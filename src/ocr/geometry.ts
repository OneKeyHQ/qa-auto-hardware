import type { ROI } from './types';

/**
 * Draws the video frame rotated 90° clockwise onto the canvas.
 * Caller must set canvas.width = video.videoHeight, canvas.height = video.videoWidth before calling.
 */
export function rotateVideoFrameToCanvas(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = video.videoHeight;
  canvas.height = video.videoWidth;
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(
    video,
    -video.videoWidth / 2,
    -video.videoHeight / 2,
    video.videoWidth,
    video.videoHeight
  );
  ctx.restore();
}

/**
 * Crops a region from the source canvas and returns a new canvas.
 */
export function cropToROI(sourceCanvas: HTMLCanvasElement, roi: ROI): HTMLCanvasElement {
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = roi.width;
  cropCanvas.height = roi.height;
  const ctx = cropCanvas.getContext('2d');
  if (!ctx) return cropCanvas;

  ctx.drawImage(
    sourceCanvas,
    roi.x, roi.y, roi.width, roi.height,
    0, 0, roi.width, roi.height
  );
  return cropCanvas;
}

/**
 * Scales the source canvas by the given factor.
 * useNearestNeighbor: true keeps pixel edges sharp (e.g. for mnemonic pixel fonts).
 */
export function scaleCanvas(
  source: HTMLCanvasElement,
  scale: number,
  useNearestNeighbor: boolean
): HTMLCanvasElement {
  const w = source.width * scale;
  const h = source.height * scale;
  const scaled = document.createElement('canvas');
  scaled.width = w;
  scaled.height = h;
  const ctx = scaled.getContext('2d');
  if (!ctx) return scaled;

  ctx.imageSmoothingEnabled = !useNearestNeighbor;
  ctx.imageSmoothingQuality = useNearestNeighbor ? 'low' : 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return scaled;
}
