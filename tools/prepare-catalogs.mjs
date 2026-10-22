/*
 * Prepares the deep sky catalog packages to be published on the server.
 *
 *   npm run prepare-catalogs                            downloads the sources (or takes them from the cache) and creates the packages
 *   npm run prepare-catalogs -- --refresh               downloads the sources again even if they are in the cache
 *   npm run prepare-catalogs -- --only sharpless,ldn    only the listed catalogs
 *
 * Depth limit: only objects within reach of advanced amateur
 * astrophotography (galaxies down to magnitude 14). Deeper catalogs
 * would weigh the program down with objects that cannot be seen in the
 * shots.
 *
 * The result goes in dist-catalogs/: one .zip archive per catalog and
 * the catalogs.json list with the size and SHA-256 fingerprint of each.
 * It is then uploaded to R2 with "npm run publish-catalogs".
 *
 * Only sources with a declared open license (see src/core/catalog/package.ts):
 *   - VizieR tables of articles published under the CC-BY 4.0 license
 *     (the license declared by the publisher for the article and its data);
 *   - Wikidata, whose data are all CC0.
 * The historical VizieR catalogs (Sharpless, LBN, LDN, Barnard, Arp…) do not
 * declare a license: their positions come from Wikidata, without the
 * columns of the original tables.
 *
 * Each package contains catalog.json, objects.tsv, LICENSE.txt and
 * ATTRIBUTION.md. The exception is the stars package for plate solving
 * (ucac4-stars, prepared by tools/prepare-stars.mjs from the UCAC4 data
 * of the IRSA archive, a work of the US government): instead of
 * objects.tsv there is stars.bin, and the manifest says type "stars".
 *
 * Languages: the texts of the manifest are in English, with the Italian
 * ones in `translations.it`; the object notes are in English, with the
 * Italian ones in the column that follows (`noteLanguages: ["it"]`). A
 * note shared by all the objects of a catalog goes in the manifest's
 * `dataNote` instead of being repeated on every row. The catalogs.json list
 * carries the same texts, so the gallery is in the right language before
 * the download. Another language is added by listing it in NOTE_LANGUAGES
 * and writing its texts next to the Italian ones (the `it` entries of the
 * CATALOGS list and of the note functions).
 *
 * Package versions are raised here by hand when the data or the texts
 * change; the archive name carries the version, so the files on the
 * server never change and the cache can keep them for a long time.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { prepareUcac4Stars, LIMIT_MAGNITUDE } from './prepare-stars.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cacheFolder = join(root, 'cache-catalogs')
const outputFolder = join(root, 'dist-catalogs')
const args = process.argv.slice(2)
const refresh = args.includes('--refresh')
const iOnly = args.indexOf('--only')
const only = iOnly >= 0 ? new Set((args[iOnly + 1] ?? '').split(',')) : null

const USER_AGENT = 'StarLight-catalogs/1.0 (catalog package preparation)'

/** Format of the packages and of the list (CATALOG_FORMAT in src/core/catalog/package.ts). */
const FORMAT = 2
/** Languages of the note columns after the English one, and of the manifest translations. */
const NOTE_LANGUAGES = ['it']

/* ---- Download with cache ---- */

async function downloadText(name, url, options = {}) {
  mkdirSync(cacheFolder, { recursive: true })
  const file = join(cacheFolder, name)
  if (!refresh && existsSync(file)) return readFileSync(file, 'utf-8')
  console.log('  downloading ' + name + '…')
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { ...options, headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(600000) })
      if (!r.ok) throw new Error('response ' + r.status)
      const text = await r.text()
      writeFileSync(file, text)
      return text
    } catch (e) {
      if (attempt >= 3) throw new Error(name + ': ' + e.message)
      await new Promise((ok) => setTimeout(ok, 5000 * attempt))
    }
  }
}

/** VizieR table as TSV: rows as {column: text} objects. */
async function vizier(name, source, columns, filters = '') {
  const url =
    'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=' + encodeURIComponent(source) +
    '&-out.max=unlimited&-out=' + encodeURIComponent(columns.join(',')) + filters
  const text = await downloadText(name + '.tsv', url)
  const rows = text.split('\n').filter((r) => r !== '' && !r.startsWith('#'))
  const header = rows[0].split('\t').map((c) => c.trim())
  // After the header: a units row and a row of dashes.
  return rows.slice(3).map((r) => {
    const fields = r.split('\t')
    const o = {}
    header.forEach((c, i) => (o[c] = (fields[i] ?? '').trim()))
    return o
  })
}

/** SPARQL query to Wikidata, JSON result. */
async function wikidata(name, query) {
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query)
  const text = await downloadText(name + '.json', url, { headers: { Accept: 'application/sparql-results+json' } })
  return JSON.parse(text).results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])))
}

/* ---- Utilities ---- */

const num = (s) => (s === undefined || s === '' || !Number.isFinite(Number(s)) ? null : Number(s))
const round = (x, digits) => (x === null ? '' : String(Number(x.toFixed(digits))))
/** A number in the format of a language of the notes. */
const format = (x, language, options) => x.toLocaleString(language === 'it' ? 'it-IT' : 'en-US', options)

/**
 * One row of objects.tsv, as a list of columns: the English note and then
 * the one of each language of NOTE_LANGUAGES. `type` is one of the English
 * codes of CATALOG_TYPES (src/core/catalog/package.ts).
 */
function row({ designation, alias = [], type, ra, dec, maj = null, min = null, pa = null, mag = null, name = '', note = {} }) {
  const clean = (t) => String(t).replace(/[\t\n\r|]/g, ' ').trim()
  const uniqueAliases = [...new Set(alias.map(clean).filter((a) => a !== '' && a !== designation))]
  return [
    clean(designation),
    uniqueAliases.join('|'),
    type,
    round(ra, 5),
    round(dec, 5),
    round(maj, 2),
    round(min, 2),
    round(pa, 0),
    round(mag, 2),
    clean(name),
    clean(note.en ?? ''),
    ...NOTE_LANGUAGES.map((l) => clean(note[l] ?? ''))
  ]
}

/* ---- Licenses ---- */

const LICENSES = {
  'CC-BY-4.0': {
    link: 'https://creativecommons.org/licenses/by/4.0/',
    text: 'https://creativecommons.org/licenses/by/4.0/legalcode.txt'
  },
  // Works of the US federal government: no license to download, the text
  // explains the status of the data (see UCAC4_TEXT).
  'LicenseRef-US-Government-Work': {
    link: 'https://www.copyright.gov/title17/92chap1.html#105',
    localText: () => UCAC4_TEXT
  },
  'CC0-1.0': {
    link: 'https://creativecommons.org/publicdomain/zero/1.0/',
    text: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt'
  }
}

/* ---- Wikidata sources ---- */

/**
 * Objects of a catalog on Wikidata: the designation (property P528 with
 * the catalog as qualifier P972), the J2000 coordinates (P6257, P6258),
 * the English name and the designations in other catalogs, which are used
 * to recognize objects already present in StarLight (an LBN that is also an NGC).
 */
async function wikidataObjects(key, qid) {
  return groupWikidata(
    await wikidata(
      'wikidata2-' + key,
      `SELECT ?item ?code ?ra ?dec ?label (GROUP_CONCAT(DISTINCT ?altra; separator="|") AS ?altre) (GROUP_CONCAT(DISTINCT ?inglese; separator="|") AS ?inglesi) WHERE {
  ?item p:P528 ?s . ?s ps:P528 ?code ; pq:P972 wd:${qid} .
  ?item wdt:P6257 ?ra ; wdt:P6258 ?dec .
  OPTIONAL { ?item rdfs:label ?label FILTER(lang(?label) = "en") }
  OPTIONAL { ?item wdt:P528 ?altra }
  OPTIONAL { ?item skos:altLabel ?inglese FILTER(lang(?inglese) = "en") }
} GROUP BY ?item ?code ?ra ?dec ?label`
    )
  )
}

/**
 * Objects of a certain type on Wikidata (P31), with all their designations:
 * for the catalogs that on Wikidata do not have the P972 qualifier.
 * (The SPARQL variable names stay as they are: they are part of the cached queries.)
 */
async function wikidataObjectsByType(key, typeQid) {
  return groupWikidata(
    await wikidata(
      'wikidata2-' + key,
      `SELECT ?item ?ra ?dec ?label (GROUP_CONCAT(DISTINCT ?altra; separator="|") AS ?altre) (GROUP_CONCAT(DISTINCT ?inglese; separator="|") AS ?inglesi) WHERE {
  ?item wdt:P31 wd:${typeQid} ; wdt:P6257 ?ra ; wdt:P6258 ?dec .
  OPTIONAL { ?item rdfs:label ?label FILTER(lang(?label) = "en") }
  OPTIONAL { ?item wdt:P528 ?altra }
  OPTIONAL { ?item skos:altLabel ?inglese FILTER(lang(?inglese) = "en") }
} GROUP BY ?item ?ra ?dec ?label`
    )
  )
}

/** Groups the Wikidata rows by item. */
function groupWikidata(rows) {
  // An item can have several coordinates (different measurements): the mean is taken.
  const byItem = new Map()
  for (const r of rows) {
    const e = byItem.get(r.item) ?? {
      codes: new Set(),
      ra: [],
      dec: [],
      label: (r.label ?? '').replace(/^NAME\s+/, ''),
      others: new Set(),
      english: new Set()
    }
    if (r.code) e.codes.add(r.code)
    e.ra.push(Number(r.ra))
    e.dec.push(Number(r.dec))
    // "NAME …" is a prefix inherited from SIMBAD: it is removed.
    const cleaned = (a) => a.replace(/^NAME\s+/, '').trim()
    for (const a of (r.altre ?? '').split('|')) if (a) e.others.add(cleaned(a))
    for (const a of (r.inglesi ?? '').split('|')) if (a && a.length <= 40) e.english.add(cleaned(a))
    // A label that is a designation ("Simeis 147") is still a name worth searching.
    if (r.label && /\d/.test(r.label) && r.label.length <= 40) e.english.add(cleaned(r.label))
    byItem.set(r.item, e)
  }
  const result = []
  for (const e of byItem.values()) {
    const ra0 = e.ra[0]
    // Circular mean of RA, for objects straddling 0h.
    const ra = e.ra.reduce((s, x) => s + (x - ra0 > 180 ? x - 360 : ra0 - x > 180 ? x + 360 : x), 0) / e.ra.length
    const dec = e.dec.reduce((s, x) => s + x, 0) / e.dec.length
    result.push({
      codes: [...e.codes],
      ra: (ra + 360) % 360,
      dec,
      label: e.label,
      others: [...e.others],
      english: [...e.english]
    })
  }
  return result
}

/** Designations from other catalogs useful as alternative names (discards survey ones). */
const USEFUL_DESIGNATIONS = /^(NGC|IC|M|Messier|Sh ?2|LBN|LDN|RCW|Gum|Ced|vdB|Barnard|B|Arp|HCG|UGC|PGC|Collinder|Cr|Melotte|Mel|Abell|Caldwell|Simeis|PN G|PK|SNR G)[\s-]*\d/i

/**
 * Common name: the English label if it is not a designation, otherwise the first
 * English alternative name that is not one ("Squid Nebula" for Sh2-129).
 */
function commonName(label, english = []) {
  if (label && !/\d/.test(label)) return label
  return english.find((a) => !/\d/.test(a)) ?? ''
}

/** Useful English alternative names: nicknames and designations from other catalogs (Simeis 147, Ou 4). */
function englishAliases(english) {
  return english.filter((a) => a.length >= 3 && !/^(New General Catalogue|Index Catalogue)/i.test(a))
}

/** Prepares a catalog from Wikidata (the note is the catalog's `dataNote`). */
function fromWikidata({ key, qid, prefix, type, suffixes = false }) {
  return async () => {
    const objects = await wikidataObjects(key, qid)
    const re = suffixes ? /(\d+)\s*([A-Za-z]?)\s*$/ : /(?:^|[\s-])(\d+)\s*$/
    const seen = new Set()
    const rows = []
    for (const o of objects) {
      let number = null
      for (const c of o.codes) {
        const m = re.exec(c.trim())
        if (m) {
          number = String(Number(m[1])) + (suffixes ? (m[2] ?? '').toLowerCase() : '')
          break
        }
      }
      if (number === null) continue
      const designation = prefix + number
      if (seen.has(designation)) continue
      seen.add(designation)
      rows.push(
        row({
          designation,
          alias: [...o.others.filter((a) => USEFUL_DESIGNATIONS.test(a)), ...englishAliases(o.english)],
          type,
          ra: o.ra,
          dec: o.dec,
          name: commonName(o.label, o.english)
        })
      )
    }
    return rows
  }
}

/* ---- Clusters from Gaia DR3 (Hunt & Reffert) ---- */

/** Historical names, in order of preference as the main designation. */
const CLUSTER_PREFERENCE = ['NGC', 'IC', 'Melotte', 'Collinder', 'Trumpler', 'Stock', 'Berkeley', 'King', 'Ruprecht', 'Dolidze', 'Palomar', 'Pismis', 'Haffner', 'Czernik', 'Basel', 'Blanco', 'Platais', 'Roslund']

/** Note of a Gaia DR3 cluster, in English and Italian. */
function clusterNote(globular, members, distance, logAge) {
  const age = logAge && !globular ? Math.pow(10, logAge) : null
  const en = [globular ? 'Globular cluster' : 'Open cluster']
  const it = [globular ? 'Ammasso globulare' : 'Ammasso aperto']
  if (members) {
    en.push(format(members, 'en') + ' member stars in Gaia DR3')
    it.push(format(members, 'it') + ' stelle membro in Gaia DR3')
  }
  if (distance) {
    en.push('distance about ' + format(Math.round(distance), 'en') + ' parsecs')
    it.push('distanza circa ' + format(Math.round(distance), 'it') + ' parsec')
  }
  if (age) {
    const billions = age >= 1e9
    const value = (l) =>
      billions ? format(age / 1e9, l, { maximumFractionDigits: 1 }) : format(Math.round(age / 1e6), l)
    en.push('age about ' + value('en') + (billions ? ' billion years' : ' million years'))
    it.push('età circa ' + value('it') + (billions ? ' miliardi di anni' : ' milioni di anni'))
  }
  return { en: en.join(', ') + '.', it: it.join(', ') + '.' }
}

async function gaiaClusters() {
  const data = await vizier('hunt-reffert-2023', 'J/A+A/673/A114/clusters', ['_RAJ2000', '_DEJ2000', 'Name', 'r50', 'Type', 'AllNames', 'N', 'dist50', 'logAge50'])
  const rows = []
  for (const d of data) {
    if (d.Type !== 'o' && d.Type !== 'g') continue
    const names = (d.AllNames || d.Name).split(',').map((n) => n.trim().replace(/_/g, ' ')).filter(Boolean)
    let designation = names[0] ?? d.Name.replace(/_/g, ' ')
    for (const p of CLUSTER_PREFERENCE) {
      const found = names.find((n) => n.startsWith(p + ' '))
      if (found) {
        designation = found
        break
      }
    }
    const r50 = num(d.r50)
    const members = num(d.N) ? Number(d.N) : null
    rows.push(
      row({
        designation,
        alias: names,
        type: d.Type === 'g' ? 'globular-cluster' : 'open-cluster',
        ra: num(d._RAJ2000),
        dec: num(d._DEJ2000),
        // Diameter of the circle containing half of the member stars.
        maj: r50 !== null ? 2 * r50 * 60 : null,
        note: clusterNote(d.Type === 'g', members, num(d.dist50), num(d.logAge50))
      })
    )
  }
  return rows
}

/* ---- Globular clusters (Vasiliev & Baumgardt) ---- */

/** Abbreviations of the globular cluster names, expanded as alternative names. */
const GLOBULAR_EXPANSIONS = { Pal: 'Palomar', Djorg: 'Djorgovski', Rup: 'Ruprecht', Ko: 'Koposov', Ton: 'Tonantzintla' }

function expandedNames(name) {
  const m = /^([A-Za-z]+)\s+(.*)$/.exec(name)
  const expanded = m && GLOBULAR_EXPANSIONS[m[1]]
  return expanded ? [expanded + ' ' + m[2]] : []
}

async function vasilievGlobulars() {
  const data = await vizier('vasiliev-baumgardt-2021', 'J/MNRAS/505/5978/tablea1', ['Name', 'OName', 'RAJ2000', 'DEJ2000', 'Rscale', 'Nstar', 'plx'])
  return data.map((d) => {
    const plx = num(d.plx)
    const withParallax = plx && plx > 0
    const parallax = (l) => format(plx, l, { maximumFractionDigits: 3 })
    const scale = num(d.Rscale)
    return row({
      designation: d.Name,
      alias: [...expandedNames(d.Name), ...(d.OName ? [d.OName] : [])],
      type: 'globular-cluster',
      ra: num(d.RAJ2000),
      dec: num(d.DEJ2000),
      maj: scale !== null ? 2 * scale : null,
      name: d.OName && /[a-z]/.test(d.OName) && !/\d/.test(d.OName) ? d.OName : '',
      note: {
        en: 'Milky Way globular cluster' + (withParallax ? ', Gaia EDR3 parallax ' + parallax('en') + ' mas' : '') + '.',
        it: 'Ammasso globulare della Via Lattea' + (withParallax ? ', parallasse Gaia EDR3 ' + parallax('it') + ' mas' : '') + '.'
      }
    })
  })
}

/* ---- Galaxies (Siena Galaxy Atlas 2020) ---- */

/**
 * Only the atlas's own measurements (diameter at the 26 mag per square
 * arcsecond isophote, angle, flattening, r magnitude): the columns taken
 * from other databases do not enter the package. The note, the same for
 * all, is the catalog's dataNote.
 */
function sgaGalaxies(name, filter) {
  return async () => {
    const data = await vizier(name, 'J/ApJS/269/3/sga2020', ['Name', 'PGC', 'RAJ2000', 'DEJ2000', 'D26', 'PA', 'b/a', 'rmagSB26'], '&rmagSB26=' + encodeURIComponent(filter))
    return data.map((d) => {
      const d26 = num(d.D26)
      const ba = num(d['b/a'])
      const designation = d.PGC ? 'PGC ' + Number(d.PGC) : d.Name
      return row({
        designation,
        alias: [d.Name, ...(d.PGC ? ['PGC ' + Number(d.PGC)] : [])],
        type: 'galaxy',
        ra: num(d.RAJ2000),
        dec: num(d.DEJ2000),
        maj: d26,
        min: d26 !== null && ba !== null ? d26 * ba : null,
        pa: num(d.PA),
        mag: num(d.rmagSB26)
      })
    })
  }
}

/* ---- Galactic designations (PN G, SNR G) ---- */

/**
 * Uniform key for a designation in galactic coordinates: "PN G047.0+42.4",
 * "G47.0+42.4" and "047.0+42.4" all become "047.0+42.4".
 */
function galacticKey(text) {
  const m = /(\d{1,3}\.\d)\s*([+-])\s*(\d{1,2}\.\d)/.exec(text)
  if (!m) return null
  return Number(m[1]).toFixed(1).padStart(5, '0') + m[2] + Number(m[3]).toFixed(1).padStart(4, '0')
}

/* ---- Planetary nebulae ---- */

/**
 * Positions and names from Wikidata (objects of type "planetary nebula"),
 * diameters from the CC BY tables of Bucciarelli & Stanghellini (2023) and
 * of Stanghellini et al. (2020), merged by PN G designation. Kept are the
 * nebulae with a diameter of at least 10″ (the others are point-like in
 * amateur shots) and those of the Abell catalog, even without a diameter.
 */
async function planetaryNebulae() {
  const radii = new Map()
  for (const r of await vizier('bucciarelli-2023', 'J/A+A/680/A104/table3', ['PNG', 'theta'])) {
    const k = galacticKey(r.PNG)
    if (k && num(r.theta)) radii.set(k, num(r.theta))
  }
  for (const r of await vizier('stanghellini-2020', 'J/ApJ/889/21/table1', ['PNG', 'theta'])) {
    const k = galacticKey(r.PNG)
    if (k && num(r.theta) && !radii.has(k)) radii.set(k, num(r.theta))
  }
  const objects = await wikidataObjectsByType('planetary-nebulae', 'Q13632')
  const rows = []
  const seen = new Set()
  const abellPresent = new Set()
  for (const o of objects) {
    const all = [...o.others, ...o.english, o.label]
    const png = all.map((c) => (/^PN\s*G/i.test(c) ? galacticKey(c) : null)).find(Boolean) ?? null
    const abell = all.map((c) => /^(?:PN\s*)?(?:A66|Abell)\s*(\d{1,2})$/i.exec(c.trim())).find(Boolean)
    const radius = png ? radii.get(png) : undefined
    const diameter = radius !== undefined ? (2 * radius) / 60 : null
    if (!abell && (diameter === null || diameter < 10 / 60)) continue
    const classic = o.others.filter((c) => /^(NGC|IC|M|Jones-Emberson|JnEr|Minkowski|M\s?\d-\d|Sh\s?2|Hu|Humason|K\s?\d|Kohoutek|PuWe|IsWe|Sp|Hb|He)\b/i.test(c))
    const designation = abell ? 'Abell ' + Number(abell[1]) : classic[0] ?? (png ? 'PN G' + png : null)
    if (!designation || seen.has(designation)) continue
    seen.add(designation)
    if (abell) abellPresent.add(Number(abell[1]))
    const size = diameter !== null ? Math.round(diameter * 60) + '″' : ''
    rows.push(
      row({
        designation,
        alias: [
          ...(png ? ['PN G' + png] : []),
          ...(abell ? ['PN A66 ' + Number(abell[1])] : []),
          ...o.others.filter((a) => USEFUL_DESIGNATIONS.test(a) || /^(PK|Jones|JnEr|Minkowski|M\s?\d-\d)/i.test(a)),
          ...englishAliases(o.english)
        ],
        type: 'planetary-nebula',
        ra: o.ra,
        dec: o.dec,
        maj: diameter,
        name: commonName(o.label, o.english),
        note: {
          en: 'Planetary nebula' + (size ? ', diameter ' + size : '') + '.',
          it: 'Nebulosa planetaria' + (size ? ', diametro ' + size : '') + '.'
        }
      })
    )
  }
  // The complete Abell catalog, also for the nebulae that on Wikidata are not
  // classified as planetary or do not carry the designation (the Medusa).
  for (const o of await wikidataObjects('abell-pn', 'Q18205121')) {
    const m = o.codes.map((c) => /(\d{1,2})\s*$/.exec(c)).find(Boolean)
    if (!m || abellPresent.has(Number(m[1]))) continue
    const designation = 'Abell ' + Number(m[1])
    if (seen.has(designation)) continue
    seen.add(designation)
    rows.push(
      row({
        designation,
        alias: ['PN A66 ' + Number(m[1]), ...o.others.filter((a) => USEFUL_DESIGNATIONS.test(a)), ...englishAliases(o.english)],
        type: 'planetary-nebula',
        ra: o.ra,
        dec: o.dec,
        name: commonName(o.label, o.english),
        note: { en: 'Planetary nebula of the Abell catalog.', it: 'Nebulosa planetaria del catalogo di Abell.' }
      })
    )
  }
  return rows
}

/* ---- Supernova remnants ---- */

/** Morphological types of Ranasinghe & Leahy: shell, filled center, composite. */
const SNR_TYPES = {
  S: { en: 'Shell-type supernova remnant', it: 'Resto di supernova a guscio' },
  F: { en: 'Filled-center supernova remnant', it: 'Resto di supernova pieno' },
  C: { en: 'Composite supernova remnant', it: 'Resto di supernova composito' }
}

/**
 * Positions and names from Wikidata (objects of type "supernova remnant"),
 * sizes and type from the CC BY table of Ranasinghe & Leahy (2023),
 * merged by SNR G designation. Kept are only the remnants with an optical
 * counterpart: a common name or a designation in an optical catalog
 * (Sharpless, Simeis, NGC, IC, LBN, RCW…). Those visible only at radio
 * wavelengths are of no use for a shot.
 */
async function supernovaRemnants() {
  const measures = new Map()
  for (const r of await vizier('ranasinghe-leahy-2023', 'J/ApJS/265/53/table1', ['SNR', 'Size1', 'Size2', 'Type'])) {
    const k = galacticKey(r.SNR)
    if (k) measures.set(k, { a: num(r.Size1), b: num(r.Size2), type: r.Type })
  }
  const optical = /^(Sh\s?2|Simeis|S\s?147|NGC|IC|LBN|RCW|Gum|Ced|vdB|Messier|M\s?1$|CTA|W\s?\d)/i
  const objects = await wikidataObjectsByType('supernova-remnants', 'Q207436')
  const rows = []
  const seen = new Set()
  for (const o of objects) {
    const all = [...o.others, ...o.english, o.label]
    const g = all.map((c) => (/^(SNR\s*)?G\s?\d/i.test(c) ? galacticKey(c) : null)).find(Boolean) ?? null
    const name = commonName(o.label, o.english)
    const isOptical = name !== '' || all.some((c) => optical.test(c.trim()))
    if (!g || !isOptical) continue
    const designation = 'SNR G' + g
    if (seen.has(designation)) continue
    seen.add(designation)
    const m = measures.get(g)
    const kind = (m && SNR_TYPES[m.type?.[0]]) || { en: 'Supernova remnant', it: 'Resto di supernova' }
    const size = m?.a ? ', ' + m.a + '′' + (m.b && m.b !== m.a ? ' × ' + m.b + '′' : '') : ''
    rows.push(
      row({
        designation,
        alias: [...o.others.filter((a) => USEFUL_DESIGNATIONS.test(a)), ...englishAliases(o.english)],
        type: 'supernova-remnant',
        ra: o.ra,
        dec: o.dec,
        maj: m?.a ?? null,
        min: m?.b ?? null,
        name,
        note: { en: kind.en + size + '.', it: kind.it + size + '.' }
      })
    )
  }
  return rows
}

/* ---- Galaxy clusters (MCXC-II) ---- */

/**
 * Galaxy clusters from the MCXC-II catalog (Sadibekova et al. 2024, CC BY),
 * only the nearby ones (redshift up to 0.06): the galaxies of more distant
 * clusters are too faint for amateur shots. The apparent diameter is
 * derived from the R500 radius and the distance, with H0 = 70 km/s/Mpc: at
 * these redshifts the approximation is enough to draw the marker.
 */
async function galaxyClusters() {
  const data = await vizier('mcxc-ii', 'J/A+A/688/A187/mcxcii', ['MCXC', 'OName', 'AName', 'RAJ2000', 'DEJ2000', 'z', 'R500'])
  // Designations and names of the Abell catalog from Wikidata (CC0), merged by position:
  // the X-ray catalog does not always carry the designation ("Coma" instead of Abell 1656).
  const abellWd = (await wikidataObjects('aco', 'Q318624'))
    .map((o) => ({ ...o, number: Number(o.codes.map((c) => /(\d{1,4})\s*$/.exec(c)?.[1]).find(Boolean)) }))
    .filter((o) => o.number > 0)
  const nearAbell = (ra, dec) => {
    let best = null
    let distance = 6 / 60
    for (const o of abellWd) {
      const dRa = Math.abs(o.ra - ra) > 180 ? 360 - Math.abs(o.ra - ra) : Math.abs(o.ra - ra)
      const dd = Math.hypot(dRa * Math.cos((dec * Math.PI) / 180), o.dec - dec)
      if (dd < distance) {
        distance = dd
        best = o
      }
    }
    return best
  }
  const rows = []
  const seen = new Set()
  for (const d of data) {
    const z = num(d.z)
    if (z === null || z <= 0 || z > 0.06) continue
    // Abell designation, written in various ways: "A426", "A0085", "ABELL 1656".
    const abellDesignation = /(?:^|[\s,])A(?:BELL)?\s?0*(\d{1,4})\b/i.exec(d.AName ?? '')
    const wd = nearAbell(num(d.RAJ2000), num(d.DEJ2000))
    const number = abellDesignation ? Number(abellDesignation[1]) : wd ? wd.number : null
    const abell = number ? [null, String(number)] : null
    const designation = abell ? 'ACO ' + Number(abell[1]) : d.MCXC
    if (seen.has(designation)) continue
    seen.add(designation)
    const distance = ((299792.458 * z) / 70) / (1 + z) // Mpc, angular diameter distance
    const r500 = num(d.R500)
    const diameter = r500 !== null ? ((2 * r500) / distance) * (180 / Math.PI) * 60 : null
    // "Abell n" only above 86: the lower numbers are the Abell planetary nebulae.
    const alias = [d.MCXC, d.OName]
    if (abell && Number(abell[1]) > 86) alias.push('Abell ' + Number(abell[1]))
    for (const n of (d.AName ?? '').split(/[,;]/)) if (n.trim()) alias.push(n.trim())
    if (wd) alias.push(...englishAliases(wd.english))
    const aNameName = /^[A-Za-z][A-Za-z ]+$/.test((d.AName ?? '').trim()) ? (d.AName ?? '').trim() : ''
    const millionsOfLightYears = Math.round((299792.458 * z) / 70 * 3.26)
    const redshift = (l) => format(z, l, { maximumFractionDigits: 4 })
    rows.push(
      row({
        designation,
        alias,
        name: (wd ? commonName(wd.label, wd.english) : '') || aNameName,
        type: 'galaxy-group',
        ra: num(d.RAJ2000),
        dec: num(d.DEJ2000),
        maj: diameter,
        note: {
          en: 'Galaxy cluster, redshift ' + redshift('en') + ', distance about ' + format(millionsOfLightYears, 'en') + ' million light-years.',
          it: 'Ammasso di galassie, redshift ' + redshift('it') + ', distanza circa ' + millionsOfLightYears + ' milioni di anni luce.'
        }
      })
    )
  }
  return rows
}

/* ---- List of the catalogs ---- */

/*
 * Texts of each catalog: `name`, `description`, `authors`, `reference` and,
 * where present, `dataNote` are { en, it } pairs (a missing `it` means the
 * English text holds for both, as for bibliographic references); `credits`
 * and `modifications` go only in ATTRIBUTION.md, in English.
 */

const WIKIDATA_NOTE = {
  en: 'Position from Wikidata, without size: the marker shows the center of the object.',
  it: 'Posizione da Wikidata, senza dimensioni: il marcatore indica il centro dell’oggetto.'
}

const WIKIDATA_CREDITS = (catalog) =>
  'Positions and designations of the ' + catalog + ' catalog from Wikidata (https://www.wikidata.org), ' +
  'data released under the CC0 1.0 license (public domain). Many Wikidata values in turn come from ' +
  'SIMBAD (CDS, Strasbourg).'

/** Last sentence of the description of the Wikidata catalogs. */
const WIKIDATA_POSITIONS = {
  en: 'Positions come from Wikidata and do not include sizes.',
  it: 'Le posizioni provengono da Wikidata e non comprendono le dimensioni.'
}

/** "Author (year); positions from Wikidata" in both languages. */
const fromWikidataAuthors = (authors) => ({ en: authors + '; positions from Wikidata', it: authors + '; posizioni da Wikidata' })

/* ---- Stars for plate solving ---- */

const UCAC4_CITATION =
  'Zacharias N., Finch C. T., Girard T. M., Henden A., Bartlett J. L., Monet D. G., Zacharias M. I., 2013, ' +
  'The Fourth US Naval Observatory CCD Astrograph Catalog (UCAC4), The Astronomical Journal 145, 44. ' +
  'DOI 10.1088/0004-6256/145/2/44'

const UCAC4_DATASET =
  'Zacharias N. et al., 2020, Fourth U.S. Naval Observatory CCD Astrograph Catalog (UCAC4), ' +
  'NASA/IPAC Infrared Science Archive (IRSA). DOI 10.26131/IRSA17'

/** Text of LICENSE.txt of the stars package: the status of the data and the required citations. */
const UCAC4_TEXT = [
  'Stars for plate solving - terms of use of the data',
  '==================================================',
  '',
  'The stars.bin file contains stars taken from the UCAC4 catalog (The Fourth U.S. Naval',
  'Observatory CCD Astrograph Catalog), produced by the United States Naval Observatory, an',
  'agency of the federal government of the United States.',
  '',
  'This package contains data derived from UCAC4, a work of the United States Government',
  'prepared by the U.S. Naval Observatory. Works of the U.S. Government are not subject to',
  'copyright protection in the United States (17 U.S.C. § 105). The data may be freely used,',
  'modified and redistributed.',
  '',
  'Users of these data are asked to cite the paper describing the catalog, as requested by',
  'its authors:',
  '',
  '  ' + UCAC4_CITATION,
  '',
  'and the dataset from which they were downloaded, as requested by the archive that',
  'distributes it:',
  '',
  '  ' + UCAC4_DATASET,
  '',
  'This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by',
  'the National Aeronautics and Space Administration and operated by the California',
  'Institute of Technology.',
  ''
].join('\n')

const UCAC4_STARS = {
  id: 'ucac4-stars',
  type: 'stars',
  version: '2.0.0',
  group: 'stars',
  name: {
    en: 'Stars for plate solving (UCAC4, down to magnitude 12)',
    it: 'Stelle per la risoluzione del campo (UCAC4, fino alla magnitudine 12)'
  },
  description: {
    en: 'All-sky stars down to magnitude 12 from the UCAC4 catalog of the U.S. Naval Observatory. With this package plate solving works without an internet connection and is faster; for very narrow fields, where stars down to magnitude 12 are few, the online Gaia catalog is still needed.',
    it: 'Le stelle di tutto il cielo fino alla magnitudine 12, dal catalogo UCAC4 dello U.S. Naval Observatory. Con questo pacchetto la risoluzione del campo funziona anche senza internet ed è più veloce; per i campi molto stretti, dove le stelle fino alla magnitudine 12 sono poche, serve ancora il catalogo Gaia in rete.'
  },
  authors: {
    en: 'N. Zacharias and collaborators, U.S. Naval Observatory (2013)',
    it: 'N. Zacharias e collaboratori, U.S. Naval Observatory (2013)'
  },
  reference: {
    en: 'Zacharias N. et al., 2013, AJ 145, 44. DOI 10.1088/0004-6256/145/2/44; data: IRSA, DOI 10.26131/IRSA17',
    it: 'Zacharias N. et al., 2013, AJ 145, 44. DOI 10.1088/0004-6256/145/2/44; dati: IRSA, DOI 10.26131/IRSA17'
  },
  source: 'https://irsa.ipac.caltech.edu/data/UCAC4/',
  license: 'LicenseRef-US-Government-Work',
  example: '',
  credits:
    'Stars of the UCAC4 catalog (' + UCAC4_CITATION + '), a work of the U.S. Naval Observatory, downloaded with ' +
    'the TAP service of the NASA/IPAC Infrared Science Archive, table ucac4_sources (' + UCAC4_DATASET + '). ' +
    'Works of the federal government of the United States are not subject to copyright in the United States ' +
    '(17 U.S.C. § 105).',
  modifications:
    'Package prepared for StarLight: the stars down to magnitude 12 in the UCAC4 band (579-642 nm, ' +
    '"fit model magnitude") are kept; for the stars brighter than magnitude 9, whose measurement is distorted ' +
    'by saturation, the V magnitude of the catalog is used; for the stars added from Hipparcos and Tycho-2, ' +
    'which have no UCAC measurement, the aperture magnitude or V is used. The J2000 positions are brought to ' +
    'epoch 2025.0 with the proper motions of the catalog, which are then not kept. Coordinates are rounded ' +
    'with an error below 0.04″ in right ascension and 0.03″ in declination, magnitudes to 1/16 of a ' +
    'magnitude, in the stars.bin binary format described in src/core/astrometry/localStars.ts. No data was ' +
    'added beyond those of the source.'
}

const CATALOGS = [
  UCAC4_STARS,
  {
    id: 'gaia-clusters',
    version: '2.0.0',
    group: 'star-clusters',
    name: { en: 'Star clusters from Gaia DR3', it: 'Ammassi stellari da Gaia DR3' },
    description: {
      en: 'About seven thousand open and globular clusters of the Milky Way, identified in the Gaia DR3 data, with radius, number of member stars, distance and age. It includes the historical Collinder, Melotte, Trumpler, Stock, Berkeley, King and Ruprecht catalogs as alternative names.',
      it: 'Circa settemila ammassi aperti e globulari della Via Lattea, identificati nei dati Gaia DR3, con raggio, numero di stelle membro, distanza ed età. Comprende i cataloghi storici Collinder, Melotte, Trumpler, Stock, Berkeley, King e Ruprecht come nomi alternativi.'
    },
    authors: { en: 'E. L. Hunt, S. Reffert (2023)', it: 'E. L. Hunt, S. Reffert (2023)' },
    reference: { en: 'Hunt E. L., Reffert S., 2023, A&A 673, A114. DOI 10.1051/0004-6361/202346285' },
    source: 'https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/A+A/673/A114',
    license: 'CC-BY-4.0',
    example: 'Collinder 399',
    credits:
      'Data from the "clusters" table of Hunt & Reffert (2023), Astronomy & Astrophysics 673, A114, ' +
      'article and data published under the Creative Commons Attribution 4.0 license. Table distributed by the ' +
      'VizieR service of the CDS, Strasbourg (DOI 10.26093/cds/vizier). The package contains only the open and ' +
      'globular clusters (moving groups excluded), with reformatted names and the diameter computed as twice ' +
      'the r50 radius.',
    prepare: gaiaClusters
  },
  {
    id: 'globular-clusters',
    version: '2.0.0',
    group: 'star-clusters',
    name: { en: 'Milky Way globular clusters', it: 'Ammassi globulari della Via Lattea' },
    description: {
      en: 'The 170 known globular clusters of the Milky Way, with positions and radii measured on Gaia EDR3 data. It adds the globular clusters without an NGC designation, such as those of the Palomar, Terzan and Djorgovski catalogs.',
      it: 'I 170 ammassi globulari noti della Via Lattea, con posizioni e raggi misurati sui dati Gaia EDR3. Aggiunge i globulari che non hanno una sigla NGC, come quelli dei cataloghi Palomar, Terzan e Djorgovski.'
    },
    authors: { en: 'E. Vasiliev, H. Baumgardt (2021)', it: 'E. Vasiliev, H. Baumgardt (2021)' },
    reference: { en: 'Vasiliev E., Baumgardt H., 2021, MNRAS 505, 5978. DOI 10.1093/mnras/stab1475' },
    source: 'https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/MNRAS/505/5978',
    license: 'CC-BY-4.0',
    example: 'Palomar 5',
    credits:
      'Data from table A1 of Vasiliev & Baumgardt (2021), Monthly Notices of the Royal Astronomical ' +
      'Society 505, 5978, article and data published under the Creative Commons Attribution 4.0 license. ' +
      'Table distributed by the VizieR service of the CDS, Strasbourg (DOI 10.26093/cds/vizier). Diameter ' +
      'computed as twice the scale radius.',
    prepare: vasilievGlobulars
  },
  {
    id: 'sga-galaxies-14',
    version: '2.0.0',
    group: 'galaxies',
    name: { en: 'Galaxies (SGA, down to mag 14)', it: 'Galassie (SGA, fino a mag 14)' },
    description: {
      en: 'The galaxies of the Siena Galaxy Atlas down to magnitude 14 in the r band, with diameter, flattening and orientation measured on the images: the galaxies within reach of amateur astrophotography, beyond those of OpenNGC. The atlas covers about half of the sky and leaves out the band of the Milky Way.',
      it: 'Le galassie del Siena Galaxy Atlas fino alla magnitudine 14 nella banda r, con diametro, schiacciamento e orientamento misurati sulle immagini: le galassie alla portata dell’astrofotografia amatoriale, oltre a quelle di OpenNGC. L’atlante copre circa metà del cielo e lascia fuori la fascia della Via Lattea.'
    },
    authors: { en: 'J. Moustakas and collaborators (2023)', it: 'J. Moustakas e collaboratori (2023)' },
    reference: { en: 'Moustakas J. et al., 2023, ApJS 269, 3. DOI 10.3847/1538-4365/acfaa2' },
    dataNote: {
      en: 'Galaxy of the Siena Galaxy Atlas; magnitude in the r band.',
      it: 'Galassia del Siena Galaxy Atlas; magnitudine nella banda r.'
    },
    source: 'https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/ApJS/269/3',
    license: 'CC-BY-4.0',
    example: 'PGC 69533',
    credits:
      'Data from the Siena Galaxy Atlas 2020 (Moustakas et al. 2023, The Astrophysical Journal Supplement ' +
      'Series 269, 3), article and data published under the Creative Commons Attribution 4.0 license. Table ' +
      'distributed by the VizieR service of the CDS, Strasbourg (DOI 10.26093/cds/vizier). The package ' +
      'contains only the atlas’s own measurements: D26 diameter, axis ratio, position angle and r magnitude.',
    prepare: sgaGalaxies('sga-14', '<14')
  },
  {
    id: 'sharpless',
    version: '2.0.0',
    group: 'emission-nebulae',
    name: { en: 'Sharpless (Sh2)', it: 'Sharpless (Sh2)' },
    description: {
      en: 'The catalog of HII regions of the northern hemisphere compiled by Stewart Sharpless in 1959: the large hydrogen emission nebulae, classic subjects for narrowband filters. ' + WIKIDATA_POSITIONS.en,
      it: 'Il catalogo delle regioni HII dell’emisfero nord compilato da Stewart Sharpless nel 1959: le grandi nebulose a emissione dell’idrogeno, soggetti classici per i filtri a banda stretta. ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('S. Sharpless (1959)'),
    reference: { en: 'Sharpless S., 1959, ApJS 4, 257' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q66381095',
    license: 'CC0-1.0',
    example: 'Sh2-155',
    credits: WIKIDATA_CREDITS('Sharpless (Sh2)'),
    prepare: fromWikidata({ key: 'sharpless', qid: 'Q66381095', prefix: 'Sh2-', type: 'nebula' })
  },
  {
    id: 'lbn',
    version: '2.0.0',
    group: 'emission-nebulae',
    name: { en: 'Lynds Bright Nebulae (LBN)', it: 'Lynds, nebulose brillanti (LBN)' },
    description: {
      en: 'Beverly Lynds’s catalog of bright nebulae (1965), drawn from the plates of the Palomar Sky Survey: emission and reflection nebulae of the northern hemisphere, many of them without an NGC or IC designation. ' + WIKIDATA_POSITIONS.en,
      it: 'Il catalogo delle nebulose brillanti di Beverly Lynds (1965), ricavato dalle lastre della Palomar Sky Survey: nebulose a emissione e a riflessione dell’emisfero nord, molte delle quali prive di sigla NGC o IC. ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('B. T. Lynds (1965)'),
    reference: { en: 'Lynds B. T., 1965, ApJS 12, 163' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q13411059',
    license: 'CC0-1.0',
    example: 'LBN 437',
    credits: WIKIDATA_CREDITS('Lynds Bright Nebulae (LBN)'),
    prepare: fromWikidata({ key: 'lbn', qid: 'Q13411059', prefix: 'LBN ', type: 'nebula' })
  },
  {
    id: 'rcw-gum',
    version: '2.0.0',
    group: 'emission-nebulae',
    name: { en: 'Southern nebulae RCW and Gum', it: 'Nebulose australi RCW e Gum' },
    description: {
      en: 'The HII regions of the southern hemisphere from the catalogs of Rodgers, Campbell and Whiteoak (1960) and of Colin Gum (1955). ' + WIKIDATA_POSITIONS.en,
      it: 'Le regioni HII dell’emisfero sud dei cataloghi di Rodgers, Campbell e Whiteoak (1960) e di Colin Gum (1955). ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('A. W. Rodgers, C. T. Campbell, J. B. Whiteoak (1960); C. S. Gum (1955)'),
    reference: { en: 'Rodgers A. W., Campbell C. T., Whiteoak J. B., 1960, MNRAS 121, 103; Gum C. S., 1955, MmRAS 67, 155' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q2032780',
    license: 'CC0-1.0',
    example: 'RCW 49',
    credits: WIKIDATA_CREDITS('RCW and Gum'),
    prepare: async () => [
      ...(await fromWikidata({ key: 'rcw', qid: 'Q2032780', prefix: 'RCW ', type: 'nebula' })()),
      ...(await fromWikidata({ key: 'gum', qid: 'Q2721889', prefix: 'Gum ', type: 'nebula' })())
    ]
  },
  {
    id: 'cederblad',
    version: '2.0.0',
    group: 'reflection-nebulae',
    name: { en: 'Cederblad diffuse nebulae', it: 'Cederblad, nebulose diffuse' },
    description: {
      en: 'Sven Cederblad’s catalog (1946) of diffuse nebulae lit by nearby stars, mostly reflection nebulae. ' + WIKIDATA_POSITIONS.en,
      it: 'Il catalogo di Sven Cederblad (1946) delle nebulose diffuse illuminate da stelle vicine, in gran parte nebulose a riflessione. ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('S. Cederblad (1946)'),
    reference: { en: 'Cederblad S., 1946, Medd. Lunds Astron. Obs. Ser. II, 119, 1' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q3663263',
    license: 'CC0-1.0',
    example: 'Ced 201',
    credits: WIKIDATA_CREDITS('Cederblad'),
    prepare: fromWikidata({ key: 'cederblad', qid: 'Q3663263', prefix: 'Ced ', type: 'nebula', suffixes: true })
  },
  {
    id: 'ldn',
    version: '2.0.0',
    group: 'dark-nebulae',
    name: { en: 'Lynds Dark Nebulae (LDN)', it: 'Lynds, nebulose oscure (LDN)' },
    description: {
      en: 'Beverly Lynds’s catalog of dark nebulae (1962): dust clouds that stand out against the starry background of the Milky Way. ' + WIKIDATA_POSITIONS.en,
      it: 'Il catalogo delle nebulose oscure di Beverly Lynds (1962): nubi di polvere che si stagliano sul fondo stellato della Via Lattea. ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('B. T. Lynds (1962)'),
    reference: { en: 'Lynds B. T., 1962, ApJS 7, 1' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q68581348',
    license: 'CC0-1.0',
    example: 'LDN 1622',
    credits: WIKIDATA_CREDITS('Lynds Dark Nebulae (LDN)'),
    prepare: fromWikidata({ key: 'ldn', qid: 'Q68581348', prefix: 'LDN ', type: 'dark-nebula' })
  },
  {
    id: 'barnard',
    version: '2.0.0',
    group: 'dark-nebulae',
    name: { en: 'Barnard dark nebulae', it: 'Barnard, nebulose oscure' },
    description: {
      en: 'Edward Emerson Barnard’s catalog (1927) of dark nebulae, including the Horsehead (B 33) and the Pipe. ' + WIKIDATA_POSITIONS.en,
      it: 'Il catalogo di Edward Emerson Barnard (1927) delle nebulose oscure, fra cui la Testa di Cavallo (B 33) e la Pipa. ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('E. E. Barnard (1927)'),
    reference: { en: 'Barnard E. E., 1927, Catalogue of 349 dark objects in the sky, University of Chicago Press' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q3247327',
    license: 'CC0-1.0',
    example: 'B 72',
    credits: WIKIDATA_CREDITS('Barnard'),
    prepare: fromWikidata({ key: 'barnard', qid: 'Q3247327', prefix: 'B ', type: 'dark-nebula' })
  },
  {
    id: 'arp',
    version: '2.0.0',
    group: 'galaxies',
    name: { en: 'Arp peculiar galaxies', it: 'Arp, galassie peculiari' },
    description: {
      en: 'Halton Arp’s atlas of peculiar galaxies (1966): interacting, distorted or unusually shaped galaxies. ' + WIKIDATA_POSITIONS.en,
      it: 'L’atlante delle galassie peculiari di Halton Arp (1966): galassie interagenti, deformate o con forme insolite. ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('H. Arp (1966)'),
    reference: { en: 'Arp H., 1966, ApJS 14, 1' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q757251',
    license: 'CC0-1.0',
    example: 'Arp 273',
    credits: WIKIDATA_CREDITS('Arp'),
    prepare: fromWikidata({ key: 'arp', qid: 'Q757251', prefix: 'Arp ', type: 'galaxy' })
  },
  {
    id: 'hickson',
    version: '2.0.0',
    group: 'galaxy-groups',
    name: { en: 'Hickson Compact Groups (HCG)', it: 'Hickson, gruppi compatti (HCG)' },
    description: {
      en: 'The hundred compact groups of galaxies of Paul Hickson (1982), small groupings of four or more galaxies very close to one another. ' + WIKIDATA_POSITIONS.en,
      it: 'I cento gruppi compatti di galassie di Paul Hickson (1982), piccoli raggruppamenti di quattro o più galassie molto vicine fra loro. ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('P. Hickson (1982)'),
    reference: { en: 'Hickson P., 1982, ApJ 255, 382' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q1574240',
    license: 'CC0-1.0',
    example: 'HCG 92',
    credits: WIKIDATA_CREDITS('Hickson Compact Groups (HCG)'),
    prepare: fromWikidata({ key: 'hickson', qid: 'Q1574240', prefix: 'HCG ', type: 'galaxy-group' })
  },
  {
    id: 'planetary-nebulae',
    version: '2.0.0',
    group: 'planetary-nebulae',
    name: { en: 'Planetary nebulae', it: 'Nebulose planetarie' },
    description: {
      en: 'The planetary nebulae of the Milky Way with a diameter of at least 10″, including those of the Abell catalog and others without an NGC or IC designation, with the measured diameter. Positions and names come from Wikidata, diameters from two recent catalogs.',
      it: 'Le nebulose planetarie della Via Lattea con un diametro di almeno 10″, comprese quelle del catalogo di Abell e altre prive di sigla NGC o IC, con il diametro misurato. Le posizioni e i nomi provengono da Wikidata, i diametri da due cataloghi recenti.'
    },
    authors: fromWikidataAuthors('L. Stanghellini and collaborators (2020, 2023)'),
    reference: { en: 'Bucciarelli B., Stanghellini L., 2023, A&A 680, A104; Stanghellini L. et al., 2020, ApJ 889, 21' },
    source: 'https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/A+A/680/A104',
    license: 'CC-BY-4.0',
    example: 'Abell 39',
    credits:
      'Positions, names and designations from Wikidata (https://www.wikidata.org), CC0 1.0 data. Angular ' +
      'diameters from table 3 of Bucciarelli & Stanghellini (2023), Astronomy & Astrophysics 680, A104 (CC BY 4.0), ' +
      'and, where missing, from table 1 of Stanghellini et al. (2020), The Astrophysical Journal 889, 21 (CC BY 3.0); ' +
      'tables distributed by the VizieR service of the CDS, Strasbourg (DOI 10.26093/cds/vizier). The diameter is ' +
      'twice the angular radius theta. The whole is distributed under the more restrictive of the two licenses, CC BY 4.0.',
    prepare: planetaryNebulae
  },
  {
    id: 'supernova-remnants',
    version: '2.0.0',
    group: 'supernova-remnants',
    name: { en: 'Supernova remnants', it: 'Resti di supernova' },
    description: {
      en: 'The supernova remnants of the Milky Way that are also visible in optical light, such as the Spaghetti Nebula and the Veil, with size and structure. Those observable only at radio wavelengths are excluded. Positions and names come from Wikidata, sizes from a recent catalog.',
      it: 'I resti di supernova della Via Lattea visibili anche in luce ottica, come la nebulosa Spaghetti e i Veli, con dimensioni e struttura. Sono esclusi quelli osservabili solo nelle onde radio. Le posizioni e i nomi provengono da Wikidata, le dimensioni da un catalogo recente.'
    },
    authors: fromWikidataAuthors('S. Ranasinghe, D. Leahy (2023)'),
    reference: { en: 'Ranasinghe S., Leahy D., 2023, ApJS 265, 53. DOI 10.3847/1538-4365/acc1de' },
    source: 'https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/ApJS/265/53',
    license: 'CC-BY-4.0',
    example: 'Simeis 147',
    credits:
      'Positions, names and designations from Wikidata (https://www.wikidata.org), CC0 1.0 data. Sizes and ' +
      'morphological type from table 1 of Ranasinghe & Leahy (2023), The Astrophysical Journal Supplement Series 265, ' +
      '53, article and data under the CC BY 4.0 license, table distributed by the VizieR service of the CDS, ' +
      'Strasbourg (DOI 10.26093/cds/vizier).',
    prepare: supernovaRemnants
  },
  {
    id: 'van-den-bergh',
    version: '2.0.0',
    group: 'reflection-nebulae',
    name: { en: 'van den Bergh reflection nebulae (vdB)', it: 'van den Bergh, nebulose a riflessione (vdB)' },
    description: {
      en: 'Sidney van den Bergh’s catalog (1966) of reflection nebulae: dust clouds lit by nearby stars, often blue in color. ' + WIKIDATA_POSITIONS.en,
      it: 'Il catalogo di Sidney van den Bergh (1966) delle nebulose a riflessione: nubi di polvere illuminate da stelle vicine, spesso di colore azzurro. ' + WIKIDATA_POSITIONS.it
    },
    authors: fromWikidataAuthors('S. van den Bergh (1966)'),
    reference: { en: 'van den Bergh S., 1966, AJ 71, 990' },
    dataNote: WIKIDATA_NOTE,
    source: 'https://www.wikidata.org/wiki/Q2941646',
    license: 'CC0-1.0',
    example: 'vdB 152',
    credits: WIKIDATA_CREDITS('van den Bergh (vdB)'),
    prepare: fromWikidata({ key: 'vdb', qid: 'Q2941646', prefix: 'vdB ', type: 'nebula' })
  },
  {
    id: 'galaxy-clusters',
    version: '2.0.0',
    group: 'galaxy-groups',
    name: { en: 'Nearby galaxy clusters', it: 'Ammassi di galassie vicini' },
    description: {
      en: 'The nearest galaxy clusters, up to redshift 0.06, with the Abell catalog designations where they exist and an apparent extent derived from the mass measured in X-rays. It includes the Perseus, Coma and Hercules clusters.',
      it: 'Gli ammassi di galassie più vicini, fino a redshift 0,06, con le sigle del catalogo di Abell dove esistono e un’estensione apparente ricavata dalla massa misurata nei raggi X. Comprende gli ammassi di Perseo, della Chioma e di Ercole.'
    },
    authors: { en: 'T. Sadibekova and collaborators (2024)', it: 'T. Sadibekova e collaboratori (2024)' },
    reference: { en: 'Sadibekova T. et al., 2024, A&A 688, A187. DOI 10.1051/0004-6361/202449427' },
    source: 'https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/A+A/688/A187',
    license: 'CC-BY-4.0',
    example: 'ACO 426',
    credits:
      'Data from the MCXC-II catalog (Sadibekova et al. 2024, Astronomy & Astrophysics 688, A187), article and data ' +
      'under the CC BY 4.0 license, table distributed by the VizieR service of the CDS, Strasbourg (DOI ' +
      '10.26093/cds/vizier). The package contains the clusters up to redshift 0.06; the apparent diameter is ' +
      'computed from the R500 radius with a Hubble constant of 70 km/s/Mpc.',
    prepare: galaxyClusters
  }
]

/* ---- ZIP archive ---- */

/** Writes a ZIP archive (deflate method) with the given files. */
function createZip(files) {
  const locals = []
  const centrals = []
  let position = 0
  // Fixed date: the same content always gives the same archive.
  const time = 0
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf-8')
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt16LE(8, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    locals.push(header, nameBytes, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(position, 42)
    centrals.push(central, nameBytes)
    position += 30 + nameBytes.length + compressed.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(position, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

/* ---- Preparation ---- */

/** Text of ATTRIBUTION.md, in English. */
function attribution(c, count) {
  const stars = c.type === 'stars'
  return [
    '# ' + c.name.en,
    '',
    c.description.en,
    '',
    '## Source and credits',
    '',
    c.credits,
    '',
    '- Authors of the original catalog: ' + c.authors.en,
    '- Reference: ' + c.reference.en,
    '- Data source: ' + c.source,
    '- Data license: ' + c.license + ' (' + LICENSES[c.license].link + ')',
    (stars ? '- Stars in the package: ' : '- Objects in the package: ') + count,
    '',
    '## Modifications',
    '',
    c.modifications ??
      'Package prepared for StarLight: data converted to the objects.tsv format (designation, alternative ' +
        'names, type, J2000 coordinates in degrees, sizes in arcminutes, position angle, magnitude, common ' +
        'name, note), with the descriptions written in English and Italian. No data was added beyond those of ' +
        'the source.',
    ''
  ].join('\n')
}

/**
 * Manifest of a catalog: English texts, the translations of the other
 * languages and, for object catalogs, the languages of the note columns.
 */
function manifest(c, count, noteLanguages) {
  const translations = {}
  for (const l of NOTE_LANGUAGES) {
    const t = {}
    for (const field of ['name', 'description', 'authors', 'reference', 'dataNote']) {
      const text = c[field]?.[l]
      if (text && text !== c[field].en) t[field] = text
    }
    translations[l] = t
  }
  return {
    format: FORMAT,
    id: c.id,
    type: c.type ?? 'deep-sky',
    name: c.name.en,
    version: c.version,
    group: c.group,
    description: c.description.en,
    authors: c.authors.en,
    reference: c.reference.en,
    ...(c.dataNote ? { dataNote: c.dataNote.en } : {}),
    source: c.source,
    license: c.license,
    licenseLink: LICENSES[c.license].link,
    objects: count,
    example: c.example,
    ...(c.type === 'stars' ? { limitMagnitude: LIMIT_MAGNITUDE } : { noteLanguages }),
    translations
  }
}

/** Writes the archive of a package and adds it to the list. */
function writePackage(c, m, dataFile, data, count) {
  const zip = createZip([
    ['catalog.json', Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf-8')],
    [dataFile, data],
    ['LICENSE.txt', Buffer.from(licenseTexts[c.license], 'utf-8')],
    ['ATTRIBUTION.md', Buffer.from(attribution(c, count), 'utf-8')]
  ])
  const file = c.id + '-' + c.version + '.zip'
  writeFileSync(join(outputFolder, file), zip)
  const sha256 = createHash('sha256').update(zip).digest('hex')
  index.catalogs.push({ ...m, file, byte: zip.length, sha256 })
  return { file, zip }
}

// With --only the other packages already prepared stay, and so do their entries in the list.
const previous = only && existsSync(join(outputFolder, 'catalogs.json'))
  ? JSON.parse(readFileSync(join(outputFolder, 'catalogs.json'), 'utf-8')).catalogs.filter((c) => !only.has(c.id))
  : []
if (!only) rmSync(outputFolder, { recursive: true, force: true })
mkdirSync(outputFolder, { recursive: true })

const licenseTexts = {}
for (const [code, l] of Object.entries(LICENSES))
  licenseTexts[code] = l.localText ? l.localText() : await downloadText('license-' + code + '.txt', l.text)

const index = { format: FORMAT, updated: new Date().toISOString().slice(0, 10), catalogs: [...previous] }
let errors = 0
for (const c of CATALOGS) {
  if (only && !only.has(c.id)) continue
  console.log('\n' + c.name.en)
  if (c.type === 'stars') {
    try {
      await prepareStarPackage(c)
    } catch (e) {
      console.error('  ✖ ' + e.message)
      errors++
    }
    continue
  }
  let rows
  try {
    rows = await c.prepare()
  } catch (e) {
    console.error('  ✖ ' + e.message)
    errors++
    continue
  }
  if (rows.length === 0) {
    console.error('  ✖ no object read')
    errors++
    continue
  }
  // The note columns of the other languages only if some object has a note.
  const withNotes = rows.some((r) => r.slice(10).some((x) => x !== ''))
  const noteLanguages = withNotes ? NOTE_LANGUAGES : []
  const header =
    '# designation\talternative names\ttype\tRA (degrees, J2000)\tDec (degrees, J2000)\tmajor axis (arcmin)\tminor axis (arcmin)\tposition angle (degrees)\tmagnitude\tcommon name\tnote' +
    noteLanguages.map((l) => '\tnote (' + l + ')').join('') +
    '\n'
  const tsv = header + rows.map((r) => (withNotes ? r : r.slice(0, 11)).join('\t')).join('\n') + '\n'
  const { file, zip } = writePackage(c, manifest(c, rows.length, noteLanguages), 'objects.tsv', Buffer.from(tsv, 'utf-8'), rows.length)
  console.log('  ✔ ' + rows.length + ' objects, ' + (zip.length / 1024).toFixed(0) + ' kB → ' + file)
}

/** Stars package: stars.bin in place of objects.tsv, type "stars" in the manifest. */
async function prepareStarPackage(c) {
  const { data, count } = await prepareUcac4Stars(cacheFolder, refresh)
  const { file, zip } = writePackage(c, manifest(c, count, []), 'stars.bin', data, count)
  console.log(
    '  ✔ ' + count + ' stars, stars.bin ' + (data.length / 1048576).toFixed(1) + ' MB, archive ' +
      (zip.length / 1048576).toFixed(1) + ' MB → ' + file
  )
}

writeFileSync(join(outputFolder, 'catalogs.json'), JSON.stringify(index, null, 2) + '\n')
console.log('\n' + index.catalogs.length + ' packages in dist-catalogs/' + (errors ? ', ' + errors + ' failed' : '') + '.\n')
if (errors) process.exit(1)
