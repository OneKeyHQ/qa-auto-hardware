/**
 * Shared device action runtime.
 * Both the PhonePilot UI and MCP tools should route confirm / slide behavior here.
 */

import { DEVICE_BUTTONS, type AutoStep } from './sequences';
import { executeClickStep, executeSwipeStep } from './utils/executeStep';

export type DeviceAction = 'confirm' | 'cancel' | 'slide';

export interface DeviceActionRuntimeConfig {
  clickDelay: number;
  zUp: number;
  defaultZDepth: number;
}

export type DeviceActionSend = (daima: string) => Promise<void>;
export type DeviceActionDelay = (ms: number) => Promise<void>;

const CLICK_ACTIONS: Record<'confirm' | 'cancel', { x: number; y: number }> = {
  confirm: DEVICE_BUTTONS.confirm,
  cancel: DEVICE_BUTTONS.cancel,
};

function buildClickStep(
  action: 'confirm' | 'cancel',
  config: DeviceActionRuntimeConfig
): AutoStep {
  const point = CLICK_ACTIONS[action];
  return {
    label: action === 'confirm' ? 'Confirm' : 'Cancel',
    x: point.x,
    y: point.y,
    depth: config.defaultZDepth,
  };
}

function buildSlideStep(config: DeviceActionRuntimeConfig): AutoStep & { swipeTo: { x: number; y: number } } {
  return {
    label: 'Slide confirm',
    x: 20,
    y: 75,
    depth: config.defaultZDepth,
    swipeTo: { x: 60, y: 75 },
    swipeSegments: 6,
    swipeSegmentDelay: 70,
    swipeHoldDelay: 900,
  };
}

export async function executeDeviceAction(
  action: DeviceAction,
  send: DeviceActionSend,
  delay: DeviceActionDelay,
  config: DeviceActionRuntimeConfig
): Promise<{ x: number; y: number; message: string }> {
  if (action === 'slide') {
    const step = buildSlideStep(config);
    await executeSwipeStep(step, send, delay, {
      clickDelay: config.clickDelay,
      zUp: config.zUp,
    });
    return {
      x: step.swipeTo.x,
      y: step.swipeTo.y,
      message: `Slide confirm gesture executed from (${step.x}, ${step.y}) to (${step.swipeTo.x}, ${step.swipeTo.y})`,
    };
  }

  const step = buildClickStep(action, config);
  await executeClickStep(step, send, delay, {
    clickDelay: config.clickDelay,
    zUp: config.zUp,
  });
  return {
    x: step.x,
    y: step.y,
    message: `${action === 'confirm' ? 'Confirm' : 'Cancel'} button clicked at (${step.x}, ${step.y})`,
  };
}

export async function executeDeviceActionSequence(
  steps: DeviceAction[],
  send: DeviceActionSend,
  delay: DeviceActionDelay,
  config: DeviceActionRuntimeConfig,
  options?: { startDelayMs?: number; betweenStepsDelayMs?: number }
): Promise<{ stepsCompleted: number; lastPosition?: { x: number; y: number } }> {
  const startDelayMs = options?.startDelayMs ?? 0;
  const betweenStepsDelayMs = options?.betweenStepsDelayMs ?? 0;
  const confirmToSlideDelayMs = Math.max(betweenStepsDelayMs, 900);

  if (startDelayMs > 0) {
    await delay(startDelayMs);
  }

  let stepsCompleted = 0;
  let lastPosition: { x: number; y: number } | undefined;

  for (let index = 0; index < steps.length; index += 1) {
    const result = await executeDeviceAction(steps[index], send, delay, config);
    stepsCompleted += 1;
    lastPosition = { x: result.x, y: result.y };

    const nextStep = steps[index + 1];
    if (index < steps.length - 1) {
      const transitionDelayMs =
        steps[index] === 'confirm' && nextStep === 'slide'
          ? confirmToSlideDelayMs
          : betweenStepsDelayMs;

      if (transitionDelayMs > 0) {
        await delay(transitionDelayMs);
      }
    }
  }

  return { stepsCompleted, lastPosition };
}
