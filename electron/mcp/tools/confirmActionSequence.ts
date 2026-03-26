/**
 * MCP Tool: confirm-action-sequence
 * Executes a sequence of confirm / cancel / slide actions on the device.
 */

import { z } from 'zod';
import { ARM_CONFIG, buildArmApiUrl, captureFrame, delay, getArmState } from '../state';
import { executeDeviceActionSequence } from '../deviceActionRuntime';
import { deviceActionSchema } from './confirmAction';

export const confirmActionSequenceSchema = z.object({
  steps: z
    .array(deviceActionSchema)
    .min(1)
    .describe('Ordered device actions to execute, e.g. ["confirm", "confirm", "slide"]'),
  startDelayMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(500)
    .describe('Delay before executing the first action in milliseconds (default: 500)'),
  betweenStepsDelayMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(300)
    .describe('Delay between actions in milliseconds (default: 300)'),
  returnFrame: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to capture and return a frame after completion (default: true)'),
});

export type ConfirmActionSequenceInput = z.infer<typeof confirmActionSequenceSchema>;

export interface ConfirmActionSequenceOutput {
  success: boolean;
  message: string;
  steps: Array<'confirm' | 'cancel' | 'slide'>;
  stepsCompleted: number;
}

export async function executeConfirmActionSequence(
  input: ConfirmActionSequenceInput,
  httpRequest: (url: string) => Promise<string>
): Promise<{ output: ConfirmActionSequenceOutput; frame: string | null }> {
  const state = getArmState();

  if (!state.isConnected || state.resourceHandle <= 0) {
    return {
      output: {
        success: false,
        message: 'Not connected to arm controller. Call arm-connect first.',
        steps: input.steps,
        stepsCompleted: 0,
      },
      frame: null,
    };
  }

  try {
    const send = async (daima: string) => {
      await httpRequest(buildArmApiUrl({ duankou: '0', hco: state.resourceHandle, daima }));
    };
    const { stepsCompleted } = await executeDeviceActionSequence(
      input.steps,
      send,
      delay,
      {
        clickDelay: ARM_CONFIG.clickDelay,
        zUp: ARM_CONFIG.zUp,
        defaultZDepth: ARM_CONFIG.defaultZDepth,
      },
      {
        startDelayMs: input.startDelayMs,
        betweenStepsDelayMs: input.betweenStepsDelayMs,
      }
    );

    await delay(500);

    let frame: string | null = null;
    if (input.returnFrame !== false) {
      frame = await captureFrame();
    }

    return {
      output: {
        success: true,
        message: `Action sequence executed: ${input.steps.join(' -> ')}`,
        steps: input.steps,
        stepsCompleted,
      },
      frame,
    };
  } catch (error) {
    return {
      output: {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        steps: input.steps,
        stepsCompleted: 0,
      },
      frame: null,
    };
  }
}
