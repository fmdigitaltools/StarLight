/**
 * StarLight plugins: the manifest and its rules.
 *
 * A plugin is a folder with two required files:
 *
 * - `plugin.json`, the manifest described below: who wrote it, under which
 *   license, what it is for and which parameters it accepts, with the texts
 *   in English and, optionally, translated into other languages
 *   (`translations`);
 * - `plugin.js`, a JavaScript module that exports the function
 *   `processImage(image, params, context)` and returns the transformed
 *   image (see `isolation.ts` for how it is run).
 *
 * Next to them are the images declared in the manifest (icon and before and
 * after previews) and, if the author wishes, the license text and a readme.
 *
 * A plugin that moves pixels (rotates, mirrors, crops) declares it with the
 * `geometry` field and returns the transformation it applied, so the
 * astrometric solution follows the image (see `PluginGeometry` and
 * core/image/geometry.ts).
 *
 * Parameters are declarative: the plugin says "a slider from 0 to 1" and
 * StarLight draws the slider, with the same look as all the others. The
 * plugin never touches the user interface.
 *
 * This module holds only the pure part, used in the same way by the main
 * process (on installation), the user interface and the tests.
 */

import { NAMES, PLUGIN, REMEDIES } from '@shared/protectionTexts'
import { t } from '@shared/i18n/i18n'

export type PluginCategory = 'astrophotography' | 'photography'

/** A plugin category whose `label` is read in the current language each time it is accessed. */
function categoryEntry(value: PluginCategory, labelKey: string): { value: PluginCategory; label: string } {
  return {
    value,
    get label(): string {
      return t('coreManifest.categories.' + labelKey)
    }
  }
}

export const PLUGIN_CATEGORIES: { value: PluginCategory; label: string }[] = [
  categoryEntry('astrophotography', 'astrophotography'),
  categoryEntry('photography', 'photography')
]

/** How to display a slider's value. */
export type SliderFormat = 'percent' | 'decimal' | 'integer' | 'degrees'

export type PluginParameter =
  | {
      type: 'slider'
      id: string
      label: string
      hint?: string
      min: number
      max: number
      step: number
      defaultValue: number
      format?: SliderFormat
    }
  | {
      type: 'toggle'
      id: string
      label: string
      hint?: string
      defaultValue: boolean
    }
  | {
      type: 'choice'
      id: string
      label: string
      hint?: string
      options: { value: string; label: string; hint?: string }[]
      defaultValue: string
    }

/**
 * What the plugin does to pixel positions.
 *
 * - `unchanged` (default): changes values, moves nothing; the returned
 *   image has the same dimensions as the received one.
 * - `transformed`: moves pixels and returns, next to the image, the exact
 *   transformation as a 2×3 affine matrix (`transform` field of the
 *   result). StarLight moves the astrometric solution accordingly, so
 *   markers and FITS export stay correct.
 * - `unknown`: moves pixels but cannot say how (for example a free-form
 *   warp). The astrometric solution is removed and the markers are hidden
 *   while the processing stays applied.
 */
export type PluginGeometry = 'unchanged' | 'transformed' | 'unknown'

/** Translated texts of a choice option; a missing text stays the main one. */
export interface PluginOptionTranslation {
  label?: string
  hint?: string
}

/** Translated texts of a parameter, and of its options by value. */
export interface PluginParameterTranslation {
  label?: string
  hint?: string
  options?: Record<string, PluginOptionTranslation>
}

/** Texts of a manifest in one language; whatever is missing stays in English. */
export interface PluginTranslation {
  name?: string
  description?: string
  /** By parameter id. */
  parameters?: Record<string, PluginParameterTranslation>
}

export interface PluginManifest {
  /** Unique identifier: lowercase letters, digits and hyphens. It is also the folder name. */
  id: string
  /** Name, in English: the main text, shown when there is no translation for the current language. */
  name: string
  /** Plugin version, in the form 1.2.3. */
  version: string
  author: string
  /** License in SPDX form (for example "MIT" or "GPL-3.0-or-later"). */
  license: string
  category: PluginCategory
  /** Description, one or two sentences, in English. */
  description: string
  /** File name of the icon, inside the plugin folder. */
  icon: string
  /** Files of the before and after previews, inside the plugin folder. */
  previews: { before: string; after: string }
  /** Oldest StarLight version the plugin works with. */
  minimumStarLightVersion: string
  /** URL of the source code or the project page, optional. */
  site?: string
  /** Whether and how the plugin moves pixels; absent in the file means "unchanged". */
  geometry: PluginGeometry
  parameters: PluginParameter[]
  /** Texts in other languages, by language code (`it`, `pt-BR`…); see `localizeManifest`. */
  translations?: Record<string, PluginTranslation>
}

export type ParameterValue = number | boolean | string
export type ParameterValues = Record<string, ParameterValue>

/**
 * A plugin chosen in the Process step, as it enters the chain parameters
 * (and therefore saved projects). The list order is the execution order:
 * a plugin enabled later goes to the end.
 */
export interface ActivePlugin {
  id: string
  /** When off it stays in the list to remember its values, but it is not run. */
  active: boolean
  values: ParameterValues
}

/** Files a plugin must contain. */
export const MANIFEST_FILE = 'plugin.json'
export const CODE_FILE = 'plugin.js'

/** Extensions allowed for icon and previews. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

/** Size limits, so a wrong archive cannot fill the disk. */
export const CODE_LIMIT_BYTES = 2 * 1024 * 1024
export const IMAGE_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * Accepted open source licenses, in SPDX form: those approved by the Open
 * Source Initiative and in common use. A plugin with an unlisted license,
 * or without a license, is not installed: users must be able to know they
 * are free to read, modify and share it.
 */
export const OPEN_SOURCE_LICENSES: readonly string[] = [
  '0BSD',
  'AFL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'Artistic-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CECILL-2.1',
  'ECL-2.0',
  'EPL-1.0',
  'EPL-2.0',
  'EUPL-1.1',
  'EUPL-1.2',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'MS-PL',
  'MulanPSL-2.0',
  'NCSA',
  'OSL-3.0',
  'PostgreSQL',
  'UPL-1.0',
  'Unlicense',
  'Zlib'
]

/**
 * True if the license is open source. Simple SPDX expressions with OR and
 * AND ("MIT OR Apache-2.0") are also accepted, provided every named license
 * is in the list. Case matters little to whoever writes by hand, so the
 * comparison ignores it.
 */
export function isOpenSourceLicense(license: string): boolean {
  const cleaned = license.trim().replace(/^\((.*)\)$/, '$1')
  if (cleaned === '') return false
  const parts = cleaned.split(/\s+(?:OR|AND)\s+/i)
  const note = new Set(OPEN_SOURCE_LICENSES.map((l) => l.toLowerCase()))
  return parts.every((p) => note.has(p.trim().replace(/^\(|\)$/g, '').toLowerCase()))
}

/** Compares two versions in the form 1.2.3: negative if a comes before b. */
export function compareVersions(a: string, b: string): number {
  const na = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const nb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const RE_ID = /^[a-z0-9][a-z0-9-]{1,39}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const RE_ID_PARAMETRO = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

/** Maximum size of plugin.json: a real manifest fits in a few kilobytes. */
export const MANIFEST_LIMIT_BYTES = 64 * 1024

/** Maximum side, in pixels, of icon and previews. */
export const MAX_IMAGE_SIDE = 4096

/** Maximum number of parameters a plugin can declare. */
export const MAX_PARAMETERS = 24

/**
 * Names Windows reserves for devices: a file or folder with these names
 * (also with an extension, "con.png") cannot be created, or worse, ends up
 * on a device instead of the disk.
 */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/** True if the name is reserved by Windows. */
export function isReservedName(name: string): boolean {
  return RESERVED_NAME_RE.test(name.trim())
}

/**
 * Invisible characters that must not appear in displayed texts: control
 * characters and those that reverse the writing direction, with which a
 * name can look like another.
 */
const RE_CONTROLLO = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩‎‏؜]/

/** True if the text contains control or direction-reversal characters. */
export function hasControlCharacters(text: string): boolean {
  return RE_CONTROLLO.test(text)
}

/**
 * Valid identifier for a plugin or a catalog: it is also the name of its
 * folder, so no names reserved by Windows.
 */
export function validId(id: string): boolean {
  return RE_ID.test(id) && !isReservedName(id)
}

/** A simple file name inside the plugin folder, never a path elsewhere. */
export function isSimpleFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 80 &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('.') &&
    // Windows silently strips trailing dots and spaces: "icona.png." would become another file.
    !/[. ]$/.test(name) &&
    !isReservedName(name)
  )
}

function imageAllowed(name: string): boolean {
  const bottom = name.toLowerCase()
  return isSimpleFileName(name) && IMAGE_EXTENSIONS.some((e) => bottom.endsWith(e))
}

/**
 * Outcome of a manifest check. On error `remedy` tells what the StarLight
 * user can do (see shared/protectionTexts.ts).
 */
export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; errors: string[]; remedy?: string }

/**
 * Checks a manifest read from `plugin.json` and returns it cleaned (known
 * fields only). The errors are sentences ready to show.
 */
export function checkManifest(raw: unknown, appVersion: string): ManifestResult {
  const errors: string[] = []
  if (!object(raw)) return { ok: false, errors: [PLUGIN.manifestNotObject], remedy: REMEDIES.pluginAuthor }
  const g = raw
  let remedy: string = REMEDIES.pluginAuthor

  // `nameKey` is the language key of the field's name, used in the error messages.
  const text = (key: string, nameKey: string, max = 120): string => {
    const v = g[key]
    const name = t('coreManifest.fields.' + nameKey)
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(PLUGIN.missingField(name))
      return ''
    }
    if (v.length > max) errors.push(PLUGIN.fieldTooLong(name, max))
    if (hasControlCharacters(key === 'description' ? v.replace(/[\n\r\t]/g, ' ') : v)) {
      errors.push(NAMES.controlCharacters(key))
    }
    return v.trim()
  }

  const id = text('id', 'id', 40)
  if (id && !RE_ID.test(id)) errors.push(PLUGIN.invalidId(id))
  else if (id && isReservedName(id)) errors.push(NAMES.reserved(id))
  const name = text('name', 'name', 60)
  const version = text('version', 'version', 20)
  if (version && !VERSION_RE.test(version)) errors.push(PLUGIN.invalidVersion)
  const author = text('author', 'author', 80)
  const license = text('license', 'license', 80)
  if (license && !isOpenSourceLicense(license)) errors.push(PLUGIN.nonOpenLicense(license))
  const category = g['category']
  if (category !== 'astrophotography' && category !== 'photography') errors.push(PLUGIN.category)
  const description = text('description', 'description', 600)
  const icon = text('icon', 'icon', 80)
  if (icon && !imageAllowed(icon)) errors.push(PLUGIN.icon)

  const previews = g['previews']
  let before = ''
  let after = ''
  if (!object(previews) || typeof previews['before'] !== 'string' || typeof previews['after'] !== 'string') {
    errors.push(PLUGIN.missingPreviews)
  } else {
    before = previews['before']
    after = previews['after']
    if (!imageAllowed(before) || !imageAllowed(after)) errors.push(PLUGIN.previews)
  }

  const minimum = text('minimumStarLightVersion', 'minVersion', 20)
  if (minimum && !VERSION_RE.test(minimum)) errors.push(PLUGIN.invalidMinVersion)
  else if (minimum && compareVersions(minimum, appVersion) > 0) {
    errors.push(PLUGIN.futureMinVersion(minimum, appVersion))
    // The plugin is not at fault here: a newer StarLight is needed.
    if (errors.length === 1) remedy = REMEDIES.updateStarLight
  }

  const site = g['site']
  if (site !== undefined && (typeof site !== 'string' || site.length > 300 || !/^https:\/\/\S+$/.test(site))) {
    errors.push(PLUGIN.site)
  }

  const geometry = g['geometry'] ?? 'unchanged'
  if (geometry !== 'unchanged' && geometry !== 'transformed' && geometry !== 'unknown') {
    errors.push(PLUGIN.geometry)
  }

  const parameters: PluginParameter[] = []
  const rawParams = g['parameters'] ?? []
  if (!Array.isArray(rawParams)) errors.push(PLUGIN.paramsNotListed)
  else if (rawParams.length > MAX_PARAMETERS) errors.push(PLUGIN.tooManyParameters(MAX_PARAMETERS))
  else {
    const seenItems = new Set<string>()
    rawParams.forEach((p, i) => {
      const result = checkParameter(p, i + 1)
      if (typeof result === 'string') errors.push(result)
      else if (seenItems.has(result.id)) errors.push(PLUGIN.duplicateParameter(result.id))
      else {
        seenItems.add(result.id)
        parameters.push(result)
      }
    })
  }

  const translations = checkTranslations(g['translations'], parameters, errors)

  if (errors.length > 0) return { ok: false, errors, remedy }
  const manifest: PluginManifest = {
    id,
    name,
    version,
    author,
    license,
    category: category as PluginCategory,
    description,
    icon,
    previews: { before, after },
    minimumStarLightVersion: minimum,
    geometry: geometry as PluginGeometry,
    parameters
  }
  if (typeof site === 'string') manifest.site = site
  if (translations) manifest.translations = translations
  return { ok: true, manifest }
}

/** Short text without invisible characters, within `max` characters. */
function shortText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max && !hasControlCharacters(v)
}

/** Optional hint: absent, or text within 400 characters without invisible characters. */
function validHint(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && v.length <= 400 && !hasControlCharacters(v))
}

function checkParameter(p: unknown, n: number): PluginParameter | string {
  const P = PLUGIN.parameter
  const where = P.prefix(n)
  if (!object(p)) return where + P.notObject
  const id = p['id']
  if (typeof id !== 'string' || !RE_ID_PARAMETRO.test(id)) return where + P.id
  const label = p['label']
  if (!shortText(label, 60)) return where + P.label
  const s = p['hint']
  if (!validHint(s)) return where + P.hint
  const base = { id, label: label.trim(), ...(typeof s === 'string' ? { hint: s } : {}) }

  const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  switch (p['type']) {
    case 'slider': {
      const { min, max, step, default: defaultValue } = p
      const format = p['format']
      if (!number(min) || !number(max) || !(max > min)) return where + P.minMax
      if (Math.abs(min) > 1e9 || Math.abs(max) > 1e9) return where + P.tooLargeItems
      if (!number(step) || step <= 0 || step > max - min) return where + P.step
      if (!number(defaultValue) || defaultValue < min || defaultValue > max) return where + P.defaultOutside
      if (format !== undefined && format !== 'percent' && format !== 'decimal' && format !== 'integer' && format !== 'degrees') {
        return where + P.format
      }
      if (format === 'integer' && ![min, max, step, defaultValue].every((x) => Number.isInteger(x))) return where + P.whole
      return {
        type: 'slider',
        ...base,
        min,
        max,
        step,
        defaultValue,
        ...(format !== undefined ? { format: format as SliderFormat } : {})
      }
    }
    case 'toggle': {
      if (typeof p['default'] !== 'boolean') return where + P.toggle
      return { type: 'toggle', ...base, defaultValue: p['default'] }
    }
    case 'choice': {
      const options = p['options']
      if (!Array.isArray(options) || options.length < 2 || options.length > 8) return where + P.optionCount
      const cleanedItems: { value: string; label: string; hint?: string }[] = []
      for (const o of options) {
        if (!object(o) || !shortText(o['value'], 40) || !shortText(o['label'], 60)) return where + P.option
        const so = o['hint']
        if (!validHint(so)) return where + P.hint
        if (cleanedItems.some((x) => x.value === o['value'])) return where + P.duplicateOption(o['value'] as string)
        cleanedItems.push({
          value: o['value'] as string,
          label: o['label'] as string,
          ...(typeof so === 'string' ? { hint: so } : {})
        })
      }
      const defaultValue = p['default']
      if (typeof defaultValue !== 'string' || !cleanedItems.some((o) => o.value === defaultValue)) return where + P.defaultChosen
      return { type: 'choice', ...base, options: cleanedItems, defaultValue }
    }
    default:
      return where + P.type(String(p['type']))
  }
}

/** Language code of a translation: `it`, `de`, `pt-BR`, `zh-Hant`… */
const RE_LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/

/** Maximum number of languages in the `translations` section. */
export const MAX_TRANSLATIONS = 40

/**
 * Checks the optional `translations` section against the declared
 * parameters. Returns it cleaned (known fields only, option texts always as
 * objects), or undefined if absent or wrong; the problems go into `errors`.
 */
function checkTranslations(
  raw: unknown,
  parameters: PluginParameter[],
  errors: string[]
): Record<string, PluginTranslation> | undefined {
  if (raw === undefined) return undefined
  const T = PLUGIN.translations
  if (!object(raw)) {
    errors.push(T.notObject)
    return undefined
  }
  const languages = Object.keys(raw)
  if (languages.length > MAX_TRANSLATIONS) {
    errors.push(T.tooMany(MAX_TRANSLATIONS))
    return undefined
  }
  const before = errors.length
  const result: Record<string, PluginTranslation> = {}
  for (const language of languages) {
    if (!RE_LANGUAGE.test(language)) {
      errors.push(T.language(language))
      continue
    }
    const entry = raw[language]
    if (!object(entry)) {
      errors.push(T.entry(language))
      continue
    }
    // A translated text is optional; when present it follows the limits of the main one.
    const translated = (v: unknown, field: string, max: number, multiline = false): string | undefined => {
      if (v === undefined) return undefined
      if (typeof v !== 'string' || v.trim() === '' || v.length > max || hasControlCharacters(multiline ? v.replace(/[\n\r\t]/g, ' ') : v)) {
        errors.push(T.text(language, field, max))
        return undefined
      }
      return multiline ? v : v.trim()
    }
    const translation: PluginTranslation = {}
    const name = translated(entry['name'], 'name', 60)
    if (name !== undefined) translation.name = name
    const description = translated(entry['description'], 'description', 600, true)
    if (description !== undefined) translation.description = description
    const params = entry['parameters']
    if (params !== undefined) {
      if (!object(params)) errors.push(T.entry(language))
      else {
        const translatedParams: Record<string, PluginParameterTranslation> = {}
        for (const [id, value] of Object.entries(params)) {
          const declared = parameters.find((p) => p.id === id)
          if (!declared) {
            errors.push(T.unknownParameter(language, id))
            continue
          }
          if (!object(value)) {
            errors.push(T.entry(language))
            continue
          }
          const pt: PluginParameterTranslation = {}
          const label = translated(value['label'], 'parameters.' + id + '.label', 60)
          if (label !== undefined) pt.label = label
          const hint = translated(value['hint'], 'parameters.' + id + '.hint', 400, true)
          if (hint !== undefined) pt.hint = hint
          const options = value['options']
          if (options !== undefined) {
            if (!object(options) || declared.type !== 'choice') errors.push(T.options(language, id))
            else {
              const translatedOptions: Record<string, PluginOptionTranslation> = {}
              for (const [optionValue, o] of Object.entries(options)) {
                if (!declared.options.some((x) => x.value === optionValue)) {
                  errors.push(T.unknownOption(language, id, optionValue))
                  continue
                }
                const field = 'parameters.' + id + '.options.' + optionValue
                const ot: PluginOptionTranslation = {}
                if (typeof o === 'string') {
                  const l = translated(o, field, 60)
                  if (l !== undefined) ot.label = l
                } else if (object(o)) {
                  const l = translated(o['label'], field + '.label', 60)
                  if (l !== undefined) ot.label = l
                  const h = translated(o['hint'], field + '.hint', 400, true)
                  if (h !== undefined) ot.hint = h
                } else errors.push(T.text(language, field, 60))
                translatedOptions[optionValue] = ot
              }
              pt.options = translatedOptions
            }
          }
          translatedParams[id] = pt
        }
        translation.parameters = translatedParams
      }
    }
    result[language] = translation
  }
  return errors.length === before ? result : undefined
}

/**
 * The translation of a manifest for a language: the exact code (`pt-BR`),
 * else the base language (`pt`), else none.
 */
function translationFor(manifest: PluginManifest, language: string): PluginTranslation | undefined {
  const all = manifest.translations
  if (!all) return undefined
  if (Object.hasOwn(all, language)) return all[language]
  const base = language.split('-')[0]
  return Object.hasOwn(all, base) ? all[base] : undefined
}

/**
 * The manifest with its texts (name, description, parameter labels and
 * hints, option labels and hints) in the given language, taken from
 * `translations`; every text without a translation stays the main
 * (English) one. Identifiers and values never change.
 */
export function localizeManifest(manifest: PluginManifest, language: string): PluginManifest {
  const tr = translationFor(manifest, language)
  if (!tr) return manifest
  const parameters = manifest.parameters.map((p): PluginParameter => {
    const pt = tr.parameters?.[p.id]
    if (!pt) return p
    const hint = pt.hint ?? p.hint
    const texts = { label: pt.label ?? p.label, ...(hint !== undefined ? { hint } : {}) }
    if (p.type !== 'choice') return { ...p, ...texts }
    return {
      ...p,
      ...texts,
      options: p.options.map((o) => {
        const ot = pt.options?.[o.value]
        if (!ot) return o
        const optionHint = ot.hint ?? o.hint
        return { value: o.value, label: ot.label ?? o.label, ...(optionHint !== undefined ? { hint: optionHint } : {}) }
      })
    }
  })
  return {
    ...manifest,
    name: tr.name ?? manifest.name,
    description: tr.description ?? manifest.description,
    parameters
  }
}

/**
 * Checks on the code before installation and at every load. They are not
 * the main defense (isolation is), but they immediately reject what could
 * not work or what tries to escape the sandbox.
 */
export function checkCode(code: string): string[] {
  const errors: string[] = []
  if (code.length > CODE_LIMIT_BYTES) errors.push(PLUGIN.codeTooLarge(CODE_LIMIT_BYTES / 1048576))
  // A byte that is invalid in UTF-8 becomes the replacement character: the file is not text.
  if (code.includes('�')) errors.push(PLUGIN.codeNotText)
  const withoutComments = stripComments(code)
  if (!/export\s+(?:async\s+)?function\s+processImage\s*\(|export\s+(?:const|let|var)\s+processImage\s*=/.test(withoutComments)) {
    errors.push(PLUGIN.codeWithoutProcess)
  }
  // A plugin is a single file: no external modules, neither static nor
  // dynamic. Dynamic import is syntax and cannot be disabled in the worker
  // environment, so it is excluded here (and the sandbox's security policy
  // blocks it anyway).
  if (/(^|[^\w$.])import\s*[\s({*'"]/.test(withoutComments) || /\bimport\s*\.\s*meta\b/.test(withoutComments)) {
    errors.push(PLUGIN.importCode)
  }
  return errors
}

/** Strips comments, so a commented-out example is not mistaken for code. Approximate but conservative. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

/** Initial parameter values, as declared by the manifest. */
export function defaultValues(manifest: PluginManifest): ParameterValues {
  const values: ParameterValues = {}
  for (const p of manifest.parameters) values[p.id] = p.defaultValue
  return values
}

/**
 * Values to pass to the plugin: the chosen ones where valid, defaults
 * otherwise. A project saved with an earlier version of the plugin (one
 * slider fewer, a different range) still opens.
 */
export function completeValues(manifest: PluginManifest, chosenItems: ParameterValues | undefined): ParameterValues {
  const values: ParameterValues = {}
  for (const p of manifest.parameters) {
    const v = chosenItems?.[p.id]
    if (p.type === 'slider') {
      values[p.id] = typeof v === 'number' && Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.defaultValue
    } else if (p.type === 'toggle') {
      values[p.id] = typeof v === 'boolean' ? v : p.defaultValue
    } else {
      values[p.id] = typeof v === 'string' && p.options.some((o) => o.value === v) ? v : p.defaultValue
    }
  }
  return values
}

/** Reads the list of active plugins from a project or a recipe, discarding anything inconsistent. */
export function readEnabledPlugins(raw: unknown): ActivePlugin[] {
  if (!Array.isArray(raw)) return []
  const result: ActivePlugin[] = []
  for (const p of raw) {
    if (!object(p) || typeof p['id'] !== 'string' || !RE_ID.test(p['id'])) continue
    if (result.some((e) => e.id === p['id'])) continue
    const values: ParameterValues = {}
    if (object(p['values'])) {
      for (const [k, v] of Object.entries(p['values'])) {
        if (RE_ID_PARAMETRO.test(k) && (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')) {
          values[k] = v
        }
      }
    }
    result.push({ id: p['id'], active: p['active'] === true, values })
  }
  return result
}

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
