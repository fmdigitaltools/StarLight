import type { ImageData32 } from '@shared/types'
import { MAD_TO_SIGMA } from './stats'
import { medianAndMad } from './selection'
import { detectStars } from '../stars/detection'
import { toLuminance } from './debayer'
import { takeShared, returnShared } from './parallel'

/**
 * Richardson-Lucy deconvolution.
 *
 * Every star and every detail reaches the sensor scattered by turbulence
 * and by the optics: a point becomes a small blob, always the same across
 * the whole field (the PSF). The stars in the frame are points, so their
 * shape is a direct measurement of the PSF. Knowing it, one can work back,
 * by successive approximations, to the image that blurred this way would
 * give the observed one: this is the Richardson-Lucy method. At each step
 * the estimate is blurred, compared with the data (ratio), and the
 * estimate is corrected with the ratio blurred in turn.
 *
 * Left to itself, the method amplifies noise and creates dark rings
 * around bright stars. For this reason:
 *  - White damping stops the correction where the estimate already
 *    explains the data within the noise, and total-variation
 *    regularization (Dey et al. 2006) restrains the grain without
 *    softening the edges;
 *  - the estimate cannot drop below the local minimum of the observed
 *    image (deringing): the dark ring is precisely a dip deeper than the
 *    sky around it;
 *  - bright stars and saturated cores are protected by a star mask that is
 *    wider the brighter the star is;
 *  - the result is applied only where there is signal: pure sky, which has
 *    nothing to reveal, is left untouched (and not computed).
 *
 * The work is done on the brightness; the correction is carried over to
 * the channels in proportion to the color of each pixel, so the hues stay
 * the same.
 *
 * PSF: Gaussian. It is separable (two passes over rows and columns instead
 * of a full box, much faster) and has shorter tails than a Moffat: if the
 * estimate is slightly wrong the Gaussian corrects less, which is the
 * prudent choice for an automatic operation.
 */

export interface DeconvolutionParams {
  /** Richardson-Lucy steps, 0..50; 0 = no effect. */
  iterations: number
  /** Sigma of the Gaussian PSF in pixels; 0 = automatic estimate from the stars. */
  psfRadius: number
  /** Strength of the noise brake, 0..1. */
  regularization: number
}

export const NEUTRAL_DECONVOLUTION: DeconvolutionParams = {
  iterations: 0,
  psfRadius: 0,
  regularization: 0.5
}

/**
 * Global measurements of the image. When working in strips they must be
 * taken on the whole image and passed to each strip, so that all of them
 * use the same background, the same noise and the same PSF.
 */
export interface DeconvolutionMeasurements {
  /** Sky background level of the brightness. */
  background: number
  /** Sky noise of the brightness. */
  noise: number
  /** Value beyond which a pixel is considered saturated. */
  saturation: number
  /** Noise of the brightness averaged over a few pixels, for the signal mask. */
  meanNoise: number
  /** Sky background of each channel. */
  channelBackgrounds: number[]
  /** PSF sigma in pixels. */
  sigma: number
}

/** Ratio between half-flux radius and sigma for a Gaussian: √(2 ln 2). */
const HFR_TO_SIGMA = Math.sqrt(2 * Math.LN2)

/** The Gaussian PSF is truncated at this multiple of sigma. */
const TRUNCATION = 3

/**
 * Star protection by brightness level: `threshold` in noise units above
 * the surroundings, `radius` of the protected zone in PSF sigmas,
 * `protection` the fraction of correction removed (1 = no correction).
 */
const STAR_LEVELS = [
  { threshold: 10, radius: 1.5, protection: 0.5 },
  { threshold: 60, radius: 3, protection: 0.7 },
  { threshold: 300, radius: 6, protection: 0.9 },
  { threshold: 1500, radius: 10, protection: 1 }
]

export function measureDeconvolution(img: ImageData32, sigma = 0): DeconvolutionMeasurements {
  const n = img.width * img.height
  const y = luminance(img)
  const stats = medianAndMad(y)
  const noise = Math.max(1e-7, stats.mad * MAD_TO_SIGMA)
  let max = 0
  for (let i = 0; i < img.data.length; i++) if (img.data[i] > max) max = img.data[i]
  return {
    background: stats.median,
    noise,
    saturation: max * 0.97,
    meanNoise: Math.max(1e-9, medianAndMad(fastBlur(y, img.width, img.height, 2)).mad * MAD_TO_SIGMA),
    channelBackgrounds: Array.from({ length: img.channels }, (_, k) =>
      img.channels === 1 ? stats.median : medianAndMad(img.data.subarray(k * n, (k + 1) * n)).median
    ),
    sigma: sigma > 0 ? sigma : estimatePsfFrom(img, y, max * 0.97)
  }
}

/**
 * PSF sigma, measured on the stars in the frame.
 *
 * `detectStars` finds the stars and a first half-flux radius, but measures
 * it only on the pixels above the threshold, losing the wings: it is
 * measured again here in a wider aperture, with the local background taken
 * from a ring around the star. Saturated stars (flat core, distorted
 * profile) and those near the edge are discarded; the median over the
 * brightest ones is taken.
 */
export function estimatePsf(img: ImageData32): number {
  let max = 0
  for (let i = 0; i < img.data.length; i++) if (img.data[i] > max) max = img.data[i]
  // The luminances are temporary planes from the pool of parallel.ts.
  const n = img.width * img.height
  const y = img.channels === 1 ? img.data.subarray(0, n) : luminance(img, takeShared(n))
  const detection = img.channels === 1 ? img.data : toLuminance(img, takeShared(n))
  const sigma = estimatePsfFrom(img, y, max * 0.97, detection)
  if (img.channels !== 1) {
    returnShared(y)
    returnShared(detection)
  }
  return sigma
}

function estimatePsfFrom(
  img: ImageData32,
  y: Float32Array,
  saturation: number,
  /** Luminance for the star detection (see `detectStars`), if already computed. */
  detection?: Float32Array
): number {
  const w = img.width
  const h = img.height
  const stars = detectStars(img, { max: 400 }, detection)
  const measurements: number[] = []
  for (const s of stars) {
    if (measurements.length >= 80) break
    if (s.pixel < 5) continue
    const hfr = measureHfr(y, w, h, s.x, s.y, s.hfr, saturation)
    if (hfr > 0) measurements.push(hfr)
  }
  if (measurements.length < 3) return 1.5
  measurements.sort((a, b) => a - b)
  const hfr = measurements[measurements.length >> 1]
  return Math.min(6, Math.max(0.6, hfr / HFR_TO_SIGMA))
}

/** Half-flux radius in an aperture with local background; 0 if the star is unsuitable. */
function measureHfr(
  y: Float32Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  rawHfr: number,
  saturation: number
): number {
  const ra = Math.min(16, Math.max(5, Math.ceil(rawHfr * 3 + 3)))
  const rc = ra + 4
  const cx = Math.round(sx)
  const cy = Math.round(sy)
  if (cx - rc < 0 || cy - rc < 0 || cx + rc >= w || cy + rc >= h) return 0
  const ring: number[] = []
  const points: { d: number; v: number }[] = []
  for (let dy = -rc; dy <= rc; dy++) {
    for (let dx = -rc; dx <= rc; dx++) {
      const v = y[(cy + dy) * w + cx + dx]
      const d2 = dx * dx + dy * dy
      if (d2 <= ra * ra) {
        if (v >= saturation) return 0
        points.push({ d: Math.hypot(cx + dx - sx, cy + dy - sy), v })
      } else if (d2 > (ra + 1) * (ra + 1) && d2 <= rc * rc) ring.push(v)
    }
  }
  ring.sort((a, b) => a - b)
  const background = ring[ring.length >> 1]
  let total = 0
  for (const p of points) {
    p.v -= background
    total += p.v
  }
  if (total <= 0) return 0
  points.sort((a, b) => a.d - b.d)
  const meta = total / 2
  let accumulated = 0
  let dBefore = 0
  for (const p of points) {
    const after = accumulated + p.v
    if (after >= meta && p.v > 0) {
      // Interpolation between the previous radius and this one.
      const t = (meta - accumulated) / p.v
      return Math.max(0.3, dBefore + (p.d - dBefore) * t)
    }
    accumulated = after
    dBefore = p.d
  }
  return 0
}

/**
 * Parameters for the automatic finish: few steps and a firm brake. With
 * stars that are already tight (sigma below one pixel) deconvolution has
 * nothing to recover and risks only grain, so it is skipped.
 */
export function automaticDeconvolution(img: ImageData32): DeconvolutionParams {
  const sigma = estimatePsf(img)
  if (sigma < 0.9) return { ...NEUTRAL_DECONVOLUTION, psfRadius: sigma }
  return { iterations: 10, psfRadius: sigma, regularization: 0.6 }
}

/**
 * Overlap rows for working in strips. Each step widens the zone of
 * influence by two PSF radii, but a Gaussian applied n times widens only
 * as the square root of n: beyond that distance the influence drops below
 * the numeric precision. To this is added the reach of the masks: the
 * protection of the brightest stars (ten sigmas plus the feathered edge)
 * and the averages used to recognize them.
 * Verified on M 27 and M 33: strips and whole image coincide.
 * The global measurements (`measureDeconvolution`) must be taken on the
 * whole image and passed to each strip.
 */
export const DECONVOLUTION_MARGIN = (p: DeconvolutionParams, sigma: number): number => {
  if (p.iterations <= 0) return 0
  const s = Math.max(0.5, sigma)
  const r = Math.ceil(TRUNCATION * s)
  return Math.ceil(2 * r * Math.sqrt(Math.min(50, p.iterations)) + 30 * s) + 20
}

/**
 * Deconvolution of a linear image. Returns a new image; with `iterations`
 * = 0, an identical copy. `measurements` is needed when working in strips
 * (see DECONVOLUTION_MARGIN); otherwise they are measured here.
 *
 * With `inPlace` the result is written into the pixels of `img` instead of
 * a copy. The result is identical, because the final carry-over reads each
 * pixel before rewriting it and nobody touches it before.
 *
 * The work is split in two (see `deconvolveBrightness` and `carryOver`) so
 * that the strip workers can receive only the brightness of their strip,
 * while the image stays with the caller, who carries the result over.
 */
export function deconvolve(
  img: ImageData32,
  p: DeconvolutionParams,
  measurements?: DeconvolutionMeasurements,
  inPlace = false
): ImageData32 {
  const iterations = Math.min(50, Math.max(0, Math.round(p.iterations)))
  const copy: ImageData32 = inPlace ? img : { ...img, data: img.data.slice() }
  if (iterations === 0) return copy
  const w = img.width
  const h = img.height
  const m = measurements ?? measureDeconvolution(img, p.psfRadius)
  const y = deconvolutionLuminance(img)
  const result = deconvolveBrightness(y, saturatedPixels(img, m), w, h, p, m)
  if (result) carryOver(copy.data, img.data, y, result.u, result.weight, m, img.channels, 0, h, w)
  return copy
}

/**
 * Brightness on which deconvolution works: the mean of the channels (the
 * plane itself if there is only one), written into `output` if given.
 */
export function deconvolutionLuminance(img: ImageData32, output?: Float32Array): Float32Array {
  return luminance(img, output)
}

/**
 * Pixels with a channel at the saturation of the measurements: they are
 * protected like the brightest stars (see `weightMask`).
 */
export function saturatedPixels(img: ImageData32, m: DeconvolutionMeasurements): Uint8Array {
  const n = img.width * img.height
  const c = img.channels
  const saturated = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) {
      if (img.data[k * n + i] >= m.saturation) {
        saturated[i] = 1
        break
      }
    }
  }
  return saturated
}

/**
 * Richardson-Lucy on the brightness `y` (see the introduction): returns the
 * deconvolved brightness and the weight with which it replaces the
 * original, or null if there is no signal to work on. `saturated` marks the
 * pixels with a saturated channel (see `saturatedPixels`).
 *
 * Memory: besides `y` it holds four planes (the weight, the estimate, its
 * floor and its blurred version). The data, the starting estimate, is
 * recomputed from `y` where needed instead of being kept; the ratio of each
 * step lives in the array of the blurred estimate (see below); the
 * convolutions and the total variation keep only the few rows they need.
 */
export function deconvolveBrightness(
  y: Float32Array,
  saturated: Uint8Array,
  w: number,
  h: number,
  p: DeconvolutionParams,
  m: DeconvolutionMeasurements
): { u: Float32Array; weight: Float32Array } | null {
  const iterations = Math.min(50, Math.max(0, Math.round(p.iterations)))
  if (iterations === 0) return null
  const n = w * h
  const sigma = p.psfRadius > 0 ? p.psfRadius : m.sigma
  const nucleus = gaussianKernel(sigma)
  const r = (nucleus.length - 1) >> 1
  const reg = Math.min(1, Math.max(0, p.regularization))
  // Weight of the total variation, in noise units: the term moves each
  // pixel by at most a fraction of the noise per step, whatever its
  // brightness.
  const lambda = 0.1 * reg
  // Damping threshold: up to two and a half noise units of difference between estimate and data.
  const threshold = 2.5 * reg * m.noise
  const damping = threshold > 0 ? 1 / (threshold * threshold) : 0

  const weight = weightMask(y, saturated, w, h, m, sigma)

  // Computed only where the result will be used, plus a margin of two PSF
  // radii: on pure sky it would be wasted work. With this margin the
  // difference from computing on the whole image stays below a tenth of
  // the noise (measured on M 27).
  const zone = buildZone(weight, w, h, 2 * r, r)
  if (zone.blank) return null

  // Richardson-Lucy needs positive data: the brightness raised to a
  // minimum, rounded as in a Float32Array. It is also the starting estimate.
  const minimum = Math.max(1e-6, m.noise * 0.01)
  const data = (i: number): number => Math.fround(Math.max(minimum, y[i]))
  const u = new Float32Array(n)
  for (let i = 0; i < n; i++) u[i] = data(i)

  // Floor against rings: the local minimum of the slightly smoothed data,
  // within a radius of two sigmas. The dark ring is a dip deeper than the
  // surrounding sky: this way it does not form.
  const ring = convolutionRing(r, w)
  const floor = u.slice()
  convolve(u, floor, ring, w, nucleus, zone)
  localMinimum(floor, w, h, Math.max(1, Math.round(sigma * 2)), zone, new Float32Array(n))

  // The blurred estimate; between the two convolutions of a step the same
  // array holds the ratio. Outside the work zone the ratio is 1 (the array
  // starts at 1 and is written only inside it), and there nothing else
  // reads the blurred estimate.
  const blurred = new Float32Array(n).fill(1)
  const tv = lambda > 0 ? totalVariation(u, w, h, m.noise, zone) : null
  const { runs } = zone
  /** Multiplicative step of row `y`, with the total-variation term `div` (or null). */
  const update = (y: number, div: Float32Array | null): void => {
    const o = y * w
    const row = runs.v[y]
    for (let q = 0; q < row.length; q += 2) {
      for (let i = o + row[q]; i < o + row[q + 1]; i++) {
        let f = blurred[i]
        if (div) f /= Math.min(2, Math.max(0.5, 1 - (lambda * m.noise * div[i - o]) / u[i]))
        // A step can at most double or halve a value: stability.
        f = Math.min(2, Math.max(0.5, f))
        u[i] = Math.max(floor[i], minimum, u[i] * f)
      }
    }
  }
  for (let k = 0; k < iterations; k++) {
    convolve(u, blurred, ring, w, nucleus, zone)
    forEachRun(runs.v, w, (a, b) => {
      for (let i = a; i < b; i++) {
        const s = Math.max(minimum, blurred[i])
        const d = data(i)
        let q = d / s
        if (damping > 0) {
          // White damping: where the estimate already explains the data
          // within the noise, the ratio is pulled toward 1, and that noise
          // is not chased.
          const e = d - s
          const v = e * e * damping
          if (v < 1) {
            const v2 = v * v
            const v8 = v2 * v2 * v2 * v2
            q = 1 + (q - 1) * v8 * v * (10 - 9 * v)
          }
        }
        blurred[i] = q
      }
    })
    convolve(blurred, blurred, ring, w, nucleus, zone)
    if (tv) {
      // The term of a row reads the estimate on that row and on the two
      // next to it, before this step: it is computed one row ahead of the
      // update, which changes only its own row.
      tv.start()
      for (let y = 0; y < h; y++) {
        if (y + 1 < h) tv.row(y + 1)
        update(y, tv.of(y))
      }
    } else for (let y = 0; y < h; y++) update(y, null)
  }
  return { u, weight }
}

/**
 * Carry-over of the deconvolved brightness to the channels, for the rows
 * from `y0` to `y1` (excluded) of an image `w` wide: where the light above
 * the background is well measured, the change is split among the channels
 * according to their contribution (the color stays); where it is weak, it
 * is added equally to all. `source` holds the channels before deconvolution
 * and `out` receives them after (it may be the same array: each value is
 * read before being rewritten). `y`, `u` and `weight` start at row `y0`.
 */
export function carryOver(
  out: Float32Array,
  source: Float32Array,
  y: Float32Array,
  u: Float32Array,
  weight: Float32Array,
  m: DeconvolutionMeasurements,
  c: number,
  y0: number,
  y1: number,
  w: number
): void {
  const n = source.length / c
  const backgrounds = m.channelBackgrounds
  const count = (y1 - y0) * w
  const o = y0 * w
  for (let q = 0; q < count; q++) {
    const a = weight[q]
    if (a <= 0) continue
    const i = o + q
    const delta = (u[q] - y[q]) * a
    if (c === 1) {
      out[i] = Math.min(1, Math.max(0, y[q] + delta))
      continue
    }
    const excess = y[q] - m.background
    const t = smoothStep(excess / m.noise, 2, 6)
    for (let k = 0; k < c; k++) {
      const j = k * n + i
      const aspectRatio = t > 0 ? Math.min(3, Math.max(0, (source[j] - backgrounds[k]) / excess)) : 1
      const share = t * aspectRatio + (1 - t)
      out[j] = Math.min(1, Math.max(0, source[j] + delta * share))
    }
  }
}

/**
 * Weight with which the result replaces the original: 1 where there is
 * clear signal, 0 on pure sky and on the brightest stars.
 */
function weightMask(
  y: Float32Array,
  saturated: Uint8Array,
  w: number,
  h: number,
  m: DeconvolutionMeasurements,
  sigma: number
): Float32Array {
  const n = w * h
  const scratch = new Float32Array(n)
  // Signal: mean light of the surroundings above the background, measured
  // in units of the noise of the mean itself (in stacks the noise is
  // correlated between neighboring pixels, and averaging reduces it less
  // than theory says).
  const mean = fastBlur(y, w, h, 2, scratch)
  const soft = new Float32Array(n)
  for (let i = 0; i < n; i++) soft[i] = smoothStep((mean[i] - m.background) / m.meanNoise, 2.5, 6)
  // Widened and softened, so the edge of the object is not sharp.
  fastBlurInPlace(soft, w, h, 2, scratch)

  // Bright stars: deconvolution raises their peak a lot and, since the
  // Gaussian PSF lacks the long wings of real stars, it sucks their halo
  // toward the center, leaving a dark ring. As is done by hand with a
  // star mask, they are protected: the effect stays full on nebulae,
  // galaxies and faint stars. The brighter the star, the further its halo
  // extends and the wider the protected zone. A star is light well above
  // the mean of its surroundings; saturated cores (a channel at the
  // maximum) count as the brightest stars. The excess is computed into the
  // array of the surroundings.
  const excess = fastBlur(mean, w, h, Math.max(3, sigma * 3), scratch)
  for (let i = 0; i < n; i++) excess[i] = (mean[i] - excess[i]) / m.noise
  // The array of the mean, no longer needed, receives the feathered discs.
  const feathered = mean
  const protection = new Float32Array(n)
  const cores = new Uint8Array(n)
  for (let l = 0; l < STAR_LEVELS.length; l++) {
    const level = STAR_LEVELS[l]
    const last = l === STAR_LEVELS.length - 1
    cores.fill(0)
    let anyFound = false
    for (let i = 0; i < n; i++) {
      if (excess[i] >= level.threshold || (last && saturated[i] === 1)) {
        cores[i] = 1
        anyFound = true
      }
    }
    if (!anyFound) continue
    const radius = Math.ceil(level.radius * sigma) + 2
    const dilated = dilate(cores, w, h, radius)
    // Feathered edge: full almost to the limit of the disc, then down to zero.
    for (let i = 0; i < n; i++) feathered[i] = dilated[i]
    fastBlurInPlace(feathered, w, h, Math.max(1, radius / 3), scratch)
    for (let i = 0; i < n; i++) {
      const v = level.protection * Math.min(1, feathered[i] * 2)
      if (v > protection[i]) protection[i] = v
    }
  }
  for (let i = 0; i < n; i++) soft[i] *= 1 - protection[i]
  return soft
}

function luminance(img: ImageData32, y: Float32Array = new Float32Array(img.width * img.height)): Float32Array {
  const n = img.width * img.height
  if (img.channels === 1) return img.data.subarray(0, n)
  const d = img.data
  for (let i = 0; i < n; i++) y[i] = (d[i] + d[n + i] + d[2 * n + i]) / 3
  return y
}

function smoothStep(v: number, from: number, a: number): number {
  const t = Math.min(1, Math.max(0, (v - from) / (a - from)))
  return t * t * (3 - 2 * t)
}

/** Normalized 1D Gaussian kernel, truncated at three sigmas. */
function gaussianKernel(sigma: number): Float32Array {
  const s = Math.max(0.3, sigma)
  const r = Math.max(1, Math.ceil(TRUNCATION * s))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * s * s))
    k[i + r] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return k
}

/**
 * Work zone: for each row, the intervals (start, end) to process. `v` are
 * the pixels within `margin` of a pixel with signal; `h` is the same
 * widened by the PSF radius, because the column pass reads the neighboring
 * rows and the total variation reads the adjacent pixel.
 */
interface Zone {
  blank: boolean
  runs: { v: Int32Array[]; h: Int32Array[] }
}

function buildZone(weight: Float32Array, w: number, h: number, margin: number, r: number): Zone {
  const active = new Uint8Array(w * h)
  let blank = true
  for (let i = 0; i < active.length; i++) {
    if (weight[i] > 0.02) {
      active[i] = 1
      blank = false
    }
  }
  const v = dilate(active, w, h, margin)
  const hh = dilate(v, w, h, r + 1)
  return { blank, runs: { v: runsOf(v, w, h), h: runsOf(hh, w, h) } }
}

/** Square dilation of radius d, separable, with running sums. */
function dilate(m: Uint8Array, w: number, h: number, d: number): Uint8Array {
  const t = new Uint8Array(m.length)
  const out = new Uint8Array(m.length)
  const sums = new Int32Array(Math.max(w, h) + 1)
  for (let y = 0; y < h; y++) {
    const o = y * w
    for (let x = 0; x < w; x++) sums[x + 1] = sums[x] + m[o + x]
    for (let x = 0; x < w; x++) t[o + x] = sums[Math.min(w, x + d + 1)] - sums[Math.max(0, x - d)] > 0 ? 1 : 0
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) sums[y + 1] = sums[y] + t[y * w + x]
    for (let y = 0; y < h; y++) out[y * w + x] = sums[Math.min(h, y + d + 1)] - sums[Math.max(0, y - d)] > 0 ? 1 : 0
  }
  return out
}

function runsOf(m: Uint8Array, w: number, h: number): Int32Array[] {
  const runs: Int32Array[] = []
  const intervals: number[] = []
  for (let y = 0; y < h; y++) {
    const o = y * w
    intervals.length = 0
    let x = 0
    while (x < w) {
      if (m[o + x] === 0) {
        x++
        continue
      }
      const start = x
      while (x < w && m[o + x] === 1) x++
      intervals.push(start, x)
    }
    runs.push(Int32Array.from(intervals))
  }
  return runs
}

/** Calls `fn(start, end)` on each row segment of the zone, in linear indices. */
function forEachRun(runs: Int32Array[], w: number, fn: (a: number, b: number) => void): void {
  for (let y = 0; y < runs.length; y++) {
    const c = runs[y]
    const o = y * w
    for (let q = 0; q < c.length; q += 2) fn(o + c[q], o + c[q + 1])
  }
}

/**
 * Separable convolution in the zone: rows first, then columns. At the
 * image edges the last pixel is repeated. The kernel is symmetric: the
 * pixels equidistant from the center are summed in pairs and multiplied
 * once. Columns are done row by row, summing whole shifted rows, so that
 * memory is read in order.
 *
 * The row pass is kept only for the 2r + 1 rows the column pass needs, in
 * `ring` (see `convolutionRing`), and computed just before: a few rows
 * instead of a full plane, with the same values. The column pass of a row
 * reads only rows of the zone widened by the radius, where the row pass
 * has written. `a` may be `from` itself: the row pass reads only rows below
 * those already written.
 */
function convolve(
  from: Float32Array,
  a: Float32Array,
  ring: Float32Array,
  w: number,
  nucleus: Float32Array,
  zone: Zone
): void {
  const h = from.length / w
  const r = (nucleus.length - 1) >> 1
  const c0 = nucleus[r]
  const depth = 2 * r + 1
  const rowPass = (y: number): void => {
    const o = y * w
    const base = (y % depth) * w - o
    const runs = zone.runs.h[y]
    for (let q = 0; q < runs.length; q += 2) {
      for (let i = o + runs[q]; i < o + runs[q + 1]; i++) {
        const x = i - o
        if (x < r || x >= w - r) {
          ring[base + i] = sampleRow(from, o, w, x, nucleus, r)
          continue
        }
        let s = from[i] * c0
        for (let k = 1; k <= r; k++) s += (from[i - k] + from[i + k]) * nucleus[r + k]
        ring[base + i] = s
      }
    }
  }
  let ready = 0
  for (let y = 0; y < h; y++) {
    const last = Math.min(h - 1, y + r)
    while (ready <= last) rowPass(ready++)
    const runs = zone.runs.v[y]
    if (runs.length === 0) continue
    const o = y * w
    const center = (y % depth) * w - o
    for (let q = 0; q < runs.length; q += 2) {
      const ia = o + runs[q]
      const ib = o + runs[q + 1]
      for (let i = ia; i < ib; i++) a[i] = ring[center + i] * c0
      for (let k = 1; k <= r; k++) {
        const from1 = (Math.max(0, y - k) % depth) * w - o
        const from2 = (Math.min(h - 1, y + k) % depth) * w - o
        const weight = nucleus[r + k]
        for (let i = ia; i < ib; i++) a[i] += (ring[from1 + i] + ring[from2 + i]) * weight
      }
    }
  }
}

/** Rows kept by `convolve` for a kernel of radius `r`. */
function convolutionRing(r: number, w: number): Float32Array {
  return new Float32Array((2 * r + 1) * w)
}

function sampleRow(from: Float32Array, o: number, w: number, x: number, nucleus: Float32Array, r: number): number {
  let s = 0
  for (let k = 0; k < nucleus.length; k++) {
    const xx = Math.min(w - 1, Math.max(0, x + k - r))
    s += from[o + xx] * nucleus[k]
  }
  return s
}

/**
 * Divergence of the normalized gradient, the total-variation term:
 * positive in small dips, negative in small peaks. Dividing the step by
 * (1 − λ·div) lowers isolated grains and leaves sharp edges almost
 * intact, where the normalized gradient is uniform. `eps` avoids division
 * by zero and equals the noise: below that slope the gradient is not
 * considered an edge. The term is used multiplied by the noise and divided
 * by the pixel level: this way it moves each pixel by at most a small
 * fraction of the noise per step, stays stable (no checkerboard pattern)
 * and acts the same way in bright and faint areas.
 *
 * It is computed one row at a time, from the top (`start` computes row 0,
 * then `row` each next one) and kept for the last two rows (`of`, indexed
 * by column): the normalized gradient is needed only on the current row
 * and, for its vertical component, on the previous one. Outside the zone
 * rows it stays 0, and nothing reads it there.
 */
interface TotalVariation {
  start: () => void
  row: (y: number) => void
  of: (y: number) => Float32Array
}

function totalVariation(u: Float32Array, w: number, h: number, eps: number, zone: Zone): TotalVariation {
  const e2 = eps * eps
  const last = (h - 1) * w
  const gx = new Float32Array(w)
  let gy = new Float32Array(w)
  let gyBefore = new Float32Array(w)
  const div = [new Float32Array(w), new Float32Array(w)]
  const row = (y: number): void => {
    const o = y * w
    gx.fill(0)
    gy.fill(0)
    const runsH = zone.runs.h[y]
    for (let q = 0; q < runsH.length; q += 2) {
      for (let i = o + runsH[q]; i < o + runsH[q + 1]; i++) {
        const dx = i - o < w - 1 ? u[i + 1] - u[i] : 0
        const dy = i < last ? u[i + w] - u[i] : 0
        const norm = Math.sqrt(dx * dx + dy * dy + e2)
        gx[i - o] = dx / norm
        gy[i - o] = dy / norm
      }
    }
    const d = div[y & 1]
    const runsV = zone.runs.v[y]
    for (let q = 0; q < runsV.length; q += 2) {
      for (let i = o + runsV[q]; i < o + runsV[q + 1]; i++) {
        const x = i - o
        const ax = i > o ? gx[x - 1] : 0
        const ay = i >= w ? gyBefore[x] : 0
        d[x] = gx[x] - ax + gy[x] - ay
      }
    }
    const t = gyBefore
    gyBefore = gy
    gy = t
  }
  return { start: () => row(0), row, of: (y) => div[y & 1] }
}

/**
 * Minimum in a square of side 2r+1, separable, computed only in the work
 * zone (outside it the starting value is kept). The result replaces `p`;
 * `t` is a scratch array of the same length.
 */
function localMinimum(p: Float32Array, w: number, h: number, r: number, zone: Zone, t: Float32Array): void {
  t.set(p)
  forEachRun(zone.runs.h, w, (ia, ib) => {
    const o = ia - (ia % w)
    for (let i = ia; i < ib; i++) {
      const a = Math.max(o, i - r)
      const b = Math.min(o + w - 1, i + r)
      let e = p[a]
      for (let j = a + 1; j <= b; j++) if (p[j] < e) e = p[j]
      t[i] = e
    }
  })
  // The column pass reads only `t`: it can write into `p`.
  forEachRun(zone.runs.v, w, (ia, ib) => {
    const y = (ia / w) | 0
    const a = (Math.max(0, y - r) - y) * w
    const b = (Math.min(h - 1, y + r) - y) * w
    for (let i = ia; i < ib; i++) {
      let e = t[i + a]
      for (let j = a + w; j <= b; j += w) if (t[i + j] < e) e = t[i + j]
      p[i] = e
    }
  })
}

/**
 * Approximate Gaussian blur with three moving averages, like `blur` in
 * cleanup.ts, but with the column pass done row by row (one accumulator
 * per column): memory is read in order, which is much faster on large
 * images. Returns a new array; `scratch`, if given, is used for the
 * intermediate passes.
 */
function fastBlur(p: Float32Array, w: number, h: number, radius: number, scratch?: Float32Array): Float32Array {
  return fastBlurInPlace(p.slice(), w, h, radius, scratch)
}

/** Like `fastBlur`, with the same result, written into `a` itself. */
function fastBlurInPlace(
  a: Float32Array,
  w: number,
  h: number,
  radius: number,
  scratch?: Float32Array
): Float32Array {
  const r = Math.max(1, Math.round(radius))
  const b = scratch ?? new Float32Array(a.length)
  const sums = new Float64Array(w)
  const norm = 1 / (2 * r + 1)
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const o = y * w
      let s = 0
      for (let x = -r; x <= r; x++) s += a[o + Math.min(w - 1, Math.max(0, x))]
      for (let x = 0; x < w; x++) {
        b[o + x] = s * norm
        s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]
      }
    }
    sums.fill(0)
    for (let y = -r; y <= r; y++) {
      const q = Math.min(h - 1, Math.max(0, y)) * w
      for (let x = 0; x < w; x++) sums[x] += b[q + x]
    }
    for (let y = 0; y < h; y++) {
      const o = y * w
      const more = Math.min(h - 1, y + r + 1) * w
      const minus = Math.max(0, y - r) * w
      for (let x = 0; x < w; x++) {
        a[o + x] = sums[x] * norm
        sums[x] += b[more + x] - b[minus + x]
      }
    }
  }
  return a
}
