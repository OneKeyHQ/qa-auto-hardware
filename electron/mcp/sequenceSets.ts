import * as proSequences from './sequences';
import * as pro2Sequences from './pro2Sequences';
import * as neoSequences from './neoSequences';

import type { AutoSequence, PageAction } from './sequences';

export type DeviceTestSetId = 'pro' | 'pro2' | 'neo';

export interface DeviceTestSetOption {
  id: DeviceTestSetId;
  name: string;
}

export const DEFAULT_DEVICE_TEST_SET_ID: DeviceTestSetId = 'pro';

export const DEVICE_TEST_SETS: DeviceTestSetOption[] = [
  { id: 'pro', name: 'Pro' },
  { id: 'pro2', name: 'Pro2' },
  { id: 'neo', name: 'Neo' },
];

export function normalizeDeviceTestSetId(id?: string | null): DeviceTestSetId {
  if (id === 'pro2') return 'pro2';
  if (id === 'neo') return 'neo';
  return DEFAULT_DEVICE_TEST_SET_ID;
}

function getSequenceModule(deviceTestSetId?: string | null) {
  const id = normalizeDeviceTestSetId(deviceTestSetId);
  if (id === 'pro2') return pro2Sequences;
  if (id === 'neo') return neoSequences;
  return proSequences;
}

export function getSequence(id: string, deviceTestSetId?: string | null): AutoSequence | undefined {
  return getSequenceModule(deviceTestSetId).getSequence(id) as AutoSequence | undefined;
}

export function getPageAction(id: string, deviceTestSetId?: string | null): PageAction | undefined {
  return getSequenceModule(deviceTestSetId).getPageAction(id) as PageAction | undefined;
}

export function getAllSequenceIds(deviceTestSetId?: string | null): string[] {
  return getSequenceModule(deviceTestSetId).getAllSequenceIds();
}

export function getAllCategories(deviceTestSetId?: string | null): string[] {
  return getSequenceModule(deviceTestSetId).getAllCategories();
}

export function getSequencesByCategory(
  category: string,
  deviceTestSetId?: string | null
): AutoSequence[] {
  return getSequenceModule(deviceTestSetId).getSequencesByCategory(category) as AutoSequence[];
}

export function getFullSteps(
  sequence: AutoSequence,
  deviceTestSetId?: string | null
): proSequences.AutoStep[] {
  return getSequenceModule(deviceTestSetId).getFullSteps(sequence as never) as proSequences.AutoStep[];
}

export function getDeviceHomeCoord(deviceTestSetId?: string | null): { x: number; y: number } {
  return getSequenceModule(deviceTestSetId).DEVICE_HOME_COORD;
}
