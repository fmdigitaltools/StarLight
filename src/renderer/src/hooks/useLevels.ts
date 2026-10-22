import { useDeferredValue, useMemo } from 'react'
import type { ImageData32 } from '@shared/types'
import { useApp, type Adjustments } from '../store/appStore'
import type { CorrectionParams } from '@core/export/processing'
import { effectiveFilter } from '@core/image/photoFilters'
import { imageSkyBackground } from '@core/image/skyBackground'
import { NEUTRAL_CURVE, type CurveChannel, type Curves } from '@core/image/curve'
import {
  sampleLevels,
  levelsHistograms,
  type LevelsSample,
  type LevelsPhase
} from '@core/image/levels'

/**
 * Levels of the corrected image, for the histogram (phase `final`, as shown
 * in the viewer, photo filter included) and for the curves editor (phase
 * `curvesInput`, the levels the curve actually receives). Why there are two
 * phases and what each contains is explained in core/image/levels.ts; this
 * module only decides when to recompute.
 */
export type { LevelsPhase }

interface Sample {
  levels: LevelsSample
  /** Sky background of the whole image: the same value the viewer uses. */
  background: [number, number, number]
}

const samples = new WeakMap<ImageData32, Sample>()

function sampleImage(image: ImageData32): Sample {
  const ready = samples.get(image)
  if (ready) return ready
  // imageSkyBackground has already been computed (and cached) by the viewer.
  const sample: Sample = { levels: sampleLevels(image), background: imageSkyBackground(image) }
  samples.set(image, sample)
  return sample
}

/** Full chain parameters, as for export. */
function parameters(sample: Sample, r: Adjustments, curves: Curves): CorrectionParams {
  return {
    stretch: r.stretch,
    brightness: r.brightness,
    contrast: r.contrast,
    saturation: r.saturation,
    redGain: r.redGain,
    greenGain: r.greenGain,
    blueGain: r.blueGain,
    gamma: r.gamma,
    noiseReduction: 0,
    sharpness: 0,
    backgroundNeutralization: r.backgroundNeutralization,
    skyBackground: sample.background,
    preserveColor: r.preserveColor,
    ghs: r.withGhs ? r.ghs : undefined,
    curves,
    filter: effectiveFilter(r.filter, r.filterIntensity, r.vibrance, r.vignette)
  }
}

/**
 * The latest result of each request is cached: the viewer histogram and the
 * panel histogram ask for the same thing, and the computation runs once.
 */
const latest = new Map<
  string,
  { sample: Sample; adjustments: Adjustments; curves: Curves; bins: number; histograms: Uint32Array[] }
>()

function compute(
  sample: Sample,
  r: Adjustments,
  curves: Curves,
  phase: LevelsPhase,
  bins: number,
  channel: CurveChannel
): Uint32Array[] {
  const key = phase + ':' + channel
  const last = latest.get(key)
  if (
    last &&
    last.sample === sample &&
    last.adjustments === r &&
    last.curves === curves &&
    last.bins === bins
  ) {
    return last.histograms
  }
  const histograms = levelsHistograms(sample.levels, parameters(sample, r, curves), phase, bins, channel)
  latest.set(key, { sample, adjustments: r, curves, bins, histograms })
  return histograms
}

/**
 * Channel histograms (one for monochrome images) in the requested phase.
 * Recomputation follows the sliders with a short delay, so dragging stays
 * smooth. `channel` matters only for the curves input: it is the curve shown
 * in the editor.
 */
export function useLevels(phase: LevelsPhase, bins: number, channel: CurveChannel = 'light'): Uint32Array[] | null {
  const image = useApp((s) => s.image)
  const adjustments = useDeferredValue(useApp((s) => s.adjustments))
  const currentCurves = useDeferredValue(useApp((s) => s.curves))

  // Only the curves that act before the requested levels matter: all of them
  // for the final phase, the channel curves for the light curve input, none
  // for the channel curves input. This way, while a point is dragged, the
  // histogram under the curve is not recomputed needlessly.
  const withLight = phase === 'final'
  const withChannels = phase === 'final' || channel === 'light'
  const light = withLight ? currentCurves.light : NEUTRAL_CURVE
  const red = withChannels ? currentCurves.red : NEUTRAL_CURVE
  const green = withChannels ? currentCurves.green : NEUTRAL_CURVE
  const blue = withChannels ? currentCurves.blue : NEUTRAL_CURVE
  const curves = useMemo((): Curves => ({ light, red, green, blue }), [light, red, green, blue])

  const sample = useMemo(() => (image ? sampleImage(image) : null), [image])

  return useMemo(() => {
    if (!sample) return null
    return compute(sample, adjustments, curves, phase, bins, channel)
  }, [sample, adjustments, curves, phase, bins, channel])
}
