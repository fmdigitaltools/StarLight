import type { BayerPattern, ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { sharedFloat32 } from '@shared/sharedMemory'
import { colorAt } from '../image/debayer'
import { invert, scale } from './alignment'
import { isCompact, rebuildRegion } from './compactFrame'
import {
  normalizationCoefficients,
  stackBand,
  type FrameToStack,
  type RejectionMap,
  type StackingOptions
} from './stacking'

/**
 * Drizzle: sum of the frames onto a finer grid.
 *
 * Normal stacking brings each frame back onto the grid of the reference
 * and samples it halfway between pixels: the sub-pixel shift between one
 * exposure and the next is thus smoothed away. Drizzle does the opposite:
 * it treats each pixel of the frame as a small square "drop", moves it
 * where the alignment says it should land and deposits it onto a grid
 * twice as fine, splitting its value among the fine pixels it touches in
 * proportion to the area covered. Since the frames land each time at a
 * slightly different point, the drops of different exposures fill the
 * gaps between the original pixels, and the detail that the sensor had
 * actually recorded becomes visible again.
 *
 * The drop is smaller than the pixel (the drop shrinking factor, called
 * pixfrac): the smaller it is, the sharper the result, but more frames are
 * needed for every fine pixel to receive something. At 1 the drop is as
 * large as the pixel and the result resembles a soft enlargement; at 0.5
 * it is sharp but, with few frames, noisy and full of holes.
 *
 * The drop is treated as a square aligned to the grid even when the
 * frame is rotated: with rotations of a few degrees between one exposure
 * and the next the error is negligible and the computation of the covered
 * area stays simple and fast.
 *
 * Outlier rejection cannot be done as in normal stacking, because here
 * the frames are never compared pixel by pixel on the same grid. The usual
 * strategy is followed: first a normal stack provides, for every pixel of
 * the reference, the central value and the maximum allowed distance; then
 * every pixel of every frame is compared with that reference, and the
 * anomalous ones (satellite trails, cosmic rays) are not deposited.
 *
 * BAYER DRIZZLE
 *
 * With a colour sensor each pixel measures a single colour, according to
 * the Bayer pattern declared in the header; the other two are invented by
 * demosaicing, which interpolates them from the neighbours. That
 * interpolation softens the stars and leaves coloured fringes on their
 * edges, and normal drizzle inherits them, because it deposits pixels that
 * are already demosaiced.
 *
 * Bayer drizzle instead deposits only the value actually measured: each
 * drop ends up in the plane of its own colour only (red, green or blue),
 * with weights and coverage kept per channel. It is the small shifts
 * between one exposure and the next that make a red pixel land, frame
 * after frame, where there was a green one before: colour is reconstructed
 * with real data instead of interpolated data. It already works at a 1×
 * grid, where the gain is mostly in colour, and at 2× it adds resolution.
 *
 * The raw data does not need to be kept separately: the bilinear
 * interpolation of `debayer` leaves the measured colour intact in every
 * pixel, and calibration works pixel by pixel, so it is enough to read the
 * right plane of the colour image for each pixel.
 *
 * Pixels with little coverage in a channel. Without dithering, or with few
 * frames, some fine pixels may receive few drops of a colour (red and blue
 * each cover a quarter of the sensor). There the value is completed with
 * normal stacking, that is with the interpolation from the neighbours done
 * by demosaicing, but with a weight that decreases as real data arrives: a
 * pixel that has received at least what a whole frame would bring on
 * average uses only its own drops; one that has received half takes half
 * of the missing weight from normal stacking; an empty one takes all of
 * it. This way no holes or coloured dots remain, and where data is
 * plentiful nothing of the sharpness is lost.
 *
 * The price is noise. The demosaicing and the resampling of normal
 * stacking also act as a slight blur, which smooths the noise together
 * with the stars; Bayer drizzle smooths nothing, and each fine pixel
 * receives on average a quarter (red, blue) or half (green) of the drops.
 * In tests the pixel-to-pixel noise is about double and, over scales of a
 * few pixels, 20-30% higher: a few tens of frames are needed for the gain
 * in sharpness and colour to prevail.
 */

export interface DrizzleOptions {
  /** Magnification of the grid: at 1 and without Bayer drizzle it is off. */
  factor: 1 | 2
  /** Side of the drop relative to the pixel, between 0.5 and 1. */
  pixfrac: number
  /**
   * Deposits the raw pixels of the sensor each in its own colour.
   * Only valid for raw frames with a Bayer pattern; it also works at 1×.
   */
  bayer?: boolean
}

/** True if the options ask for a drizzle of some kind. */
export function isDrizzleActive(d: DrizzleOptions | undefined): d is DrizzleOptions {
  return d !== undefined && (d.factor > 1 || d.bayer === true)
}

/** Part of the sensor occupied by each colour in the Bayer pattern. */
const BAYER_SHARE = [0.25, 0.5, 0.25]

export interface DrizzleBandParams {
  frame: FrameToStack[]
  factor: number
  pixfrac: number
  /**
   * Present in Bayer drizzle: the pattern with which the (already
   * demosaiced) frames were recorded. Each pixel deposits only the
   * colour that the sensor measured there.
   */
  bayerPattern?: BayerPattern
  /** Maps of normal stacking for the rejection; absent with the mean. */
  rejection?: RejectionMap
  /**
   * Normal stacking, on the grid of the reference: fills the fine pixels
   * on which no drop landed.
   */
  reserve: Float32Array
  /** Rows of the fine grid to compute. */
  yStart: number
  yEnd: number
  /** Result on the fine grid (width × height × channels). */
  output: Float32Array
  /** Weight collected by each fine pixel, mean of the channels. */
  coverage: Float32Array
}

export interface DrizzleBandResult {
  /** Sum of the weights collected by the pixels of the band, all channels. */
  totalWeight: number
  rejectedValues: number
  /** Fine pixels without any drop, filled by normal stacking. */
  blanks: number
}

export interface DrizzleResult {
  image: ImageData32
  /** Weight collected by each fine pixel (width × height of the fine grid). */
  coverage: Float32Array
  /** Mean weight per fine pixel, divided by that of a whole frame. */
  meanContribution: number
  rejectedValues: number
  /** Fraction of the fine pixels left without data. */
  emptyFraction: number
}

/** How many bytes drizzle needs beyond the frames already in memory. */
export function drizzleMemory(
  width: number,
  height: number,
  channels: number,
  factor: number,
  withRejection: boolean,
  compactItems = false
): number {
  const n = width * height
  const end = n * factor * factor
  // Fine output, coverage, and the temporary sums and weights of the bands
  // (in double precision), fallback stack and rejection maps; with compact
  // frames also the pieces reconstructed by the bands, which together
  // amount to about one whole frame.
  return (
    end * channels * 4 +
    end * 4 +
    end * channels * 16 +
    n * channels * 4 +
    (withRejection ? n * channels * 8 : 0) +
    (compactItems ? n * channels * 4 : 0)
  )
}

/**
 * Computes a band of rows of the fine grid.
 *
 * Each band scans the pixels of all the frames whose drops can land in
 * its rows and writes only those: bands do not touch each other and can
 * be handed to different workers without locks.
 */
export function drizzleBand(p: DrizzleBandParams): DrizzleBandResult {
  const { frame, output, coverage, reserve, rejection } = p
  if (frame.length === 0) throw new Error(t('coreDrizzle.noFrames'))

  const first = frame[0].image
  const w = first.width
  const h = first.height
  const channels = first.channels
  const s = p.factor
  const W = w * s
  const H = h * s
  const N = W * H
  const refCount = w * h

  const yStart = Math.max(0, p.yStart)
  const yEnd = Math.min(H, p.yEnd)
  if (yEnd <= yStart) return { totalWeight: 0, rejectedValues: 0, blanks: 0 }
  const rows = yEnd - yStart

  // Local sums and weights of the band, in double precision: a fine pixel
  // receives contributions from hundreds of drops.
  const sums = new Float64Array(rows * W * channels)
  const weights = new Float64Array(rows * W * channels)

  let rejected = 0
  const pixfrac = Math.min(1, Math.max(0.1, p.pixfrac))

  // Bayer drizzle: only with colour frames and a real pattern.
  const schema = channels === 3 && p.bayerPattern && p.bayerPattern !== 'NONE' ? p.bayerPattern : null
  // Weight that a fine pixel receives on average from a whole frame, for
  // each channel: below this threshold Bayer drizzle completes the value
  // with normal stacking (see the comment at the top of the file). In normal
  // drizzle the threshold is zero: the fallback is used only if no drop
  // has landed.
  let meanFrameWeight = 0
  for (const fr of frame) meanFrameWeight += fr.weight
  meanFrameWeight /= frame.length
  const thresholds = [0, 0, 0]
  if (schema) {
    for (let c = 0; c < 3; c++) thresholds[c] = BAYER_SHARE[c] * pixfrac * pixfrac * meanFrameWeight
  }

  // Rows of the reference (continuous coordinates) in which the centre of a
  // drop must land to touch the band, with a pixel of margin.
  // Night normalisation (see nights.ts): the same as in the normal sum, so
  // that the comparison with the rejection map is homogeneous.
  const norm = normalizationCoefficients(frame, channels)

  const vMin = yStart / s - 0.5 - 1.5
  const vMax = yEnd / s - 0.5 + 1.5

  // Reconstructed piece of the compact frames (see `compactFrame.ts`), one
  // at a time: the frames are scanned one after the other.
  let piece = new Float32Array(0)

  for (let f = 0; f < frame.length; f++) {
    const fr = frame[f]
    const t = fr.transformation
    const inv = invert(t)
    const wf = fr.image.width
    const hf = fr.image.height
    const frameWeight = fr.weight
    // Half side of the drop on the fine grid.
    const halfSide = (pixfrac * scale(t) * s) / 2

    // Rectangle of the frame that can fall in the band: the four corners of
    // the reference strip are mapped onto the frame.
    let iMin = Infinity
    let iMax = -Infinity
    let jMin = Infinity
    let jMax = -Infinity
    const angles = [
      [-1.5, vMin],
      [w + 0.5, vMin],
      [-1.5, vMax],
      [w + 0.5, vMax]
    ]
    for (const [u, v] of angles) {
      const x = inv.a * u - inv.b * v + inv.tx
      const y = inv.b * u + inv.a * v + inv.ty
      if (x < iMin) iMin = x
      if (x > iMax) iMax = x
      if (y < jMin) jMin = y
      if (y > jMax) jMax = y
    }
    const i0 = Math.max(0, Math.floor(iMin))
    const i1 = Math.min(wf - 1, Math.ceil(iMax))
    const j0 = Math.max(0, Math.floor(jMin))
    const j1 = Math.min(hf - 1, Math.ceil(jMax))
    if (i1 < i0 || j1 < j0) continue

    // Pixel (i, j) of the frame is at plane[base + (j - oy) · step + i - ox],
    // with base = channel · area: the whole plane or the reconstructed piece.
    let plane: Float32Array
    let ox = 0
    let oy = 0
    let step = wf
    let area = wf * hf
    const im = fr.image
    if (isCompact(im)) {
      // The comparison with normal stacking also reads around the point
      // mapped onto the frame: a few pixels of margin, more if the frame
      // has finer pixels than the reference.
      const margin = 3 + Math.ceil(1 / Math.max(0.05, scale(t)))
      ox = Math.max(0, i0 - margin)
      oy = Math.max(0, j0 - margin)
      step = Math.min(wf, i1 + 1 + margin) - ox
      area = step * (Math.min(hf, j1 + 1 + margin) - oy)
      if (piece.length < area * channels) piece = new Float32Array(area * channels)
      rebuildRegion(im, ox, oy, ox + step, oy + area / step, piece)
      plane = piece
    } else {
      plane = im.data
    }

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        // Centre of the drop on the reference and then on the fine grid,
        // where pixel X covers the interval [X - 0.5, X + 0.5].
        const u = t.a * i - t.b * j + t.tx
        const v = t.b * i + t.a * j + t.ty
        if (v < vMin || v > vMax) continue
        const cx = (u + 0.5) * s - 0.5
        const cy = (v + 0.5) * s - 0.5

        const xa = cx - halfSide
        const xb = cx + halfSide
        const ya = cy - halfSide
        const yb = cy + halfSide
        let X0 = Math.floor(xa + 0.5)
        let X1 = Math.floor(xb + 0.5)
        let Y0 = Math.floor(ya + 0.5)
        let Y1 = Math.floor(yb + 0.5)
        if (X0 < 0) X0 = 0
        if (X1 > W - 1) X1 = W - 1
        if (Y0 < yStart) Y0 = yStart
        if (Y1 > yEnd - 1) Y1 = yEnd - 1
        if (X1 < X0 || Y1 < Y0) continue

        // Reference pixel closest to the centre of the drop, for the
        // comparison with normal stacking.
        let pRef = -1
        let sxR = 0
        let syR = 0
        if (rejection) {
          const pu = Math.round(u)
          const pv = Math.round(v)
          if (pu >= 0 && pv >= 0 && pu < w && pv < h) {
            pRef = pv * w + pu
            // The value that normal stacking read from this frame at that
            // pixel, interpolated in the same way.
            sxR = inv.a * pu - inv.b * pv + inv.tx
            syR = inv.b * pu + inv.a * pv + inv.ty
          }
        }

        // In Bayer drizzle the pixel carries a single colour: the measured one.
        const colorOnly = schema ? colorAt(schema, i, j) : -1

        for (let c = 0; c < channels; c++) {
          if (colorOnly >= 0 && c !== colorOnly) continue
          const base = (channels === 3 ? c : 0) * area - ox
          const raw = plane[base + (j - oy) * step + i]
          const kN = norm ? norm.scale[f * channels + c] : 1
          const oN = norm ? norm.shift[f * channels + c] : 0
          const value = norm ? raw * kN + oN : raw

          if (pRef >= 0 && rejection) {
            const limit = rejection.limit[c * refCount + pRef]
            if (limit < Infinity) {
              const rawRead = bilinear(plane, base, wf, hf, sxR, syR, step, oy)
              const readResult = norm ? rawRead * kN + oN : rawRead
              const d = readResult - rejection.center[c * refCount + pRef]
              if ((d < 0 ? -d : d) > limit) {
                rejected++
                continue
              }
            }
          }

          const bandBase = c * rows * W
          for (let Y = Y0; Y <= Y1; Y++) {
            const oy = Math.min(yb, Y + 0.5) - Math.max(ya, Y - 0.5)
            if (oy <= 0) continue
            const row = bandBase + (Y - yStart) * W
            for (let X = X0; X <= X1; X++) {
              const ox = Math.min(xb, X + 0.5) - Math.max(xa, X - 0.5)
              if (ox <= 0) continue
              const weight = ox * oy * frameWeight
              sums[row + X] += value * weight
              weights[row + X] += weight
            }
          }
        }
      }
    }
  }

  // Normalisation: each fine pixel is the weighted mean of the drops that
  // touched it, so it stays on the same scale as the frames.
  let totalWeight = 0
  let blanks = 0
  for (let Y = yStart; Y < yEnd; Y++) {
    for (let X = 0; X < W; X++) {
      let pixelWeight = 0
      let empty = false
      for (let c = 0; c < channels; c++) {
        const k = c * rows * W + (Y - yStart) * W + X
        const pc = weights[k]
        pixelWeight += pc
        const threshold = thresholds[c]
        let value: number
        if (pc > 1e-9 && pc >= threshold) {
          value = sums[k] / pc
        } else {
          // No drop, or few in Bayer drizzle: normal stacking, enlarged,
          // covers the weight missing from the threshold.
          const r = bilinear(reserve, c * refCount, w, h, (X + 0.5) / s - 0.5, (Y + 0.5) / s - 0.5)
          if (pc > 1e-9) {
            value = (sums[k] + r * (threshold - pc)) / threshold
          } else {
            value = r
            empty = true
          }
        }
        output[c * N + Y * W + X] = value < 0 ? 0 : value > 1 ? 1 : value
      }
      if (empty) blanks++
      // In Bayer drizzle each drop goes into a single channel: the coverage
      // is the sum of the channels, so it stays comparable with that of
      // normal drizzle (a whole frame is worth pixfrac² in both).
      coverage[Y * W + X] = schema ? pixelWeight : pixelWeight / channels
      totalWeight += pixelWeight
    }
  }

  return { totalWeight, rejectedValues: rejected, blanks }
}

/**
 * Bilinear interpolation of a plane, with the edges held fixed. With a
 * piece of the plane, `step` is its width and `oy` its first row; the
 * starting column must be subtracted from `base`.
 */
function bilinear(
  plane: Float32Array,
  base: number,
  w: number,
  h: number,
  x: number,
  y: number,
  step = w,
  oy = 0
): number {
  if (x < 0) x = 0
  else if (x > w - 1) x = w - 1
  if (y < 0) y = 0
  else if (y > h - 1) y = h - 1
  const x0 = x | 0
  const y0 = y | 0
  const x1 = x0 + 1 < w ? x0 + 1 : x0
  const y1 = y0 + 1 < h ? y0 + 1 : y0
  const fx = x - x0
  const fy = y - y0
  const r0 = base + (y0 - oy) * step
  const r1 = base + (y1 - oy) * step
  const top = plane[r0 + x0] + (plane[r0 + x1] - plane[r0 + x0]) * fx
  const bottom = plane[r1 + x0] + (plane[r1 + x1] - plane[r1 + x0]) * fx
  return top + (bottom - top) * fy
}

/** True if the chosen method rejects outliers. */
export function withRejection(options: StackingOptions): boolean {
  return options.method !== 'mean'
}

/**
 * Complete drizzle on a single thread: reference normal stacking and then
 * deposit of the drops. Used as a fallback and by the tests.
 */
export function drizzle(
  frame: FrameToStack[],
  options: StackingOptions,
  drizzleOpts: DrizzleOptions,
  bayerPattern?: BayerPattern
): DrizzleResult {
  if (frame.length === 0) throw new Error(t('coreDrizzle.noFrames'))
  const first = frame[0].image
  const w = first.width
  const h = first.height
  const channels = first.channels
  const s = drizzleOpts.factor

  const reserve = sharedFloat32(w * h * channels)
  const rejection: RejectionMap | undefined = withRejection(options)
    ? { center: sharedFloat32(w * h * channels), limit: sharedFloat32(w * h * channels) }
    : undefined
  stackBand({ frame, options, yStart: 0, yEnd: h, output: reserve, rejectionMap: rejection })

  const W = w * s
  const H = h * s
  const output = sharedFloat32(W * H * channels)
  const coverage = sharedFloat32(W * H)
  const result = drizzleBand({
    frame,
    factor: s,
    pixfrac: drizzleOpts.pixfrac,
    bayerPattern,
    rejection,
    reserve,
    yStart: 0,
    yEnd: H,
    output,
    coverage
  })

  return {
    image: { width: W, height: H, channels: channels, data: output },
    coverage,
    meanContribution: meanContribution(result.totalWeight, W * H, channels, frame, drizzleOpts, bayerPattern),
    rejectedValues: result.rejectedValues,
    emptyFraction: result.blanks / (W * H)
  }
}

/**
 * How many frames contributed, on average, to each fine pixel. In normal
 * drizzle each drop weighs on all channels, in Bayer drizzle on a single
 * one: the collected weight is therefore divided differently so that the
 * number stays the same for the same frames.
 */
export function meanContribution(
  totalWeight: number,
  finePixels: number,
  channels: number,
  frame: FrameToStack[],
  d: DrizzleOptions,
  bayerPattern?: BayerPattern
): number {
  const perPixel = bayerPattern && bayerPattern !== 'NONE' && channels === 3 ? finePixels : finePixels * channels
  return totalWeight / perPixel / fullDropWeight(frame, d)
}

/**
 * Weight that a fine pixel would receive on average from a single frame of
 * weight one: used to express coverage as "how many frames, on average".
 */
export function fullDropWeight(frame: FrameToStack[], d: DrizzleOptions): number {
  const pf = Math.min(1, Math.max(0.1, d.pixfrac))
  // A drop covers (pixfrac × factor)² fine pixels and each pixel of the
  // frame corresponds to factor² fine pixels: on average pixfrac² per frame.
  let meanWeight = 0
  for (const f of frame) meanWeight += f.weight
  meanWeight /= frame.length
  return pf * pf * meanWeight
}
