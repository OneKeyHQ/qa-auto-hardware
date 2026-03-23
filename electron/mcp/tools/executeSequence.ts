/**
 * MCP Tool: execute-sequence
 * Executes a predefined auto operation sequence.
 */

import { z } from 'zod';
import {
  getArmState,
  updateArmState,
  buildArmApiUrl,
  captureFrame,
  capturePreOcrFrame,
  runMnemonicOcr,
  runVerifyOcr,
  clearMnemonicWords,
  getStoredMnemonicWords,
  storeMnemonicWords,
  storeStructuredMnemonicState,
  delay,
  ARM_CONFIG,
  shouldStopSequenceExecution,
  setStopSequenceFlag,
} from '../state';
import { getSequence, getPageAction, getAllSequenceIds } from '../sequences';
import { saveCaptureToDownloads } from '../../saveCapture';
import { executeClickStep, executeSwipeStep } from '../utils/executeStep';

import type { AutoStep } from '../sequences';

/** Input schema for execute-sequence tool */
export const executeSequenceSchema = z.object({
  sequenceId: z
    .string()
    .describe(`The ID of the sequence to execute. Available: ${getAllSequenceIds().join(', ')}`),
  returnFrame: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to capture and return a frame after completion (default: true)'),
});

export type ExecuteSequenceInput = z.infer<typeof executeSequenceSchema>;

/** Output type for execute-sequence tool */
export interface ExecuteSequenceOutput {
  success: boolean;
  message: string;
  sequenceId?: string;
  sequenceName?: string;
  stepsCompleted?: number;
  totalSteps?: number;
}

const SLIP39_CREATE_SEQUENCE_CONFIG: Record<
  string,
  { shareCount: number; threshold: number }
> = {
  'create-slip39-single-template': { shareCount: 1, threshold: 1 },
  'create-slip39-multi-2of2-template': { shareCount: 2, threshold: 2 },
  'create-slip39-multi-8of8-template': { shareCount: 8, threshold: 8 },
  'create-slip39-multi-16of2-template': { shareCount: 16, threshold: 2 },
};

// The device firmware can still be finalizing wallet state right after
// import/create flows complete. Hold the response briefly so the next test
// does not start against a busy device.
const POST_WALLET_FLOW_COOLDOWN_MS = 5000;

function requiresPostSequenceCooldown(sequence: { category: string; actions: string[] }): boolean {
  return sequence.category === '创建钱包' || sequence.actions.includes('nav-import');
}

/**
 * Executes a single step (click, swipe, or OCR capture).
 */
async function executeStep(
  step: AutoStep,
  resourceHandle: number,
  httpRequest: (url: string) => Promise<string>
): Promise<void> {
  if ((step.delayBefore ?? 0) > 0) {
    await delay(step.delayBefore ?? 0);
  }

  // Shared send helper: wraps ARM URL building so shared utilities can call it
  const send = async (daima: string) => {
    await httpRequest(buildArmApiUrl({ duankou: '0', hco: resourceHandle, daima }));
  };
  const stepConfig = { clickDelay: ARM_CONFIG.clickDelay, zUp: ARM_CONFIG.zUp };

  if (step.ocrCapture) {
    const ocrCaptureConfig = typeof step.ocrCapture === 'object' ? step.ocrCapture : {};
    // OCR capture step: move arm out of the way without clicking
    await send(`X${step.x}Y${step.y}`);
    updateArmState({ currentX: step.x, currentY: step.y });

    // Wait for arm to settle, then run OCR capture in renderer.
    await delay(1000);

    const ocrResult = await runMnemonicOcr(ocrCaptureConfig);
    if (!ocrResult) {
      throw new Error('Renderer did not return mnemonic OCR result');
    }
    const allowPartial = !!ocrCaptureConfig.allowPartial;
    const canContinueWithPartial = allowPartial && ocrResult.words.length > 0;
    if ((!ocrResult.success && !canContinueWithPartial) || ocrResult.words.length === 0) {
      throw new Error(`Mnemonic OCR failed: ${ocrResult.reason || 'no words recognized'}`);
    }

    storeMnemonicWords(
      ocrResult.words,
      canContinueWithPartial ? 'sequence-ocr-partial' : 'sequence-ocr'
    );

    // Optional debug artifact: save the current OCR-input image.
    const preOcrFrame = await capturePreOcrFrame();
    if (preOcrFrame) {
      try {
        await saveCaptureToDownloads(preOcrFrame, `ocr-x${step.x}-y${step.y}`);
      } catch (err) {
        console.warn('[execute-sequence] Failed to save OCR debug capture:', err);
      }
    }
  } else if (step.ocrVerify) {
    // Verification step: move to observation position, run verify OCR, then click chosen option.
    await send(`X${step.x}Y${step.y}`);
    updateArmState({ currentX: step.x, currentY: step.y });

    await delay(1000);

    const verifyResult = await runVerifyOcr();
    if (!verifyResult) {
      throw new Error('Renderer did not return verify OCR result');
    }
    if (!verifyResult.success) {
      throw new Error(`Verify OCR failed: ${verifyResult.reason || 'unknown reason'}`);
    }
    if (
      verifyResult.optionIndex < 0
      || verifyResult.optionIndex >= step.ocrVerify.options.length
    ) {
      throw new Error(
        `Verify OCR returned invalid optionIndex=${verifyResult.optionIndex} for ${step.ocrVerify.options.length} options`
      );
    }

    const option = step.ocrVerify.options[verifyResult.optionIndex];
    // Click the correct option using shared click logic
    await send(`X${option.x}Y${option.y}`);
    await send(`Z${option.depth}`);
    await delay(ARM_CONFIG.clickDelay);
    await send(`Z${ARM_CONFIG.zUp}`);
    updateArmState({ currentX: option.x, currentY: option.y });

    console.log(
      `[execute-sequence] Verify word #${verifyResult.wordIndex}: option ${verifyResult.optionIndex + 1}, correct=${verifyResult.correctWord}`
    );
    if (Array.isArray(verifyResult.mnemonicWords) && verifyResult.mnemonicWords.length > 0) {
      console.log(
        '[execute-sequence] Mnemonic list:',
        verifyResult.mnemonicWords.map((word, idx) => `${idx + 1}.${word}`).join(', ')
      );
    }
    if (verifyResult.rawOptions.length > 0) {
      console.log('[execute-sequence] Verify raw options:', verifyResult.rawOptions.join(', '));
    }
    if (verifyResult.matchedOptions.length > 0) {
      console.log('[execute-sequence] Verify mapped options:', verifyResult.matchedOptions.join(', '));
    }
  } else if (step.swipeTo) {
    // Swipe: shared utility (single direct command, consistent with client UI)
    await executeSwipeStep(step as AutoStep & { swipeTo: { x: number; y: number } }, send, delay, stepConfig);
    updateArmState({ currentX: step.swipeTo.x, currentY: step.swipeTo.y });
  } else {
    // Click: shared utility (consistent with client UI)
    await executeClickStep(step, send, delay, stepConfig);
    updateArmState({ currentX: step.x, currentY: step.y });
  }

  // Wait after step (default 250ms for faster sequence execution)
  await delay(step.delayAfter ?? 250);
}

/**
 * Executes the execute-sequence tool.
 * Runs all steps in the specified sequence.
 */
export async function executeExecuteSequence(
  input: ExecuteSequenceInput,
  httpRequest: (url: string) => Promise<string>
): Promise<{ output: ExecuteSequenceOutput; frame: string | null }> {
  const state = getArmState();

  if (!state.isConnected || state.resourceHandle <= 0) {
    return {
      output: {
        success: false,
        message: 'Not connected to arm controller. Call arm-connect first.',
      },
      frame: null,
    };
  }

  const sequence = getSequence(input.sequenceId);
  if (!sequence) {
    return {
      output: {
        success: false,
        message: `Unknown sequence ID: ${input.sequenceId}. Available: ${getAllSequenceIds().join(', ')}`,
      },
      frame: null,
    };
  }

  // Pre-build all action steps once so that:
  // 1. totalSteps count and actual execution use the SAME resolved steps
  // 2. Actions with buildSteps (e.g. random share selection) are only evaluated once
  const resolvedActions: Array<{ action: NonNullable<ReturnType<typeof getPageAction>>; steps: AutoStep[] }> = [];
  for (const actionId of sequence.actions) {
    const action = getPageAction(actionId);
    if (!action) {
      return {
        output: {
          success: false,
          message: `Unknown page action ID: ${actionId}`,
          sequenceId: sequence.id,
          sequenceName: sequence.name,
        },
        frame: null,
      };
    }
    resolvedActions.push({ action, steps: action.buildSteps ? action.buildSteps() : action.steps });
  }
  const totalSteps = resolvedActions.reduce((sum, { steps }) => sum + steps.length, 0);
  let stepsCompleted = 0;
  const slip39CreateConfig = SLIP39_CREATE_SEQUENCE_CONFIG[sequence.id];
  const capturedShares: string[][] = [];

  // Reset stop flag at start
  setStopSequenceFlag(false);
  clearMnemonicWords();

  try {
    for (const { action, steps: actionSteps } of resolvedActions) {
      // action and actionSteps already resolved above

      for (const step of actionSteps) {
        if (shouldStopSequenceExecution()) {
          return {
            output: {
              success: false,
              message: `Sequence "${sequence.name}" stopped by user at step ${stepsCompleted + 1}`,
              sequenceId: sequence.id,
              sequenceName: sequence.name,
              stepsCompleted,
              totalSteps,
            },
            frame: null,
          };
        }

        await executeStep(step, state.resourceHandle, httpRequest);
        stepsCompleted++;
        console.log(`[execute-sequence] Step ${stepsCompleted}/${totalSteps}: ${step.label}`);
      }

      if (slip39CreateConfig && action.id === 'create-screenshot-20-part2') {
        const shareWords = getStoredMnemonicWords();
        if (shareWords.length === 0) {
          throw new Error('SLIP39 share capture is empty after create-screenshot-20-part2');
        }
        capturedShares.push([...shareWords]);
        console.log(
          `[execute-sequence] Captured SLIP39 share ${capturedShares.length}/${slip39CreateConfig.shareCount}`
        );
      }
    }

    if (slip39CreateConfig) {
      const latestWords = capturedShares[capturedShares.length - 1] || getStoredMnemonicWords();
      storeStructuredMnemonicState(
        {
          words: latestWords,
          shares: capturedShares,
          shareCount: slip39CreateConfig.shareCount,
          threshold: slip39CreateConfig.threshold,
          sequenceId: sequence.id,
          walletType: 'slip39',
          flowType: 'create',
        },
        'sequence-create-slip39'
      );
    } else if (sequence.id.startsWith('create-wallet')) {
      const createdWords = getStoredMnemonicWords();
      if (createdWords.length > 0) {
        storeStructuredMnemonicState(
          {
            words: createdWords,
            sequenceId: sequence.id,
            walletType: 'bip39',
            flowType: 'create',
          },
          'sequence-create-bip39'
        );
      }
    }

    const needsCooldown = requiresPostSequenceCooldown(sequence);
    if (needsCooldown) {
      console.log(
        `[execute-sequence] Cooling down for ${POST_WALLET_FLOW_COOLDOWN_MS}ms after ${sequence.id}`
      );
      await delay(POST_WALLET_FLOW_COOLDOWN_MS);
    }

    // Capture frame if requested
    let frame: string | null = null;
    if (input.returnFrame !== false) {
      frame = await captureFrame();
    }

    return {
      output: {
        success: true,
        message: needsCooldown
          ? `Sequence "${sequence.name}" completed successfully after ${POST_WALLET_FLOW_COOLDOWN_MS}ms cooldown`
          : `Sequence "${sequence.name}" completed successfully`,
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        stepsCompleted,
        totalSteps,
      },
      frame,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      output: {
        success: false,
        message: `Sequence execution failed at step ${stepsCompleted + 1}: ${errorMessage}`,
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        stepsCompleted,
        totalSteps,
      },
      frame: null,
    };
  }
}
