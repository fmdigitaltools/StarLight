import type { ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'

/**
 * Pieces shared by all image readers (FITS, compressed FITS, XISF, TIFF,
 * PNG): the user-readable error type and the pixel normalization. They live
 * here rather than in reader.ts because the individual format readers use
 * them and reader.ts in turn uses the readers.
 */

/** Read error with a user-readable message, shown directly in the interface. */
export class FitsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FitsError'
  }
}

/**
 * The head that was read is not enough: more bytes from the start of the
 * file are needed to understand it. Callers that read headers only (folder
 * import) catch it and read again with the requested amount; `Infinity`
 * means "the whole file".
 */
export class InsufficientHead extends Error {
  constructor(readonly neededBytes: number) {
    super(t('coreCommon.insufficientHead', { bytes: neededBytes }))
    this.name = 'InsufficientHead'
  }
}

/**
 * Determines the full-scale value used to normalize values to [0,1].
 * Integers use the format's theoretical maximum; floating-point data uses
 * the observed maximum, since it may already be normalized or in ADU.
 * `bitpix` follows the FITS convention: positive for integers, negative
 * for floating point.
 */
export function detectScale(values: Float32Array, bitpix: number): number {
  if (bitpix === 8) return 255
  if (bitpix === 16) return 65535
  if (bitpix === 32) return 2147483647

  let max = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v) && v > max) max = v
  }
  if (max <= 1.0001) return 1
  if (max <= 255) return 255
  if (max <= 65535) return 65535
  return max
}

/**
 * Builds the normalized image from the physical values, laid out in planes
 * ([R..., G..., B...] or a single plane). Planes beyond the third (for
 * example an alpha channel) are ignored; two planes become a single one
 * (gray plus alpha). A missing value (NaN) becomes black so that it does
 * not poison statistics and filters.
 */
export function composeImage(
  raw: Float32Array,
  width: number,
  height: number,
  planes: number,
  scale: number
): ImageData32 {
  const pixelsPerPlane = width * height
  const channels: 1 | 3 = planes >= 3 ? 3 : 1
  const used = channels === 3 ? pixelsPerPlane * 3 : pixelsPerPlane
  // The physical values are only needed here: if they occupy exactly the
  // planes in use they are normalized in place, avoiding a second copy of
  // the frame. Each value depends only on itself, so the result is identical.
  const data = raw.length === used && raw.byteOffset === 0 && raw.buffer.byteLength === used * 4 ? raw : new Float32Array(used)
  const inv = 1 / scale
  for (let i = 0; i < used; i++) {
    const v = raw[i] * inv
    // Out-of-range values are clamped to the useful interval.
    data[i] = v > 0 ? (v < 1 ? v : 1) : 0
  }
  return { width, height, channels, data }
}
