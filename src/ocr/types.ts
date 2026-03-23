/**
 * Region of interest for cropping the camera frame (in rotated canvas coordinates).
 */
export interface ROI {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Full scene config: ROI and scaling options for OCR input.
 */
export interface OcrSceneConfig {
  readonly roi: ROI;
  readonly scale: number;
  readonly useNearestNeighbor: boolean;
}
