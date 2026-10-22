import type { ImageData32 } from '@shared/types'
import { computeStats } from './stats'
import { toLuminance } from './debayer'

/**
 * Histogram stretch.
 *
 * A raw frame straight from the telescope is linear: the deep-sky signal
 * occupies a tiny fraction of the scale and the image looks black. The
 * stretch redistributes the levels to make faint detail visible without
 * burning out bright stars.
 */

export interface StretchParams {
  /** Black point: everything below it becomes black. */
  shadows: number
  /** Midtones position: low values brighten faint detail strongly. */
  midtones: number
  /** White point: everything above it becomes white. */
  highlights: number
}

export const NEUTRAL_STRETCH: StretchParams = { shadows: 0, midtones: 0.5, highlights: 1 }

/**
 * Midtones transfer function (MTF): with m = 0.5 it is linear, below 0.5 it
 * brightens.
 */
export function mtf(x: number, m: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m <= 0) return 1
  if (m >= 1) return 0
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

/** Applies black point, midtones and white point to a single value. */
export function applyStretchValue(v: number, p: StretchParams): number {
  const range = p.highlights - p.shadows
  if (range <= 0) return v <= p.shadows ? 0 : 1
  let x = (v - p.shadows) / range
  if (x < 0) x = 0
  else if (x > 1) x = 1
  return mtf(x, p.midtones)
}

/**
 * Computes the stretch parameters automatically from the image statistics,
 * with the classic autostretch criterion: the black point is placed just
 * below the sky background and the midtones are moved so that the
 * background lands at a reference brightness.
 */
export function autoStretch(
  image: ImageData32,
  options: { targetBackground?: number; shadowsClipping?: number; highlights?: number } = {}
): StretchParams {
  /*
   * Level to which the sky background is brought.
   *
   * The usual reference value of 0.25 is meant for a manual finishing
   * pass. Applied directly it produces a light grey background and
   * amplifies the noise more than twenty times, giving a washed-out,
   * grainy result. A lower value keeps the sky dark, as expected of an
   * astronomical photograph, while the faint signal stays visible.
   */
  const targetBackground = options.targetBackground ?? 0.15
  // Number of deviations below the median beyond which the signal is only noise.
  const shadowsClipping = options.shadowsClipping ?? -2.8

  const lum = toLuminance(image)
  const stats = computeStats(lum)
  const sigma = stats.mad * 1.4826

  let shadows = sigma > 0 ? stats.median + shadowsClipping * sigma : stats.min
  if (shadows < 0) shadows = 0
  if (shadows >= stats.median) shadows = Math.max(0, stats.median * 0.5)

  // White point: normally the maximum; the automatic finish lowers it onto
  // the brightest parts of the object to use the whole scale.
  const highlights = Math.min(1, Math.max(shadows + 1e-4, options.highlights ?? 1))

  // Median remapped to the range between the black point and the white point.
  const normalizedMedian = (stats.median - shadows) / Math.max(1e-6, highlights - shadows)

  // Inverse MTF: find m such that mtf(normalizedMedian, m) = target.
  const midtones = solveMidtones(normalizedMedian, targetBackground)

  // The lower limit must stay very low: the darkest stacks request
  // midtones around 0.002, and a minimum of 0.005 would clamp the stretch
  // and make the three levels equal.
  return {
    shadows,
    midtones: Math.min(0.95, Math.max(0.0005, midtones)),
    highlights
  }
}

/**
 * Finds by bisection the midtones value that brings level x to the
 * desired brightness. Forty iterations give far more precision than a
 * display curve needs.
 */
function solveMidtones(x: number, target: number): number {
  if (x <= 0) return 0.5
  if (x >= 1) return 0.5
  let lo = 0.0001
  let hi = 0.9999
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) * 0.5
    // The MTF is monotonically decreasing in m.
    if (mtf(x, mid) > target) lo = mid
    else hi = mid
  }
  return (lo + hi) * 0.5
}

/** 16384-entry lookup table, to apply the curve without recomputation. */
export function buildStretchLut(p: StretchParams, size = 16384): Float32Array {
  const lut = new Float32Array(size)
  const last = size - 1
  for (let i = 0; i < size; i++) lut[i] = applyStretchValue(i / last, p)
  return lut
}

/** Applies the stretch to all channels, returning a new image. */
export function applyStretch(image: ImageData32, p: StretchParams): ImageData32 {
  const lut = buildStretchLut(p)
  const last = lut.length - 1
  const out = new Float32Array(image.data.length)
  for (let i = 0; i < image.data.length; i++) {
    const v = image.data[i]
    out[i] = lut[Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * last)]
  }
  return { ...image, data: out }
}

/**
 * Inverse hyperbolic (asinh) stretch: compresses the highlights more
 * gently than the MTF and preserves the color of bright stars.
 */
export function asinhStretch(image: ImageData32, intensity: number, blackPoint: number): ImageData32 {
  const out = new Float32Array(image.data.length)
  // Intensity 0-1 mapped to a factor of 1-1000 on an exponential scale.
  const factor = Math.pow(10, intensity * 3)
  const norm = Math.asinh(factor)
  const span = Math.max(1e-6, 1 - blackPoint)

  for (let i = 0; i < image.data.length; i++) {
    let v = (image.data[i] - blackPoint) / span
    if (v < 0) v = 0
    const s = Math.asinh(v * factor) / norm
    out[i] = s > 1 ? 1 : s
  }

  return { ...image, data: out }
}
