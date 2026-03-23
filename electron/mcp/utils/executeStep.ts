/**
 * Shared step executor for ARM controller operations.
 *
 * This is the single source of truth for click and swipe step execution.
 * Both the QA Auto Hardware client (ControlPanel.tsx) and the MCP tool (executeSequence.ts)
 * use this utility so their behavior stays identical.
 *
 * OCR capture / OCR verify steps are NOT handled here because they require
 * platform-specific integrations (window events in the browser, IPC calls in MCP).
 */

import type { AutoStep } from '../sequences';

/** Send a raw `daima` string command to the ARM controller. */
export type SendDaima = (daima: string) => Promise<void>;

/** Delay utility (returns a Promise that resolves after `ms` milliseconds). */
export type DelayFn = (ms: number) => Promise<void>;

export interface StepExecutorConfig {
  clickDelay: number;
  zUp: number;
}

/**
 * Executes a single click step:
 *   move → lower stylus → wait → raise stylus
 */
export async function executeClickStep(
  step: AutoStep,
  send: SendDaima,
  delay: DelayFn,
  config: StepExecutorConfig
): Promise<void> {
  await send(`X${step.x}Y${step.y}`);
  await send(`Z${step.depth}`);
  await delay(config.clickDelay);
  await send(`Z${config.zUp}`);
}

/**
 * Executes a single swipe step.
 * If `swipeSegments` >= 2, the swipe path is broken into multiple intermediate moves
 * with `swipeSegmentDelay` ms between each, producing a slower, more controlled gesture.
 * Otherwise falls back to a single direct move.
 *
 *   move to start → lower stylus → brief pause → [segmented move to end] → hold → raise stylus
 */
export async function executeSwipeStep(
  step: AutoStep & { swipeTo: { x: number; y: number } },
  send: SendDaima,
  delay: DelayFn,
  config: StepExecutorConfig
): Promise<void> {
  await send(`X${step.x}Y${step.y}`);
  await send(`Z${step.depth}`);
  await delay(50);

  const segments = step.swipeSegments ?? 1;
  if (segments >= 2) {
    const segDelay = step.swipeSegmentDelay ?? 0;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const ix = Math.round(step.x + (step.swipeTo.x - step.x) * t);
      const iy = Math.round(step.y + (step.swipeTo.y - step.y) * t);
      await send(`X${ix}Y${iy}`);
      if (segDelay > 0 && i < segments) {
        await delay(segDelay);
      }
    }
  } else {
    await send(`X${step.swipeTo.x}Y${step.swipeTo.y}`);
  }

  await delay(step.swipeHoldDelay ?? 50);
  await send(`Z${config.zUp}`);
}
