/**
 * MCP Tool: execute-automation-preset
 * Resolves and executes a shared automation preset on the PhonePilot side.
 */

import { z } from 'zod';
import { ARM_CONFIG, buildArmApiUrl, captureFrame, delay, getArmState } from '../state';
import { executeDeviceActionSequence } from '../deviceActionRuntime';
import { resolveAutomationPresetSteps } from '../automationActionPresets';
import { deviceActionSchema } from './confirmAction';

export const executeAutomationPresetSchema = z.object({
  suite: z
    .enum(['deviceSettings', 'securityCheck', 'chainMethodBatch'])
    .describe('Preset group to resolve'),
  presetId: z.string().describe('Preset identifier, usually the SDK method name or operation name'),
  expectedResult: z
    .boolean()
    .optional()
    .describe('Optional case expectation, used by securityCheck to skip blocked cases'),
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

export type ExecuteAutomationPresetInput = z.infer<typeof executeAutomationPresetSchema>;

export interface ExecuteAutomationPresetOutput {
  success: boolean;
  message: string;
  suite: 'deviceSettings' | 'securityCheck' | 'chainMethodBatch';
  presetId: string;
  steps: Array<z.infer<typeof deviceActionSchema>>;
  stepsCompleted: number;
}

export async function executeAutomationPreset(
  input: ExecuteAutomationPresetInput,
  httpRequest: (url: string) => Promise<string>
): Promise<{ output: ExecuteAutomationPresetOutput; frame: string | null }> {
  const state = getArmState();

  if (!state.isConnected || state.resourceHandle <= 0) {
    return {
      output: {
        success: false,
        message: 'Not connected to arm controller. Call arm-connect first.',
        suite: input.suite,
        presetId: input.presetId,
        steps: [],
        stepsCompleted: 0,
      },
      frame: null,
    };
  }

  const steps = resolveAutomationPresetSteps({
    suite: input.suite,
    presetId: input.presetId,
    expectedResult: input.expectedResult,
  });

  try {
    const send = async (daima: string) => {
      await httpRequest(buildArmApiUrl({ duankou: '0', hco: state.resourceHandle, daima }));
    };
    const { stepsCompleted } = await executeDeviceActionSequence(
      steps,
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
        message:
          steps.length > 0
            ? `Automation preset executed: ${input.suite}/${input.presetId} -> ${steps.join(' -> ')}`
            : `Automation preset resolved to no action: ${input.suite}/${input.presetId}`,
        suite: input.suite,
        presetId: input.presetId,
        steps,
        stepsCompleted,
      },
      frame,
    };
  } catch (error) {
    return {
      output: {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        suite: input.suite,
        presetId: input.presetId,
        steps,
        stepsCompleted: 0,
      },
      frame: null,
    };
  }
}
