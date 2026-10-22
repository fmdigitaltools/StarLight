import type { ImageData32 } from '@shared/types'
import { computeStats, MAD_TO_SIGMA } from './stats'
import { toLuminance } from './debayer'
import { mtf, type StretchParams } from './stretch'
import type { CurvePoint } from './curve'
import { blur } from './cleanup'

/**
 * Automatic finish: the rendering values that the automatic pass sets
 * after cleanup, all measured on the image.
 *
 * The goal is the look of published astronomical images: dark but not
 * pure-black sky, an object that uses the whole tonal scale up to white,
 * firm midtone contrast and full color without tinting the background.
 */

export interface Finish {
  stretch: StretchParams
  /** Contrast curve on the luminosity, calibrated on the sky level. */
  lightCurve: CurvePoint[]
  saturation: number
  /** Sky level after the stretch, for the report. */
  background: number
}

/** Level to which the sky is brought: dark, but with the faint signal visible. */
const TARGET_BACKGROUND = 0.04

/** Desired mean color on the object, as the difference between the maximum and minimum channel. */
const TARGET_CHROMA = 0.2

/** Minimum desired level for the body of the object: arms, nebulosity. */
const TARGET_BODY = 0.22

/** Desired level for the brightest part of the object. */
const TARGET_OBJECT = 0.92

export function computeFinish(image: ImageData32): Finish {
  const lum = toLuminance(image)
  const stats = computeStats(lum)
  const sigma = stats.mad * MAD_TO_SIGMA

  /*
   * Stretch with two targets, calibrated on a published reference image:
   * the sky at TARGET_BACKGROUND and the brightest part of the object at
   * TARGET_OBJECT. The object level is measured on a blurred version of
   * the image, where the point-like stars are diluted and the extended
   * structures remain: it is the level exceeded by 0.5% of those pixels,
   * the center of a nebula or the bright parts of a galaxy. The brightest
   * stars go beyond it and turn white. With the black point fixed, the
   * white point is found by bisection such that, with the midtones that
   * bring the sky to its target level, the object reaches its own.
   */
  const w = image.width
  const h = image.height
  const extended = blur(lum, w, h, Math.max(4, Math.min(w, h) / 150))
  const sortedItems = sample(extended, 400000).sort()
  const object = sortedItems[Math.floor(sortedItems.length * 0.9995)]
  const shadows = Math.max(0, stats.median - 3.5 * sigma)
  const midtonesFor = (highlights: number): number => {
    const x = (stats.median - shadows) / Math.max(1e-9, highlights - shadows)
    return findMidtones(x, TARGET_BACKGROUND)
  }
  const objectLevelFor = (highlights: number): number =>
    mtf(
      Math.min(1, Math.max(0, (object - shadows) / Math.max(1e-9, highlights - shadows))),
      midtonesFor(highlights)
    )
  let bottom = Math.max(object, stats.median + 10 * sigma)
  let top = 1
  for (let i = 0; i < 40; i++) {
    const mid = (bottom + top) / 2
    // Raising the white point darkens the object.
    if (objectLevelFor(mid) > TARGET_OBJECT) bottom = mid
    else top = mid
  }
  const highlights = (bottom + top) / 2
  const stretch: StretchParams = {
    shadows,
    midtones: Math.min(0.95, Math.max(0.0005, midtonesFor(highlights))),
    highlights
  }

  /*
   * Tone curve adapted to the object.
   *
   * Below the sky level it darkens slightly, so the background is cleaned
   * up without turning black. Above it, it lifts the body of the object:
   * the position, after the stretch, of the median of the extended-signal
   * pixels (the arms of a galaxy, the nebulosity) is measured and brought
   * to at least TARGET_BODY. An already bright object such as a planetary
   * nebula is left alone; a faint, large galaxy is lifted until its arms
   * read well. Near white the curve returns to the diagonal so as not to
   * burn the core.
   */
  const extendedStats = computeStats(extended)
  const extendedSigma = Math.max(1e-9, extendedStats.mad * MAD_TO_SIGMA)
  const bodyThreshold = extendedStats.median + 5 * extendedSigma
  const body: number[] = []
  const step = Math.max(1, Math.floor(extended.length / 400000))
  for (let i = 0; i < extended.length; i += step) if (extended[i] > bodyThreshold) body.push(extended[i])
  body.sort((p, q) => p - q)
  const f = TARGET_BACKGROUND
  let xBody = 0.3
  if (body.length > 100) {
    const v = body[body.length >> 1]
    const interval = Math.max(1e-9, stretch.highlights - stretch.shadows)
    xBody = mtf(Math.min(1, Math.max(0, (v - stretch.shadows) / interval)), stretch.midtones)
  }
  xBody = Math.min(0.6, Math.max(f * 1.5, xBody))
  const yBody = Math.max(xBody * 1.1, Math.min(0.75, TARGET_BODY))
  const lightCurve: CurvePoint[] = [
    { x: 0, y: 0 },
    { x: f * 0.5, y: f * 0.4 },
    { x: f, y: f * 0.9 },
    { x: xBody, y: yBody },
    // Above the body the curve rises more steeply, so the core stays
    // distinct from the arms instead of flattening to the same brightness.
    { x: (xBody + 1) / 2, y: Math.min(0.9, (yBody + 1) / 2 + 0.12) },
    { x: 1, y: 1 }
  ]

  /*
   * Saturation: the amount of color the object has after the stretch is
   * measured and brought to a fixed level. An already vivid image receives
   * little, a dull one a lot; the sky does not enter the measurement.
   */
  const chroma = objectChroma(image, stretch, stats.median + 8 * sigma)
  // Never goes below zero: removing color from the whole image to calm
  // the most colorful part would dull the fainter regions.
  const saturation =
    chroma > 1e-4 ? Math.min(0.6, Math.max(0, TARGET_CHROMA / chroma - 1)) : 0.2

  return { stretch, lightCurve, saturation, background: TARGET_BACKGROUND }
}

function sample(data: Float32Array, max: number): Float32Array {
  const step = Math.max(1, Math.floor(data.length / max))
  const out = new Float32Array(Math.floor(data.length / step))
  for (let i = 0; i < out.length; i++) out[i] = data[i * step]
  return out
}

/**
 * Mean color of the signal pixels, measured on the values stretched with
 * the same color-preserving stretch used by the automatic finish.
 */
function objectChroma(image: ImageData32, stretch: StretchParams, threshold: number): number {
  if (image.channels !== 3) return 0
  const n = image.width * image.height
  const d = image.data
  const step = Math.max(1, Math.floor(n / 300000))
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i += step) {
    const r = d[i]
    const g = d[n + i]
    const b = d[2 * n + i]
    if ((r + g + b) / 3 < threshold) continue
    const interval = Math.max(1e-6, stretch.highlights - stretch.shadows)
    const rl = Math.max(0, (r - stretch.shadows) / interval)
    const gl = Math.max(0, (g - stretch.shadows) / interval)
    const bl = Math.max(0, (b - stretch.shadows) / interval)
    const l = (rl + gl + bl) / 3
    if (l <= 1e-6) continue
    let k = mtf(Math.min(l, 1), stretch.midtones) / l
    const max = Math.max(rl, gl, bl) * k
    if (max > 1) k /= max
    // Same brightness mask as the stretch.
    const ld = (rl + gl + bl) * k / 3
    const t = Math.min(1, Math.max(0, (ld - 0.02) / 0.04))
    const ms = t * t * (3 - 2 * t)
    const rs = ld + (rl * k - ld) * ms
    const gs = ld + (gl * k - ld) * ms
    const bs = ld + (bl * k - ld) * ms
    // Saturated stars are white by nature: they do not count.
    if (rs > 0.97 && gs > 0.97 && bs > 0.97) continue
    sum += Math.max(rs, gs, bs) - Math.min(rs, gs, bs)
    count++
  }
  return count > 50 ? sum / count : 0
}

/** Midtones that bring level x to the desired level, by bisection. */
function findMidtones(x: number, desired: number): number {
  if (x <= 0 || x >= 1) return 0.5
  let lo = 0.0001
  let hi = 0.9999
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2
    if (mtf(x, m) > desired) lo = m
    else hi = m
  }
  return (lo + hi) / 2
}
