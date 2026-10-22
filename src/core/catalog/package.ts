import type { CelestialObject, ObjectType } from '@shared/types'
import { CATALOG, NAMES, REMEDIES } from '@shared/protectionTexts'
import { hasControlCharacters, isReservedName } from '@core/plugin/manifest'
import { FALLBACK_LANGUAGE, formatNumber, getLanguage, t, type Language } from '@shared/i18n/i18n'

/**
 * Catalog packages: deep-sky catalogs downloaded and installed from the
 * plugin gallery, "Deep-sky catalogs" section.
 *
 * A package contains data only, never code:
 *   - `catalog.json`   the manifest (name, version, source, license…);
 *   - `objects.tsv`    one row per object, tab-separated columns;
 *   - `LICENSE.txt` and `ATTRIBUTION.md`, the data license text and the
 *     credits, which always travel with the data.
 *
 * The columns of `objects.tsv`, in order:
 *   designation · alternative names (separated by "|") · type (English
 *   code: see CATALOG_TYPES) · RA in degrees · Dec in degrees (J2000) ·
 *   major axis in arcminutes · minor axis · position angle in degrees ·
 *   magnitude · common name · note in English · the note in each language
 *   listed by the manifest's `noteLanguages`, in that order.
 * Fields the catalog does not have stay empty.
 *
 * Texts are in English, the main language. The manifest's `translations`
 * holds, per language code ("it", "fr"…), the translated name, description,
 * authors, reference and data note; StarLight shows the current language's
 * text and falls back to English where a translation is missing. The same
 * holds for the notes of the objects.
 *
 * Only data with a declared open license: a package with a license outside
 * the list is not installed, like a plugin without an open source license.
 *
 * There is also a second package type, marked by `type: 'stars'` in the
 * manifest: reference stars for plate solving without an internet
 * connection. Instead of `objects.tsv` it contains `stars.bin`, a binary
 * file read in chunks (see src/core/astrometry/localStars.ts); its stars do
 * not enter the object catalog. Object catalogs have `type: 'deep-sky'`.
 *
 * This module holds only the pure part, used in the same way by the main
 * process (on installation), the user interface, the tools that prepare
 * the packages and the tests.
 */

export const CATALOG_MANIFEST_FILE = 'catalog.json'
export const OBJECTS_FILE = 'objects.tsv'

/** Format version: it increases only if the meaning of the fields or columns changes. */
export const CATALOG_FORMAT = 2

/** Index of the packages on the server, in the `catalogs/` folder. */
export const SERVER_CATALOGS_FOLDER = 'catalogs/'
export const CATALOG_INDEX_FILE = 'catalogs.json'

/** Size limit of a package downloaded or chosen from disk. */
export const PACKAGE_LIMIT_BYTES = 300 * 1024 * 1024

/** Type code written in objects.tsv -> StarLight type. */
export const CATALOG_TYPES: Record<string, ObjectType> = {
  galaxy: 'galaxy',
  'galaxy-group': 'galaxy-group',
  nebula: 'nebula',
  'planetary-nebula': 'planetary-nebula',
  'supernova-remnant': 'supernova-remnant',
  'open-cluster': 'open-cluster',
  'globular-cluster': 'globular-cluster',
  'dark-nebula': 'dark-nebula',
  star: 'star',
  'double-star': 'double-star',
  other: 'other'
}

/**
 * Data produced by the United States federal government (for example by
 * the U.S. Naval Observatory): not subject to copyright in the United
 * States (17 U.S.C. § 105). There is no SPDX identifier for this case: a
 * local reference is used, in the form SPDX provides for unlisted licenses.
 */
export const US_GOVERNMENT_LICENSE = 'LicenseRef-US-Government-Work'

/**
 * Open licenses accepted for the data, in SPDX form: public domain,
 * Creative Commons attribution-only or share-alike, Open Data Commons. No
 * "scientific use only" or "non-commercial": whoever downloads must be
 * free to use and redistribute.
 */
export const OPEN_DATA_LICENSES: readonly string[] = [
  'CC0-1.0',
  'PDDL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-SA-3.0',
  'CC-BY-SA-4.0',
  'ODC-By-1.0',
  'ODbL-1.0',
  'etalab-2.0',
  'OGL-UK-3.0',
  US_GOVERNMENT_LICENSE
]

export function isOpenDataLicense(license: string): boolean {
  const l = license.trim().toLowerCase()
  return OPEN_DATA_LICENSES.some((x) => x.toLowerCase() === l)
}

/** License name to display: the SPDX identifier, or a phrase for cases without one. */
export function dataLicenseName(license: string): string {
  return license === US_GOVERNMENT_LICENSE ? t('corePackage.publicDomain') : license
}

/** Package type: deep-sky objects or stars for plate solving. */
export type PackageType = 'deep-sky' | 'stars'

/** Gallery group reserved for star packages. */
export const STAR_GROUP = 'stars'

/** Groups into which the gallery divides the catalogs (field `group` of catalog.json). */
export const CATALOG_GROUPS = [
  STAR_GROUP,
  'emission-nebulae',
  'dark-nebulae',
  'reflection-nebulae',
  'planetary-nebulae',
  'supernova-remnants',
  'galaxies',
  'galaxy-groups',
  'star-clusters',
  'other'
] as const

export type CatalogGroup = (typeof CATALOG_GROUPS)[number]

/** Manifest texts that can be translated, with their maximum length. */
export const TRANSLATABLE_FIELDS = {
  name: 80,
  description: 600,
  authors: 200,
  reference: 400,
  dataNote: 300
} as const

export type TranslatableField = keyof typeof TRANSLATABLE_FIELDS

/** The texts of one language: those missing fall back to English. */
export type ManifestTranslation = Partial<Record<TranslatableField, string>>

/** Maximum number of languages in `translations` and in `noteLanguages`. */
export const MAX_TRANSLATIONS = 50
export const MAX_NOTE_LANGUAGES = 20

/** Language code: "it", "fr", "pt-BR". */
const RE_LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

/** Manifest of a package, `catalog.json`. */
export interface CatalogManifest {
  format: number
  /** Stable identifier, lowercase letters and hyphens: "sharpless". */
  id: string
  /** Displayed name, in English: "Sharpless (Sh2)". */
  name: string
  /** Package version, 1.2.3: it increases when the data is regenerated. */
  version: string
  /** Deep-sky objects (`objects.tsv`) or stars for plate solving (`stars.bin`). */
  type: PackageType
  group: CatalogGroup
  /** Two or three sentences: what it contains and who it is for. */
  description: string
  /** Who compiled the original catalog: "Sharpless (1959)". */
  authors: string
  /** Bibliographic reference to cite. */
  reference: string
  /**
   * Description of the objects without a note of their own ("Position from
   * Wikidata, without size…"); without it they read "From the … catalog.".
   */
  dataNote?: string
  /** Where the data comes from (page of the service or archive). */
  source: string
  /** Data license, SPDX. */
  license: string
  /** Page that declares the license. */
  licenseLink: string
  /** Number of objects in the package (of stars, for a star package). */
  objects: number
  /** Example designation, to explain how to search: "Sh2-155". Empty for stars. */
  example: string
  /** Stars only: magnitude of the faintest star included. */
  limitMagnitude?: number
  /** Languages of the note columns that follow the English one in objects.tsv. */
  noteLanguages: string[]
  /** Translated texts, by language code. */
  translations: Record<Language, ManifestTranslation>
}

/**
 * A manifest text in `language` (the current one by default), falling back
 * to English, the manifest's main language.
 */
export function catalogText(
  m: Pick<CatalogManifest, TranslatableField | 'translations'>,
  field: TranslatableField,
  language: Language = getLanguage()
): string {
  const translated = language === FALLBACK_LANGUAGE ? undefined : m.translations?.[language]?.[field]
  return translated || m[field] || ''
}

/** Displayed name of a catalog, in the current language. */
export function catalogName(m: Pick<CatalogManifest, TranslatableField | 'translations'>): string {
  return catalogText(m, 'name')
}

/** Entry of the server index: the manifest plus where and how much to download. */
export interface CatalogIndexEntry extends CatalogManifest {
  /** Name of the .zip file in the `catalogs/` folder. */
  file: string
  /** Archive size in bytes. */
  byte: number
  /** SHA-256 hash of the archive, lowercase hexadecimal. */
  sha256: string
}

export interface CatalogIndex {
  format: number
  updated: string
  catalogs: CatalogIndexEntry[]
}

const RE_ID = /^[a-z0-9][a-z0-9-]{1,39}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const RE_SHA = /^[0-9a-f]{64}$/
const RE_FILE = /^[a-z0-9][a-z0-9._-]{0,80}\.zip$/

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export type CatalogManifestResult =
  | { ok: true; manifest: CatalogManifest }
  | { ok: false; errors: string[]; remedy?: string }

/** Maximum objects in a deep-sky catalog: the largest published one has about 14,000. */
export const MAX_CATALOG_OBJECTS = 500_000
/** Maximum stars in a star package (the published one has about 2.7 million). */
export const MAX_PACKAGE_STARS = 40_000_000
/** Maximum size of the catalog.json manifest. */
export const CATALOG_MANIFEST_LIMIT_BYTES = 64 * 1024
/** Maximum size of objects.tsv (that of the largest published catalog is about 2 MB). */
export const OBJECTS_LIMIT_BYTES = 48 * 1024 * 1024
/** Maximum size of stars.bin (the published one is 17 MB). */
export const STARS_LIMIT_BYTES = 256 * 1024 * 1024

/** Checks a manifest and returns it cleaned (known fields only). */
export function checkCatalogManifest(raw: unknown): CatalogManifestResult {
  if (!object(raw)) return { ok: false, errors: [CATALOG.manifestNotObject], remedy: REMEDIES.catalogAuthor }
  const g = raw
  const errors: string[] = []
  let remedy: string = REMEDIES.catalogAuthor
  /** Checks a text: length and invisible characters. `key` names it in the messages. */
  const checkText = (v: string, key: string, max: number): string => {
    if (v.length > max) errors.push(CATALOG.fieldTooLong(key, max))
    if (hasControlCharacters(v.replace(/[\n\r\t]/g, ' '))) errors.push(NAMES.controlCharacters(key))
    return v.trim()
  }
  // `nameKey` is the language key of the field's name, used in the error message.
  const text = (key: string, nameKey: string, max = 200): string => {
    const v = g[key]
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(CATALOG.missingField(t('corePackage.fields.' + nameKey)))
      return ''
    }
    return checkText(v, key, max)
  }

  if (g.format !== CATALOG_FORMAT) {
    const futureValue = typeof g.format === 'number' && g.format > CATALOG_FORMAT
    errors.push(futureValue ? CATALOG.futureFormat : CATALOG.unrecognizedFormat)
    if (futureValue) remedy = REMEDIES.updateStarLight
  }
  const id = text('id', 'id', 40)
  if (id && !RE_ID.test(id)) errors.push(CATALOG.invalidId)
  else if (id && isReservedName(id)) errors.push(NAMES.reserved(id))
  const name = text('name', 'name', TRANSLATABLE_FIELDS.name)
  const version = text('version', 'version', 20)
  if (version && !VERSION_RE.test(version)) errors.push(CATALOG.invalidVersion)
  const type = g.type
  if (type !== 'deep-sky' && type !== 'stars') {
    errors.push(CATALOG.unknownType(String(type).slice(0, 40)))
    remedy = REMEDIES.updateStarLight
  }
  const group = text('group', 'group', 60)
  if (group && !(CATALOG_GROUPS as readonly string[]).includes(group)) errors.push(CATALOG.unknownGroup(group))
  else if (group && (type === 'stars') !== (group === STAR_GROUP)) errors.push(CATALOG.inconsistentGroup(group))
  const description = text('description', 'description', TRANSLATABLE_FIELDS.description)
  const authors = text('authors', 'authors', TRANSLATABLE_FIELDS.authors)
  const reference = text('reference', 'reference', TRANSLATABLE_FIELDS.reference)
  const dataNote =
    typeof g.dataNote === 'string' && g.dataNote.trim() !== ''
      ? checkText(g.dataNote, 'dataNote', TRANSLATABLE_FIELDS.dataNote)
      : undefined
  const source = text('source', 'source', 300)
  const license = text('license', 'license', 40)
  if (license && !isOpenDataLicense(license)) errors.push(CATALOG.nonOpenLicense(license))
  const licenseLink = text('licenseLink', 'licenseLink', 300)
  // Stars are not searched by designation: the example is needed only for object catalogs.
  const example =
    type === 'stars'
      ? typeof g.example === 'string'
        ? g.example.trim().slice(0, 40)
        : ''
      : text('example', 'example', 40)
  const number = g.objects
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) errors.push(CATALOG.objectCount)
  else if (number > (type === 'stars' ? MAX_PACKAGE_STARS : MAX_CATALOG_OBJECTS)) {
    errors.push(CATALOG.tooManyObjects(type === 'stars' ? MAX_PACKAGE_STARS : MAX_CATALOG_OBJECTS))
  }
  const limit = g.limitMagnitude
  if (type === 'stars' && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0 || limit > 20))
    errors.push(CATALOG.limitMagnitude)

  // Languages of the note columns: distinct codes, none of them English (the main column).
  const noteLanguages: string[] = []
  if (g.noteLanguages !== undefined) {
    const list = g.noteLanguages
    if (
      !Array.isArray(list) ||
      list.length > MAX_NOTE_LANGUAGES ||
      list.some((l) => typeof l !== 'string' || !RE_LANGUAGE.test(l) || l === FALLBACK_LANGUAGE) ||
      new Set(list).size !== list.length
    ) {
      errors.push(CATALOG.invalidNoteLanguages(MAX_NOTE_LANGUAGES))
    } else noteLanguages.push(...(list as string[]))
  }

  // Translations: for each language code, only the translatable texts.
  const translations: Record<Language, ManifestTranslation> = {}
  if (g.translations !== undefined) {
    const all = g.translations
    if (!object(all) || Object.keys(all).length > MAX_TRANSLATIONS) errors.push(CATALOG.invalidTranslations)
    else {
      for (const [language, texts] of Object.entries(all)) {
        if (!RE_LANGUAGE.test(language) || !object(texts)) {
          errors.push(CATALOG.invalidTranslations)
          break
        }
        const translation: ManifestTranslation = {}
        for (const field of Object.keys(TRANSLATABLE_FIELDS) as TranslatableField[]) {
          const v = texts[field]
          if (v === undefined) continue
          if (typeof v !== 'string') {
            errors.push(CATALOG.invalidTranslations)
            continue
          }
          if (v.trim() !== '') translation[field] = checkText(v, 'translations.' + language + '.' + field, TRANSLATABLE_FIELDS[field])
        }
        translations[language] = translation
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, remedy }
  return {
    ok: true,
    manifest: {
      format: CATALOG_FORMAT,
      id,
      name,
      version,
      type: type as PackageType,
      group: group as CatalogGroup,
      description,
      authors,
      reference,
      ...(dataNote !== undefined ? { dataNote } : {}),
      source,
      license,
      licenseLink,
      objects: number as number,
      example,
      ...(type === 'stars' ? { limitMagnitude: limit as number } : {}),
      noteLanguages,
      translations
    }
  }
}

/** Checks the index downloaded from the server; keeps only the valid entries. */
export function readCatalogsIndex(raw: unknown): CatalogIndex {
  if (!object(raw) || !Array.isArray(raw.catalogs)) throw new Error(t('corePackage.indexUnreadable'))
  const catalogs: CatalogIndexEntry[] = []
  for (const v of raw.catalogs) {
    if (!object(v)) continue
    const result = checkCatalogManifest(v)
    if (!result.ok) continue
    if (typeof v.file !== 'string' || !RE_FILE.test(v.file)) continue
    if (typeof v.sha256 !== 'string' || !RE_SHA.test(v.sha256)) continue
    if (typeof v.byte !== 'number' || !(v.byte > 0) || v.byte > PACKAGE_LIMIT_BYTES) continue
    catalogs.push({
      ...result.manifest,
      file: v.file,
      byte: v.byte,
      sha256: v.sha256
    })
  }
  return {
    format: typeof raw.format === 'number' ? raw.format : CATALOG_FORMAT,
    updated: typeof raw.updated === 'string' ? raw.updated : '',
    catalogs
  }
}

function number(field: string | undefined): number | null {
  if (field === undefined || field === '') return null
  const n = Number(field)
  return Number.isFinite(n) ? n : null
}

/** Maximum rows in objects.tsv, comments included. */
export const MAX_OBJECT_ROWS = 600_000
/** Maximum length of an objects.tsv row (the longest published ones are 600 characters). */
export const MAX_LINE_LENGTH = 4096
/**
 * Unreadable rows tolerated: a historical catalog always has a few entries
 * without a position, which are discarded. Beyond 5% of the rows (and at
 * least 5 rows) the file is corrupt or not in the right format, and the
 * catalog is rejected.
 */
export const MALFORMED_ROWS_SHARE = 0.05
/** Maximum size of an object: 60 degrees, beyond any real nebula. */
export const MAX_SIZE_ARCMIN = 3600

/** Description of a package object in a given language. */
export type ObjectDescriber = (object: CelestialObject, language: Language) => string

/** Outcome of reading objects.tsv, with the discarded rows and the reason. */
export interface ObjectAnalysis {
  objects: CelestialObject[]
  /**
   * The description of an object of `objects` in any language: its note,
   * or the catalog's data note. The objects carry the current language's.
   */
  describe: ObjectDescriber
  /** Data rows (excluding comments and empty rows). */
  rows: number
  discardedItems: number
  /** Why the first unreadable row was discarded (protectionTexts CATALOG.row). */
  example: string
  /** Problems that cause the catalog to be rejected; empty if it is usable. */
  errors: string[]
}

/** Removes invisible characters and shortens a displayed text. */
function cleaned(text: string, max: number): string {
  return Array.from(text)
    .filter((c) => !hasControlCharacters(c))
    .join('')
    .slice(0, max)
}

/** What analyzeCatalogObjects needs from the manifest. */
export type ManifestForObjects = Pick<CatalogManifest, 'name'> &
  Partial<Pick<CatalogManifest, 'objects' | 'noteLanguages' | 'translations' | TranslatableField>>

/**
 * Reads `objects.tsv` and checks every row: designation present, sky
 * coordinates, plausible size, magnitude and position angle. Wrong rows are
 * discarded; if there are too many (see MALFORMED_ROWS_SHARE), or the file
 * is too large, or the objects read do not match the manifest, `errors`
 * says why the catalog must be rejected.
 */
export function analyzeCatalogObjects(tsv: string, manifest: ManifestForObjects): ObjectAnalysis {
  const notes = new Map<CelestialObject, Record<Language, string>>()
  const texts = {
    name: manifest.name,
    description: manifest.description ?? '',
    authors: manifest.authors ?? '',
    reference: manifest.reference ?? '',
    dataNote: manifest.dataNote,
    translations: manifest.translations ?? {}
  }
  const describe: ObjectDescriber = (o, language) => {
    const n = notes.get(o)
    if (n) return n[language] || n[FALLBACK_LANGUAGE] || Object.values(n).find((x) => x !== '') || ''
    return (
      catalogText(texts, 'dataNote', language) ||
      t('corePackage.fromCatalog', { name: catalogText(texts, 'name', language) }, language)
    )
  }
  const result: ObjectAnalysis = { objects: [], describe, rows: 0, discardedItems: 0, example: '', errors: [] }
  if (tsv.length > OBJECTS_LIMIT_BYTES) {
    result.errors.push(CATALOG.objectsTooBig(OBJECTS_LIMIT_BYTES / 1048576))
    return result
  }
  if (tsv.includes('�')) {
    result.errors.push(CATALOG.objectsNotText)
    return result
  }
  const rows = tsv.split('\n')
  if (rows.length > MAX_OBJECT_ROWS) {
    result.errors.push(CATALOG.tooManyLines(MAX_OBJECT_ROWS))
    return result
  }
  const noteLanguages = manifest.noteLanguages ?? []
  const language = getLanguage()
  const R = CATALOG.row
  const discard = (reason: string): void => {
    result.discardedItems++
    if (!result.example) result.example = reason
  }
  for (const rawValue of rows) {
    if (!rawValue || rawValue.startsWith('#') || rawValue === '\r') continue
    result.rows++
    if (rawValue.length > MAX_LINE_LENGTH) {
      discard(R.long)
      continue
    }
    const [code, alias, type, ra, dec, maj, min, pa, mag, name, note, ...translatedNotes] = rawValue
      .replace(/\r$/, '')
      .split('\t')
    if (!code || !code.trim() || hasControlCharacters(code)) {
      discard(R.code)
      continue
    }
    const a = number(ra)
    const d = number(dec)
    if (a === null || d === null || a < 0 || a >= 360 || d < -90 || d > 90) {
      discard(R.coordinates)
      continue
    }
    const majorAxis = number(maj)
    const minorAxis = number(min)
    const angle = number(pa)
    const magnitude = number(mag)
    // A field that is present but unreadable ("abc" where a number belongs) is an error; an empty one is not.
    if ([maj, min, pa, mag].some((c, i) => c !== undefined && c !== '' && [majorAxis, minorAxis, angle, magnitude][i] === null)) {
      discard(R.number)
      continue
    }
    if (
      [majorAxis, minorAxis].some((s) => s !== null && (s < 0 || s > MAX_SIZE_ARCMIN))
    ) {
      discard(R.dimensions)
      continue
    }
    if (magnitude !== null && (magnitude < -30 || magnitude > 40)) {
      discard(R.magnitude)
      continue
    }
    if (angle !== null && (angle < -360 || angle > 360)) {
      discard(R.angle)
      continue
    }
    const id = cleaned(code.trim(), 60)
    const object: CelestialObject = {
      id,
      name: name ? cleaned(name, 120) || id : id,
      aliases: alias
        ? alias
            .split('|')
            .filter((x) => x !== '')
            .slice(0, 64)
            .map((x) => cleaned(x, 80))
        : [],
      type: CATALOG_TYPES[type] ?? 'other',
      ra: a,
      dec: d,
      magnitude: magnitude,
      sizeArcmin: majorAxis,
      minorArcmin: minorAxis,
      positionAngle: angle,
      constellation: '',
      description: ''
    }
    const objectNotes: Record<Language, string> = {}
    if (note) objectNotes[FALLBACK_LANGUAGE] = cleaned(note, 1000)
    noteLanguages.forEach((l, i) => {
      const n = translatedNotes[i]
      if (n) objectNotes[l] = cleaned(n, 1000)
    })
    if (Object.keys(objectNotes).length > 0) notes.set(object, objectNotes)
    object.description = describe(object, language)
    result.objects.push(object)
  }
  if (result.objects.length === 0) result.errors.push(CATALOG.objectsEmpty)
  else if (result.discardedItems >= 5 && result.discardedItems > result.rows * MALFORMED_ROWS_SHARE) {
    result.errors.push(CATALOG.malformedRows(result.discardedItems, result.rows, result.example))
  } else if (manifest.objects !== undefined) {
    // The objects read may be slightly fewer than declared (the discarded
    // rows), never more, and never many fewer.
    const readCount = result.objects.length
    if (readCount > manifest.objects || readCount < manifest.objects * (1 - MALFORMED_ROWS_SHARE)) {
      result.errors.push(CATALOG.differentNumber(readCount, manifest.objects))
    }
  }
  return result
}

/**
 * Reads `objects.tsv` into StarLight objects, silently discarding wrong
 * rows (without a designation or with impossible values). To know whether
 * the catalog as a whole is usable, use analyzeCatalogObjects.
 */
export function readCatalogObjects(tsv: string, manifest: ManifestForObjects): CelestialObject[] {
  return analyzeCatalogObjects(tsv, manifest).objects
}

/** Readable size in the current language's number format: "3.4 MB", "820 kB". */
export function formatBytes(byte: number): string {
  if (byte >= 1024 * 1024) return formatNumber(byte / (1024 * 1024), { maximumFractionDigits: 1 }) + ' MB'
  return formatNumber(Math.max(1, Math.round(byte / 1024))) + ' kB'
}
