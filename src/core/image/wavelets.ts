import type { ImageData32 } from '@shared/types'
import { MAD_TO_SIGMA } from './stats'
import { kth } from './selection'
import { sharedValue, copyAndReturn, smoothB3, takeShared, returnShared } from './parallel'
import { localNoiseRatio } from './wedges'

/**
 * Multiscale "à trous" wavelet processing (Starck, Murtagh, "Image
 * restoration with noise suppression using the wavelet transform", A&A
 * 1994; "Astronomical Image and Data Analysis", Springer 2006).
 *
 * The image is decomposed into detail layers: layer 0 holds what changes
 * within a single pixel, layer 1 within two, then four, eight, sixteen;
 * what remains (the residual) is the smooth part. Summing the layers and
 * the residual gives back exactly the image.
 *
 * The advantage is that the noise in stacks is not the same at every
 * scale: interpolated alignment and debayering knead it into clumps of
 * 2-4 pixels, which live in layers 1 and 2. A reduction that looks at the
 * single pixel (NL-Bayes, a light blur) removes the fine grain but leaves
 * the clumps. Here each layer has its own threshold, calibrated on the
 * noise measured in that very layer.
 *
 * In each layer the coefficients that are small relative to the noise are
 * almost certainly noise and are reduced (soft threshold), while the
 * large ones are structure and are kept; each layer can then be given a
 * gain, i.e. more or less sharpness at that scale. Stars are excluded
 * from the gain: amplifying their layers produces dark rings.
 */

/** Number of detail layers (scales of 1, 2, 4, 8, 16 pixels). */
export const WAVELET_LAYERS = 5

export interface WaveletParams {
  /** Per layer, from 0 (no reduction) to 1 (full threshold); layer 0 = 1-pixel scale. */
  noiseReduction: number[]
  /** Per layer, additional gain from -1 (layer removed) to 2 (tripled); 0 = neutral. */
  sharpness: number[]
}

export const NEUTRAL_WAVELETS: WaveletParams = {
  noiseReduction: [0, 0, 0, 0, 0],
  sharpness: [0, 0, 0, 0, 0]
}

/**
 * Noise of each layer for white noise with a deviation of 1 (Starck and
 * Murtagh, table for the two-dimensional B3 transform). The deviation
 * measured in a layer is divided by it to bring it back to the pixel
 * noise: if the noise were independent from pixel to pixel, all layers
 * would give the same value. In stacks, layers 1 and 2 give more, which
 * is the measure of the clumps.
 */
const WHITE_NOISE_LAYER = [0.889, 0.2, 0.086, 0.041, 0.02]

/**
 * Threshold of each layer, in multiples of the noise measured in that
 * layer. On the fine layers it is three deviations (the classic choice:
 * only 0.3% of pure noise passes by chance); the threshold drops as the
 * scale grows, because there the coefficients are largely object
 * structure: with the same threshold the arms of a galaxy would turn
 * into a smooth blotch.
 */
const SIGMA_THRESHOLD = [3, 2.5, 2, 1.5, 1]

/**
 * Overlap rows needed when working in strips: the reach of the
 * decomposition (2·(1+2+4+8+16) = 62 pixels) plus that of the star mask
 * widened for the coarse layers, rounded up. When working in strips, the
 * noise measured on the whole plane must be passed to each strip (see
 * `measureWaveletNoise`), otherwise the thresholds would change from one
 * strip to another.
 */
export const WAVELETS_MARGIN = 128

/**
 * Decomposition of `plane`: calls `layer(j, c, next)` for each detail layer,
 * which is the difference between two successive smoothings (its value at a
 * pixel is `c[i] - next[i]` rounded to single precision, as it would be in a
 * Float32Array), and returns the residual, or null with `keepResidual`
 * false. The residual is a temporary plane from the pool of parallel.ts, to
 * be given back with `returnShared` (`wavelets` returns its own copy).
 *
 * The layers are not kept: on large images five full planes would weigh
 * more than a gigabyte. Whoever needs them again runs the decomposition a
 * second time, which gives exactly the same values.
 */
function decompose(
  plane: Float32Array,
  w: number,
  h: number,
  layer?: (j: number, c: Float32Array, next: Float32Array) => void,
  keepResidual = true
): Float32Array | null {
  // The filter (B3 kernel, 1-4-6-4-1 sixteenths) lives in parallel.ts: with
  // an executor the rows are split among threads, and the vectors must be
  // in shared memory, taken from the pool and returned after use.
  const source = sharedValue(plane)
  let c = source
  for (let j = 0; j < WAVELET_LAYERS; j++) {
    const next = takeShared(w * h)
    smoothB3(c, w, h, 1 << j, next)
    layer?.(j, c, next)
    if (c !== source) returnShared(c)
    c = next
  }
  if (source !== plane) returnShared(source)
  if (keepResidual) return c
  returnShared(c)
  return null
}

/** The noise of the layers is measured on one pixel every this many (see `layerNoise`). */
function noiseStep(n: number): number {
  return Math.max(1, Math.floor(n / 400000))
}

/**
 * Decomposition that keeps, of each layer, only the values at the pixels
 * sampled by `layerNoise`: enough to measure the noise.
 */
function decomposeWithSamples(
  plane: Float32Array,
  w: number,
  h: number
): { residual: Float32Array; samples: Float32Array[] } {
  const n = w * h
  const step = noiseStep(n)
  const count = Math.ceil(n / step)
  const samples: Float32Array[] = []
  const residual = decompose(plane, w, h, (_, c, next) => {
    const s = new Float32Array(count)
    for (let k = 0, i = 0; i < n; k++, i += step) s[k] = c[i] - next[i]
    samples.push(s)
  }) as Float32Array
  return { residual, samples }
}

/** Robust deviation of a sample: MAD with iterative rejection of values beyond 3σ. */
function robustSigma(values: Float32Array): number {
  if (values.length === 0) return 0
  let sample = values
  let sigma = Infinity
  for (let pass = 0; pass < 4; pass++) {
    if (Number.isFinite(sigma)) {
      const limit = 3 * sigma
      let n = 0
      const kept = new Float32Array(sample.length)
      for (let i = 0; i < sample.length; i++) {
        if (Math.abs(sample[i]) < limit) kept[n++] = sample[i]
      }
      if (n < 32) break
      sample = kept.subarray(0, n)
    }
    // Selection instead of sorting: same value, much less work.
    const sortedItems = Float32Array.from(sample)
    const median = kth(sortedItems, sortedItems.length >> 1)
    for (let i = 0; i < sortedItems.length; i++) sortedItems[i] = Math.abs(sortedItems[i] - median)
    const newValue = kth(sortedItems, sortedItems.length >> 1) * MAD_TO_SIGMA
    if (Math.abs(newValue - sigma) < 1e-3 * newValue) {
      sigma = newValue
      break
    }
    sigma = newValue
  }
  return sigma
}

/**
 * Noise of each layer measured on the sky. The sky pixels are the darker
 * half of the smooth residual: there the layers contain almost only noise,
 * and the iterative rejection removes the remaining stars. On a nebula
 * that fills the field, even the darker half has some structure in the
 * coarse layers, which inflates the estimate: this is another reason why
 * the threshold (`SIGMA_THRESHOLD`) is lower there. `samples` are the
 * layer values at one pixel every `noiseStep` (see `decomposeWithSamples`).
 */
function layerNoise(samples: Float32Array[], residual: Float32Array): number[] {
  const n = residual.length
  const step = noiseStep(n)
  const threshold = quantile(residual, 0.5, step)
  const indices: number[] = []
  for (let i = 0, k = 0; i < n; i += step, k++) if (residual[i] <= threshold) indices.push(k)
  const sigma: number[] = []
  for (let j = 0; j < WAVELET_LAYERS; j++) {
    const values = new Float32Array(indices.length)
    for (let k = 0; k < indices.length; k++) values[k] = samples[j][indices[k]]
    const s = robustSigma(values)
    sigma.push(s)
  }
  return sigma
}

function quantile(data: Float32Array, q: number, step: number): number {
  const sample = new Float32Array(Math.ceil(data.length / step))
  let n = 0
  for (let i = 0; i < data.length; i += step) sample[n++] = data[i]
  return kth(sample, Math.min(n - 1, Math.floor(q * n)), n)
}

/**
 * Noise measured in each layer of a linear plane, in the unit of the data.
 * Needed when working in strips: it is measured once on the whole plane
 * and passed to `wavelets` for each strip.
 */
export function measureWaveletNoise(plane: Float32Array, w: number, h: number): number[] {
  const { residual, samples } = decomposeWithSamples(plane, w, h)
  const noise = layerNoise(samples, residual)
  returnShared(residual)
  return noise
}

/**
 * Layer noise brought back to the equivalent pixel noise: for noise that
 * is independent from pixel to pixel all values coincide, for clumpy
 * noise layers 1-2 exceed layer 0.
 */
export function normalizedNoise(noise: number[]): number[] {
  return noise.map((s, j) => s / WHITE_NOISE_LAYER[j])
}

/** Beyond this area (in pixels) a bright cluster is a nebula, not a star. */
const MAX_STAR_AREA = 5000

/** Maximum radius, in pixels, up to which the halo of a star is followed. */
const HALO_MAX = 160

/**
 * Radius at which the halo of a bright star blends into the background.
 * The profile is read along sixteen directions, taking the median at each
 * distance (a neighboring star along one direction does not count); the
 * background is the lowest point of the profile, and the halo ends where
 * the profile comes within twice the noise of it.
 */
function haloRadius(
  plane: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  noise: number
): number {
  const directions = 16
  const values = new Float32Array(directions)
  const profile: number[] = []
  for (let d = Math.ceil(r); d <= HALO_MAX; d++) {
    let k = 0
    for (let a = 0; a < directions; a++) {
      const ang = (2 * Math.PI * a) / directions
      const x = Math.round(cx + d * Math.cos(ang))
      const y = Math.round(cy + d * Math.sin(ang))
      if (x >= 0 && y >= 0 && x < w && y < h) values[k++] = plane[y * w + x]
    }
    if (k < directions / 2) break
    const sortedItems = values.subarray(0, k).sort()
    profile.push(sortedItems[k >> 1])
  }
  if (profile.length === 0) return r
  let background = Infinity
  for (const v of profile) if (v < background) background = v
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] - background < 2 * noise) return Math.ceil(r) + i
  }
  return Math.ceil(r) + profile.length
}

/**
 * Star mask for each layer, from 0 (no star) to 1.
 *
 * Stars are searched for in the overall detail (plane minus residual, i.e.
 * the light that sticks out of the local smooth background, even above a
 * nebula): groups of pixels well above the noise and of limited area; a
 * huge group is the nebula itself and is left out. The gain on a layer
 * produces a ring around a star with the radius of that scale, so for
 * layer j the protected disc is the star disc widened by three times the scale.
 * A faint star produces no visible rings in the coarse layers, where its
 * light is diluted: there it needs no protection, and sharpness is not
 * taken away from its surroundings.
 *
 * The stars are found once (`maskStars`) and the mask of a layer is drawn
 * when that layer is processed (`drawMask`), into a single plane reused
 * for all of them: five full planes would weigh too much on large images.
 * Each mask receives the stars in the same order as before, so the values
 * are the same.
 */
interface MaskStar {
  cx: number
  cy: number
  r: number
  halo: number
  peak: number
}

function maskStars(residual: Float32Array, plane: Float32Array, noise: number[], w: number, h: number): MaskStar[] {
  const n = w * h
  // Temporary planes from the pool of parallel.ts, given back at the end;
  // the stack of the visit is a view of one of them.
  const detail = takeShared(n)
  for (let i = 0; i < n; i++) detail[i] = plane[i] - residual[i]
  let variance = 0
  for (const s of noise) variance += s * s
  const detailNoise = Math.sqrt(variance)

  const stars: MaskStar[] = []
  const seen = new Uint8Array(n)
  const stackPlane = takeShared(n)
  const stack = new Int32Array(stackPlane.buffer, 0, n)
  // A bright star has a halo that at a low threshold extends over thousands
  // of pixels or merges with its neighbors: the search is repeated with
  // progressively higher thresholds, at which its core becomes compact again.
  for (let level = 0; level < 4; level++) {
    const threshold = 8 * 4 ** level * detailNoise
    seen.fill(0)
    for (let i0 = 0; i0 < n; i0++) {
      if (seen[i0] || detail[i0] <= threshold) continue
      let top = 0
      stack[top++] = i0
      seen[i0] = 1
      let area = 0
      let peak = 0
      let sx = 0
      let sy = 0
      let sp = 0
      while (top > 0) {
        const i = stack[--top]
        const x = i % w
        const y = (i - x) / w
        const v = detail[i]
        area++
        if (v > peak) peak = v
        sx += x * v
        sy += y * v
        sp += v
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= h) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= w) continue
            const k = yy * w + xx
            if (seen[k] || detail[k] <= threshold) continue
            seen[k] = 1
            stack[top++] = k
          }
        }
      }
      if (area > MAX_STAR_AREA) continue
      const cx = sx / sp
      const cy = sy / sp
      const r = Math.sqrt(area / Math.PI)
      // Bright stars have a halo extending well beyond the core found: the
      // gain would turn it into concentric circles.
      const halo = peak > 30 * threshold ? haloRadius(plane, w, h, cx, cy, r, detailNoise) : 0
      stars.push({ cx, cy, r, halo, peak })
    }
  }
  returnShared(stackPlane)
  returnShared(detail)
  return stars
}

/** Draws into `m` (overwritten) the star mask of layer `j` (see `maskStars`). */
function drawMask(stars: MaskStar[], j: number, noise: number[], m: Float32Array, w: number, h: number): void {
  m.fill(0)
  const scale = 1 << j
  for (const { cx, cy, r, halo, peak } of stars) {
    // Star light that ends up in the layer: all of it if the star is as
    // wide as the scale, diluted over the scale area if it is smaller.
    const share = Math.min(1, ((r + 1) / scale) ** 2)
    if (peak * share < 3 * noise[j]) continue
    // Three scales: at two, the ring of a bright star fell in the fading
    // edge of the mask, where the gain is only partly removed (a dark ring
    // 24 pixels from a star of IC 434, with the gain on the 8-pixel layer).
    const filled = Math.max(r + 3 * scale + 1, halo + 2 * scale)
    const end = filled + scale + 1
    const x0 = Math.max(0, Math.floor(cx - end))
    const x1 = Math.min(w - 1, Math.ceil(cx + end))
    const y0 = Math.max(0, Math.floor(cy - end))
    const y1 = Math.min(h - 1, Math.ceil(cy + end))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx
        const dy = y - cy
        // Direct square root instead of the much slower Math.hypot: the values are small here.
        const d = Math.sqrt(dx * dx + dy * dy)
        const v = d <= filled ? 1 : d >= end ? 0 : (end - d) / (end - filled)
        const k = y * w + x
        if (v > m[k]) m[k] = v
      }
    }
  }
}

/**
 * Processes a linear plane: per-layer noise reduction and sharpness.
 * `noise` (optional) is the per-layer noise measured on the whole plane,
 * to be passed when processing a strip.
 */
export function wavelets(
  plane: Float32Array,
  w: number,
  h: number,
  p: WaveletParams,
  noise?: number[]
): Float32Array {
  return copyAndReturn(applyWavelets(plane, w, h, p, noise))
}

/**
 * The work of `wavelets`. The result may be a temporary plane from the pool
 * of parallel.ts (to be given back with `returnShared`, which ignores the
 * other arrays).
 */
function applyWavelets(
  plane: Float32Array,
  w: number,
  h: number,
  p: WaveletParams,
  noise?: number[],
  /** Residual of this plane already computed (see `analyzeWavelets`): it is consumed, becoming the output. */
  decomposition?: { residual: Float32Array }
): Float32Array {
  const n = w * h
  const reduction = normalize(p.noiseReduction, 0, 1)
  const gain = normalize(p.sharpness, -1, 2)
  if (w < 2 || h < 2 || (reduction.every((r) => r === 0) && gain.every((g) => g === 0))) {
    // Nothing to do: a residual received is not needed.
    if (decomposition) returnShared(decomposition.residual)
    return plane.slice()
  }

  let residual = decomposition?.residual
  let sigma = noise
  if (!sigma) {
    const d = decomposeWithSamples(plane, w, h)
    sigma = layerNoise(d.samples, d.residual)
    if (residual) returnShared(d.residual)
    else residual = d.residual
  } else if (!residual) residual = decompose(plane, w, h) as Float32Array
  const s = sigma
  const withGain = gain.some((g) => g !== 0)
  const stars = withGain ? maskStars(residual, plane, s, w, h) : []
  // The mask and the noise map are temporary planes from the pool.
  const m = withGain ? takeShared(n) : null

  const ratio = reduction.some((r) => r > 0) ? localNoiseRatio(plane, w, h, takeShared) : null

  // The layers are computed again one at a time (same values as the first
  // decomposition) and added to the residual as they come.
  const output = residual
  decompose(
    plane,
    w,
    h,
    (j, cj, next) => {
      const t = SIGMA_THRESHOLD[j] * s[j]
      const r = reduction[j]
      const g = gain[j]
      if (g !== 0 && m) drawMask(stars, j, s, m, w, h)
      for (let i = 0; i < n; i++) {
        let c = Math.fround(cj[i] - next[i])
        // Dosed soft threshold: the part of the coefficient within the
        // threshold is subtracted, i.e. the value itself if it is small.
        // Where the noise is q times the typical one (under-covered wedges,
        // see wedges.ts) the threshold grows with it and only 1/q of the
        // grain remains compared to elsewhere: in the end the grain is the
        // same across the whole field.
        if (r > 0) {
          const q = ratio !== null ? ratio[i] : 1
          const tq = t * q
          const rq = q > 1 ? 1 - (1 - r) / q : r
          c -= rq * (c > tq ? tq : c < -tq ? -tq : c)
        }
        // Gain excluded where there are stars.
        if (g !== 0 && m) c *= 1 + g * (1 - m[i])
        output[i] += c
      }
    },
    false
  )
  if (m) returnShared(m)
  if (ratio) returnShared(ratio)
  return output
}

function normalize(v: number[], min: number, max: number): number[] {
  const r: number[] = []
  for (let j = 0; j < WAVELET_LAYERS; j++) {
    const x = v[j] ?? 0
    r.push(Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : 0)
  }
  return r
}

/** Rec. 709 luminance (or the single plane). */
/** Rec. 709 luminance (or a copy of the single plane), in a temporary plane from the pool of parallel.ts. */
function luminance(img: ImageData32): Float32Array {
  const n = img.width * img.height
  if (img.channels === 1) {
    const l = takeShared(n)
    l.set(img.data.subarray(0, n))
    return l
  }
  const d = img.data
  const l = takeShared(n)
  for (let i = 0; i < n; i++) l[i] = 0.2126 * d[i] + 0.7152 * d[n + i] + 0.0722 * d[2 * n + i]
  return l
}

/**
 * Wavelet measurements on an image: luminance, its decomposition and the
 * per-layer noise. The automatic finish computes them once and passes
 * them to both the automatic selection and the application, which would
 * otherwise each repeat the same decomposition (almost a second on an
 * eight-megapixel image). Valid for a single application: `imageWavelets`
 * reuses the memory of the residual for the output. The layers are not
 * kept (see `decompose`): the application computes them again. The planes
 * are temporary ones from the pool of parallel.ts: `imageWavelets` gives
 * them back.
 */
export interface WaveletAnalysis {
  luminance: Float32Array
  residual: Float32Array
  noise: number[]
}

export function analyzeWavelets(img: ImageData32): WaveletAnalysis {
  const l = luminance(img)
  const { residual, samples } = decomposeWithSamples(l, img.width, img.height)
  return { luminance: l, residual, noise: layerNoise(samples, residual) }
}

/**
 * Applies the wavelets to the luminance and transfers the correction to
 * the channels in proportion to their value, so the ratio between the
 * channels (the color) does not change. In almost black sky the ratio
 * would be unstable: there the correction becomes the same for all
 * channels, which is neutral for the background color anyway.
 */
export function imageWavelets(
  img: ImageData32,
  p: WaveletParams,
  analysis?: WaveletAnalysis,
  /**
   * If true, the color image is written into the pixels of `img` instead of
   * a new array (each value depends only on the pixel at the same position):
   * the processing chain uses it on images that belong to it alone.
   */
  inPlace = false
): ImageData32 {
  const w = img.width
  const h = img.height
  const n = w * h
  const l = analysis?.luminance ?? luminance(img)
  const newValue = analysis ? applyWavelets(l, w, h, p, analysis.noise, analysis) : applyWavelets(l, w, h, p)
  if (img.channels === 1) {
    returnShared(l)
    const data = copyAndReturn(newValue)
    for (let i = 0; i < n; i++) data[i] = Math.min(1, Math.max(0, data[i]))
    return { width: w, height: h, channels: 1, data }
  }
  // Level below which the ratio between channels is considered unreliable:
  // a few times the sky noise.
  const eps = Math.max(1e-6, 3 * measurePixelNoise(l))
  const data = inPlace ? img.data : new Float32Array(img.data.length)
  for (let i = 0; i < n; i++) {
    const delta = newValue[i] - l[i]
    const den = Math.max(0, l[i]) + eps
    for (let k = 0; k < 3; k++) {
      const c = img.data[k * n + i]
      const v = c + (delta * (Math.max(0, c) + eps)) / den
      data[k * n + i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  // The temporary planes go back to the pool (`returnShared` ignores those
  // that do not come from it).
  returnShared(newValue)
  returnShared(l)
  return { width: w, height: h, channels: 3, data }
}

/** Pixel noise from the differences between neighbors, robust to stars. */
function measurePixelNoise(l: Float32Array): number {
  const step = Math.max(1, Math.floor(l.length / 200000))
  const d = new Float32Array(Math.ceil(l.length / step))
  let k = 0
  for (let i = 0; i + 1 < l.length; i += step) d[k++] = Math.abs(l[i + 1] - l[i])
  const o = d.subarray(0, k).sort()
  return (o[k >> 1] * MAD_TO_SIGMA) / Math.SQRT2
}

/**
 * Starting reduction and sharpness for the automatic finish, calibrated on
 * M 33, M 27 and NGC 7000. Deliberately light: after NL-Bayes a strong
 * reduction on the large layers (0.7 0.8 0.7 0.5 0.2) would leave the
 * background and the object blotchy, like a watercolor, and a sharpness
 * up to 0.5 on the 2-8 pixel layers, on faint data, would turn the
 * residual grain into worms. A little fine grain is better than plastic.
 * Even 0.5 0.35 0.2 0.1 on the layers from 2 pixels up, tested one tool at
 * a time on M 42, M 45 and the Rosette, left blotches in the background and
 * swollen stars: the reduction now stays on the finest layers.
 */
const AUTOMATIC_REDUCTION = [0.4, 0.25, 0.1, 0, 0]
const AUTO_SHARPNESS = [0, 0, 0.18, 0.25, 0.2]

/**
 * Automatic parameters for the automatic finish.
 *
 * The noise of each layer is measured and brought back to the pixel noise
 * (`normalizedNoise`): with noise independent from pixel to pixel, layer 1
 * would give the same value as layer 0, while in stacks it gives three to
 * seven times as much, which is the measure of the clumps. The more
 * clumps, the firmer the reduction on layers 1-3; with fine, independent
 * noise the work is mostly on layer 0 and the others are left alone.
 * Sharpness is moderate and goes to the medium structures (4-32 pixels),
 * where the arms of galaxies and the filaments of nebulae lie; the
 * one-pixel layer receives no gain because it is mostly noise.
 */
export function automaticWavelets(img: ImageData32, analysis?: WaveletAnalysis): WaveletParams {
  let noise = analysis?.noise
  if (!noise) {
    const l = luminance(img)
    noise = measureWaveletNoise(l, img.width, img.height)
    returnShared(l)
  }
  const norm = normalizedNoise(noise)
  const lumps = norm[0] > 0 ? norm[1] / norm[0] : 1
  // From 0.6 (independent noise) to 1 (strong clumps, five times or more).
  const factor = Math.min(1, Math.max(0.6, 0.6 + (0.4 * (lumps - 1)) / 4))
  const round = (x: number): number => Math.round(x * 100) / 100
  return {
    noiseReduction: AUTOMATIC_REDUCTION.map((r, j) => round(j === 0 ? r : r * factor)),
    sharpness: AUTO_SHARPNESS.slice()
  }
}
