import type { ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'

/**
 * HDR merge of series taken with different exposures.
 *
 * When an object has areas much brighter than the rest (the core of a
 * nebula, the centre of a galaxy), the long exposures that reveal the faint
 * parts saturate the centre in every frame: the information is not there,
 * and no processing can recover it. A second series of short exposures
 * records the centre without saturating it. Here the two series, each
 * stacked on its own and aligned to each other, become a single image:
 *
 *   1. the brightness ratio between the long and the short series is not
 *      taken from the declared exposure times but measured on the pixels
 *      that are well exposed in both, together with the background level:
 *      this holds for different gains or offsets and for a sky that changed
 *      between the two series;
 *   2. where the long series is far from saturation it is kept, as it has
 *      the lower noise;
 *   3. where it approaches saturation the short series, scaled to the same
 *      level, takes over with a gradual transition;
 *   4. the result, which now exceeds the white level of the long series, is
 *      brought back between 0 and 1 by dividing everything by the same
 *      number: it stays linear, ready for stretching and finishing.
 */

/** A series of frames with the same exposure time. */
export interface ExposureSeries {
  /** Exposure in seconds. */
  exposure: number
  ids: string[]
}

/** Two exposures belong to the same series if they differ by less than this (proportionally). */
const EXPOSURE_TOLERANCE = 0.03

/** Minimum ratio between exposures for the merge to make sense. */
export const MIN_RATIO_HDR = 1.5

/** Minimum number of frames in a series to stack it on its own. */
export const MIN_SERIES_FRAMES = 2

/**
 * Groups frames by exposure time, longest first. Frames without a declared
 * exposure are left out of the groups.
 */
export function seriesPerExposure(frame: { id: string; exposure: number | null }[]): ExposureSeries[] {
  const series: ExposureSeries[] = []
  for (const f of frame) {
    if (f.exposure === null || !(f.exposure > 0)) continue
    const s = series.find((x) => Math.abs(x.exposure - f.exposure!) <= EXPOSURE_TOLERANCE * Math.max(x.exposure, f.exposure!))
    if (s) s.ids.push(f.id)
    else series.push({ exposure: f.exposure, ids: [f.id] })
  }
  return series.sort((a, b) => b.exposure - a.exposure)
}

/**
 * The series to merge, longest first, or null if the merge cannot be
 * done: at least two series with enough frames and exposures that differ by
 * at least MIN_RATIO_HDR are required.
 */
export function seriesToMerge(series: ExposureSeries[]): ExposureSeries[] | null {
  const validOnes = series.filter((s) => s.ids.length >= MIN_SERIES_FRAMES)
  if (validOnes.length < 2) return null
  const choices: ExposureSeries[] = [validOnes[0]]
  for (const s of validOnes.slice(1)) {
    if (choices[choices.length - 1].exposure / s.exposure >= MIN_RATIO_HDR) choices.push(s)
  }
  return choices.length >= 2 ? choices : null
}

export interface MergeResult {
  image: ImageData32
  /** How many times brighter the long series is than the short one (measured). */
  ratio: number
  /** Share of pixels where the short series took over, even partially. */
  replacedShare: number
  /** Number by which the result was divided to stay between 0 and 1. */
  divisor: number
}

export interface MergeOptions {
  /** From here (brightness of the long series, 0-1) the short series starts to take over. */
  start: number
  /** From here upward only the short series is used. */
  end: number
}

export const DEFAULT_MERGE: MergeOptions = { start: 0.7, end: 0.9 }

function median(values: number[]): number {
  if (values.length === 0) return 0
  const v = [...values].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** Smooth transition from 0 to 1 between a and b. */
function gradual(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Merges the long and the short series, already aligned and of the same
 * size. Throws an error if the ratio between the two cannot be measured.
 */
export function mergeHdr(long: ImageData32, short: ImageData32, options: MergeOptions = DEFAULT_MERGE): MergeResult {
  if (long.width !== short.width || long.height !== short.height || long.channels !== short.channels) {
    throw new Error(t('coreHdr.differentSizes'))
  }
  const { width: w, height: h, channels } = long
  const n = w * h
  const light = (img: ImageData32, i: number): number => {
    let m = img.data[i]
    for (let c = 1; c < channels; c++) m = Math.max(m, img.data[c * n + i])
    return m
  }

  // Background of each series, per channel: the median of a sample.
  const step = Math.max(1, Math.floor(n / 60000))
  const longBackgrounds: number[] = []
  const shortBackgrounds: number[] = []
  for (let c = 0; c < channels; c++) {
    const l: number[] = []
    const b: number[] = []
    for (let i = 0; i < n; i += step) {
      l.push(long.data[c * n + i])
      b.push(short.data[c * n + i])
    }
    longBackgrounds.push(median(l))
    shortBackgrounds.push(median(b))
  }

  // Noise of the short series on the background, to pick pixels that carry signal.
  const rejectionsB: number[] = []
  for (let i = 0; i < n; i += step) rejectionsB.push(Math.abs(short.data[i] - shortBackgrounds[0]))
  const noiseB = Math.max(1e-6, 1.4826 * median(rejectionsB))

  // Ratio: median of the ratios above the background, only where both
  // series are well exposed (signal in the short one, long one far from white).
  const ratios: number[] = []
  for (let i = 0; i < n; i += Math.max(1, Math.floor(step / 4))) {
    const lv = light(long, i)
    if (lv > options.start * 0.8) continue
    for (let c = 0; c < channels; c++) {
      const sb = short.data[c * n + i] - shortBackgrounds[c]
      const sl = long.data[c * n + i] - longBackgrounds[c]
      if (sb > 10 * noiseB && sl > 0) ratios.push(sl / sb)
    }
  }
  if (ratios.length < 50) {
    throw new Error(t('coreHdr.notEnoughOverlap'))
  }
  const ratio = median(ratios)
  if (!(ratio > 1)) throw new Error(t('coreHdr.shortBrighter'))

  const data = new Float32Array(long.data.length)
  let replaced = 0
  let max = 0
  for (let i = 0; i < n; i++) {
    const weight = gradual(options.start, options.end, light(long, i))
    if (weight > 0) replaced++
    for (let c = 0; c < channels; c++) {
      const k = c * n + i
      const fromShort = (short.data[k] - shortBackgrounds[c]) * ratio + longBackgrounds[c]
      const v = long.data[k] * (1 - weight) + fromShort * weight
      data[k] = v
      if (v > max) max = v
    }
  }
  const divisor = Math.max(1, max)
  if (divisor > 1) for (let k = 0; k < data.length; k++) data[k] /= divisor
  for (let k = 0; k < data.length; k++) if (data[k] < 0) data[k] = 0

  return {
    image: { width: w, height: h, channels, data: data },
    ratio,
    replacedShare: replaced / n,
    divisor
  }
}
