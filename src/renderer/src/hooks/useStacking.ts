import { useCallback, useState } from 'react'
import type { BayerPattern, ImageData32, LoadedFrame } from '@shared/types'
import { relativeQuality, detectStars, type Star } from '@core/stars/detection'
import { align } from '@core/stack/alignment'
import { stack } from '@core/stack/stacking'
import { mergeHdr, seriesToMerge, seriesPerExposure, type ExposureSeries } from '@core/stack/hdr'
import {
  rotationDegrees,
  IDENTITY_TRANSFORMATION,
  type AlignmentResult,
  type Transformation
} from '@core/stack/alignment'
import type { FrameToStack, StackingMethod } from '@core/stack/stacking'
import {
  formatWeight,
  utcTimestamp,
  medianOf,
  weighNights,
  qualityPerNight,
  groupByNight,
  fluxRatio,
  backgroundStatistics,
  type NightResult,
  type NightMeasurements,
  type NightsChoice
} from '@core/stack/nights'
import { autoStretch } from '@core/image/stretch'
import { estimateNoise } from '@core/image/stats'
import { calibrate } from '@core/stack/calibration'
import { deferredCalibration, isCompact, expand, type HeldImage, type KeptMaster } from '@core/stack/compactFrame'
import { sharedFloat32 } from '@shared/sharedMemory'
import { loadMaster, conditionsOf, entriesToReuse } from '../calibration/library'
import {
  noDarkNotice,
  lightResult,
  summarizeCalibration,
  chooseForLight,
  type LightCalibrationResult,
  type CalibratedLightGroup,
  type ChosenMaster
} from '@core/stack/calibrationGroups'
import type { FrameConditions, MasterEntry } from '@core/stack/calibrationLibrary'
import { analysisWorkerPool, stackingWorkerPool } from '../workers/pool'
import { estimateStackingMemory } from './stackingMemory'
import { frameCache } from './useLibrary'
import { isDrizzleActive, type DrizzleOptions } from '@core/stack/drizzle'
import { suggestCoverageCrop, type CropProposal } from '@core/stack/coverage'
import {
  drizzleParallel,
  stackInParallel,
  insufficientDrizzleMemory
} from '../workers/stackInParallel'
import { alignParallel } from '../workers/alignParallel'
import { useApp } from '../store/appStore'
import { wcsScale } from '@core/astrometry/wcs'
import { showStacked, showResult, rememberIntegration } from './temporaryResult'
import { registerPreview } from './framePreviews'
import {
  addLayer,
  findNucleus,
  extractCometLayer,
  nucleusFromTwoPoints,
  subtractLayerFromFrame,
  transformationOnComet,
  type NucleusResult,
  type CometMode,
  type CometLayer
} from '@core/stack/comet'
import type { NucleusPoint } from './cometNucleus'
import { formatNumber, t } from '@shared/i18n/i18n'

/**
 * Why a frame was used or left out: a stable code, turned into text only
 * where it is shown (see frameReasonText), so it does not depend on the
 * interface language.
 */
export type FrameReason = 'reference' | 'stacked' | 'low-quality' | 'stars-not-recognized' | 'excluded-night'

/** Text shown to the user for a frame outcome, in the current language. */
export function frameReasonText(reason: FrameReason): string {
  switch (reason) {
    case 'reference':
      return t('hooksUseStacking.reason.reference')
    case 'stacked':
      return t('hooksUseStacking.reason.stacked')
    case 'low-quality':
      return t('hooksUseStacking.reason.lowQuality')
    case 'stars-not-recognized':
      return t('hooksUseStacking.reason.starsNotRecognized')
    case 'excluded-night':
      return t('hooksUseStacking.reason.excludedNight')
  }
}

/** Outcome of the analysis and alignment of a single frame. */
export interface FrameResult {
  id: string
  fileName: string
  quality: number
  hfr: number
  stars: number
  /** Shift relative to the reference, in pixels. */
  shift: number
  rotation: number
  alignmentError: number
  isUsed: boolean
  reason: FrameReason
  /** Night key of the frame, if the frames come from several nights. */
  night?: string
}

export interface StackingSummary {
  usedFrames: number
  totalFrames: number
  results: FrameResult[]
  method: StackingMethod
  timeSeconds: number
  rejectedValues: number
  noiseBefore: number
  noiseAfter: number
  /** Present only if drizzle was actually applied. */
  drizzle?: DrizzleResult
  /** Crop of the edges covered by few frames, if one was proposed. */
  crop?: CropProposal
  /** Present if the stack followed a comet. */
  comet?: CometResult
  /** Present if the frames came from several nights: weight and measurements of each. */
  nights?: NightResult[]
  /** Present if series with different exposures were merged. */
  hdr?: HdrResult
  /**
   * Present if calibration was active: for each group of lights, the masters
   * used and why, or why the dark is missing.
   */
  calibration?: CalibratedLightGroup[]
}

/** HDR merge of series with different exposures: what was merged and how. */
export interface HdrResult {
  series: { exposure: number; frame: number }[]
  /** Measured brightness ratio between the longest and the shortest series. */
  ratio: number
  /** Fraction of the image where the short exposures took over. */
  replacedShare: number
}

/**
 * Comet stacking: what stays still in the result and how the nucleus is
 * found in each frame.
 */
export interface CometOptions {
  mode: CometMode
  /** Automatic, or the two points marked with a click in the viewer. */
  nucleus: 'automatic' | { first: NucleusPoint; last: NucleusPoint }
}

/** How the comet stacking went, for the summary. */
export interface CometResult {
  mode: CometMode
  nucleus: 'automatic' | 'manual'
  /** Path of the nucleus between the first and the last frame, in pixels. */
  pathLength: number
  /** Speed in pixels per hour; null if the files have no capture date. */
  speed: number | null
  /** Typical deviation of the measured positions from uniform motion, in pixels. */
  deviation: number
  /** Frames in which the nucleus was measured, out of those stacked. */
  measured: number
  frame: number
}

/** How drizzle went, for the summary. */
export interface DrizzleResult {
  factor: number
  pixfrac: number
  /** Average number of frames contributing to each fine pixel. */
  meanCoverage: number
  /** Fraction of fine pixels with no data, filled in by normal stacking. */
  emptyFraction: number
  /** True if it was a Bayer drizzle, from the raw sensor data. */
  bayer: boolean
}

export interface StartOptions {
  method: StackingMethod
  rejectionThreshold: number
  /**
   * Minimum score for a frame to be stacked, as a percentage of the best
   * frames of the same session (`relativeQuality`).
   */
  minQuality: number
  /** Detects stars and aligns; if false, sums the frames as they are. */
  alignment: boolean
  /**
   * Sum on a finer grid. When absent or with factor 1 stacking is normal; the
   * live session never passes it.
   */
  drizzle?: DrizzleOptions
  /**
   * Proposes cropping the edges where few frames contribute (less than 70%).
   * Absent means true.
   */
  edgeTrim?: boolean
  /**
   * Alignment on the comet as well as on the stars. When absent or with mode
   * `stars` stacking is normal; the live session never passes it.
   */
  comet?: CometOptions
  /**
   * Manually chosen weights and excluded nights, when the frames come from
   * several nights. Absent: everything automatic. The live session does not
   * pass it.
   */
  nights?: NightsChoice
  /**
   * With frames of different exposures (for example 10 s and 2 s), stacks
   * each series separately and merges them in HDR (see core/stack/hdr.ts).
   * Absent means true; the live session does not pass it.
   */
  hdr?: boolean
}

/** Fraction of the stacked frames that must cover every point kept by the crop. */
export const CROP_COVERAGE = 0.7

/** Calibration frames and already stacked frames do not take part in the integration. */
function toIntegrate(frame: LoadedFrame[]): LoadedFrame[] {
  return frame.filter(
    (f) =>
      !f.excluded &&
      f.metadata.frameType !== 'dark' &&
      f.metadata.frameType !== 'flat' &&
      f.metadata.frameType !== 'bias'
  )
}

/** A frame already decoded, calibrated and measured, ready to be aligned. */
export interface AnalyzedFrame {
  id: string
  fileName: string
  /**
   * The calibrated frame, either whole or compact (the integer codes of the
   * file, rebuilt and calibrated only when summed: see
   * core/stack/compactFrame.ts).
   */
  image: HeldImage
  stars: Star[]
  /**
   * Absolute score of the frame on its own (`evaluateQuality`). Choosing and
   * weighting frames uses the session-relative score, computed by
   * `stackAnalyzed` on all frames together.
   */
  quality: number
  hfr: number
  /** Explanation if calibration was skipped for this frame. */
  calibrationError?: string
  /** Which masters were chosen for this frame and why (calibration active). */
  calibration?: LightCalibrationResult
  /** Bayer pattern, if the file was a raw frame from a color sensor. */
  bayerPattern?: BayerPattern
  /**
   * Mid-exposure time, in milliseconds since 1970, if the file has a capture
   * date: used to follow the motion of a comet.
   */
  timestamp?: number
  /**
   * Night of capture (see `groupByNight`). Absent in the live session, which
   * is always a single night.
   */
  night?: { key: string; label: string }
}

/**
 * Mid-exposure time of a frame, from the capture date and the exposure;
 * undefined if the date is missing or unreadable. FITS dates are in UTC even
 * when they do not say so: without the trailing «Z» the browser would parse
 * them as local time.
 */
export function shotTimestamp(meta: { dateObs: string | null; exposure: number | null }): number | undefined {
  const ms = utcTimestamp(meta.dateObs)
  if (ms === undefined) return undefined
  return ms + ((meta.exposure ?? 0) * 1000) / 2
}

/**
 * Analyzes a frame with the worker pool: decodes it, rebuilds its color,
 * detects its stars and calibrates it with the active masters. Used both by
 * normal stacking and by the live session. Throws if the file cannot be read.
 */
export async function analyzeFrame(
  frame: { id: string; path: string; fileName: string },
  withStars: boolean,
  buffer?: ArrayBuffer
): Promise<AnalyzedFrame> {
  const state = useApp.getState()
  const master = state.master

  const content = buffer ?? (await window.starlight.readFile(frame.path))
  const response = await analysisWorkerPool().analyze({
    id: frame.id,
    path: frame.path,
    buffer: content,
    withStars,
    fileName: frame.fileName,
    compactValue: true
  })

  if (response.result === 'error' || (!response.data && !response.compact)) {
    throw new Error(response.message ?? t('hooksUseStacking.analysisFailed'))
  }
  if (response.thumbnail) registerPreview(frame.path, response.thumbnail)

  let image: HeldImage = response.compact ?? {
    width: response.width as number,
    height: response.height as number,
    channels: response.channels as 1 | 3,
    data: new Float32Array(response.data as ArrayBufferLike)
  }

  // Calibration: removes the thermal signal, corrects the optical
  // non-uniformity and the defective pixels. For each type the session
  // master matching the frame conditions is used (exposure, gain,
  // temperature, filter: the rules of chooseMaster); if the session has
  // none, the library one; if the library has none either, nothing. A dark
  // out of tolerance is never used.
  let calibrationError: string | undefined
  let calibration: LightCalibrationResult | undefined
  if (state.withCalibration) {
    const conditions: FrameConditions = response.metadata
      ? conditionsOf(response.metadata, image.width, image.height, image.channels)
      : { width: image.width, height: image.height, channels: image.channels, bayer: 'NONE', exposure: null, gain: null, temperature: null, instrument: null, filter: null, data: null }
    const session = master.groups
    const sessionEntries = session.map((g) => g.entry)
    let library: MasterEntry[] = []
    try {
      library = await entriesToReuse()
    } catch {
      // An unreadable library must not stop the job.
    }
    const choice = chooseForLight(sessionEntries, library, conditions)
    calibration = lightResult(choice, conditions, [...sessionEntries, ...library])
    const unread: string[] = []
    const imageOf = async (m: ChosenMaster | null): Promise<KeptMaster | null> => {
      if (!m) return null
      if (m.origin === 'session') return session.find((g) => g.entry.id === m.entry.id)?.image ?? null
      try {
        return await loadMaster(m.entry)
      } catch {
        unread.push(m.entry.id)
        return null
      }
    }
    const dark = await imageOf(choice.dark)
    const flat = await imageOf(choice.flat)
    const bias = await imageOf(choice.bias)
    if (unread.length > 0) {
      // The master could not be read: for the summary, it was not used.
      calibration.unread = unread
      if (!dark) calibration.dark = null
      if (!flat) calibration.flat = null
      if (!bias) calibration.bias = null
    }
    if (dark !== null || flat !== null || bias !== null) {
      try {
        // A compact frame stays compact: calibration is applied every time
        // the sum rebuilds it, with the same result. A whole frame is
        // calibrated in place: the freshly decoded pixels are only needed
        // calibrated, and this way they stay in shared memory without a
        // second copy.
        image = isCompact(image)
          ? deferredCalibration(image, { dark, flat, bias })
          : calibrate(image, {
              dark,
              flat,
              bias,
              correctDefectivePixels: dark !== null,
              inPlace: true
            })
      } catch (e) {
        // An incompatible master must not stop the job.
        calibrationError = e instanceof Error ? e.message : String(e)
        calibration = undefined
      }
    }
  }

  return {
    id: frame.id,
    fileName: frame.fileName,
    image,
    stars: response.stars ?? [],
    quality: response.quality ?? 0,
    hfr: response.hfr ?? 0,
    calibrationError,
    calibration,
    bayerPattern: response.bayerPattern
  }
}

/** What stacking already analyzed frames returns. */
export interface StackAnalyzedResult {
  image: ImageData32
  referenceId: string
  results: FrameResult[]
  usedFrames: number
  rejectedValues: number
  noiseBefore: number
  noiseAfter: number
  /** Alignments computed against the reference, reusable on the next round. */
  alignments: Map<string, AlignmentResult>
  drizzle?: DrizzleResult
  /** Why the requested drizzle was not applied. */
  drizzleNotice?: string
  /** Proposed crop for the edges covered by few frames. */
  crop?: CropProposal
  /** Present if the stack followed a comet. */
  comet?: CometResult
  /** Present if the stacked frames came from several nights. */
  nights?: NightResult[]
}

/** Frames per night on which background and noise are measured: enough for a stable median. */
const MEASURED_FRAMES_PER_NIGHT = 6

/**
 * Measures each night on its stacked frames, computes its weight and
 * normalization (`weighNights`) and applies them to the frames to sum.
 * `usedValues` and `toStack` are parallel arrays. Pixel work is limited to a
 * sample of a few frames per night (`backgroundStatistics`); transparency
 * comes from the stars already detected, without touching the pixels.
 */
function weighAndNormalizeNights(
  usedValues: AnalyzedFrame[],
  toStack: FrameToStack[],
  reference: AnalyzedFrame,
  choices: NightsChoice | undefined
): NightResult[] {
  const groups = new Map<string, number[]>()
  usedValues.forEach((f, i) => {
    const k = f.night?.key ?? ''
    const g = groups.get(k)
    if (g) g.push(i)
    else groups.set(k, [i])
  })
  const measurements: NightMeasurements[] = []
  for (const [key, indices] of groups) {
    // Frames spread across the night, because the background changes with time.
    const step = Math.max(1, indices.length / MEASURED_FRAMES_PER_NIGHT)
    const sample: number[] = []
    for (let k = 0; k < indices.length && sample.length < MEASURED_FRAMES_PER_NIGHT; k += step) {
      sample.push(indices[Math.floor(k)])
    }
    // A compact frame is rebuilt in full, one at a time.
    const statistics = sample.map((i) => backgroundStatistics(expand(toStack[i].image)))
    const channels = toStack[indices[0]].image.channels
    const perChannel = (choose: (s: { background: number[]; noise: number[] }) => number[]): number[] =>
      Array.from({ length: channels }, (_, c) => medianOf(statistics.map((s) => choose(s)[c])) ?? 0)
    const fluxes = indices
      .map((i) => fluxRatio(reference.stars, usedValues[i].stars, toStack[i].transformation))
      .filter((r): r is number => r !== null)
    measurements.push({
      key,
      label: usedValues[indices[0]].night?.label ?? key,
      frame: indices.length,
      hfr: medianOf(indices.map((i) => usedValues[i].hfr).filter((h) => h > 0)) ?? 0,
      background: perChannel((s) => s.background),
      noise: perChannel((s) => s.noise),
      flux: medianOf(fluxes)
    })
  }
  const results = weighNights(measurements, reference.night?.key ?? '', choices)
  const byKey = new Map(results.map((e) => [e.key, e]))
  usedValues.forEach((f, i) => {
    const e = byKey.get(f.night?.key ?? '')
    if (!e) return
    toStack[i].weight *= e.weight
    if (!e.reference) {
      const channels = toStack[i].image.channels
      toStack[i].normalization = {
        scale: Array.from({ length: channels }, () => e.scale),
        shift: e.shift
      }
    }
  })
  return results
}

/**
 * Position of the comet nucleus in each stacked frame, in pixels of the
 * reference (the first in the list). Time comes from the capture date; if
 * some file lacks it, the order of the frames in the library is used, which
 * works as long as the shots are taken at regular intervals.
 * Throws an explanatory error if the nucleus cannot be found.
 */
function nucleusInFrames(
  usedValues: AnalyzedFrame[],
  transformations: Transformation[],
  order: Map<string, number>,
  comet: CometOptions
): { result: NucleusResult; times: number[]; realTimes: boolean } {
  const timestamps = usedValues.map((f) => f.timestamp)
  const realTimes =
    timestamps.every((t) => t !== undefined) && new Set(timestamps).size === timestamps.length
  const startTime = realTimes ? Math.min(...(timestamps as number[])) : 0
  // In hours if the dates are available, otherwise as a sequence number.
  const times = usedValues.map((f) =>
    realTimes ? ((f.timestamp as number) - startTime) / 3600000 : (order.get(f.id) ?? 0)
  )
  const perCore = usedValues.map((f, i) => ({
    image: expand(f.image),
    transformation: transformations[i],
    t: times[i]
  }))
  const width = usedValues[0].image.width
  const height = usedValues[0].image.height

  let result: NucleusResult | { error: string }
  if (comet.nucleus === 'automatic') {
    result = findNucleus(perCore, width, height)
  } else {
    const { first, last } = comet.nucleus
    const ia = usedValues.findIndex((f) => f.id === first.frameId)
    const ib = usedValues.findIndex((f) => f.id === last.frameId)
    if (ia < 0 || ib < 0) {
      throw new Error(
        t(ia < 0 ? 'hooksUseStacking.nucleusFrameNotStacked.first' : 'hooksUseStacking.nucleusFrameNotStacked.last')
      )
    }
    // The click is in pixels of the image as it was shown in the viewer.
    const inPixels = (p: NucleusPoint, f: AnalyzedFrame): { x: number; y: number } => ({
      x: (p.x * f.image.width) / p.width,
      y: (p.y * f.image.height) / p.height
    })
    result = nucleusFromTwoPoints(
      perCore,
      { index: ia, point: inPixels(first, usedValues[ia]) },
      { index: ib, point: inPixels(last, usedValues[ib]) }
    )
  }
  if ('error' in result) throw new Error(result.error)
  return { result, times, realTimes }
}

/**
 * Chooses the reference, aligns and stacks already analyzed frames.
 *
 * `known` lets the live session keep the reference fixed and avoid
 * realigning frames already aligned to it: for each new frame only that one
 * is aligned and then the sum is redone.
 */
export async function stackAnalyzed(
  allItems: AnalyzedFrame[],
  options: StartOptions,
  advance: (label: string, fraction: number) => void,
  known?: {
    referenceId?: string
    alignments?: Map<string, AlignmentResult>
    /**
     * Already accepted frames that stay in the sum even if their score drops
     * below the threshold (a choice of the live session).
     */
    accepted?: Set<string>
  }
): Promise<StackAnalyzedResult> {
  // --- Nights: excluded ones stay out of everything ---
  // With a single night (and always in the live session) nothing is excluded
  // and everything proceeds as for a single session.
  const nightOf = (f: AnalyzedFrame): string => f.night?.key ?? ''
  const multipleNightsInInput = new Set(allItems.map(nightOf)).size > 1
  const excludedNights = new Set<string>()
  if (multipleNightsInInput && options.nights) {
    for (const k of options.nights.excludedNights ?? []) excludedNights.add(k)
    // Zero weight is the same as exclusion: the night would add nothing to
    // the mean but would still shift the median used by rejection.
    for (const [k, p] of Object.entries(options.nights.weights ?? {})) if (p <= 0) excludedNights.add(k)
  }
  const availableItems = excludedNights.size > 0 ? allItems.filter((f) => !excludedNights.has(nightOf(f))) : allItems
  if (availableItems.length < 2) {
    throw new Error(t('hooksUseStacking.tooFewAfterNightExclusion'))
  }
  const multipleNights = new Set(availableItems.map(nightOf)).size > 1

  // --- Score of each frame relative to the best of its night ---
  // Recomputed on every call: in the live session, when better frames
  // arrive, the already accepted ones are reviewed too (the reason is
  // explained in useSession.ts). With several nights each frame is compared
  // only with those of the same night; with a single night the score is the
  // usual one.
  const measurements = availableItems.map((f) => ({ starCount: f.stars.length, medianHfr: f.hfr }))
  const relative = multipleNights ? qualityPerNight(measurements, availableItems.map(nightOf)) : relativeQuality(measurements)
  const scoreOf = new Map<string, number>(availableItems.map((f, i) => [f.id, relative[i]]))
  const score = (f: AnalyzedFrame): number => scoreOf.get(f.id) ?? 0

  // --- Reference: the frame with the best score ---
  // With several nights each night has its own frames at 100: the reference,
  // on which everything is aligned, is chosen by comparing all frames together.
  const globals = multipleNights ? relativeQuality(measurements) : relative
  const globalOf = new Map<string, number>(availableItems.map((f, i) => [f.id, globals[i]]))
  const byQuality = [...availableItems].sort((a, b) => (globalOf.get(b.id) ?? 0) - (globalOf.get(a.id) ?? 0))
  // A reference already fixed is kept, so the image does not jump, unless it
  // has meanwhile fallen below the threshold: a hazy reference would make the
  // alignment of all the others fail.
  const fixedFound = known?.referenceId ? availableItems.find((f) => f.id === known.referenceId) : undefined
  const fixed =
    fixedFound && (!options.alignment || score(fixedFound) >= options.minQuality)
      ? fixedFound
      : undefined
  const reference = fixed ?? (options.alignment ? byQuality[0] : availableItems[0])
  const referenceStars = reference.stars
  const alignmentOf = new Map<string, AlignmentResult>(
    fixed && known?.alignments ? known.alignments : []
  )

  advance(t('hooksUseStacking.progress.aligning'), 0.6)

  const results: FrameResult[] = []
  const toStack: FrameToStack[] = []

  // Bayer patterns of the frames that enter the sum, for Bayer drizzle.
  const patternsUsed: (BayerPattern | undefined)[] = [reference.bayerPattern]
  // The frames that enter the sum, in the same order: for the comet.
  const usedValues: AnalyzedFrame[] = [reference]

  toStack.push({
    image: reference.image,
    transformation: IDENTITY_TRANSFORMATION,
    weight: 1
  })
  results.push({
    id: reference.id,
    fileName: reference.fileName,
    quality: score(reference),
    hfr: reference.hfr,
    stars: referenceStars.length,
    shift: 0,
    rotation: 0,
    alignmentError: 0,
    isUsed: true,
    reason: 'reference',
    night: reference.night?.key
  })

  // The frames to align are independent of each other: they are all handed
  // to the workers together, so the interface stays responsive. Left out are
  // the reference, those below the quality threshold, which would not be
  // used anyway, and those already aligned.
  const toAlign = options.alignment
    ? availableItems.filter(
        (f) =>
          f.id !== reference.id &&
          (score(f) >= options.minQuality || known?.accepted?.has(f.id) === true) &&
          !alignmentOf.has(f.id)
      )
    : []
  const alignments = await alignParallel(
    referenceStars,
    toAlign.map((f) => f.stars),
    (fraction) => advance(t('hooksUseStacking.progress.aligning'), 0.6 + fraction * 0.05)
  )
  toAlign.forEach((f, i) => alignmentOf.set(f.id, alignments[i]))

  for (const frame of availableItems) {
    if (frame.id === reference.id) continue

    const quality = score(frame)

    let transformation = IDENTITY_TRANSFORMATION
    let error = 0
    let isUsed = true
    let reason: FrameReason = 'stacked'

    if (options.alignment && quality < options.minQuality && known?.accepted?.has(frame.id) !== true) {
      isUsed = false
      reason = 'low-quality'
    } else if (options.alignment) {
      const result = alignmentOf.get(frame.id)
      if (!result || !result.valid) {
        isUsed = false
        reason = 'stars-not-recognized'
      } else {
        transformation = result.transformation
        error = result.meanError
      }
    }

    results.push({
      id: frame.id,
      fileName: frame.fileName,
      quality,
      hfr: frame.hfr,
      stars: frame.stars.length,
      shift: Math.hypot(transformation.tx, transformation.ty),
      rotation: rotationDegrees(transformation),
      alignmentError: error,
      isUsed,
      reason,
      night: frame.night?.key
    })

    if (isUsed) {
      patternsUsed.push(frame.bayerPattern)
      usedValues.push(frame)
      toStack.push({
        image: frame.image,
        transformation,
        // Better frames weigh more in the mean.
        weight: options.alignment ? Math.max(0.2, quality / 100) : 1
      })
    }
  }

  // Frames from excluded nights appear in the details, as rejected.
  for (const frame of allItems) {
    if (!excludedNights.has(nightOf(frame))) continue
    results.push({
      id: frame.id,
      fileName: frame.fileName,
      quality: 0,
      hfr: frame.hfr,
      stars: frame.stars.length,
      shift: 0,
      rotation: 0,
      alignmentError: 0,
      isUsed: false,
      reason: 'excluded-night',
      night: nightOf(frame)
    })
  }

  if (toStack.length < 2) {
    throw new Error(t('hooksUseStacking.tooFewAligned'))
  }

  // --- Several nights: weight and normalization of each ---
  // Before the comet step, which modifies the frames: the measurements must
  // be taken on the frames as they are. If only one night is left after the
  // rejections, there is nothing to weigh.
  let nightResults: NightResult[] | undefined
  if (multipleNights && new Set(usedValues.map(nightOf)).size > 1) {
    advance(t('hooksUseStacking.progress.weighingNights'), 0.65)
    nightResults = weighAndNormalizeNights(usedValues, toStack, reference, options.nights)
  }

  const noiseBefore = estimateNoise(expand(toStack[0].image))

  let sumOptions: { method: StackingMethod; rejectionThreshold: number; weightsInRejection?: boolean } = {
    method: options.method,
    rejectionThreshold: options.rejectionThreshold,
    // With several nights, rejection also honors the night weights.
    ...(nightResults ? { weightsInRejection: true } : {})
  }
  let drizzleNotice: string | undefined
  let drizzleResult: DrizzleResult | undefined
  let result: { image: ImageData32; rejectedValues: number }

  let d = options.drizzle

  // --- Comet: alignment on the nucleus as well as on the stars ---
  // Where the progress bar of the final sum starts: with «comet and stars»
  // it is preceded by the sum aligned on the comet.
  let sumStart = 0.65
  let cometResult: CometResult | undefined
  let layer: CometLayer | null = null
  const cometMode = options.comet?.mode ?? 'stars'
  if (options.comet && cometMode !== 'stars') {
    advance(t('hooksUseStacking.progress.findingNucleus'), 0.65)
    // Nucleus search and comet separation work on whole frames: compact ones
    // are rebuilt here, in shared memory for the sum. The analyzed frames
    // stay as they are.
    for (let i = 0; i < toStack.length; i++) {
      if (!isCompact(toStack[i].image)) continue
      const whole = expand(toStack[i].image, sharedFloat32)
      toStack[i].image = whole
      usedValues[i] = { ...usedValues[i], image: whole }
    }
    // Let the label appear before the computation, which blocks briefly.
    await new Promise((r) => setTimeout(r, 30))
    const order = new Map(availableItems.map((f, i) => [f.id, i]))
    const starsT = toStack.map((f) => f.transformation)
    const { result: nucleus, times, realTimes } = nucleusInFrames(usedValues, starsT, order, options.comet)
    const refCount = nucleus.positions[0]
    const onComet = starsT.map((t, i) => transformationOnComet(t, nucleus.positions[i], refCount))
    // The stars, which move relative to the comet, are removed by rejection,
    // stricter than usual, whatever method was chosen.
    const cometSum = {
      method: 'rejection' as const,
      rejectionThreshold: Math.min(options.rejectionThreshold, 2),
      ...(nightResults ? { weightsInRejection: true } : {})
    }
    const iFirst = times.indexOf(Math.min(...times))
    const iLast = times.indexOf(Math.max(...times))
    const pathLength = Math.hypot(
      nucleus.positions[iLast].x - nucleus.positions[iFirst].x,
      nucleus.positions[iLast].y - nucleus.positions[iFirst].y
    )
    cometResult = {
      mode: cometMode,
      nucleus: options.comet.nucleus === 'automatic' ? 'automatic' : 'manual',
      pathLength,
      speed: realTimes ? Math.hypot(nucleus.motion.vx, nucleus.motion.vy) : null,
      deviation: nucleus.rejection,
      measured: nucleus.measured,
      frame: usedValues.length
    }

    if (cometMode === 'comet') {
      toStack.forEach((f, i) => (f.transformation = onComet[i]))
      sumOptions = cometSum
    } else {
      // Comet and still stars: first the sum on the comet, from which the
      // comet alone (the layer) is extracted; then it is subtracted from each
      // frame where it was, the frames are summed on the stars, and finally
      // the comet is put back on top, still and sharp.
      const sumOnComet = await stackInParallel(
        toStack.map((f, i) => ({ ...f, transformation: onComet[i] })),
        cometSum,
        (fraction) => advance(t('hooksUseStacking.progress.stackingOnComet'), 0.66 + fraction * 0.16)
      )
      advance(t('hooksUseStacking.progress.separatingComet'), 0.82)
      await new Promise((r) => setTimeout(r, 30))
      const shift = (i: number): { x: number; y: number } => ({
        x: nucleus.positions[i].x - refCount.x,
        y: nucleus.positions[i].y - refCount.y
      })
      layer = extractCometLayer(sumOnComet.image, refCount, expand(usedValues[0].image), {
        from: shift(iFirst),
        a: shift(iLast)
      })
      // The frames are modified in place: they are analyzed copies made for
      // this stack, no longer needed once the job is done.
      const s = layer
      toStack.forEach((f, i) =>
        subtractLayerFromFrame(expand(f.image), f.transformation, shift(i), s, f.normalization?.scale[0] ?? 1)
      )
      sumStart = 0.83
      if (isDrizzleActive(d)) {
        drizzleNotice = t('hooksUseStacking.drizzle.notWithCometAndStars')
        d = undefined
      }
    }
  }
  // Bayer drizzle applies only if all frames used are raw color sensor
  // frames with the same pattern; otherwise it falls back to normal drizzle
  // (or to the normal sum, at 1×) and says so.
  let bayerPattern: BayerPattern | undefined
  if (d && d.bayer) {
    const first = patternsUsed[0]
    if (first !== undefined && patternsUsed.every((s) => s === first)) {
      bayerPattern = first
    } else {
      drizzleNotice = t(
        d.factor > 1 ? 'hooksUseStacking.drizzle.bayerFallbackDrizzle' : 'hooksUseStacking.drizzle.bayerFallbackStack'
      )
      d = { ...d, bayer: false }
    }
  }
  if (isDrizzleActive(d)) {
    const memory = await insufficientDrizzleMemory(toStack, sumOptions, d)
    if (memory !== null) {
      drizzleNotice = memory
      d = undefined
    }
  }
  if (isDrizzleActive(d)) {
    const dd = d
    const r = await drizzleParallel(
      toStack,
      sumOptions,
      dd,
      (fraction) =>
        advance(
          t(bayerPattern ? 'hooksUseStacking.progress.bayerDrizzle' : 'hooksUseStacking.progress.drizzle'),
          sumStart + fraction * (0.98 - sumStart)
        ),
      bayerPattern
    )
    result = r
    drizzleResult = {
      factor: dd.factor,
      pixfrac: dd.pixfrac,
      meanCoverage: r.meanContribution,
      emptyFraction: r.emptyFraction,
      bayer: bayerPattern !== undefined
    }
  } else {
    result = await stackInParallel(toStack, sumOptions, (fraction) =>
      advance(
        cometMode === 'comet'
          ? t('hooksUseStacking.progress.stackingOnComet')
          : cometMode === 'both'
            ? t('hooksUseStacking.progress.stackingOnStars')
            : t('hooksUseStacking.progress.stacking'),
        sumStart + fraction * (0.98 - sumStart)
      )
    )
  }
  // The comet, still and sharp, goes back on top of the stars.
  if (layer) addLayer(result.image, layer)

  // --- Edges: where few frames contribute, a crop is proposed ---
  // Without alignment the frames overlap completely and there is nothing to
  // remove.
  const crop =
    options.alignment && options.edgeTrim !== false
      ? (suggestCoverageCrop(
          toStack.map((f) => ({
            transformation: f.transformation,
            width: f.image.width,
            height: f.image.height
          })),
          reference.image.width,
          reference.image.height,
          CROP_COVERAGE
        ) ?? undefined)
      : undefined

  return {
    drizzle: drizzleResult,
    drizzleNotice,
    crop,
    image: result.image,
    referenceId: reference.id,
    results,
    usedFrames: toStack.length,
    rejectedValues: result.rejectedValues,
    noiseBefore,
    // At single-frame scale: with drizzle the pixels are smaller.
    noiseAfter: estimateNoise(result.image, drizzleResult?.factor ?? 1),
    alignments: alignmentOf,
    comet: cometResult,
    nights: nightResults
  }
}

export function useStacking(): {
  inProgress: boolean
  summary: StackingSummary | null
  start: (options: StartOptions) => Promise<void>
} {
  const [inProgress, setInProgress] = useState(false)
  const [summary, setSummary] = useState<StackingSummary | null>(null)

  const setJob = useApp((s) => s.setJob)
  const finishJob = useApp((s) => s.finishJob)
  const notify = useApp((s) => s.notify)
  const setActiveFrame = useApp((s) => s.setActiveFrame)
  const updateAdjustments = useApp((s) => s.updateAdjustments)
  const setCrop = useApp((s) => s.setCrop)

  const start = useCallback(
    async (options: StartOptions): Promise<void> => {
      const toUse = toIntegrate(useApp.getState().frame)

      if (toUse.length < 2) {
        notify('warning', t('hooksUseStacking.needTwoLights'))
        return
      }

      // Series of different exposures to merge in HDR: depends only on the
      // capture data, and is already needed by the memory estimate.
      const series =
        options.hdr === false || (options.comet && options.comet.mode !== 'stars')
          ? null
          : seriesToMerge(seriesPerExposure(toUse.map((f) => ({ id: f.id, exposure: f.metadata.exposure }))))

      // --- Memory: checked before starting, not halfway through ---
      // If the frames do not fit with all the workers, fewer are used; if
      // they do not fit even with one, stop here with an explanation.
      const workerPool = analysisWorkerPool()
      const sums = series ? series.length + 2 : options.comet?.mode === 'both' ? 3 : 1
      const estimate = await estimateStackingMemory(
        toUse,
        workerPool.size,
        sums,
        options.comet !== undefined && options.comet.mode !== 'stars'
      )
      if (estimate && estimate.workers === 0) {
        notify('error', estimate.notice ?? t('hooksUseStacking.insufficientMemory'))
        return
      }
      // Recently opened frames are released if their memory is needed.
      if (estimate?.freeCache) frameCache.clear()
      const inParallel = Math.min(estimate?.workers ?? workerPool.size, workerPool.size)

      const calibrationErrors: string[] = []
      const calibrationResults: LightCalibrationResult[] = []

      setInProgress(true)
      const startTime = performance.now()

      try {
        if (estimate?.notice) notify('info', estimate.notice)

        // --- Parallel analysis on several cores ---
        const analyzedFrames = new Map<string, AnalyzedFrame>()
        const failedItems: string[] = []

        let completedItems = 0
        setJob(t('hooksUseStacking.progress.analyzingParallel', { count: inParallel }), 0.02)

        // A short queue: each process reads its next file only after
        // finishing the previous one. Reading them all at once would load
        // every file into memory before the analysis even starts.
        let next = 0
        const work = async (): Promise<void> => {
          while (next < toUse.length) {
            const frame = toUse[next++]
            try {
              const analyzed = await analyzeFrame(frame, options.alignment)
              analyzed.timestamp = shotTimestamp(frame.metadata)
              if (analyzed.calibrationError) {
                calibrationErrors.push(frame.fileName + ': ' + analyzed.calibrationError)
              }
              if (analyzed.calibration) calibrationResults.push(analyzed.calibration)
              analyzedFrames.set(frame.id, analyzed)
            } catch (e) {
              failedItems.push(frame.fileName + ': ' + (e instanceof Error ? e.message : String(e)))
            } finally {
              completedItems++
              setJob(
                t('hooksUseStacking.progress.analyzing', { done: completedItems, total: toUse.length }),
                (completedItems / toUse.length) * 0.55
              )
            }
          }
        }
        await Promise.all(Array.from({ length: Math.max(1, Math.min(inParallel, toUse.length)) }, work))
        // The analysis workers still hold the remains of the last frame:
        // close them, so that memory is free for the sum.
        workerPool.dismiss()

        // In library order.
        // Night of each frame, from the capture date (or from the folder).
        const nights = groupByNight(
          toUse.map((f) => ({
            id: f.id,
            path: f.path,
            dateObs: f.metadata.dateObs,
            longitude: f.metadata.instrumentInfo?.siteLongitude ?? null
          }))
        )
        for (const n of nights) {
          for (const id of n.frame) {
            const a = analyzedFrames.get(id)
            if (a) a.night = { key: n.key, label: n.label }
          }
        }

        const availableItems = toUse
          .map((f) => analyzedFrames.get(f.id))
          .filter((f): f is AnalyzedFrame => f !== undefined)
        if (availableItems.length < 2) {
          throw new Error(t('hooksUseStacking.notEnoughReadable', { detail: failedItems[0] ?? '' }))
        }

        const { result, hdr } = series
          ? await stackWithHdr(series, availableItems, options, setJob)
          : { result: await stackAnalyzed(availableItems, options, setJob), hdr: undefined }

        // The analyzed frames are no longer needed: release them before
        // showing the result, which prepares a copy of it for the GPU. The
        // stacking workers also hold references to the frames until they
        // clear their memory: close them.
        analyzedFrames.clear()
        availableItems.length = 0
        stackingWorkerPool().dismiss()

        // The result replaces the image shown in the viewer.
        if (result.drizzle && result.drizzle.factor > 1) {
          // With drizzle the pixels are smaller: the astrometric solution and
          // the scale of the reference frame must be brought to the fine
          // grid, otherwise field scale, object sizes and photometry would be
          // off by the same factor.
          const f = result.drizzle.factor
          showResult(result.referenceId, result.image, (m) => ({
            wcs: m.wcs !== null ? wcsScale(m.wcs, f) : null,
            pixelScale: m.pixelScale !== null ? m.pixelScale / f : null,
            type: 'drizzle'
          }))
        } else {
          showStacked(result.referenceId, result.image)
        }
        // Frames and exposures used, for the export caption.
        rememberIntegration(result.referenceId, result.image, result.results.filter((e) => e.isUsed).map((e) => e.id))
        updateAdjustments({ stretch: autoStretch(result.image) })
        // The crop must be set after showing the result, which resets the
        // previous one. It can still be changed in the Export step.
        if (result.crop) setCrop(result.crop.crop)

        const calibration = calibrationResults.length > 0 ? summarizeCalibration(calibrationResults) : undefined
        setSummary({
          usedFrames: result.usedFrames,
          totalFrames: toUse.length,
          results: result.results,
          method: options.method,
          timeSeconds: (performance.now() - startTime) / 1000,
          rejectedValues: result.rejectedValues,
          noiseBefore: result.noiseBefore,
          noiseAfter: result.noiseAfter,
          drizzle: result.drizzle,
          crop: result.crop,
          comet: result.comet,
          nights: result.nights,
          hdr,
          calibration
        })

        finishJob()
        notify(
          'ok',
          t('hooksUseStacking.done.summary', {
            used: result.usedFrames,
            total: toUse.length,
            nights: result.nights
              ? t('hooksUseStacking.done.nights', {
                  count: result.nights.length,
                  weights: result.nights.map((n) => formatWeight(n.weight)).join(', ')
                })
              : '',
            hdr: hdr
              ? t('hooksUseStacking.done.hdr', {
                  series: hdr.series
                    .map((x) =>
                      t('hooksUseStacking.done.hdrSeries', {
                        frames: x.frame,
                        exposure: formatNumber(x.exposure)
                      })
                    )
                    .join(t('hooksUseStacking.done.and')),
                  percent: Math.round(hdr.replacedShare * 100)
                })
              : ''
          })
        )
        if (result.drizzleNotice) notify('warning', result.drizzleNotice)
        if (failedItems.length > 0) notify('warning', t('hooksUseStacking.unreadableFrames', { count: failedItems.length }))
        if (calibrationErrors.length > 0) {
          notify('warning', t('hooksUseStacking.calibrationSkipped', { detail: calibrationErrors[0] }))
        }
        // Lights without a suitable dark: reported group by group.
        for (const g of calibration ?? []) {
          const text = noDarkNotice(g)
          if (text) notify('warning', text)
        }
        const fromLibrary = [
          ...new Set(
            (calibration ?? []).flatMap((g) =>
              [g.dark, g.flat, g.bias].filter((u) => u !== null && u.origin === 'library').map((u) => u!.description)
            )
          )
        ]
        if (fromLibrary.length > 0) {
          notify('info', t('hooksUseStacking.calibratedWithLibrary', { masters: fromLibrary.join('; ') }))
        }
        const unread = new Set(calibrationResults.flatMap((e) => e.unread))
        if (unread.size > 0) {
          notify(
            'warning',
            unread.size === 1
              ? t('hooksUseStacking.unreadMaster.one')
              : t('hooksUseStacking.unreadMaster.other', { count: unread.size })
          )
        }
      } catch (e) {
        finishJob()
        notify('error', e instanceof Error ? e.message : String(e))
      } finally {
        // Even after an error: idle workers must not hold on to frames.
        analysisWorkerPool().dismiss()
        stackingWorkerPool().dismiss()
        setInProgress(false)
      }
    },
    [setJob, finishJob, notify, setActiveFrame, updateAdjustments, setCrop]
  )

  return { inProgress, summary, start }
}

/**
 * Stacks the series of different exposures separately and merges them in
 * HDR. Each series goes through `stackAnalyzed` like a normal stack (frame
 * selection, nights, rejection); then each shorter series is aligned on the
 * longest one using the stars of the two stacks and merged with `mergeHdr`.
 */
async function stackWithHdr(
  series: ExposureSeries[],
  availableItems: AnalyzedFrame[],
  options: StartOptions,
  advance: (label: string, fraction: number) => void
): Promise<{ result: StackAnalyzedResult; hdr: HdrResult }> {
  const results: { exposure: number; result: StackAnalyzedResult }[] = []
  for (let k = 0; k < series.length; k++) {
    const s = series[k]
    const ids = new Set(s.ids)
    const group = availableItems.filter((f) => ids.has(f.id))
    if (group.length < 2) continue
    const name = t('hooksUseStacking.hdr.seriesName', { exposure: formatNumber(s.exposure) })
    const result = await stackAnalyzed(group, options, (label, fraction) =>
      advance(name + ': ' + label.charAt(0).toLowerCase() + label.slice(1), (k + fraction) / series.length * 0.9)
    )
    results.push({ exposure: s.exposure, result })
  }
  if (results.length < 2) throw new Error(t('hooksUseStacking.hdr.needTwoSeries'))

  const base = results[0].result
  let image = base.image
  let last = { ratio: 1, replacedShare: 0 }
  const baseStars = detectStars(base.image)
  for (const other of results.slice(1)) {
    advance(t('hooksUseStacking.progress.hdrMerge', { exposure: formatNumber(other.exposure) }), 0.93)
    const stars = detectStars(other.result.image)
    const alignment = align(baseStars, stars)
    if (!alignment.valid) {
      throw new Error(t('hooksUseStacking.hdr.seriesNotAligned', { exposure: formatNumber(other.exposure) }))
    }
    // The short series resampled onto the geometry of the long one.
    const aligned = stack(
      [{ image: other.result.image, transformation: alignment.transformation, weight: 1 }],
      { method: 'mean', rejectionThreshold: 3 }
    ).image
    const merged = mergeHdr(image, aligned)
    image = merged.image
    last = { ratio: merged.ratio, replacedShare: merged.replacedShare }
  }

  return {
    result: {
      ...base,
      image,
      results: results.flatMap((e) => e.result.results),
      usedFrames: results.reduce((t, e) => t + e.result.usedFrames, 0)
    },
    hdr: {
      series: results.map((e) => ({ exposure: e.exposure, frame: e.result.usedFrames })),
      ratio: last.ratio,
      replacedShare: last.replacedShare
    }
  }
}
