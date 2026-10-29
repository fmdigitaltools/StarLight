import type { ImageData32 } from '@shared/types'
import { clean, blur, FULL_CLEANUP, type CleanupResult } from './cleanup'
import { extractRbfBackground, autoRbfBackground, DEFAULT_RBF_BACKGROUND, type RbfBackgroundParams } from './rbfBackground'
import { applyGains } from './photometry'
import { wedgeMap, equalizeWedgeBackground, findWedges, type WedgeMap } from './wedges'
import {
  deconvolve,
  automaticDeconvolution,
  NEUTRAL_DECONVOLUTION,
  type DeconvolutionParams
} from './deconvolution'
import {
  analyzeWavelets,
  measureWaveletNoise,
  wavelets,
  imageWavelets,
  automaticWavelets,
  NEUTRAL_WAVELETS,
  type WaveletParams
} from './wavelets'
import {
  analyzeStars,
  reduceStars,
  releaseStarAnalysis,
  automaticStarReduction,
  NEUTRAL_STAR_REDUCTION,
  type StarReductionParams
} from './starReduction'
import {
  localContrast,
  automaticLocalContrast,
  NEUTRAL_LOCAL_CONTRAST,
  type LocalContrastParams
} from './localContrast'
import { removeTrails, automaticTrails, NEUTRAL_TRAILS, type TrailsParams, type ProtectedZone } from './trails'
import {
  narrowband,
  extractBands,
  NARROWBAND_NEUTRAL,
  type ExtractedBands,
  type NarrowbandParams
} from './narrowband'
import type { ActivePlugin } from '../plugin/manifest'

/**
 * Data processing chain.
 *
 * Unlike the adjustments of the Correct panel, which the GPU recomputes at
 * every slider movement, these tools transform the data and take from a
 * few tenths of a second to a few seconds each. They are therefore all run
 * together, in the order an astrophotographer applies them, always
 * starting from the original image: changing a parameter and reapplying
 * does not accumulate processing, and "Reset" returns to the original.
 *
 * Order matters. Defects are removed first (hot pixels, satellite trails,
 * sky background), then the color is fixed, then sharpness is recovered
 * (deconvolution wants data that is still noisy but free of background),
 * then the noise is reduced, and only at the end is the appearance
 * adjusted: stars and local contrast.
 *
 * The chain is split into three stages because the second, NL-Bayes, is
 * distributed over several workers and driven by the interface process;
 * the first and the third each run in one worker.
 *
 * With narrowband (dual-band filter, palette other than "natural") the
 * color is not smoothed in the first stage, and right after it (and after
 * deconvolution) the image is separated into H-alpha and OIII: NL-Bayes
 * and the wavelets clean each band on its own, then the palette is
 * recomposed. Working on the brightness, which with that filter is almost
 * all H-alpha, would copy its details into the OIII.
 */

export type BackgroundMode = 'none' | 'simple' | 'rbf'
export type BalanceMode = 'none' | 'stars' | 'photometric'

export interface ProcessingParams {
  hotPixels: boolean
  /** Airplane and satellite trails on a single frame. */
  trails: TrailsParams
  background: BackgroundMode
  rbfBackground: RbfBackgroundParams
  /**
   * With the sky background on, evens out the sky of the wedges poorly
   * covered by field rotation (see wedges.ts). It can be turned off for
   * data with very little grain, where the detail of an object could be
   * taken for a wedge.
   */
  wedgeEqualization: boolean
  balance: BalanceMode
  /** Gains from the photometric calibration, computed on request. */
  photometricGains: [number, number, number] | null
  /** Colored grain and star color, from 0 to 1. */
  colorNoise: number
  deconvolution: DeconvolutionParams
  /** Strength of the NL-Bayes noise reduction, from 0 (off) to 1. */
  nlBayes: number
  wavelets: WaveletParams
  /**
   * Narrowband palette for files taken with the dual-band filter
   * (see narrowband.ts). 'natural' keeps it off.
   */
  narrowband: NarrowbandParams
  starReduction: StarReductionParams
  localContrast: LocalContrastParams
  /**
   * Plugins chosen in the Process step ("Extra tools"), run after the
   * third stage in list order, each in its own isolated worker (see
   * useProcessing.ts). Disabled ones are kept only to remember their values.
   */
  plugin: ActivePlugin[]
  /**
   * Only for the automatic choice (see `abracadabraProcessing`): multiplies
   * the doses chosen by measuring the image. Removed from the parameters
   * returned by `thirdStage`, so it never reaches the interface or a project.
   */
  automaticStrength?: number
}

export const NEUTRAL_PROCESSING: ProcessingParams = {
  hotPixels: false,
  trails: NEUTRAL_TRAILS,
  background: 'none',
  rbfBackground: DEFAULT_RBF_BACKGROUND,
  wedgeEqualization: true,
  balance: 'none',
  photometricGains: null,
  colorNoise: 0,
  deconvolution: NEUTRAL_DECONVOLUTION,
  nlBayes: 0,
  wavelets: NEUTRAL_WAVELETS,
  narrowband: NARROWBAND_NEUTRAL,
  starReduction: NEUTRAL_STAR_REDUCTION,
  localContrast: NEUTRAL_LOCAL_CONTRAST,
  plugin: []
}

/**
 * True if a narrowband palette is chosen: the chain then treats H-alpha
 * and OIII separately (no smoothing of the colored grain in the first
 * stage, noise reduction band by band).
 */
export function narrowbandActive(p: ProcessingParams): boolean {
  return p.narrowband.palette !== 'natural'
}

/** True if the chain would change nothing. */
export function neutralProcessing(p: ProcessingParams): boolean {
  return pluginsToRun(p).length === 0 && internalNeutralProcessing(p)
}

/** True if the built-in tools, plugins excluded, would change nothing. */
export function internalNeutralProcessing(p: ProcessingParams): boolean {
  return JSON.stringify({ ...p, plugin: [] }) === JSON.stringify(NEUTRAL_PROCESSING)
}

/** Plugins to run, in the order in which they were enabled. */
export function pluginsToRun(p: ProcessingParams): ActivePlugin[] {
  return (p.plugin ?? []).filter((x) => x.active)
}

/**
 * Parameters used by the automatic finish before the measurements: the
 * tools with an automatic choice are then dosed on the image during
 * execution (see the `automatic` argument of the stages).
 */
export const ABRACADABRA_PROCESSING: ProcessingParams = {
  ...NEUTRAL_PROCESSING,
  hotPixels: true,
  trails: { ...NEUTRAL_TRAILS, active: true },
  background: 'rbf',
  balance: 'stars',
  colorNoise: 1,
  // NL-Bayes at a third: full reduction, on the clumpy grain of stacks,
  // leaves a worm-like, blotchy pattern (the plastic look); even at half,
  // compared at 100% with the plain stretch on opening, the background
  // looked clumpier and faint stars were lost. Most of the fine grain
  // remains, which the eye reads as natural.
  nlBayes: 0.3
}

/** How hard Abracadabra works: lighter on data that is already clean, heavier on very noisy data. */
export type AbracadabraStrength = 'gentle' | 'balanced' | 'strong'
export const ABRACADABRA_STRENGTHS: readonly AbracadabraStrength[] = ['gentle', 'balanced', 'strong']

/**
 * Factor on the doses of the tools that change the look (color grain,
 * NL-Bayes, deconvolution, wavelets, star reduction, local contrast,
 * saturation). Defects, sky background and color balance are corrections,
 * not a matter of taste, and stay the same. "Balanced" is the measured
 * choice; "strong" stops at 1.4 because beyond it the wavelets and local
 * contrast leave halos and the noise reduction a plastic look.
 */
export const STRENGTH_FACTOR: Record<AbracadabraStrength, number> = { gentle: 0.5, balanced: 1, strong: 1.4 }

/** Parameters of Abracadabra at the chosen strength. */
export function abracadabraProcessing(strength: AbracadabraStrength = 'balanced'): ProcessingParams {
  const f = STRENGTH_FACTOR[strength]
  if (f === 1) return ABRACADABRA_PROCESSING
  return {
    ...ABRACADABRA_PROCESSING,
    colorNoise: Math.min(1, ABRACADABRA_PROCESSING.colorNoise * f),
    nlBayes: Math.min(1, ABRACADABRA_PROCESSING.nlBayes * f),
    automaticStrength: f
  }
}

/** Measurements of the first stage, for the report and the crop. */
export type FirstStageMeasurements = Pick<
  CleanupResult,
  'correctedPixels' | 'edges' | 'starGains' | 'hfr'
> & {
  backgroundUnevenness: number
  /** Satellite trails found and reconstructed. */
  trails: number
  /**
   * Poorly covered wedges from field rotation (see wedges.ts), measured
   * before any noise reduction, for the crop suggestion; null if there are
   * none. Missing in measurements saved by earlier versions.
   */
  wedges?: WedgeMap | null
}

/**
 * First stage: defects, sky background, color, deconvolution.
 * With `automatic` the background and deconvolution parameters are chosen
 * by measuring the image; the ones actually used are returned, so the
 * interface can show them and they stay editable.
 */
export function firstStage(
  original: ImageData32,
  p: ProcessingParams,
  automatic: boolean,
  /** If true, deconvolution is chosen but not applied: the caller runs it, in parallel. */
  externalDeconvolution = false,
  /**
   * Catalog galaxies and nebulae with their position in the frame (if
   * there is an astrometric solution): a trace that lies inside one of
   * them and follows its axis is not taken for a trail (see trails.ts).
   */
  protectedZones: ProtectedZone[] = [],
  /**
   * If true, `original` belongs to the caller alone and its pixels become
   * the result: the chain worker receives its own copy and so saves one.
   * Otherwise `original` is not touched. The result is the same.
   */
  inPlace = false
): { image: ImageData32; parameters: ProcessingParams; measurements: FirstStageMeasurements } {
  const usedValues = { ...p }

  // Hot pixels and simple background; it also measures the noisy edges.
  // From here on the image belongs to this function (a copy, or the
  // original given in place) and every tool works on its pixels: on large
  // images a new full copy per tool would weigh gigabytes.
  const a = clean(
    original,
    {
      ...FULL_CLEANUP,
      hotPixels: p.hotPixels,
      background: p.background === 'simple',
      colorNoise: 0,
      lightNoise: 0,
      balanceStars: false,
      sharpness: 0
    },
    inPlace
  )
  let image = a.image
  let unevenness = a.backgroundUnevenness

  // Satellite trails, right after the hot pixels: they are a frame defect
  // like those, and a bright trail left in place would skew the advanced
  // background model and the color measured on the stars. The simple
  // background is computed in the same pass as the hot pixels and so comes
  // first, but it is a soft surface that a thin trail does not shift.
  let trails = 0
  if (p.trails.active) {
    if (automatic) usedValues.trails = automaticTrails(image)
    const r = removeTrails(image, usedValues.trails, protectedZones, true)
    image = r.image
    trails = r.trails.length
  }

  if (p.background === 'rbf') {
    if (automatic) usedValues.rbfBackground = autoRbfBackground(image)
    const r = extractRbfBackground(image, usedValues.rbfBackground, true)
    image = r.image
    unevenness = r.unevenness
  }

  if (p.balance === 'photometric' && p.photometricGains) {
    image = applyGains(image, p.photometricGains)
  }

  // Color: balance on the stars, colored grain, star color. With
  // narrowband the colored grain is not smoothed: the smoothing leaves the
  // details to the brightness alone, which with the dual-band filter is
  // almost all H-alpha, and green and blue would copy its structure,
  // making it impossible to separate the OIII. The grain of the two bands
  // is removed afterwards, band by band (see `thirdStage`). The star
  // corrections (colored dots, tint) stay.
  const b = clean(
    image,
    {
      ...FULL_CLEANUP,
      hotPixels: false,
      background: false,
      colorNoise: p.colorNoise,
      lightNoise: 0,
      balanceStars: p.balance === 'stars',
      sharpness: 0,
      onlyStarColor: narrowbandActive(p)
    },
    true
  )
  image = b.image

  // Field-rotation wedges, for the crop suggestion: measured here, on the
  // still intact grain (see wedges.ts).
  const wedges = withWedges(p) ? wedgeMap(image) : null

  if (automatic) {
    const d = automaticDeconvolution(image)
    const f = p.automaticStrength ?? 1
    usedValues.deconvolution = f === 1 ? d : { ...d, iterations: Math.min(50, Math.round(d.iterations * f)) }
  }
  if (!externalDeconvolution && usedValues.deconvolution.iterations > 0) {
    image = deconvolve(image, usedValues.deconvolution, undefined, true)
  }

  return {
    image,
    parameters: usedValues,
    measurements: {
      correctedPixels: a.correctedPixels,
      edges: a.edges,
      starGains: b.starGains,
      hfr: b.hfr,
      backgroundUnevenness: unevenness,
      trails,
      wedges
    }
  }
}

/**
 * Third stage: clumpy noise and per-scale sharpness, narrowband, stars,
 * local contrast.
 *
 * With narrowband (see `narrowbandActive`) the wavelets work on the two
 * separate bands instead of the brightness (see `bandsToPalette`).
 * `bands` are those already extracted, and cleaned by NL-Bayes, by the
 * caller; if missing they are extracted here, taking into account the
 * color balance gains (`colorGains`, see `chainColorGains`).
 */
export function thirdStage(
  image: ImageData32,
  p: ProcessingParams,
  automatic: boolean,
  bands?: ExtractedBands,
  colorGains?: readonly [number, number, number],
  /**
   * If true, `image` belongs to the caller alone and its pixels become the
   * result: the chain worker receives it transferred and so saves a copy.
   * Otherwise `image` is not touched. The result is the same.
   */
  inPlace = false
): { image: ImageData32; parameters: ProcessingParams } {
  const usedValues = { ...p }
  // From here on the image belongs to this function (a copy, or the input
  // given in place) and the tools work on its pixels: on large images a new
  // full copy per tool would weigh gigabytes. Measurements no longer needed
  // are dropped as soon as possible for the same reason.
  let im = inPlace ? image : { ...image, data: image.data.slice() }
  // Poorly covered wedges from field rotation (see wedges.ts): they are
  // searched for here, before noise reduction confuses them with the rest.
  // The wavelets even out their grain, then their sky is evened out, which
  // the background model, a soft surface, does not follow across its
  // sharp step.
  const wedges = withWedges(p) ? findWedges(im) : null
  const f = automatic ? (p.automaticStrength ?? 1) : 1
  if (narrowbandActive(usedValues) && im.channels === 3) {
    im = bandsToPalette(im, usedValues, automatic, bands, colorGains)
  } else {
    // With the automatic choice the wavelet and star measurements are
    // needed twice on the same image (to choose and to apply): they are
    // taken once, the result is the same.
    let measurements = automatic ? analyzeWavelets(im) : undefined
    if (measurements) usedValues.wavelets = strongerWavelets(automaticWavelets(im, measurements), f)
    im = imageWavelets(im, usedValues.wavelets, measurements, true)
    measurements = undefined
  }
  if (wedges !== null) im = equalizeWedgeBackground(im, wedges, true).image
  let starMeasurements = automatic ? analyzeStars(im) : undefined
  if (starMeasurements) {
    // The automatic finish reduces stars with a light hand and does not
    // lower their brightness: in a finished image the stars stay full.
    // The full reduction remains available by hand in the Process step.
    const choice = automaticStarReduction(im, starMeasurements)
    usedValues.starReduction = { quantity: Math.min(1, Math.round(choice.quantity * 50 * f) / 100), attenuation: 0 }
  }
  if (usedValues.starReduction.quantity > 0 || usedValues.starReduction.attenuation > 0) {
    im = reduceStars(im, usedValues.starReduction, starMeasurements, true)
  }
  if (starMeasurements) releaseStarAnalysis(starMeasurements)
  starMeasurements = undefined
  if (automatic) {
    const c = automaticLocalContrast(im)
    usedValues.localContrast = { ...c, strength: Math.min(1, c.strength * f) }
  }
  if (usedValues.localContrast.strength > 0) im = localContrast(im, usedValues.localContrast, true)
  // The strength has done its job: the values chosen stay editable by hand.
  delete usedValues.automaticStrength
  return { image: im, parameters: usedValues }
}

/** True if the wedges are searched for and evened out (see `wedgeEqualization`). */
function withWedges(p: ProcessingParams): boolean {
  // Parameters saved before the switch existed have no value: on, as then.
  return p.background !== 'none' && p.wedgeEqualization !== false
}

/** Automatic wavelets at the chosen strength (see `STRENGTH_FACTOR`). */
function strongerWavelets(w: WaveletParams, f: number): WaveletParams {
  if (f === 1) return w
  return {
    noiseReduction: w.noiseReduction.map((v) => Math.min(1, v * f)),
    sharpness: w.sharpness.map((v) => Math.min(2, v * f))
  }
}

/**
 * Narrowband in the chain: the bands are cleaned one by one (see
 * `cleanBands`), then the palette is recomposed.
 *
 * The two bands have different noise (OIII, fainter and multiplied to
 * even it out, is usually the grainier): each has its own thresholds,
 * measured on its own plane. Working on the brightness, almost all
 * H-alpha, and splitting the correction among the channels would instead
 * carry the H-alpha structure into green and blue. The palette follows
 * immediately, before stars and local contrast, which thus work on the
 * final colors (star reduction fills the freed space with the nebula
 * already in the palette, and local contrast measures the light of the
 * recomposed image). The automatic finish does not choose it: it changes
 * the colors in a way that is not faithful, so it is enabled by hand.
 *
 * The stars, if they keep their color, take it from the color image, to
 * which for this reason the same wavelets on the brightness are applied
 * as without narrowband: otherwise the grain from before the reduction
 * would return around the stars.
 */
function bandsToPalette(
  im: ImageData32,
  usedValues: ProcessingParams,
  automatic: boolean,
  givenBands: ExtractedBands | undefined,
  colorGains: readonly [number, number, number] | undefined
): ImageData32 {
  const w = im.width
  const h = im.height
  const b = givenBands ?? extractBands(im, usedValues.narrowband.sensor, colorGains)
  // The automatic choice looks at the brightness of the image, as without
  // narrowband; the thresholds are then measured on each band.
  if (automatic) usedValues.wavelets = strongerWavelets(automaticWavelets(im), usedValues.automaticStrength ?? 1)
  const cleanedItems: ExtractedBands = { ...b, ...cleanBands(b, usedValues.wavelets, usedValues.colorNoise) }
  const perStars = usedValues.narrowband.naturalStars ? imageWavelets(im, usedValues.wavelets) : im
  return narrowband(perStars, usedValues.narrowband, cleanedItems)
}

/**
 * Wavelet thresholds on the bands, in multiples of those calibrated for
 * the brightness (see `cleanBands`).
 */
const HA_THRESHOLD = 1.2
const OIII_THRESHOLD = 1.5
/** How close signal-free sky gets to gray, with the colored grain at maximum. */
const NEUTRAL_SKY = 0.85

/**
 * Noise reduction of the two separate bands, already passed through
 * NL-Bayes.
 *
 * The bands are grainier than the brightness: the latter averages three
 * channels, while H-alpha comes almost from the red alone and OIII from
 * green and blue, and the separation, removing from each the part of the
 * other, brings into both a little of the noise of the removed channels,
 * with opposite sign: where it remains, the grain turns into red and cyan
 * blotches. Without narrowband the color smoothing hides it, but copying
 * the H-alpha details into the OIII. Here instead:
 * 1. wavelets on each band, with thresholds measured on the band itself
 *    and firmer than those chosen for the brightness. H-alpha: the
 *    reduction of each layer removes half of what the choice left (0.7
 *    becomes 0.85) and the thresholds rise by 20%. OIII, almost always
 *    faint and multiplied to even it out: full reduction in every layer
 *    and thresholds one and a half times higher; an oxygen-rich nebula
 *    (NGC 6992) has structures well above these thresholds and keeps
 *    them. A layer without reduction stays without; the sharpness is the
 *    chosen one.
 * 2. Where neither band has signal (the sky), the two are brought closer
 *    to their mean, i.e. to gray: there the difference between the bands
 *    is only noise, in blotches too large for the wavelets. The threshold
 *    is narrow (the smoothed sum below half the pixel noise): in a nebula
 *    that fills the field, like NGC 7000, the faint but real areas stay
 *    out, and so the H-alpha detail does not pass into the OIII (with a
 *    threshold of two noise units the copy would come back almost as
 *    strong as with the color smoothing). This is what the color
 *    smoothing does on the sky, and it follows its strength (`sky`).
 * Calibrated on NGC 7000 and NGC 6992 so that the HOO grain is no
 * stronger than it was with the color smoothing.
 */
export function cleanBands(
  b: Pick<ExtractedBands, 'ha' | 'oiii' | 'width' | 'height' | 'noiseHa' | 'noiseOiii'>,
  p: WaveletParams,
  /** Strength of the sky neutralization, from 0 to 1 (the colored grain of the Color step). */
  sky: number
): { ha: Float32Array; oiii: Float32Array } {
  const w = b.width
  const h = b.height
  const n = w * h
  const reinforce = (k: (r: number) => number): WaveletParams => ({
    ...p,
    noiseReduction: p.noiseReduction.map((r) => (r > 0 ? k(Math.min(1, r)) : 0))
  })
  const thresholds = (plane: Float32Array, factor: number): number[] =>
    measureWaveletNoise(plane, w, h).map((s) => s * factor)
  const ha = wavelets(b.ha, w, h, reinforce((r) => 1 - (1 - r) / 2), thresholds(b.ha, HA_THRESHOLD))
  const oiii = wavelets(b.oiii, w, h, reinforce(() => 1), thresholds(b.oiii, OIII_THRESHOLD))

  const strength = NEUTRAL_SKY * Math.min(1, Math.max(0, sky))
  if (strength > 0) {
    // Signal: the sum of the bands (which start from zero on the sky),
    // smoothed like the cleanup signal map, in units of the pixel noise of
    // the sum before any reduction.
    const sum = new Float32Array(n)
    for (let i = 0; i < n; i++) sum[i] = ha[i] + oiii[i]
    const trace = blur(sum, w, h, Math.max(4, Math.min(w, h) / 360))
    const sigma = Math.max(1e-9, Math.hypot(b.noiseHa, b.noiseOiii))
    for (let i = 0; i < n; i++) {
      const f = strength * (1 - smoothStep(trace[i] / sigma, 0, 0.5))
      if (f <= 0) continue
      const mean = sum[i] / 2
      ha[i] += (mean - ha[i]) * f
      oiii[i] += (mean - oiii[i]) * f
    }
  }
  return { ha, oiii }
}

/** Gradual transition from 0 (below from) to 1 (above a). */
function smoothStep(v: number, from: number, a: number): number {
  const t = Math.min(1, Math.max(0, (v - from) / (a - from)))
  return t * t * (3 - 2 * t)
}

/**
 * Gains by which the first stage multiplied the channels (photometric
 * calibration, then balance on the stars): narrowband needs them to know
 * how much H-alpha green and blue now see.
 */
export function chainColorGains(
  p: ProcessingParams,
  measurements: Pick<FirstStageMeasurements, 'starGains'>
): [number, number, number] {
  const f: readonly number[] =
    p.balance === 'photometric' && p.photometricGains ? p.photometricGains : [1, 1, 1]
  const s = measurements.starGains
  return [f[0] * s[0], f[1] * s[1], f[2] * s[2]]
}

/**
 * Bands to be cleaned with NL-Bayes between the first and third stage,
 * when narrowband is active (see useProcessing.ts).
 */
export function extractChainBands(
  image: ImageData32,
  p: ProcessingParams,
  colorGains?: readonly [number, number, number]
): ExtractedBands {
  return extractBands(image, p.narrowband.sensor, colorGains)
}

/** Blends a plane reduced by NL-Bayes with the starting one according to the strength. */
export function applyPlaneAmount(before: Float32Array, after: Float32Array, strength: number): Float32Array {
  if (strength >= 0.999) return after
  const data = new Float32Array(before.length)
  for (let i = 0; i < data.length; i++) data[i] = before[i] + (after[i] - before[i]) * strength
  return data
}

/**
 * NL-Bayes cleans the brightness `y` (the mean of the channels) and its
 * change is added equally to every channel; the result is then blended with
 * the starting image according to the strength. This does both for the rows
 * from `y0` to `y1` of an image `w` wide with `c` channels, writing into
 * `data` itself, with the same values as adding the change to a copy and
 * then calling `applyReductionAmount`: the caller needs neither the copy nor
 * the full cleaned plane. `cleaned` starts at row `y0`, `y` covers the whole
 * image and is not modified.
 */
export function applyBrightnessReduction(
  data: Float32Array,
  y: Float32Array,
  cleaned: Float32Array,
  strength: number,
  c: number,
  y0: number,
  y1: number,
  w: number
): void {
  const n = y.length
  const o = y0 * w
  const count = (y1 - y0) * w
  for (let q = 0; q < count; q++) {
    const i = o + q
    const delta = cleaned[q] - y[i]
    for (let k = 0; k < c; k++) {
      const j = k * n + i
      const before = data[j]
      const after = Math.fround(before + delta)
      data[j] = strength >= 0.999 ? after : before + (after - before) * strength
    }
  }
}

/** Blends the image reduced by NL-Bayes with the starting one according to the strength. */
export function applyReductionAmount(before: ImageData32, after: ImageData32, strength: number): ImageData32 {
  if (strength >= 0.999) return after
  const data = new Float32Array(before.data.length)
  for (let i = 0; i < data.length; i++) data[i] = before.data[i] + (after.data[i] - before.data[i]) * strength
  return { ...before, data }
}
