/**
 * Generates the compact StarLight catalog from OpenNGC.
 *
 * Reads the original files in resources/catalog/openngc/ (CC-BY-SA-4.0) and
 * writes src/core/catalog/openNgcData.ts, reduced to the columns the
 * application needs. Run it again whenever OpenNGC is updated:
 *   node tools/generate-catalog.mjs
 *
 * Stars stay in the catalog but are marked only when they are the declared
 * target (the rule lives in recognition, not here).
 *
 * Italian names, constellations and descriptions come from the
 * hand-written table resources/catalog/translations-it.mjs, the English
 * descriptions from resources/catalog/translations-en.mjs: after editing
 * either, this script must be run again.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONSTELLATIONS as CONSTELLATIONS_IT,
  DESCRIPTIONS as DESCRIPTIONS_IT,
  NAMES as NAMES_IT,
  ENGLISH_NAME_FIXES,
  TYPE_FIXES
} from '../resources/catalog/translations-it.mjs'
import { DESCRIPTIONS as DESCRIPTIONS_EN } from '../resources/catalog/translations-en.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'resources/catalog/openngc')

// OpenNGC -> StarLight type code (a single letter, for compactness).
const TYPE = {
  'G': 'g', 'GPair': 'R', 'GTrpl': 'R', 'GGroup': 'R',
  'OCl': 'a', 'GCl': 'b', 'Cl+N': 'n',
  'PN': 'p', 'SNR': 'r',
  'HII': 'n', 'EmN': 'n', 'Neb': 'n', 'RfN': 'n', 'DrkN': 'd',
  '*': 's', '**': 'S', '*Ass': 'o', 'Nova': 'o', 'Other': 'o'
}

const raDegrees = (s) => { const [h, m, sec] = s.split(':').map(Number); return (h + m / 60 + sec / 3600) * 15 }
const decDegrees = (s) => {
  const sign = s[0] === '-' ? -1 : 1
  const [d, m, sec] = s.replace(/^[+-]/, '').split(':').map(Number)
  return sign * (d + m / 60 + sec / 3600)
}

/** "NGC7331" -> "NGC 7331", "IC0005146" -> "IC 5146" (strips the zeros). */
function readableDesignation(name) {
  const m = name.match(/^(NGC|IC)(\d+)([A-Za-z]*)$/)
  if (!m) return name
  return m[1] + ' ' + String(Number(m[2])) + m[3]
}

/** Keys of the translation tables actually used (for the checks). */
const used = new Set()
/** OpenNGC common names left without an Italian translation. */
const untranslated = []
/** Constellation codes without an Italian name. */
const unknownConstellations = new Set()

/** Table entry: first by Messier number, then by designation. */
function entry(table, designation, messier) {
  for (const key of [messier ? 'M ' + messier : null, designation]) {
    if (key !== null && key in table) {
      used.add(key)
      return table[key]
    }
  }
  return ''
}

/** Strips the characters that would break the tab-separated format. */
function clean(text) {
  return String(text).replace(/[\t\r\n]+/g, ' ').trim()
}

function processFile(file) {
  const rows = readFileSync(join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean)
  const col = Object.fromEntries(rows[0].split(';').map((n, i) => [n, i]))
  const out = []
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i].split(';')
    const openType = c[col['Type']]
    if (openType === 'Dup' || openType === 'NonEx') continue
    const designation = readableDesignation(c[col['Name']])
    if (!c[col['RA']] || !c[col['Dec']]) continue
    const ra = raDegrees(c[col['RA']]).toFixed(4)
    const dec = decDegrees(c[col['Dec']]).toFixed(4)
    const maj = c[col['MajAx']] || ''
    // Minor axis and position angle (degrees from north towards east): they
    // give the shape of the marker ellipse. Empty if OpenNGC lacks them: the
    // marker then stays a circle. A position angle without a minor axis is
    // useless and is discarded.
    const min = maj ? c[col['MinAx']] || '' : ''
    const pa = min ? c[col['PosAng']] || '' : ''
    const mag = c[col['V-Mag']] || c[col['B-Mag']] || ''
    const messier = c[col['M']] ? String(Number(c[col['M']])) : ''
    const type = entry(TYPE_FIXES, designation, messier) || TYPE[openType] || 'o'
    // OpenNGC English common names: the first is the displayed name when no
    // translation exists; all of them are kept as alternative names, so a file
    // declaring "Stephan's Quintet" is still recognized.
    // ENGLISH_NAME_FIXES corrects the common names that OpenNGC attributes wrongly.
    const fixed = entry(ENGLISH_NAME_FIXES, designation, messier)
    const english = Array.isArray(fixed)
      ? fixed
      : (c[col['Common names']] || '').split(',').map((n) => n.trim()).filter(Boolean)
    const italian = entry(NAMES_IT, designation, messier)
    if (english.length > 0 && !italian) untranslated.push((messier ? 'M ' + messier : designation) + ': ' + english[0])
    const name = italian || english[0] || ''
    const alias = english.filter((n) => n !== name).join('|')
    const constellation = c[col['Const']] || ''
    if (constellation && !(constellation in CONSTELLATIONS_IT)) unknownConstellations.add(constellation)
    // Caldwell number: among the identifiers ("C 030"), or the designation
    // itself for OpenNGC's additional entries ("C009").
    const caldwell =
      (c[col['Identifiers']] || '').match(/(?:^|,)\s*C (\d+)/) ?? designation.match(/^C(\d+)$/)
    const descriptionIt = entry(DESCRIPTIONS_IT, designation, messier)
    const descriptionEn = entry(DESCRIPTIONS_EN, designation, messier)
    out.push(
      [
        designation, type, ra, dec, maj, min, pa, mag, messier,
        clean(name), constellation, caldwell ? String(Number(caldwell[1])) : '',
        clean(alias), clean(descriptionIt), clean(descriptionEn)
      ].join('\t')
    )
  }
  return out
}

const rows = [...processFile('NGC.csv'), ...processFile('addendum.csv')]
const tsv = rows.join('\n')

// Checks on the translation tables: a key that finds no object is almost
// always a typo.
const orphans = [NAMES_IT, DESCRIPTIONS_IT, DESCRIPTIONS_EN, TYPE_FIXES, ENGLISH_NAME_FIXES].flatMap((t) => Object.keys(t)).filter((k) => !used.has(k))
if (orphans.length > 0) console.log('WARNING, keys without an object: ' + [...new Set(orphans)].join(', '))
// Every description must exist in both languages.
const onlyOne = [
  ...Object.keys(DESCRIPTIONS_IT).filter((k) => !DESCRIPTIONS_EN[k]).map((k) => k + ' (English missing)'),
  ...Object.keys(DESCRIPTIONS_EN).filter((k) => !DESCRIPTIONS_IT[k]).map((k) => k + ' (Italian missing)')
]
if (onlyOne.length > 0) console.log('WARNING, descriptions in one language only: ' + onlyOne.join(', '))
if (untranslated.length > 0) console.log('Common names without a translation (' + untranslated.length + '): ' + untranslated.join('; '))
if (unknownConstellations.size > 0) console.log('WARNING, constellations without a name: ' + [...unknownConstellations].join(', '))

const byType = {}
for (const r of rows) { const t = r.split('\t')[1]; byType[t] = (byType[t] || 0) + 1 }

const header = `/**
 * Catalog of deep sky objects, generated from OpenNGC.
 * DO NOT edit by hand: regenerate with "node tools/generate-catalog.mjs".
 *
 * Source: OpenNGC (https://github.com/mattiaverga/OpenNGC) — CC-BY-SA-4.0.
 * This file is an adaptation of the database and remains under that license.
 *
 * Italian names and descriptions: resources/catalog/translations-it.mjs;
 * English descriptions: resources/catalog/translations-en.mjs.
 *
 * Columns (tab-separated): designation, type, RA, Dec, major axis
 * (arcmin), minor axis (arcmin), position angle (degrees from north
 * towards east; empty if unknown), magnitude, Messier number, name (Italian if translated),
 * constellation code, Caldwell number, OpenNGC English names
 * (separated by "|"), Italian description, English description.
 * Objects: ${rows.length}.
 */

export const CATALOG_SOURCE = 'OpenNGC — CC-BY-SA-4.0'

/** Italian names of the constellations, by IAU code. */
export const CONSTELLATIONS: Record<string, string> = ${JSON.stringify(CONSTELLATIONS_IT)}

export const OPENNGC_DATA = ${JSON.stringify(tsv)}
`

writeFileSync(join(root, 'src/core/catalog/openNgcData.ts'), header, 'utf8')
console.log('Objects: ' + rows.length)
console.log('By type: ' + JSON.stringify(byType))
