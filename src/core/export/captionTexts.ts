/**
 * Texts and formats of the export caption, all in one place.
 *
 * The caption follows the chosen language: labels and words come from the
 * language files (namespace `coreCaptionTexts`), while dates and numbers go
 * through Intl with the language's locale. The functions take the language
 * as a parameter and default to the current interface language, so the code
 * that collects the data and the code that draws never deal with languages.
 */
import { getLanguage, isLanguage, localeTag, REFERENCE_LANGUAGE, t, type Language } from '@shared/i18n/i18n'

export type CaptionLanguage = Language

export const DEFAULT_CAPTION_LANGUAGE: CaptionLanguage = REFERENCE_LANGUAGE

export interface CaptionTexts {
  /** Locale code for Intl (dates and numbers). */
  locale: string
  /** Card labels, one per entry. */
  labels: {
    object: string
    data: string
    instrument: string
    camera: string
    exposure: string
    totalExposure: string
    filter: string
    place: string
    author: string
  }
  /** "LP filter" in the Banner and Minimal line. */
  filter: (name: string) => string
  /** "250 mm focal length", used when the instrument name is missing. */
  onlyFocalLength: (focalLength: string) => string
  /** Author signature in the line. */
  author: (name: string) => string
  /** Between the common name and the catalog code, and between instrument and focal length. */
  union: string
  /** "75 × 20 s". */
  per: string
  unit: { seconds: string; minutes: string; hours: string; millimeters: string }
}

/** Caption texts in `language`; the default is the current interface language. */
export function captionTexts(language: CaptionLanguage = getLanguage()): CaptionTexts {
  const lang: CaptionLanguage = isLanguage(language) ? language : DEFAULT_CAPTION_LANGUAGE
  const tr = (key: string, params?: Record<string, string | number>): string =>
    t('coreCaptionTexts.' + key, params, lang)
  return {
    locale: localeTag(lang),
    labels: {
      object: tr('labels.object'),
      data: tr('labels.date'),
      instrument: tr('labels.instrument'),
      camera: tr('labels.camera'),
      exposure: tr('labels.exposure'),
      totalExposure: tr('labels.totalExposure'),
      filter: tr('labels.filter'),
      place: tr('labels.place'),
      author: tr('labels.author')
    },
    filter: (name) => tr('filter', { name }),
    onlyFocalLength: (focalLength) => tr('onlyFocalLength', { focalLength }),
    author: (name) => tr('author', { name }),
    union: ' · ',
    per: ' × ',
    unit: {
      seconds: tr('unit.seconds'),
      minutes: tr('unit.minutes'),
      hours: tr('unit.hours'),
      millimeters: tr('unit.millimeters')
    }
  }
}

/** A number in the language's notation, with at most `decimals` fractional digits. */
export function formatNumber(value: number, language: CaptionLanguage = getLanguage(), decimals = 1): string {
  return new Intl.NumberFormat(captionTexts(language).locale, { maximumFractionDigits: decimals }).format(value)
}

/** Day, month and year of an ISO date, exactly as written (no time zones). */
function timestampDate(iso: string | null): number | null {
  if (!iso) return null
  const r = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim())
  if (!r) return null
  const a = Number(r[1])
  const m = Number(r[2])
  const g = Number(r[3])
  if (m < 1 || m > 12 || g < 1 || g > 31 || a < 1900) return null
  return Date.UTC(a, m - 1, g)
}

/**
 * Acquisition date: "15 October 2026", or the range of nights
 * ("12–14 September 2026"). The short form is the numeric one.
 */
export function formatDate(
  before: string | null,
  last: string | null = null,
  language: CaptionLanguage = getLanguage()
): { text: string; short: string } | null {
  const p = timestampDate(before)
  if (p === null) return null
  const u = timestampDate(last)
  const locale = captionTexts(language).locale
  // Formatted in UTC so the date stays the one written in the file, whatever the time zone.
  const long = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  const short = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
  if (u === null || u === p) return { text: long.format(p), short: short.format(p) }
  const [from, a] = u < p ? [u, p] : [p, u]
  return { text: long.formatRange(from, a), short: short.formatRange(from, a) }
}

/** Readable duration: "45 s", "7 min 40 s", "2 h 10 min". */
export function formatDuration(seconds: number, language: CaptionLanguage = getLanguage()): string {
  const { unit } = captionTexts(language)
  const n = (v: number): string => formatNumber(v, language)
  if (seconds < 60) return n(seconds) + ' ' + unit.seconds
  if (seconds < 600) {
    let m = Math.floor(seconds / 60)
    let s = Math.round(seconds - m * 60)
    if (s === 60) {
      m++
      s = 0
    }
    return s === 0 ? n(m) + ' ' + unit.minutes : n(m) + ' ' + unit.minutes + ' ' + n(s) + ' ' + unit.seconds
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return n(minutes) + ' ' + unit.minutes
  const h = Math.floor(minutes / 60)
  const m = minutes - h * 60
  return m === 0 ? n(h) + ' ' + unit.hours : n(h) + ' ' + unit.hours + ' ' + n(m) + ' ' + unit.minutes
}

/** Exposure: the total, with "frames × exposure" in parentheses when known. */
export function formatExposure(
  total: number,
  frame: number | null,
  single: number | null,
  language: CaptionLanguage = getLanguage()
): { text: string; short: string; label: string } {
  const t = captionTexts(language)
  const duration = formatDuration(total, language)
  const more = frame !== null && frame > 1
  const detail =
    more && single !== null
      ? formatNumber(frame, language, 0) + t.per + formatNumber(single, language) + ' ' + t.unit.seconds
      : null
  return {
    text: detail ? duration + ' (' + detail + ')' : duration,
    short: duration,
    label: more ? t.labels.totalExposure : t.labels.exposure
  }
}

/** Focal length: "250 mm". */
export function formatFocalLength(mm: number, language: CaptionLanguage = getLanguage()): string {
  return formatNumber(Math.round(mm), language, 0) + ' ' + captionTexts(language).unit.millimeters
}
