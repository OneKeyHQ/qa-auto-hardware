import { useEffect, useRef, useState, useCallback } from 'react';
import { createWorker, Worker, PSM } from 'tesseract.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist as bip39English } from '@scure/bip39/wordlists/english.js';
import { slip39English } from '../slip39Wordlist';
import {
  rotateVideoFrameToCanvas,
  cropToROI,
  scaleCanvas,
  MNEMONIC_SCENE,
  VERIFY_NUMBER_SCENE,
  VERIFY_OPTIONS_SCENE,
  type OcrSceneConfig,
} from '../ocr';
import './CameraPanel.css';

/** JPEG quality for OCR-input and crop images (higher = clearer). */
const OCR_JPEG_QUALITY = 0.92;
/** Max side for PaddleOCR input to keep inference latency stable. */
const PADDLE_MAX_IMAGE_SIDE = 1280;
const STORED_MNEMONIC_KEY = 'qa-auto-hw:stored-mnemonic:v1';
const ENABLE_CHECKSUM_GUIDED_AUTOCORRECT = false;
// Production flow should keep this disabled; enabling it forces OCR capture to return failure for debug only.
const RAW_MNEMONIC_OCR_DEBUG_ONLY = false;
const OCR_BACKEND: 'tesseract' | 'paddleocr_en' = 'paddleocr_en';
const BASE_OCR_CHAR_WHITELIST = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.# ';
const BASE_OCR_PARAMS = {
  tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
  tessedit_char_whitelist: BASE_OCR_CHAR_WHITELIST,
  preserve_interword_spaces: '1',
  user_defined_dpi: '300',
  tessjs_create_hocr: '0',
  tessjs_create_tsv: '0',
} as const;
const MNEMONIC_OCR_PARAMS = {
  ...BASE_OCR_PARAMS,
  // Two-column mnemonic grid fits sparse text segmentation better than strict single-block.
  tessedit_pageseg_mode: PSM.SPARSE_TEXT,
} as const;
const MNEMONIC_COLUMN_OCR_PARAMS = {
  ...BASE_OCR_PARAMS,
  tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
} as const;
const NUMBER_OCR_PARAMS = {
  ...BASE_OCR_PARAMS,
  tessedit_pageseg_mode: PSM.SINGLE_LINE,
  tessedit_char_whitelist: '0123456789# ',
} as const;
type OcrParams = Record<string, string | number>;
type OcrWord = {
  text: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

function formatRawOcrDebugText(rawText: string, words: OcrWord[]): string {
  const trimmedRaw = rawText.trim();
  const hasWordBoxes = words.some((item) => item.w > 0 || item.h > 0);
  const wordLines = words
    .map((item, idx) => {
      const text = item.text.trim() || '(empty)';
      if (!hasWordBoxes) {
        return `${idx + 1}. ${text} [${item.confidence.toFixed(0)}%]`;
      }
      return `${idx + 1}. ${text} [${item.confidence.toFixed(0)}%] @(${Math.round(item.x)}, ${Math.round(item.y)})`;
    })
    .join('\n');

  return [
    '原始 OCR 文本:',
    trimmedRaw || '(empty)',
    '',
    hasWordBoxes ? '词框明细:' : '词框明细: 当前后端仅返回行级文本，不返回词框坐标',
    '',
    `原始 OCR 词框 (${words.length}):`,
    wordLines || '(none)',
  ].join('\n');
}

function buildFallbackWordsFromText(rawText: string, confidence: number): OcrWord[] {
  const tokens = rawText
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return tokens.map((token) => ({
    text: token,
    confidence,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  }));
}

interface VideoDevice {
  deviceId: string;
  label: string;
}

interface OcrResult {
  text: string;
  confidence: number;
  timestamp: Date;
}

/** A single recognized mnemonic word with metadata */
interface MnemonicWord {
  index: number;
  word: string;
  original?: string;
  wordConfidence: number;
}

/** Stored mnemonic words from previous recognition */
interface StoredMnemonic {
  words: string[];
  confidences?: number[];
  timestamp: Date;
}

interface OcrTriggerOptions {
  expectedWordCount?: number;
  mergeWithStored?: boolean;
  allowPartial?: boolean;
  requireBip39?: boolean;
}

function parseMnemonicIndexToken(token: string, expectedWordCount: number): number {
  const cleaned = token.replace(/[^0-9A-Za-z|!]/g, '');
  if (!cleaned) return -1;

  // Conservative confusion mapping for index tokens only.
  // Examples: "l2" -> 12, "I3" -> 13, "#O8" -> 8.
  const normalized = cleaned
    .replace(/[Iil|!]/g, '1')
    .replace(/[OoQq]/g, '0');

  if (!/^\d{1,2}$/.test(normalized)) return -1;
  const value = parseInt(normalized, 10);
  if (!Number.isFinite(value)) return -1;
  if (value < 1 || value > expectedWordCount) return -1;
  return value;
}

function buildMnemonicSceneCandidates(
  baseScene: OcrSceneConfig,
  expectedWordCount: number
): OcrSceneConfig[] {
  if (expectedWordCount <= 12) {
    return [baseScene];
  }

  const candidates: OcrSceneConfig[] = [];
  const seen = new Set<string>();
  const add = (scene: OcrSceneConfig) => {
    const normalized: OcrSceneConfig = {
      ...scene,
      roi: {
        x: Math.max(0, Math.round(scene.roi.x)),
        y: Math.max(0, Math.round(scene.roi.y)),
        width: Math.max(80, Math.round(scene.roi.width)),
        height: Math.max(80, Math.round(scene.roi.height)),
      },
      scale: Math.max(1, Math.round(scene.scale)),
    };
    const key =
      `${normalized.roi.x}:${normalized.roi.y}:` +
      `${normalized.roi.width}:${normalized.roi.height}:` +
      `${normalized.scale}:${normalized.useNearestNeighbor ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(normalized);
  };

  if (expectedWordCount >= 24) {
    // 24-word part1 needs stronger top coverage (first rows are easy to clip).
    add({
      ...baseScene,
      roi: {
        x: Math.max(0, baseScene.roi.x - 40),
        y: Math.max(0, baseScene.roi.y - 240),
        width: baseScene.roi.width + 80,
        height: baseScene.roi.height + 620,
      },
      scale: 4,
    });
    add({
      ...baseScene,
      roi: {
        x: Math.max(0, baseScene.roi.x - 28),
        y: Math.max(0, baseScene.roi.y - 180),
        width: baseScene.roi.width + 56,
        height: baseScene.roi.height + 500,
      },
      scale: 4,
    });
    add({
      ...baseScene,
      roi: {
        x: Math.max(0, baseScene.roi.x - 16),
        y: Math.max(0, baseScene.roi.y - 120),
        width: baseScene.roi.width + 32,
        height: baseScene.roi.height + 360,
      },
      scale: 4,
    });
    // Right-column top focus to recover indices 13/14 when global OCR clips upper-right labels.
    add({
      ...baseScene,
      roi: {
        x: Math.max(0, baseScene.roi.x + Math.round(baseScene.roi.width * 0.42)),
        y: Math.max(0, baseScene.roi.y - 280),
        width: Math.round(baseScene.roi.width * 0.64),
        height: baseScene.roi.height + 520,
      },
      scale: 4,
    });
    add({
      ...baseScene,
      roi: {
        x: Math.max(0, baseScene.roi.x + Math.round(baseScene.roi.width * 0.48)),
        y: Math.max(0, baseScene.roi.y - 190),
        width: Math.round(baseScene.roi.width * 0.54),
        height: baseScene.roi.height + 360,
      },
      scale: 4,
    });
    add(baseScene);
    add({
      ...baseScene,
      roi: {
        x: baseScene.roi.x,
        y: baseScene.roi.y + 260,
        width: baseScene.roi.width,
        height: baseScene.roi.height,
      },
    });
    add({
      ...baseScene,
      roi: {
        x: Math.max(0, baseScene.roi.x - 8),
        y: baseScene.roi.y + 330,
        width: baseScene.roi.width + 16,
        height: baseScene.roi.height,
      },
      scale: 3,
    });
    return candidates;
  }

  // 18-word: mild top/bottom-biased crops.
  add(baseScene);
  add({
    ...baseScene,
    roi: {
      x: Math.max(0, baseScene.roi.x - 24),
      y: Math.max(0, baseScene.roi.y - 96),
      width: baseScene.roi.width + 48,
      height: baseScene.roi.height + 280,
    },
    scale: 4,
  });
  add({
    ...baseScene,
    roi: {
      x: baseScene.roi.x,
      y: baseScene.roi.y + 190,
      width: baseScene.roi.width,
      height: baseScene.roi.height,
    },
  });

  return candidates;
}

/**
 * Computes the Levenshtein (edit) distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/**
 * Corrects an OCR word against the BIP39 English wordlist.
 * Returns the original word if it's already valid, or the closest BIP39 word.
 *
 * Tie-breaking: when two candidates have the same Levenshtein distance, prefer
 * the one that the OCR word is a prefix of (e.g. "visua" → "visual" over "visa"),
 * because OCR trailing-character truncation is far more common than mid-word
 * substitution at equal edit distance.
 */
function correctToBip39(ocrWord: string): { word: string; corrected: boolean } {
  if (bip39English.includes(ocrWord)) {
    return { word: ocrWord, corrected: false };
  }
  let bestWord = ocrWord;
  let bestDist = Infinity;
  let bestIsPrefix = false;
  for (const w of bip39English) {
    const dist = levenshteinDistance(ocrWord, w);
    const isPrefix = w.startsWith(ocrWord);
    if (dist < bestDist || (dist === bestDist && isPrefix && !bestIsPrefix)) {
      bestDist = dist;
      bestWord = w;
      bestIsPrefix = isPrefix;
    }
    if (dist === 0) break; // exact match shortcut
  }
  // Keep correction conservative for create-wallet flow to avoid overfitting wrong words.
  return { word: bestWord, corrected: bestDist > 0 && bestDist <= 2 };
}

/**
 * Returns the top-N BIP39 candidate words for an OCR word, sorted by Levenshtein distance.
 * Used for BIP39-guided auto-correction when checksum validation fails.
 *
 * Tie-breaking: prefer candidates where the OCR word is a prefix (trailing truncation is
 * a more common OCR error than mid-word substitution at equal edit distance).
 */
function getBip39Candidates(ocrWord: string, topN: number = 5): { word: string; distance: number }[] {
  const candidates: { word: string; distance: number }[] = [];
  for (const w of bip39English) {
    const dist = levenshteinDistance(ocrWord, w);
    if (dist <= 3) {
      candidates.push({ word: w, distance: dist });
    }
  }
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    // At equal distance, prefer the word that OCR input is a prefix of.
    const aIsPrefix = a.word.startsWith(ocrWord) ? 0 : 1;
    const bIsPrefix = b.word.startsWith(ocrWord) ? 0 : 1;
    return aIsPrefix - bIsPrefix;
  });
  return candidates.slice(0, topN);
}

/**
 * Corrects an OCR word against the SLIP39 English wordlist.
 * Uses the same prefix-match tie-breaking as correctToBip39:
 * when two candidates have equal Levenshtein distance, prefer the one
 * that the OCR word is a prefix of (trailing-char truncation heuristic).
 */
function correctToSlip39(ocrWord: string): { word: string; corrected: boolean } {
  if (slip39English.includes(ocrWord)) {
    return { word: ocrWord, corrected: false };
  }
  let bestWord = ocrWord;
  let bestDist = Infinity;
  let bestIsPrefix = false;
  for (const w of slip39English) {
    const dist = levenshteinDistance(ocrWord, w);
    const isPrefix = w.startsWith(ocrWord);
    if (dist < bestDist || (dist === bestDist && isPrefix && !bestIsPrefix)) {
      bestDist = dist;
      bestWord = w;
      bestIsPrefix = isPrefix;
    }
    if (dist === 0) break;
  }
  return { word: bestWord, corrected: bestDist > 0 && bestDist <= 2 };
}

/**
 * Returns the top-N SLIP39 candidate words for an OCR word, sorted by Levenshtein distance.
 * Tie-breaking: prefer candidates where the OCR word is a prefix.
 */
function getSlip39Candidates(ocrWord: string, topN: number = 5): { word: string; distance: number }[] {
  const candidates: { word: string; distance: number }[] = [];
  for (const w of slip39English) {
    const dist = levenshteinDistance(ocrWord, w);
    if (dist <= 3) {
      candidates.push({ word: w, distance: dist });
    }
  }
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const aIsPrefix = a.word.startsWith(ocrWord) ? 0 : 1;
    const bIsPrefix = b.word.startsWith(ocrWord) ? 0 : 1;
    return aIsPrefix - bIsPrefix;
  });
  return candidates.slice(0, topN);
}

/**
 * Attempts SLIP39 wordlist-guided auto-correction on mnemonic words.
 * Tries top SLIP39 candidates for the lowest-confidence word.
 * Returns true if a valid correction was found (mutates mnemonicWords in-place).
 * Note: SLIP39 checksum validation (RS1024) is not performed here —
 * single-word correction is applied conservatively (distance ≤ 1).
 */
function trySlip39AutoCorrect(mnemonicWords: MnemonicWord[]): boolean {
  // Sort indices by confidence ascending (least confident first).
  const sortedByConf = [...mnemonicWords].sort((a, b) => a.wordConfidence - b.wordConfidence);
  for (const target of sortedByConf) {
    if (slip39English.includes(target.word)) continue; // already valid
    const candidates = getSlip39Candidates(target.word, 3);
    if (candidates.length > 0 && candidates[0].distance <= 1) {
      const idx = mnemonicWords.findIndex(w => w.index === target.index);
      if (idx >= 0) {
        console.log(`[SLIP39 AutoCorrect] Fixed word #${target.index}: "${target.word}" -> "${candidates[0].word}"`);
        mnemonicWords[idx] = { ...mnemonicWords[idx], word: candidates[0].word, original: target.word };
        return true;
      }
    }
  }
  return false;
}

/**
 * Attempts BIP39 checksum-guided auto-correction on mnemonic words.
 * Sorts words by confidence (lowest first), then tries top BIP39 candidates
 * for each suspicious word until a valid mnemonic is found.
 * Mutates the mnemonicWords array in-place if correction succeeds.
 * Returns true if a valid mnemonic was found.
 */
function tryBip39AutoCorrect(mnemonicWords: MnemonicWord[]): boolean {
  if (mnemonicWords.length < 12) return false;

  const words = mnemonicWords.map(w => w.word);
  const phrase = words.join(' ');

  // Already valid
  try {
    if (validateMnemonic(phrase, bip39English)) return true;
  } catch { /* ignore */ }

  // Sort indices by confidence (lowest first) to prioritize suspicious words
  const sortedIndices = mnemonicWords
    .map((w, i) => ({ i, conf: w.wordConfidence }))
    .sort((a, b) => a.conf - b.conf)
    .map(e => e.i);

  // Try single-word substitution first (most common case: only 1 word is wrong)
  for (const idx of sortedIndices) {
    const originalWord = mnemonicWords[idx].original || mnemonicWords[idx].word;
    const candidates = getBip39Candidates(originalWord);

    for (const candidate of candidates) {
      if (candidate.word === mnemonicWords[idx].word) continue; // skip current

      const testWords = [...words];
      testWords[idx] = candidate.word;
      const testPhrase = testWords.join(' ');

      try {
        if (validateMnemonic(testPhrase, bip39English)) {
          console.log(`[BIP39 AutoCorrect] Fixed word #${mnemonicWords[idx].index}: "${mnemonicWords[idx].word}" -> "${candidate.word}" (conf: ${mnemonicWords[idx].wordConfidence.toFixed(0)}%)`);
          mnemonicWords[idx].original = mnemonicWords[idx].original || mnemonicWords[idx].word;
          mnemonicWords[idx].word = candidate.word;
          return true;
        }
      } catch { /* ignore */ }
    }
  }

  // Try two-word substitution for the 3 lowest-confidence words
  const suspectIndices = sortedIndices.slice(0, 3);
  for (let a = 0; a < suspectIndices.length; a++) {
    const idxA = suspectIndices[a];
    const candidatesA = getBip39Candidates(mnemonicWords[idxA].original || mnemonicWords[idxA].word);

    for (let b = a + 1; b < suspectIndices.length; b++) {
      const idxB = suspectIndices[b];
      const candidatesB = getBip39Candidates(mnemonicWords[idxB].original || mnemonicWords[idxB].word);

      for (const cA of candidatesA) {
        for (const cB of candidatesB) {
          const testWords = [...words];
          testWords[idxA] = cA.word;
          testWords[idxB] = cB.word;
          const testPhrase = testWords.join(' ');

          try {
            if (validateMnemonic(testPhrase, bip39English)) {
              console.log(`[BIP39 AutoCorrect] Fixed 2 words: #${mnemonicWords[idxA].index} "${mnemonicWords[idxA].word}"->"${cA.word}", #${mnemonicWords[idxB].index} "${mnemonicWords[idxB].word}"->"${cB.word}"`);
              mnemonicWords[idxA].original = mnemonicWords[idxA].original || mnemonicWords[idxA].word;
              mnemonicWords[idxA].word = cA.word;
              mnemonicWords[idxB].original = mnemonicWords[idxB].original || mnemonicWords[idxB].word;
              mnemonicWords[idxB].word = cB.word;
              return true;
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  console.log('[BIP39 AutoCorrect] Could not find valid mnemonic combination');
  return false;
}

/**
 * Builds ROI crop + scaled OCR input image from a rotated source frame.
 */
function buildPreOcrCanvasFromFrame(
  sourceCanvas: HTMLCanvasElement,
  ocrCanvas: HTMLCanvasElement,
  sceneConfig: OcrSceneConfig
): { imageDataUrl: string; preOcrImageDataUrl: string } | null {
  const cropCanvas = cropToROI(sourceCanvas, sceneConfig.roi);
  const scaledCanvas = scaleCanvas(cropCanvas, sceneConfig.scale, sceneConfig.useNearestNeighbor);
  const ocrCtx = ocrCanvas.getContext('2d');
  if (!ocrCtx) return null;
  ocrCanvas.width = scaledCanvas.width;
  ocrCanvas.height = scaledCanvas.height;
  ocrCtx.clearRect(0, 0, ocrCanvas.width, ocrCanvas.height);
  ocrCtx.drawImage(scaledCanvas, 0, 0);
  const imageDataUrl = cropCanvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY);
  const preOcrImageDataUrl = ocrCanvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY);
  return { imageDataUrl, preOcrImageDataUrl };
}

/**
 * Builds OCR input images directly from live video.
 */
function buildPreOcrCanvasFromVideo(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ocrCanvas: HTMLCanvasElement,
  sceneConfig: OcrSceneConfig
): { imageDataUrl: string; preOcrImageDataUrl: string } | null {
  rotateVideoFrameToCanvas(video, canvas);
  return buildPreOcrCanvasFromFrame(canvas, ocrCanvas, sceneConfig);
}

/**
 * Converts OCR input canvas to PaddleOCR input data URL.
 * Downscales oversized images to reduce inference cost.
 */
function buildPaddleInputDataUrl(
  sourceCanvas: HTMLCanvasElement,
  useNearestNeighbor: boolean
): string {
  const currentMaxSide = Math.max(sourceCanvas.width, sourceCanvas.height);
  if (currentMaxSide <= PADDLE_MAX_IMAGE_SIDE) {
    return sourceCanvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY);
  }

  const ratio = PADDLE_MAX_IMAGE_SIDE / currentMaxSide;
  const targetWidth = Math.max(1, Math.round(sourceCanvas.width * ratio));
  const targetHeight = Math.max(1, Math.round(sourceCanvas.height * ratio));
  const resized = document.createElement('canvas');
  resized.width = targetWidth;
  resized.height = targetHeight;
  const ctx = resized.getContext('2d');
  if (!ctx) {
    return sourceCanvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY);
  }

  ctx.imageSmoothingEnabled = !useNearestNeighbor;
  ctx.imageSmoothingQuality = useNearestNeighbor ? 'low' : 'high';
  ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
  return resized.toDataURL('image/jpeg', OCR_JPEG_QUALITY);
}

/**
 * Captures one rotated full frame so multiple ROI OCR passes share the exact same frame.
 */
function captureRotatedFrameCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  const frameCanvas = document.createElement('canvas');
  rotateVideoFrameToCanvas(video, frameCanvas);
  return frameCanvas;
}

/**
 * Extracts verification word index from OCR text.
 * Priority: digits after "#" -> "单词#N"/"word #N" patterns -> any valid digit in range.
 */
function extractWordIndexFromText(text: string, maxIndex: number = 12): number {
  const safeMaxIndex = Math.max(1, Math.min(24, Math.floor(maxIndex)));
  const normalized = text.trim();
  if (!normalized) return -1;
  const normalizedForDigits = normalized
    // Common OCR confusions on index text.
    .replace(/[Iil|!丨｜]/g, '1')
    .replace(/[Oo]/g, '0');

  const hashMatches = [...normalizedForDigits.matchAll(/[#＃]\s*(\d{1,2})/g)];
  for (let i = hashMatches.length - 1; i >= 0; i--) {
    const value = parseInt(hashMatches[i][1], 10);
    if (value >= 1 && value <= safeMaxIndex) return value;
  }

  const hashAmbiguousMatch = normalized.match(/[#＃]\s*([A-Za-z!丨｜|])/);
  if (hashAmbiguousMatch) {
    const symbol = hashAmbiguousMatch[1];
    const mapped = symbol
      .replace(/[IiLl!丨｜|]/g, '1')
      .replace(/[Oo]/g, '0');
    if (/^\d{1,2}$/.test(mapped)) {
      const value = parseInt(mapped, 10);
      if (value >= 1 && value <= safeMaxIndex) return value;
    }
  }

  const explicitPatterns = [
    /单词\s*[#＃]?\s*(\d{1,2})/i,
    /word\s*[#＃]?\s*(\d{1,2})/i,
    /第\s*(\d{1,2})\s*(个|位)?\s*(单词|词|word)?/i,
    /(\d{1,2})\s*(st|nd|rd|th)\s*(word)?/i,
  ];
  for (const pattern of explicitPatterns) {
    const match = normalizedForDigits.match(pattern);
    if (!match) continue;
    const value = parseInt(match[1], 10);
    if (value >= 1 && value <= safeMaxIndex) return value;
  }

  // Conservative fallback: only accept plain number text when OCR output is short.
  // This avoids misreading unrelated text (e.g. status-bar battery digits) as word index.
  const digitMatches = normalizedForDigits.match(/\d{1,2}/g) || [];
  if (digitMatches.length === 1) {
    const value = parseInt(digitMatches[0], 10);
    const compact = normalizedForDigits.replace(/\s+/g, '');
    if (value >= 1 && value <= safeMaxIndex && compact.length <= 4) {
      return value;
    }
  }

  return -1;
}

/**
 * Extracts up to 3 option words from verification options OCR text.
 * Prefers one token per line to preserve top-to-bottom click order.
 */
function extractVerifyOptionWords(text: string, maxOptions: number = 3): string[] {
  const normalizedLines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const optionsFromLines: string[] = [];
  for (const line of normalizedLines) {
    const tokens = (line.match(/[a-zA-Z]{2,16}/g) ?? [])
      .map((token) => token.toLowerCase().replace(/[^a-z]/g, ''))
      .filter((token) => token.length >= 2 && token.length <= 12);
    if (tokens.length === 0) continue;
    const bestToken = tokens.reduce((longest, current) =>
      current.length > longest.length ? current : longest
    );
    optionsFromLines.push(bestToken);
    if (optionsFromLines.length >= maxOptions) {
      return optionsFromLines;
    }
  }

  // Fallback to ordered tokens when line separation is poor.
  const orderedTokens = (text.match(/[a-zA-Z]{2,16}/g) ?? [])
    .map((token) => token.toLowerCase().replace(/[^a-z]/g, ''))
    .filter((token) => token.length >= 2 && token.length <= 12);

  const unique: string[] = [];
  for (const token of orderedTokens) {
    if (!unique.includes(token)) {
      unique.push(token);
      if (unique.length >= maxOptions) break;
    }
  }
  return unique;
}

/**
 * Strict option mapping: exact match first, otherwise unique nearest mnemonic within small edit distance.
 */
function mapOptionToMnemonicStrict(ocrWord: string, mnemonicWords: string[]): string | null {
  if (mnemonicWords.includes(ocrWord)) return ocrWord;
  const uniqueMnemonicWords = Array.from(new Set(mnemonicWords));

  let bestWord: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestCount = 0;

  for (const mnemonicWord of uniqueMnemonicWords) {
    const distance = levenshteinDistance(ocrWord, mnemonicWord);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestWord = mnemonicWord;
      bestCount = 1;
    } else if (distance === bestDistance) {
      bestCount += 1;
    }
  }

  const maxDistance = ocrWord.length >= 6 ? 2 : 1;
  if (bestWord && bestDistance <= maxDistance && bestCount === 1) {
    return bestWord;
  }

  return null;
}

function CameraPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ocrCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<VideoDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [showCrosshair, setShowCrosshair] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [storedMnemonic, setStoredMnemonic] = useState<StoredMnemonic | null>(null);
  const [fullFrameImageUrl, setFullFrameImageUrl] = useState<string | null>(null);
  const [capturedImageUrl, setCapturedImageUrl] = useState<string | null>(null);
  const [preOcrImageUrl, setPreOcrImageUrl] = useState<string | null>(null);
  const [numberImageUrl, setNumberImageUrl] = useState<string | null>(null);
  const [numberPreOcrImageUrl, setNumberPreOcrImageUrl] = useState<string | null>(null);
  const ocrWorkerRef = useRef<Worker | null>(null);

  const saveStoredMnemonic = useCallback((words: string[], confidences?: number[]) => {
    const normalizedConfidences = Array.isArray(confidences) && confidences.length === words.length
      ? confidences.map((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
        return Math.min(100, value);
      })
      : undefined;
    const payload: StoredMnemonic = { words, confidences: normalizedConfidences, timestamp: new Date() };
    setStoredMnemonic(payload);
    try {
      localStorage.setItem(
        STORED_MNEMONIC_KEY,
        JSON.stringify({
          words: payload.words,
          confidences: payload.confidences,
          timestamp: payload.timestamp.toISOString(),
        })
      );
    } catch (err) {
      console.warn('Failed to persist mnemonic locally:', err);
    }
  }, []);

  const clearStoredMnemonic = useCallback(() => {
    setStoredMnemonic(null);
    try {
      localStorage.removeItem(STORED_MNEMONIC_KEY);
    } catch (err) {
      console.warn('Failed to clear stored mnemonic locally:', err);
    }
  }, []);

  // Restore previously recognized mnemonic words for verification-page debug workflow.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORED_MNEMONIC_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { words?: unknown; confidences?: unknown; timestamp?: unknown };
      if (!Array.isArray(parsed.words) || parsed.words.length === 0) return;
      const words = parsed.words.filter((w): w is string => typeof w === 'string');
      if (words.length === 0) return;
      const confidences = Array.isArray(parsed.confidences)
        ? parsed.confidences.map((value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0))
        : undefined;
      const timestamp =
        typeof parsed.timestamp === 'string' ? new Date(parsed.timestamp) : new Date();
      setStoredMnemonic({ words, confidences, timestamp });
    } catch (err) {
      console.warn('Failed to restore mnemonic from local storage:', err);
    }
  }, []);

  /**
   * Captures the current video frame as a base64-encoded JPEG image.
   * Rotates the frame 90 degrees clockwise to match the UI display (9:16 portrait).
   * Used by MCP Server via IPC to get camera frames.
   */
  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || video.readyState < 2) {
      console.warn('Video not ready for capture');
      return null;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('Failed to get canvas context');
      return null;
    }

    // Rotate 90 degrees clockwise: swap width and height for 9:16 portrait output
    canvas.width = video.videoHeight;
    canvas.height = video.videoWidth;

    // Save context state
    ctx.save();

    // Translate to center, rotate 90 degrees clockwise, then draw
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(
      video,
      -video.videoWidth / 2,
      -video.videoHeight / 2,
      video.videoWidth,
      video.videoHeight
    );

    // Restore context state
    ctx.restore();

    // Convert to base64 JPEG (without the data:image/jpeg;base64, prefix)
    const dataUrl = canvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY);
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

    return base64;
  }, []);

  /** Expected number of mnemonic words */
  const EXPECTED_MNEMONIC_COUNT = 12;
  /** Maximum retry attempts for OCR */
  const MAX_OCR_RETRIES = 3;
  /** Delay between retries in milliseconds */
  const OCR_RETRY_DELAY = 500;

  /**
   * Initializes the Tesseract OCR worker if not already done.
   */
  const ensureOcrWorker = useCallback(async () => {
    if (!ocrWorkerRef.current) {
      console.log('Initializing Tesseract.js worker...');
      ocrWorkerRef.current = await createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            console.log(`OCR progress: ${(m.progress * 100).toFixed(0)}%`);
          }
        },
      });

      await ocrWorkerRef.current.setParameters(BASE_OCR_PARAMS);

      console.log('Tesseract.js worker initialized');
    }
    return ocrWorkerRef.current;
  }, []);

  // Preload OCR worker only when Tesseract backend is enabled.
  useEffect(() => {
    if (OCR_BACKEND !== 'tesseract') {
      return;
    }

    let disposed = false;

    const preloadWorker = async () => {
      try {
        const worker = await ensureOcrWorker();
        if (disposed) {
          await worker.terminate();
          if (ocrWorkerRef.current === worker) {
            ocrWorkerRef.current = null;
          }
        }
      } catch (err) {
        console.warn('Failed to preload OCR worker:', err);
      }
    };

    preloadWorker();

    return () => {
      disposed = true;
    };
  }, [ensureOcrWorker]);

  /**
   * Captures a frame, crops to the scene region, scales it, and runs OCR.
   * Returns raw text, confidence, and the cropped image data URL.
   */
  const runOcrOnRegion = useCallback(async (
    sceneConfig: OcrSceneConfig,
    options?: {
      onImageForOcr?: (dataUrl: string) => void;
      frameCanvas?: HTMLCanvasElement;
      ocrParams?: OcrParams;
      layoutHint?: 'mnemonic' | 'verify-options' | 'verify-number' | 'generic';
      forceTesseract?: boolean;
      expectedWordCount?: number;
    }
  ): Promise<{ rawText: string; confidence: number; imageDataUrl: string; preOcrImageDataUrl: string; words: OcrWord[] } | null> => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ocrCanvas = ocrCanvasRef.current;

    if (!video || !canvas || !ocrCanvas || video.readyState < 2) {
      return null;
    }

    const built = options?.frameCanvas
      ? buildPreOcrCanvasFromFrame(options.frameCanvas, ocrCanvas, sceneConfig)
      : buildPreOcrCanvasFromVideo(video, canvas, ocrCanvas, sceneConfig);
    if (!built) return null;
    const { imageDataUrl, preOcrImageDataUrl } = built;
    const ocrInputDataUrl = OCR_BACKEND === 'paddleocr_en'
      ? buildPaddleInputDataUrl(ocrCanvas, sceneConfig.useNearestNeighbor)
      : preOcrImageDataUrl;

    options?.onImageForOcr?.(ocrInputDataUrl);

    const inferredLayoutHint = (() => {
      if (options?.layoutHint) return options.layoutHint;
      if (
        sceneConfig.roi.width === MNEMONIC_SCENE.roi.width
        && sceneConfig.roi.height === MNEMONIC_SCENE.roi.height
      ) {
        return 'mnemonic' as const;
      }
      if (
        sceneConfig.roi.width === VERIFY_OPTIONS_SCENE.roi.width
        && sceneConfig.roi.height === VERIFY_OPTIONS_SCENE.roi.height
      ) {
        return 'verify-options' as const;
      }
      return 'generic' as const;
    })();

    if (!options?.forceTesseract && OCR_BACKEND === 'paddleocr_en' && window.electronAPI?.paddleOcrEnRecognize) {
      const paddle = await window.electronAPI.paddleOcrEnRecognize(
        ocrInputDataUrl,
        inferredLayoutHint,
        options?.expectedWordCount
      );
      const fallbackConfidence = Number.isFinite(paddle.confidence) ? paddle.confidence : 0;
      return {
        rawText: paddle.text || '',
        confidence: fallbackConfidence,
        imageDataUrl,
        preOcrImageDataUrl: ocrInputDataUrl,
        words: buildFallbackWordsFromText(paddle.text || '', fallbackConfidence),
      };
    }

    const worker = await ensureOcrWorker();
    if (options?.ocrParams) {
      await worker.setParameters(options.ocrParams);
    }
    const result = await worker.recognize(ocrCanvas);
    if (options?.ocrParams) {
      await worker.setParameters(BASE_OCR_PARAMS);
    }

    // Extract word-level data from Tesseract's nested structure
    const ocrWords: OcrWord[] = [];
    if (result.data.blocks) {
      for (const block of result.data.blocks) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            for (const word of line.words) {
              const bbox = word.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
              ocrWords.push({
                text: word.text,
                confidence: word.confidence,
                x: bbox.x0,
                y: bbox.y0,
                w: Math.max(0, bbox.x1 - bbox.x0),
                h: Math.max(0, bbox.y1 - bbox.y0),
              });
            }
          }
        }
      }
    }

    return {
      rawText: result.data.text,
      confidence: result.data.confidence,
      imageDataUrl,
      preOcrImageDataUrl,
      words: ocrWords,
    };
  }, [ensureOcrWorker]);

  /**
   * Captures a frame, crops to the number region, and runs OCR optimized for detecting
   * a single number 1-N (used for verification page "#N" detection, N=12/18/24).
   * Uses scene-config upscaling and digits-only OCR parameters for maximum accuracy.
   */
  const runNumberOcr = useCallback(async (options?: {
    onImageForOcr?: (dataUrl: string) => void;
    frameCanvas?: HTMLCanvasElement;
    maxIndex?: number;
  }): Promise<{ number: number; rawText: string; confidence: number; imageDataUrl: string; preOcrImageDataUrl: string } | null> => {
    const maxIndex = Math.max(1, Math.min(24, Math.floor(options?.maxIndex ?? 12)));
    const fallbackScenes: OcrSceneConfig[] = [
      // Tight first-line crop (often improves "#N" visibility).
      {
        ...VERIFY_NUMBER_SCENE,
        roi: {
          x: VERIFY_NUMBER_SCENE.roi.x,
          y: Math.max(0, VERIFY_NUMBER_SCENE.roi.y - 20),
          width: VERIFY_NUMBER_SCENE.roi.width,
          height: Math.max(60, Math.round(VERIFY_NUMBER_SCENE.roi.height * 0.72)),
        },
        scale: 7,
      },
      // Extra-tight hash-right area to catch a faint single digit (e.g. "#1").
      {
        ...VERIFY_NUMBER_SCENE,
        roi: {
          x: VERIFY_NUMBER_SCENE.roi.x + Math.round(VERIFY_NUMBER_SCENE.roi.width * 0.32),
          y: Math.max(0, VERIFY_NUMBER_SCENE.roi.y - 20),
          width: Math.max(120, Math.round(VERIFY_NUMBER_SCENE.roi.width * 0.45)),
          height: Math.max(56, Math.round(VERIFY_NUMBER_SCENE.roi.height * 0.70)),
        },
        scale: 8,
      },
      VERIFY_NUMBER_SCENE,
      {
        ...VERIFY_NUMBER_SCENE,
        roi: {
          x: Math.max(0, VERIFY_NUMBER_SCENE.roi.x - 40),
          y: Math.max(0, VERIFY_NUMBER_SCENE.roi.y - 70),
          width: VERIFY_NUMBER_SCENE.roi.width + 120,
          height: VERIFY_NUMBER_SCENE.roi.height + 140,
        },
        scale: 4,
      },
      {
        ...VERIFY_NUMBER_SCENE,
        roi: {
          x: Math.max(0, VERIFY_NUMBER_SCENE.roi.x - 80),
          y: Math.max(0, VERIFY_NUMBER_SCENE.roi.y - 120),
          width: VERIFY_NUMBER_SCENE.roi.width + 220,
          height: VERIFY_NUMBER_SCENE.roi.height + 260,
        },
        scale: 3,
      },
    ];
    let bestAttempt: {
      rawText: string;
      confidence: number;
      imageDataUrl: string;
      preOcrImageDataUrl: string;
    } | null = null;
    type NumberCandidate = {
      number: number;
      rawText: string;
      confidence: number;
      imageDataUrl: string;
      preOcrImageDataUrl: string;
      score: number;
    };
    const detectedCandidates: NumberCandidate[] = [];

    const scoreNumberCandidate = (rawText: string, number: number, confidence: number): number => {
      let score = confidence;
      const normalized = rawText.toLowerCase();
      if (new RegExp(`[#＃]\\s*${number}\\b`, 'i').test(normalized)) {
        score += 28;
      }
      if (new RegExp(`\\b(word|单词)\\s*[#＃]?\\s*${number}\\b`, 'i').test(normalized)) {
        score += 18;
      }
      if (normalized.includes(`\n${number}\n`) || normalized.trim().endsWith(` ${number}`)) {
        score += 6;
      }
      return score;
    };

    const pickBestCandidate = (candidates: NumberCandidate[]): NumberCandidate | null => {
      if (candidates.length === 0) return null;
      const grouped = new Map<number, {
        totalScore: number;
        count: number;
        best: NumberCandidate;
      }>();
      for (const candidate of candidates) {
        const current = grouped.get(candidate.number);
        if (!current) {
          grouped.set(candidate.number, {
            totalScore: candidate.score,
            count: 1,
            best: candidate,
          });
          continue;
        }
        current.totalScore += candidate.score;
        current.count += 1;
        if (
          candidate.score > current.best.score
          || (candidate.score === current.best.score && candidate.confidence > current.best.confidence)
        ) {
          current.best = candidate;
        }
      }

      const ranked = Array.from(grouped.values()).sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        if (b.count !== a.count) return b.count - a.count;
        if (b.best.score !== a.best.score) return b.best.score - a.best.score;
        return a.best.number - b.best.number;
      });
      return ranked[0]?.best ?? null;
    };

    for (const scene of fallbackScenes) {
      const result = await runOcrOnRegion(scene, {
        onImageForOcr: options?.onImageForOcr,
        frameCanvas: options?.frameCanvas,
        ocrParams: OCR_BACKEND === 'tesseract' ? NUMBER_OCR_PARAMS : undefined,
        layoutHint: 'verify-number',
        expectedWordCount: maxIndex,
      });
      if (!result) continue;

      const rawText = result.rawText;
      const confidence = result.confidence;
      const detectedNumber = extractWordIndexFromText(rawText, maxIndex);

      if (!bestAttempt || confidence > bestAttempt.confidence) {
        bestAttempt = {
          rawText,
          confidence,
          imageDataUrl: result.imageDataUrl,
          preOcrImageDataUrl: result.preOcrImageDataUrl,
        };
      }

      console.log(
        `[CameraPanel] Number OCR raw: "${rawText.trim()}", confidence: ${confidence.toFixed(0)}%, roi=(${scene.roi.x},${scene.roi.y},${scene.roi.width},${scene.roi.height})`
      );

      if (detectedNumber !== -1) {
        detectedCandidates.push({
          number: detectedNumber,
          rawText,
          confidence,
          imageDataUrl: result.imageDataUrl,
          preOcrImageDataUrl: result.preOcrImageDataUrl,
          score: scoreNumberCandidate(rawText, detectedNumber, confidence),
        });
      }
    }

    const bestDetected = pickBestCandidate(detectedCandidates);
    if (bestDetected) {
      return {
        number: bestDetected.number,
        rawText: bestDetected.rawText,
        confidence: bestDetected.confidence,
        imageDataUrl: bestDetected.imageDataUrl,
        preOcrImageDataUrl: bestDetected.preOcrImageDataUrl,
      };
    }

    if (bestAttempt) {
      // Paddle pass failed to get a valid index; fallback to Tesseract digits-only across ROI variants.
      const tesseractCandidates: NumberCandidate[] = [];
      for (const scene of fallbackScenes) {
        const tesseractResult = await runOcrOnRegion(scene, {
          onImageForOcr: options?.onImageForOcr,
          frameCanvas: options?.frameCanvas,
          forceTesseract: true,
          ocrParams: NUMBER_OCR_PARAMS,
          layoutHint: 'verify-number',
          expectedWordCount: maxIndex,
        });
        if (!tesseractResult) continue;

        const tesseractIndex = extractWordIndexFromText(tesseractResult.rawText, maxIndex);
        console.log(
          `[CameraPanel] Number OCR tesseract fallback raw: "${tesseractResult.rawText.trim()}", confidence: ${tesseractResult.confidence.toFixed(0)}%, roi=(${scene.roi.x},${scene.roi.y},${scene.roi.width},${scene.roi.height})`
        );
        if (tesseractIndex !== -1) {
          tesseractCandidates.push({
            number: tesseractIndex,
            rawText: tesseractResult.rawText,
            confidence: tesseractResult.confidence,
            imageDataUrl: tesseractResult.imageDataUrl,
            preOcrImageDataUrl: tesseractResult.preOcrImageDataUrl,
            score: scoreNumberCandidate(
              tesseractResult.rawText,
              tesseractIndex,
              tesseractResult.confidence
            ),
          });
        }
      }

      const bestTesseract = pickBestCandidate(tesseractCandidates);
      if (bestTesseract) {
        return {
          number: bestTesseract.number,
          rawText: bestTesseract.rawText,
          confidence: bestTesseract.confidence,
          imageDataUrl: bestTesseract.imageDataUrl,
          preOcrImageDataUrl: bestTesseract.preOcrImageDataUrl,
        };
      }

      return {
        number: -1,
        rawText: bestAttempt.rawText,
        confidence: bestAttempt.confidence,
        imageDataUrl: bestAttempt.imageDataUrl,
        preOcrImageDataUrl: bestAttempt.preOcrImageDataUrl,
      };
    }

    return null;
  }, [runOcrOnRegion]);

  const runVerifyOptionsOcr = useCallback(async (options?: {
    onImageForOcr?: (dataUrl: string) => void;
    frameCanvas?: HTMLCanvasElement;
    targetWord?: string;
  }): Promise<{
    rawText: string;
    rawOptions: string[];
    confidence: number;
    imageDataUrl: string;
    preOcrImageDataUrl: string;
  } | null> => {
    const fallbackScenes: OcrSceneConfig[] = [
      VERIFY_OPTIONS_SCENE,
      {
        ...VERIFY_OPTIONS_SCENE,
        roi: {
          x: Math.max(0, VERIFY_OPTIONS_SCENE.roi.x - 40),
          y: Math.max(0, VERIFY_OPTIONS_SCENE.roi.y - 40),
          width: VERIFY_OPTIONS_SCENE.roi.width + 80,
          height: VERIFY_OPTIONS_SCENE.roi.height + 120,
        },
        scale: 4,
      },
      {
        ...VERIFY_OPTIONS_SCENE,
        roi: {
          x: Math.max(0, VERIFY_OPTIONS_SCENE.roi.x - 80),
          y: Math.max(0, VERIFY_OPTIONS_SCENE.roi.y - 90),
          width: VERIFY_OPTIONS_SCENE.roi.width + 160,
          height: VERIFY_OPTIONS_SCENE.roi.height + 220,
        },
        scale: 3,
      },
    ];
    let bestAttempt: {
      rawText: string;
      rawOptions: string[];
      confidence: number;
      imageDataUrl: string;
      preOcrImageDataUrl: string;
      score: number;
      scene: OcrSceneConfig;
    } | null = null;

    for (const scene of fallbackScenes) {
      const result = await runOcrOnRegion(scene, {
        frameCanvas: options?.frameCanvas,
        layoutHint: 'verify-options',
      });
      if (!result) continue;

      const rawOptions = extractVerifyOptionWords(result.rawText, 3);
      let score = rawOptions.length * 120 + result.confidence;
      const targetWord = options?.targetWord?.toLowerCase().trim();
      if (targetWord) {
        if (rawOptions.includes(targetWord)) {
          score += 300;
        } else if (rawOptions.length > 0) {
          const minDist = Math.min(...rawOptions.map((word) => levenshteinDistance(word, targetWord)));
          if (minDist <= 1) {
            score += 180;
          } else if (minDist <= 2) {
            score += 90;
          }
        }
      }

      console.log(
        `[CameraPanel] Verify options OCR raw="${result.rawText.replace(/\s+/g, ' ').trim()}", options=[${rawOptions.join(', ')}], conf=${result.confidence.toFixed(0)}%, roi=(${scene.roi.x},${scene.roi.y},${scene.roi.width},${scene.roi.height}), score=${score.toFixed(1)}`
      );

      if (!bestAttempt || score > bestAttempt.score) {
        bestAttempt = {
          rawText: result.rawText,
          rawOptions,
          confidence: result.confidence,
          imageDataUrl: result.imageDataUrl,
          preOcrImageDataUrl: result.preOcrImageDataUrl,
          score,
          scene,
        };
      }
    }

    if (!bestAttempt) return null;
    options?.onImageForOcr?.(bestAttempt.preOcrImageDataUrl);
    return {
      rawText: bestAttempt.rawText,
      rawOptions: bestAttempt.rawOptions,
      confidence: bestAttempt.confidence,
      imageDataUrl: bestAttempt.imageDataUrl,
      preOcrImageDataUrl: bestAttempt.preOcrImageDataUrl,
    };
  }, [runOcrOnRegion]);

  /**
   * Captures current frame and runs OCR recognition on the standard mnemonic ROI.
   * Applies BIP39 wordlist correction to fix misrecognized words.
   * Returns the recognized mnemonic words or null if failed.
   */
  const runSingleOcr = useCallback(async (options?: {
    onImageForOcr?: (dataUrl: string) => void;
    sceneConfig?: OcrSceneConfig;
    frameCanvas?: HTMLCanvasElement;
    expectedWordCount?: number;
    applyBip39Wordlist?: boolean;
  }): Promise<{
    mnemonicWords: MnemonicWord[];
    rawText: string;
    confidence: number;
    imageDataUrl: string;
    preOcrImageDataUrl: string;
    bip39Valid: boolean;
    hasCompleteSequence: boolean;
    missingIndices: number[];
  } | null> => {
    const sceneConfig = options?.sceneConfig ?? MNEMONIC_SCENE;
    const expectedWordCount = Math.max(
      12,
      Math.min(24, Math.floor(options?.expectedWordCount ?? EXPECTED_MNEMONIC_COUNT))
    );
    const applyBip39Wordlist = options?.applyBip39Wordlist ?? true;
    const applySlip39Wordlist = !applyBip39Wordlist; // SLIP39 flow uses its own wordlist
    const sceneCandidates = buildMnemonicSceneCandidates(sceneConfig, expectedWordCount);

    // Extract numbered mnemonic words.
    const mnemonicPattern = new RegExp(
      '(?:^|\\s)([0-9A-Za-z|!]{1,2})\\s*[.。,，:;：)]?\\s*([a-zA-Z]{3,8})\\b',
      'gi'
    );
    const compactMnemonicPattern = new RegExp(
      '(?:^|\\s)([0-9A-Za-z|!]{1,2})([a-zA-Z]{3,8})\\b',
      'gi'
    );
    const indexedWords = new Map<number, MnemonicWord>();
    let bestSceneResult: {
      rawText: string;
      confidence: number;
      imageDataUrl: string;
      preOcrImageDataUrl: string;
      words: OcrWord[];
    } | null = null;
    let aggregatedRawText = '';

    const buildWordConfidenceMap = (ocrWords: OcrWord[]) => {
      const map = new Map<string, number>();
      for (const w of ocrWords) {
        const clean = w.text.replace(/[^a-zA-Z]/g, '').toLowerCase();
        if (clean.length >= 2) {
          map.set(clean, w.confidence);
        }
      }
      return map;
    };

    const upsertCandidateByConfidence = (
      index: number,
      ocrWord: string,
      wordConf: number,
      mode: 'default' | 'column-row' = 'default'
    ) => {
      if (index < 1 || index > expectedWordCount) return;
      const normalizedWord = ocrWord.toLowerCase();
      const correction = applyBip39Wordlist
        ? correctToBip39(normalizedWord)
        : applySlip39Wordlist
          ? correctToSlip39(normalizedWord)
          : { word: normalizedWord, corrected: false };
      const candidate: MnemonicWord = {
        index,
        word: correction.word,
        original: correction.corrected ? normalizedWord : undefined,
        wordConfidence: wordConf,
      };
      const existing = indexedWords.get(index);
      if (!existing) {
        indexedWords.set(index, candidate);
        return;
      }
      if (mode === 'column-row') {
        const shouldReplace = candidate.wordConfidence >= existing.wordConfidence * 0.85;
        if (shouldReplace) {
          indexedWords.set(index, candidate);
        }
        return;
      }
      if (candidate.wordConfidence > existing.wordConfidence) {
        indexedWords.set(index, candidate);
      }
    };

    const upsertCandidate = (
      index: number,
      ocrWord: string,
      fallbackConfidence: number,
      confidenceMap: Map<string, number>
    ) => {
      const normalizedWord = ocrWord.toLowerCase();
      const wordConf = confidenceMap.get(normalizedWord) ?? fallbackConfidence;
      upsertCandidateByConfidence(index, normalizedWord, wordConf, 'default');
    };

    const extractIndexedFromText = (
      rawText: string,
      fallbackConfidence: number,
      confidenceMap: Map<string, number>
    ) => {
      mnemonicPattern.lastIndex = 0;
      let match;
      while ((match = mnemonicPattern.exec(rawText)) !== null) {
        const index = parseMnemonicIndexToken(match[1], expectedWordCount);
        if (index === -1) continue;
        const ocrWord = match[2];
        upsertCandidate(index, ocrWord, fallbackConfidence, confidenceMap);
      }

      compactMnemonicPattern.lastIndex = 0;
      while ((match = compactMnemonicPattern.exec(rawText)) !== null) {
        const index = parseMnemonicIndexToken(match[1], expectedWordCount);
        if (index === -1) continue;
        const ocrWord = match[2];
        upsertCandidate(index, ocrWord, fallbackConfidence, confidenceMap);
      }

      // Handles glued rows like "2.dawnI8.thought" where separator chars bleed into next index.
      const stickyPairPattern = /([0-9A-Za-z|!]{1,2})\s*[.。,，:;：)]\s*([a-zA-Z]{3,10}?)(?=(?:\s*[Iil|!]{0,1}\s*[0-9A-Za-z|!]{1,2}\s*[.。,，:;：)]|\s*$))/gi;
      while ((match = stickyPairPattern.exec(rawText)) !== null) {
        const index = parseMnemonicIndexToken(match[1], expectedWordCount);
        if (index === -1) continue;
        const ocrWord = match[2];
        upsertCandidate(index, ocrWord, fallbackConfidence, confidenceMap);
      }
    };

    const extractIndexedFromTokenPairs = (
      ocrWords: OcrWord[],
      fallbackConfidence: number,
      confidenceMap: Map<string, number>
    ) => {
      const tokens = ocrWords
        .map((item) => item.text.trim())
        .filter((token) => token.length > 0);

      for (let i = 0; i < tokens.length; i++) {
        const current = tokens[i];
        const compactMatch = current.match(/^([#＃]?[0-9A-Za-z|!]{1,2})[.。,，:;：)]([a-zA-Z]{3,8})$/);
        if (compactMatch) {
          const index = parseMnemonicIndexToken(compactMatch[1], expectedWordCount);
          if (index !== -1) {
            upsertCandidate(index, compactMatch[2], fallbackConfidence, confidenceMap);
            continue;
          }
        }

        const index = parseMnemonicIndexToken(current, expectedWordCount);
        if (index === -1) continue;
        const next = tokens[i + 1];
        if (!next) continue;
        const nextWord = next.replace(/[^a-zA-Z]/g, '');
        if (nextWord.length < 3 || nextWord.length > 8) continue;
        upsertCandidate(index, nextWord, fallbackConfidence, confidenceMap);
      }
    };

    const extractColumnWordsByBoxes = (
      ocrWords: OcrWord[],
      columnHeight: number
    ): Array<{ word: string; confidence: number; y: number }> => {
      const entries = ocrWords
        .map((item) => {
          const word = item.text.replace(/[^a-zA-Z]/g, '').toLowerCase();
          const yCenter = item.y + item.h / 2;
          return {
            word,
            confidence: item.confidence,
            y: yCenter,
          };
        })
        .filter((item) => item.word.length >= 3 && item.word.length <= 8)
        .sort((a, b) => a.y - b.y);

      if (entries.length === 0) return [];

      const rowTolerance = Math.max(10, Math.round((columnHeight / 6) * 0.35));
      const groups: Array<{
        yMean: number;
        items: Array<{ word: string; confidence: number; y: number }>;
      }> = [];

      for (const entry of entries) {
        const last = groups[groups.length - 1];
        if (!last || Math.abs(entry.y - last.yMean) > rowTolerance) {
          groups.push({ yMean: entry.y, items: [entry] });
          continue;
        }
        last.items.push(entry);
        last.yMean = last.items.reduce((sum, item) => sum + item.y, 0) / last.items.length;
      }

      return groups.slice(0, 6).map((group) => {
        const best = [...group.items].sort((a, b) => b.confidence - a.confidence)[0];
        return {
          word: best.word,
          confidence: best.confidence,
          y: group.yMean,
        };
      });
    };

    const applyColumnRows = (
      rowWords: Array<{ word: string; confidence: number; y: number }>,
      startIndex: number,
      endIndex: number,
      columnHeight: number
    ) => {
      if (rowWords.length === 0) return;

      const slotCount = endIndex - startIndex + 1;
      const maxShift = Math.max(0, slotCount - rowWords.length);
      const rowHeight = columnHeight / slotCount;
      const estimatedShift = Math.max(
        0,
        Math.min(maxShift, Math.round(rowWords[0].y / rowHeight - 0.5))
      );

      const topAlignedDense = rowWords.length >= 5 && rowWords[0].y <= columnHeight / 3;
      let bestShift = topAlignedDense ? 0 : estimatedShift;
      let bestScore = Number.NEGATIVE_INFINITY;

      if (!topAlignedDense) {
        for (let shift = 0; shift <= maxShift; shift++) {
          let score = -Math.abs(shift - estimatedShift) * 0.25;
          rowWords.forEach((entry, rowIdx) => {
            const index = startIndex + shift + rowIdx;
            const existing = indexedWords.get(index);
            if (!existing) return;
            const normalized = entry.word.toLowerCase();
            const expectedWord = applyBip39Wordlist
              ? correctToBip39(normalized).word
              : applySlip39Wordlist
                ? correctToSlip39(normalized).word
                : normalized;
            if (existing.word === expectedWord) {
              score += 2;
            } else if (levenshteinDistance(existing.word, expectedWord) <= 1) {
              score += 1;
            }
          });
          if (score > bestScore) {
            bestScore = score;
            bestShift = shift;
          }
        }
      }

      rowWords.forEach((entry, rowIdx) => {
        const index = startIndex + bestShift + rowIdx;
        if (index > endIndex) return;
        upsertCandidateByConfidence(index, entry.word, entry.confidence, 'column-row');
      });
    };

    for (let i = 0; i < sceneCandidates.length; i++) {
      const scene = sceneCandidates[i];
      const sceneResult = await runOcrOnRegion(scene, {
        onImageForOcr: options?.onImageForOcr,
        frameCanvas: options?.frameCanvas,
        ocrParams: MNEMONIC_OCR_PARAMS,
        layoutHint: 'mnemonic',
        expectedWordCount,
      });
      if (!sceneResult) continue;

      if (!bestSceneResult || sceneResult.confidence > bestSceneResult.confidence) {
        bestSceneResult = sceneResult;
      }

      aggregatedRawText += `${aggregatedRawText ? '\n' : ''}[SCENE ${i + 1}] ${scene.roi.x},${scene.roi.y},${scene.roi.width},${scene.roi.height}\n${sceneResult.rawText}`;
      const confidenceMap = buildWordConfidenceMap(sceneResult.words);
      extractIndexedFromText(sceneResult.rawText, sceneResult.confidence, confidenceMap);
      extractIndexedFromTokenPairs(sceneResult.words, sceneResult.confidence, confidenceMap);

      if (indexedWords.size === expectedWordCount) {
        break;
      }
    }

    if (!bestSceneResult) return null;

    // Last-resort fallback for 18/24: if indices are unreadable but OCR text has enough wordlist-like
    // words, map sequentially so the flow can continue and surface concrete words for debugging.
    if ((applyBip39Wordlist || applySlip39Wordlist) && indexedWords.size === 0 && expectedWordCount >= 18) {
      const tokens = (aggregatedRawText.match(/[a-zA-Z]{3,8}/g) || [])
        .map((token) => token.toLowerCase());
      const activeWordlist = applyBip39Wordlist ? bip39English : slip39English;
      const correctFn = applyBip39Wordlist ? correctToBip39 : correctToSlip39;
      const orderedWords: string[] = [];
      for (const token of tokens) {
        const corrected = correctFn(token).word;
        const isLikelyBip39 = activeWordlist.includes(token) || levenshteinDistance(token, corrected) <= 1;
        if (!isLikelyBip39) continue;
        orderedWords.push(corrected);
        if (orderedWords.length >= expectedWordCount) break;
      }
      if (orderedWords.length >= expectedWordCount) {
        for (let i = 0; i < expectedWordCount; i++) {
          upsertCandidateByConfidence(i + 1, orderedWords[i], bestSceneResult.confidence, 'default');
        }
        console.warn(
          `[CameraPanel] Mnemonic OCR used sequential fallback for ${expectedWordCount} words (indices unreadable).`
        );
      }
    }

    // If direct indexed parsing is incomplete, run per-column OCR on the same frame
    // and fill missing slots by row order. This is strategy-level fallback, not image filtering.
    if (
      indexedWords.size < expectedWordCount
      && OCR_BACKEND !== 'paddleocr_en'
      && expectedWordCount === 12
    ) {
      const video = videoRef.current;
      const sharedFrameCanvas = options?.frameCanvas
        ?? (video && video.readyState >= 2 ? captureRotatedFrameCanvas(video) : undefined);

      if (sharedFrameCanvas) {
        const centerGap = 24;
        const leftWidth = Math.floor((sceneConfig.roi.width - centerGap) / 2);
        const rightWidth = sceneConfig.roi.width - centerGap - leftWidth;
        const leftScene: OcrSceneConfig = {
          ...sceneConfig,
          roi: {
            x: sceneConfig.roi.x,
            y: sceneConfig.roi.y,
            width: leftWidth,
            height: sceneConfig.roi.height,
          },
        };
        const rightScene: OcrSceneConfig = {
          ...sceneConfig,
          roi: {
            x: sceneConfig.roi.x + leftWidth + centerGap,
            y: sceneConfig.roi.y,
            width: rightWidth,
            height: sceneConfig.roi.height,
          },
        };

        const leftResult = await runOcrOnRegion(leftScene, {
          frameCanvas: sharedFrameCanvas,
          ocrParams: MNEMONIC_COLUMN_OCR_PARAMS,
        });
        const rightResult = await runOcrOnRegion(rightScene, {
          frameCanvas: sharedFrameCanvas,
          ocrParams: MNEMONIC_COLUMN_OCR_PARAMS,
        });

        if (leftResult) {
          aggregatedRawText += `\n[LEFT]\n${leftResult.rawText}`;
          const leftConfidenceMap = buildWordConfidenceMap(leftResult.words);
          extractIndexedFromText(leftResult.rawText, leftResult.confidence, leftConfidenceMap);
          extractIndexedFromTokenPairs(leftResult.words, leftResult.confidence, leftConfidenceMap);
          const leftRows = extractColumnWordsByBoxes(leftResult.words, leftScene.roi.height);
          applyColumnRows(leftRows, 1, 6, leftScene.roi.height);
        }

        if (rightResult) {
          aggregatedRawText += `\n[RIGHT]\n${rightResult.rawText}`;
          const rightConfidenceMap = buildWordConfidenceMap(rightResult.words);
          extractIndexedFromText(rightResult.rawText, rightResult.confidence, rightConfidenceMap);
          extractIndexedFromTokenPairs(rightResult.words, rightResult.confidence, rightConfidenceMap);
          const rightRows = extractColumnWordsByBoxes(rightResult.words, rightScene.roi.height);
          applyColumnRows(rightRows, 7, 12, rightScene.roi.height);
        }
      }
    }

    const mnemonicWords = Array.from(indexedWords.values());
    // Sort by original index number
    mnemonicWords.sort((a, b) => a.index - b.index);
    const hasCompleteSequence = mnemonicWords.length === expectedWordCount
      && mnemonicWords.every((item, idx) => item.index === idx + 1);
    const missingIndices: number[] = [];
    for (let i = 1; i <= expectedWordCount; i++) {
      if (!indexedWords.has(i)) {
        missingIndices.push(i);
      }
    }

    // Validate the full mnemonic against BIP39 checksum
    let bip39Valid = false;
    if (hasCompleteSequence && applyBip39Wordlist) {
      const phrase = mnemonicWords.map(w => w.word).join(' ');
      try {
        bip39Valid = validateMnemonic(phrase, bip39English);
      } catch {
        bip39Valid = false;
      }
      console.log(`BIP39 validation: ${bip39Valid ? 'VALID' : 'INVALID'} - "${phrase}"`);

      // If BIP39 invalid, attempt smart auto-correction on low-confidence words
      if (!bip39Valid && ENABLE_CHECKSUM_GUIDED_AUTOCORRECT) {
        const corrected = tryBip39AutoCorrect(mnemonicWords);
        if (corrected) {
          bip39Valid = true;
          console.log(`BIP39 auto-correction succeeded!`);
        }
      }
    } else if (hasCompleteSequence && applySlip39Wordlist) {
      // SLIP39 flow: no checksum validation, but apply conservative single-word correction
      // for any word that is still not in the SLIP39 wordlist.
      const anyInvalid = mnemonicWords.some(w => !slip39English.includes(w.word));
      if (anyInvalid) {
        trySlip39AutoCorrect(mnemonicWords);
      }
      console.log('[CameraPanel] SLIP39 OCR complete (SLIP39 wordlist correction applied).');
    } else if (hasCompleteSequence) {
      console.log('[CameraPanel] Mnemonic OCR complete (non-BIP39 flow), skipped BIP39 validation.');
    } else {
      console.log(
        `[CameraPanel] Mnemonic OCR indices incomplete: [${mnemonicWords.map((w) => w.index).join(', ')}], missing=[${missingIndices.join(', ')}]`
      );
    }

    return {
      rawText: aggregatedRawText || bestSceneResult.rawText,
      confidence: bestSceneResult.confidence,
      imageDataUrl: bestSceneResult.imageDataUrl,
      preOcrImageDataUrl: bestSceneResult.preOcrImageDataUrl,
      mnemonicWords,
      bip39Valid,
      hasCompleteSequence,
      missingIndices,
    };
  }, [runOcrOnRegion]);

  /**
   * Performs OCR recognition on the current camera frame.
   * Automatically retries if the result doesn't meet expectations.
   */
  const performOcr = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || video.readyState < 2) {
      console.warn('Video not ready for OCR');
      return;
    }

    setIsOcrProcessing(true);
    setOcrResult(null);
    setFullFrameImageUrl(null);
    setCapturedImageUrl(null);
    setPreOcrImageUrl(null);
    setNumberImageUrl(null);
    setNumberPreOcrImageUrl(null);

    try {
      if (RAW_MNEMONIC_OCR_DEBUG_ONLY) {
        const rawResult = await runOcrOnRegion(MNEMONIC_SCENE, {
          ocrParams: MNEMONIC_OCR_PARAMS,
        });
        if (!rawResult) {
          throw new Error('Raw OCR capture failed');
        }
        setCapturedImageUrl(rawResult.imageDataUrl);
        setPreOcrImageUrl(rawResult.preOcrImageDataUrl);
        setOcrResult({
          text: formatRawOcrDebugText(rawResult.rawText, rawResult.words),
          confidence: rawResult.confidence,
          timestamp: new Date(),
        });
        return;
      }

      let bestResult: {
        mnemonicWords: MnemonicWord[];
        rawText: string;
        confidence: number;
        imageDataUrl: string;
        preOcrImageDataUrl: string;
        bip39Valid: boolean;
        hasCompleteSequence: boolean;
        missingIndices: number[];
      } | null = null;

      // Try OCR with retries
    for (let attempt = 1; attempt <= MAX_OCR_RETRIES; attempt++) {
        console.log(`OCR attempt ${attempt}/${MAX_OCR_RETRIES}...`);

        const result = await runSingleOcr();
        
        if (!result) {
          console.warn('OCR attempt failed');
          continue;
        }

        console.log(`Attempt ${attempt}: Found ${result.mnemonicWords.length} words, confidence: ${result.confidence.toFixed(0)}%`);

        // Keep track of best result: prefer complete index sequence, then BIP39 validity, then word count.
        const resultScore = (result.hasCompleteSequence ? 1000 : 0)
          + (result.bip39Valid ? 500 : 0)
          + result.mnemonicWords.length;
        const bestScore = bestResult
          ? ((bestResult.hasCompleteSequence ? 1000 : 0)
            + (bestResult.bip39Valid ? 500 : 0)
            + bestResult.mnemonicWords.length)
          : -1;
        if (!bestResult || resultScore > bestScore) {
          bestResult = result;
        }

        // Check if result meets expectations
        if (result.hasCompleteSequence && result.bip39Valid) {
          console.log(`Success! Found complete mnemonic sequence with valid BIP39 checksum.`);
          bestResult = result;
          break;
        }

        // Wait before retry
        if (attempt < MAX_OCR_RETRIES) {
          console.log(`Retrying in ${OCR_RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, OCR_RETRY_DELAY));
        }
      }

      // Analyze the result to determine page type
      const rawText = bestResult?.rawText || '';

      if (bestResult) {
        setCapturedImageUrl(bestResult.imageDataUrl);
        setPreOcrImageUrl(bestResult.preOcrImageDataUrl);
      }
      
      // Check if this is a mnemonic display page (has numbered words like "1. bike")
      const hasNumberedWords = bestResult && bestResult.mnemonicWords.length >= 3;
      
      // Check if this is a verification page:
      // 1. Has stored mnemonic
      // 2. No numbered words (or very few)
      // 3. Has some word options
      const isVerificationPage = storedMnemonic && 
        storedMnemonic.words.length > 0 && 
        (!hasNumberedWords || (bestResult && bestResult.mnemonicWords.length < 3));
      
      // Try to extract word index from various patterns: "#1", "#4", "1", etc.
      let wordIndex = 1;
      const indexPatterns = [
        /#(\d+)/,           // #1, #4
        /[#＃]\s*(\d+)/,    // # 1, ＃4
        /\b([1-9]|1[0-2])\b(?!\s*\.)/,  // standalone 1-12 not followed by .
      ];
      
      for (const pattern of indexPatterns) {
        const match = rawText.match(pattern);
        if (match) {
          const idx = parseInt(match[1], 10);
          if (idx >= 1 && idx <= 12) {
            wordIndex = idx;
            break;
          }
        }
      }
      
      if (isVerificationPage) {
        // Verification page detected
        const expectedWord = storedMnemonic.words[wordIndex - 1];
        
        // Extract option words (words without numbers, 3-12 chars)
        const optionWords = rawText
          .split(/[\s\n]+/)
          .map(w => w.toLowerCase().replace(/[^a-z]/g, ''))
          .filter(w => w.length >= 3 && w.length <= 12)
          // Remove common noise words
          .filter(w => !['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'one', 'sen', 'aen', 'wrt', 'kis', 'linea', 'echsn', 'pre', 'twn', 'koz', 'linn', 'iabechon', 'onekey'].includes(w));
        
        // Find unique options (dedupe)
        const uniqueOptions = [...new Set(optionWords)];
        
        // Try to match with stored mnemonic words to filter noise
        const validOptions = uniqueOptions.filter(opt => 
          storedMnemonic.words.includes(opt) || 
          storedMnemonic.words.some(w => w.startsWith(opt) || opt.startsWith(w))
        );
        
        const displayOptions = validOptions.length > 0 ? validOptions : uniqueOptions;
        
        console.log('Verification page detected - Word #', wordIndex);
        console.log('Expected word:', expectedWord);
        console.log('Options found:', displayOptions);
        
        // Check if expected word is in options
        const correctOption = displayOptions.find(opt => opt === expectedWord);
        
        let resultText = `验证单词 #${wordIndex}\n`;
        resultText += `正确答案: ${expectedWord?.toUpperCase() || '未知'}\n\n`;
        resultText += `识别到的选项: ${displayOptions.join(', ')}\n`;
        
        if (correctOption) {
          resultText += `\n✓ 请选择: ${correctOption.toUpperCase()}`;
        } else if (expectedWord) {
          // Try fuzzy match
          const fuzzyMatch = displayOptions.find(opt => 
            expectedWord.includes(opt) || opt.includes(expectedWord)
          );
          if (fuzzyMatch) {
            resultText += `\n✓ 请选择: ${fuzzyMatch.toUpperCase()} (模糊匹配)`;
          } else {
            resultText += `\n⚠ 未在选项中找到 "${expectedWord}"`;
          }
        }
        
        setOcrResult({
          text: resultText,
          confidence: bestResult?.confidence || 0,
          timestamp: new Date(),
        });
      } else if (bestResult && bestResult.mnemonicWords.length > 0) {
        // Mnemonic display page - save the words and captured image
        if (bestResult.hasCompleteSequence && bestResult.bip39Valid) {
          const words = bestResult.mnemonicWords.map(item => item.word);
          saveStoredMnemonic(words);
          console.log('Saved mnemonic words:', words);
        }

        const hasFull = bestResult.hasCompleteSequence;
        const canStore = hasFull && bestResult.bip39Valid;
        const hasCorrections = bestResult.mnemonicWords.some(item => item.original);
        const statusText = canStore
          ? `✓ 已保存 ${bestResult.mnemonicWords.length} 个助记词:`
          : `识别到 ${bestResult.mnemonicWords.length} 个助记词 (预期 ${EXPECTED_MNEMONIC_COUNT} 个):`;

        const wordLines = bestResult.mnemonicWords.map((item) => {
          const confTag = `[${item.wordConfidence.toFixed(0)}%]`;
          if (item.original) {
            return `${item.index}. ${item.original} -> ${item.word} (corrected) ${confTag}`;
          }
          return `${item.index}. ${item.word} ${confTag}`;
        }).join('\n');

        const missingLine = hasFull
          ? ''
          : `\n缺失编号: ${bestResult.missingIndices.join(', ') || '未知'}`;
        const validationLine = hasFull
          ? `\nBIP39 checksum: ${bestResult.bip39Valid ? 'valid' : 'INVALID'}${hasCorrections ? ' (有自动修正)' : ''}`
          : '';
        
        setOcrResult({
          text: `${statusText}\n${wordLines}${missingLine}${validationLine}`,
          confidence: bestResult.confidence,
          timestamp: new Date(),
        });
      } else {
        // Fallback - unknown page type
        const words = rawText
          .split(/[\s\n]+/)
          .map(w => w.toLowerCase().replace(/[^a-z]/g, ''))
          .filter(w => w.length >= 3 && w.length <= 12);
        
        setOcrResult({
          text: words.length > 0 
            ? `识别到 ${words.length} 个单词:\n${words.join(', ')}`
            : '(No text detected)',
          confidence: bestResult?.confidence || 0,
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error('OCR failed:', err);
      setOcrResult({
        text: `OCR Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        confidence: 0,
        timestamp: new Date(),
      });
    } finally {
      setIsOcrProcessing(false);
    }
  }, [runOcrOnRegion, runSingleOcr, saveStoredMnemonic, storedMnemonic]);

  // Get list of video devices
  const getVideoDevices = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = allDevices
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      setDevices(videoDevices);
      return videoDevices;
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
      return [];
    }
  }, []);

  /**
   * Applies manual focus mode to disable autofocus and prevent camera shake.
   * Falls back gracefully if the camera doesn't support manual focus.
   */
  const applyManualFocus = async (videoTrack: MediaStreamTrack) => {
    try {
      const capabilities = videoTrack.getCapabilities() as MediaTrackCapabilities & {
        focusMode?: string[];
        focusDistance?: { min: number; max: number };
      };

      if (capabilities.focusMode?.includes('manual')) {
        await videoTrack.applyConstraints({
          // @ts-expect-error focusMode is not in standard TypeScript types
          focusMode: 'manual',
        });
        console.log('Manual focus mode enabled');
      } else if (capabilities.focusMode?.includes('continuous')) {
        await videoTrack.applyConstraints({
          // @ts-expect-error focusMode is not in standard TypeScript types
          focusMode: 'continuous',
        });
        console.log('Continuous focus mode enabled (manual not supported)');
      } else {
        console.log('Focus mode control not supported by this camera');
      }
    } catch (err) {
      console.warn('Failed to set focus mode:', err);
    }
  };

  /**
   * Starts the camera with optional device ID.
   * Configures manual focus to prevent autofocus hunting during movement.
   */
  const startCamera = useCallback(async (deviceId?: string) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        audio: false,
      };

      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = mediaStream;

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }

      const videoTrack = mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        if (settings.deviceId) {
          setSelectedDeviceId(settings.deviceId);
        }

        await applyManualFocus(videoTrack);
      }

      setError(null);
    } catch (err) {
      console.error('Failed to access camera:', err);
      setError('Failed to access camera. Please ensure camera permissions are granted.');
    }
  }, []);

  // Initialize camera on mount and set up IPC listener for frame capture
  useEffect(() => {
    const initCamera = async () => {
      // First, get camera permission with any camera
      await startCamera();

      // Get device list (labels available after permission)
      const videoDevices = await getVideoDevices();

      // Find DECXIN camera
      const decxinDevice = videoDevices.find((device) =>
        device.label.toUpperCase().includes('DECXIN')
      );

      // If DECXIN found, switch to it
      if (decxinDevice) {
        await startCamera(decxinDevice.deviceId);
      }
    };

    initCamera();

    // Set up IPC listener for frame capture requests from MCP Server
    const unsubscribe = window.electronAPI?.onCaptureFrameRequest?.(() => {
      const frame = captureFrame();
      window.electronAPI?.sendCaptureFrameResponse?.(frame);
    });

    // Set up IPC listener for OCR-input image capture (crop + scale only).
    const unsubPreOcr = window.electronAPI?.onCapturePreOcrRequest?.(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ocrCanvas = ocrCanvasRef.current;
      if (!video || !canvas || !ocrCanvas || video.readyState < 2) {
        window.electronAPI?.sendCapturePreOcrResponse?.(null);
        return;
      }
      const built = buildPreOcrCanvasFromVideo(video, canvas, ocrCanvas, MNEMONIC_SCENE);
      if (!built) {
        window.electronAPI?.sendCapturePreOcrResponse?.(null);
        return;
      }
      const dataUrl = OCR_BACKEND === 'paddleocr_en'
        ? buildPaddleInputDataUrl(ocrCanvas, MNEMONIC_SCENE.useNearestNeighbor)
        : ocrCanvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY);
      window.electronAPI?.sendCapturePreOcrResponse?.(dataUrl);
    });

    const unsubMcpOcr = window.electronAPI?.onMcpOcrRequest?.((payload) => {
      let settled = false;
      const handler = (e: Event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        window.removeEventListener('qa-auto-hw:ocr-result', handler);
        const detail = (e as CustomEvent).detail as {
          success?: boolean;
          words?: string[];
          confidence?: number;
          expectedWordCount?: number;
          hasCompleteSequence?: boolean;
          bip39Valid?: boolean;
          reason?: string;
        };
        window.electronAPI?.sendMcpOcrResponse?.({
          success: !!detail?.success,
          words: Array.isArray(detail?.words) ? detail.words : [],
          confidence: typeof detail?.confidence === 'number' ? detail.confidence : 0,
          expectedWordCount:
            typeof detail?.expectedWordCount === 'number' ? detail.expectedWordCount : undefined,
          hasCompleteSequence:
            typeof detail?.hasCompleteSequence === 'boolean'
              ? detail.hasCompleteSequence
              : undefined,
          bip39Valid:
            typeof detail?.bip39Valid === 'boolean' ? detail.bip39Valid : undefined,
          reason: detail?.reason,
        });
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener('qa-auto-hw:ocr-result', handler);
        window.electronAPI?.sendMcpOcrResponse?.({
          success: false,
          words: [],
          confidence: 0,
          reason: 'OCR request timed out',
        });
      }, 45000);

      window.addEventListener('qa-auto-hw:ocr-result', handler);
      window.dispatchEvent(new CustomEvent('qa-auto-hw:trigger-ocr', { detail: payload || undefined }));
    });

    const unsubMcpVerify = window.electronAPI?.onMcpVerifyOcrRequest?.(() => {
      let settled = false;
      const handler = (e: Event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        window.removeEventListener('qa-auto-hw:verify-ocr-result', handler);
        const detail = (e as CustomEvent).detail as {
          success?: boolean;
          optionIndex?: number;
          wordIndex?: number;
          correctWord?: string;
          rawOptions?: string[];
          matchedOptions?: string[];
          mnemonicWords?: string[];
          reason?: string;
        };
        window.electronAPI?.sendMcpVerifyOcrResponse?.({
          success: !!detail?.success,
          optionIndex: typeof detail?.optionIndex === 'number' ? detail.optionIndex : -1,
          wordIndex: typeof detail?.wordIndex === 'number' ? detail.wordIndex : -1,
          correctWord: typeof detail?.correctWord === 'string' ? detail.correctWord : '',
          rawOptions: Array.isArray(detail?.rawOptions) ? detail.rawOptions : [],
          matchedOptions: Array.isArray(detail?.matchedOptions) ? detail.matchedOptions : [],
          mnemonicWords: Array.isArray(detail?.mnemonicWords) ? detail.mnemonicWords : [],
          reason: detail?.reason,
        });
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener('qa-auto-hw:verify-ocr-result', handler);
        window.electronAPI?.sendMcpVerifyOcrResponse?.({
          success: false,
          optionIndex: -1,
          wordIndex: -1,
          correctWord: '',
          rawOptions: [],
          matchedOptions: [],
          mnemonicWords: [],
          reason: 'Verify OCR request timed out',
        });
      }, 45000);

      window.addEventListener('qa-auto-hw:verify-ocr-result', handler);
      window.dispatchEvent(new CustomEvent('qa-auto-hw:trigger-verify-ocr'));
    });

    // Cleanup on unmount
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (ocrWorkerRef.current) {
        ocrWorkerRef.current.terminate();
        ocrWorkerRef.current = null;
      }
      unsubscribe?.();
      unsubPreOcr?.();
      unsubMcpOcr?.();
      unsubMcpVerify?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureFrame]);

  // Listen for external OCR trigger events (from ControlPanel sequence executor)
  useEffect(() => {
    const handleTriggerOcr = async (event: Event) => {
      const triggerOptions = ((event as CustomEvent<OcrTriggerOptions | undefined>).detail ?? {}) as OcrTriggerOptions;
      const expectedWordCount = Math.max(
        12,
        Math.min(24, Math.floor(triggerOptions.expectedWordCount ?? EXPECTED_MNEMONIC_COUNT))
      );
      const mergeWithStored = !!triggerOptions.mergeWithStored;
      const allowPartial = !!triggerOptions.allowPartial;
      const requireBip39 = triggerOptions.requireBip39 ?? true;

      console.log(
        `[CameraPanel] External OCR trigger received (expected=${expectedWordCount}, merge=${mergeWithStored}, allowPartial=${allowPartial}, requireBip39=${requireBip39})`
      );
      setIsOcrProcessing(true);
      setFullFrameImageUrl(null);
      setCapturedImageUrl(null);
      setPreOcrImageUrl(null);
      setNumberImageUrl(null);
      setNumberPreOcrImageUrl(null);

      // Start-of-capture cleanup:
      // - 12/18 non-merge capture should drop stale words from previous runs.
      // - 24 first-pass (merge+partial) should also start from clean state.
      if (!mergeWithStored || allowPartial) {
        clearStoredMnemonic();
      }

      let bestWords: MnemonicWord[] = [];
      let bestConfidence = 0;
      let bestImageDataUrl = '';
      let bestPreOcrImageDataUrl = '';
      let bestBip39Valid = false;
      let bestHasCompleteSequence = false;
      let bestMissingIndices: number[] = [];
      let preOcrSaved = false;

      try {
        if (RAW_MNEMONIC_OCR_DEBUG_ONLY) {
          const rawResult = await runOcrOnRegion(MNEMONIC_SCENE, {
            ocrParams: MNEMONIC_OCR_PARAMS,
          });
          if (!rawResult) {
            throw new Error('Raw OCR capture failed');
          }

          setCapturedImageUrl(rawResult.imageDataUrl);
          setPreOcrImageUrl(rawResult.preOcrImageDataUrl);
          setOcrResult({
            text: formatRawOcrDebugText(rawResult.rawText, rawResult.words),
            confidence: rawResult.confidence,
            timestamp: new Date(),
          });

          window.dispatchEvent(
            new CustomEvent('qa-auto-hw:ocr-result', {
              detail: {
                success: false,
                words: [],
                confidence: rawResult.confidence,
                reason: 'Raw mnemonic OCR debug mode enabled',
              },
            })
          );
          return;
        }

        for (let attempt = 1; attempt <= MAX_OCR_RETRIES; attempt++) {
          console.log(`[CameraPanel] OCR attempt ${attempt}/${MAX_OCR_RETRIES}...`);
          const result = await runSingleOcr({
            onImageForOcr: (dataUrl) => {
              if (!preOcrSaved && window.electronAPI?.saveCaptureToDownloads) {
                preOcrSaved = true;
                window.electronAPI.saveCaptureToDownloads(dataUrl, 'ocr-trigger').catch((err) =>
                  console.warn('[CameraPanel] Failed to save capture to Downloads:', err)
                );
              }
            },
            expectedWordCount,
            applyBip39Wordlist: requireBip39,
          });
          if (!result) continue;

          const resultScore = (result.hasCompleteSequence ? 1000 : 0)
            + (result.bip39Valid ? 500 : 0)
            + result.mnemonicWords.length;
          const bestScore = (bestHasCompleteSequence ? 1000 : 0)
            + (bestBip39Valid ? 500 : 0)
            + bestWords.length;

          if (resultScore > bestScore) {
            bestWords = result.mnemonicWords;
            bestConfidence = result.confidence;
            bestImageDataUrl = result.imageDataUrl;
            bestPreOcrImageDataUrl = result.preOcrImageDataUrl;
            bestBip39Valid = result.bip39Valid;
            bestHasCompleteSequence = result.hasCompleteSequence;
            bestMissingIndices = result.missingIndices;
          }

          const captureReady = result.hasCompleteSequence && (!requireBip39 || result.bip39Valid);
          if (captureReady) {
            console.log('[CameraPanel] Found capture-ready mnemonic OCR result.');
            break;
          }

          if (attempt < MAX_OCR_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, OCR_RETRY_DELAY));
          }
        }

        const indexedToMap = (items: MnemonicWord[]): Map<number, string> => {
          const map = new Map<number, string>();
          items.forEach((item) => {
            if (item.index >= 1 && item.index <= expectedWordCount) {
              map.set(item.index, item.word);
            }
          });
          return map;
        };

        const buildSparseWords = (wordMap: Map<number, string>): string[] =>
          Array.from({ length: expectedWordCount }, (_, idx) => wordMap.get(idx + 1) ?? '');

        const collectMissingIndices = (wordMap: Map<number, string>): number[] => {
          const missing: number[] = [];
          for (let i = 1; i <= expectedWordCount; i++) {
            if (!wordMap.has(i)) {
              missing.push(i);
            }
          }
          return missing;
        };

        let effectiveMissingIndices = [...bestMissingIndices];
        let finalWordMap = indexedToMap(bestWords);
        if (mergeWithStored && bestWords.length > 0) {
          const mergedByIndex = new Map<number, string>();
          const useStoredMergeBase = !allowPartial;
          if (useStoredMergeBase && storedMnemonic?.words?.length) {
            storedMnemonic.words.forEach((word, idx) => {
              if (word) mergedByIndex.set(idx + 1, word);
            });
          }
          for (const item of bestWords) {
            mergedByIndex.set(item.index, item.word);
          }
          finalWordMap = mergedByIndex;
          effectiveMissingIndices = collectMissingIndices(finalWordMap);
        } else if (mergeWithStored && bestWords.length === 0 && storedMnemonic?.words?.length) {
          const storedMap = indexedToMap(
            storedMnemonic.words.map((word, idx) => ({
              index: idx + 1,
              word,
              wordConfidence: 0,
            }))
          );
          finalWordMap = storedMap;
          effectiveMissingIndices = collectMissingIndices(finalWordMap);
        }

        const words = buildSparseWords(finalWordMap);
        const recognizedCount = finalWordMap.size;
        const finalConfidenceByIndex = new Map<number, number>();
        if (mergeWithStored && Array.isArray(storedMnemonic?.confidences)) {
          storedMnemonic.confidences.forEach((value, idx) => {
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
              finalConfidenceByIndex.set(idx + 1, value);
            }
          });
        }
        bestWords.forEach((item) => {
          if (Number.isFinite(item.wordConfidence) && item.wordConfidence > 0) {
            finalConfidenceByIndex.set(item.index, item.wordConfidence);
          }
        });
        const hasFull = mergeWithStored
          ? effectiveMissingIndices.length === 0
          : bestHasCompleteSequence;
        let finalBip39Valid = bestBip39Valid;
        if (mergeWithStored && hasFull && requireBip39) {
          try {
            finalBip39Valid = validateMnemonic(words.join(' '), bip39English);
          } catch {
            finalBip39Valid = false;
          }
        }

        // Update local CameraPanel display
        if (recognizedCount > 0) {
          // Display the captured image
          setCapturedImageUrl(bestImageDataUrl);
          setPreOcrImageUrl(bestPreOcrImageDataUrl);

          const hasCorrections = bestWords.some(w => w.original);
          const bestWordsByIndex = new Map<number, MnemonicWord>();
          bestWords.forEach((item) => bestWordsByIndex.set(item.index, item));

          const wordLines = Array.from(finalWordMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([index, word]) => {
              const currentCapture = bestWordsByIndex.get(index);
              const confidence = finalConfidenceByIndex.get(index);
              const confTag = typeof confidence === 'number' ? `[${confidence.toFixed(0)}%]` : '';
              if (currentCapture) {
                if (currentCapture.original) {
                  return `${index}. ${currentCapture.original} -> ${word} (corrected) ${confTag}`;
                }
                return `${index}. ${word} ${confTag}`;
              }
              return confTag ? `${index}. ${word} ${confTag}` : `${index}. ${word}`;
            })
            .join('\n');

          const missingLine = hasFull
            ? ''
            : `\n缺失编号: ${effectiveMissingIndices.join(', ') || '未知'}`;
          const validationLine = hasFull && requireBip39
            ? `\nBIP39 checksum: ${finalBip39Valid ? 'valid' : 'INVALID'}${hasCorrections ? ' (有自动修正)' : ''}`
            : '';

          setOcrResult({
            text: `✓ 自动识别到 ${recognizedCount} 个助记词:\n${wordLines}${missingLine}${validationLine}`,
            confidence: bestConfidence,
            timestamp: new Date(),
          });

          if (mergeWithStored && finalWordMap.size > 0) {
            const sparseConfidences = Array.from(
              { length: expectedWordCount },
              (_, idx) => finalConfidenceByIndex.get(idx + 1) ?? 0
            );
            saveStoredMnemonic(words, sparseConfidences);
            if (allowPartial) {
              const partialIndices = Array.from(finalWordMap.keys()).sort((a, b) => a - b);
              console.log(`[CameraPanel] Stored partial mnemonic indices: ${partialIndices.join(', ')}`);
            }
          } else if (hasFull && (!requireBip39 || finalBip39Valid)) {
            const sparseConfidences = Array.from(
              { length: expectedWordCount },
              (_, idx) => finalConfidenceByIndex.get(idx + 1) ?? 0
            );
            saveStoredMnemonic(words, sparseConfidences);
          }
        }

        const triggerSuccess = allowPartial
          ? recognizedCount > 0
          : (hasFull && (!requireBip39 || finalBip39Valid));
        let triggerReason: string | undefined;
        if (!triggerSuccess) {
          if (recognizedCount === 0) {
            triggerReason = 'No mnemonic words recognized';
          } else if (!hasFull) {
            triggerReason =
              `Incomplete mnemonic words: ${recognizedCount}/${expectedWordCount}` +
              (effectiveMissingIndices.length > 0
                ? ` (missing indices: ${effectiveMissingIndices.join(', ')})`
                : '');
          } else if (requireBip39 && !finalBip39Valid) {
            triggerReason = 'Mnemonic checksum invalid';
          } else {
            triggerReason = 'Mnemonic OCR did not meet capture requirements';
          }
        }

        // Dispatch result back to sequence executor
        window.dispatchEvent(
          new CustomEvent('qa-auto-hw:ocr-result', {
            detail: {
              success: triggerSuccess,
              words,
              confidence: bestConfidence,
              expectedWordCount,
              hasCompleteSequence: hasFull,
              bip39Valid: finalBip39Valid,
              reason: triggerReason,
            },
          })
        );
      } catch (err) {
        console.error('[CameraPanel] Triggered OCR failed:', err);
        window.dispatchEvent(
          new CustomEvent('qa-auto-hw:ocr-result', {
            detail: {
              success: false,
              words: [],
              confidence: 0,
              reason: err instanceof Error ? err.message : 'Unknown OCR error',
            },
          })
        );
      } finally {
        setIsOcrProcessing(false);
      }
    };

    window.addEventListener('qa-auto-hw:trigger-ocr', handleTriggerOcr);
    return () => window.removeEventListener('qa-auto-hw:trigger-ocr', handleTriggerOcr);
  }, [clearStoredMnemonic, runOcrOnRegion, runSingleOcr, saveStoredMnemonic, storedMnemonic]);

  // Listen for verification OCR trigger events (from ControlPanel verification steps)
  useEffect(() => {
    const handleTriggerVerifyOcr = async () => {
      console.log('[CameraPanel] Verification OCR trigger received');
      setIsOcrProcessing(true);
      setFullFrameImageUrl(null);
      setCapturedImageUrl(null);
      setPreOcrImageUrl(null);
      setNumberImageUrl(null);
      setNumberPreOcrImageUrl(null);

      try {
        const video = videoRef.current;
        if (!video || video.readyState < 2) {
          throw new Error('Video not ready for verification OCR');
        }

        type VerifyAttempt = {
          wordIndex: number;
          numberImageDataUrl: string;
          numberPreOcrDataUrl: string;
          numberRawText: string;
          numberConfidence: number;
          optionsText: string;
          optionsRawWords: string[];
          optionsConfidence: number;
          optionsImageDataUrl: string;
          optionsPreOcrDataUrl: string;
          fullFrameImageDataUrl: string;
        };

        let verifyNumberSaved = false;
        let verifyOptionsSaved = false;
        let selectedAttempt: VerifyAttempt | null = null;
        let selectedAttemptScore = Number.NEGATIVE_INFINITY;
        const verifyMaxIndex = Math.max(
          12,
          Math.min(24, Math.floor(storedMnemonic?.words?.length ?? 12))
        );
        const hasStoredMnemonicWords = !!storedMnemonic && storedMnemonic.words.length > 0;
        const resolveTensAmbiguousFallback = (index: number): number => {
          if (index < 10 || index % 10 !== 0) return -1;
          const reduced = Math.floor(index / 10);
          if (reduced < 1 || reduced > verifyMaxIndex) return -1;
          return reduced;
        };

        for (let attempt = 1; attempt <= MAX_OCR_RETRIES; attempt++) {
          console.log(`[CameraPanel] Verify OCR attempt ${attempt}/${MAX_OCR_RETRIES}...`);
          const frameCanvas = captureRotatedFrameCanvas(video);
          const fullFrameImageDataUrl = frameCanvas.toDataURL('image/jpeg', OCR_JPEG_QUALITY);

          let wordIndex = -1;
          let numberImageDataUrl = '';
          let numberPreOcrDataUrl = '';
          let numberRawText = '';
          let numberConfidence = 0;

          const numberResult = await runNumberOcr({
            frameCanvas,
            maxIndex: verifyMaxIndex,
            onImageForOcr: (dataUrl) => {
              if (!verifyNumberSaved && window.electronAPI?.saveCaptureToDownloads) {
                verifyNumberSaved = true;
                window.electronAPI.saveCaptureToDownloads(dataUrl, 'verify-number').catch((err) =>
                  console.warn('[CameraPanel] Failed to save verify-number capture:', err)
                );
              }
            },
          });

          if (numberResult) {
            wordIndex = numberResult.number;
            numberImageDataUrl = numberResult.imageDataUrl;
            numberPreOcrDataUrl = numberResult.preOcrImageDataUrl;
            numberRawText = numberResult.rawText.trim();
            numberConfidence = numberResult.confidence;
          }

          const targetWord = storedMnemonic && wordIndex >= 1
            ? storedMnemonic.words[wordIndex - 1]
            : undefined;
          const fallbackIndex = hasStoredMnemonicWords ? resolveTensAmbiguousFallback(wordIndex) : -1;
          const fallbackWord = fallbackIndex >= 1 && storedMnemonic
            ? storedMnemonic.words[fallbackIndex - 1]
            : undefined;
          const optionsResult = await runVerifyOptionsOcr({
            frameCanvas,
            targetWord,
            onImageForOcr: (dataUrl) => {
              if (!verifyOptionsSaved && window.electronAPI?.saveCaptureToDownloads) {
                verifyOptionsSaved = true;
                window.electronAPI.saveCaptureToDownloads(dataUrl, 'verify-options').catch((err) =>
                  console.warn('[CameraPanel] Failed to save verify-options capture:', err)
                );
              }
            },
          });

          if (!optionsResult) {
            if (attempt < MAX_OCR_RETRIES) {
              await new Promise((resolve) => setTimeout(resolve, OCR_RETRY_DELAY));
            }
            continue;
          }

          const candidate: VerifyAttempt = {
            wordIndex,
            numberImageDataUrl,
            numberPreOcrDataUrl,
            numberRawText,
            numberConfidence,
            optionsText: optionsResult.rawText,
            optionsRawWords: optionsResult.rawOptions,
            optionsConfidence: optionsResult.confidence,
            optionsImageDataUrl: optionsResult.imageDataUrl,
            optionsPreOcrDataUrl: optionsResult.preOcrImageDataUrl,
            fullFrameImageDataUrl,
          };
          const rawOptions = candidate.optionsRawWords;
          const mappedOptions = hasStoredMnemonicWords
            ? rawOptions.map((option) =>
              mapOptionToMnemonicStrict(option, storedMnemonic.words) ?? option
            )
            : rawOptions;
          const optionIndex = targetWord ? mappedOptions.indexOf(targetWord) : -1;
          const fallbackOptionIndex = fallbackWord ? mappedOptions.indexOf(fallbackWord) : -1;
          const matchedByFallback = optionIndex < 0 && fallbackOptionIndex >= 0;
          const hasBaseReady = candidate.wordIndex >= 1
            && candidate.wordIndex <= verifyMaxIndex
            && rawOptions.length >= 3;
          const hasMatchedOption = !hasStoredMnemonicWords
            || (!!targetWord && optionIndex >= 0)
            || matchedByFallback;
          const attemptScore = (optionIndex >= 0 ? 1200 : 0)
            + (matchedByFallback ? 950 : 0)
            + (hasBaseReady ? 100 : 0)
            + rawOptions.length * 10
            + (candidate.optionsConfidence / 10);
          if (!selectedAttempt || attemptScore >= selectedAttemptScore) {
            selectedAttempt = candidate;
            selectedAttemptScore = attemptScore;
          }

          console.log(
            `[CameraPanel] Verify attempt #${attempt}: index=${candidate.wordIndex}, options=${rawOptions.join(', ') || '(empty)'}, optionsConf=${candidate.optionsConfidence.toFixed(0)}%, target=${targetWord || '(none)'}, optionIndex=${optionIndex}, fallbackIndex=${fallbackIndex}, fallbackWord=${fallbackWord || '(none)'}, fallbackOptionIndex=${fallbackOptionIndex}`
          );

          // For loaded mnemonic flows (including SLIP39), do not stop early unless
          // one option matches the target word. This avoids false positives from
          // transient OCR frames where 3 words are read but not the current question options.
          if (hasBaseReady && hasMatchedOption) {
            break;
          }

          if (attempt < MAX_OCR_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, OCR_RETRY_DELAY));
          }
        }

        if (!selectedAttempt) {
          throw new Error('Failed to OCR verification regions');
        }

        let wordIndex = selectedAttempt.wordIndex;
        const numberRawText = selectedAttempt.numberRawText;
        const numberConfidence = selectedAttempt.numberConfidence;
        const optionsConfidence = selectedAttempt.optionsConfidence;
        const rawOptions = selectedAttempt.optionsRawWords;

        setFullFrameImageUrl(selectedAttempt.fullFrameImageDataUrl);
        setNumberImageUrl(selectedAttempt.numberImageDataUrl || null);
        setNumberPreOcrImageUrl(selectedAttempt.numberPreOcrDataUrl || null);
        setCapturedImageUrl(selectedAttempt.optionsImageDataUrl || null);
        setPreOcrImageUrl(selectedAttempt.optionsPreOcrDataUrl || null);

        const hasStoredMnemonic = !!storedMnemonic && storedMnemonic.words.length > 0;

        // Look up the correct word from stored mnemonic
        let correctWord = hasStoredMnemonic && wordIndex >= 1
          ? storedMnemonic.words[wordIndex - 1]
          : null;

        // Option mapping keeps slot order and avoids permissive fuzzy fallback.
        const mappedOptions = hasStoredMnemonic
          ? rawOptions.map((option) =>
            mapOptionToMnemonicStrict(option, storedMnemonic.words) ?? option
          )
          : rawOptions;

        // Find which option index matches the correct word
        let optionIndex = -1;
        if (correctWord && mappedOptions.length > 0) {
          optionIndex = mappedOptions.indexOf(correctWord);
        }
        let indexAdjustHint = '';
        if (hasStoredMnemonic && optionIndex < 0) {
          // Fallback A: "tens ambiguity" — OCR read e.g. "10" as "1", try dividing by 10.
          const fallbackIndex = wordIndex >= 10 && wordIndex % 10 === 0
            ? Math.floor(wordIndex / 10)
            : -1;
          if (fallbackIndex >= 1 && fallbackIndex <= storedMnemonic.words.length) {
            const fallbackWord = storedMnemonic.words[fallbackIndex - 1];
            const fallbackOptionIndex = mappedOptions.indexOf(fallbackWord);
            if (fallbackOptionIndex >= 0) {
              indexAdjustHint = `数字OCR疑似将 #${fallbackIndex} 识别为 #${wordIndex}，已按候选词修正。`;
              wordIndex = fallbackIndex;
              correctWord = fallbackWord;
              optionIndex = fallbackOptionIndex;
            }
          }
        }
        if (hasStoredMnemonic && optionIndex < 0 && mappedOptions.length > 0) {
          // Fallback B: wordIndex unknown (OCR failed to read digit) — scan each option against
          // the stored mnemonic. The verify screen always shows exactly one correct word;
          // the other two options are plausible but different words.
          for (let i = 0; i < mappedOptions.length; i++) {
            const mnemonicIdx = storedMnemonic.words.indexOf(mappedOptions[i]);
            if (mnemonicIdx >= 0) {
              indexAdjustHint = `数字OCR失败，通过选项匹配推断: #${mnemonicIdx + 1} = ${mappedOptions[i]}`;
              wordIndex = mnemonicIdx + 1;
              correctWord = mappedOptions[i];
              optionIndex = i;
              break;
            }
          }
        }

        console.log(
          `[CameraPanel] Verify: word #${wordIndex}, hasStored=${hasStoredMnemonic}, correct="${correctWord}", raw=[${rawOptions.join(', ')}], mapped=[${mappedOptions.join(', ')}], optionIndex=${optionIndex}`
        );

        // Update display
        let resultText = `验证单词 #${wordIndex}`;
        resultText += ` (数字OCR: "${numberRawText}", 置信度: ${numberConfidence.toFixed(0)}%)\n`;
        resultText += `助记词状态: ${hasStoredMnemonic ? `已加载 ${storedMnemonic.words.length} 个词` : '未加载'}\n`;
        resultText += `正确答案: ${correctWord?.toUpperCase() || '未知'}\n`;
        if (hasStoredMnemonic) {
          resultText += `目标助记词: #${wordIndex} = ${correctWord || '(未知)'}\n`;
          resultText += `助记词表: ${storedMnemonic.words.map((word, idx) => `${idx + 1}.${word}`).join(', ')}\n`;
        }
        resultText += `原始OCR选项: ${rawOptions.join(', ') || '(空)'}\n`;
        resultText += `映射选项: ${mappedOptions.join(', ') || '(空)'}\n`;
        if (indexAdjustHint) {
          resultText += `${indexAdjustHint}\n`;
        }
        if (optionIndex >= 0) {
          resultText += `\n-> 点击选项 ${optionIndex + 1}: ${mappedOptions[optionIndex].toUpperCase()}`;
        } else if (!hasStoredMnemonic) {
          resultText += '\n-> 未加载助记词，无法自动确定正确选项';
        } else if (wordIndex < 1) {
          resultText += '\n-> 未能识别要验证的单词序号';
        } else {
          resultText += '\n-> 未找到匹配选项';
        }

        const verifySuccess = hasStoredMnemonic && wordIndex >= 1 && optionIndex >= 0 && !!correctWord;
        const verifyReason = verifySuccess
          ? undefined
          : (
            !hasStoredMnemonic
              ? 'Mnemonic words not loaded'
              : wordIndex < 1
                ? `Failed to detect verification word index (number OCR="${numberRawText || '(empty)'}")`
                : wordIndex > storedMnemonic.words.length
                  ? `Verification word index out of range: ${wordIndex}/${storedMnemonic.words.length}`
                : rawOptions.length === 0
                  ? 'No option words recognized'
                  : `Correct word not found in detected options (wordIndex=${wordIndex}, targetWord="${correctWord || '(unknown)'}", rawOptions="${rawOptions.join(', ') || '(empty)'}", mappedOptions="${mappedOptions.join(', ') || '(empty)'}")`
          );

        setOcrResult({
          text: resultText,
          confidence: optionsConfidence,
          timestamp: new Date(),
        });

        // Dispatch result back to sequence executor
        window.dispatchEvent(
          new CustomEvent('qa-auto-hw:verify-ocr-result', {
            detail: {
              success: verifySuccess,
              optionIndex,
              wordIndex,
              correctWord: correctWord || '',
              rawOptions,
              matchedOptions: mappedOptions,
              mnemonicWords: hasStoredMnemonic ? [...storedMnemonic.words] : [],
              reason: verifyReason,
            },
          })
        );
      } catch (err) {
        console.error('[CameraPanel] Verification OCR failed:', err);
        window.dispatchEvent(
          new CustomEvent('qa-auto-hw:verify-ocr-result', {
            detail: {
              success: false,
              optionIndex: -1,
              wordIndex: -1,
              correctWord: '',
              rawOptions: [],
              matchedOptions: [],
              mnemonicWords: storedMnemonic?.words ? [...storedMnemonic.words] : [],
              reason: err instanceof Error ? err.message : 'Unknown verification OCR error',
            },
          })
        );
      } finally {
        setIsOcrProcessing(false);
      }
    };

    window.addEventListener('qa-auto-hw:trigger-verify-ocr', handleTriggerVerifyOcr);
    return () => window.removeEventListener('qa-auto-hw:trigger-verify-ocr', handleTriggerVerifyOcr);
  }, [runNumberOcr, runVerifyOptionsOcr, storedMnemonic]);

  // Handle device selection change
  const handleDeviceChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const deviceId = event.target.value;
    startCamera(deviceId);
  };

  // Manually trigger verification-page OCR debug flow (single-frame dual ROI).
  const handleVerifyDebugOcr = () => {
    window.dispatchEvent(new CustomEvent('qa-auto-hw:trigger-verify-ocr'));
  };

  return (
    <div className="camera-panel">
      {/* Hidden canvases for frame capture and OCR input */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <canvas ref={ocrCanvasRef} style={{ display: 'none' }} />

      {devices.length > 1 && (
        <div className="camera-controls">
          <select
            value={selectedDeviceId}
            onChange={handleDeviceChange}
            className="device-select"
          >
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="camera-container">
        <div className="camera-viewport">
          {error ? (
            <div className="camera-error">
              <span className="error-icon">📷</span>
              <p>{error}</p>
            </div>
          ) : (
            <video
              ref={videoRef}
              className="camera-video"
              autoPlay
              playsInline
              muted
            />
          )}
          {showCrosshair && <div className="overlay-crosshair" />}
          {showGrid && <div className="overlay-grid" />}
        </div>
      </div>

      <div className="overlay-controls">
        <button
          className={`overlay-btn ${showCrosshair ? 'active' : ''}`}
          onClick={() => setShowCrosshair(!showCrosshair)}
        >
          十字线
        </button>
        <button
          className={`overlay-btn ${showGrid ? 'active' : ''}`}
          onClick={() => setShowGrid(!showGrid)}
        >
          网格
        </button>
        <button
          className={`overlay-btn ocr-btn ${isOcrProcessing ? 'processing' : ''}`}
          onClick={performOcr}
          disabled={isOcrProcessing}
        >
          {isOcrProcessing ? 'OCR...' : 'OCR 识别'}
        </button>
        <button
          className={`overlay-btn ocr-btn ${isOcrProcessing ? 'processing' : ''}`}
          onClick={handleVerifyDebugOcr}
          disabled={isOcrProcessing}
          title="用于助记词确认页：同一帧上方数字+下方选项双区域 OCR"
        >
          {isOcrProcessing ? 'OCR...' : '确认页 OCR'}
        </button>
        {storedMnemonic && (
          <span className="mnemonic-indicator" title={`已保存 ${storedMnemonic.words.length} 个助记词`}>
            ✓ {storedMnemonic.words.length}词
          </span>
        )}
      </div>

      {ocrResult && (
        <div className="ocr-result">
          <div className="ocr-result-header">
            <span className="ocr-result-title">OCR 结果</span>
            <span className="ocr-result-confidence">
              置信度: {ocrResult.confidence.toFixed(0)}%
            </span>
            <span className="ocr-result-time">
              {ocrResult.timestamp.toLocaleTimeString()}
            </span>
            <button
              className="ocr-result-close"
              onClick={() => {
                setOcrResult(null);
                setFullFrameImageUrl(null);
                setCapturedImageUrl(null);
                setPreOcrImageUrl(null);
                setNumberImageUrl(null);
                setNumberPreOcrImageUrl(null);
              }}
              title="关闭"
            >
              ×
            </button>
          </div>
          {fullFrameImageUrl && (
            <div className="ocr-result-image-wrapper">
              <div className="ocr-result-image-label">完整截图</div>
              <img
                src={fullFrameImageUrl}
                alt="完整截图"
                className="ocr-result-image"
              />
              <button
                className="ocr-result-save-btn"
                onClick={() => {
                  const link = document.createElement('a');
                  link.href = fullFrameImageUrl;
                  link.download = `ocr-full-frame-${Date.now()}.jpg`;
                  link.click();
                }}
                title="保存完整截图到本地"
              >
                保存完整截图
              </button>
            </div>
          )}
          {numberImageUrl && (
            <div className="ocr-result-image-wrapper">
              <div className="ocr-result-image-label">数字区域截图</div>
              <img
                src={numberImageUrl}
                alt="数字区域截图"
                className="ocr-result-image"
              />
              <button
                className="ocr-result-save-btn"
                onClick={() => {
                  const link = document.createElement('a');
                  link.href = numberImageUrl;
                  link.download = `ocr-number-${Date.now()}.jpg`;
                  link.click();
                }}
                title="保存数字截图到本地"
              >
                保存数字截图
              </button>
            </div>
          )}
          {numberPreOcrImageUrl && (
            <div className="ocr-result-image-wrapper">
              <div className="ocr-result-image-label">数字区域 OCR 输入图</div>
              <img
                src={numberPreOcrImageUrl}
                alt="数字区域 OCR 输入图"
                className="ocr-result-image"
              />
            </div>
          )}
          {capturedImageUrl && (
            <div className="ocr-result-image-wrapper">
              {numberImageUrl && <div className="ocr-result-image-label">选项区域截图</div>}
              <img
                src={capturedImageUrl}
                alt="OCR 识别截图"
                className="ocr-result-image"
              />
              <button
                className="ocr-result-save-btn"
                onClick={() => {
                  const link = document.createElement('a');
                  link.href = capturedImageUrl;
                  link.download = `ocr-capture-${Date.now()}.jpg`;
                  link.click();
                }}
                title="保存截图到本地"
              >
                保存截图
              </button>
            </div>
          )}
          {preOcrImageUrl && (
            <div className="ocr-result-image-wrapper">
              <div className="ocr-result-image-label">OCR 输入图（送入 OCR 前）</div>
              <img
                src={preOcrImageUrl}
                alt="OCR 输入图"
                className="ocr-result-image"
              />
              <button
                className="ocr-result-save-btn"
                onClick={() => {
                  const link = document.createElement('a');
                  link.href = preOcrImageUrl;
                  link.download = `ocr-input-${Date.now()}.jpg`;
                  link.click();
                }}
                title="保存OCR输入图到本地"
              >
                保存OCR输入图
              </button>
            </div>
          )}
          <div className="ocr-result-content">{ocrResult.text}</div>
        </div>
      )}
    </div>
  );
}

export default CameraPanel;
