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
import { normalizeDeviceTestSetId, type DeviceTestSetId } from './sequenceSets';

import type { AutoSequence, AutoStep, PageAction } from './sequences';

export function resolvePageActionStepsForDevice(
  action: PageAction,
  deviceTestSetId?: string | null
): AutoStep[] {
  return normalizeDeviceTestSetId(deviceTestSetId) === 'pro2'
    ? resolvePro2PageActionSteps(action as never) as AutoStep[]
    : resolvePageActionSteps(action);
}

export function resolveSequenceStepsForDevice(
  sequence: AutoSequence,
  deviceTestSetId?: string | null
): AutoStep[] {
  return normalizeDeviceTestSetId(deviceTestSetId) === 'pro2'
    ? resolvePro2SequenceSteps(sequence as never) as AutoStep[]
    : resolveSequenceSteps(sequence);
}

export function resolveSequenceStepsByIdForDevice(
  sequenceId: string,
  deviceTestSetId?: string | null
): AutoStep[] {
  return normalizeDeviceTestSetId(deviceTestSetId) === 'pro2'
    ? resolvePro2SequenceStepsById(sequenceId) as AutoStep[]
    : resolveSequenceStepsById(sequenceId);
}

export type { DeviceTestSetId };
