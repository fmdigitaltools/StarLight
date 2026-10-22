import type { CelestialObject, ObjectType } from '@shared/types'
import { byLanguage, getLanguage, onLanguageChange, t, type Language } from '@shared/i18n/i18n'
import { CURATED, CURATED_CONSTELLATION_CODES } from './objects'
import { OBJECT_TEXTS_IT } from './objects.it'
import { OBJECT_TEXTS_EN, CONSTELLATIONS_EN, OPENNGC_NAMES_EN } from './objects.en'
import { CONSTELLATIONS, OPENNGC_DATA } from './openNgcData'
import type { ObjectDescriber } from './package'

/**
 * Complete object catalog.
 *
 * It merges three sources: the bulk comes from OpenNGC (~13,000 NGC/IC
 * objects, generated in `openNgcData.ts`, with the Italian common names and
 * descriptions of the `resources/catalog/translations-it.mjs` table and the
 * English descriptions of `translations-en.mjs`); the
 * hand-`CURATED` objects, written with more care for the main subjects, are
 * laid over it; finally a small Solar System list, recognized by name only
 * because its position changes over time and does not fit a fixed catalog.
 *
 * Stars and Solar System objects stay in the catalog but are not placed as
 * "passing" markers: recognition shows them only when they are the declared
 * target (see recognition.ts).
 *
 * Names, descriptions and constellations of the bundled objects follow the
 * current language: the catalog keeps every language's texts and rewrites
 * the displayed ones when the language changes. Search finds an object by
 * its name in any language.
 */

/** Compact type code -> StarLight type. */
const TYPES: Record<string, ObjectType> = {
  g: 'galaxy',
  R: 'galaxy-group',
  n: 'nebula',
  p: 'planetary-nebula',
  r: 'supernova-remnant',
  a: 'open-cluster',
  b: 'globular-cluster',
  d: 'dark-nebula',
  s: 'star',
  S: 'double-star',
  o: 'other'
}

/** Types that are not placed from the catalog: only when they are the target. */
export const TARGET_ONLY_TYPES = new Set<ObjectType>([
  'star',
  'double-star',
  'sun',
  'moon',
  'planet'
])

/** True if the object must be placed in the field when it is not the target. */
export function placeableInField(type: ObjectType): boolean {
  return !TARGET_ONLY_TYPES.has(type)
}

/**
 * Normalizes a name for comparison: "M27", "m 27", "Messier 27" match, and
 * so do "Barnard 33" and "B033" (leading zeros in the number do not count).
 */
export function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/MESSIER/g, 'M')
    .replace(/BARNARD/g, 'B')
    .replace(/[^A-Z0-9]/g, '')
    .replace(/([A-Z])0+(?=\d)/g, '$1')
}

const normalize = normalizeName

/* ---- Texts in the current language ---- */

/** Texts of a bundled object in every language. */
interface Localization {
  names: Record<Language, string> & { it: string }
  descriptions: Record<Language, string> & { it: string }
  /** IAU abbreviation of the constellation; empty if unknown. */
  constellation: string
}

/** Bundled objects with their texts in every language. */
const LOCALIZED = new Map<CelestialObject, Localization>()

function constellationName(code: string, language: Language): string {
  if (code === '') return ''
  return byLanguage({ it: CONSTELLATIONS, en: CONSTELLATIONS_EN }, language)[code] ?? CONSTELLATIONS[code] ?? ''
}

/**
 * Writes the texts of `language` into the object. The name of the other
 * language, if it is among the alternative names (an English common name
 * from OpenNGC, for example), swaps places with the current one, so that
 * the name is not repeated among the alternatives and the number of
 * alternative names does not change.
 */
function localize(o: CelestialObject, l: Localization, language: Language): void {
  const name = byLanguage(l.names, language)
  if (name !== o.name) {
    const i = o.aliases.indexOf(name)
    if (i >= 0) o.aliases[i] = o.name
    o.name = name
  }
  o.description = byLanguage(l.descriptions, language)
  o.constellation = constellationName(l.constellation, language)
}

/** Texts of a curated object or Solar System body, from the per-language data files. */
function curatedLocalization(id: string, constellation: string, fallback: CelestialObject): Localization {
  const it = OBJECT_TEXTS_IT[id]
  const en = OBJECT_TEXTS_EN[id] ?? it
  return {
    names: { it: it?.name ?? fallback.name, en: en?.name ?? fallback.name },
    descriptions: { it: it?.description ?? fallback.description, en: en?.description ?? '' },
    constellation
  }
}

/** Expands the compact OpenNGC catalog into objects. */
function fromOpenNGC(): CelestialObject[] {
  const objects: CelestialObject[] = []
  for (const row of OPENNGC_DATA.split('\n')) {
    if (!row) continue
    const [code, type, ra, dec, maj, min, pa, mag, messier, name, constellationCode, caldwell, english, description, descriptionEn] =
      row.split('\t')
    // Objects with a Messier number are called by it: it is the name the
    // telescope declares and the user recognizes; the NGC/IC designation
    // stays as an alternative designation, together with the Caldwell
    // number and OpenNGC's English common names (a file can declare
    // "Stephan's Quintet").
    const id = messier ? 'M ' + messier : code
    const aliases = messier ? [code] : []
    if (caldwell) aliases.push('Caldwell ' + caldwell)
    if (english) aliases.push(...english.split('|'))
    const object: CelestialObject = {
      id,
      name: name || id,
      aliases,
      type: TYPES[type] ?? 'other',
      ra: Number(ra),
      dec: Number(dec),
      magnitude: mag ? Number(mag) : null,
      sizeArcmin: maj ? Number(maj) : null,
      minorArcmin: min ? Number(min) : null,
      positionAngle: pa ? Number(pa) : null,
      constellation: CONSTELLATIONS[constellationCode] ?? '',
      description: description ?? ''
    }
    // English: the first OpenNGC common name for objects that have an
    // Italian name, and the English description generated next to the Italian one.
    const englishName = name ? (OPENNGC_NAMES_EN[id] ?? (english ? english.split('|')[0] : name)) : id
    LOCALIZED.set(object, {
      names: { it: object.name, en: englishName },
      descriptions: { it: object.description, en: descriptionEn ?? '' },
      constellation: constellationCode ?? ''
    })
    objects.push(object)
  }
  return objects
}

/** Solar System: no fixed position, recognized by name (English or Italian). */
const SOLAR_SYSTEM: CelestialObject[] = [
  s('Sun', 'sun', ['Sole']),
  s('Moon', 'moon', ['Luna']),
  s('Mercury', 'planet', ['Mercurio']),
  s('Venus', 'planet', ['Venere']),
  s('Mars', 'planet', ['Marte']),
  s('Jupiter', 'planet', ['Giove']),
  s('Saturn', 'planet', ['Saturno']),
  s('Uranus', 'planet', ['Urano']),
  s('Neptune', 'planet', ['Nettuno'])
]

function s(name: string, type: ObjectType, aliases: string[]): CelestialObject {
  const object: CelestialObject = {
    id: name,
    name: name,
    aliases,
    type: type,
    ra: 0,
    dec: 0,
    magnitude: null,
    sizeArcmin: null,
    constellation: '',
    description: ''
  }
  LOCALIZED.set(object, curatedLocalization(name, '', object))
  return object
}

/**
 * Shape (minor axis and angle) of a curated object merged with its OpenNGC
 * entry. The hand-written value wins; otherwise OpenNGC's is used. If the
 * curated entry declares a different major axis, OpenNGC's minor axis is
 * rescaled in the same proportion: what matters is the ratio between the
 * axes, i.e. how flattened the ellipse is, not the number itself.
 */
function shapeWithFallback(
  c: CelestialObject,
  base: CelestialObject
): Pick<CelestialObject, 'minorArcmin' | 'positionAngle'> {
  if (c.minorArcmin != null) {
    return { minorArcmin: c.minorArcmin, positionAngle: c.positionAngle ?? null }
  }
  const baseMin = base.minorArcmin ?? null
  const majBase = base.sizeArcmin
  if (baseMin === null || majBase === null || !(majBase > 0)) {
    return { minorArcmin: null, positionAngle: null }
  }
  const maj = c.sizeArcmin ?? majBase
  return { minorArcmin: (baseMin * maj) / majBase, positionAngle: base.positionAngle ?? null }
}

/** IDs of the curated objects, which take precedence on names. */
const CURATED_IDS = new Set<string>()

/** Builds the merged catalog once. */
function build(): CelestialObject[] {
  const byId = new Map<string, CelestialObject>()
  // Index by normalized identifier, to hook the curated objects.
  const index = new Map<string, string>()
  for (const o of fromOpenNGC()) {
    byId.set(o.id, o)
    index.set(normalize(o.id), o.id)
    for (const a of o.aliases) index.set(normalize(a), o.id)
  }

  // Curated objects merge with the matching OpenNGC entry, looked up by ID
  // or by one of the aliases; the curated data wins. OpenNGC entries
  // already hooked to a curated object are not absorbed into another one.
  const hookedCurated = new Set<string>()
  for (const c of CURATED) {
    const localization = curatedLocalization(c.id, CURATED_CONSTELLATION_CODES.get(c.id) ?? '', c)
    let canonicalId = index.get(normalize(c.id))
    if (!canonicalId) {
      for (const a of c.aliases) {
        canonicalId = index.get(normalize(a))
        if (canonicalId) break
      }
    }
    const found = canonicalId !== undefined ? byId.get(canonicalId) : undefined
    if (canonicalId !== undefined && found !== undefined) {
      const base = found
      // Duplicates: if an alternative name of the curated object leads to
      // another OpenNGC entry at the same point of the sky, it is the same
      // subject written twice (the Horsehead is IC 434 among the curated
      // objects and B033 among OpenNGC's additional entries): the extra
      // entry is absorbed, so the marker appears only once. The distance
      // check avoids merging different objects through a misspelled alias.
      const absorbed: CelestialObject[] = []
      for (const a of c.aliases) {
        const otherId = index.get(normalize(a))
        if (!otherId || otherId === canonicalId || hookedCurated.has(otherId)) continue
        const other = byId.get(otherId)
        if (!other) continue
        const dRa = (other.ra - base.ra) * Math.cos((base.dec * Math.PI) / 180)
        if (Math.hypot(dRa, other.dec - base.dec) > 0.1) continue
        byId.delete(otherId)
        LOCALIZED.delete(other)
        absorbed.push(other)
      }
      hookedCurated.add(canonicalId)
      CURATED_IDS.add(canonicalId)
      const mergedAliases = [
        ...new Set([
          c.id,
          ...c.aliases,
          ...base.aliases,
          base.id,
          ...absorbed.flatMap((x) => [x.id, x.name, ...x.aliases])
        ])
      ].filter((a) => a !== base.id && a !== c.name)
      const merged: CelestialObject = {
        ...base,
        name: c.name,
        type: c.type,
        description: c.description,
        constellation: c.constellation,
        magnitude: c.magnitude ?? base.magnitude,
        sizeArcmin: c.sizeArcmin ?? base.sizeArcmin,
        ...shapeWithFallback(c, base),
        aliases: mergedAliases
      }
      LOCALIZED.delete(base)
      LOCALIZED.set(merged, localization)
      byId.set(canonicalId, merged)
    } else {
      LOCALIZED.set(c, localization)
      byId.set(c.id, c)
      CURATED_IDS.add(c.id)
    }
  }

  for (const o of SOLAR_SYSTEM) byId.set(o.id, o)
  return [...byId.values()]
}

export const CATALOG: CelestialObject[] = build()

/** Objects bundled with the program, without separately installed catalogs. */
export const OBJECT_COUNT = CATALOG.length

/**
 * Precedence among objects that answer to the same name: first the curated
 * ones, then Messier, then NGC, then IC, then the other catalogs. It is
 * needed because OpenNGC gives the same common name to different entries:
 * "Eagle Nebula" is both M 16 (the cluster with the nebula) and IC 4703
 * (the nebula alone), and a telescope that declares it means M 16.
 */
function rank(o: CelestialObject): number {
  if (CURATED_IDS.has(o.id)) return 0
  if (/^M \d/.test(o.id)) return 1
  if (o.id.startsWith('NGC ')) return 2
  if (o.id.startsWith('IC ')) return 3
  return 4
}

/** Name search indexes, rebuilt when the installed catalogs change. */
const BY_ID = new Map<string, CelestialObject>()
const BY_NAME = new Map<string, CelestialObject>()

/** Search keys of an object, already normalized. */
interface Keys {
  id: string
  /** Name and alternative names, in every language. */
  names: string[]
}

function keysOf(o: CelestialObject): Keys {
  const localized = LOCALIZED.get(o)
  const names = [o.name, ...o.aliases, ...(localized ? Object.values(localized.names) : [])]
  return { id: normalize(o.id), names: [...new Set(names.map(normalize))].filter((c) => c !== '') }
}

function buildIndex(o: CelestialObject, keys: Keys): void {
  BY_ID.set(keys.id, o)
  for (const key of keys.names) {
    const present = BY_NAME.get(key)
    if (present === undefined || rank(o) < rank(present)) BY_NAME.set(key, o)
  }
}

for (const o of CATALOG) buildIndex(o, keysOf(o))

/** Rewrites the texts of the bundled objects in `language`. */
function applyLanguage(language: Language): void {
  for (const [o, l] of LOCALIZED) localize(o, l, language)
}

applyLanguage(getLanguage())
onLanguageChange(applyLanguage)

/* ---- Separately installed catalogs ---- */

/**
 * The catalog bundled with the program as it is before any package: the
 * objects, how many alternative names they had (those added by packages
 * are removed by shortening the list) and the search indexes. Every
 * rebuild starts again from here, without redoing the work on the bundled
 * entries.
 */
const BASE = [...CATALOG]
const BASE_ALIAS = new Map(BASE.map((o) => [o, o.aliases.length]))
const BY_ID_BASE = new Map(BY_ID)
const BY_NAME_BASE = new Map(BY_NAME)

/** Objects of a package with their keys, computed only once. */
interface ExternalEntry {
  object: CelestialObject
  keys: Keys
  /** Keys of the alternative names only, to look up an existing entry. */
  alias: string[]
  /** How many alternative names the object has in the package. */
  aliasCount: number
}

/** Installed packages, in the order they were registered. */
const EXTERNAL = new Map<string, ExternalEntry[]>()

/** Objects of an installed catalog, with the function that describes them in each language. */
export interface CatalogObjects {
  id: string
  objects: CelestialObject[]
  describe?: ObjectDescriber
}

/** How the objects of each installed package are described, by catalog id. */
const DESCRIBERS = new Map<string, ObjectDescriber>()

/** Rewrites the descriptions of the installed packages' objects in `language`. */
function describeExternal(language: Language): void {
  for (const [id, entries] of EXTERNAL) {
    const describe = DESCRIBERS.get(id)
    if (describe) for (const v of entries) v.object.description = describe(v.object, language)
  }
}

onLanguageChange(describeExternal)

function setDescriber(id: string, describe: ObjectDescriber | undefined): void {
  if (describe) DESCRIBERS.set(id, describe)
  else DESCRIBERS.delete(id)
}

/** Neighbors within this distance (degrees) and of the same kind: same object. */
const DUPLICATE_DISTANCE = 2 / 60

/** Object kinds: an emission nebula and a dark nebula are not merged. */
function kind(t: CelestialObject['type']): string {
  if (t === 'nebula' || t === 'supernova-remnant') return 'nebula'
  return t
}

/** One-degree cell, to find neighbors without scanning everything. */
function cell(ra: number, dec: number): number {
  return Math.floor(((ra % 360) + 360) % 360) * 1000 + Math.floor(dec + 90)
}

function grid(objects: CelestialObject[]): Map<number, CelestialObject[]> {
  const g = new Map<number, CelestialObject[]>()
  for (const o of objects) {
    if (!placeableInField(o.type)) continue
    const k = cell(o.ra, o.dec)
    const list = g.get(k)
    if (list) list.push(o)
    else g.set(k, [o])
  }
  return g
}

const BASE_GRID = grid(BASE)

/**
 * Rebuilds the catalog with the installed packages. A package object that
 * is already in the catalog, because one of its alternative names leads to
 * an existing entry or because it lies at the same point and is of the
 * same kind, is not added: its designation becomes an alternative name of
 * the existing entry. This way Sh2-275 can be found by searching, but the
 * Rosette stays a single marker.
 */
function rebuild(): void {
  for (const o of BASE) o.aliases.length = BASE_ALIAS.get(o) ?? o.aliases.length
  for (const entries of EXTERNAL.values()) for (const v of entries) v.object.aliases.length = v.aliasCount
  CATALOG.length = BASE.length
  BY_ID.clear()
  BY_NAME.clear()
  for (const [k, o] of BY_ID_BASE) BY_ID.set(k, o)
  for (const [k, o] of BY_NAME_BASE) BY_NAME.set(k, o)
  const neighbors = new Map<number, CelestialObject[]>()
  for (const [k, list] of BASE_GRID) neighbors.set(k, [...list])

  const sameNeighbor = (n: CelestialObject): CelestialObject | null => {
    const g = kind(n.type)
    const cosDec = Math.cos((n.dec * Math.PI) / 180)
    for (let dr = -1; dr <= 1; dr++) {
      for (let dd = -1; dd <= 1; dd++) {
        const list = neighbors.get(cell(n.ra + dr, n.dec + dd))
        if (!list) continue
        for (const o of list) {
          if (kind(o.type) !== g) continue
          let dRa = Math.abs(o.ra - n.ra)
          if (dRa > 180) dRa = 360 - dRa
          if (Math.hypot(dRa * cosDec, o.dec - n.dec) <= DUPLICATE_DISTANCE) return o
        }
      }
    }
    return null
  }

  for (const entries of EXTERNAL.values()) {
    for (const { object: n, keys, alias } of entries) {
      let already = BY_ID.get(keys.id)
      if (!already) {
        for (const a of alias) {
          already = BY_ID.get(a)
          if (already) break
        }
      }
      if (!already) already = sameNeighbor(n) ?? undefined
      if (already) {
        // The package's designation and names become alternative names of the existing entry.
        for (const name of [n.id, ...n.aliases, ...(n.name !== n.id ? [n.name] : [])]) {
          if (name !== already.id && !already.aliases.includes(name)) already.aliases.push(name)
        }
        for (const key of [keys.id, ...keys.names]) {
          if (!BY_NAME.has(key)) BY_NAME.set(key, already)
          if (!BY_ID.has(key)) BY_ID.set(key, already)
        }
        continue
      }
      const newValue = n
      CATALOG.push(newValue)
      buildIndex(newValue, keys)
      if (placeableInField(newValue.type)) {
        const k = cell(newValue.ra, newValue.dec)
        const list = neighbors.get(k)
        if (list) list.push(newValue)
        else neighbors.set(k, [newValue])
      }
    }
  }
}

function prepare(objects: CelestialObject[]): ExternalEntry[] {
  return objects.map((o) => ({
    object: o,
    keys: keysOf(o),
    alias: o.aliases.map(normalize).filter((c) => c !== ''),
    aliasCount: o.aliases.length
  }))
}

/**
 * Adds (or replaces) the objects of an installed catalog. With `describe`
 * their descriptions follow the language (see analyzeCatalogObjects).
 */
export function registerCatalog(id: string, objects: CelestialObject[], describe?: ObjectDescriber): void {
  EXTERNAL.set(id, prepare(objects))
  setDescriber(id, describe)
  rebuild()
}

/** Adds several catalogs together, rebuilding the catalog only once. */
export function registerCatalogs(catalogs: CatalogObjects[]): void {
  for (const c of catalogs) {
    EXTERNAL.set(c.id, prepare(c.objects))
    setDescriber(c.id, c.describe)
  }
  rebuild()
}

/**
 * Like registerCatalogs, but a catalog that makes the build fail
 * (unexpected data that slips past the checks) does not take the others
 * down with it: all are tried together, and if something breaks they are
 * tried again one at a time, leaving out those that fail. Returns the
 * excluded catalogs with the error message; the catalog bundled with the
 * program always stays usable.
 */
export function registerProtectedCatalogs(catalogs: CatalogObjects[]): { id: string; error: string }[] {
  const before = new Map(EXTERNAL)
  try {
    registerCatalogs(catalogs)
    return []
  } catch {
    // Go back to the previous state and try one catalog at a time.
  }
  const excludedItems: { id: string; error: string }[] = []
  EXTERNAL.clear()
  for (const [id, entries] of before) EXTERNAL.set(id, entries)
  for (const c of catalogs) {
    try {
      EXTERNAL.set(c.id, prepare(c.objects))
      setDescriber(c.id, c.describe)
      rebuild()
    } catch (e) {
      EXTERNAL.delete(c.id)
      DESCRIBERS.delete(c.id)
      excludedItems.push({ id: c.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  try {
    rebuild()
  } catch {
    // Even the remaining external catalogs fail: only the bundled catalog is kept.
    for (const id of [...EXTERNAL.keys()]) if (!excludedItems.some((x) => x.id === id)) excludedItems.push({ id, error: t('coreCatalog.buildError') })
    EXTERNAL.clear()
    DESCRIBERS.clear()
    rebuild()
  }
  return excludedItems
}

/** Removes the objects of an uninstalled catalog. */
export function removeCatalog(id: string): void {
  if (!EXTERNAL.delete(id)) return
  DESCRIBERS.delete(id)
  rebuild()
}

/** Objects currently in the catalog, including those of the installed catalogs. */
export function objectCount(): number {
  return CATALOG.length
}

/**
 * Looks up an object by identifier, name or alternative name. An exact
 * identifier ("IC 4703") always wins; among names shared by several
 * objects the precedence of `rank` applies.
 */
export function searchCatalog(name: string): CelestialObject | null {
  const key = normalize(name)
  if (key === '') return null
  return BY_ID.get(key) ?? BY_NAME.get(key) ?? null
}
