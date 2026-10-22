import type { FrameMetadata } from '@shared/types'
import { formatNumber, t } from '@shared/i18n/i18n'
import type { MasterType } from './calibration'
import {
  TEMPERATURE_TOLERANCE,
  captureDate,
  describeMaster,
  chooseMaster,
  type FrameConditions,
  type MasterEntry
} from './calibrationLibrary'
import { utcTimestamp, groupByNight } from './nights'

/**
 * Calibration groups: the calibration frames of a session split by capture
 * conditions, one master per group, and the choice of the right master for
 * each light.
 *
 * Anyone who captures several series in the same session (different
 * exposures, a warmer evening, two filters) loads darks, flats and biases
 * of different conditions together. Combined into a single master they
 * would give a dark that matches no light: here they are split
 * automatically, with the same rules as the calibration library
 * (chooseMaster), so that each light receives the master of its own
 * conditions or, if there is none, no master.
 *
 * The groups, by type:
 *   - dark: same exposure (within 1 %), same gain, sensor temperature in
 *     groups at most TEMPERATURE_TOLERANCE wide, same dimensions (binning
 *     changes the dimensions, so it is covered);
 *   - bias: same gain and same dimensions;
 *   - flat: same filter, same capture night, same gain and same
 *     dimensions: every evening has its own dust and camera rotation, and
 *     the gain determines the bias used to correct it.
 * The instrument and the Bayer pattern, when declared, always separate groups.
 *
 * Everything here is pure: it is used by the calibration panel, by stacking
 * and by the tests (tools/test-simulated-calibration.ts).
 */

/** The capture conditions of a master, as recorded by the library. */
export type MasterConditions = Pick<
  MasterEntry,
  | 'type'
  | 'captured'
  | 'width'
  | 'height'
  | 'channels'
  | 'bayer'
  | 'exposure'
  | 'gain'
  | 'temperature'
  | 'instrument'
  | 'filter'
  | 'frame'
>

/** Median of the values present (null if none). */
function median(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** The most frequent value among those present (null if none). */
function mostFrequent(values: (string | null)[]): string | null {
  const tallies = new Map<string, number>()
  for (const v of values) if (v) tallies.set(v, (tallies.get(v) ?? 0) + 1)
  let chosen: string | null = null
  let max = 0
  for (const [v, n] of tallies) if (n > max) [chosen, max] = [v, n]
  return chosen
}

/**
 * The conditions of a master from the metadata of the frames that make it
 * up: median of exposure, gain and temperature, the most frequent value of
 * instrument, Bayer pattern and filter (flats only). The same for the
 * session master and for the entry saved in the library.
 */
export function masterConditions(
  type: MasterType,
  width: number,
  height: number,
  channels: 1 | 3,
  meta: FrameMetadata[]
): MasterConditions {
  return {
    type,
    captured: captureDate(meta.map((m) => m.dateObs)),
    width,
    height,
    channels,
    bayer: (mostFrequent(meta.map((m) => (m.bayer === 'NONE' ? null : m.bayer))) ?? 'NONE') as MasterEntry['bayer'],
    exposure: median(meta.map((m) => m.exposure)),
    gain: median(meta.map((m) => m.gain)),
    temperature: median(meta.map((m) => m.sensorTemp)),
    instrument: mostFrequent(meta.map((m) => m.instrument)),
    filter: type === 'flat' ? mostFrequent(meta.map((m) => m.filter)) : null,
    frame: meta.length
  }
}

/* ---- Grouping ---- */

/** A calibration frame as seen by the grouping, without reading its pixels. */
export interface CalibrationFrame {
  id: string
  name: string
  path: string
  type: MasterType
  width: number
  height: number
  /** Channels of the reconstructed image: 3 for raw frames of a colour sensor. */
  channels: 1 | 3
  meta: FrameMetadata
}

export interface CalibrationGroup {
  /** Stable key, from the conditions: the same group rebuilt has the same key. */
  key: string
  type: MasterType
  frame: CalibrationFrame[]
  conditions: MasterConditions
  /** Flats only: the capture night ("Night of 12 October"). */
  night: string | null
}

export interface RejectedFrame {
  frame: CalibrationFrame
  reason: string
}

export interface GroupingResult {
  groups: CalibrationGroup[]
  rejected: RejectedFrame[]
}

const NAMES: Record<MasterType, string> = { dark: 'dark', flat: 'flat', bias: 'bias' }

/**
 * Splits into groups sorted by value, opening a new one when a value moves
 * away from the first of the group by more than `neighbor` accepts. This
 * way no group is wider than the tolerance. Missing values form a group of
 * their own.
 */
function byValue<T>(elements: T[], value: (e: T) => number | null, neighbor: (first: number, v: number) => boolean): T[][] {
  const groups: T[][] = []
  const without = elements.filter((e) => value(e) === null)
  const combined = elements.filter((e) => value(e) !== null).sort((a, b) => (value(a) as number) - (value(b) as number))
  let current: T[] = []
  let first = 0
  for (const e of combined) {
    const v = value(e) as number
    if (current.length > 0 && neighbor(first, v)) {
      current.push(e)
    } else {
      if (current.length > 0) groups.push(current)
      current = [e]
      first = v
    }
  }
  if (current.length > 0) groups.push(current)
  if (without.length > 0) groups.push(without)
  return groups
}

/** Same sensor: dimensions, colour, Bayer pattern, instrument. */
function sensorKey(f: CalibrationFrame): string {
  return [f.width, f.height, f.channels, f.meta.bayer, (f.meta.instrument ?? '').trim().toLowerCase()].join('|')
}

function byKey<T>(elements: T[], key: (e: T) => string): T[][] {
  const map = new Map<string, T[]>()
  for (const e of elements) {
    const k = key(e)
    const g = map.get(k)
    if (g) g.push(e)
    else map.set(k, [e])
  }
  return [...map.values()]
}

/** A file that is already a master (produced by the telescope or by another program). */
function alreadyMaster(f: CalibrationFrame): boolean {
  return /master/i.test(f.name) || (f.meta.stackCount ?? 0) > 1
}

/** Stable key of a group: its conditions. */
function groupKey(c: MasterConditions, night: string | null): string {
  const n = (v: number | null, digits: number): string => (v === null ? '-' : v.toFixed(digits))
  return [
    c.type,
    c.width + 'x' + c.height,
    c.channels,
    c.bayer,
    (c.instrument ?? '').trim().toLowerCase(),
    c.type === 'dark' ? n(c.exposure, 3) : '',
    n(c.gain, 2),
    c.type === 'dark' ? n(c.temperature, 1) : '',
    c.type === 'flat' ? (c.filter ?? '').trim().toLowerCase() : '',
    night ?? ''
  ].join('|')
}

/**
 * Groups calibration frames by capture conditions. A group with a single
 * frame is discarded when there are others of the same type: a single
 * frame would bring all its noise and cosmic rays into the master, and it
 * is usually a file that ended up there by mistake. A file that is already
 * a master (in its name or header) and the only frame of its type remain
 * valid, and are used as they are.
 */
export function groupCalibration(frame: CalibrationFrame[]): GroupingResult {
  const groups: CalibrationGroup[] = []
  const rejected: RejectedFrame[] = []

  for (const type of ['dark', 'flat', 'bias'] as const) {
    const ofKind = frame.filter((f) => f.type === type)
    if (ofKind.length === 0) continue
    const collections: { frame: CalibrationFrame[]; night: string | null }[] = []

    // Night of each flat, from the capture date (or from the folder).
    const nightFor = new Map<string, { key: string; label: string }>()
    if (type === 'flat') {
      const nights = groupByNight(
        ofKind.map((f) => ({ id: f.id, path: f.path, dateObs: f.meta.dateObs, longitude: f.meta.instrumentInfo?.siteLongitude ?? null }))
      )
      for (const n of nights) for (const id of n.frame) nightFor.set(id, { key: n.key, label: n.label })
    }

    for (const sensor of byKey(ofKind, sensorKey)) {
      for (const gain of byValue(sensor, (f) => f.meta.gain, (a, b) => Math.abs(a - b) <= 1e-6)) {
        if (type === 'bias') {
          collections.push({ frame: gain, night: null })
        } else if (type === 'flat') {
          const perFilterNight = byKey(gain, (f) => (f.meta.filter ?? '').trim().toLowerCase() + '|' + (nightFor.get(f.id)?.key ?? ''))
          for (const g of perFilterNight) collections.push({ frame: g, night: nightFor.get(g[0].id)?.label ?? null })
        } else {
          const perExposure = byValue(gain, (f) => f.meta.exposure, (a, b) => Math.abs(b - a) <= 0.01 * Math.max(Math.abs(a), Math.abs(b)) + 1e-6)
          for (const exposure of perExposure) {
            for (const g of byValue(exposure, (f) => f.meta.sensorTemp, (a, b) => b - a <= TEMPERATURE_TOLERANCE)) {
              collections.push({ frame: g, night: null })
            }
          }
        }
      }
    }

    for (const collection of collections) {
      const first = collection.frame[0]
      const conditions = masterConditions(type, first.width, first.height, first.channels, collection.frame.map((f) => f.meta))
      if (collection.frame.length === 1 && ofKind.length > 1 && !alreadyMaster(first)) {
        rejected.push({
          frame: first,
          reason: t('coreCalibrationGroups.rejectedSingle', {
            type: NAMES[type],
            conditions: describeGroup(conditions, collection.night)
          })
        })
        continue
      }
      groups.push({ key: groupKey(conditions, collection.night), type, frame: collection.frame, conditions, night: collection.night })
    }
  }

  // An order that reads well: by type, then exposure, gain, temperature, filter.
  const order: Record<MasterType, number> = { dark: 0, flat: 1, bias: 2 }
  const num = (v: number | null): number => (v === null ? Infinity : v)
  groups.sort(
    (a, b) =>
      order[a.type] - order[b.type] ||
      num(a.conditions.exposure) - num(b.conditions.exposure) ||
      num(a.conditions.gain) - num(b.conditions.gain) ||
      num(a.conditions.temperature) - num(b.conditions.temperature) ||
      (a.conditions.filter ?? '').localeCompare(b.conditions.filter ?? '') ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )
  return { groups, rejected }
}

/** "Dark 60 s, gain 100, 18 °C"; for flats with the night: "Flat, filter LP, night of 12 October". */
export function describeGroup(c: MasterConditions, night: string | null): string {
  return describeMaster(c) + (night ? ', ' + night.charAt(0).toLowerCase() + night.slice(1) : '')
}

/**
 * The entry with which a session master takes part in the choice, in the
 * same format as those of the library: so the same rules apply.
 */
export function sessionEntry(
  key: string,
  c: MasterConditions,
  extra: { defectivePixels?: number; flatCorrection?: 'dark' | 'bias' | null } = {}
): MasterEntry {
  return {
    ...c,
    id: 'sessione:' + key,
    // Without the capture date the age of a session flat cannot be measured:
    // with today's date an old session would reject its own flats. An empty
    // date leaves it without an age.
    created: c.captured ?? '',
    planes: c.channels === 3 && c.bayer !== 'NONE' ? 1 : c.channels,
    defectivePixels: extra.defectivePixels ?? 0,
    flatCorrection: extra.flatCorrection ?? null,
    minimum: 0,
    max: 0,
    byte: 0
  }
}

/** The conditions of a group seen as those of a frame, to choose the masters that correct it. */
export function groupConditions(c: MasterConditions): FrameConditions {
  return {
    width: c.width,
    height: c.height,
    channels: c.channels,
    bayer: c.bayer,
    exposure: c.exposure,
    gain: c.gain,
    temperature: c.temperature,
    instrument: c.instrument,
    filter: c.filter,
    data: c.captured ?? null
  }
}

/* ---- Choice for each light ---- */

export type MasterOrigin = 'session' | 'library'

export interface ChosenMaster {
  entry: MasterEntry
  origin: MasterOrigin
  note: string
}

export interface LightChoice {
  dark: ChosenMaster | null
  flat: ChosenMaster | null
  /** Only without a dark: the dark already contains the readout level. */
  bias: ChosenMaster | null
}

function oneOf(session: MasterEntry[], library: MasterEntry[], type: MasterType, c: FrameConditions, today?: string): ChosenMaster | null {
  const s = chooseMaster(session, type, c, today)
  if (s) return { ...s, origin: 'session' }
  const l = chooseMaster(library, type, c, today)
  return l ? { ...l, origin: 'library' } : null
}

/**
 * The masters for a light: for each type the one from the session with the
 * right conditions, otherwise the one from the library, otherwise none.
 * The rules are those of chooseMaster: a dark outside the tolerance is
 * never used. `library` is empty when reuse is switched off.
 */
export function chooseForLight(session: MasterEntry[], library: MasterEntry[], c: FrameConditions, today?: string): LightChoice {
  const dark = oneOf(session, library, 'dark', c, today)
  const flat = oneOf(session, library, 'flat', c, today)
  const bias = dark ? null : oneOf(session, library, 'bias', c, today)
  return { dark, flat, bias }
}

/**
 * The master used to correct a flat before normalising it: the dark of the
 * flats' exposure (flat dark), or failing that the bias of their gain;
 * session masters first, then the library.
 */
export function flatCorrectionChoice(
  session: MasterEntry[],
  library: MasterEntry[],
  flat: MasterConditions
): { type: 'dark' | 'bias'; choice: ChosenMaster } | null {
  const c = groupConditions(flat)
  const dark = oneOf(session, library, 'dark', c)
  if (dark) return { type: 'dark', choice: dark }
  const bias = oneOf(session, library, 'bias', c)
  return bias ? { type: 'bias', choice: bias } : null
}

/* ---- Explanations ---- */

function exposure(seconds: number): string {
  if (seconds < 1) return formatNumber(Math.round(seconds * 1000)) + ' ms'
  return formatNumber(seconds, { maximumFractionDigits: 2 }) + ' s'
}

function degrees(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 1 }) + ' °C'
}

function sameSensor(v: MasterEntry, c: FrameConditions): boolean {
  const text = (a: string | null, b: string | null): boolean => a === null || b === null || a.trim().toLowerCase() === b.trim().toLowerCase()
  return v.width === c.width && v.height === c.height && v.channels === c.channels && v.bayer === c.bayer && text(v.instrument, c.instrument)
}

/** Why a master is suitable, in words: "same exposure and same gain, 0.3 °C difference". */
export function choiceReason(type: MasterType, m: ChosenMaster, c: FrameConditions): string {
  const v = m.entry
  if (type === 'dark') {
    let temperature = ''
    if (m.note) temperature = m.note
    else if (v.temperature !== null && c.temperature !== null) {
      const d = Math.abs(v.temperature - c.temperature)
      temperature = d < 0.05 ? t('coreCalibrationGroups.reason.sameTemperature') : t('coreCalibrationGroups.reason.temperatureDifference', { value: degrees(d) })
    }
    return temperature ? t('coreCalibrationGroups.reason.darkWithTemperature', { temperature }) : t('coreCalibrationGroups.reason.dark')
  }
  if (type === 'bias') return t('coreCalibrationGroups.reason.bias')
  const ta = utcTimestamp(v.captured ?? v.created)
  const tb = utcTimestamp(c.data)
  if (ta === undefined || tb === undefined) return t('coreCalibrationGroups.reason.flat')
  const days = Math.round(Math.abs(ta - tb) / 86400000)
  if (days === 0) return t('coreCalibrationGroups.reason.flatSameNight')
  return t(days === 1 ? 'coreCalibrationGroups.reason.flatDaysOne' : 'coreCalibrationGroups.reason.flatDaysOther', { days })
}

/**
 * Why there is no suitable dark for a light, given the set of available
 * darks (session and library); null if there are no darks at all, that is
 * if the user does not use them.
 */
export function noDarkReason(entries: MasterEntry[], c: FrameConditions): string | null {
  const dark = entries.filter((v) => v.type === 'dark')
  if (dark.length === 0) return null
  if (c.exposure === null) return t('coreCalibrationGroups.noDark.lightsWithoutExposure')
  const sensor = dark.filter((v) => sameSensor(v, c))
  if (sensor.length === 0) return t('coreCalibrationGroups.noDark.otherSensor')
  const sameExposure = sensor.filter((v) => v.exposure !== null && Math.abs(v.exposure - (c.exposure as number)) <= 0.01 * Math.max(v.exposure, c.exposure as number) + 1e-6)
  if (sameExposure.length === 0) return t('coreCalibrationGroups.noDark.otherExposure', { exposure: exposure(c.exposure) })
  const sameGain = sameExposure.filter((v) => (v.gain === null && c.gain === null) || (v.gain !== null && c.gain !== null && Math.abs(v.gain - c.gain) <= 1e-6))
  if (sameGain.length === 0) {
    return c.gain === null
      ? t('coreCalibrationGroups.noDark.lightsWithoutGain', { exposure: exposure(c.exposure) })
      : t('coreCalibrationGroups.noDark.otherGain', { exposure: exposure(c.exposure), gain: formatNumber(c.gain) })
  }
  if (c.temperature === null) return t('coreCalibrationGroups.noDark.noneSuitable')
  const withTemperature = sameGain.filter((v) => v.temperature !== null)
  if (withTemperature.length === 0) return t('coreCalibrationGroups.noDark.noneSuitable')
  const neighbor = withTemperature.reduce((a, b) => (Math.abs((b.temperature as number) - (c.temperature as number)) < Math.abs((a.temperature as number) - (c.temperature as number)) ? b : a))
  const d = (neighbor.temperature as number) - c.temperature
  return t(d > 0 ? 'coreCalibrationGroups.noDark.nearestWarmer' : 'coreCalibrationGroups.noDark.nearestColder', {
    exposure: exposure(c.exposure),
    temperature: degrees(neighbor.temperature as number),
    difference: degrees(Math.abs(d)),
    tolerance: TEMPERATURE_TOLERANCE
  })
}

/* ---- Stacking summary ---- */

export interface MasterUsage {
  id: string
  description: string
  origin: MasterOrigin
  reason: string
}

/** How a light was calibrated. */
export interface LightCalibrationResult {
  conditions: FrameConditions
  dark: MasterUsage | null
  flat: MasterUsage | null
  bias: MasterUsage | null
  /** Why the dark is missing, when there were darks but none suitable. */
  withoutDark: string | null
  /** Library masters that could not be read. */
  unread: string[]
}

function usage(type: MasterType, m: ChosenMaster | null, c: FrameConditions): MasterUsage | null {
  if (!m) return null
  return { id: m.entry.id, description: describeMaster(m.entry), origin: m.origin, reason: choiceReason(type, m, c) }
}

/** The outcome of a choice, to keep for the summary. `all` are the entries considered (session and library). */
export function lightResult(choice: LightChoice, c: FrameConditions, all: MasterEntry[]): LightCalibrationResult {
  return {
    conditions: c,
    dark: usage('dark', choice.dark, c),
    flat: usage('flat', choice.flat, c),
    bias: usage('bias', choice.bias, c),
    withoutDark: choice.dark ? null : noDarkReason(all, c),
    unread: []
  }
}

/** Lights calibrated in the same way, for the summary. */
export interface CalibratedLightGroup {
  lights: number
  /** "lights at 60 s, gain 100, 17.8–18.2 °C, filter LP" */
  description: string
  dark: MasterUsage | null
  flat: MasterUsage | null
  bias: MasterUsage | null
  withoutDark: string | null
}

/** Groups lights calibrated with the same masters and conditions, the most numerous first. */
export function summarizeCalibration(results: LightCalibrationResult[]): CalibratedLightGroup[] {
  const groups = new Map<string, { results: LightCalibrationResult[] }>()
  for (const e of results) {
    const c = e.conditions
    const k = [e.dark?.id, e.flat?.id, e.bias?.id, e.withoutDark, c.exposure, c.gain, (c.filter ?? '').toLowerCase()].join('|')
    const g = groups.get(k)
    if (g) g.results.push(e)
    else groups.set(k, { results: [e] })
  }
  const result: CalibratedLightGroup[] = []
  for (const { results: members } of groups.values()) {
    const c = members[0].conditions
    const parts: string[] = []
    if (c.exposure !== null) parts.push(t('coreCalibrationGroups.summary.atExposure', { exposure: exposure(c.exposure) }))
    if (c.gain !== null) parts.push(t('coreCalibrationLibrary.gain', { value: formatNumber(c.gain) }))
    const temperatures = members.map((m) => m.conditions.temperature).filter((t): t is number => t !== null)
    if (temperatures.length > 0) {
      const min = Math.min(...temperatures)
      const max = Math.max(...temperatures)
      parts.push(max - min < 0.05 ? degrees(min) : formatNumber(min, { maximumFractionDigits: 1 }) + '–' + degrees(max))
    }
    if (c.filter) parts.push(t('coreCalibrationLibrary.filter', { name: c.filter }))
    const e = members[0]
    result.push({
      lights: members.length,
      description: (members.length === 1 ? t('coreCalibrationGroups.summary.lightsOne') : t('coreCalibrationGroups.summary.lightsOther', { count: members.length })) + (parts.length ? ' ' + parts.join(', ') : ''),
      dark: e.dark,
      flat: e.flat,
      bias: e.bias,
      withoutDark: e.withoutDark
    })
  }
  return result.sort((a, b) => b.lights - a.lights)
}

/** A master's row in the summary: "Dark 60 s, gain 100, 18 °C, from the session: same exposure…". */
export function usageRow(u: MasterUsage): string {
  return t(u.origin === 'session' ? 'coreCalibrationGroups.usageRow.session' : 'coreCalibrationGroups.usageRow.library', { description: u.description, reason: u.reason })
}

/** The notice for a group of lights without a suitable dark (null if the dark is there or if there were no darks). */
export function noDarkNotice(g: CalibratedLightGroup): string | null {
  if (g.dark || !g.withoutDark) return null
  const combined = t(
    g.bias && g.flat
      ? 'coreCalibrationGroups.noDarkNotice.withBiasAndFlat'
      : g.flat
        ? 'coreCalibrationGroups.noDarkNotice.withFlatOnly'
        : g.bias
          ? 'coreCalibrationGroups.noDarkNotice.withBiasOnly'
          : 'coreCalibrationGroups.noDarkNotice.withoutMasters'
  )
  return t(g.lights === 1 ? 'coreCalibrationGroups.noDarkNotice.one' : 'coreCalibrationGroups.noDarkNotice.other', {
    description: g.description.charAt(0).toUpperCase() + g.description.slice(1),
    combined,
    reason: g.withoutDark
  })
}
