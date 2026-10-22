/**
 * Translation of the texts shown to the user.
 *
 * Every text lives in the language files under `locales/<language>/`, one
 * JSON file per area of the program (namespace). A key is written as
 * `namespace.path.to.text`; `t()` returns the text in the current language.
 * A missing text falls back to English, then to Italian (the reference
 * language, always complete); if the key is missing everywhere, the key
 * itself is returned so that the gap is visible instead of silent.
 *
 * Languages are discovered from the folders under `locales/`: adding a
 * language means adding a folder and regenerating the index with
 * `tools/generate-locales-index.mjs` (see docs/translating.md). Each language
 * declares in its `common.json` its own name (`language.name`, shown in the
 * settings) and its locale tag (`language.locale`, used to format numbers
 * and dates).
 *
 * Placeholders are written `{name}` in the texts and filled from the
 * `params` argument. The module is shared by the main process and the
 * renderer: each side sets the language with `setLanguage()` when it starts
 * and whenever the setting changes.
 */
import { LOCALES } from './locales'

/** Language code: the name of a folder under `locales/` (`it`, `en`, `fr`…). */
export type Language = string

/** Reference language: every key exists here. */
export const REFERENCE_LANGUAGE: Language = 'it'

/** Language used when a text is missing in the chosen one, before the reference. */
export const FALLBACK_LANGUAGE: Language = 'en'

type Tree = { [key: string]: string | Tree }
const TABLES = LOCALES as unknown as Record<string, Record<string, Tree | undefined>>

/** Available languages, each with its own name, sorted by code. */
export const LANGUAGES: { value: Language; label: string }[] = Object.keys(TABLES)
  .sort()
  .map((code) => ({ value: code, label: lookup(code, 'common.language.name') ?? code }))

let current: Language = REFERENCE_LANGUAGE
const listeners = new Set<(language: Language) => void>()

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.hasOwn(TABLES, value)
}

/**
 * Language for a system locale such as `it-IT`, `fr-CA` or `en-US`: the
 * available language with the same code, English otherwise.
 */
export function languageForLocale(locale: string | null | undefined): Language {
  const code = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/)[0] : ''
  return isLanguage(code) ? code : FALLBACK_LANGUAGE
}

export function getLanguage(): Language {
  return current
}

export function setLanguage(language: Language): void {
  if (language === current || !isLanguage(language)) return
  current = language
  for (const listener of listeners) listener(language)
}

/** Calls `listener` whenever the language changes; returns the function that stops listening. */
export function onLanguageChange(listener: (language: Language) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function lookup(language: Language, key: string): string | null {
  const dot = key.indexOf('.')
  if (dot <= 0) return null
  let node: string | Tree | undefined = TABLES[language]?.[key.slice(0, dot)]
  for (const part of key.slice(dot + 1).split('.')) {
    if (node === undefined || typeof node === 'string') return null
    node = node[part]
  }
  return typeof node === 'string' ? node : null
}

/** Fills `{name}` placeholders; unknown placeholders are left as they are. */
export function format(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

/** Text for `key` in the current language (or in `language`, when given). */
export function t(key: string, params?: Record<string, string | number>, language: Language = current): string {
  const text = lookup(language, key) ?? lookup(FALLBACK_LANGUAGE, key) ?? lookup(REFERENCE_LANGUAGE, key) ?? key
  return format(text, params)
}

/** True if `key` exists in the reference language. */
export function hasKey(key: string): boolean {
  return lookup(REFERENCE_LANGUAGE, key) !== null
}

/* ---- Numbers, dates and per-language content ---- */

/** Locale tag of a language (`it-IT`, `en-US`…), declared in its `common.json`. */
export function localeTag(language: Language = current): string {
  return lookup(language, 'common.language.locale') ?? lookup(FALLBACK_LANGUAGE, 'common.language.locale') ?? 'en-US'
}

/** A number with the decimal separator and grouping of the current language. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions, language: Language = current): string {
  return value.toLocaleString(localeTag(language), options)
}

/** A number with exactly `digits` decimals, in the format of the current language. */
export function formatDecimal(value: number, digits: number, language: Language = current): string {
  return formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits }, language)
}

/** A date or time in the format of the current language. */
export function formatDate(date: Date, options?: Intl.DateTimeFormatOptions, language: Language = current): string {
  return date.toLocaleString(localeTag(language), options)
}

/**
 * Content that exists as separate data per language (glossary, help,
 * what's new…): the one for the current language, else English, else
 * Italian.
 */
export function byLanguage<T>(contents: Partial<Record<Language, T>> & { it: T }, language: Language = current): T {
  return contents[language] ?? contents[FALLBACK_LANGUAGE] ?? contents.it
}
