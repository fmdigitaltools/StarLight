import type { ImageData32 } from '@shared/types'
import { MAD_TO_SIGMA } from './stats'
import { mtf } from './stretch'
import { blurInPlace } from './cleanup'
import { kth, medianAndMad } from './selection'
import { sharedValue, takeShared, returnShared, reducePlane } from './parallel'

/**
 * CLAHE local contrast (contrast-limited adaptive histogram equalization),
 * adapted to linear astronomical data.
 *
 * Equalization only makes sense on a stretched image: on linear data almost
 * all pixels sit at the bottom of the scale. The luminance is therefore
 * stretched internally, equalized by tiles and then brought back to the
 * linear domain with the inverse curve. Only the resulting difference in
 * light is added to (or removed from) the image, with the color the object
 * has at that point: the color does not change.
 *
 * Three safeguards compared with classic CLAHE, which would do damage on a
 * photo of the sky:
 * - histograms count only signal pixels (above the sky) and not stars: a
 *   tile of pure sky stays identical instead of being brightened to gray,
 *   and background noise is not inflated;
 * - each tile's curve is computed on a smooth, star-free version of the
 *   luminance and applied as added light, not as a slope: fine detail (and
 *   grain) keeps its original contrast, while medium-scale structures such
 *   as the arms of a galaxy emerge;
 * - stars and sky are protected by soft masks, so no halos appear around
 *   stars and no steps at the edge of the object.
 */

export interface LocalContrastParams {
  /** Strength of the effect, from 0 (none) to 1. */
  strength: number
  /** Histogram clip limit, from 1 (almost none) to 4 (strong). */
  limit: number
  /** Tiles along the short side of the image, from 4 to 16. */
  boxes: number
}

export const NEUTRAL_LOCAL_CONTRAST: LocalContrastParams = {
  strength: 0,
  limit: 2,
  boxes: 8
}

/** Level to which the internal stretch brings the sky background. */
const STRETCHED_BACKGROUND = 0.1
/** Histogram levels of each tile. */
const LEVELS = 512

/** What needs to be known about the stretched luminance, computed once. */
interface Analysis {
  w: number
  h: number
  /** Stretched luminance, smooth and star-free: the shapes of the object. */
  shapes: Float32Array
  /** Weight of the effect at each pixel: 0 on the sky and on stars. */
  weight: Float32Array
  /** Threshold (in the stretched domain) below which there is only sky. */
  threshold: number
  black: number
  midtones: number
  /** Fraction of pixels occupied by extended signal, stars excluded. */
  signalFraction: number
  /** Median of the linear luminance. */
  lumMedian: number
  /** Noise of the linear luminance (sky). */
  linearSigma: number
}

function luminance(img: ImageData32, l: Float32Array = new Float32Array(img.width * img.height)): Float32Array {
  const n = img.width * img.height
  if (img.channels === 1) return img.data
  const d = img.data
  for (let i = 0; i < n; i++) l[i] = 0.2126 * d[i] + 0.7152 * d[n + i] + 0.0722 * d[2 * n + i]
  return l
}

/** Finds by bisection the midtones that bring x to the desired level. */
function solveMidtones(x: number, target: number): number {
  if (x <= 0 || x >= 1) return 0.5
  let lo = 0.00001
  let hi = 0.99999
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) * 0.5
    if (mtf(x, m) > target) lo = m
    else hi = m
  }
  return (lo + hi) * 0.5
}

function step(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Noise of a plane measured on the differences between pixels at distance
 * `jump` along the row: gradients and the object almost cancel out, leaving
 * the spread due to grain (already reduced by the blur).
 */
function differenceNoise(p: Float32Array, n: number, jump: number): number {
  const sampleStep = Math.max(1, Math.floor(n / 200000))
  const count = Math.floor((n - jump) / sampleStep)
  const differences = new Float32Array(count)
  for (let k = 0; k < count; k++) {
    const i = k * sampleStep
    differences[k] = p[i] - p[i + jump]
  }
  const sd = medianAndMad(differences)
  return Math.max(1e-5, (sd.mad * MAD_TO_SIGMA) / Math.SQRT2)
}

/**
 * A plane blurred at reduced resolution (see `reducedBlur`), read back at
 * full resolution with bilinear interpolation, row by row (`row`) or pixel
 * by pixel (`at`). The values are those that the enlargement in parallel.ts
 * would store in a full plane, which is never built: on large images each
 * would weigh hundreds of megabytes.
 */
interface Smooth {
  /** Writes row `y` into `out` (`w` values). */
  row: (y: number, out: Float32Array) => Float32Array
  /** Value at pixel `i`. */
  at: (i: number) => number
  /** Gives back to the pool of parallel.ts the reduced plane: the version can no longer be read. */
  release: () => void
}

function smoothPlane(values: Float32Array, w: number, wr: number, hr: number, factor: number): Smooth {
  // Positions and weights along the row are the same for all rows.
  const column0 = new Int32Array(w)
  const column1 = new Int32Array(w)
  const weightX = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    let gx = (x + 0.5) / factor - 0.5
    if (gx < 0) gx = 0
    if (gx > wr - 1) gx = wr - 1
    const x0 = Math.floor(gx)
    column0[x] = x0
    column1[x] = Math.min(wr - 1, x0 + 1)
    weightX[x] = gx - x0
  }
  /** Bilinear value at column `x` between reduced rows `r0` and `r1`, as in `upscaleRows`. */
  const value = (r0: number, r1: number, fy: number, x: number): number => {
    const x0 = column0[x]
    const x1 = column1[x]
    const fx = weightX[x]
    const top = values[r0 + x0] + (values[r0 + x1] - values[r0 + x0]) * fx
    const bottom = values[r1 + x0] + (values[r1 + x1] - values[r1 + x0]) * fx
    return top + (bottom - top) * fy
  }
  const rowOf = (y: number): [number, number, number] => {
    let gy = (y + 0.5) / factor - 0.5
    if (gy < 0) gy = 0
    if (gy > hr - 1) gy = hr - 1
    const row0 = Math.floor(gy)
    const row1 = Math.min(hr - 1, row0 + 1)
    return [row0 * wr, row1 * wr, gy - row0]
  }
  return {
    row: (y, out) => {
      const [r0, r1, fy] = rowOf(y)
      for (let x = 0; x < w; x++) out[x] = value(r0, r1, fy, x)
      return out
    },
    at: (i) => {
      const y = Math.floor(i / w)
      const [r0, r1, fy] = rowOf(y)
      return Math.fround(value(r0, r1, fy, i - y * w))
    },
    release: () => returnShared(values)
  }
}

/**
 * Wide blur computed on a copy reduced by `factor` and brought back to full
 * resolution with bilinear interpolation (see `Smooth`). For very smooth
 * versions the result is indistinguishable from the full one and costs a
 * fraction of the time.
 */
function reducedBlur(p: Float32Array, w: number, h: number, radius: number, factor: number): Smooth {
  const wr = Math.max(1, Math.floor(w / factor))
  const hr = Math.max(1, Math.floor(h / factor))
  // Reduction and blur are split across threads when there is an executor
  // (see parallel.ts): same result. The shared scratch arrays go back to the
  // pool as soon as they are done.
  const source = sharedValue(p)
  const reduced = takeShared(wr * hr)
  reducePlane(source, reduced, w, wr, hr, factor)
  if (source !== p) returnShared(source)
  // The reduced plane, from the pool, becomes the blurred one: whoever reads
  // the smooth version gives it back (`release`).
  blurInPlace(reduced, wr, hr, Math.max(1, radius / factor))
  return smoothPlane(reduced, w, wr, hr, factor)
}

/** Blurred copy of `p` in a temporary plane from the pool of parallel.ts. */
function blurredCopy(p: Float32Array, w: number, h: number, radius: number): Float32Array {
  const t = takeShared(p.length)
  t.set(p)
  return blurInPlace(t, w, h, radius)
}

/** Approximate percentile over a regular sample of the pixels. */
function percentile(p: Float32Array, q: number): number {
  return percentileOf(p.length, (i) => p[i], q)
}

/** Like `percentile`, on `n` values read with `value`. */
function percentileOf(n: number, value: (i: number) => number, q: number): number {
  const sampleStep = Math.max(1, Math.floor(n / 200000))
  const sample = new Float32Array(Math.floor(n / sampleStep))
  for (let k = 0; k < sample.length; k++) sample[k] = value(k * sampleStep)
  return kth(sample, Math.min(sample.length - 1, Math.floor(q * sample.length)))
}

/*
 * Memory: the analysis needs many smooth versions of the luminance. Each is
 * dropped, or its array reused for the next one, as soon as it is no longer
 * needed, and the very smooth ones stay at reduced resolution (see
 * `Smooth`): at most three full planes are alive at once. Every value is
 * computed with the same operations as when each version had its own plane.
 */
function analyze(img: ImageData32): Analysis {
  const w = img.width
  const h = img.height
  const n = w * h
  // The full planes here are temporary ones from the pool of parallel.ts:
  // the luminance and the masks are given back at the end, the shapes and
  // the weight by whoever uses the analysis.
  let lum: Float32Array | null = img.channels === 1 ? img.data : luminance(img, takeShared(n))

  // Internal stretch: black point slightly below the sky, midtones chosen so
  // the sky reaches STRETCHED_BACKGROUND.
  const st = medianAndMad(lum)
  const sigma = Math.max(1e-7, st.mad * MAD_TO_SIGMA)
  let black = st.median - 2.8 * sigma
  if (black < 0) black = 0
  if (black >= st.median) black = st.median * 0.5
  const midtones = Math.min(0.95, Math.max(0.00005, solveMidtones((st.median - black) / (1 - black), STRETCHED_BACKGROUND)))

  const smoothed = takeShared(n)
  const scale = 1 / (1 - black)
  for (let i = 0; i < n; i++) smoothed[i] = mtf((lum[i] - black) * scale, midtones)
  if (lum !== img.data) returnShared(lum)
  lum = null

  // Moderate blur: the curve is computed on the shapes, not on the grain.
  blurInPlace(smoothed, w, h, 2)
  // Very smooth version (`around`): reference for recognizing stars and
  // first estimate of the sky. Its array then receives the star mask.
  const stars = blurredCopy(smoothed, w, h, 5)

  // The noise of the moderate version is measured on the differences between
  // pixels at a distance beyond the blur's reach: the overall spread would
  // include gradients and the object.
  const sigmaL = differenceNoise(smoothed, n, 6)

  // Level and spread of the sky in the very smooth version, derived from the
  // low tail of the distribution (5th and 30th percentile): the upper part
  // includes the object, and in a nebula that fills the field the median is
  // already nebula. For a normal distribution there are 1.12 deviations
  // between the two percentiles.
  const p05 = percentile(stars, 0.05)
  const p30 = percentile(stars, 0.3)
  const sigmaM = Math.max(1e-5, (p30 - p05) / 1.121)
  const background = p30 + 0.524 * sigmaM
  const threshold = Math.min(0.9, background + 2 * sigmaM)

  // Stars: pixels much brighter than their surroundings. The comparison is
  // relative to the local level, so filaments and arms (which stand out only
  // slightly) are not mistaken for stars, while a star stands out by many
  // times even inside a nebula.
  // Bright stars are wider than their surroundings and themselves raise the
  // reference term: they need a much larger neighborhood, against which they
  // stand out by several times their own level (the core of a galaxy or the
  // interior of a bright nebula stands out by barely a tenth).
  const far = reducedBlur(smoothed, w, h, 20, 4)
  const row = new Float32Array(w)
  const row2 = new Float32Array(w)
  for (let y = 0; y < h; y++) {
    far.row(y, row)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const around = stars[i]
      const overshoot = smoothed[i] - around
      let s = 0
      if (overshoot > 4 * sigmaL) {
        const base = Math.max(0, around - background) + 3 * sigmaL
        s = step(0.4, 1.2, overshoot / base)
      }
      const farOvershoot = smoothed[i] - row[x]
      if (farOvershoot > 10 * sigmaL) {
        const base = Math.max(0, row[x] - background) + 3 * sigmaL
        s = Math.max(s, step(1.2, 2.5, farOvershoot / base))
      }
      stars[i] = Math.min(1, 4 * s)
    }
  }
  far.release()
  // The mask widens and softens: it also covers the star's halo, which would
  // otherwise be brightened as if it were nebulosity.
  const wideStars = blurredCopy(stars, w, h, 4)
  // Bright stars have a halo much wider than the core: a second mask, wide
  // and proportional to the core's light, covers all of it. A faint star
  // weighs little here and does not switch off the nebula around it; a bright
  // one brings along a circle of a few tens of pixels. The cores are
  // computed into the array of the star mask, which is no longer needed.
  const cores = stars
  for (let i = 0; i < n; i++) cores[i] = stars[i] > 0 ? stars[i] * Math.max(0, smoothed[i] - background) : 0
  const halos = reducedBlur(cores, w, h, 12, 2)
  for (let y = 0; y < h; y++) {
    halos.row(y, row)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      wideStars[i] = Math.max(Math.min(1, wideStars[i] * 3), step(0.004, 0.02, row[x]))
    }
  }
  halos.release()

  // Version WITHOUT stars: where there is a star, the level of the
  // surroundings is used, obtained from a weighted mean that ignores star
  // pixels. It serves twice. To decide where there is signal: the faint
  // parts of a galaxy are below the single-pixel noise but emerge when
  // averaged over a few tens of pixels, and the light of an isolated star
  // must not suggest nebulosity around it. And to compute the curve on the
  // shapes of the object: faint stars that escaped the mask would otherwise
  // be brightened as small lumps of nebula. The star-free weight
  // (`1 - wideStars`, rounded as in a plane) and the weighted value go
  // through the array of the cores, then the version without stars.
  const buffer = cores
  for (let i = 0; i < n; i++) buffer[i] = smoothed[i] * Math.fround(1 - wideStars[i])
  const numerator = reducedBlur(buffer, w, h, 8, 2)
  for (let i = 0; i < n; i++) buffer[i] = 1 - wideStars[i]
  const denominator = reducedBlur(buffer, w, h, 8, 2)
  const withoutStars = buffer
  for (let y = 0; y < h; y++) {
    numerator.row(y, row)
    denominator.row(y, row2)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const s = wideStars[i]
      const surroundings = row2[x] > 0.05 ? row[x] / row2[x] : Math.min(smoothed[i], background)
      withoutStars[i] = smoothed[i] * (1 - s) + Math.min(smoothed[i], surroundings) * s
    }
  }
  numerator.release()
  denominator.release()
  // Shapes of the object: smooth enough to contain neither grain nor stars,
  // detailed enough to follow arms and filaments.
  const shapes = blurInPlace(withoutStars, w, h, 5)

  // Where there is signal is decided on an even wider scale: at the scale of
  // the shapes, the faint parts of a nebula are patchy, mixed with noise
  // clumps, and a mask taken there would switch the effect on in blotches.
  // Here the mask is soft and follows the extent of the object.
  const wide = reducedBlur(shapes, w, h, 16, 4)
  const a05 = percentileOf(n, wide.at, 0.05)
  const a30 = percentileOf(n, wide.at, 0.3)
  const sigmaA = Math.max(1e-5, (a30 - a05) / 1.121)
  const backgroundA = a30 + 0.524 * sigmaA
  const startA = backgroundA + 1.5 * sigmaA
  const filledAt = backgroundA + 5 * sigmaA

  // The weight takes the array of the moderate version, no longer needed.
  const weight = smoothed
  let signal = 0
  for (let y = 0; y < h; y++) {
    wide.row(y, row)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const sky = step(startA, filledAt, row[x])
      weight[i] = sky * (1 - wideStars[i])
      if (weight[i] > 0.5) signal++
    }
  }
  wide.release()
  returnShared(wideStars)

  return {
    w,
    h,
    shapes,
    weight,
    threshold,
    black,
    midtones,
    signalFraction: signal / n,
    lumMedian: st.median,
    linearSigma: sigma
  }
}

/**
 * Equalization curve of a tile. Below the sky threshold the curve is the
 * identity; above it, it redistributes the signal levels within the same
 * interval [threshold, 1]. A uniform "prior" background added to the
 * histogram keeps a tile with few signal pixels almost unchanged instead of
 * being distorted by a handful of values.
 */
function boxCurve(
  shapes: Float32Array,
  weight: Float32Array,
  w: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  threshold: number,
  limit: number
): Float32Array {
  const first = Math.min(LEVELS - 1, Math.floor(threshold * LEVELS))
  const nb = LEVELS - first
  const isto = new Float64Array(nb)
  for (let y = y0; y < y1; y++) {
    const o = y * w
    for (let x = x0; x < x1; x++) {
      const i = o + x
      if (weight[i] < 0.5) continue
      let b = Math.floor(shapes[i] * LEVELS) - first
      if (b < 0) continue
      if (b >= nb) b = nb - 1
      isto[b]++
    }
  }
  const area = (x1 - x0) * (y1 - y0)
  const priors = (0.04 * area) / nb
  let total = 0
  for (let b = 0; b < nb; b++) {
    isto[b] += priors
    total += isto[b]
  }
  // Clipping: no level may exceed `limit` times the mean. The excess is
  // redistributed uniformly; repeating a couple of times, the ceiling is
  // respected almost exactly.
  const cap = (limit * total) / nb
  for (let pass = 0; pass < 3; pass++) {
    let excess = 0
    for (let b = 0; b < nb; b++) {
      if (isto[b] > cap) {
        excess += isto[b] - cap
        isto[b] = cap
      }
    }
    if (excess <= 0) break
    const share = excess / nb
    for (let b = 0; b < nb; b++) isto[b] += share
  }

  // Curve at the level edges: LEVELS + 1 values, identity below the threshold.
  const curve = new Float32Array(LEVELS + 1)
  for (let b = 0; b <= first; b++) curve[b] = b / LEVELS
  const start = first / LEVELS
  let sum = 0
  for (let b = 0; b < nb; b++) {
    sum += isto[b]
    curve[first + b + 1] = start + ((1 - start) * sum) / total
  }
  return curve
}

function readCurve(curve: Float32Array, v: number): number {
  const t = v * LEVELS
  if (t <= 0) return curve[0]
  if (t >= LEVELS) return curve[LEVELS]
  const i = Math.floor(t)
  const f = t - i
  return curve[i] + (curve[i + 1] - curve[i]) * f
}

export function localContrast(
  img: ImageData32,
  p: LocalContrastParams,
  /**
   * If true, the result is written into the pixels of `img` (each value
   * depends only on the pixel at the same position and on measurements taken
   * before): the processing chain uses it on images that belong to it alone.
   */
  inPlace = false
): ImageData32 {
  const strength = Math.min(1, Math.max(0, p.strength))
  if (strength <= 0) return inPlace ? img : { ...img, data: img.data.slice() }
  const limit = Math.min(4, Math.max(1, p.limit))
  const boxes = Math.round(Math.min(16, Math.max(4, p.boxes)))

  const a = analyze(img)
  const { w, h, shapes, weight } = a
  const n = w * h

  // Grid of square tiles: `tiles` along the short side.
  const side = Math.min(w, h) / boxes
  const nx = Math.max(1, Math.round(w / side))
  const ny = Math.max(1, Math.round(h / side))
  const curves: Float32Array[] = []
  for (let ty = 0; ty < ny; ty++) {
    const y0 = Math.floor((ty * h) / ny)
    const y1 = Math.floor(((ty + 1) * h) / ny)
    for (let tx = 0; tx < nx; tx++) {
      const x0 = Math.floor((tx * w) / nx)
      const x1 = Math.floor(((tx + 1) * w) / nx)
      curves.push(boxCurve(shapes, weight, w, x0, x1, y0, y1, a.threshold, limit))
    }
  }

  // The added (or removed) light is computed on the smooth version: in the
  // stretched domain the curve moves the shapes by "new - v"; brought back to
  // the linear domain, this becomes an amount of light that varies only at
  // the scale of the shapes. Added to the image, it does not touch grain or
  // fine detail: a ratio computed pixel by pixel, instead, would multiply the
  // noise and leave dark dots where the noisy pixel is almost black.
  const inverted = 1 - a.midtones
  // The light takes the array of the shapes: each value is read before
  // being replaced.
  const light = shapes
  const stepX = w / nx
  const stepY = h / ny
  for (let y = 0; y < h; y++) {
    let gy = (y + 0.5) / stepY - 0.5
    if (gy < 0) gy = 0
    if (gy > ny - 1) gy = ny - 1
    const ty0 = Math.floor(gy)
    const ty1 = Math.min(ny - 1, ty0 + 1)
    const fy = gy - ty0
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const pe = weight[i]
      if (pe <= 0) {
        light[i] = 0
        continue
      }
      let gx = (x + 0.5) / stepX - 0.5
      if (gx < 0) gx = 0
      if (gx > nx - 1) gx = nx - 1
      const tx0 = Math.floor(gx)
      const tx1 = Math.min(nx - 1, tx0 + 1)
      const fx = gx - tx0
      const v = shapes[i]
      const a00 = readCurve(curves[ty0 * nx + tx0], v)
      const a01 = readCurve(curves[ty0 * nx + tx1], v)
      const a10 = readCurve(curves[ty1 * nx + tx0], v)
      const a11 = readCurve(curves[ty1 * nx + tx1], v)
      const newValue = (a00 * (1 - fx) + a01 * fx) * (1 - fy) + (a10 * (1 - fx) + a11 * fx) * fy
      let boost = newValue - v
      // In already bright areas, brightening consumes only a fraction of the
      // remaining headroom: near white the inverse curve is very steep and a
      // small push would burn the center of a bright nebula, erasing its
      // detail and color.
      if (boost > 0) boost = Math.min(boost, 0.35 * (1 - v))
      let v2 = v + pe * boost
      if (v2 < 0) v2 = 0
      else if (v2 > 1) v2 = 1
      light[i] = strength * (1 - a.black) * (mtf(v2, inverted) - mtf(v, inverted))
    }
  }

  // Color of the added light: that of the object at that point, measured on
  // smooth versions of the channels (net of each channel's black level), so
  // the color stays unchanged and no gray is added to a red nebula. Where the
  // signal is too weak to measure it, the sky color is used.
  const c = img.channels
  const d = img.data
  const out = inPlace ? d : new Float32Array(img.data.length)
  if (c === 1) {
    for (let i = 0; i < n; i++) {
      const v = d[i] + light[i]
      out[i] = v > 1 ? 1 : v < 0 ? 0 : v
    }
    returnShared(shapes)
    returnShared(weight)
    return { ...img, data: out }
  }
  const lumWeights = [0.2126, 0.7152, 0.0722]
  const channelBlack: number[] = []
  const skyColor: number[] = []
  for (let k = 0; k < 3; k++) {
    const mk = percentile(d.subarray(k * n, (k + 1) * n), 0.5)
    skyColor.push(a.lumMedian > 1e-7 ? mk / a.lumMedian : 1)
    channelBlack.push(a.black * skyColor[k])
  }
  // The excess light of the luminance (recomputed from the channels, with
  // the same rounding) and of each channel go one after the other through
  // the array of the weight, no longer needed; their smooth versions stay at
  // reduced resolution (see `Smooth`).
  const buffer = weight
  for (let i = 0; i < n; i++) {
    buffer[i] = Math.max(0, Math.fround(0.2126 * d[i] + 0.7152 * d[n + i] + 0.0722 * d[2 * n + i]) - a.black)
  }
  const smoothExcess = reducedBlur(buffer, w, h, 4, 2)
  const smoothChannels: Smooth[] = []
  for (let k = 0; k < 3; k++) {
    const o = k * n
    for (let i = 0; i < n; i++) buffer[i] = Math.max(0, d[o + i] - channelBlack[k])
    smoothChannels.push(reducedBlur(buffer, w, h, 4, 2))
  }
  const excessRow = new Float32Array(w)
  const channelRows = [new Float32Array(w), new Float32Array(w), new Float32Array(w)]
  // Below this light (in linear units) the local color is just noise.
  const minimum = Math.max(1e-6, a.linearSigma * 2)
  for (let i = 0; i < n; i++) {
    const x = i % w
    if (x === 0) {
      const y = (i - x) / w
      smoothExcess.row(y, excessRow)
      for (let k = 0; k < 3; k++) smoothChannels[k].row(y, channelRows[k])
    }
    const l = light[i]
    if (l === 0) {
      out[i] = d[i]
      out[n + i] = d[n + i]
      out[2 * n + i] = d[2 * n + i]
      continue
    }
    const el = excessRow[x]
    // Blend between object color and sky color according to how reliable
    // the local signal is.
    const confidence = step(minimum, minimum * 4, el)
    let q0 = skyColor[0]
    let q1 = skyColor[1]
    let q2 = skyColor[2]
    if (confidence > 0) {
      const r0 = channelRows[0][x]
      const r1 = channelRows[1][x]
      const r2 = channelRows[2][x]
      const lumR = lumWeights[0] * r0 + lumWeights[1] * r1 + lumWeights[2] * r2
      if (lumR > 1e-9) {
        q0 += confidence * (r0 / lumR - q0)
        q1 += confidence * (r1 / lumR - q1)
        q2 += confidence * (r2 / lumR - q2)
      }
    }
    const v0 = d[i] + l * q0
    const v1 = d[n + i] + l * q1
    const v2 = d[2 * n + i] + l * q2
    out[i] = v0 > 1 ? 1 : v0 < 0 ? 0 : v0
    out[n + i] = v1 > 1 ? 1 : v1 < 0 ? 0 : v1
    out[2 * n + i] = v2 > 1 ? 1 : v2 < 0 ? 0 : v2
  }
  smoothExcess.release()
  for (const smooth of smoothChannels) smooth.release()
  returnShared(shapes)
  returnShared(weight)
  return { ...img, data: out }
}

/**
 * Parameters for Abracadabra. The effect grows with the area occupied by the
 * object: a galaxy that fills the field benefits from it, a small object in
 * a star field hardly at all (equalizing a few hundred pixels only produces
 * artifacts). The strength stays moderate: equalization brings the light of
 * the core closer to that of the arms, and with Abracadabra's stretch a
 * doubled strength would turn the galaxy into a uniform blotch.
 */
export function automaticLocalContrast(img: ImageData32): LocalContrastParams {
  // Measuring the area only needs the half-size image: it costs a quarter.
  const half = halve(img)
  const a = analyze(half)
  const f = a.signalFraction
  returnShared(a.shapes)
  returnShared(a.weight)
  returnShared(half.data)
  const strength = 0.25 * step(0.03, 0.3, f)
  return { strength: Math.round(strength * 100) / 100, limit: 2, boxes: 8 }
}

/** Image reduced to half per side, averaging each group of 2x2 pixels. */
function halve(img: ImageData32): ImageData32 {
  const w = Math.floor(img.width / 2)
  const h = Math.floor(img.height / 2)
  const n0 = img.width * img.height
  const n = w * h
  // A temporary array from the pool of parallel.ts (see `automaticLocalContrast`).
  const data = takeShared(n * img.channels)
  for (let k = 0; k < img.channels; k++) {
    for (let y = 0; y < h; y++) {
      const r0 = k * n0 + 2 * y * img.width
      const r1 = r0 + img.width
      for (let x = 0; x < w; x++) {
        data[k * n + y * w + x] = 0.25 * (img.data[r0 + 2 * x] + img.data[r0 + 2 * x + 1] + img.data[r1 + 2 * x] + img.data[r1 + 2 * x + 1])
      }
    }
  }
  return { width: w, height: h, channels: img.channels, data }
}
