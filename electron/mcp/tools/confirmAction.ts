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
import { DEVICE_BUTTONS } from '../sequences';

/** Input schema for confirm-action tool */
export const confirmActionSchema = z.object({
  action: z
    .enum(['confirm', 'cancel'])
    .describe('The action to perform: "confirm" to click the confirm button, "cancel" to click the cancel button'),
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

  const button = input.action === 'confirm' ? DEVICE_BUTTONS.confirm : DEVICE_BUTTONS.cancel;
  const buttonName = input.action === 'confirm' ? 'Confirm' : 'Cancel';

  try {
    // Move to button position
    const moveUrl = buildArmApiUrl({
      duankou: '0',
      hco: state.resourceHandle,
      daima: `X${button.x}Y${button.y}`,
    });
    await httpRequest(moveUrl);

    // Lower stylus
    const lowerUrl = buildArmApiUrl({
      duankou: '0',
      hco: state.resourceHandle,
      daima: `Z${ARM_CONFIG.defaultZDepth}`,
    });
    await httpRequest(lowerUrl);

    await delay(ARM_CONFIG.clickDelay);

    // Raise stylus
    const raiseUrl = buildArmApiUrl({
      duankou: '0',
      hco: state.resourceHandle,
      daima: `Z${ARM_CONFIG.zUp}`,
    });
    await httpRequest(raiseUrl);

    // Update position
    updateArmState({
      currentX: button.x,
      currentY: button.y,
    });

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
        message: `${buttonName} button clicked at (${button.x}, ${button.y})`,
        action: input.action,
        position: { x: button.x, y: button.y },
      },
      frame,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      output: {
        success: false,
        message: `${buttonName} action failed: ${errorMessage}`,
        action: input.action,
      },
      frame: null,
    };
  }
}
