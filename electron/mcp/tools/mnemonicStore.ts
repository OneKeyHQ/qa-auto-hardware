/**
 * MCP Tool: mnemonic-store
 * Stores mnemonic words recognized from OCR for later verification.
 */

import { z } from 'zod';
import {
  storeMnemonicWords,
  getStoredMnemonicState,
  getMnemonicMetadata,
  clearMnemonicWords,
  hasMnemonicWords,
} from '../state';
import type { MnemonicStoreMetadata } from '../state';

/** Input schema for mnemonic-store tool */
export const mnemonicStoreSchema = z.object({
  /** Action to perform */
  action: z.enum(['store', 'get', 'clear', 'status']).describe(
    'Action: store (save words), get (retrieve words), clear (remove words), status (check if stored)'
  ),
  /** Mnemonic words to store (required for store action) */
  words: z.array(z.string()).optional().describe('Array of mnemonic words to store (for store action)'),
});

export type MnemonicStoreInput = z.infer<typeof mnemonicStoreSchema>;

/** Output type for mnemonic-store tool */
export interface MnemonicStoreOutput {
  success: boolean;
  message: string;
  words?: string[];
  wordCount?: number;
  metadata?: MnemonicStoreMetadata;
  shares?: string[][];
  shareCount?: number;
  threshold?: number;
  sequenceId?: string;
  walletType?: 'bip39' | 'slip39';
  flowType?: 'create' | 'import' | 'manual';
}

/**
 * Executes the mnemonic-store tool.
 * Manages storage of mnemonic words for verification workflows.
 */
export async function executeMnemonicStore(
  input: MnemonicStoreInput
): Promise<MnemonicStoreOutput> {
  const { action, words } = input;

  switch (action) {
    case 'store': {
      if (!words || words.length === 0) {
        return {
          success: false,
          message: 'No words provided for storage',
        };
      }

      // Validate words (basic BIP39-like validation)
      const validWords = words.filter(
        (w) => typeof w === 'string' && w.length >= 3 && /^[a-zA-Z]+$/.test(w)
      );

      if (validWords.length !== words.length) {
        return {
          success: false,
          message: `Some words are invalid. Expected ${words.length}, got ${validWords.length} valid words.`,
        };
      }

      // Store the words
      storeMnemonicWords(validWords.map((w) => w.toLowerCase()), 'manual');

      return {
        success: true,
        message: `Stored ${validWords.length} mnemonic words`,
        wordCount: validWords.length,
        words: validWords.map((w) => w.toLowerCase()),
      };
    }

    case 'get': {
      const storedState = getStoredMnemonicState();
      const storedWords = storedState.words;

      if (storedWords.length === 0) {
        return {
          success: false,
          message: 'No mnemonic words stored',
        };
      }

      return {
        success: true,
        message: `Retrieved ${storedWords.length} mnemonic words`,
        words: storedWords,
        wordCount: storedWords.length,
        metadata: storedState.metadata,
        shares: storedState.shares,
        shareCount: storedState.shareCount,
        threshold: storedState.threshold,
        sequenceId: storedState.sequenceId,
        walletType: storedState.walletType,
        flowType: storedState.flowType,
      };
    }

    case 'clear': {
      clearMnemonicWords();
      return {
        success: true,
        message: 'Mnemonic words cleared',
      };
    }

    case 'status': {
      const hasWords = hasMnemonicWords();
      const storedState = getStoredMnemonicState();
      const metadata = getMnemonicMetadata();

      return {
        success: true,
        message: hasWords
          ? `${metadata.wordCount} mnemonic words stored (from ${metadata.source})`
          : 'No mnemonic words stored',
        wordCount: metadata.wordCount || 0,
        metadata: hasWords ? metadata : undefined,
        shares: hasWords ? storedState.shares : undefined,
        shareCount: hasWords ? storedState.shareCount : undefined,
        threshold: hasWords ? storedState.threshold : undefined,
        sequenceId: hasWords ? storedState.sequenceId : undefined,
        walletType: hasWords ? storedState.walletType : undefined,
        flowType: hasWords ? storedState.flowType : undefined,
      };
    }

    default:
      return {
        success: false,
        message: `Unknown action: ${action}`,
      };
  }
}
