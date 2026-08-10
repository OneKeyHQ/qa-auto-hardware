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

export const PRO_OCR_SCENES = {
  createWallet: {
    // 12-word grid only (rows at y≈725-1227): excludes status bar and Chinese
    // header so OCR resolution goes entirely to the numbered words.
    mnemonic12: {
      roi: { x: 225, y: 690, width: 665, height: 580 },
      scale: 5,
      useNearestNeighbor: true,
    },
    // 18-word page: no big title, instruction line ends ~y565, 9 grid rows at
    // y≈610-1370 (the legacy ROI bottom at 1360 clipped row 9).
    mnemonic18: {
      roi: { x: 225, y: 580, width: 665, height: 830 },
      scale: 5,
      useNearestNeighbor: true,
    },
    // 20/24-word lists are a scrolled 2-column window. Part1 (unscrolled):
    // header above, 8 rows at y≈729-1401, cyan 继续 button from y≈1419 — the
    // ROI must stop above it. Part2 (scrolled): full rows at y≈565-1322 with a
    // half-clipped row near the status bar; span the whole list viewport to
    // absorb scroll-position variance between runs.
    mnemonic24Part1: {
      roi: { x: 225, y: 695, width: 665, height: 715 },
      scale: 5,
      useNearestNeighbor: true,
    },
    mnemonic24Part2: {
      roi: { x: 225, y: 520, width: 665, height: 890 },
      scale: 5,
      useNearestNeighbor: true,
    },
  },
  verifyWallet: {
    // "单词 #N" title sits at y≈545-615; the old default ROI (y 480-610) was
    // almost entirely above it. Keep the title in the upper part so the tight
    // first-line fallback crop (y-20, 72% height) still contains the digits.
    number: {
      roi: { x: 160, y: 530, width: 520, height: 170 },
      scale: 5,
      useNearestNeighbor: true,
    },
  },
} as const satisfies DeviceOcrScenes;

export const PRO2_OCR_SCENES = {
  createWallet: {
    mnemonic12: {
      roi: { x: 250, y: 620, width: 620, height: 840 },
      scale: 5,
      useNearestNeighbor: true,
    },
    // 18-word page (pro-style single capture): after the scroll-10 the title
    // collapses and all 9 grid rows fit the viewport; span the whole list.
    mnemonic18: {
      roi: { x: 250, y: 600, width: 620, height: 920 },
      scale: 5,
      useNearestNeighbor: true,
    },
    // 24-word page is captured in two passes. Part1 (unscrolled): rows below
    // the 准备备份 subtitle (row1 y≈900) down to just above the 备份 button
    // (y≈1500). Part2 (after scroll): rows shift up; span the whole list
    // viewport to absorb scroll-position variance between runs.
    mnemonic24Part1: {
      roi: { x: 250, y: 830, width: 620, height: 680 },
      scale: 5,
      useNearestNeighbor: true,
    },
    mnemonic24Part2: {
      roi: { x: 250, y: 580, width: 620, height: 940 },
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
  pro: PRO_OCR_SCENES,
  pro2: PRO2_OCR_SCENES,
};
