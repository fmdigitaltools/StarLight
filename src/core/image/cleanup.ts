import type { ImageData32 } from '@shared/types'
import { MAD_TO_SIGMA } from './stats'
import { detectStars, type Star } from '../stars/detection'
import { kth, medianAndMad } from './selection'
import { blurMovingAverage, blurMovingAverageInPlace, takeShared, returnShared } from './parallel'
import { toLuminance } from './debayer'

/**
 * Automatic cleanup of a linear astronomical image.
 *
 * These are the corrections an astrophotographer performs before the
 * stretch, in the order they are performed: hot pixels, sky background
 * extraction, color and brightness noise reduction. Each step measures the
 * image instead of using fixed values, and returns a new image: the
 * original is never modified.
 */

export interface CleanupOptions {
  /** Correction of isolated anomalous pixels in each channel. */
  hotPixels: boolean
  /** Subtraction of the modeled sky background, which makes it uniform and neutral. */
  background: boolean
  /** Color smoothing, from 0 to 1: removes the colored grain. */
  colorNoise: number
  /**
   * If true, only the star parts of the color correction remain (spots of
   * impossible color and star tint), without smoothing the colored grain.
   * Needed by narrowband: the smoothing leaves the details to the
   * brightness alone, which with the dual-band filter is almost all
   * H-alpha, and green and blue would copy its structure (see
   * extractBands in narrowband.ts).
   */
  onlyStarColor?: boolean
  /** Brightness smoothing on the sky only, from 0 to 1. */
  lightNoise: number
  /** White balance measured on the stars. */
  balanceStars: boolean
  /** Sharpness on the signal only, from 0 to 1, dosed on the star size. */
  sharpness: number
}

export const FULL_CLEANUP: CleanupOptions = {
  hotPixels: true,
  background: true,
  colorNoise: 1,
  lightNoise: 0.6,
  balanceStars: true,
  sharpness: 1
}

/** What was done, with the measured numbers: feeds the report. */
export interface CleanupResult {
  image: ImageData32
  correctedPixels: number
  /** Range of the background before correction, as a percentage of the level. */
  backgroundUnevenness: number
  /** Color imbalance of the background before correction, as a percentage. */
  backgroundColorCast: number
  /** Sky noise before and after, in units of the linear data. */
  noiseBefore: number
  noiseAfter: number
  /** Gains applied to the three channels so that the stars come out white. */
  starGains: [number, number, number]
  /** Typical half-flux radius of the stars, in pixels: measures sharpness. */
  hfr: number
  /** Edges poorly covered by the stack, as fractions of the side. */
  edges: { left: number; rightSide: number; top: number; bottom: number }
}

export function clean(
  source: ImageData32,
  options: CleanupOptions = FULL_CLEANUP,
  /**
   * If true, the result is written into the pixels of `source` instead of a
   * copy: the processing chain uses it on images that belong to it alone,
   * saving a full copy of the frame. The result is identical.
   */
  inPlace = false
): CleanupResult {
  const w = source.width
  const h = source.height
  const n = w * h
  const c = source.channels
  // The planes are views of a single array, which is also the result: no
  // final copy to reassemble them.
  const data = inPlace ? source.data : source.data.slice(0, n * c)
  const planes: Float32Array[] = []
  for (let k = 0; k < c; k++) planes.push(data.subarray(k * n, (k + 1) * n))

  let correctedPixels = 0
  if (options.hotPixels) {
    for (const p of planes) correctedPixels += correctHotPixels(p, w, h)
  }

  // The luminance and its statistics are needed by several steps: they
  // are recomputed only when a step has actually changed the planes.
  let y: Float32Array | null = luminance(planes)
  const edges = measureEdges(y, w, h)

  let backgroundUnevenness = 0
  let backgroundColorCast = 0
  if (options.background) {
    const result = subtractBackground(planes, w, h)
    backgroundUnevenness = result.unevenness
    backgroundColorCast = result.colorCast
    releaseLuminance(y, planes)
    y = null
  }

  let starGains: [number, number, number] = [1, 1, 1]
  let hfr = 0
  let stars: Star[] = []
  if (c === 3) {
    const measurement = measureStars(planes, data.subarray(0, 3 * n), w, h)
    hfr = measurement.hfr
    stars = measurement.stars
    if (options.balanceStars && measurement.gains) {
      starGains = measurement.gains
      if (y) releaseLuminance(y, planes)
      y = null
      for (let k = 0; k < 3; k++) {
        // The channel background is already measured, on the same data, by measureStars.
        const background = measurement.backgrounds[k]
        const g = starGains[k]
        const p = planes[k]
        for (let i = 0; i < n; i++) p[i] = background + (p[i] - background) * g
      }
    }
  }

  // References to the full planes no longer needed are dropped as soon as
  // possible: on large images each one is hundreds of megabytes.
  let lum: Float32Array | null = y ?? luminance(planes)
  y = null
  const statsLum = medianAndMad(lum)
  const noiseBefore = statsLum.mad * MAD_TO_SIGMA

  // The signal map is computed only if a correction below uses it.
  const colorNoise = c === 3 && options.colorNoise > 0.001
  const withSignal = colorNoise || options.lightNoise > 0.001 || options.sharpness > 0.001
  let signal: Float32Array | null = withSignal ? signalMap(lum, w, h, noiseBefore, statsLum.median) : null
  let modified = false
  if (colorNoise && signal) {
    modified = true
    // Before the color smoothing, which would otherwise spread the colored
    // ring of saturated cores around.
    const neutralized = neutralizeSaturatedStars(planes, w, h)
    if (!options.onlyStarColor) {
      const protectedStars = starMask(stars, w, h)
      // The luminance goes to the color smoothing, which gives it back.
      smoothColor(planes, w, h, options.colorNoise, signal, lum, statsLum.median, neutralized, protectedStars)
      lum = null
      smoothColorFine(planes, w, h, options.colorNoise, neutralized, protectedStars)
    }
    if (lum) releaseLuminance(lum, planes)
    lum = null
    correctColoredSpots(planes, w, h)
    clampStarTint(planes, w, h, tintStars(planes, data.subarray(0, 3 * n), w, h), signal)
  }
  if (lum) releaseLuminance(lum, planes)
  lum = null
  if (options.lightNoise > 0.001 && signal) {
    modified = true
    smoothSky(planes, w, h, options.lightNoise, signal)
  }
  if (options.sharpness > 0.001 && signal) {
    modified = true
    refine(planes, w, h, options.sharpness, signal, hfr)
  }
  if (signal) returnShared(signal)
  signal = null

  const noiseAfter = modified ? planeSkyNoise(planes) : noiseBefore

  return {
    image: { width: w, height: h, channels: c, data },
    correctedPixels,
    backgroundUnevenness,
    backgroundColorCast,
    noiseBefore,
    noiseAfter,
    starGains,
    hfr,
    edges
  }
}

/**
 * Luminance of the planes (the plane itself, if there is only one). It is a
 * temporary plane taken from the pool of parallel.ts: it must be given back
 * with `releaseLuminance` when no longer needed, so the next one reuses its
 * memory instead of leaving garbage behind.
 */
function luminance(planes: Float32Array[]): Float32Array {
  if (planes.length === 1) return planes[0]
  const [r, g, b] = planes
  const y = takeShared(r.length)
  for (let i = 0; i < y.length; i++) y[i] = (r[i] + g[i] + b[i]) / 3
  return y
}

/** Gives back a luminance obtained from `luminance` (not the plane itself). */
function releaseLuminance(y: Float32Array, planes: Float32Array[]): void {
  if (y !== planes[0]) returnShared(y)
}

/** Blurred copy of `p` in a temporary plane from the pool, to give back with `returnShared`. */
function blurredCopy(p: Float32Array, w: number, h: number, radius: number): Float32Array {
  const t = takeShared(p.length)
  t.set(p)
  return blurInPlace(t, w, h, radius)
}

/** Sky noise: robust dispersion, to which the stars do not contribute. */
function skyNoise(y: Float32Array): number {
  return medianAndMad(y).mad * MAD_TO_SIGMA
}

/**
 * Sky noise of the luminance of the planes, like `skyNoise(luminance(planes))`
 * with the same result: the luminance is computed only at the pixels that
 * `medianAndMad` samples, without a full plane.
 */
function planeSkyNoise(planes: Float32Array[]): number {
  if (planes.length === 1) return skyNoise(planes[0])
  const [r, g, b] = planes
  const step = Math.max(1, Math.floor(r.length / MEDIAN_SAMPLES))
  const sample = new Float32Array(Math.floor(r.length / step))
  for (let i = 0; i < sample.length; i++) {
    const j = i * step
    sample[i] = (r[j] + g[j] + b[j]) / 3
  }
  return medianAndMad(sample, Infinity).mad * MAD_TO_SIGMA
}

/** Samples taken by `medianAndMad` with its default limit. */
const MEDIAN_SAMPLES = 200000

/**
 * Hot pixels: a pixel that exceeds all eight neighbors by a wide margin
 * is a sensor defect or a cosmic ray. A star, even a small one, instead
 * lights up the surrounding pixels too, so its brightest neighbor stays
 * comparable to the center. The defective pixel is replaced with the
 * median of its neighbors.
 */
function correctHotPixels(p: Float32Array, w: number, h: number): number {
  const s = medianAndMad(p)
  const sigma = s.mad * MAD_TO_SIGMA
  if (sigma <= 0) return 0
  const threshold = s.median + 6 * sigma
  const neighbors = new Float32Array(8)
  let correctedItems = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = p[i]
      if (v <= threshold) continue
      let k = 0
      let max = -Infinity
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const u = p[i + dy * w + dx]
          neighbors[k++] = u
          if (u > max) max = u
        }
      }
      if (max - s.median > (v - s.median) * 0.3) continue
      neighbors.sort()
      p[i] = (neighbors[3] + neighbors[4]) / 2
      correctedItems++
    }
  }
  return correctedItems
}

/**
 * Poorly covered edges: after alignment the frames do not overlap
 * completely, and where the field rotates (alt-azimuth mounts) the corners
 * come from few exposures and are much noisier than the rest.
 *
 * The image is divided into boxes and the noise of each is measured from
 * the difference between pixels two steps apart: the signal varies
 * slowly, the grain does not, so the nebula is not mistaken for noise.
 * Then the rectangle to keep is chosen (see below).
 */
function measureEdges(y: Float32Array, w: number, h: number): CleanupResult['edges'] {
  const columns = 32
  const rows = Math.max(8, Math.round((columns * h) / w))
  const cw = Math.floor(w / columns)
  const ch = Math.floor(h / rows)
  const noise = new Float32Array(columns * rows)
  const step = Math.max(1, Math.floor(Math.sqrt((cw * ch) / 800)))
  // Differences in double precision, like ordinary JavaScript numbers.
  const differences = new Float64Array(Math.ceil(ch / step) * Math.ceil(cw / step) + 1)
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      let count = 0
      for (let yy = cy * ch; yy < (cy + 1) * ch; yy += step) {
        for (let xx = cx * cw; xx < (cx + 1) * cw - 2; xx += step) {
          differences[count++] = Math.abs(y[yy * w + xx + 2] - y[yy * w + xx])
        }
      }
      noise[cy * columns + cx] = count > 0 ? kth(differences, count >> 1, count) : 0
    }
  }
  const sortedItems = Array.from(noise).sort((a, b) => a - b)
  const typical = Math.max(1e-12, sortedItems[sortedItems.length >> 1])
  // Median over the neighboring boxes (3 x 3, edge repeated): an isolated
  // "noisier" box is almost always a bright star or a detail-rich piece of
  // nebula; the poorly covered bands are contiguous and remain.
  const smoothed = new Float32Array(columns * rows)
  const neighbors = new Float32Array(9)
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      let k = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(rows - 1, Math.max(0, cy + dy))
          const xx = Math.min(columns - 1, Math.max(0, cx + dx))
          neighbors[k++] = noise[yy * columns + xx]
        }
      }
      neighbors.sort()
      smoothed[cy * columns + cx] = neighbors[4]
    }
  }

  /*
   * The most advantageous rectangle is chosen: each box kept is worth 1,
   * each noisy box kept costs in proportion to how much its noise exceeds
   * 1.5 times the typical one (slightly higher noise is absorbed by noise
   * reduction; from twice upward, after the stretch, a grainy band shows).
   * All rectangles that remove at most a fifth per side are tried; with
   * cumulative sums the cost of each is immediate. Removing clean boxes
   * for a barely noisy corner is not worthwhile; a truly noisy band or
   * wedge (from field rotation) is.
   *
   * Tightening the rectangle one side at a time, removing the side with
   * the most boxes above 1.5 times the typical, is not enough: with field
   * rotation the wedges push three sides to the limit and a noisy corner,
   * which does not take up enough of the side, remains.
   */
  const WEIGHT = 6
  const cost = new Float64Array((columns + 1) * (rows + 1))
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const excess = Math.max(0, smoothed[cy * columns + cx] / typical - 1.5)
      const v = 1 - WEIGHT * excess
      // Cumulative sums over rows and columns: the value of a rectangle in
      // four reads.
      cost[(cy + 1) * (columns + 1) + cx + 1] =
        v + cost[cy * (columns + 1) + cx + 1] + cost[(cy + 1) * (columns + 1) + cx] - cost[cy * (columns + 1) + cx]
    }
  }
  const value = (s0: number, d0: number, a0: number, b0: number): number =>
    cost[b0 * (columns + 1) + d0] - cost[a0 * (columns + 1) + d0] - cost[b0 * (columns + 1) + s0] + cost[a0 * (columns + 1) + s0]
  const maxX = Math.floor(columns * 0.2)
  const maxY = Math.floor(rows * 0.2)
  let best = value(0, columns, 0, rows)
  let s = 0
  let d = columns
  let a = 0
  let b = rows
  for (let s0 = 0; s0 <= maxX; s0++) {
    for (let d0 = columns; d0 >= columns - maxX; d0--) {
      for (let a0 = 0; a0 <= maxY; a0++) {
        for (let b0 = rows; b0 >= rows - maxY; b0--) {
          const v = value(s0, d0, a0, b0)
          // On equal value the larger rectangle is kept.
          if (v > best + 1e-9) {
            best = v
            s = s0
            d = d0
            a = a0
            b = b0
          }
        }
      }
    }
  }
  return {
    left: (s * cw) / w,
    rightSide: ((columns - d) * cw) / w,
    top: (a * ch) / h,
    bottom: ((rows - b) * ch) / h
  }
}

/**
 * Sky background extraction.
 *
 * The sky is sampled on a grid of boxes; from each box a low level is
 * taken, which the stars do not raise, and the boxes occupied by the
 * object are rejected. A second-degree surface is fitted to the remaining
 * samples: it follows the halos of light pollution and of the Moon but is
 * too stiff to chase a nebula. The surface is subtracted channel by
 * channel and replaced by a single level, equal for the three channels:
 * the background becomes uniform and neutral, without a color cast.
 */
function subtractBackground(
  planes: Float32Array[],
  w: number,
  h: number
): { unevenness: number; colorCast: number } {
  const columns = 24
  const rows = Math.max(8, Math.round((columns * h) / w))
  const cw = Math.floor(w / columns)
  const ch = Math.floor(h / rows)
  const y = luminance(planes)
  try {
    return subtractSurface(planes, y, w, h, columns, rows, cw, ch)
  } finally {
    releaseLuminance(y, planes)
  }
}

/** The work of `subtractBackground`, on the luminance `y`. */
function subtractSurface(
  planes: Float32Array[],
  y: Float32Array,
  w: number,
  h: number,
  columns: number,
  rows: number,
  cw: number,
  ch: number
): { unevenness: number; colorCast: number } {
  /** Sky level in a box: the lowest quarter of the values. */
  const level = (p: Float32Array, cx: number, cy: number): number => {
    const v: number[] = []
    const step = Math.max(1, Math.floor(Math.sqrt((cw * ch) / 400)))
    for (let yy = cy * ch; yy < (cy + 1) * ch; yy += step) {
      for (let xx = cx * cw; xx < (cx + 1) * cw; xx += step) v.push(p[yy * w + xx])
    }
    v.sort((a, b) => a - b)
    return v[Math.floor(v.length * 0.25)]
  }

  // The extreme edges are discarded, often spoiled by the stacking.
  const samples: { x: number; y: number; lum: number }[] = []
  for (let cy = 1; cy < rows - 1; cy++) {
    for (let cx = 1; cx < columns - 1; cx++) {
      samples.push({ x: (cx + 0.5) / columns, y: (cy + 0.5) / rows, lum: level(y, cx, cy) })
    }
  }
  // Object boxes: too bright compared with the bulk of the sky.
  const values = samples.map((s) => s.lum).sort((a, b) => a - b)
  const median = values[values.length >> 1]
  const spread =
    values.map((v) => Math.abs(v - median)).sort((a, b) => a - b)[values.length >> 1] *
    MAD_TO_SIGMA
  const sky = samples.filter((s) => s.lum < median + 2.5 * Math.max(spread, 1e-6))
  if (sky.length < 12) return { unevenness: 0, colorCast: 0 }

  const models = planes.map((p) => {
    const data = sky.map((s) => ({
      x: s.x,
      y: s.y,
      v: level(p, Math.floor(s.x * columns), Math.floor(s.y * rows))
    }))
    return fitSurface(data)
  })

  // Common final level: the mean of the channel sky levels.
  const means = models.map((m) => evaluateMean(m))
  const common = means.reduce((a, b) => a + b, 0) / means.length
  const colorCast = ((Math.max(...means) - Math.min(...means)) / Math.max(common, 1e-9)) * 100

  let range = 0
  for (let k = 0; k < planes.length; k++) {
    const m = models[k]
    const p = planes[k]
    let minimum = Infinity
    let max = -Infinity
    for (let yy = 0; yy < h; yy++) {
      const ny = (yy + 0.5) / h
      for (let xx = 0; xx < w; xx++) {
        const f = evaluate(m, (xx + 0.5) / w, ny)
        if (f < minimum) minimum = f
        if (f > max) max = f
        p[yy * w + xx] = p[yy * w + xx] - f + common
      }
    }
    range = Math.max(range, ((max - minimum) / Math.max(common, 1e-9)) * 100)
  }
  return { unevenness: range, colorCast }
}

/** Coefficients of a + bx + cy + dx² + exy + fy². */
type Surface = number[]

function terms(x: number, y: number): number[] {
  return [1, x, y, x * x, x * y, y * y]
}

function evaluate(s: Surface, x: number, y: number): number {
  const t = terms(x, y)
  let v = 0
  for (let i = 0; i < 6; i++) v += s[i] * t[i]
  return v
}

/** Mean value of the surface over the whole frame. */
function evaluateMean(s: Surface): number {
  let sum = 0
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) sum += evaluate(s, (i + 0.5) / 10, (j + 0.5) / 10)
  return sum / 100
}

/** Least squares with the normal equations, solved by elimination. */
function fitSurface(data: { x: number; y: number; v: number }[]): Surface {
  const a = Array.from({ length: 6 }, () => new Array(7).fill(0))
  for (const d of data) {
    const t = terms(d.x, d.y)
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) a[i][j] += t[i] * t[j]
      a[i][6] += t[i] * d.v
    }
  }
  for (let i = 0; i < 6; i++) {
    let anchor = i
    for (let r = i + 1; r < 6; r++) if (Math.abs(a[r][i]) > Math.abs(a[anchor][i])) anchor = r
    ;[a[i], a[anchor]] = [a[anchor], a[i]]
    if (Math.abs(a[i][i]) < 1e-12) return [data.reduce((s, d) => s + d.v, 0) / data.length, 0, 0, 0, 0, 0]
    for (let r = 0; r < 6; r++) {
      if (r === i) continue
      const f = a[r][i] / a[i][i]
      for (let k = i; k < 7; k++) a[r][k] -= f * a[i][k]
    }
  }
  return a.map((row, i) => row[6] / row[i])
}

/**
 * Approximate Gaussian blur with three moving-average passes, separable
 * into rows and columns: the cost does not depend on the radius. In the
 * chain worker the passes are split among several threads, with exactly
 * the same result (see parallel.ts).
 */
export function blur(p: Float32Array, w: number, h: number, radius: number): Float32Array {
  return blurMovingAverage(p, w, h, Math.max(1, Math.round(radius)))
}

/** Like `blur`, with the same result, but written into `p` itself (see parallel.ts). */
export function blurInPlace(p: Float32Array, w: number, h: number, radius: number): Float32Array {
  return blurMovingAverageInPlace(p, w, h, Math.max(1, Math.round(radius)))
}

/**
 * Color noise.
 *
 * The eye distinguishes details in brightness, much less in color. The
 * image is therefore separated into brightness and ratios between the
 * channels, only the latter are smoothed, and the image is recomposed: the
 * colored grain disappears, while sharpness stays intact because it lives
 * in the brightness. The radius is wide because in stacks the color grain
 * forms blotches a few pixels across, not isolated dots.
 *
 * The average is taken only over sky pixels, weighted by the signal map:
 * otherwise the color of a star or the edge of a nebula would be smeared
 * onto the neighboring sky, creating colored rings and halos. Stars and
 * object, where the color is measured with confidence, stay as they are.
 */
function smoothColor(
  planes: Float32Array[],
  w: number,
  h: number,
  strength: number,
  signal: Float32Array,
  /**
   * Luminance of the planes and its median, already computed by the caller.
   * The luminance (a temporary plane, see `luminance`) is given back to the
   * pool here as soon as its blurred version is computed: in the final loop
   * it is recomputed from the planes, which still hold the values it came
   * from, except for the pixels `neutralized` (see
   * `neutralizeSaturatedStars`), whose values are kept apart. On large
   * images this saves a full plane at the moment the most are in use.
   */
  y: Float32Array,
  medianY: number,
  neutralized: Int32Array | null,
  /** Detected stars (see `starMask`): neither smoothed nor averaged into the sky. */
  protectedStars: Uint8Array
): void {
  const [r, g, b] = planes
  const n = r.length
  // The luminance of the neutralized pixels, by increasing position.
  const kept = neutralized ? keptLuminance(neutralized, y) : null
  const radius = Math.max(3, Math.min(w, h) / 180)
  // Sky weight, recomputed where needed instead of kept in a plane: rounded
  // to single precision as it would be in a Float32Array.
  const sky = (i: number): number => Math.fround((1 - smoothStep(signal[i], 3, 12)) * (1 - protectedStars[i] / 255))
  const weighted = (p: Float32Array): Float32Array => {
    const t = takeShared(n)
    for (let i = 0; i < n; i++) t[i] = p[i] * sky(i)
    return blurInPlace(t, w, h, radius)
  }
  const yL = weighted(y)
  returnShared(y)
  const rL = weighted(r)
  const gL = weighted(g)
  const bL = weighted(b)
  // A pedestal avoids divisions by values close to zero.
  const pedestal = Math.max(1e-6, medianY * 0.1)
  let next = 0
  for (let i = 0; i < n; i++) {
    const f = strength * sky(i)
    if (f <= 0) continue
    let yi: number
    if (kept) {
      while (next < kept.positions.length && kept.positions[next] < i) next++
      yi = next < kept.positions.length && kept.positions[next] === i ? kept.values[next] : Math.fround((r[i] + g[i] + b[i]) / 3)
    } else yi = Math.fround((r[i] + g[i] + b[i]) / 3)
    const base = yL[i] + pedestal
    // Smoothed ratios only, never pulled toward gray: the background
    // extraction already leaves the sky neutral, and a faint nebula that
    // fills the frame (the Rosette) sits at the "sky" level of the signal
    // map, so graying it erased its color.
    validAspectRatios((rL[i] + pedestal) / base, (gL[i] + pedestal) / base, (bL[i] + pedestal) / base)
    const vr = yi * aspectRatios[0]
    const vg = yi * aspectRatios[1]
    const vb = yi * aspectRatios[2]
    r[i] += (vr - r[i]) * f
    g[i] += (vg - g[i]) * f
    b[i] += (vb - b[i]) * f
  }
  for (const p of [yL, rL, gL, bL]) returnShared(p)
}

/**
 * Discs of the detected stars, 255 inside and fading to 0 just beyond.
 *
 * The signal map is measured on a blurred version, where a faint star
 * spreads below the threshold: the color smoothing took it for sky and
 * gave it the sky's gray, so after the stretch the field stars came out
 * white (true color ratios around 1.3, rendered 1.08). Protected here,
 * they keep their color, which `clampStarTint` then measures on the
 * whole star and makes uniform, removing the speckle the smoothing
 * removed before.
 */
function starMask(stars: Star[], w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h)
  for (const s of stars) {
    const inner = Math.max(2, s.hfr * 2.5)
    const outer = inner + 2
    const cx = Math.round(s.x)
    const cy = Math.round(s.y)
    const e = Math.ceil(outer)
    for (let dy = -e; dy <= e; dy++) {
      const y = cy + dy
      if (y < 0 || y >= h) continue
      for (let dx = -e; dx <= e; dx++) {
        const x = cx + dx
        if (x < 0 || x >= w) continue
        const v = Math.round(255 * (1 - smoothStep(Math.hypot(s.x - x, s.y - y), inner, outer)))
        const i = y * w + x
        if (v > mask[i]) mask[i] = v
      }
    }
  }
  return mask
}

/**
 * Highest green share a star can have, given its red and blue shares.
 * Stars glow like hot bodies: green always lies between red and blue,
 * below the stronger of the two, and the more they differ the further
 * below. A limit at the mean of red and blue took the color away from
 * yellow and orange stars, whose green is close to red; at the stronger
 * of the two, the cyan stars of dual-band filters stayed cyan.
 */
function maxStarGreen(red: number, blue: number): number {
  return Math.max(red, blue) - 0.25 * Math.abs(red - blue)
}

/**
 * Lowest green share a star can have: as far above the weaker of red and
 * blue as `maxStarGreen` is below the stronger. Green well below both is
 * violet or magenta, a color no star has: on faint stars it is the noise
 * of the green channel, and saturation turned it into violet confetti.
 */
function minStarGreen(red: number, blue: number): number {
  return Math.min(red, blue) + 0.25 * Math.abs(red - blue)
}

/**
 * Positions in `neutralized` (with repetitions, in any order) sorted and
 * without repetitions, with the value of `y` at each.
 */
function keptLuminance(neutralized: Int32Array, y: Float32Array): { positions: Int32Array; values: Float32Array } {
  const sorted = neutralized.slice().sort()
  let count = 0
  for (let k = 0; k < sorted.length; k++) if (k === 0 || sorted[k] !== sorted[k - 1]) sorted[count++] = sorted[k]
  const positions = sorted.subarray(0, count)
  const values = new Float32Array(count)
  for (let k = 0; k < count; k++) values[k] = y[positions[k]]
  return { positions, values }
}

/**
 * Brings three ratios between channels within physically possible values
 * and with sum 3, so that the pixel brightness does not change. Without
 * this limit, at the edge of a very bright star the weighted average can
 * give one channel a share greater than the total, leaving the others
 * negative: the pixel would turn a pure color, for example fire red.
 */
function validAspectRatios(nr: number, ng: number, nb: number): void {
  const a = Math.min(2.5, Math.max(0.2, nr))
  const b = Math.min(2.5, Math.max(0.2, ng))
  const c = Math.min(2.5, Math.max(0.2, nb))
  const s = 3 / (a + b + c)
  aspectRatios[0] = a * s
  aspectRatios[1] = b * s
  aspectRatios[2] = c * s
}

/**
 * Result of `validAspectRatios`. The function is called for millions of
 * pixels: writing here instead of returning a new array every time saves
 * the JavaScript engine millions of objects to collect. It is in double
 * precision, so the numbers are the same.
 */
const aspectRatios = new Float64Array(3)

/**
 * Signal map: how many times, at each point, the local level exceeds the
 * sky noise. It is measured on a blurred version, so the grain alone is
 * not enough to cross the threshold. It distinguishes the sky, where the
 * noise corrections act in full, from stars and nebula, which must be
 * left intact.
 */
function signalMap(y: Float32Array, w: number, h: number, sigma: number, background: number): Float32Array {
  // A temporary plane from the pool: the caller gives it back.
  const trace = blurredCopy(y, w, h, Math.max(4, Math.min(w, h) / 360))
  const s = Math.max(sigma, 1e-9)
  for (let i = 0; i < trace.length; i++) trace[i] = (trace[i] - background) / s
  return trace
}

/** Gradual transition from 0 (below from) to 1 (above a). */
function smoothStep(v: number, from: number, a: number): number {
  const t = Math.min(1, Math.max(0, (v - from) / (a - from)))
  return t * t * (3 - 2 * t)
}

/**
 * Brightness noise on the sky: where the signal map says there is only
 * sky, the grain is smoothed; on stars and nebula the image stays as it
 * is and loses no detail. The transition between the two zones is
 * gradual, so as not to leave visible outlines.
 */
function smoothSky(
  planes: Float32Array[],
  w: number,
  h: number,
  strength: number,
  signal: Float32Array
): void {
  const y = luminance(planes)
  const yL = blurredCopy(y, w, h, Math.max(1, Math.min(w, h) / 1100))
  for (let i = 0; i < y.length; i++) {
    // Full on the sky; on the object a moderate smoothing remains, which
    // removes the grain without erasing the structure.
    const delta = (yL[i] - y[i]) * strength * (1 - 0.6 * smoothStep(signal[i], 2, 8))
    for (const p of planes) p[i] += delta
  }
  returnShared(yL)
  releaseLuminance(y, planes)
}

/**
 * Measurements on the stars: mean color and typical size.
 *
 * White balance is done on the stars and not on the object: the average of
 * many stars of different types is close to white, while a nebula has a
 * color of its own (the blue of oxygen, the red of hydrogen) that a
 * balance on the whole image would extinguish. Only unsaturated stars are
 * used, whose light is measured in full.
 */
function measureStars(
  planes: Float32Array[],
  /** The three planes one after the other: the array of which `planes` are views. */
  data: Float32Array,
  w: number,
  h: number
): { gains: [number, number, number] | null; hfr: number; stars: Star[]; backgrounds: number[] } {
  // Many stars, even faint ones: they are needed to limit their tint. For
  // the white balance only the unsaturated ones count anyway.
  const image = { width: w, height: h, channels: 3 as const, data }
  const detectionLuminance = toLuminance(image, takeShared(w * h))
  const stars = detectStars(image, { max: 3000 }, detectionLuminance)
  returnShared(detectionLuminance)
  if (stars.length === 0) return { gains: null, hfr: 0, stars, backgrounds: [] }

  // The typical size is measured on the brightest, well-defined stars.
  const sortedHfr = stars
    .slice()
    .sort((a, b) => b.flux - a.flux)
    .slice(0, 300)
    .map((s) => s.hfr)
    .sort((a, b) => a - b)
  const hfr = sortedHfr[sortedHfr.length >> 1] ?? 0

  const backgrounds = planes.map((p) => medianAndMad(p).median)
  const ratiosR: number[] = []
  const ratiosB: number[] = []
  for (const s of stars) {
    const radius = Math.max(2, Math.ceil(s.hfr * 2.5))
    const cx = Math.round(s.x)
    const cy = Math.round(s.y)
    if (cx - radius < 0 || cy - radius < 0 || cx + radius >= w || cy + radius >= h) continue
    const sums = [0, 0, 0]
    let saturate = false
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue
        const i = (cy + dy) * w + cx + dx
        for (let k = 0; k < 3; k++) {
          const v = planes[k][i]
          if (v > 0.95) saturate = true
          sums[k] += v - backgrounds[k]
        }
      }
    }
    if (saturate || sums[1] <= 0 || sums[0] <= 0 || sums[2] <= 0) continue
    ratiosR.push(sums[1] / sums[0])
    ratiosB.push(sums[1] / sums[2])
  }
  if (ratiosR.length < 10) return { gains: null, hfr, stars, backgrounds }

  const median = (v: number[]): number => v.sort((a, b) => a - b)[v.length >> 1]
  const clamp = (g: number): number => Math.min(1.5, Math.max(0.67, g))
  // The balance is applied at half strength (the square root of each
  // gain): at full strength M 27 turns cyan instead of the expected green;
  // at half strength M 33 stays lavender.
  const gr = Math.sqrt(clamp(median(ratiosR)))
  const gb = Math.sqrt(clamp(median(ratiosB)))
  // Normalized so the overall brightness does not change.
  const mean = (gr + 1 + gb) / 3
  return { gains: [gr / mean, 1 / mean, gb / mean], hfr, stars, backgrounds }
}

/**
 * Sharpness on the signal only.
 *
 * An unsharp mask (a blurred version is subtracted to enhance what the
 * blur removes) applied to the brightness, and only where the signal map
 * says there is an object: on the sky it would amplify the grain just
 * removed. The strength grows with the star size, because a soft image
 * needs it more, and the radius follows the scale of the details. The
 * three channels are multiplied by the same factor, so the color does not
 * change.
 */
function refine(
  planes: Float32Array[],
  w: number,
  h: number,
  strength: number,
  signal: Float32Array,
  hfr: number
): void {
  const y = luminance(planes)
  const radius = Math.max(1, Math.min(3, hfr > 0 ? hfr * 0.7 : 1.5))
  const amount = strength * Math.min(1, Math.max(0.35, 0.35 + (hfr - 1.5) * 0.25))
  const yL = blurredCopy(y, w, h, radius)
  // Stars: point-like, so well above the mean of their surroundings. They
  // are excluded, because the unsharp mask would create a dark ring around
  // each; sharpness is for the extended structures.
  const surroundings = blurredCopy(y, w, h, radius * 4)
  const stats = medianAndMad(y)
  const sigma = Math.max(1e-9, stats.mad * MAD_TO_SIGMA)
  // It acts on the light above the background only: multiplying the sky
  // level too would push the faint channels below the black point.
  const backgrounds = planes.map((p) => medianAndMad(p).median)
  for (let i = 0; i < y.length; i++) {
    const star = smoothStep((y[i] - surroundings[i]) / sigma, 3, 10)
    const m = smoothStep(signal[i], 3, 12) * (1 - star)
    if (m <= 0) continue
    const excess = y[i] - stats.median
    if (excess <= sigma) continue
    const newValue = excess + (y[i] - yL[i]) * amount * m
    const factor = Math.min(1.6, Math.max(0.6, newValue / excess))
    for (let k = 0; k < planes.length; k++) {
      const p = planes[k]
      p[i] = backgrounds[k] + (p[i] - backgrounds[k]) * factor
    }
  }
  returnShared(yL)
  returnShared(surroundings)
  releaseLuminance(y, planes)
}

/**
 * Fine-scale color noise, over the whole image.
 *
 * After the sky smoothing, colored grain remains inside the object and on
 * faint stars, which saturation would turn into confetti. Here the radius
 * is small and the average is weighted with the brightness: a bright star
 * dominates its own average and keeps its color, the nebula keeps its
 * color zones, while the pixel-to-pixel variation, which is only noise,
 * disappears.
 */
function smoothColorFine(
  planes: Float32Array[],
  w: number,
  h: number,
  strength: number,
  /**
   * Pixels already given a neutral color around saturated cores (see
   * `neutralizeSaturatedStars`): they are left alone, because averaging
   * them with the colored halo beyond put a blue rim around the star.
   */
  neutralized: Int32Array | null,
  /** Detected stars (see `starMask`), left with their own color. */
  protectedStars: Uint8Array
): void {
  const [r, g, b] = planes
  let skip: Uint8Array | null = null
  if (neutralized) {
    skip = new Uint8Array(r.length)
    for (let k = 0; k < neutralized.length; k++) skip[neutralized[k]] = 1
  }
  const radius = Math.max(2, Math.min(w, h) / 600)
  // The luminance is blurred in place once its statistics are taken: in the
  // loop it is recomputed from the planes, which at each pixel still hold
  // the values it came from (same operations, same rounding).
  const yL = luminance(planes)
  const stats = medianAndMad(yL)
  const sigma = Math.max(1e-9, stats.mad * MAD_TO_SIGMA)
  // In the averages each pixel weighs at most as much as a pixel a few
  // deviations above the sky, keeping its own color: otherwise a single
  // bright hot pixel outweighed all its neighbors and gave them its color,
  // a green blob a few pixels wide (IC 434).
  const cap = stats.median + 8 * sigma
  const weight = (i: number): number => {
    const y = (r[i] + g[i] + b[i]) / 3
    return y > cap ? cap / y : 1
  }
  for (let i = 0; i < yL.length; i++) if (yL[i] > cap) yL[i] = cap
  blurInPlace(yL, w, h, radius)
  const cappedBlur = (p: Float32Array): Float32Array => {
    const t = takeShared(p.length)
    for (let i = 0; i < p.length; i++) t[i] = p[i] * weight(i)
    return blurInPlace(t, w, h, radius)
  }
  const rL = cappedBlur(r)
  const gL = cappedBlur(g)
  const bL = cappedBlur(b)
  const pedestal = Math.max(1e-6, stats.median * 0.1)
  for (let i = 0; i < yL.length; i++) {
    const y = Math.fround((r[i] + g[i] + b[i]) / 3)
    // Where light is abundant the color is well measured and is not touched:
    // near a bright star the average would take the tint of the core and
    // spread it onto the edge.
    const f = strength * 0.85 * (1 - smoothStep((y - stats.median) / sigma, 15, 60)) * (1 - protectedStars[i] / 255)
    if (f <= 0 || (skip && skip[i])) continue
    const base = yL[i] + pedestal
    validAspectRatios((rL[i] + pedestal) / base, (gL[i] + pedestal) / base, (bL[i] + pedestal) / base)
    const vr = y * aspectRatios[0]
    const vg = y * aspectRatios[1]
    const vb = y * aspectRatios[2]
    r[i] += (vr - r[i]) * f
    g[i] += (vg - g[i]) * f
    b[i] += (vb - b[i]) * f
  }
  for (const p of [yL, rL, gL, bL]) returnShared(p)
}

/**
 * Spots of impossible color.
 *
 * A real star always has light in all three channels: even the reddest or
 * bluest do not exceed by much a ratio of 2 between the strongest and the
 * weakest channel, and on faint stars the measured ratio is mostly noise.
 * A dot that is almost purely red or blue is a stacking residue (a hot
 * pixel smeared by interpolation) and saturation would make it conspicuous.
 * These spots are brought toward gray in proportion to how implausible
 * their color is, preserving their brightness; the other stars only by
 * half, so that the final saturation does not make them vivid.
 */
function correctColoredSpots(planes: Float32Array[], w: number, h: number): void {
  const backgrounds = planes.map((p) => medianAndMad(p).median)
  // As in `smoothColorFine`: the luminance becomes its blurred version and
  // is recomputed pixel by pixel in the loop.
  const surroundings = luminance(planes)
  const stats = medianAndMad(surroundings)
  blurInPlace(surroundings, w, h, 4)
  const sigma = Math.max(1e-9, stats.mad * MAD_TO_SIGMA)
  const [r, g, b] = planes
  for (let i = 0; i < surroundings.length; i++) {
    // The excess is measured against the sky noise plus a tenth of the local
    // light above the sky: inside a bright nebula a filament a few percent
    // above its surroundings is hundreds of sky deviations, and was grayed
    // as if it were a star (cyan worms in the core of M 42).
    const local = sigma + 0.1 * Math.max(0, surroundings[i] - stats.median)
    const excess = (Math.fround((r[i] + g[i] + b[i]) / 3) - surroundings[i]) / local
    if (excess < 1.5) continue
    const cr = Math.max(0, r[i] - backgrounds[0])
    const cg = Math.max(0, g[i] - backgrounds[1])
    const cb = Math.max(0, b[i] - backgrounds[2])
    const max = Math.max(cr, cg, cb)
    const minimum = Math.min(cr, cg, cb)
    if (max <= 0) continue
    const ratio = max / Math.max(minimum, max * 0.01)
    // On faint stars a modest ratio is enough: a strong stretch would
    // multiply it into a full color. Bright stars, well measured, can have
    // more pronounced colors.
    const tolerance = 1.3 + smoothStep(excess, 10, 60) * 1.2
    const pointLike = smoothStep(excess, 1.5, 4)
    // Only impossible colors: halving every star tint as well turned the
    // stars gray (the star tint is limited by `clampStarTint`).
    const amount = smoothStep(ratio, tolerance, tolerance * 1.8) * pointLike
    if (amount <= 0) continue
    const m = (cr + cg + cb) / 3
    r[i] -= (cr - m) * amount
    g[i] -= (cg - m) * amount
    b[i] -= (cb - m) * amount
  }
  returnShared(surroundings)
}


/**
 * Saturated cores of bright stars.
 *
 * In the core of a very bright star the channels reach the sensor maximum,
 * but not all at the same radius: on many color sensors red and blue
 * saturate on a wider disc than green. The result is a ring of impossible
 * color (violet, magenta) between the white core and the halo, which a
 * strong stretch and saturation make conspicuous. The star tint
 * (`clampStarTint`) is not enough: those stars often escape detection
 * (the profile is flat at the top) or sit on top of a galaxy, where the
 * tint is left alone. A saturated core, however, is never a nebula knot.
 *
 * Groups of pixels with at least one channel near its own maximum are
 * searched for; on a disc around each (six times its radius plus ten
 * pixels, to include the halo) the light above the local background
 * (the surrounding nebula or galaxy, which keeps its own color) takes a
 * single color: the mean color of the unsaturated halo, almost neutral
 * near the core and compressed within a ratio of 1.25 between the channels
 * on the rest of the halo, as for the other saturated stars (see
 * `clampStarTint`). Toward the edge of the disc the change fades.
 *
 * Returns the positions of the pixels it rewrote (null if none).
 */
function neutralizeSaturatedStars(planes: Float32Array[], w: number, h: number): Int32Array | null {
  const n = w * h
  const maxima = planes.map((p) => {
    let m = 0
    for (let i = 0; i < n; i++) if (p[i] > m) m = p[i]
    return m
  })
  // A channel that does not reach at least mid-scale has saturated nothing.
  const thresholds = maxima.map((m) => (m >= 0.5 ? m * 0.97 : Infinity))
  if (thresholds.every((s) => s === Infinity)) return null
  const isSaturated = new Uint8Array(n)
  let count = 0
  for (let i = 0; i < n; i++) {
    if (planes[0][i] >= thresholds[0] || planes[1][i] >= thresholds[1] || planes[2][i] >= thresholds[2]) {
      isSaturated[i] = 1
      count++
    }
  }
  // Too many pixels at the maximum: they are not stars (burned or already
  // normalized image), better to touch nothing.
  if (count === 0 || count > n * 0.01) return null

  // Groups of contiguous saturated pixels, with a breadth-first visit. A
  // visited pixel is marked with 2 (still nonzero, so still saturated); the
  // queue holds at most all the saturated pixels.
  const tail = new Int32Array(count)
  const groups: { x: number; y: number; radius: number }[] = []
  for (let i0 = 0; i0 < n; i0++) {
    if (isSaturated[i0] !== 1) continue
    let head = 0
    let end = 0
    tail[end++] = i0
    isSaturated[i0] = 2
    let sx = 0
    let sy = 0
    while (head < end) {
      const i = tail[head++]
      const x = i % w
      const y = (i - x) / w
      sx += x
      sy += y
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && isSaturated[j] === 1) {
          isSaturated[j] = 2
          tail[end++] = j
        }
      }
    }
    groups.push({ x: sx / end, y: sy / end, radius: Math.sqrt(end / Math.PI) })
  }

  // Pixels rewritten (with repetitions where discs overlap), for the color
  // smoothing (see `smoothColor`).
  let positions = new Int32Array(1024)
  let written = 0
  for (const g of groups) {
    // An isolated hot pixel is not a star.
    if (g.radius < 0.8) continue
    const cx = Math.round(g.x)
    const cy = Math.round(g.y)
    // The halo of a very bright star reaches far beyond its core: with a
    // dual-band filter it keeps the filter's cyan, and a disc limited to 80
    // pixels left a white disc with a sharp edge inside a cyan halo
    // (Alnitak). The disc follows the halo, up to 250 pixels.
    const disk = Math.min(250, Math.ceil(g.radius * 6 + 10))
    // Local background, just outside the disc: over a nebula or a galaxy
    // it is their color, which must stay around the star.
    const locale = localBackground(planes, w, h, cx, cy, disk + 1, disk + 4)
    // Halo color, between the saturated core and the edge of the disc.
    const flux = [0, 0, 0]
    const r1 = Math.ceil(g.radius) + 1
    for (let dy = -disk; dy <= disk; dy++) {
      for (let dx = -disk; dx <= disk; dx++) {
        const d2 = dx * dx + dy * dy
        const x = cx + dx
        const y = cy + dy
        if (d2 < r1 * r1 || d2 > disk * disk || x < 0 || y < 0 || x >= w || y >= h) continue
        const i = y * w + x
        if (isSaturated[i]) continue
        for (let k = 0; k < 3; k++) flux[k] += Math.max(0, planes[k][i] - locale[k])
      }
    }
    const mf = (flux[0] + flux[1] + flux[2]) / 3
    const share = mf > 0 ? flux.map((f) => f / mf) : [1, 1, 1]
    // Never green or cyan (see `maxStarGreen`), and within a maximum ratio
    // between the channels: 1.05 near the core, where the channels clip on
    // discs of different size and leave a ring of impossible color, 1.25 on
    // the rest of the halo, whose color is the star's (at 1.1 everywhere,
    // with the disc covering the whole halo, every bright star of a cluster
    // came out white).
    share[1] = Math.min(share[1], maxStarGreen(share[0], share[2]))
    const compressed = (limit: number): number[] => {
      const s = share.slice()
      const qMax = Math.max(...s)
      const qMin = Math.min(...s)
      if (qMax > qMin * limit) {
        const q = (limit - 1) / (qMax - qMin * limit + (limit - 1))
        for (let k = 0; k < 3; k++) s[k] = 1 + (s[k] - 1) * q
      }
      const sum = s[0] + s[1] + s[2]
      // Halo light in green alone: neutral gray instead of a division by zero.
      for (let k = 0; k < 3; k++) s[k] = sum > 1e-9 ? s[k] * (3 / sum) : 1
      return s
    }
    const coreShare = compressed(1.05)
    const haloShare = compressed(1.25)
    const coreEdge = g.radius * 2.5 + 3
    for (let dy = -disk; dy <= disk; dy++) {
      const y = cy + dy
      if (y < 0 || y >= h) continue
      for (let dx = -disk; dx <= disk; dx++) {
        const x = cx + dx
        const d2 = dx * dx + dy * dy
        if (x < 0 || x >= w || d2 > disk * disk) continue
        const i = y * w + x
        const weight = 1 - smoothStep(Math.sqrt(d2) / disk, 0.6, 1)
        const e0 = planes[0][i] - locale[0]
        const e1 = planes[1][i] - locale[1]
        const e2 = planes[2][i] - locale[2]
        // Where a channel is clipped the pixel light is that of the
        // strongest channel (the mean would darken the core); elsewhere the mean.
        const a = isSaturated[i] ? Math.max(e0, e1, e2) : (e0 + e1 + e2) / 3
        if (a <= 0) continue
        if (written === positions.length) {
          const larger = new Int32Array(positions.length * 2)
          larger.set(positions)
          positions = larger
        }
        positions[written++] = i
        const t = smoothStep(Math.sqrt(d2), coreEdge, coreEdge * 1.4)
        const s0 = coreShare[0] + (haloShare[0] - coreShare[0]) * t
        const s1 = coreShare[1] + (haloShare[1] - coreShare[1]) * t
        const s2 = coreShare[2] + (haloShare[2] - coreShare[2]) * t
        planes[0][i] = locale[0] + e0 + (a * s0 - e0) * weight
        planes[1][i] = locale[1] + e1 + (a * s1 - e1) * weight
        planes[2][i] = locale[2] + e2 + (a * s2 - e2) * weight
      }
    }
  }
  return positions.subarray(0, written)
}

/**
 * Level of each channel on a ring around a point (median, which nearby
 * stars do not shift): the local background, nebula included.
 */
function localBackground(
  planes: Float32Array[],
  w: number,
  h: number,
  cx: number,
  cy: number,
  r1: number,
  r2: number
): number[] {
  return planes.map((p) => {
    const values: number[] = []
    for (let dy = -r2; dy <= r2; dy++) {
      for (let dx = -r2; dx <= r2; dx++) {
        const d2 = dx * dx + dy * dy
        const x = cx + dx
        const y = cy + dy
        if (d2 < r1 * r1 || d2 > r2 * r2 || x < 0 || y < 0 || x >= w || y >= h) continue
        values.push(p[y * w + x])
      }
    }
    if (values.length === 0) return 0
    values.sort((u, v) => u - v)
    return values[values.length >> 1]
  })
}

/**
 * Stars whose tint is limited (see `clampStarTint`), found on the luminance
 * minus its version blurred over a few star widths. On the plain luminance
 * a star on the halo of a very bright one merges with that halo into a
 * single group too large to be a star, and it kept the cyan ring the
 * optics leave around it (next to Alcyone); without the wide light the
 * stars stand apart.
 */
function tintStars(
  planes: Float32Array[],
  /** The three planes one after the other: the array of which `planes` are views. */
  data: Float32Array,
  w: number,
  h: number
): Star[] {
  const image = { width: w, height: h, channels: 3 as const, data }
  const y = toLuminance(image, takeShared(w * h))
  const wide = blurredCopy(y, w, h, 10)
  for (let i = 0; i < y.length; i++) y[i] -= wide[i]
  returnShared(wide)
  const stars = detectStars(image, { max: 3000 }, y)
  returnShared(y)
  return stars
}

/**
 * Star tint.
 *
 * With the color-preserving stretch every pixel shows its ratio between
 * channels. Inside a star the pixels have slightly different colors from
 * one another (residue of the sensor color reconstruction) and saturation
 * would turn them into speckle; a very red or saturated star would become
 * a disc of pure color.
 *
 * Each star therefore receives a single color, measured on its total light
 * and compressed within a maximum ratio between the strongest and the
 * weakest channel: 1.5, and 1.25 for saturated ones, whose core color the
 * sensor did not record (at 1.1 the bright stars of a cluster, saturated
 * only at the center, lost the color their halo keeps). Excess green is
 * moved to red and blue (see `maxStarGreen`): stars range from orange to
 * blue, green belongs only to nebulae. Stars on top of the nebula may be
 * knots of it, and get a wider limit of 2.
 *
 * The faint halo around a red star keeps its full red, and the strong
 * stretch of the finish makes it visible as a dark red ring around a pink
 * disc. For this reason the disc given the single color is wider than the
 * measured halo, and in its outer part, where the light falls to a few
 * percent of the peak and near the sky noise, the tint is gradually
 * brought toward gray: the halo is never more saturated than the core.
 */
function clampStarTint(
  planes: Float32Array[],
  w: number,
  h: number,
  stars: Star[],
  signal: Float32Array
): void {
  const y = luminance(planes)
  const statsY = medianAndMad(y)
  const sigma = Math.max(1e-9, statsY.mad * MAD_TO_SIGMA)
  const done = new Uint8Array(w * h)
  // Typical star size, to tell compact stars from extended blobs (see below).
  const hfrs = stars.map((s) => s.hfr).sort((a, b) => a - b)
  const typicalHfr = hfrs.length ? hfrs[hfrs.length >> 1] : 0
  for (const s of stars) {
    // A star with a channel at the maximum in the core is saturated: its
    // true color was lost in the sensor and it is rendered almost white.
    const cxs = Math.round(s.x)
    const cys = Math.round(s.y)
    let saturate = false
    for (let dy = -1; dy <= 1 && !saturate; dy++) {
      for (let dx = -1; dx <= 1 && !saturate; dx++) {
        const x = cxs + dx
        const yy = cys + dy
        if (x < 0 || yy < 0 || x >= w || yy >= h) continue
        const i = yy * w + x
        saturate = planes[0][i] > 0.9 || planes[1][i] > 0.9 || planes[2][i] > 0.9
      }
    }
    // Limits tighter than what is wanted in the end: the saturation of
    // the finish will widen them.
    let limit = saturate ? 1.25 : 1.5
    const cx = Math.round(s.x)
    const cy = Math.round(s.y)
    // The disc widens until the outer ring returns to the level around the
    // star: bright stars have a halo much wider than the core. The level is
    // the local one, beyond the widest halo accepted below: compared with
    // the sky of the whole image, the ring of a star on a nebula never
    // closed, the star was skipped and the stretch turned it into a dot of
    // pure color (M 45, M 42).
    const far = Math.ceil(s.hfr * 8 + 10)
    const around0 = localBackground([y], w, h, cx, cy, far, far + 4)[0]
    // A bright star has an optical halo much wider than 40 pixels, which
    // never returns to the local level within a few sky deviations: it was
    // skipped as if immersed in the object, and kept the cyan ring the
    // optics leave around it (next to Alcyone). For a compact star the disc
    // also closes where its light falls to 1% of its peak; a galaxy core or
    // a nebula knot, wider than the stars, keeps the first rule only.
    const centerLight = y[cy * w + cx] - around0
    const compact = s.hfr <= 1.5 * typicalHfr
    const closed = Math.max(1.5 * sigma, compact ? 0.01 * centerLight : 0)
    let radius = Math.max(2, Math.ceil(s.hfr * 1.5))
    while (radius < 40) {
      let sum = 0
      let count = 0
      for (let a = 0; a < 24; a++) {
        const x = Math.round(cx + radius * Math.cos((a / 24) * 2 * Math.PI))
        const yy = Math.round(cy + radius * Math.sin((a / 24) * 2 * Math.PI))
        if (x < 0 || yy < 0 || x >= w || yy >= h) continue
        sum += y[yy * w + x] - around0
        count++
      }
      if (count === 0 || sum / count < closed) break
      radius++
    }
    // If the halo does not close, the star is immersed in the object (like
    // the central star of a planetary nebula): it is not touched.
    if (radius >= 40 || radius > s.hfr * 8 + 8) continue
    radius += 2
    // The color is measured and changed on the star light above the local
    // background, just outside the treated disc: above a faint nebula the
    // background is the nebula, and around the star it must keep its own
    // color (with the whole-sky background every star would carry away a
    // grayed disc of nebula).
    const tintDisk = Math.ceil(radius * 1.6 + 3)
    const backgrounds = localBackground(planes, w, h, Math.round(s.x), Math.round(s.y), tintDisk + 1, tintDisk + 4)
    // A point above the nebula may be a knot of it, and its color is that
    // of the gas: it keeps a wider limit, enough for the hue of a knot but
    // not for a dot of pure color. The signal map is checked beyond the
    // halo just measured, where the star itself no longer weighs.
    const d = radius * 2 + 6
    const around = [
      [cx + d, cy],
      [cx - d, cy],
      [cx, cy + d],
      [cx, cy - d]
    ].filter(([x, yy]) => x >= 0 && yy >= 0 && x < w && yy < h)
    const onSignal = around.filter(([x, yy]) => signal[yy * w + x] > 6).length >= 3
    if (onSignal && !saturate) limit = 2
    // Star color: its total light above the sky, channel by channel,
    // compressed within the limit. It is measured on the halo disc; in the
    // meantime the peak is found, to which the light of the outer part is
    // compared.
    const flux = [0, 0, 0]
    let peak = 0
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = cy + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx
        if (x < 0 || x >= w || dx * dx + dy * dy > radius * radius) continue
        const i = yy * w + x
        const light = (planes[0][i] - backgrounds[0] + planes[1][i] - backgrounds[1] + planes[2][i] - backgrounds[2]) / 3
        if (light > peak) peak = light
        // The clipped core of a saturated star is white whatever the star:
        // its color is measured on the halo, which keeps it.
        if (saturate && (planes[0][i] > 0.9 || planes[1][i] > 0.9 || planes[2][i] > 0.9)) continue
        for (let k = 0; k < 3; k++) flux[k] += Math.max(0, planes[k][i] - backgrounds[k])
      }
    }
    const mf = (flux[0] + flux[1] + flux[2]) / 3
    if (mf <= 0) continue
    const share = flux.map((f) => f / mf)
    // Stars range from orange to white to blue, never green or cyan: the
    // excess over `maxStarGreen` is moved to red and blue in equal parts
    // (removing it alone left the stars of dual-band filters, green because
    // the filter passes oxygen, as blue dots). The sum stays 3.
    const excessGreen = share[1] - maxStarGreen(share[0], share[2])
    if (excessGreen > 0) {
      share[1] -= (excessGreen * 2) / 3
      share[0] += excessGreen / 3
      share[2] += excessGreen / 3
    }
    // Likewise, missing green is taken from red and blue (see `minStarGreen`).
    const missingGreen = minStarGreen(share[0], share[2]) - share[1]
    if (missingGreen > 0) {
      share[1] += (missingGreen * 2) / 3
      share[0] -= missingGreen / 3
      share[2] -= missingGreen / 3
    }
    // The color of a faint star is measured on few photons and is largely
    // noise: the limit widens with the star signal, from 1.15 for a star a
    // few sky deviations above the background to the full limit from
    // thirty upward.
    if (!saturate) limit = 1.15 + (limit - 1.15) * smoothStep(peak / sigma, 5, 30)
    const qMax = Math.max(...share)
    const qMin = Math.min(...share)
    if (qMax > qMin * limit) {
      const q = (limit - 1) / (qMax - qMin * limit + (limit - 1))
      for (let k = 0; k < 3; k++) share[k] = 1 + (share[k] - 1) * q
    }
    // Each pixel takes that single color, with its own brightness: no more
    // speckle from pixels of different color. The disc extends beyond the
    // measured halo, which would leave out the faintest part; toward the
    // edge the change fades, so as not to leave an outline. On a nebula the
    // halo takes the star's color instead of sliding toward gray: around a
    // bright star it merges with the nebula's light (the blue glow of the
    // Pleiades), which must keep its color. A disc limited to the star alone
    // left colored rings on its edge.
    const disk = tintDisk
    // A few percent of the peak, and at least a few sky deviations: at a
    // fifth of the peak almost all the visible disc of a star, after the
    // stretch, slid toward gray and the stars of a cluster came out white.
    const haloThreshold = Math.max(peak * 0.03, 4 * sigma, 1e-12)
    for (let dy = -disk; dy <= disk; dy++) {
      const yy = cy + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -disk; dx <= disk; dx++) {
        const x = cx + dx
        const d2 = dx * dx + dy * dy
        if (x < 0 || x >= w || d2 > disk * disk) continue
        const i = yy * w + x
        if (done[i]) continue
        const weight = 1 - smoothStep(Math.sqrt(d2) / disk, 0.75, 1)
        // Only the pixels taken in full are closed to the following stars:
        // closing the fading edge too left a nearby star untouched, with
        // the cyan and red sides of its slightly misaligned channels.
        if (weight >= 1) done[i] = 1
        const e0 = planes[0][i] - backgrounds[0]
        const e1 = planes[1][i] - backgrounds[1]
        const e2 = planes[2][i] - backgrounds[2]
        const a = (e0 + e1 + e2) / 3
        // In the faintest halo the tint slides toward gray; where the
        // light is already at the sky level only gray remains, otherwise the
        // colored grain of the halo would reappear as red dots.
        const tint = onSignal ? 1 : a > 0 ? smoothStep(a / haloThreshold, 0, 1) : 0
        const q0 = 1 + (share[0] - 1) * tint
        const q1 = 1 + (share[1] - 1) * tint
        const q2 = 1 + (share[2] - 1) * tint
        planes[0][i] = backgrounds[0] + e0 + (a * q0 - e0) * weight
        planes[1][i] = backgrounds[1] + e1 + (a * q1 - e1) * weight
        planes[2][i] = backgrounds[2] + e2 + (a * q2 - e2) * weight
      }
    }
  }
  releaseLuminance(y, planes)
}
