export type PreferredDeviceTestSetId = 'pro' | 'pro2' | 'neo';

export const DEFAULT_PREFERRED_DEVICE_TEST_SET_ID: PreferredDeviceTestSetId = 'pro';
export const SELECTED_DEVICE_TEST_SET_STORAGE_KEY = 'phonepilot:selected-device-test-set';

export function normalizePreferredDeviceTestSet(value: string | null): PreferredDeviceTestSetId {
  if (value === 'pro2') return 'pro2';
  if (value === 'neo') return 'neo';
  return DEFAULT_PREFERRED_DEVICE_TEST_SET_ID;
}

export function getStoredDeviceTestSet(): PreferredDeviceTestSetId {
  try {
    return normalizePreferredDeviceTestSet(localStorage.getItem(SELECTED_DEVICE_TEST_SET_STORAGE_KEY));
  } catch {
    return DEFAULT_PREFERRED_DEVICE_TEST_SET_ID;
  }
}

export function storeDeviceTestSet(deviceTestSetId: PreferredDeviceTestSetId): void {
  try {
    localStorage.setItem(SELECTED_DEVICE_TEST_SET_STORAGE_KEY, deviceTestSetId);
  } catch {
    // Ignore storage errors; the selector still works for the current session.
  }
}
