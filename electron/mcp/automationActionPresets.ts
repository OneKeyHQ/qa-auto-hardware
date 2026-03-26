/**
 * Shared automation action presets.
 * These presets define device button sequences for automation cases and can be
 * reused by both MCP tools and any local client/UI integrations.
 */

export type AutomationPresetSuite = 'deviceSettings' | 'securityCheck' | 'chainMethodBatch';
export type DeviceAction = 'confirm' | 'cancel' | 'slide';

export interface AutomationPresetRequest {
  suite: AutomationPresetSuite;
  presetId: string;
  expectedResult?: boolean;
}

export interface AutomationPresetEntry {
  id: string;
  steps: DeviceAction[];
}

const buildActionSequence = (confirmCount = 0, noSlide = false): DeviceAction[] => {
  if (confirmCount <= 0) {
    return [];
  }

  const steps: DeviceAction[] = Array(confirmCount).fill('confirm');
  if (!noSlide) {
    steps.push('slide');
  }
  return steps;
};

const SECURITY_CHECK_PRESETS: Record<string, { confirmCount: number; noSlide?: boolean }> = {
  alephiumSignTransaction: { confirmCount: 3 },
  algoSignTransaction: { confirmCount: 1 },
  aptosSignTransaction: { confirmCount: 2 },
  confluxSignTransaction: { confirmCount: 1 },
  cosmosSignTransaction: { confirmCount: 1 },
  dnxSignTransaction: { confirmCount: 0 },
  filecoinSignTransaction: { confirmCount: 1 },
  kaspaSignTransaction: { confirmCount: 2 },
  nearSignTransaction: { confirmCount: 1 },
  neoSignTransaction: { confirmCount: 1 },
  nexaSignTransaction: { confirmCount: 2 },
  nemSignTransaction: { confirmCount: 2 },
  nostrSignSchnorr: { confirmCount: 1, noSlide: true },
  nervosSignTransaction: { confirmCount: 2 },
  polkadotSignTransaction: { confirmCount: 1 },
  solSignTransaction: { confirmCount: 1 },
  scdoSignTransaction: { confirmCount: 1 },
  starcoinSignTransaction: { confirmCount: 2 },
  stellarSignTransaction: { confirmCount: 7 },
  suiSignTransaction: { confirmCount: 2 },
  xrpSignTransaction: { confirmCount: 1 },
  tonSignMessage: { confirmCount: 1 },
  tronSignTransaction: { confirmCount: 2 },
  alephiumSignMessage: { confirmCount: 1, noSlide: true },
  aptosSignMessage: { confirmCount: 1, noSlide: true },
  confluxSignMessage: { confirmCount: 1, noSlide: true },
  confluxSignMessageCIP23: { confirmCount: 1 },
  scdoSignMessage: { confirmCount: 1, noSlide: true },
  starcoinSignMessage: { confirmCount: 1, noSlide: true },
  suiSignMessage: { confirmCount: 1, noSlide: true },
  solSignMessage: { confirmCount: 1, noSlide: true },
  solSignOffchainMessage: { confirmCount: 1, noSlide: true },
  tronSignMessage: { confirmCount: 1, noSlide: true },
  tonSignProof: { confirmCount: 1, noSlide: true },
};

const CHAIN_METHOD_BATCH_PRESETS: Record<string, { confirmCount?: number; noSlide?: boolean }> = {
  solGetAddress: {},
  solSignTransaction: { confirmCount: 1 },
  solSignOffchainMessage: { confirmCount: 1, noSlide: true },
  solSignMessage: { confirmCount: 1, noSlide: true },
  btcGetAddress: {},
  btcGetPublicKey: {},
  btcSignMessage: { confirmCount: 1, noSlide: true },
  btcSignTransaction: { confirmCount: 2 },
  btcVerifyMessage: { confirmCount: 2, noSlide: true },
  cardanoGetAddress: {},
  cardanoGetPublicKey: {},
  cardanoSignTransaction: { confirmCount: 5 },
  cardanoSignMessage: { confirmCount: 1, noSlide: true },
  evmGetAddress: {},
  evmGetPublicKey: {},
  evmSignMessage: { confirmCount: 1, noSlide: true },
  evmSignTransaction: { confirmCount: 1 },
  evmSignTypedData: { confirmCount: 3 },
  evmVerifyMessage: { confirmCount: 2, noSlide: true },
  polkadotGetAddress: {},
  polkadotSignTransaction: { confirmCount: 1 },
};

export function resolveAutomationPresetSteps(request: AutomationPresetRequest): DeviceAction[] {
  if (request.suite === 'deviceSettings' && request.presetId === 'disableSafetyChecks') {
    return ['confirm'];
  }

  if (request.suite === 'securityCheck') {
    if (request.expectedResult === false) {
      return [];
    }
    const preset = SECURITY_CHECK_PRESETS[request.presetId];
    return preset ? buildActionSequence(preset.confirmCount, preset.noSlide) : [];
  }

  if (request.suite === 'chainMethodBatch') {
    const preset = CHAIN_METHOD_BATCH_PRESETS[request.presetId];
    return preset ? buildActionSequence(preset.confirmCount ?? 0, preset.noSlide) : [];
  }

  return [];
}

export function getAutomationPresetEntries(
  suite: Exclude<AutomationPresetSuite, 'deviceSettings'>
): AutomationPresetEntry[] {
  const source = suite === 'securityCheck' ? SECURITY_CHECK_PRESETS : CHAIN_METHOD_BATCH_PRESETS;

  return Object.entries(source)
    .map(([id, config]) => ({
      id,
      steps: buildActionSequence(config.confirmCount ?? 0, config.noSlide),
    }))
    .filter(entry => entry.steps.length > 0);
}
