import type { OcrSceneConfig } from './types';

/** Mnemonic phrase page (12-word create-wallet): focus only on the 2-column word grid. */
export const MNEMONIC_SCENE: OcrSceneConfig = {
  // Further expand upward for 24-word flow so top rows are fully captured.
  roi: { x: 250, y: 430, width: 620, height: 930 },
  scale: 5,
  useNearestNeighbor: true,
};

/** Verification page: "#N" number region, 5x scale for stronger digit legibility. */
export const VERIFY_NUMBER_SCENE: OcrSceneConfig = {
  roi: { x: 230, y: 480, width: 400, height: 130 },
  scale: 5,
  useNearestNeighbor: true,
};

/** Verification page: bottom options region (3 word choices). */
export const VERIFY_OPTIONS_SCENE: OcrSceneConfig = {
  // Tight ROI around lower 3-option card to avoid header text noise.
  roi: { x: 250, y: 1160, width: 620, height: 360 },
  scale: 5,
  useNearestNeighbor: false,
};
