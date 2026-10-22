import type { BayerPattern, ImageData32 } from '@shared/types'
import { colorAt } from './debayer'
import { autoStretch, applyStretchValue } from './stretch'

/**
 * Thumbnail of a frame for the library.
 *
 * With dozens of frames in the list, the file name alone is not enough to
 * recall what they contain; a small square image is. The central square of
 * the frame is taken, reduced by block averaging (which also removes much
 * of the noise), and the reduced version is stretched, so the cost stays at
 * a few milliseconds even on the largest files.
 */

/** Default thumbnail side, in pixels: sharp even on high-density displays. */
export const THUMBNAIL_SIDE = 96

export interface Thumbnail {
  /** Side of the square, in pixels. */
  side: number
  /** RGBA pixels, row by row, ready for a canvas ImageData. */
  rgba: Uint8ClampedArray
  /**
   * True if it comes from the preview the camera embedded in the RAW file
   * rather than from the sensor data: as soon as the frame is decoded
   * (opening, analysis) the real thumbnail takes its place.
   */
  temporary?: boolean
}

/**
 * Reduces the central square of the image to side x side RGB pixels.
 *
 * Accepts both already-colored images and raw color-sensor data (a single
 * plane with a Bayer pattern): in the latter case each sensor pixel is added
 * to its own color, without first reconstructing the whole image.
 */
export function reduceCentralSquare(
  image: ImageData32,
  bayer: BayerPattern,
  side = THUMBNAIL_SIDE
): ImageData32 {
  const { width: w, height: h, data, channels } = image
  const square = Math.min(w, h)
  const n = Math.max(1, Math.min(side, square))
  const x0 = Math.floor((w - square) / 2)
  const y0 = Math.floor((h - square) / 2)
  const step = square / n
  const plane = w * h
  const outside = new Float32Array(n * n * 3)
  const withBayer = channels === 1 && bayer !== 'NONE'
  // Color of the four positions of the 2x2 cell, to avoid recomputing it for every pixel.
  const cell = [colorAt(bayer, 0, 0), colorAt(bayer, 1, 0), colorAt(bayer, 0, 1), colorAt(bayer, 1, 1)]

  for (let by = 0; by < n; by++) {
    const ya = y0 + Math.floor(by * step)
    const yb = Math.max(ya + 1, y0 + Math.floor((by + 1) * step))
    for (let bx = 0; bx < n; bx++) {
      const xa = x0 + Math.floor(bx * step)
      const xb = Math.max(xa + 1, x0 + Math.floor((bx + 1) * step))
      const o = by * n + bx
      if (withBayer) {
        const sum = [0, 0, 0]
        const tally = [0, 0, 0]
        for (let y = ya; y < yb; y++) {
          const row = y * w
          const even = cell[(y & 1) * 2]
          const odd = cell[(y & 1) * 2 + 1]
          for (let x = xa; x < xb; x++) {
            const c = x & 1 ? odd : even
            sum[c] += data[row + x]
            tally[c]++
          }
        }
        // With single-pixel blocks a color may be missing: green is used.
        const g = tally[1] > 0 ? sum[1] / tally[1] : 0
        outside[o] = tally[0] > 0 ? sum[0] / tally[0] : g
        outside[n * n + o] = g
        outside[2 * n * n + o] = tally[2] > 0 ? sum[2] / tally[2] : g
      } else {
        const planes = channels === 3 ? 3 : 1
        const area = (yb - ya) * (xb - xa)
        for (let c = 0; c < planes; c++) {
          const base = c * plane
          let s = 0
          for (let y = ya; y < yb; y++) {
            const row = base + y * w
            for (let x = xa; x < xb; x++) s += data[row + x]
          }
          outside[c * n * n + o] = s / area
        }
        if (planes === 1) {
          outside[n * n + o] = outside[o]
          outside[2 * n * n + o] = outside[o]
        }
      }
    }
  }

  return { width: n, height: n, channels: 3, data: outside }
}

/**
 * Stretches the reduced version and converts it to RGBA pixels.
 *
 * The stretch is computed channel by channel, so the sky background becomes
 * neutral even on raw data, where the sensor's green dominates, and the
 * thumbnail shows the colors of the object instead of a color cast. The
 * background is brought slightly higher than in the viewer, because on a
 * very small tile a sky that is too dark hides everything.
 */
export function stretchThumbnail(reduced: ImageData32): Thumbnail {
  const n = reduced.width
  const area = n * reduced.height
  const rgba = new Uint8ClampedArray(area * 4)
  for (let c = 0; c < 3; c++) {
    const plane = reduced.data.subarray(c * area, (c + 1) * area)
    const p = autoStretch(
      { width: n, height: reduced.height, channels: 1, data: plane },
      { targetBackground: 0.18 }
    )
    for (let i = 0; i < area; i++) rgba[i * 4 + c] = applyStretchValue(plane[i], p) * 255 + 0.5
  }
  for (let i = 0; i < area; i++) rgba[i * 4 + 3] = 255
  return { side: n, rgba }
}

/**
 * Suppresses the hot pixels left in the reduced version.
 *
 * A hot sensor pixel is lit on a single color and, even diluted in the block
 * average, becomes a red, green or blue dot after stretching: a raw frame can
 * have hundreds of them, covering the object. A star, instead, rises in all
 * three channels. For this reason each channel is allowed to rise above its
 * neighbors by at most as much as the other two do: stars stay, colored dots
 * disappear. Only needed on single frames: stacked images are already free
 * of them.
 */
export function suppressHotPixels(reduced: ImageData32): void {
  const n = reduced.width
  const h = reduced.height
  const area = n * h
  const d = reduced.data
  const medians = new Float32Array(area * 3)
  const window = new Float32Array(9)
  for (let c = 0; c < 3; c++) {
    const base = c * area
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < n; x++) {
        let k = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx < 0 ? 0 : x + dx >= n ? n - 1 : x + dx
            window[k++] = d[base + yy * n + xx]
          }
        }
        window.sort()
        medians[base + y * n + x] = window[4]
      }
    }
  }
  for (let i = 0; i < area; i++) {
    const e0 = d[i] - medians[i]
    const e1 = d[area + i] - medians[area + i]
    const e2 = d[2 * area + i] - medians[2 * area + i]
    const t0 = Math.max(0, e1, e2)
    const t1 = Math.max(0, e0, e2)
    const t2 = Math.max(0, e0, e1)
    if (e0 > t0) d[i] = medians[i] + t0
    if (e1 > t1) d[area + i] = medians[area + i] + t1
    if (e2 > t2) d[2 * area + i] = medians[2 * area + i] + t2
  }
}

/**
 * Complete thumbnail: central square, reduction and stretch.
 *
 * @param singleFrame True for unstacked frames, which may have hot pixels
 * to suppress
 */
export function computeThumbnail(
  image: ImageData32,
  bayer: BayerPattern,
  singleFrame: boolean,
  side = THUMBNAIL_SIDE
): Thumbnail {
  const reduced = reduceCentralSquare(image, bayer, side)
  if (singleFrame) suppressHotPixels(reduced)
  return stretchThumbnail(reduced)
}

/**
 * Thumbnail built from the 8-bit preview embedded in a RAW file (see
 * `readRawPreview`), already decoded to pixels.
 *
 * The part corresponding to the sensor is cropped (4:3 previews of a 3:2
 * sensor have black bands), its central square is taken as for the real
 * data and reduced by block averaging.
 *
 * The preview has already been developed by the camera, with its own colors
 * and brightness curve, and has only 256 levels: stretching it channel by
 * channel like sensor data would magnify those steps (a flat would turn
 * into a purple patch). It is therefore brightened only if dark, such as a
 * night-sky frame, and with the same curve for all three colors.
 *
 * Returns null if the preview is blown out (for example that of a flat,
 * which the camera develops all white): the real data is needed there.
 *
 * @param pixel 8-bit values, `step` per pixel (4 for RGBA, 3 for RGB, 1 for gray)
 * @param aspectRatios Width divided by height of the visible sensor area
 */
export function thumbnailFromPreview(
  pixel: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  step: number,
  aspectRatios: number,
  side = THUMBNAIL_SIDE
): Thumbnail | null {
  const usableW = Math.max(1, Math.min(width, Math.round(height * aspectRatios)))
  const usableH = Math.max(1, Math.min(height, Math.round(width / aspectRatios)))
  const square = Math.min(usableW, usableH)
  const x0 = Math.floor((width - square) / 2)
  const y0 = Math.floor((height - square) / 2)
  const n = Math.max(1, Math.min(side, square))
  const block = square / n
  const area = n * n
  const reduced = new Float32Array(area * 3)
  const colors = step >= 3 ? 3 : 1

  for (let by = 0; by < n; by++) {
    const ya = y0 + Math.floor(by * block)
    const yb = Math.max(ya + 1, y0 + Math.floor((by + 1) * block))
    for (let bx = 0; bx < n; bx++) {
      const xa = x0 + Math.floor(bx * block)
      const xb = Math.max(xa + 1, x0 + Math.floor((bx + 1) * block))
      const tally = (yb - ya) * (xb - xa) * 255
      for (let c = 0; c < colors; c++) {
        let s = 0
        for (let y = ya; y < yb; y++) {
          const row = y * width
          for (let x = xa; x < xb; x++) s += pixel[(row + x) * step + c]
        }
        reduced[c * area + by * n + bx] = s / tally
      }
    }
  }
  if (colors === 1) {
    reduced.copyWithin(area, 0, area)
    reduced.copyWithin(2 * area, 0, area)
  }

  let burnedOut = 0
  for (let i = 0; i < area; i++) {
    if (reduced[i] > 0.97 && reduced[area + i] > 0.97 && reduced[2 * area + i] > 0.97) burnedOut++
  }
  if (burnedOut > area / 2) return null

  // Dark previews (night sky) often have a camera color cast: the background
  // is made neutral by bringing the three colors to the same median, as the
  // per-channel stretch does with real data.
  const image: ImageData32 = { width: n, height: n, channels: 3, data: reduced }
  const p = autoStretch(image, { targetBackground: 0.18 })
  if (p.midtones < 0.5) {
    const medians = [0, 1, 2].map((c) => {
      const v = Array.from(reduced.subarray(c * area, (c + 1) * area)).sort((x, y) => x - y)
      return v[v.length >> 1]
    })
    const reference = medians[1]
    for (let c = 0; c < 3; c++) {
      if (medians[c] <= 0 || reference <= 0) continue
      const f = reference / medians[c]
      for (let i = c * area; i < (c + 1) * area; i++) reduced[i] = Math.min(1, reduced[i] * f)
    }
    Object.assign(p, autoStretch(image, { targetBackground: 0.18 }))
  }
  // Brighten only dark previews: the others are shown as they are.
  const lighten = p.midtones < 0.5
  const rgba = new Uint8ClampedArray(area * 4)
  for (let i = 0; i < area; i++) {
    for (let c = 0; c < 3; c++) {
      const v = reduced[c * area + i]
      rgba[i * 4 + c] = (lighten ? applyStretchValue(v, p) : v) * 255 + 0.5
    }
    rgba[i * 4 + 3] = 255
  }
  return { side: n, rgba, temporary: true }
}
