#!/usr/bin/env python3
"""
Run PP-OCRv6 ONNX detection/recognition on a single image.

Input JSON (stdin line):
{
  "imageDataUrl": "data:image/jpeg;base64,...",
  "layoutHint": "mnemonic" | "verify-options" | "verify-number" | "generic",  # optional
  "expectedWordCount": 12 | 18 | 20 | 24 | 33,  # optional
  "wordlistHint": "bip39" | "slip39"  # optional, which closed wordlist the flow uses
}

Output JSON (stdout line):
{
  "text": "...",
  "confidence": 0,
  "elapsedMs": 123,
  "inputWidth": 680,
  "inputHeight": 1110,
  "mode": "mnemonic-grid" | "generic-lines" | "verify-number-det-rec" | "verify-number-fallback"
}
"""

from __future__ import annotations

import argparse
import base64
import io
import inspect
import json
import os
from pathlib import Path
import re
import statistics
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

# Avoid startup network probe in offline/limited environments.
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
# Keep matplotlib cache in writable temp dir to avoid noisy warnings/startup rebuild.
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib")

import cv2
import numpy as np
from PIL import Image
import yaml

from paddleocr import PaddleOCR, TextRecognition

REC_MODEL_DIR_NAME = "PP-OCRv6_medium_rec_onnx"
DET_MODEL_DIR_NAME = "PP-OCRv6_medium_det_onnx"
DEFAULT_REC_MODEL_NAME = "PP-OCRv6_medium_rec"
DEFAULT_DET_MODEL_NAME = "PP-OCRv6_medium_det"
OCR_ENGINE = "onnxruntime"

# Bump when tuning recognition; the Electron main process logs it at startup so
# a stale (pre-restart) OCR server is immediately visible.
SCRIPT_VERSION = "2026-07-03.4-blue-channel"

MODEL_CACHE: Dict[str, Tuple[Any, Any, Any, List[str]]] = {}
VERIFY_NUMBER_OCR: Optional[PaddleOCR] = None

# Closed wordlists for mnemonic recognition. BIP39 (2048 words) and SLIP39
# (1024 words) are distinct lists — never mix them; the renderer says which
# one the current flow uses via the request's wordlistHint.
Lexicon = Tuple[frozenset, Dict[int, List[str]]]
LEXICON_FILES = {"bip39": "bip39_english.txt", "slip39": "slip39_english.txt"}
LEXICON_MIN_WORDS = {"bip39": 2048, "slip39": 1024}
LEXICON_CACHE: Dict[str, Optional[Lexicon]] = {}


def read_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
  raw = os.environ.get(name)
  if raw is None:
    return default
  try:
    value = int(raw)
  except ValueError:
    return default
  return max(minimum, min(maximum, value))


MAX_IMAGE_SIDE = read_int_env(
  "QA_AUTO_HW_OCR_MAX_IMAGE_SIDE",
  default=1280,
  minimum=512,
  maximum=4096,
)
CPU_THREADS = read_int_env(
  "QA_AUTO_HW_OCR_CPU_THREADS",
  default=4,
  minimum=1,
  maximum=32,
)
REC_VARIANT_COUNT = read_int_env(
  "QA_AUTO_HW_OCR_REC_VARIANTS",
  default=1,
  minimum=1,
  maximum=4,
)


try:
  RESAMPLE_BICUBIC = Image.Resampling.BICUBIC
except AttributeError:
  RESAMPLE_BICUBIC = Image.BICUBIC


def resolve_model_dir(default_name: str, env_keys: Sequence[str]) -> Path:
  override = ""
  for key in env_keys:
    value = (os.environ.get(key) or "").strip()
    if value:
      override = value
      break
  if override:
    path = Path(override).expanduser().resolve()
    if path.exists():
      return path

  script_root = Path(__file__).resolve().parents[1]
  candidates = [
    script_root / "models" / "paddle_ocr" / default_name,
    Path.cwd() / "models" / "paddle_ocr" / default_name,
  ]
  for candidate in candidates:
    if candidate.exists():
      return candidate

  raise FileNotFoundError(
    f"{default_name} not found. Checked: "
    + ", ".join(str(c) for c in candidates)
    + f". You can set one of: {', '.join(env_keys)}."
  )


def resolve_en_model_dir() -> Path:
  return resolve_model_dir(
    default_name=REC_MODEL_DIR_NAME,
    env_keys=["QA_AUTO_HW_OCR_MODEL_DIR", "QA_AUTO_HW_EN_OCR_MODEL_DIR"],
  )


def resolve_multi_rec_model_dir() -> Path:
  return resolve_model_dir(
    default_name=REC_MODEL_DIR_NAME,
    env_keys=[
      "QA_AUTO_HW_OCR_MULTI_REC_MODEL_DIR",
      "QA_AUTO_HW_OCR_MODEL_DIR",
      "QA_AUTO_HW_EN_OCR_MODEL_DIR",
    ],
  )


def resolve_det_model_dir() -> Path:
  return resolve_model_dir(
    default_name=DET_MODEL_DIR_NAME,
    env_keys=["QA_AUTO_HW_OCR_DET_MODEL_DIR"],
  )


def decode_data_url(data_url_or_base64: str) -> Image.Image:
  raw = data_url_or_base64.strip()
  if raw.startswith("data:"):
    comma = raw.find(",")
    if comma < 0:
      raise ValueError("Invalid data URL: missing comma separator")
    raw = raw[comma + 1 :]
  binary = base64.b64decode(raw)
  return Image.open(io.BytesIO(binary)).convert("RGB")


def resize_image_if_needed(image: Image.Image) -> Image.Image:
  width, height = image.size
  max_side = max(width, height)
  if max_side <= MAX_IMAGE_SIDE:
    return image

  ratio = MAX_IMAGE_SIDE / float(max_side)
  target_w = max(1, int(round(width * ratio)))
  target_h = max(1, int(round(height * ratio)))
  return image.resize((target_w, target_h), RESAMPLE_BICUBIC)


def load_charset(model_dir: Path) -> List[str]:
  yml_path = model_dir / "inference.yml"
  data = yaml.safe_load(yml_path.read_text(encoding="utf-8"))
  chars = data["PostProcess"]["character_dict"]
  if not isinstance(chars, list):
    raise ValueError(f"Unexpected character_dict format in {yml_path}")
  return [str(x) for x in chars]


def load_model_name(model_dir: Path, default_name: str) -> str:
  yml_path = model_dir / "inference.yml"
  try:
    data = yaml.safe_load(yml_path.read_text(encoding="utf-8"))
    model_name = data.get("Global", {}).get("model_name")
    return str(model_name) if model_name else default_name
  except Exception:
    return default_name


class OnnxTextRecognizer:
  def __init__(self, model_dir: Path):
    model_file = model_dir / "inference.onnx"
    if not model_file.exists():
      raise FileNotFoundError(
        f"Model files missing in {model_dir}. Expected {model_file.name}."
      )
    self.model = TextRecognition(
      model_name=load_model_name(model_dir, DEFAULT_REC_MODEL_NAME),
      model_dir=str(model_dir),
      engine=OCR_ENGINE,
    )

  def recognize(self, image_bgr: np.ndarray) -> Tuple[str, float]:
    result = self.model.predict(image_bgr, batch_size=1)
    for item in result:
      if isinstance(item, dict):
        text = item.get("rec_text")
        score = item.get("rec_score")
        if isinstance(text, str):
          conf = float(score) if isinstance(score, (int, float, np.floating)) else 0.0
          return text, conf
    return "", 0.0


def ensure_rec_model(model_dir: Path) -> Tuple[Any, Any, Any, List[str]]:
  model_key = str(model_dir.resolve())
  cached = MODEL_CACHE.get(model_key)
  if cached is not None:
    return cached

  predictor = OnnxTextRecognizer(model_dir)
  input_handle = None
  output_handle = None
  charset = load_charset(model_dir)
  cached = (predictor, input_handle, output_handle, charset)
  MODEL_CACHE[model_key] = cached
  return cached


def ensure_verify_number_ocr() -> PaddleOCR:
  global VERIFY_NUMBER_OCR
  if VERIFY_NUMBER_OCR is not None:
    return VERIFY_NUMBER_OCR

  det_dir = resolve_det_model_dir()
  rec_dir = resolve_multi_rec_model_dir()
  init_params = inspect.signature(PaddleOCR.__init__).parameters

  kwargs: Dict[str, Any] = {"engine": OCR_ENGINE}

  # PaddleOCR 3.x naming.
  if "text_detection_model_dir" in init_params:
    kwargs["text_detection_model_dir"] = str(det_dir)
    if "text_detection_model_name" in init_params:
      kwargs["text_detection_model_name"] = load_model_name(det_dir, DEFAULT_DET_MODEL_NAME)
  else:
    kwargs["det_model_dir"] = str(det_dir)

  if "text_recognition_model_dir" in init_params:
    kwargs["text_recognition_model_dir"] = str(rec_dir)
    if "text_recognition_model_name" in init_params:
      kwargs["text_recognition_model_name"] = load_model_name(rec_dir, DEFAULT_REC_MODEL_NAME)
  else:
    kwargs["rec_model_dir"] = str(rec_dir)

  # Keep current behavior: detect + recognize only.
  if "use_doc_orientation_classify" in init_params:
    kwargs["use_doc_orientation_classify"] = False
  if "use_doc_unwarping" in init_params:
    kwargs["use_doc_unwarping"] = False
  if "use_textline_orientation" in init_params:
    kwargs["use_textline_orientation"] = False
  elif "use_angle_cls" in init_params:
    kwargs["use_angle_cls"] = False

  if "show_log" in init_params:
    kwargs["show_log"] = False

  VERIFY_NUMBER_OCR = PaddleOCR(**kwargs)
  return VERIFY_NUMBER_OCR


def preprocess_rec_input(crop_bgr: np.ndarray) -> np.ndarray:
  target_h = 48
  target_w = 320
  h, w = crop_bgr.shape[:2]
  if h <= 0 or w <= 0:
    return np.zeros((1, 3, target_h, target_w), dtype=np.float32)

  new_w = min(target_w, max(1, int(round(target_h * w / float(h)))))
  resized = cv2.resize(crop_bgr, (new_w, target_h), interpolation=cv2.INTER_CUBIC)
  canvas = np.zeros((target_h, target_w, 3), dtype=np.float32)
  canvas[:, :new_w, :] = resized.astype(np.float32) / 255.0
  canvas = (canvas - 0.5) / 0.5
  return canvas.transpose(2, 0, 1)[None, :]


def build_rec_crop_variants(crop_bgr: np.ndarray, variant_count: int = REC_VARIANT_COUNT) -> List[np.ndarray]:
  variants = [crop_bgr]
  safe_variant_count = max(1, min(4, int(variant_count)))
  if safe_variant_count <= 1 or crop_bgr.size == 0:
    return variants

  # Light sharpening helps cyan/white OLED text that is slightly bloomed by the camera.
  blurred = cv2.GaussianBlur(crop_bgr, (0, 0), 1.0)
  sharpened = cv2.addWeighted(crop_bgr, 1.55, blurred, -0.55, 0)
  variants.append(sharpened)
  if safe_variant_count <= 2:
    return variants

  # Local contrast on luminance keeps text strokes stronger without changing geometry.
  lab = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2LAB)
  l_channel, a_channel, b_channel = cv2.split(lab)
  clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(4, 4))
  contrast_l = clahe.apply(l_channel)
  contrast = cv2.cvtColor(cv2.merge((contrast_l, a_channel, b_channel)), cv2.COLOR_LAB2BGR)
  variants.append(contrast)
  if safe_variant_count <= 3:
    return variants

  # High-contrast binary fallback for very clear bright text on dark screen.
  gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
  _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
  variants.append(cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR))
  return variants


def load_lexicon(name: str) -> Optional[Lexicon]:
  """Loads a wordlist (scripts/{bip39,slip39}_english.txt) once, keyed by name.

  Returns (word_set, words_by_length) or None when the file is unavailable.
  """
  if name in LEXICON_CACHE:
    return LEXICON_CACHE[name]

  file_name = LEXICON_FILES.get(name)
  if file_name is None:
    LEXICON_CACHE[name] = None
    return None

  wordlist_path = Path(__file__).resolve().parent / file_name
  lexicon: Optional[Lexicon] = None
  try:
    words = [line.strip().lower() for line in wordlist_path.read_text(encoding="utf-8").splitlines()]
    words = [w for w in words if w]
    if len(words) >= LEXICON_MIN_WORDS[name]:
      by_length: Dict[int, List[str]] = {}
      for word in words:
        by_length.setdefault(len(word), []).append(word)
      lexicon = (frozenset(words), by_length)
  except OSError:
    lexicon = None

  LEXICON_CACHE[name] = lexicon
  return lexicon


def within_one_edit(a: str, b: str) -> bool:
  la, lb = len(a), len(b)
  if abs(la - lb) > 1:
    return False
  if la == lb:
    diff = 0
    for ca, cb in zip(a, b):
      if ca != cb:
        diff += 1
        if diff > 1:
          return False
    return True
  if la > lb:
    a, b, la, lb = b, a, lb, la
  i = j = 0
  skipped = False
  while i < la and j < lb:
    if a[i] == b[j]:
      i += 1
      j += 1
    elif skipped:
      return False
    else:
      skipped = True
      j += 1
  return True


def lexicon_has_near_match(
  lexicon: Lexicon, token: str
) -> bool:
  _, by_length = lexicon
  for length in (len(token) - 1, len(token), len(token) + 1):
    for word in by_length.get(length, ()):
      if within_one_edit(token, word):
        return True
  return False


def score_rec_text(
  text: str,
  conf: float,
  lexicon: Optional[Lexicon] = None,
) -> float:
  token = extract_alpha_token(text)
  score = conf
  if 3 <= len(token) <= 8:
    score += 0.08
  elif token:
    score -= 0.08
  else:
    score -= 0.25

  alpha_tokens = re.findall(r"[A-Za-z]+", text)
  if len(alpha_tokens) > 1:
    score -= 0.04 * (len(alpha_tokens) - 1)

  # Closed-vocabulary bonus: mnemonic/verify words always come from the selected
  # wordlist, so prefer the variant whose decode lands in (or near) that list.
  if lexicon is not None and token:
    words, _ = lexicon
    if token in words:
      score += 0.25
    elif lexicon_has_near_match(lexicon, token):
      score += 0.08
    else:
      score -= 0.12
  return score


# Per-scene charset masks. Restricting the CTC decode to characters that can
# actually appear kills digit/letter confusions (0/O, 1/l) at the source:
# - "letters": mnemonic words / verify options. Pure letters on both devices
#   (pro is all-lowercase, pro2 capitalizes the first letter on verify pages),
#   so [A-Za-z] covers both; the index digits come from row order, not OCR.
# - "alnum-index": index/number regions and generic text ("1." style indices up
#   to 33, "#N" markers) — letters, digits and the few separators that occur.
CHARSET_MASK_PATTERNS = {
  "letters": re.compile(r"[A-Za-z ]"),
  "alnum-index": re.compile(r"[A-Za-z0-9.# ]"),
}
CHARSET_MASK_CACHE: Dict[Tuple[str, int], Optional[np.ndarray]] = {}


def build_charset_mask(charset: Sequence[str], mask_name: str) -> Optional[np.ndarray]:
  """Boolean mask over CTC classes (blank + charset) allowing only mask_name chars.

  Charset lists are cached per model in MODEL_CACHE, so id() is a stable key.
  """
  pattern = CHARSET_MASK_PATTERNS.get(mask_name)
  if pattern is None:
    return None
  cache_key = (mask_name, id(charset))
  cached = CHARSET_MASK_CACHE.get(cache_key)
  if cached is not None:
    return cached

  mask = np.zeros(len(charset) + 1, dtype=bool)
  mask[0] = True  # CTC blank must stay decodable
  for pos, char in enumerate(charset):
    if pattern.fullmatch(char):
      mask[pos + 1] = True
  CHARSET_MASK_CACHE[cache_key] = mask
  return mask


def decode_ctc(
  logits: np.ndarray,
  charset: Sequence[str],
  allowed_mask: Optional[np.ndarray] = None,
) -> Tuple[str, float]:
  if allowed_mask is not None and allowed_mask.shape[0] == logits.shape[1]:
    # Probabilities are >= 0, so -1 reliably excludes disallowed classes.
    logits = np.where(allowed_mask[None, :], logits, -1.0)
  idxs = logits.argmax(axis=1)
  confs = logits.max(axis=1)
  chars: List[str] = []
  scores: List[float] = []
  prev = -1
  for idx, conf in zip(idxs, confs):
    i = int(idx)
    if i == 0:
      prev = i
      continue
    if i == prev:
      continue
    char_pos = i - 1
    if 0 <= char_pos < len(charset):
      chars.append(charset[char_pos])
      scores.append(float(conf))
    prev = i
  text = "".join(chars)
  score = float(statistics.mean(scores)) if scores else 0.0
  return text, score


CROP_PAD_X_LEFT = 2   # left padding (small — number labels sit here)
CROP_PAD_X_RIGHT = 8  # right padding (larger — trailing chars are most often clipped here)
CROP_PAD_Y = 2        # vertical padding (small — avoids row bleed in dense 24-word grids)


def recognize_crop(
  image_bgr: np.ndarray,
  box: Tuple[int, int, int, int],
  predictor: Any,
  input_handle: Any,
  output_handle: Any,
  charset: Sequence[str],
  variant_count: int = REC_VARIANT_COUNT,
  lexicon: Optional[Lexicon] = None,
  charset_mask: Optional[np.ndarray] = None,
) -> Tuple[str, float]:
  x, y, w, h = box
  h_img, w_img = image_bgr.shape[:2]
  x1 = max(0, x - CROP_PAD_X_LEFT)
  y1 = max(0, y - CROP_PAD_Y)
  x2 = min(w_img, x + w + CROP_PAD_X_RIGHT)
  y2 = min(h_img, y + h + CROP_PAD_Y)
  crop = image_bgr[y1:y2, x1:x2]
  best_text = ""
  best_conf = 0.0
  best_score = float("-inf")

  for variant in build_rec_crop_variants(crop, variant_count):
    if isinstance(predictor, OnnxTextRecognizer):
      text, conf = predictor.recognize(variant)
    else:
      arr = preprocess_rec_input(variant)
      input_handle.reshape(arr.shape)
      input_handle.copy_from_cpu(arr)
      predictor.run()
      out = output_handle.copy_to_cpu()[0]
      text, conf = decode_ctc(out, charset, charset_mask)
    score = score_rec_text(text, conf, lexicon)
    if score > best_score:
      best_text = text
      best_conf = conf
      best_score = score

  return best_text, best_conf


def extract_alpha_token(text: str) -> str:
  tokens = re.findall(r"[A-Za-z]+", text.lower())
  if not tokens:
    return ""
  return max(tokens, key=len)


def normalize_for_digit_parsing(text: str) -> str:
  # Common OCR confusions around numbers in verify prompt text.
  return text.replace("I", "1").replace("l", "1").replace("|", "1").replace("O", "0").replace("o", "0")


def parse_word_index_from_text(text: str, max_index: int = 12) -> int:
  safe_max_index = max(1, min(33, int(max_index)))
  normalized = text.strip()
  if not normalized:
    return -1

  normalized_for_digits = normalize_for_digit_parsing(normalized)

  hash_matches = list(re.finditer(r"[#＃]\s*(\d{1,2})", normalized_for_digits))
  for match in reversed(hash_matches):
    value = int(match.group(1))
    if 1 <= value <= safe_max_index:
      return value

  explicit_patterns = [
    r"单词\s*[#＃]?\s*(\d{1,2})",
    r"word\s*[#＃]?\s*(\d{1,2})",
    r"第\s*(\d{1,2})\s*(个|位)?\s*(单词|词|word)?",
    r"(\d{1,2})\s*(st|nd|rd|th)\s*(word)?",
  ]
  for pattern in explicit_patterns:
    match = re.search(pattern, normalized_for_digits, flags=re.IGNORECASE)
    if not match:
      continue
    value = int(match.group(1))
    if 1 <= value <= safe_max_index:
      return value

  digit_matches = re.findall(r"\d{1,2}", normalized_for_digits)
  if len(digit_matches) == 1:
    value = int(digit_matches[0])
    compact = re.sub(r"\s+", "", normalized_for_digits)
    if 1 <= value <= safe_max_index and len(compact) <= 6:
      return value

  return -1


def detect_verify_word_index(candidates: Sequence[str], max_index: int = 12) -> int:
  safe_max_index = max(1, min(33, int(max_index)))
  clean_candidates = [str(value).strip() for value in candidates if str(value).strip()]
  if not clean_candidates:
    return -1

  # Highest priority: explicit "#N" tokens.
  for candidate in clean_candidates:
    normalized = normalize_for_digit_parsing(candidate)
    matches = list(re.finditer(r"[#＃]\s*(\d{1,2})", normalized))
    for match in reversed(matches):
      value = int(match.group(1))
      if 1 <= value <= safe_max_index:
        return value

  # Then try normal parser on each line, before mixed full-text fallback.
  for candidate in clean_candidates:
    value = parse_word_index_from_text(candidate, safe_max_index)
    if value != -1:
      return value

  return parse_word_index_from_text("\n".join(clean_candidates), safe_max_index)


def append_text_conf(entries: List[Tuple[str, float]], text: Any, score: Any = None) -> None:
  if not isinstance(text, str):
    return
  stripped = text.strip()
  if not stripped:
    return
  conf = 0.0
  if isinstance(score, (int, float, np.floating)):
    conf = float(score)
  entries.append((stripped, conf))


def extract_ocr_text_conf_entries(ocr_result: Any) -> List[Tuple[str, float]]:
  entries: List[Tuple[str, float]] = []

  def walk(node: Any) -> None:
    if node is None:
      return

    if isinstance(node, dict):
      texts = node.get("rec_texts")
      scores = node.get("rec_scores")
      if isinstance(texts, list):
        for idx, text in enumerate(texts):
          score = None
          if isinstance(scores, list) and idx < len(scores):
            score = scores[idx]
          append_text_conf(entries, text, score)
      if "text" in node:
        append_text_conf(entries, node.get("text"), node.get("score"))
      for value in node.values():
        walk(value)
      return

    if isinstance(node, (list, tuple)):
      # (text, score)
      if (
        len(node) >= 2
        and isinstance(node[0], str)
        and isinstance(node[1], (int, float, np.floating))
      ):
        append_text_conf(entries, node[0], node[1])
        return

      # (box, (text, score))
      if (
        len(node) == 2
        and isinstance(node[1], (list, tuple))
        and len(node[1]) >= 1
        and isinstance(node[1][0], str)
      ):
        text = node[1][0]
        score = node[1][1] if len(node[1]) > 1 else None
        append_text_conf(entries, text, score)
        return

      for item in node:
        walk(item)

  walk(ocr_result)

  deduped: List[Tuple[str, float]] = []
  seen: set[Tuple[str, int]] = set()
  for text, score in entries:
    key = (text, int(round(score * 1000)))
    if key in seen:
      continue
    seen.add(key)
    deduped.append((text, score))
  return deduped


def recognize_verify_number(image_bgr: np.ndarray, max_index: int = 12) -> Tuple[str, float, int, int]:
  verify_ocr = ensure_verify_number_ocr()
  if hasattr(verify_ocr, "predict"):
    try:
      # PaddleOCR 3.x preferred path.
      ocr_result = verify_ocr.predict(image_bgr)
    except Exception:
      # Fallback for older/compat versions.
      ocr_result = verify_ocr.ocr(image_bgr, det=True, rec=True, cls=False)
  else:
    ocr_result = verify_ocr.ocr(image_bgr, det=True, rec=True, cls=False)
  entries = extract_ocr_text_conf_entries(ocr_result)

  texts = [text for text, _ in entries if text]
  confs = [score for _, score in entries if score > 0]
  merged_text = "\n".join(texts).strip()
  detected_index = detect_verify_word_index(
    texts + ([merged_text] if merged_text else []),
    max_index=max_index,
  )

  if detected_index != -1:
    canonical = f"word #{detected_index}"
    output_text = f"{canonical}\n{merged_text}" if merged_text else canonical
  else:
    output_text = merged_text

  confidence = float(statistics.mean(confs)) * 100.0 if confs else 0.0
  return output_text, confidence, len(texts), detected_index


def flatten_illumination(gray: np.ndarray) -> np.ndarray:
  """Divides out the low-frequency illumination background (flat-field).

  Screen-camera captures are rarely evenly lit — glare and corner falloff make
  a single global threshold split the page wrong. Dividing by a heavily blurred
  copy normalizes brightness so Otsu sees uniform text-vs-background contrast.
  """
  h, w = gray.shape[:2]
  sigma = max(8.0, min(h, w) * 0.05)
  background = cv2.GaussianBlur(gray, (0, 0), sigma)
  background = np.maximum(background, 1)
  flattened = cv2.divide(gray, background, scale=128)
  return cv2.normalize(flattened, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)


def boxes_from_binary(
  binary: np.ndarray, w: int, h: int
) -> List[Tuple[int, int, int, int]]:
  kernel_w = max(17, int(round(w * 0.03)))
  kernel_h = max(3, int(round(h * 0.004)))
  kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_w, kernel_h))
  merged = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

  contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
  boxes: List[Tuple[int, int, int, int]] = []
  for contour in contours:
    x, y, bw, bh = cv2.boundingRect(contour)
    area = bw * bh
    if area < (w * h) * 0.00035 or area > (w * h) * 0.12:
      continue
    if bh < h * 0.015 or bh > h * 0.22:
      continue
    if bw < w * 0.05 or bw > w * 0.8:
      continue
    boxes.append((x, y, bw, bh))
  return boxes


def detect_text_boxes(
  image_bgr: np.ndarray,
  mask_top_ratio: float = 0.14,
  mask_bottom_ratio: float = 0.90,
) -> List[Tuple[int, int, int, int]]:
  h, w = image_bgr.shape[:2]
  gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

  # Try illumination-flattened Otsu first (robust to glare / uneven lighting),
  # keep plain global Otsu as a second opinion, and use whichever binarization
  # recovers more text boxes — missing boxes is the failure mode that aborts
  # grid recognition, while spurious ones are removed by the size filters.
  candidates: List[List[Tuple[int, int, int, int]]] = []
  for source in (flatten_illumination(gray), gray):
    work = source.copy()
    # Remove top title and bottom button band for stable text-box extraction.
    if mask_top_ratio > 0:
      work[: int(h * mask_top_ratio), :] = 0
    if mask_bottom_ratio < 1:
      work[int(h * mask_bottom_ratio) :, :] = 0
    _, binary = cv2.threshold(work, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    candidates.append(boxes_from_binary(binary, w, h))

  return max(candidates, key=len)


def cluster_rows(
  boxes: Sequence[Tuple[int, int, int, int]],
  image_h: int,
) -> List[Dict[str, Any]]:
  rows: List[Dict[str, Any]] = []
  tolerance = max(18.0, image_h * 0.03)
  for box in sorted(boxes, key=lambda b: b[1] + b[3] / 2.0):
    cy = box[1] + box[3] / 2.0
    placed = False
    for row in rows:
      if abs(cy - row["cy"]) <= tolerance:
        row["items"].append(box)
        row["cy"] = sum(item[1] + item[3] / 2.0 for item in row["items"]) / len(row["items"])
        placed = True
        break
    if not placed:
      rows.append({"cy": cy, "items": [box]})
  rows.sort(key=lambda row: row["cy"])
  return rows


def merge_boxes(items: Sequence[Tuple[int, int, int, int]]) -> Optional[Tuple[int, int, int, int]]:
  if not items:
    return None
  x1 = min(item[0] for item in items)
  y1 = min(item[1] for item in items)
  x2 = max(item[0] + item[2] for item in items)
  y2 = max(item[1] + item[3] for item in items)
  return (x1, y1, x2 - x1, y2 - y1)


# Supported mnemonic grid layouts: word_count → row_count
MNEMONIC_GRID_WORD_COUNTS = {12: 6, 18: 9, 20: 10, 24: 12}


def grid_column_anchors(
  rows_items: Sequence[Sequence[Tuple[int, int, int, int]]],
  median_h: float,
) -> List[float]:
  """Median x-start of the index and word columns across grid rows.

  The device UI is a fixed grid, so the "N." box and the word box start at
  nearly the same x in every row; glare boxes do not line up with either.
  """
  firsts: List[float] = []
  seconds: List[float] = []
  for items in rows_items:
    ordered = sorted(
      (item for item in items if item[3] <= median_h * 1.8),
      key=lambda box: box[0],
    ) or sorted(items, key=lambda box: box[0])
    if ordered:
      firsts.append(float(ordered[0][0]))
    if len(ordered) > 1:
      seconds.append(float(ordered[1][0]))
  anchors: List[float] = []
  if firsts:
    anchors.append(float(statistics.median(firsts)))
  if seconds:
    anchors.append(float(statistics.median(seconds)))
  return anchors


def filter_grid_cell_items(
  items: Sequence[Tuple[int, int, int, int]],
  median_h: float,
  col_x_anchors: Sequence[float],
) -> List[Tuple[int, int, int, int]]:
  """Drop glare/reflection det boxes from one grid cell before merging.

  Screen-edge glare produces boxes that merge into the cell and corrupt the
  recognized word (e.g. "board" -> "maboardowb"). Real boxes either start at a
  column anchor (index or word column) or directly continue the previous box
  (a word det split into fragments); everything else is noise.
  """
  text_like = [item for item in items if item[3] <= median_h * 1.8]
  if not text_like:
    return list(items)
  text_like.sort(key=lambda box: box[0])
  if not col_x_anchors:
    return text_like
  tol = median_h * 1.5
  continuation_gap = median_h * 0.45
  kept: List[Tuple[int, int, int, int]] = []
  for box in text_like:
    aligned = any(abs(box[0] - anchor) <= tol for anchor in col_x_anchors)
    continues_previous = bool(kept) and (
      box[0] - (kept[-1][0] + kept[-1][2]) <= continuation_gap
    )
    if aligned or continues_previous:
      kept.append(box)
  return kept or text_like


def recognize_mnemonic_grid(
  image_bgr: np.ndarray,
  rows: Sequence[Dict[str, Any]],
  predictor: Any,
  input_handle: Any,
  output_handle: Any,
  charset: Sequence[str],
  num_rows: int = 6,
  variant_count: int = REC_VARIANT_COUNT,
  lexicon: Optional[Lexicon] = None,
  charset_mask: Optional[np.ndarray] = None,
) -> Optional[Tuple[str, float]]:
  """Recognize a 2-column mnemonic grid with `num_rows` rows (num_rows*2 words total).

  Supports 6 rows (12 words), 9 rows (18 words), 10 rows (20 words), 12 rows (24 words).
  """
  dense_rows = [row for row in rows if len(row["items"]) >= 2]
  if len(dense_rows) < num_rows - 1:
    return None
  if len(dense_rows) >= num_rows:
    dense_rows = dense_rows[-num_rows:]
  if len(dense_rows) != num_rows:
    return None

  image_w = image_bgr.shape[1]
  x_mid = image_w / 2.0
  lines: List[str] = []
  confs: List[float] = []
  all_heights = [item[3] for row in dense_rows for item in row["items"]]
  median_h = float(statistics.median(all_heights)) if all_heights else 0.0

  split_rows = [
    (
      [item for item in row["items"] if item[0] + item[2] / 2.0 < x_mid],
      [item for item in row["items"] if item[0] + item[2] / 2.0 >= x_mid],
    )
    for row in dense_rows
  ]
  left_anchors = grid_column_anchors([left for left, _ in split_rows], median_h)
  right_anchors = grid_column_anchors([right for _, right in split_rows], median_h)

  for row_idx, (left_items, right_items) in enumerate(split_rows):
    if median_h > 0:
      left_items = filter_grid_cell_items(left_items, median_h, left_anchors)
      right_items = filter_grid_cell_items(right_items, median_h, right_anchors)
    left_box = merge_boxes(left_items)
    right_box = merge_boxes(right_items)
    if left_box is None or right_box is None:
      return None

    left_text, left_conf = recognize_crop(
      image_bgr, left_box, predictor, input_handle, output_handle, charset,
      variant_count, lexicon, charset_mask
    )
    right_text, right_conf = recognize_crop(
      image_bgr, right_box, predictor, input_handle, output_handle, charset,
      variant_count, lexicon, charset_mask
    )

    left_token = extract_alpha_token(left_text)
    right_token = extract_alpha_token(right_text)
    if not left_token or not right_token:
      return None

    left_index = row_idx + 1
    right_index = row_idx + num_rows + 1  # generalised: right column starts at num_rows+1
    lines.append(f"{left_index}. {left_token}")
    lines.append(f"{right_index}. {right_token}")
    confs.extend([left_conf, right_conf])

  expected_word_count = num_rows * 2
  if len(lines) != expected_word_count:
    return None

  avg_conf = float(statistics.mean(confs)) * 100.0 if confs else 0.0
  return "\n".join(lines), avg_conf


def generic_row_anchors(
  rows: Sequence[Dict[str, Any]],
  median_h: float,
) -> List[float]:
  """Cluster box x-starts that repeat across rows (fixed-layout list columns)."""
  clusters: List[Dict[str, Any]] = []
  tol = median_h * 1.5
  for row_idx, row in enumerate(rows):
    for item in row["items"]:
      if item[3] > median_h * 1.8:
        continue
      x = float(item[0])
      for cluster in clusters:
        if abs(x - cluster["center"]) <= tol:
          cluster["xs"].append(x)
          cluster["rows"].add(row_idx)
          cluster["center"] = float(statistics.median(cluster["xs"]))
          break
      else:
        clusters.append({"center": x, "xs": [x], "rows": {row_idx}})
  min_rows = max(3, int(len(rows) * 0.4))
  return [cluster["center"] for cluster in clusters if len(cluster["rows"]) >= min_rows]


def recognize_generic_lines(
  image_bgr: np.ndarray,
  rows: Sequence[Dict[str, Any]],
  predictor: Any,
  input_handle: Any,
  output_handle: Any,
  charset: Sequence[str],
  variant_count: int = REC_VARIANT_COUNT,
  lexicon: Optional[Lexicon] = None,
  charset_mask: Optional[np.ndarray] = None,
  grid_anchor_filter: bool = False,
) -> Tuple[str, float]:
  split_columns = False
  if grid_anchor_filter and len(rows) >= 4:
    # Scrolled list windows clip the first/last visible row at the DEVICE
    # viewport edge (not our crop edge — wider candidate crops shift it inward),
    # leaving half-height glyphs that OCR as garbage which can steal a word
    # index renderer-side (e.g. "1. ens" overwriting the real word 1). A real
    # row has at least one full-height box; drop rows that are all-short or
    # touch the image edge.
    image_h = image_bgr.shape[0]
    heights = [item[3] for row in rows for item in row["items"]]
    median_h = float(statistics.median(heights)) if heights else 0.0
    rows = [
      row for row in rows
      if min(item[1] for item in row["items"]) > 2
      and max(item[1] + item[3] for item in row["items"]) < image_h - 2
      # Real rows always contain a full-height digit box (the "N." index), so
      # their tallest box sits at ~1.0x the median; a viewport-clipped row is
      # uniformly shortened.
      and (median_h <= 0 or max(item[3] for item in row["items"]) >= median_h * 0.78)
    ]
    # Scrolled mnemonic windows (20/24-word pages) can't use the fixed grid,
    # but their columns still align across rows — use that to drop glare boxes
    # before merging each row (same failure mode as the grid path).
    heights = [item[3] for row in rows for item in row["items"]]
    median_h = float(statistics.median(heights)) if heights else 0.0
    anchors = generic_row_anchors(rows, median_h) if median_h > 0 else []
    if anchors:
      rows = [
        {**row, "items": filter_grid_cell_items(row["items"], median_h, anchors)}
        for row in rows
      ]
    # Recognize the two grid columns separately: a whole-row crop makes the
    # rec model glue the left word to the right index ("gym13. stove"), which
    # the renderer-side index parser can't split reliably.
    split_columns = True

  x_mid = image_bgr.shape[1] / 2.0
  lines: List[str] = []
  confs: List[float] = []
  for row in rows:
    if split_columns:
      cell_groups = [
        [item for item in row["items"] if item[0] + item[2] / 2.0 < x_mid],
        [item for item in row["items"] if item[0] + item[2] / 2.0 >= x_mid],
      ]
    else:
      cell_groups = [list(row["items"])]
    for cell_items in cell_groups:
      box = merge_boxes(cell_items)
      if box is None:
        continue
      text, conf = recognize_crop(
        image_bgr, box, predictor, input_handle, output_handle, charset,
        variant_count, lexicon, charset_mask
      )
      if text.strip():
        lines.append(text.strip())
        confs.append(conf)

  if not lines:
    # Last fallback: recognize the whole image as one line.
    h, w = image_bgr.shape[:2]
    text, conf = recognize_crop(
      image_bgr, (0, 0, w, h), predictor, input_handle, output_handle, charset,
      variant_count, lexicon, charset_mask
    )
    return text.strip(), conf * 100.0

  return "\n".join(lines), (float(statistics.mean(confs)) * 100.0 if confs else 0.0)


def parse_payload(payload_raw: str) -> Dict[str, Any]:
  if not payload_raw:
    raise ValueError("Missing stdin JSON payload")
  payload = json.loads(payload_raw)
  if "imageDataUrl" not in payload:
    raise ValueError("Payload missing 'imageDataUrl'")
  return payload


def infer_once(payload: Dict[str, Any]) -> Dict[str, Any]:
  start = time.time()
  image = resize_image_if_needed(decode_data_url(payload["imageDataUrl"]))
  image_bgr = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
  layout_hint = str(payload.get("layoutHint") or "").strip().lower()
  raw_expected_word_count = payload.get("expectedWordCount")
  try:
    expected_word_count = int(raw_expected_word_count)
  except (TypeError, ValueError):
    expected_word_count = 0
  if expected_word_count not in {12, 18, 20, 24, 33}:
    expected_word_count = 0
  try:
    rec_variant_count = int(payload.get("recVariantCount") or REC_VARIANT_COUNT)
  except (TypeError, ValueError):
    rec_variant_count = REC_VARIANT_COUNT
  rec_variant_count = max(1, min(4, rec_variant_count))
  verify_max_index = expected_word_count if expected_word_count in {12, 18, 20, 24, 33} else 12
  wordlist_hint = str(payload.get("wordlistHint") or "").strip().lower()
  wordlist_name = wordlist_hint if wordlist_hint in LEXICON_FILES else "bip39"

  if layout_hint in {"verify-number", "verify_number"}:
    try:
      text, confidence, line_count, detected_index = recognize_verify_number(
        image_bgr,
        max_index=verify_max_index,
      )
      return {
        "text": text,
        "confidence": confidence,
        "elapsedMs": int((time.time() - start) * 1000),
        "inputWidth": image.width,
        "inputHeight": image.height,
        "device": "cpu",
        "mode": "verify-number-det-rec",
        "boxCount": line_count,
        "rowCount": line_count,
        "detectedIndex": detected_index,
      }
    except Exception as verify_err:  # noqa: BLE001
      predictor, input_handle, output_handle, charset = ensure_rec_model(resolve_en_model_dir())
      boxes = detect_text_boxes(image_bgr, mask_top_ratio=0.0, mask_bottom_ratio=1.0)
      rows = cluster_rows(boxes, image_bgr.shape[0])
      text, confidence = recognize_generic_lines(
        image_bgr, rows, predictor, input_handle, output_handle, charset, rec_variant_count,
        charset_mask=build_charset_mask(charset, "alnum-index"),
      )
      detected_index = parse_word_index_from_text(text, verify_max_index)
      if detected_index != -1 and f"#{detected_index}" not in text:
        text = f"word #{detected_index}\n{text}".strip()
      return {
        "text": text,
        "confidence": confidence,
        "elapsedMs": int((time.time() - start) * 1000),
        "inputWidth": image.width,
        "inputHeight": image.height,
        "device": "cpu",
        "mode": "verify-number-fallback",
        "boxCount": len(boxes),
        "rowCount": len(rows),
        "detectedIndex": detected_index,
        "fallbackReason": str(verify_err),
      }

  predictor, input_handle, output_handle, charset = ensure_rec_model(resolve_en_model_dir())
  mnemonic_layout = layout_hint in {"mnemonic", "mnemonic-grid", "mnemonic_words"}
  verify_options_layout = layout_hint in {"verify-options", "verify_options"}
  if mnemonic_layout:
    # The device renders cyan/blue text; glare from warm ambient light lives
    # mostly in the red/green channels. Keeping only the blue channel keeps
    # glyphs bright while suppressing glare clouds that wash them out (plain
    # grayscale mixes the glare back in). Verified to recover words under
    # reflections; do NOT apply to verify layouts — it can break their
    # detection on some crops.
    blue_channel = image_bgr[:, :, 0]
    image_bgr = cv2.merge([blue_channel, blue_channel, blue_channel])
  # Mnemonic and verify-option words always come from a closed wordlist; use it
  # to pick the best preprocessing variant per crop.
  lexicon = load_lexicon(wordlist_name) if (mnemonic_layout or verify_options_layout) else None
  # Grid cells are always wordlist words (indices come from row order), so the
  # grid decode is letters-only; generic lines keep digits for "1."/"#N" indices
  # unless the layout says the region contains only words.
  letters_mask = build_charset_mask(charset, "letters")
  generic_mask = (
    letters_mask
    if (mnemonic_layout or verify_options_layout)
    else build_charset_mask(charset, "alnum-index")
  )
  # Mnemonic and verify-option crops are already tight; keep full vertical content.
  use_full_vertical_mask = mnemonic_layout or verify_options_layout or expected_word_count >= 18
  boxes = detect_text_boxes(
    image_bgr,
    mask_top_ratio=0.0 if use_full_vertical_mask else 0.14,
    mask_bottom_ratio=1.0 if use_full_vertical_mask else 0.90,
  )
  rows = cluster_rows(boxes, image_bgr.shape[0])
  text = ""
  confidence = 0.0
  mode = "generic-lines"

  mnemonic_result = None
  should_try_mnemonic_grid = expected_word_count in MNEMONIC_GRID_WORD_COUNTS or expected_word_count == 0
  if should_try_mnemonic_grid and (mnemonic_layout or len(rows) >= 5):
    if expected_word_count in MNEMONIC_GRID_WORD_COUNTS:
      # Known word count: try the exact grid layout.
      num_rows = MNEMONIC_GRID_WORD_COUNTS[expected_word_count]
      mnemonic_result = recognize_mnemonic_grid(
        image_bgr, rows, predictor, input_handle, output_handle, charset,
        num_rows=num_rows,
        variant_count=rec_variant_count,
        lexicon=lexicon,
        charset_mask=letters_mask,
      )
    else:
      # Unknown word count: try all supported layouts in ascending order.
      for num_rows in sorted(MNEMONIC_GRID_WORD_COUNTS.values()):
        mnemonic_result = recognize_mnemonic_grid(
          image_bgr, rows, predictor, input_handle, output_handle, charset,
          num_rows=num_rows,
          variant_count=rec_variant_count,
          lexicon=lexicon,
          charset_mask=letters_mask,
        )
        if mnemonic_result is not None:
          break

    # Some tightly-cropped mnemonic frames place the first row very close to the top.
    # Retry with relaxed masking to avoid dropping it.
    if mnemonic_result is None and mnemonic_layout:
      retry_boxes = detect_text_boxes(
        image_bgr,
        mask_top_ratio=0.0,
        mask_bottom_ratio=1.0,
      )
      retry_rows = cluster_rows(retry_boxes, image_bgr.shape[0])
      retry_num_rows = (
        MNEMONIC_GRID_WORD_COUNTS[expected_word_count]
        if expected_word_count in MNEMONIC_GRID_WORD_COUNTS
        else 6
      )
      retry_result = recognize_mnemonic_grid(
        image_bgr, retry_rows, predictor, input_handle, output_handle, charset,
        num_rows=retry_num_rows,
        variant_count=rec_variant_count,
        lexicon=lexicon,
        charset_mask=letters_mask,
      )
      if retry_result is not None:
        boxes = retry_boxes
        rows = retry_rows
        mnemonic_result = retry_result
      elif len(retry_rows) > len(rows):
        boxes = retry_boxes
        rows = retry_rows

  if mnemonic_result is not None:
    text, confidence = mnemonic_result
    mode = "mnemonic-grid"
  else:
    text, confidence = recognize_generic_lines(
      image_bgr, rows, predictor, input_handle, output_handle, charset,
      rec_variant_count, lexicon, generic_mask,
      grid_anchor_filter=mnemonic_layout,
    )

  return {
    "text": text,
    "confidence": confidence,
    "elapsedMs": int((time.time() - start) * 1000),
    "inputWidth": image.width,
    "inputHeight": image.height,
    "device": "cpu",
    "mode": mode,
    "boxCount": len(boxes),
    "rowCount": len(rows),
    "recVariantCount": rec_variant_count,
  }


def run_once():
  payload_raw = sys.stdin.read()
  payload = parse_payload(payload_raw)
  out = infer_once(payload)
  print(json.dumps(out, ensure_ascii=False))
  sys.stdout.flush()


def run_server():
  ensure_rec_model(resolve_en_model_dir())
  print(json.dumps({"type": "ready", "scriptVersion": SCRIPT_VERSION}, ensure_ascii=False))
  sys.stdout.flush()

  for line in sys.stdin:
    raw = line.strip()
    if not raw:
      continue

    req_id = None
    try:
      payload = json.loads(raw)
      req_id = payload.get("id")
      parsed = parse_payload(json.dumps(payload))
      out = infer_once(parsed)
      print(
        json.dumps(
          {
            "id": req_id,
            "ok": True,
            **out,
          },
          ensure_ascii=False,
        )
      )
      sys.stdout.flush()
    except Exception as err:  # noqa: BLE001
      print(
        json.dumps(
          {
            "id": req_id,
            "ok": False,
            "error": str(err),
          },
          ensure_ascii=False,
        )
      )
      sys.stdout.flush()


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--server", action="store_true")
  args = parser.parse_args()

  if args.server:
    run_server()
  else:
    run_once()
  return 0


if __name__ == "__main__":
  try:
    raise SystemExit(main())
  except Exception as err:  # noqa: BLE001
    print(f"[paddleocr_en_infer] {err}", file=sys.stderr)
    raise SystemExit(1)
