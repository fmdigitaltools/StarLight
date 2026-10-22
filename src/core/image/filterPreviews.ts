import type { ImageData32 } from '@shared/types'
import { applyCorrections, type CorrectionParams } from '@core/export/processing'
import { applyPixelFilter, type FilterParams } from '@core/image/photoFilters'

/**
 * Photo filter thumbnails computed on the image being edited.
 *
 * Each thumbnail is a square around the subject, run through the same
 * chain as export (`applyCorrections` and `applyPixelFilter`): there is no
 * second way of computing colors that could drift from the real result.
 * The work is split into three stages, each repeated only when needed:
 *
 *   1. crop     once per image: the square at full resolution, with a
 *               two-pixel border
 *   2. base     on every change of adjustments or curves: the whole chain
 *               except the filter, pixel by pixel at full resolution
 *   3. filters  on every change of adjustments or intensity: the filter,
 *               still at full resolution, then area averaging down to the
 *               thumbnail side
 *
 * Everything is computed at full resolution and only averaged at the end:
 * this is what exporting and then downscaling yields, so the thumbnail
 * matches the downscaled export of the same area up to rounding. Averaging
 * first would cost far less but would be off by tens of levels on stars,
 * because the stretch and the filters are not linear (measured: up to 34
 * levels out of 255 with a false-color filter).
 */

/** Thumbnail side, in pixels: sharp even on high-density displays. */
export const PREVIEW_SIDE = 128

/**
 * Maximum side of the square, in image pixels: bounds the time of the
 * full-resolution chain and the memory. Measured on a 3840 x 2160 image:
 * about 0.2 s for the base and 0.6 s for the 25 filters, in the worker;
 * crop and base take about 10 MB, also in the worker.
 */
export const MAX_SIDE = 640

/**
 * Border pixels kept around the square: noise reduction and sharpening
 * each look one pixel around, so at the thumbnail edges they see the same
 * neighbors they would see in the whole image.
 */
const MARGIN = 2

export interface PreviewSquare {
  x0: number
  y0: number
  side: number
}

export interface PreviewCrop {
  /** Full-resolution square, with the margin around it. */
  image: ImageData32
  /** The square without the margin, in whole-image pixels. */
  square: PreviewSquare
  /** Actual margin on the left and at the top (it may be missing at the image edges). */
  marginX: number
  marginY: number
  /** Dimensions of the whole image, for the vignette. */
  fullWidth: number
  fullHeight: number
}

/**
 * Square to display, in whole-image pixels.
 *
 * @param center normalized position (0-1) of the subject, if known
 * @param diameter apparent diameter of the subject in pixels, if known
 */
export function chooseSquare(
  width: number,
  height: number,
  center: { x: number; y: number } | null,
  diameter: number | null
): PreviewSquare {
  const minimum = Math.min(width, height)
  // The subject with some sky around it; without a known size, half of the
  // short side: close enough to see the colors, wide enough to recognize
  // the scene. Never less than the thumbnail (it would be an upscale),
  // never more than the image or MAX_SIDE.
  const desired = diameter !== null && diameter > 0 ? diameter * 2.5 : minimum * 0.5
  const side = Math.round(Math.min(minimum, MAX_SIDE, Math.max(desired, PREVIEW_SIDE)))
  const cx = center ? center.x * width : width / 2
  const cy = center ? center.y * height : height / 2
  const x0 = Math.round(Math.min(width - side, Math.max(0, cx - side / 2)))
  const y0 = Math.round(Math.min(height - side, Math.max(0, cy - side / 2)))
  return { x0, y0, side }
}

/** Copies the square, with its margin, out of the whole image. */
export function prepareCrop(image: ImageData32, square: PreviewSquare): PreviewCrop {
  const { width: w, height: h, channels, data } = image
  const { x0, y0, side } = square
  const marginX = Math.min(MARGIN, x0)
  const marginY = Math.min(MARGIN, y0)
  const lw = side + marginX + Math.min(MARGIN, w - x0 - side)
  const lh = side + marginY + Math.min(MARGIN, h - y0 - side)
  const ox = x0 - marginX
  const oy = y0 - marginY
  const n = w * h
  const m = lw * lh
  const outside = new Float32Array(m * channels)
  for (let c = 0; c < channels; c++) {
    for (let y = 0; y < lh; y++) {
      const from = c * n + (oy + y) * w + ox
      outside.set(data.subarray(from, from + lw), c * m + y * lw)
    }
  }
  return {
    image: { width: lw, height: lh, channels, data: outside },
    square,
    marginX,
    marginY,
    fullWidth: w,
    fullHeight: h
  }
}

/** The whole export chain except the photo filter, at full resolution. */
export function computeBase(crop: PreviewCrop, p: Omit<CorrectionParams, 'filter'>): ImageData32 {
  return applyCorrections(crop.image, { ...p, filter: undefined })
}

/**
 * Applies a filter to the base, pixel by pixel at full resolution like
 * export, and reduces it to the thumbnail with area averaging: every
 * pixel of the square falls in exactly one cell, none is skipped. The
 * conversion to 8 bits is the same as export.
 *
 * @param filter the already dosed filter, or undefined for the unfiltered image
 * @returns the thumbnail side and its RGBA pixels
 */
export function thumbnailWithFilter(
  base: ImageData32,
  crop: PreviewCrop,
  filter: FilterParams | undefined,
  outputSide = PREVIEW_SIDE
): { side: number; rgba: Uint8ClampedArray } {
  const { marginX, marginY, square, fullWidth, fullHeight } = crop
  const L = square.side
  const k = Math.max(1, Math.min(outputSide, L))
  const lw = base.width
  const m = base.width * base.height
  const d = base.data

  const cell = new Int32Array(L)
  for (let i = 0; i < L; i++) cell[i] = Math.min(k - 1, Math.floor((i * k) / L))
  // Position in the whole image, the same one export passes to the
  // filter for the vignette.
  const posX = new Float32Array(L)
  const posY = new Float32Array(L)
  for (let i = 0; i < L; i++) {
    posX[i] = (square.x0 + i) / fullWidth
    posY[i] = (square.y0 + i) / fullHeight
  }

  const sums = new Float64Array(k * k * 3)
  const countBuffer = new Uint32Array(k * k)
  const rgb = [0, 0, 0]
  for (let y = 0; y < L; y++) {
    const row = (y + marginY) * lw + marginX
    const cy = cell[y] * k
    for (let x = 0; x < L; x++) {
      const i = row + x
      rgb[0] = d[i]
      rgb[1] = d[m + i]
      rgb[2] = d[2 * m + i]
      if (filter !== undefined) {
        applyPixelFilter(rgb, filter, posX[x], posY[y])
        for (let c = 0; c < 3; c++) rgb[c] = rgb[c] < 0 ? 0 : rgb[c] > 1 ? 1 : rgb[c]
      }
      const o = cy + cell[x]
      sums[o * 3] += rgb[0]
      sums[o * 3 + 1] += rgb[1]
      sums[o * 3 + 2] += rgb[2]
      countBuffer[o]++
    }
  }

  const rgba = new Uint8ClampedArray(k * k * 4)
  for (let o = 0; o < k * k; o++) {
    const inv = 1 / Math.max(1, countBuffer[o])
    rgba[o * 4] = sums[o * 3] * inv * 255
    rgba[o * 4 + 1] = sums[o * 3 + 1] * inv * 255
    rgba[o * 4 + 2] = sums[o * 3 + 2] * inv * 255
    rgba[o * 4 + 3] = 255
  }
  return { side: k, rgba }
}
