import type { ImageData32 } from '@shared/types'
import { formatDecimal, t } from '@shared/i18n/i18n'
import { relativeQuality, type SessionMeasurement, type Star } from '@core/stars/detection'
import type { Transformation } from './alignment'

/**
 * Multi-night stacking.
 *
 * Captures of the same object taken on different evenings are not
 * equivalent: one night has a more transparent sky, another a high Moon
 * and a bright background, yet another turbulence that widens the stars.
 * Summing them as if they were a single session leads to three errors:
 *   1. the rejection of bad frames compares each frame with the best ones
 *      of all nights, and a slightly hazy night ends up discarded as a
 *      whole even though its frames, among themselves, are good;
 *   2. outlier pixel rejection sees the background difference between one
 *      night and another as a disturbance, and discards good signal;
 *   3. a noisy night counts as much as a clean one, and worsens the result
 *      instead of improving it.
 *
 * This file holds the pure parts that remedy this: recognising nights from
 * the capture date, the score of frames within each night, background and
 * noise measurements on a sample of pixels, the transparency factor from
 * the stars in common, and finally weights and normalisation of each night.
 * With a single night none of these functions changes anything: the score
 * matches that of the session and the weights are not computed.
 */

/* ---- Night recognition ---- */

/** A light frame, with what is needed to tell which night it belongs to. */
export interface FrameToGroup {
  id: string
  path: string
  /** Exposure start date (DATE-OBS), ISO. */
  dateObs: string | null
  /** Longitude of the site in degrees, positive east (SITELONG), if known. */
  longitude?: number | null
}

export interface Night {
  /**
   * Stable key: the date of the evening on which the night begins
   * ("2026-10-12"), or the "folder:" prefix followed by the folder of
   * the files without a date.
   */
  key: string
  /** "Night of 12 October", or "Folder “M31 evening 2”". */
  label: string
  /** Identifiers of the frames, in the order received. */
  frame: string[]
  /** True if the night was inferred from the folder because the date was missing. */
  perFolder: boolean
}

/**
 * Instant in milliseconds since 1970 of a FITS date. FITS dates are in
 * universal time even when they do not say so: without the trailing "Z"
 * they would be read as local time.
 */
export function utcTimestamp(dateObs: string | null | undefined): number | undefined {
  if (!dateObs) return undefined
  const text = dateObs.trim()
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(text) || !text.includes('T') ? text : text + 'Z'
  const ms = Date.parse(withZone)
  return Number.isFinite(ms) ? ms : undefined
}

/** Offset in minutes between the computer's time and universal time, at that instant. */
export function computerTimeZone(ms: number): number {
  return -new Date(ms).getTimezoneOffset()
}

/**
 * Date of the evening on which the night of an exposure begins, as
 * "YYYY-MM-DD". The night runs from noon to noon in local time of the
 * site: exposures from 9 pm to 3 am the next morning fall in the same one.
 * With the longitude of the site the local solar time is used (one hour
 * per 15 degrees), which depends neither on the computer's time zone nor
 * on daylight saving time; without it, the local time of the computer,
 * which is almost always that of the person who captured the frames.
 */
export function nightKey(
  timestamp: number,
  longitude: number | null | undefined,
  timeZone: (ms: number) => number = computerTimeZone
): string {
  const minutesDeviation =
    longitude !== null && longitude !== undefined && Number.isFinite(longitude)
      ? (((longitude + 540) % 360) - 180) * 4
      : timeZone(timestamp)
  const d = new Date(timestamp + minutesDeviation * 60000 - 12 * 3600000)
  const two = (n: number): string => (n < 10 ? '0' : '') + n
  return d.getUTCFullYear() + '-' + two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate())
}

/** Folder of a path, with backslashes or forward slashes. */
function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(0, i) : ''
}

/** "Night of 12 October", "Night of 8 October", "Night of 1st October". */
function dateLabel(key: string, withYear: boolean): string {
  const [year, month, day] = key.split('-').map(Number)
  const dayText = day === 1 ? t('coreNights.firstOfMonth') : String(day)
  const text = t(day === 8 || day === 11 ? 'coreNights.nightOfElided' : 'coreNights.nightOf', {
    day: dayText,
    month: t('coreNights.months.m' + month)
  })
  return text + (withYear ? ' ' + year : '')
}

/**
 * Groups frames by night. Those without a readable date are grouped by
 * source folder, the only remaining clue (people who capture several
 * nights usually keep each evening in its own folder). Nights with a date
 * come first, in date order; then the folders.
 */
export function groupByNight(
  frame: FrameToGroup[],
  timeZone: (ms: number) => number = computerTimeZone
): Night[] {
  const byKey = new Map<string, Night>()
  for (const f of frame) {
    const t = utcTimestamp(f.dateObs)
    let key: string
    let perFolder = false
    if (t !== undefined) {
      key = nightKey(t, f.longitude, timeZone)
    } else {
      key = 'folder:' + folderOf(f.path)
      perFolder = true
    }
    let night = byKey.get(key)
    if (!night) {
      night = { key, label: '', frame: [], perFolder }
      byKey.set(key, night)
    }
    night.frame.push(f.id)
  }
  const nights = [...byKey.values()].sort((a, b) =>
    a.perFolder !== b.perFolder ? (a.perFolder ? 1 : -1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  )
  const years = new Set(nights.filter((n) => !n.perFolder).map((n) => n.key.slice(0, 4)))
  for (const n of nights) {
    if (n.perFolder) {
      const folder = n.key.slice('folder:'.length)
      const name = folder.slice(Math.max(folder.lastIndexOf('/'), folder.lastIndexOf('\\')) + 1)
      n.label = name ? t('coreNights.folderLabel', { name }) : t('coreNights.undatedFrames')
    } else {
      n.label = dateLabel(n.key, years.size > 1)
    }
  }
  return nights
}

/* ---- Quality within each night ---- */

/**
 * Relative score (`relativeQuality`) computed by comparing each frame only
 * with those of its own night. A slightly hazy night has fewer stars than
 * a clear one in all its frames: compared with the other it would fall
 * below the threshold entirely, while within itself the good frames stay
 * good and only the worst ones of that evening are discarded. How much the
 * whole night should count is then decided by its weight (`weighNights`).
 *
 * With a single night the result matches `relativeQuality`.
 */
export function qualityPerNight(measurements: SessionMeasurement[], nights: string[]): number[] {
  const groups = new Map<string, number[]>()
  nights.forEach((n, i) => {
    const g = groups.get(n)
    if (g) g.push(i)
    else groups.set(n, [i])
  })
  if (groups.size <= 1) return relativeQuality(measurements)
  const result = new Array<number>(measurements.length).fill(0)
  for (const indices of groups.values()) {
    const relative = relativeQuality(indices.map((i) => measurements[i]))
    indices.forEach((i, k) => (result[i] = relative[k]))
  }
  return result
}

/* ---- Measurements on a sample of pixels ---- */

/** Pixels measured per frame: enough for medians stable to a thousandth, at very little cost. */
export const BACKGROUND_SAMPLES = 16384

export interface BackgroundStatistics {
  /** Sky background level per channel: median of the sample. */
  background: number[]
  /** Typical noise deviation per channel. */
  noise: number[]
}

function median(values: Float32Array, count: number): number {
  if (count === 0) return 0
  const v = values.subarray(0, count).sort()
  const m = count >> 1
  return count % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * Background and noise of a frame, measured on about `samples` pixels
 * taken on a regular grid rather than on all of them: for a frame of 24
 * million values it is a thousandth of the work, and the median does not
 * change.
 *
 * The background is the median of the sample: stars and nebula occupy a
 * small part of the field and do not shift it. Noise is measured on the
 * difference between each pixel and the one two columns away: the signal,
 * which varies slowly, cancels out, leaving the noise multiplied by the
 * square root of two. The distance of two pixels avoids the immediate
 * neighbours, which in colour sensors were reconstructed from one another
 * and would appear less noisy than they really are. Of the difference the
 * median absolute deviation is taken, which stars do not inflate.
 * Pixels at zero (outside the field) are ignored.
 */
export function backgroundStatistics(image: ImageData32, samples = BACKGROUND_SAMPLES): BackgroundStatistics {
  const { width: w, height: h, channels: channels, data } = image
  const n = w * h
  const step = Math.max(1, Math.floor(Math.sqrt(n / samples)))
  const max = Math.ceil(w / step) * Math.ceil(h / step)
  const values = new Float32Array(max)
  const differences = new Float32Array(max)
  const background: number[] = []
  const noise: number[] = []
  for (let c = 0; c < channels; c++) {
    const base = c * n
    let count = 0
    let diffCount = 0
    for (let y = step >> 1; y < h; y += step) {
      const row = base + y * w
      for (let x = step >> 1; x < w; x += step) {
        const v = data[row + x]
        if (v === 0) continue
        values[count++] = v
        if (x + 2 < w) {
          const v2 = data[row + x + 2]
          if (v2 !== 0) differences[diffCount++] = v - v2
        }
      }
    }
    const level = median(values, count)
    background.push(level)
    // First estimate of the noise on all pairs; then the second, only on
    // background pairs (both pixels within 4 deviations of the level):
    // star edges give large differences that, in a rich field, would
    // inflate the estimate by a good 10%.
    const before = madOfDifferences(differences, diffCount)
    const limit = 4 * before
    let kept = 0
    for (let y = step >> 1; y < h; y += step) {
      const row = base + y * w
      for (let x = step >> 1; x + 2 < w; x += step) {
        const v = data[row + x]
        const v2 = data[row + x + 2]
        if (v === 0 || v2 === 0) continue
        if (Math.abs(v - level) > limit || Math.abs(v2 - level) > limit) continue
        differences[kept++] = v - v2
      }
    }
    noise.push(kept >= 100 ? madOfDifferences(differences, kept) : before)
  }
  return { background, noise }
}

/**
 * Typical noise deviation from the differences between pixels: the median
 * absolute deviation around the median, times 1.4826 (which converts it to
 * a standard deviation) and divided by the square root of two (the
 * difference of two pixels has double the variance). Modifies `differences`
 * in place.
 */
function madOfDifferences(differences: Float32Array, count: number): number {
  const center = median(differences, count)
  for (let i = 0; i < count; i++) differences[i] = Math.abs(differences[i] - center)
  return (median(differences, count) * 1.4826) / Math.SQRT2
}

/**
 * Transparency of a frame relative to the reference: the median of the
 * ratios between the flux of a star in the reference and that of the same
 * star in the frame. It is 1 if the sky was equally transparent, 1.5 if
 * the stars arrived with two thirds of the light (haze, mist, a lower
 * object). Stars are paired by bringing those of the frame onto the
 * reference with the alignment transformation and looking for the nearest
 * one within a pixel and a half. The brightest stars are used, as their
 * flux is measured with less uncertainty.
 *
 * Returns null if there are too few pairs to be trusted.
 */
export function fluxRatio(reference: Star[], stars: Star[], t: Transformation, count = 80): number | null {
  if (reference.length < 5 || stars.length < 5) return null
  // Grid of 4-pixel cells to look for neighbours without comparing every star with every other.
  const CELL = 4
  const grid = new Map<number, Star[]>()
  const cell = (x: number, y: number): number => Math.floor(y / CELL) * 100003 + Math.floor(x / CELL)
  for (const s of reference) {
    if (!(s.flux > 0)) continue
    const k = cell(s.x, s.y)
    const g = grid.get(k)
    if (g) g.push(s)
    else grid.set(k, [s])
  }
  const brightest = [...stars].filter((s) => s.flux > 0).sort((a, b) => b.flux - a.flux).slice(0, count)
  const ratios: number[] = []
  const radius2 = 1.5 * 1.5
  for (const s of brightest) {
    const x = t.a * s.x - t.b * s.y + t.tx
    const y = t.b * s.x + t.a * s.y + t.ty
    let best: Star | null = null
    let distance = radius2
    const cx = Math.floor(x / CELL)
    const cy = Math.floor(y / CELL)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const g = grid.get((cy + dy) * 100003 + cx + dx)
        if (!g) continue
        for (const r of g) {
          const d = (r.x - x) * (r.x - x) + (r.y - y) * (r.y - y)
          if (d < distance) {
            distance = d
            best = r
          }
        }
      }
    }
    if (best) ratios.push(best.flux / s.flux)
  }
  if (ratios.length < 5) return null
  ratios.sort((a, b) => a - b)
  const m = ratios.length >> 1
  return ratios.length % 2 === 1 ? ratios[m] : (ratios[m - 1] + ratios[m]) / 2
}

/** Median of a list of numbers; null if it is empty. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const v = [...values].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2
}

/* ---- Weight and normalisation of each night ---- */

/** The measurements of a night, taken from its stacked frames. */
export interface NightMeasurements {
  key: string
  label: string
  /** Frames of the night that enter the sum. */
  frame: number
  /** Median HFR of the stars in the frames of the night, in pixels; 0 if unknown. */
  hfr: number
  /** Sky background per channel (median of the measured frames). */
  background: number[]
  /** Noise per channel (median of the measured frames), in the units of the frame. */
  noise: number[]
  /**
   * Star flux ratio "reference / frame" (median over the frames of the
   * night); null if not measurable.
   */
  flux: number | null
}

/** The choices of whoever stacks: weights set by hand and excluded nights. */
export interface NightsChoice {
  /** Weight set by hand per night, from 0 to 1; missing nights are automatic. */
  weights?: Record<string, number>
  /** Nights to leave out. */
  excludedNights?: string[]
}

/** The result for a night: how it is normalised, how much it weighs and why. */
export interface NightResult {
  key: string
  label: string
  frame: number
  hfr: number
  /** Background noise after normalisation, in the units of the reference night. */
  noise: number
  /** Sky background before normalisation (mean of the channels). */
  background: number
  /**
   * Multiplicative factor that brings the night to the scale of the reference
   * (1 for the reference night; more than 1 if the sky was less transparent).
   */
  scale: number
  /** Additive term per channel, applied after the scale. */
  shift: number[]
  /** Weight computed by StarLight, from 0 to 1: the best night is 1. */
  proposedWeight: number
  /** Weight actually used: the proposed one, or the one set by hand. */
  weight: number
  manual: boolean
  /** True for the night of the reference frame. */
  reference: boolean
  /** Short explanation, to be displayed as it is. */
  explanation: string
}

/** Limits of the transparency factor: beyond them, the measurement is to be considered wrong. */
const MIN_SCALE = 0.25
const MAX_SCALE = 4

const mean = (v: number[]): number => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0)

/** "0.42" (decimal separator follows the language) */
export function formatWeight(p: number): string {
  return formatDecimal(p, 2)
}

function times(r: number): string {
  if (r >= 1.9 && r <= 2.1) return t('coreNights.times.double')
  if (r >= 2.9 && r <= 3.1) return t('coreNights.times.triple')
  const value = formatDecimal(r, 1)
  return t('coreNights.times.other', { value })
}

/**
 * Weight and normalisation of each night.
 *
 * Normalisation (additive and multiplicative). Each night is brought to
 * the scale and background of the reference night, the one of the frame
 * on which everything is aligned:
 *     normalised_value = scale · value + shift_c
 *     scale = transparency of the night / transparency of the reference
 *     shift_c = background_ref,c − scale · background_night,c
 * where transparency is the median flux ratio of the stars in common with
 * the reference frame (`fluxRatio`) and the background is the median of
 * the sample (`backgroundStatistics`). The scale comes from the stars and
 * not from the dispersion of the pixels because the dispersion, on the
 * background, is almost all noise: equalising it would make all nights
 * equally noisy on paper, and the weight would no longer distinguish
 * anything. After normalisation a star has the same value on all nights
 * and the background the same level, so outlier pixel rejection compares
 * homogeneous values and does not mistake a brighter background for a
 * disturbance.
 *
 * Weight (inverse-variance weighting). This is the classic method for
 * combining measurements of different precision: the weighted mean with
 * weights 1/σ² has the minimum variance among all weighted means (Gauss-
 * Markov theorem; see for example P. R. Bevington and D. K. Robinson,
 * "Data Reduction and Error Analysis for the Physical Sciences", ch. 4,
 * "weighted mean"). Here σ is the background noise of the night after
 * normalisation (scale · measured noise), and the variance is corrected for
 * sharpness: the light of a star is spread over an area that grows with
 * the square of the HFR, so the signal-to-noise ratio of a point source
 * goes as 1/(σ · HFR), and the weight that maximises it as
 *     night_weight ∝ 1 / (σ_normalised² · HFR²)
 * Weights are divided by the largest, so the best night is 1. Each frame
 * then receives its own weight multiplied by that of the night, and every
 * frame of the night counts as one observation: a night with twice the
 * frames already counts twice, with nothing else needed.
 *
 * A weight set by hand replaces the proposed one; excluded nights (or with
 * weight 0) do not appear in the result: the caller removes them first.
 */
export function weighNights(measurements: NightMeasurements[], referenceKey: string, choices: NightsChoice = {}): NightResult[] {
  if (measurements.length === 0) return []
  const ref = measurements.find((m) => m.key === referenceKey) ?? measurements[0]
  const withHfr = measurements.every((m) => m.hfr > 0)

  const partials = measurements.map((m) => {
    let scale = 1
    if (m !== ref && m.flux !== null && ref.flux !== null && m.flux > 0 && ref.flux > 0) {
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, m.flux / ref.flux))
    }
    const shift = m.background.map((f, c) => (m === ref ? 0 : (ref.background[c] ?? f) - scale * f))
    const noise = scale * mean(m.noise)
    const variance = noise * noise * (withHfr ? m.hfr * m.hfr : 1)
    return { m, scale, shift, noise, raw: variance > 0 ? 1 / variance : 0 }
  })
  const max = Math.max(...partials.map((p) => p.raw))
  const best = partials.find((p) => p.raw === max) ?? partials[0]

  return partials.map((p) => {
    const proposed = max > 0 ? p.raw / max : 1
    const chosen = choices.weights?.[p.m.key]
    const manual = chosen !== undefined && Number.isFinite(chosen)
    const weight = manual ? Math.min(1, Math.max(0, chosen as number)) : proposed

    // --- Explanation, relative to the best night ---
    let reason: string
    if (p === best) {
      reason = t('coreNights.reason.best')
    } else {
      const reasons: string[] = []
      const hereBackground = mean(p.m.background)
      const bestBackground = mean(best.m.background)
      if (bestBackground > 0 && hereBackground / bestBackground > 1.15) reasons.push(t('coreNights.reason.brighterBackground'))
      else if (bestBackground > 0 && hereBackground / bestBackground < 0.87) reasons.push(t('coreNights.reason.darkerBackground'))
      const transparency = p.scale / best.scale
      if (transparency > 1.15) {
        reasons.push(t('coreNights.reason.lessTransparent', { percent: Math.round((1 - 1 / transparency) * 100) }))
      }
      const r = best.noise > 0 ? p.noise / best.noise : 1
      if (r > 1.1) reasons.push(t('coreNights.reason.noise', { factor: times(r) }))
      if (withHfr && best.m.hfr > 0) {
        const h = p.m.hfr / best.m.hfr
        if (h > 1.08) reasons.push(t('coreNights.reason.widerStars', { percent: Math.round((h - 1) * 100) }))
      }
      reason =
        reasons.length === 0
          ? t('coreNights.reason.similar')
          : reasons.length === 1
            ? reasons[0]
            : t('coreNights.reason.joinLast', { list: reasons.slice(0, -1).join(', '), last: reasons[reasons.length - 1] })
    }
    let explanation = t('coreNights.explanation.automatic', { label: p.m.label, weight: formatWeight(proposed), reason })
    if (manual) {
      explanation = t('coreNights.explanation.manual', {
        label: p.m.label,
        weight: formatWeight(weight),
        proposed: formatWeight(proposed),
        reason
      })
    }

    return {
      key: p.m.key,
      label: p.m.label,
      frame: p.m.frame,
      hfr: p.m.hfr,
      noise: p.noise,
      background: mean(p.m.background),
      scale: p.scale,
      shift: p.shift,
      proposedWeight: proposed,
      weight,
      manual,
      reference: p.m === ref,
      explanation
    }
  })
}
