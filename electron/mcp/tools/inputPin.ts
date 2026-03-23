/**
 * MCP Tool: input-pin
 * Inputs a PIN code on the device using the number pad.
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
import { NUMBER_COORDS, DEVICE_BUTTONS } from '../sequences';

/** Input schema for input-pin tool */
export const inputPinSchema = z.object({
  pin: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[0-9]+$/, 'PIN must contain only digits 0-9')
    .describe('The PIN code to input (digits only)'),
  confirm: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to click the confirm button after entering the PIN (default: true)'),
  returnFrame: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to capture and return a frame after completion (default: true)'),
});

export type InputPinInput = z.infer<typeof inputPinSchema>;

/** Output type for input-pin tool */
export interface InputPinOutput {
  success: boolean;
  message: string;
  digitsEntered?: number;
  confirmed?: boolean;
}

/**
 * Executes the input-pin tool.
 * Types the PIN code using the on-screen number pad.
 */
export async function executeInputPin(
  input: InputPinInput,
  httpRequest: (url: string) => Promise<string>
): Promise<{ output: InputPinOutput; frame: string | null }> {
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

  const pin = input.pin;
  let digitsEntered = 0;

  try {
    // Enter each digit
    for (const digit of pin) {
      const coord = NUMBER_COORDS[digit];
      if (!coord) {
        return {
          output: {
            success: false,
            message: `Invalid digit in PIN: ${digit}`,
            digitsEntered,
          },
          frame: null,
        };
      }

      // Move to digit position
      const moveUrl = buildArmApiUrl({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `X${coord.x}Y${coord.y}`,
      });
      await httpRequest(moveUrl);

      // Click
      const lowerUrl = buildArmApiUrl({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `Z${ARM_CONFIG.defaultZDepth}`,
      });
      await httpRequest(lowerUrl);

      await delay(ARM_CONFIG.clickDelay);

      const raiseUrl = buildArmApiUrl({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `Z${ARM_CONFIG.zUp}`,
      });
      await httpRequest(raiseUrl);

      updateArmState({
        currentX: coord.x,
        currentY: coord.y,
      });

      digitsEntered++;
      await delay(300); // Delay between digits
    }

    // Click confirm if requested
    let confirmed = false;
    if (input.confirm !== false) {
      const confirmButton = DEVICE_BUTTONS.confirm;

      const moveUrl = buildArmApiUrl({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `X${confirmButton.x}Y${confirmButton.y}`,
      });
      await httpRequest(moveUrl);

      const lowerUrl = buildArmApiUrl({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `Z${ARM_CONFIG.defaultZDepth}`,
      });
      await httpRequest(lowerUrl);

      await delay(ARM_CONFIG.clickDelay);

      const raiseUrl = buildArmApiUrl({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `Z${ARM_CONFIG.zUp}`,
      });
      await httpRequest(raiseUrl);

      updateArmState({
        currentX: confirmButton.x,
        currentY: confirmButton.y,
      });

      confirmed = true;
      await delay(500); // Wait for device to process
    }

    // Capture frame if requested
    let frame: string | null = null;
    if (input.returnFrame !== false) {
      frame = await captureFrame();
    }

    return {
      output: {
        success: true,
        message: `PIN entered successfully (${digitsEntered} digits)${confirmed ? ', confirmed' : ''}`,
        digitsEntered,
        confirmed,
      },
      frame,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      output: {
        success: false,
        message: `PIN input failed: ${errorMessage}`,
        digitsEntered,
      },
      frame: null,
    };
  }
}
