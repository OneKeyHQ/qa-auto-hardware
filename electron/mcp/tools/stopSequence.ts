/**
 * MCP Tool: stop-sequence
 * Stops the currently running sequence execution.
 */

import { z } from 'zod';
import { setStopSequenceFlag } from '../state';

/** Input schema for stop-sequence tool */
export const stopSequenceSchema = z.object({});

export type StopSequenceInput = z.infer<typeof stopSequenceSchema>;

/** Output type for stop-sequence tool */
export interface StopSequenceOutput {
  success: boolean;
  message: string;
}

/**
 * Executes the stop-sequence tool.
 * Sets the global stop flag to interrupt sequence execution.
 */
export async function executeStopSequence(
  _input: StopSequenceInput
): Promise<StopSequenceOutput> {
  setStopSequenceFlag(true);
  return {
    success: true,
    message: 'Stop signal sent. Sequence will stop at next step.',
  };
}
