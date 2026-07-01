export interface SequenceOcrSceneConfig {
  readonly roi: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly scale?: number;
  readonly useNearestNeighbor?: boolean;
}

export type DeviceOcrScenes = {
  readonly createWallet?: {
    readonly mnemonic12?: SequenceOcrSceneConfig;
    readonly mnemonic18?: SequenceOcrSceneConfig;
    readonly mnemonic24Part1?: SequenceOcrSceneConfig;
    readonly mnemonic24Part2?: SequenceOcrSceneConfig;
  };
  readonly importWallet?: {
    readonly mnemonic12?: SequenceOcrSceneConfig;
    readonly mnemonic18?: SequenceOcrSceneConfig;
    readonly mnemonic24?: SequenceOcrSceneConfig;
  };
  readonly verifyWallet?: {
    readonly number?: SequenceOcrSceneConfig;
    readonly options?: SequenceOcrSceneConfig;
  };
};

export const PRO2_OCR_SCENES = {
  createWallet: {
    mnemonic12: {
      roi: { x: 250, y: 620, width: 620, height: 840 },
      scale: 5,
      useNearestNeighbor: true,
    },
  },
  verifyWallet: {
    number: {
      roi: { x: 250, y: 640, width: 620, height: 260 },
      scale: 5,
      useNearestNeighbor: true,
    },
    options: {
      roi: { x: 240, y: 1060, width: 640, height: 640 },
      scale: 5,
      useNearestNeighbor: false,
    },
  },
} as const satisfies DeviceOcrScenes;

export const DEVICE_OCR_SCENES: Record<'pro' | 'pro2', DeviceOcrScenes> = {
  pro: {},
  pro2: PRO2_OCR_SCENES,
};
