import type { ImageData32 } from '@shared/types'
import { applyCorrections, type CorrectionParams } from '@core/export/processing'
import { NEUTRAL_CURVE, type CurveChannel } from '@core/image/curve'
import { computeHistogram } from '@core/image/stats'

/**
 * Levels of the corrected image, for the histogram and the curves editor.
 *
 * Instead of transforming the histogram of the raw data (which can only
 * follow the stretch), the real export chain (applyCorrections, the twin
 * of the viewer shader) is run on a sample of about one hundred thousand
 * pixels taken at a regular step. Measured on a 3840 x 2160 image: about
 * 20 ms per recomputation, against over a second at full resolution.
 *
 * There are two phases, because the chain is: stretch → curves → balance,
 * contrast, brightness, saturation, gamma → photo filter.
 *
 *   'final'        levels as they appear in the viewer: the whole chain,
 *                  photo filter included (with vibrance and vignette).
 *                  This is the "result" histogram.
 *   'curvesInput'  levels the curve actually receives, i.e. those on the
 *                  horizontal axis of the editor. The filter and the color
 *                  adjustments come AFTER the curves, so they must not
 *                  appear here: with a filter enabled this histogram does
 *                  not change, as intended.
 *
 * For the curves input, which curve is being edited also matters:
 *  - the red, green and blue curves receive the freshly stretched channels;
 *  - in the viewer the light curve acts after the channel curves, so its
 *    input already includes them;
 *  - with "preserve color" the light curve acts on the stretched
 *    brightness (the mean of the three channels) and the channel curves do
 *    not act at all: the input is that brightness alone.
 *
 * Left out in both phases: noise reduction and sharpening (they work on
 * neighboring pixels, which are not neighbors in the sample, and shift
 * the level distribution very little) and local adjustments, which act
 * only inside their masks and need the geometry of the whole image.
 */
export type LevelsPhase = 'final' | 'curvesInput'

const SAMPLE_PIXELS = 100_000

export interface LevelsSample {
  /** Pixels taken at a regular step, with the image channels. */
  image: ImageData32
  /**
   * Mean of the three channels of each sampled pixel (null for monochrome
   * images, where it equals the sample): this is the brightness that the
   * "preserve color" stretch stretches.
   */
  light: ImageData32 | null
  channels: 1 | 3
}

/** Pixels at a regular step: the level statistics stay the true ones. */
export function sampleLevels(image: ImageData32, pixel = SAMPLE_PIXELS): LevelsSample {
  const step = Math.max(1, Math.round(Math.sqrt((image.width * image.height) / pixel)))
  const w = Math.max(1, Math.floor(image.width / step))
  const h = Math.max(1, Math.floor(image.height / step))
  const n = image.width * image.height
  const m = w * h
  const data = new Float32Array(m * image.channels)
  for (let c = 0; c < image.channels; c++) {
    for (let y = 0; y < h; y++) {
      const row = c * n + y * step * image.width
      for (let x = 0; x < w; x++) data[c * m + y * w + x] = image.data[row + x * step]
    }
  }
  let light: ImageData32 | null = null
  if (image.channels === 3) {
    const mean = new Float32Array(m)
    for (let i = 0; i < m; i++) mean[i] = (data[i] + data[m + i] + data[2 * m + i]) / 3
    light = { width: w, height: h, channels: 1, data: mean }
  }
  return { image: { width: w, height: h, channels: image.channels, data: data }, light, channels: image.channels }
}

/**
 * Chain parameters for the levels entering the curves: only background
 * neutralization and stretch, plus (for the light curve) the channel
 * curves that precede it.
 */
function inputParams(p: CorrectionParams, channel: CurveChannel): CorrectionParams {
  const curves = p.curves
  return {
    ...p,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    redGain: 1,
    greenGain: 1,
    blueGain: 1,
    gamma: 1,
    noiseReduction: 0,
    sharpness: 0,
    filter: undefined,
    locals: null,
    curves: channel === 'light' && curves && !p.preserveColor ? { ...curves, light: NEUTRAL_CURVE } : undefined
  }
}

/**
 * Level histograms for the requested phase: three (red, green, blue) for
 * color images, one for monochrome images and for the input of the light
 * curve with "preserve color".
 *
 * `p` holds the full parameters, as for export (with the sky background of
 * the whole image, the same as the viewer); the phase decides which parts
 * of the chain count. `channel` only matters for the curves input.
 */
export function levelsHistograms(
  sample: LevelsSample,
  p: CorrectionParams,
  phase: LevelsPhase,
  bins: number,
  channel: CurveChannel = 'light'
): Uint32Array[] {
  if (phase === 'final') {
    const output = applyCorrections(sample.image, { ...p, noiseReduction: 0, sharpness: 0, locals: null })
    const histograms = computeHistogram(output, bins)
    return sample.channels === 1 ? [histograms[0]] : histograms
  }

  const input = inputParams(p, channel)
  if (p.preserveColor && sample.light) {
    // The chain applied to the channel mean alone, with the mean background:
    // background subtraction is linear, so the mean of the neutralized
    // channels is the neutralized mean, and the stretch returns exactly the
    // stretched brightness that the light curve receives.
    const f = p.skyBackground
    const meanBackground = (f[0] + f[1] + f[2]) / 3
    const output = applyCorrections(sample.light, { ...input, skyBackground: [meanBackground, meanBackground, meanBackground] })
    return [computeHistogram(output, bins)[0]]
  }
  const output = applyCorrections(sample.image, input)
  const histograms = computeHistogram(output, bins)
  return sample.channels === 1 ? [histograms[0]] : histograms
}
