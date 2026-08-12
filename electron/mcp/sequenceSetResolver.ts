import {
  resolvePageActionSteps,
  resolveSequenceSteps,
  resolveSequenceStepsById,
} from './sequenceResolver';
import {
  resolvePro2PageActionSteps,
  resolvePro2SequenceSteps,
  resolvePro2SequenceStepsById,
} from './pro2SequenceResolver';
import {
  resolveNeoPageActionSteps,
  resolveNeoSequenceSteps,
  resolveNeoSequenceStepsById,
} from './neoSequenceResolver';
import { normalizeDeviceTestSetId, type DeviceTestSetId } from './sequenceSets';

import type { AutoSequence, AutoStep, PageAction } from './sequences';

export function resolvePageActionStepsForDevice(
  action: PageAction,
  deviceTestSetId?: string | null
): AutoStep[] {
  const id = normalizeDeviceTestSetId(deviceTestSetId);
  if (id === 'pro2') return resolvePro2PageActionSteps(action as never) as AutoStep[];
  if (id === 'neo') return resolveNeoPageActionSteps(action as never) as AutoStep[];
  return resolvePageActionSteps(action);
}

export function resolveSequenceStepsForDevice(
  sequence: AutoSequence,
  deviceTestSetId?: string | null
): AutoStep[] {
  const id = normalizeDeviceTestSetId(deviceTestSetId);
  if (id === 'pro2') return resolvePro2SequenceSteps(sequence as never) as AutoStep[];
  if (id === 'neo') return resolveNeoSequenceSteps(sequence as never) as AutoStep[];
  return resolveSequenceSteps(sequence);
}

export function resolveSequenceStepsByIdForDevice(
  sequenceId: string,
  deviceTestSetId?: string | null
): AutoStep[] {
  const id = normalizeDeviceTestSetId(deviceTestSetId);
  if (id === 'pro2') return resolvePro2SequenceStepsById(sequenceId) as AutoStep[];
  if (id === 'neo') return resolveNeoSequenceStepsById(sequenceId) as AutoStep[];
  return resolveSequenceStepsById(sequenceId);
}

export type { DeviceTestSetId };
