/**
 * MCP Tool: confirm-action
 * Performs a confirm or cancel action on the device.
 */

import { z } from 'zod';
import {
  getArmState,
  updateArmState,
  buildArmApiUrl,
  captureFrame,
  delay,
  ARM_CONFIG,
} from '../state';
import { executeDeviceAction, type DeviceAction } from '../deviceActionRuntime';

export const deviceActionSchema = z.enum(['confirm', 'cancel', 'slide']);

/** Input schema for confirm-action tool */
export const confirmActionSchema = z.object({
  action: deviceActionSchema.describe(
    'The action to perform: "confirm" to click confirm, "cancel" to click cancel, "slide" to perform the slide-to-confirm gesture'
  ),
  returnFrame: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to capture and return a frame after the action (default: true)'),
});

export type ConfirmActionInput = z.infer<typeof confirmActionSchema>;

/** Output type for confirm-action tool */
export interface ConfirmActionOutput {
  success: boolean;
  message: string;
  action?: string;
  position?: { x: number; y: number };
}

export async function performDeviceAction(
  action: DeviceAction,
  httpRequest: (url: string) => Promise<string>
): Promise<{
  message: string;
  position: { x: number; y: number };
}> {
  const state = getArmState();
  const send = async (daima: string) => {
    await httpRequest(
      buildArmApiUrl({
        duankou: '0',
        hco: state.resourceHandle,
        daima,
      })
    );
  };
  const result = await executeDeviceAction(action, send, delay, {
    clickDelay: ARM_CONFIG.clickDelay,
    zUp: ARM_CONFIG.zUp,
    defaultZDepth: ARM_CONFIG.defaultZDepth,
  });
  updateArmState({
    currentX: result.x,
    currentY: result.y,
  });
  return {
    message: result.message,
    position: { x: result.x, y: result.y },
  };
}

/**
 * Executes the confirm-action tool.
 * Clicks the confirm or cancel button on the device.
 */
export async function executeConfirmAction(
  input: ConfirmActionInput,
  httpRequest: (url: string) => Promise<string>
): Promise<{ output: ConfirmActionOutput; frame: string | null }> {
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

  try {
    const actionResult = await performDeviceAction(input.action, httpRequest);

    // Wait a bit for device to process
    await delay(500);

    // Capture frame if requested
    let frame: string | null = null;
    if (input.returnFrame !== false) {
      frame = await captureFrame();
    }

    return {
      output: {
        success: true,
        message: actionResult.message,
        action: input.action,
        position: actionResult.position,
      },
      frame,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      output: {
        success: false,
        message: `${input.action} action failed: ${errorMessage}`,
        action: input.action,
      },
      frame: null,
    };
  }
}
