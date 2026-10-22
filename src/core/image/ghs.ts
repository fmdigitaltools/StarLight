import type { ImageData32 } from '@shared/types'
import { computeStats, MAD_TO_SIGMA } from './stats'
import { blur } from './cleanup'

/**
 * Generalized Hyperbolic Stretch (GHS), by Mike Cranfield and Dave Payne.
 *
 * The classic stretch (black point + midtones) has a single lever: it
 * lifts all the faint signal together, sky included. GHS instead lets you
 * choose WHERE to concentrate the contrast: around the symmetry point SP
 * the curve is steeper (nearby levels are pushed apart and faint
 * structures become readable), while far from SP it flattens. With SP
 * just above the sky, the body of the object is lifted without
 * brightening the background, and with highlight protection (HP) the
 * core does not burn out.
 *
 * The five parameters:
 * - D (strength): how steep the curve is at SP. e^D - 1 is used, as in
 *   the original implementations, so that the 0..10 slider has a uniform
 *   response.
 * - b (local intensity): how much the contrast stays concentrated around
 *   SP. b = 0 is the exponential curve, b > 0 is hyperbolic (ever
 *   narrower around SP), b < 0 is gentler, b = -1 is logarithmic.
 * - SP (symmetry point): the level at which the curve is steepest.
 * - LP (shadow protection): below LP the curve becomes a straight line,
 *   so as not to crush the sky and the noise below SP too much.
 * - HP (highlight protection): above HP the curve becomes a straight
 *   line, so the bright parts keep their contrast instead of flattening
 *   toward white.
 *
 * The result is rescaled so that 0 stays 0 and 1 stays 1; the curve is
 * continuous, with a continuous derivative, and always increasing.
 */

export interface GhsParams {
  /** Strength D, 0..10 (0 = no effect). */
  strength: number
  /** Local intensity b, -5..15. */
  localIntensity: number
  /** Symmetry point SP, 0..1. */
  symmetryPoint: number
  /** Shadow protection LP, 0..SP. */
  shadowProtection: number
  /** Highlight protection HP, SP..1. */
  highlightProtection: number
}

/** Zero strength: the curve coincides with the diagonal. */
export const NEUTRAL_GHS: GhsParams = {
  strength: 0,
  localIntensity: 0,
  symmetryPoint: 0,
  shadowProtection: 0,
  highlightProtection: 1
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/**
 * Prepares the curve once: returns the ready-made function, with all the
 * constants computed, or null if the curve is the identity.
 */
function prepareCurve(p: GhsParams): ((x: number) => number) | null {
  const dUser = clamp(Number.isFinite(p.strength) ? p.strength : 0, 0, 10)
  if (dUser <= 1e-9) return null
  const D = Math.expm1(dUser)
  const b = clamp(Number.isFinite(p.localIntensity) ? p.localIntensity : 0, -5, 15)
  const SP = clamp(p.symmetryPoint, 0, 1)
  const LP = clamp(p.shadowProtection, 0, SP)
  const HP = clamp(p.highlightProtection, SP, 1)

  // Base curve T(t) and its slope T'(t), with t = distance from SP (t >= 0).
  // log1p and expm1 are used to stay accurate near the transition cases
  // (b close to 0 or to -1), where the formulas tend toward one another.
  let T: (t: number) => number
  let dT: (t: number) => number
  if (Math.abs(b + 1) < 1e-7) {
    // Logarithmic.
    T = (t) => Math.log1p(D * t)
    dT = (t) => D / (1 + D * t)
  } else if (Math.abs(b) < 1e-7) {
    // Exponential.
    T = (t) => -Math.expm1(-D * t)
    dT = (t) => D * Math.exp(-D * t)
  } else if (b < 0) {
    // Integral of the slope D (1 - b D t)^(1/b): gentler than the exponential.
    const e = (b + 1) / b
    T = (t) => -Math.expm1(e * Math.log1p(-b * D * t)) / (b + 1)
    dT = (t) => D * Math.exp(Math.log1p(-b * D * t) / b)
  } else {
    // Hyperbolic: slope D (1 + b D t)^(-(1+b)/b), concentrated on SP.
    T = (t) => -Math.expm1((-1 / b) * Math.log1p(b * D * t))
    dT = (t) => D * Math.exp((-(1 + b) / b) * Math.log1p(b * D * t))
  }

  // Values and slopes at the two joints with the protection lines.
  const tShadows = SP - LP
  const tHighlights = HP - SP
  const shadowsValue = -T(tShadows)
  const shadowsSlope = dT(tShadows)
  const highlightsValue = T(tHighlights)
  const highlightsSlope = dT(tHighlights)

  const rawValue = (x: number): number => {
    if (x < LP) return shadowsValue - shadowsSlope * (LP - x)
    if (x < SP) return -T(SP - x)
    if (x < HP) return T(x - SP)
    return highlightsValue + highlightsSlope * (x - HP)
  }

  const zero = rawValue(0)
  const scale = rawValue(1) - zero
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  const inv = 1 / scale
  return (x: number) => {
    if (!(x > 0)) return 0
    if (x >= 1) return 1
    const y = (rawValue(x) - zero) * inv
    return y < 0 ? 0 : y > 1 ? 1 : y
  }
}

/** Applies GHS to a value already normalized between the black and white points. */
export function ghs(x: number, p: GhsParams): number {
  const f = prepareCurve(p)
  if (f === null) return clamp(x, 0, 1)
  return f(x)
}

/** Lookup table: LUT[i] = ghs(i / (n - 1)). */
export function buildGhsLut(p: GhsParams, size = 4096): Float32Array {
  const n = Math.max(2, Math.floor(size))
  const lut = new Float32Array(n)
  const f = prepareCurve(p)
  const last = n - 1
  for (let i = 0; i < n; i++) lut[i] = f === null ? i / last : f(i / last)
  return lut
}

// ---------------------------------------------------------------------------
// Automatic parameter selection
// ---------------------------------------------------------------------------

/** Levels measured on the image, already normalized between black and white. */
export interface GhsMeasurements {
  /** Sky background (median). */
  sky: number
  /** Sky noise at full resolution (sigma). */
  noise: number
  /** Residual noise on the reduced, star-free map. */
  noiseMap: number
  /** First signal: where the extended object starts to stand out from the sky. */
  firstSignal: number
  /** Body of the extended object (typical level of its parts). */
  body: number
  /** Brightest parts of the extended object (core, center). */
  core: number
  /** Fraction of the image occupied by the extended object. */
  objectFraction: number
  /** Level of the brightest stars (a few pixels out of ten thousand). */
  stars: number
}

function percentile(sortedItems: Float32Array, q: number): number {
  if (sortedItems.length === 0) return 0
  return sortedItems[Math.min(sortedItems.length - 1, Math.max(0, Math.floor(q * (sortedItems.length - 1))))]
}

/** Median over a square window: removes the stars and keeps the wide structures. */
function medianFilter(p: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(p.length)
  const side = 2 * r + 1
  const window = new Float32Array(side * side)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx
          window[k++] = p[yy * w + xx]
        }
      }
      window.sort()
      out[y * w + x] = window[(k - 1) >> 1]
    }
  }
  return out
}

/**
 * Measures the sky, the noise and the levels of the extended object on the
 * luminance (mean of the channels, like the color-preserving stretch).
 * The extended structures are measured on a reduced copy, filtered with a
 * median that erases the stars and then blurred: this way a bright star
 * is not mistaken for the core of a galaxy.
 */
export function measureGhs(image: ImageData32, black: number, white: number): GhsMeasurements {
  const { width: w, height: h, channels, data } = image
  const n = w * h
  const interval = Math.max(1e-6, white - black)
  const inv = 1 / (interval * channels)

  // Normalized luminance (unclipped, so the noise is measured correctly).
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < channels; c++) s += data[c * n + i]
    lum[i] = s * inv - black / interval
  }
  const statistics = computeStats(lum)
  const sky = statistics.median
  const noise = Math.max(1e-7, statistics.mad * MAD_TO_SIGMA)

  // Bright stars: look at the high tail of a pixel sample.
  const sampleStep = Math.max(1, Math.floor(n / 400000))
  const sample = new Float32Array(Math.floor(n / sampleStep))
  for (let i = 0; i < sample.length; i++) sample[i] = lum[i * sampleStep]
  sample.sort()
  const stars = percentile(sample, 0.9995)

  // Copy reduced to about 250 thousand pixels, by averaged blocks.
  const f = Math.max(1, Math.round(Math.sqrt(n / 250000)))
  const wr = Math.max(1, Math.floor(w / f))
  const hr = Math.max(1, Math.floor(h / f))
  const reduced = new Float32Array(wr * hr)
  const area = 1 / (f * f)
  for (let y = 0; y < hr; y++) {
    for (let x = 0; x < wr; x++) {
      let s = 0
      for (let dy = 0; dy < f; dy++) {
        const o = (y * f + dy) * w + x * f
        for (let dx = 0; dx < f; dx++) s += lum[o + dx]
      }
      reduced[y * wr + x] = s * area
    }
  }
  const map = blur(medianFilter(reduced, wr, hr, 2), wr, hr, 2)

  const mapStats = computeStats(map)
  const noiseMap = Math.max(1e-7, mapStats.mad * MAD_TO_SIGMA)
  const skyMap = mapStats.median

  // Extended object: whatever lies clearly above the sky on the clean map.
  const threshold = skyMap + 3 * noiseMap
  let tally = 0
  for (let i = 0; i < map.length; i++) if (map[i] > threshold) tally++
  const object = new Float32Array(tally)
  tally = 0
  for (let i = 0; i < map.length; i++) if (map[i] > threshold) object[tally++] = map[i]
  object.sort()

  return {
    sky,
    noise,
    noiseMap,
    firstSignal: threshold,
    body: tally > 0 ? percentile(object, 0.5) : threshold,
    core: tally > 0 ? percentile(object, 0.995) : threshold,
    objectFraction: tally / map.length,
    stars
  }
}

/** Brightness to which the sky background is brought: dark but not absolute black. */
const FINAL_SKY = 0.05
/** Tolerated deviation on the sky: anything between 0.04 and 0.06 is fine. */
const SKY_TOLERANCE = 0.01
/** Desired level for the body of the extended object. */
const IDEAL_BODY = 0.4
/** Desired level for the brightest parts of the object. */
const IDEAL_CORE = 0.75
/** Ceiling for the core: above it, it would burn out and lose detail. */
const MAX_CORE = 0.85
/** Bright stars must reach at least this level, or the image stays dull. */
const MIN_STARS = 0.7
/**
 * Maximum output value of the noise (one sigma).
 * If the curve is steeper than the noise, every pixel ends up black or
 * light at random and the object breaks up into specks: a slightly less
 * bright but smooth object is better. The noise is measured on the image
 * as received: if it has already been cleaned, the curve can be firmer.
 */
const MAX_NOISE = 0.08

/**
 * Levels sought by the automatic selection. The default ones serve the
 * button in the Correct step; the automatic finish passes its own (see
 * abracadabraFinish.ts), with a lighter sky and a more firmly protected
 * core.
 */
export interface GhsTargets {
  sky: number
  body: number
  core: number
  maxCore: number
  /** Weight of the penalty when the core exceeds the ceiling. */
  coreWeight: number
  maxNoise: number
  /**
   * Linear level of the sky background, if the caller measured it itself.
   * Without it, the sky is the image median: right when the sky fills
   * most of the field, not with a nebula that fills it (the median would
   * fall on the nebula and the dark areas would go to black).
   */
  linearSky?: number
}

export const GHS_TARGETS: GhsTargets = {
  sky: FINAL_SKY,
  body: IDEAL_BODY,
  core: IDEAL_CORE,
  maxCore: MAX_CORE,
  coreWeight: 4,
  maxNoise: MAX_NOISE
}

/**
 * Chooses D, b, SP, LP and HP by measuring the image.
 *
 * - SP goes just above the sky, where the object's signal begins: there
 *   the curve is steepest and the contrast concentrates on the faint
 *   structures (arms, nebulosity). The sky stays below SP, in the part
 *   where the curve compresses, and therefore remains dark and smooth.
 * - Many combinations of D, b, SP and HP are tried, and the one that
 *   brings the body of the object closest to the desired level while
 *   satisfying the constraints is kept: sky around 0.05, noise not
 *   exaggerated, core below the ceiling, bright stars still brilliant.
 * - The noise constraint is usually the deciding one: if the body of the
 *   object is only a few sigma above the sky, no curve can brighten it
 *   much without also brightening the grain. On an already cleaned image
 *   (NL-Bayes) the margin is larger and the curve firmer.
 * - HP above the core: beyond HP the curve becomes a straight line and the
 *   brightest parts are not crushed against white.
 *
 * The black and white points have already been chosen: here the work is
 * on the values normalized between the two. The image must be passed
 * as it will be stretched (after any noise reduction).
 */
export function automaticGhs(
  image: ImageData32,
  black: number,
  white: number,
  o: GhsTargets = GHS_TARGETS
): GhsParams {
  const m = measureGhs(image, black, white)
  const sky = clamp(
    o.linearSky !== undefined ? (o.linearSky - black) / Math.max(1e-6, white - black) : m.sky,
    0,
    0.98
  )
  const sigma = m.noise
  const stars = Math.max(m.stars, m.core)

  // How good a curve is: closeness to the desired levels, plus penalties
  // for the constraints not met. Null if the sky is completely off.
  const evaluate = (p: GhsParams): number | null => {
    const f = prepareCurve(p)
    if (f === null) return null
    const skyDeviation = Math.abs(f(sky) - o.sky)
    if (skyDeviation > SKY_TOLERANCE * 3) return null
    const outBody = f(m.body)
    const outCore = f(m.core)
    const outStars = f(stars)
    // The noise grows most where the curve is steepest, i.e. around SP.
    let noise = 0
    for (const x of [sky, p.symmetryPoint, m.body]) {
      noise = Math.max(noise, (f(x + sigma) - f(Math.max(0, x - sigma))) / 2)
    }
    let s = -Math.abs(outBody - o.body) - 0.5 * Math.abs(outCore - o.core)
    s -= 0.5 * skyDeviation
    if (skyDeviation > SKY_TOLERANCE) s -= 10 * (skyDeviation - SKY_TOLERANCE)
    if (outCore > o.maxCore) s -= o.coreWeight * (outCore - o.maxCore)
    if (outStars < MIN_STARS) s -= 2 * (MIN_STARS - outStars)
    if (noise > o.maxNoise) s -= 10 * (noise - o.maxNoise)
    return s
  }

  let best: GhsParams = NEUTRAL_GHS
  let score = -Infinity
  for (const kSP of [0, 0.5, 1, 1.5, 2, 3, 4, 6]) {
    const SP = clamp(sky + kSP * sigma, 0, 0.98)
    for (const lp of [0, sky - 3 * sigma, sky]) {
      const LP = clamp(lp, 0, SP)
      for (const b of [0, 0.5, 1, 2, 3, 4, 6, 8, 11, 15]) {
        // HP above the core (multiples of its level) or no protection.
        for (const kHP of [1, 1.5, 2, 4, 8, 0]) {
          const HP = kHP === 0 ? 1 : clamp(m.core * kHP, SP, 1)
          for (let D = 0.5; D <= 10.0001; D += 0.25) {
            const p: GhsParams = {
              strength: D,
              localIntensity: b,
              symmetryPoint: SP,
              shadowProtection: LP,
              highlightProtection: HP
            }
            const s = evaluate(p)
            if (s !== null && s > score) {
              score = s
              best = p
            }
          }
        }
      }
    }
  }

  // Refine the strength around the best choice, in fine steps.
  const base = best
  for (let D = Math.max(0.05, base.strength - 0.25); D <= Math.min(10, base.strength + 0.25); D += 0.025) {
    const p = { ...base, strength: D }
    const s = evaluate(p)
    if (s !== null && s > score) {
      score = s
      best = p
    }
  }
  return best
}
