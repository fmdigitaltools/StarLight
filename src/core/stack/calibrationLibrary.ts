import type { BayerPattern, FrameMetadata, ImageData32 } from '@shared/types'
import { formatNumber, t } from '@shared/i18n/i18n'
import { colorAt, debayer } from '@core/image/debayer'
import type { MasterType } from './calibration'
import { utcTimestamp } from './nights'

/**
 * Calibration library: the dark, flat and bias masters built in a session
 * stay on the computer and are reused automatically in later sessions, when
 * the capture conditions match.
 *
 * This is the pure part: the rules used to pick the right master for a
 * frame, the description to display and the conversion of masters to the
 * format in which they are stored. Reading and writing files is done in the
 * main process (src/main/calibration.ts).
 *
 * The rules, by type:
 *   - dark: same sensor, same exposure, same gain, sensor temperature within
 *     TEMPERATURE_TOLERANCE. The thermal signal doubles every 5-6 °C: a
 *     warmer or colder dark would leave a residual.
 *   - bias: same sensor and same gain. The exposure is the shortest and the
 *     temperature matters little.
 *   - flat: same sensor, same filter, captured no more than
 *     MAX_FLAT_AGE_DAYS ago, counted from when the flats were taken and not
 *     from when the master was built. The flat does not depend on the
 *     exposure but on the optical configuration: dust moves and the camera
 *     rotates, and an old flat would introduce shadows that are no longer
 *     there.
 * Among several suitable darks the closest in temperature is chosen and,
 * on a tie, the most recent. Among several suitable flats the one captured
 * closest to the date of the frame is chosen, not the most recent: when
 * stacking several nights each night gets the flat of its own optical
 * configuration (dust and camera rotation of that evening), even if a newer
 * one was built afterwards.
 */

/** Accepted sensor temperature difference for a dark, in °C. */
export const TEMPERATURE_TOLERANCE = 3

/** Maximum age of a flat reused on its own, in days. */
export const MAX_FLAT_AGE_DAYS = 30

/** A master kept in the library, as described by the index. */
export interface MasterEntry {
  id: string
  type: MasterType
  /** Build date, ISO. */
  created: string
  /**
   * Date the frames making up the master were captured (the median of
   * DATE-OBS), ISO. This is the one that counts for the age of a flat: a
   * master built today from last month's flats is a month old. It is
   * missing from entries saved before it existed and when the frames have
   * no date: in that case the build date is used.
   */
  captured?: string | null
  width: number
  height: number
  /** Stored planes: 1 if the master is in the sensor format (CFA or mono), 3 if colour. */
  planes: 1 | 3
  /** Channels of the reconstructed image: 3 for colour sensors. */
  channels: 1 | 3
  bayer: BayerPattern
  /** Exposure in seconds. */
  exposure: number | null
  gain: number | null
  /** Sensor temperature in °C. */
  temperature: number | null
  instrument: string | null
  filter: string | null
  /** Frames that made up the master. */
  frame: number
  /** Defective pixels found (dark only). */
  defectivePixels: number
  /** How a flat was corrected before normalising it: 'dark', 'bias' or none. */
  flatCorrection: 'dark' | 'bias' | null
  /** Minimum and maximum values: data is stored at 16 bits in this range. */
  minimum: number
  max: number
  /** Bytes used on disk. */
  byte: number
}

/** What needs to be known about a light frame to choose the masters. */
export interface FrameConditions {
  width: number
  height: number
  channels: 1 | 3
  bayer: BayerPattern
  exposure: number | null
  gain: number | null
  temperature: number | null
  instrument: string | null
  filter: string | null
  /** Capture date, ISO, for the age of flats; if missing, today is used. */
  data: string | null
}

export function conditionsOf(meta: FrameMetadata, width: number, height: number, channels: 1 | 3): FrameConditions {
  return {
    width,
    height,
    channels,
    bayer: meta.bayer,
    exposure: meta.exposure,
    gain: meta.gain,
    temperature: meta.sensorTemp,
    instrument: meta.instrument,
    filter: meta.filter,
    data: meta.dateObs
  }
}

function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function sameNumber(a: number | null, b: number | null, relativeTolerance = 0): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= Math.max(1e-6, relativeTolerance * Math.max(Math.abs(a), Math.abs(b)))
}

/** Same sensor: dimensions, colour, Bayer pattern and instrument (if declared by both). */
function sameSensor(v: MasterEntry, c: FrameConditions): boolean {
  return (
    v.width === c.width &&
    v.height === c.height &&
    v.channels === c.channels &&
    v.bayer === c.bayer &&
    sameText(v.instrument, c.instrument)
  )
}

/** Days between two ISO dates (absolute); null if one is missing or unreadable. */
function daysBetween(a: string | null, b: string | null): number | null {
  // DATE-OBS is in universal time even when it does not say so: without
  // this reading, the date of a frame would be read in local time.
  const ta = utcTimestamp(a)
  const tb = utcTimestamp(b)
  if (ta === undefined || tb === undefined) return null
  return Math.abs(ta - tb) / 86400000
}

/**
 * Capture date of a master: the median of the dates of the frames that make
 * it up, ISO in universal time; null if none has a date.
 */
export function captureDate(date: (string | null)[]): string | null {
  const timestamps = date.map((d) => utcTimestamp(d)).filter((t): t is number => t !== undefined).sort((a, b) => a - b)
  if (timestamps.length === 0) return null
  return new Date(timestamps[(timestamps.length - 1) >> 1]).toISOString()
}

export type ChoiceResult = { entry: MasterEntry; note: string } | null

/**
 * Picks from the library the master of a given type that suits the
 * conditions of the frame, or null if none does.
 */
export function chooseMaster(entries: MasterEntry[], type: MasterType, c: FrameConditions, today = new Date().toISOString()): ChoiceResult {
  const suitable: { entry: MasterEntry; distance: number; note: string }[] = []
  for (const v of entries) {
    if (v.type !== type || !sameSensor(v, c)) continue
    if (type === 'dark') {
      // The exposure must match: within 1 %, to allow for header rounding.
      if (!sameNumber(v.exposure, c.exposure, 0.01)) continue
      if (!sameNumber(v.gain, c.gain)) continue
      let distance = 0
      let note = ''
      if (v.temperature !== null && c.temperature !== null) {
        distance = Math.abs(v.temperature - c.temperature)
        if (distance > TEMPERATURE_TOLERANCE) continue
      } else if (v.temperature !== null || c.temperature !== null) {
        // Only one of the two declares the temperature: accept it, but flag it.
        distance = TEMPERATURE_TOLERANCE
        note = t('coreCalibrationLibrary.temperatureNotComparable')
      }
      suitable.push({ entry: v, distance, note })
    } else if (type === 'bias') {
      if (!sameNumber(v.gain, c.gain)) continue
      suitable.push({ entry: v, distance: 0, note: '' })
    } else {
      if (!sameText(v.filter, c.filter)) continue
      const age = daysBetween(v.captured ?? v.created, c.data ?? today)
      if (age !== null && age > MAX_FLAT_AGE_DAYS) continue
      // The distance is the number of days from the date of the frame: the
      // flat from the same night wins. Without a readable date the distance
      // is the same for all and the ordering decides: the most recent.
      suitable.push({ entry: v, distance: age ?? 0, note: '' })
    }
  }
  if (suitable.length === 0) return null
  suitable.sort((a, b) => a.distance - b.distance || Date.parse(b.entry.created) - Date.parse(a.entry.created))
  return { entry: suitable[0].entry, note: suitable[0].note }
}

/**
 * The master that replaces an older entry with the same conditions: a new
 * dark at 10 s, gain 80 and 25 °C takes the place of the previous one.
 */
export function sameConditions(a: Omit<MasterEntry, 'id' | 'created' | 'byte'>, b: MasterEntry): boolean {
  if (a.type !== b.type) return false
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels || a.bayer !== b.bayer) return false
  if (!sameText(a.instrument, b.instrument) || (a.instrument === null) !== (b.instrument === null)) return false
  if (!sameNumber(a.gain, b.gain)) return false
  if (a.type === 'dark') {
    if (!sameNumber(a.exposure, b.exposure, 0.01)) return false
    const ta = a.temperature === null ? null : Math.round(a.temperature)
    const tb = b.temperature === null ? null : Math.round(b.temperature)
    return ta === tb
  }
  if (a.type === 'flat') return sameText(a.filter, b.filter) && (a.filter === null) === (b.filter === null)
  return true
}

const NAMES: Record<MasterType, string> = { dark: 'Dark', flat: 'Flat', bias: 'Bias' }

/** Short description of a master: "Dark 10 s, gain 80, 25 °C". */
export function describeMaster(v: Pick<MasterEntry, 'type' | 'exposure' | 'gain' | 'temperature' | 'filter'>): string {
  const parts = [NAMES[v.type]]
  if (v.type === 'dark' && v.exposure !== null) parts.push(formatExposure(v.exposure))
  const details: string[] = []
  if (v.gain !== null) details.push(t('coreCalibrationLibrary.gain', { value: formatNumber(v.gain) }))
  if (v.type === 'dark' && v.temperature !== null) details.push(formatNumber(v.temperature, { maximumFractionDigits: 1 }) + ' °C')
  if (v.type === 'flat' && v.filter) details.push(t('coreCalibrationLibrary.filter', { name: v.filter }))
  return parts.join(' ') + (details.length ? ', ' + details.join(', ') : '')
}

function formatExposure(seconds: number): string {
  if (seconds < 1) return formatNumber(Math.round(seconds * 1000)) + ' ms'
  return formatNumber(seconds, { maximumFractionDigits: 2 }) + ' s'
}

/* ---- Storage format ---- */

/**
 * Brings a colour master back to the sensor format: for each pixel only
 * the channel that pixel measured. Colour reconstruction preserves that
 * exact value, so `debayer(unmosaic(m))` returns a master that matches the
 * original in the measured values and recomputes the interpolated ones in
 * the same way as for light frames.
 */
export function unmosaic(master: ImageData32, schema: BayerPattern): ImageData32 {
  if (schema === 'NONE' || master.channels !== 3) return master
  const { width: w, height: h } = master
  const n = w * h
  const plane = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      plane[i] = master.data[colorAt(schema, x, y) * n + i]
    }
  }
  return { width: w, height: h, channels: 1, data: plane }
}

/**
 * The master as used by calibration: colour is reconstructed from the
 * sensor format as for light frames.
 */
export function usableMaster(kept: ImageData32, schema: BayerPattern): ImageData32 {
  return kept.channels === 1 && schema !== 'NONE' ? debayer(kept, schema) : kept
}

/**
 * Canonical form of a freshly built master: it goes back through the
 * sensor format, so that the one used in the session and the one read
 * back from the library are identical.
 */
export function canonicalMaster(master: ImageData32, schema: BayerPattern): ImageData32 {
  return usableMaster(unmosaic(master, schema), schema)
}

/** Converts values to 16-bit integers in the range [minimum, max]. */
export function quantize(data: Float32Array): { values: Uint16Array; minimum: number; max: number } {
  let minimum = Infinity
  let max = -Infinity
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v < minimum) minimum = v
    if (v > max) max = v
  }
  if (!Number.isFinite(minimum)) minimum = max = 0
  const amplitude = max - minimum || 1
  const values = new Uint16Array(data.length)
  for (let i = 0; i < data.length; i++) values[i] = Math.round(((data[i] - minimum) / amplitude) * 65535)
  return { values, minimum, max }
}

/** The inverse of `quantize`. */
export function dequantize(values: Uint16Array, minimum: number, max: number): Float32Array {
  const amplitude = max - minimum || 1
  const data = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) data[i] = minimum + (values[i] / 65535) * amplitude
  return data
}

/** Subtracts a master (dark or bias) from a flat before normalising it. */
export function correctFlat(flat: ImageData32, toSubtract: ImageData32): ImageData32 {
  if (flat.width !== toSubtract.width || flat.height !== toSubtract.height || flat.channels !== toSubtract.channels) {
    throw new Error(t('coreCalibrationLibrary.flatMasterSizes'))
  }
  const data = new Float32Array(flat.data.length)
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, flat.data[i] - toSubtract.data[i])
  return { width: flat.width, height: flat.height, channels: flat.channels, data: data }
}
