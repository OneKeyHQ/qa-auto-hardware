/**
 * Neo 序列解析器。
 * 逐个动作的步骤解析（含 mnemonicSource → 逐词键盘步骤）与 Pro2 完全一致，
 * 直接复用 resolvePro2PageActionSteps；仅在按序列/ID 解析时改用 Neo 的动作表，
 * 使 nav-continue-setup 走无指纹版本。
 */
import { getPageAction, getSequence, type AutoSequence, type AutoStep, type PageAction } from './neoSequences';
import { resolvePro2PageActionSteps } from './pro2SequenceResolver';

export function resolveNeoPageActionSteps(action: PageAction): AutoStep[] {
  return resolvePro2PageActionSteps(action as never);
}

export function resolveNeoSequenceSteps(sequence: AutoSequence): AutoStep[] {
  const steps: AutoStep[] = [];
  for (const actionId of sequence.actions) {
    const action = getPageAction(actionId);
    if (!action) {
      console.warn(`[neo-sequence-resolver] Unknown page action ID: ${actionId}`);
      continue;
    }
    steps.push(...resolvePro2PageActionSteps(action as never));
  }
  return steps;
}

export function resolveNeoSequenceStepsById(sequenceId: string): AutoStep[] {
  const sequence = getSequence(sequenceId);
  if (!sequence) {
    throw new Error(`Unknown Neo sequence ID: ${sequenceId}`);
  }
  return resolveNeoSequenceSteps(sequence);
}
