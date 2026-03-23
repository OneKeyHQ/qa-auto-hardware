/**
 * Saves a captured frame (base64 or data URL) to the user's Downloads folder.
 * Used for OCR capture points so the image before OCR can be inspected.
 */

import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';

const HINT_MAX_LENGTH = 32;

/**
 * Sanitizes content hint for use in filenames: keep alphanumeric and hyphen, truncate length.
 */
function sanitizeHint(hint: string): string {
  const sanitized = hint.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized.slice(0, HINT_MAX_LENGTH) || 'capture';
}

/**
 * Extracts raw base64 string from either a data URL or a plain base64 string.
 */
function extractBase64(dataUrlOrBase64: string): string {
  if (dataUrlOrBase64.startsWith('data:image')) {
    const base64Index = dataUrlOrBase64.indexOf('base64,');
    if (base64Index !== -1) {
      return dataUrlOrBase64.slice(base64Index + 7);
    }
  }
  return dataUrlOrBase64;
}

/**
 * Saves a capture (data URL or raw base64) to the user's Downloads folder.
 * Filename: qa-auto-hw-YYYYMMDD-HHmmss-sss-{contentHint}.jpg
 *
 * @param dataUrlOrBase64 - JPEG as data URL or raw base64 string
 * @param contentHint - Short label for the file (e.g. ocr-x85-y0, ocr-trigger)
 * @returns Full path of the saved file
 */
export async function saveCaptureToDownloads(
  dataUrlOrBase64: string,
  contentHint: string
): Promise<string> {
  const downloadsDir = app.getPath('downloads');
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hhmmss = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  const hint = sanitizeHint(contentHint);
  const filename = `qa-auto-hw-${dateStr}-${hhmmss}-${ms}-${hint}.jpg`;
  const fullPath = path.join(downloadsDir, filename);

  const base64 = extractBase64(dataUrlOrBase64);
  const buffer = Buffer.from(base64, 'base64');

  await fs.writeFile(fullPath, buffer);
  console.log('[saveCapture] Saved to', fullPath);
  return fullPath;
}
