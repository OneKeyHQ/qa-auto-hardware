/**
 * MCP Tool: mnemonic-verify
 * Verifies mnemonic words by finding the correct option from OCR results.
 * Used during seed phrase backup verification where user must select correct words.
 */

import { z } from 'zod';
import { getMnemonicWordByIndex, getStoredMnemonicWords, hasMnemonicWords } from '../state';

/** Input schema for mnemonic-verify tool */
export const mnemonicVerifySchema = z.object({
  /** The word index to verify (1-based, e.g., "Word #5" means index 5) */
  wordIndex: z.number().int().min(1).max(24).describe(
    '1-based index of the word to verify (e.g., 5 for "Word #5")'
  ),
  /** OCR results from the verification screen showing word options */
  ocrResults: z.array(z.object({
    text: z.string(),
    confidence: z.number(),
    box: z.array(z.array(z.number())),
  })).describe('OCR results containing the word options to choose from'),
});

export type MnemonicVerifyInput = z.infer<typeof mnemonicVerifySchema>;

/** Output type for mnemonic-verify tool */
export interface MnemonicVerifyOutput {
  success: boolean;
  message: string;
  /** The correct word that should be selected */
  correctWord?: string;
  /** The word index being verified */
  wordIndex?: number;
  /** The matching option found in OCR results */
  matchedOption?: {
    text: string;
    confidence: number;
    box: number[][];
    centerX: number;
    centerY: number;
  };
  /** All word options detected in OCR */
  detectedOptions?: string[];
}

/**
 * Calculate center point of a bounding box.
 */
function calculateCenter(box: number[][]): { x: number; y: number } {
  const xs = box.map((p) => p[0]);
  const ys = box.map((p) => p[1]);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/**
 * Normalize text for comparison (lowercase, trim, remove special chars).
 */
function normalizeWord(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z]/g, '');
}

/**
 * Check if text looks like a word option (not a number or UI element).
 */
function isWordOption(text: string): boolean {
  const normalized = normalizeWord(text);
  // Word should be 3-8 chars, all letters
  return normalized.length >= 3 && normalized.length <= 8 && /^[a-z]+$/.test(normalized);
}

/**
 * Executes the mnemonic-verify tool.
 * Finds the correct word option to click based on stored mnemonic and OCR results.
 */
export async function executeMnemonicVerify(
  input: MnemonicVerifyInput
): Promise<MnemonicVerifyOutput> {
  const { wordIndex, ocrResults } = input;

  // Check if mnemonic words are stored
  if (!hasMnemonicWords()) {
    return {
      success: false,
      message: 'No mnemonic words stored. Please run mnemonic OCR flow first (for example execute-sequence with OCR steps), or set words via mnemonic-store.',
    };
  }

  // Get the correct word for this index
  const correctWord = getMnemonicWordByIndex(wordIndex);
  if (!correctWord) {
    const storedWords = getStoredMnemonicWords();
    return {
      success: false,
      message: `Word index ${wordIndex} is out of range. Stored mnemonic has ${storedWords.length} words.`,
      wordIndex,
    };
  }

  // Find word options in OCR results
  const wordOptions: Array<{
    text: string;
    normalized: string;
    confidence: number;
    box: number[][];
    center: { x: number; y: number };
  }> = [];

  for (const result of ocrResults) {
    if (isWordOption(result.text)) {
      const center = calculateCenter(result.box);
      wordOptions.push({
        text: result.text,
        normalized: normalizeWord(result.text),
        confidence: result.confidence,
        box: result.box,
        center,
      });
    }
  }

  if (wordOptions.length === 0) {
    return {
      success: false,
      message: 'No word options found in OCR results. The screen may not show verification options.',
      wordIndex,
      correctWord,
      detectedOptions: [],
    };
  }

  // Find the matching option
  const normalizedCorrect = normalizeWord(correctWord);
  const matchedOption = wordOptions.find((opt) => opt.normalized === normalizedCorrect);

  if (!matchedOption) {
    return {
      success: false,
      message: `Correct word "${correctWord}" not found in detected options: ${wordOptions.map((o) => o.text).join(', ')}`,
      wordIndex,
      correctWord,
      detectedOptions: wordOptions.map((o) => o.text),
    };
  }

  return {
    success: true,
    message: `Found correct word "${correctWord}" at position (${Math.round(matchedOption.center.x)}, ${Math.round(matchedOption.center.y)})`,
    wordIndex,
    correctWord,
    matchedOption: {
      text: matchedOption.text,
      confidence: matchedOption.confidence,
      box: matchedOption.box,
      centerX: matchedOption.center.x,
      centerY: matchedOption.center.y,
    },
    detectedOptions: wordOptions.map((o) => o.text),
  };
}
