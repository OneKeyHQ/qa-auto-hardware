#!/usr/bin/env python3
"""
Run en_PP-OCRv5_mobile_rec (local Paddle inference) on a single image.

Input JSON (stdin line):
{
  "imageDataUrl": "data:image/jpeg;base64,...",
  "layoutHint": "mnemonic" | "verify-options" | "verify-number" | "generic",  # optional
  "expectedWordCount": 12 | 18 | 20 | 24  # optional
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

from paddle import inference
from paddleocr import PaddleOCR

EN_REC_MODEL_DIR_NAME = "en_PP-OCRv5_mobile_rec"
MULTI_REC_MODEL_DIR_NAME = "PP-OCRv5_mobile_rec"
DET_MODEL_DIR_NAME = "PP-OCRv5_mobile_det"

MODEL_CACHE: Dict[str, Tuple[Any, Any, Any, List[str]]] = {}
VERIFY_NUMBER_OCR: Optional[PaddleOCR] = None


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
    default_name=EN_REC_MODEL_DIR_NAME,
    env_keys=["QA_AUTO_HW_OCR_MODEL_DIR", "QA_AUTO_HW_EN_OCR_MODEL_DIR"],
  )


def resolve_multi_rec_model_dir() -> Path:
  return resolve_model_dir(
    default_name=MULTI_REC_MODEL_DIR_NAME,
    env_keys=["QA_AUTO_HW_OCR_MULTI_REC_MODEL_DIR"],
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


def ensure_rec_model(model_dir: Path) -> Tuple[Any, Any, Any, List[str]]:
  model_key = str(model_dir.resolve())
  cached = MODEL_CACHE.get(model_key)
  if cached is not None:
    return cached

  model_file = model_dir / "inference.json"
  params_file = model_dir / "inference.pdiparams"
  if not model_file.exists() or not params_file.exists():
    raise FileNotFoundError(
      f"Model files missing in {model_dir}. "
      f"Expected {model_file.name} and {params_file.name}."
    )

  config = inference.Config(str(model_file), str(params_file))
  config.disable_gpu()
  config.set_cpu_math_library_num_threads(CPU_THREADS)
  config.disable_mkldnn()
  config.switch_use_feed_fetch_ops(False)
  # Keep behavior stable across machines.
  config.switch_ir_optim(False)

  predictor = inference.create_predictor(config)
  input_handle = predictor.get_input_handle(predictor.get_input_names()[0])
  output_handle = predictor.get_output_handle(predictor.get_output_names()[0])
  charset = load_charset(model_dir)
  cached = (predictor, input_handle, output_handle, charset)
  MODEL_CACHE[model_key] = cached
  return cached


def ensure_verify_number_ocr() -> PaddleOCR:
  global VERIFY_NUMBER_OCR
  if VERIFY_NUMBER_OCR is not None:
    return VERIFY_NUMBER_OCR

  det_dir = resolve_det_model_dir()
  multi_rec_dir = resolve_multi_rec_model_dir()
  init_params = inspect.signature(PaddleOCR.__init__).parameters

  kwargs: Dict[str, Any] = {}

  # PaddleOCR 3.x naming.
  if "text_detection_model_dir" in init_params:
    kwargs["text_detection_model_dir"] = str(det_dir)
    if "text_detection_model_name" in init_params:
      kwargs["text_detection_model_name"] = "PP-OCRv5_mobile_det"
  else:
    kwargs["det_model_dir"] = str(det_dir)

  if "text_recognition_model_dir" in init_params:
    kwargs["text_recognition_model_dir"] = str(multi_rec_dir)
    if "text_recognition_model_name" in init_params:
      kwargs["text_recognition_model_name"] = "PP-OCRv5_mobile_rec"
  else:
    kwargs["rec_model_dir"] = str(multi_rec_dir)

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


def decode_ctc(logits: np.ndarray, charset: Sequence[str]) -> Tuple[str, float]:
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
) -> Tuple[str, float]:
  x, y, w, h = box
  h_img, w_img = image_bgr.shape[:2]
  x1 = max(0, x - CROP_PAD_X_LEFT)
  y1 = max(0, y - CROP_PAD_Y)
  x2 = min(w_img, x + w + CROP_PAD_X_RIGHT)
  y2 = min(h_img, y + h + CROP_PAD_Y)
  crop = image_bgr[y1:y2, x1:x2]
  arr = preprocess_rec_input(crop)
  input_handle.reshape(arr.shape)
  input_handle.copy_from_cpu(arr)
  predictor.run()
  out = output_handle.copy_to_cpu()[0]
  return decode_ctc(out, charset)


def extract_alpha_token(text: str) -> str:
  tokens = re.findall(r"[A-Za-z]+", text.lower())
  if not tokens:
    return ""
  return max(tokens, key=len)


def normalize_for_digit_parsing(text: str) -> str:
  # Common OCR confusions around numbers in verify prompt text.
  return text.replace("I", "1").replace("l", "1").replace("|", "1").replace("O", "0").replace("o", "0")


def parse_word_index_from_text(text: str, max_index: int = 12) -> int:
  safe_max_index = max(1, min(24, int(max_index)))
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
  safe_max_index = max(1, min(24, int(max_index)))
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


def detect_text_boxes(
  image_bgr: np.ndarray,
  mask_top_ratio: float = 0.14,
  mask_bottom_ratio: float = 0.90,
) -> List[Tuple[int, int, int, int]]:
  h, w = image_bgr.shape[:2]
  gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

  # Remove top title and bottom button band for stable text-box extraction.
  work = gray.copy()
  if mask_top_ratio > 0:
    work[: int(h * mask_top_ratio), :] = 0
  if mask_bottom_ratio < 1:
    work[int(h * mask_bottom_ratio) :, :] = 0

  _, binary = cv2.threshold(work, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

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


def recognize_mnemonic_grid(
  image_bgr: np.ndarray,
  rows: Sequence[Dict[str, Any]],
  predictor: Any,
  input_handle: Any,
  output_handle: Any,
  charset: Sequence[str],
  num_rows: int = 6,
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

  for row_idx, row in enumerate(dense_rows):
    left_items = [item for item in row["items"] if item[0] + item[2] / 2.0 < x_mid]
    right_items = [item for item in row["items"] if item[0] + item[2] / 2.0 >= x_mid]
    left_box = merge_boxes(left_items)
    right_box = merge_boxes(right_items)
    if left_box is None or right_box is None:
      return None

    left_text, left_conf = recognize_crop(
      image_bgr, left_box, predictor, input_handle, output_handle, charset
    )
    right_text, right_conf = recognize_crop(
      image_bgr, right_box, predictor, input_handle, output_handle, charset
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


def recognize_generic_lines(
  image_bgr: np.ndarray,
  rows: Sequence[Dict[str, Any]],
  predictor: Any,
  input_handle: Any,
  output_handle: Any,
  charset: Sequence[str],
) -> Tuple[str, float]:
  lines: List[str] = []
  confs: List[float] = []
  for row in rows:
    box = merge_boxes(row["items"])
    if box is None:
      continue
    text, conf = recognize_crop(
      image_bgr, box, predictor, input_handle, output_handle, charset
    )
    if text.strip():
      lines.append(text.strip())
      confs.append(conf)

  if not lines:
    # Last fallback: recognize the whole image as one line.
    h, w = image_bgr.shape[:2]
    text, conf = recognize_crop(
      image_bgr, (0, 0, w, h), predictor, input_handle, output_handle, charset
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
  if expected_word_count not in {12, 18, 20, 24}:
    expected_word_count = 0
  verify_max_index = expected_word_count if expected_word_count in {12, 18, 20, 24} else 12

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
        image_bgr, rows, predictor, input_handle, output_handle, charset
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
  # For mnemonic pages, keep full vertical content (18/24 need top and bottom indices).
  use_full_vertical_mask = mnemonic_layout or expected_word_count >= 18
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
        image_bgr, rows, predictor, input_handle, output_handle, charset, num_rows=num_rows
      )
    else:
      # Unknown word count: try all supported layouts in ascending order.
      for num_rows in sorted(MNEMONIC_GRID_WORD_COUNTS.values()):
        mnemonic_result = recognize_mnemonic_grid(
          image_bgr, rows, predictor, input_handle, output_handle, charset, num_rows=num_rows
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
      image_bgr, rows, predictor, input_handle, output_handle, charset
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
  }


def run_once():
  payload_raw = sys.stdin.read()
  payload = parse_payload(payload_raw)
  out = infer_once(payload)
  print(json.dumps(out, ensure_ascii=False))
  sys.stdout.flush()


def run_server():
  ensure_rec_model(resolve_en_model_dir())
  print(json.dumps({"type": "ready"}, ensure_ascii=False))
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
