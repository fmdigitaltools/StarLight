/**
 * Test: language files.
 *
 * - Italian (reference) and English (fallback) have exactly the same keys;
 * - every other language has no key that Italian lacks; its missing keys
 *   are counted (they fall back to English) but do not fail the test;
 * - every text has the same `{placeholders}` as the Italian one;
 * - no text is empty; every language declares `common.language.name` and
 *   a valid `common.language.locale`;
 * - every key written literally in the code as t('namespace.key') exists;
 * - the mechanism: Windows language, fallbacks, placeholders, number format.
 *
 * No external files needed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LOCALES } from '../src/shared/i18n/locales'
import {
  FALLBACK_LANGUAGE,
  LANGUAGES,
  byLanguage,
  formatDecimal,
  isLanguage,
  languageForLocale,
  localeTag,
  t
} from '../src/shared/i18n/i18n'

let problems = 0
function check(condition: boolean, description: string): void {
  if (condition) return
  problems++
  console.log('  NO   ' + description)
}

type Tree = { [key: string]: string | Tree }
function flatten(tree: Tree, prefix: string, out: Map<string, string>): void {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? prefix + '.' + k : k
    if (typeof v === 'string') out.set(key, v)
    else flatten(v, key, out)
  }
}
const TABLES = LOCALES as unknown as Record<string, Record<string, Tree>>
const keys = (language: string): Map<string, string> => {
  const out = new Map<string, string>()
  for (const [ns, tree] of Object.entries(TABLES[language] ?? {})) flatten(tree, ns, out)
  return out
}
const it = keys('it')
const placeholders = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')

for (const language of Object.keys(TABLES)) {
  const own = keys(language)
  const missing = [...it.keys()].filter((k) => !own.has(k))
  console.log(language + ': ' + own.size + ' keys' + (missing.length ? ', ' + missing.length + ' missing (fallback)' : ''))
  // English is the fallback of every other language: it must be complete.
  if (language === 'en') for (const k of missing) check(false, 'missing in English: ' + k)
  for (const [k, v] of own) {
    check(it.has(k), language + ' has a key that Italian lacks: ' + k)
    check(v.trim() !== '', 'empty ' + language + ' text: ' + k)
    const ref = it.get(k)
    if (ref !== undefined) check(placeholders(ref) === placeholders(v), 'different placeholders in ' + language + ' ' + k + ': {' + placeholders(ref) + '} / {' + placeholders(v) + '}')
  }
  check(typeof own.get('common.language.name') === 'string', language + ': common.language.name is missing')
  const tag = own.get('common.language.locale') ?? ''
  let validTag = false
  try {
    validTag = tag !== '' && Intl.NumberFormat.supportedLocalesOf([tag]).length === 1
  } catch {
    validTag = false
  }
  check(validTag, language + ': common.language.locale is not a valid locale tag: «' + tag + '»')
}

// Literal keys used in the code.
// run-tests.mjs runs every test from the project root.
const src = join(process.cwd(), 'src')
const files: string[] = []
const walk = (dir: string): void => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(f)) files.push(p)
  }
}
walk(src)
let used = 0
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/\bt\(\s*'([A-Za-z][\w-]*\.[\w.-]+)'(\s*\+)?/g)) {
    used++
    const key = m[1]
    // Keys built at run time (t('panel.mode.' + mode), t('months.m' + n)): at least one key must start with the prefix.
    const exists = m[2] ? [...it.keys()].some((k) => k.startsWith(key)) : it.has(key)
    check(exists, 'key used in ' + f.slice(src.length + 1) + ' does not exist: ' + key)
  }
}
console.log('Literal keys used in the code: ' + used)

// The mechanism, independent of which languages exist: a language that is
// not there (here the made-up code `zz`) behaves like a partial translation.
check(languageForLocale('it-IT') === 'it', 'languageForLocale(it-IT) is not it')
check(languageForLocale('en-GB') === 'en', 'languageForLocale(en-GB) is not en')
check(languageForLocale('zz-ZZ') === FALLBACK_LANGUAGE, 'an unknown Windows language does not fall back to English')
check(languageForLocale(null) === FALLBACK_LANGUAGE, 'no Windows language does not fall back to English')
check(!isLanguage('zz'), 'zz is reported as an available language')
const sample = 'common.language.label'
check(t(sample, undefined, 'zz') === t(sample, undefined, 'en'), 'a missing text does not fall back to English')
check(t('menuBar.file.saveHint', { name: 'M31' }, 'en').includes('M31'), 'placeholders are not filled')
check(t('nothing.like.this', undefined, 'en') === 'nothing.like.this', 'a missing key does not show itself')
check(localeTag('zz') === localeTag('en'), 'the locale tag of an unknown language does not fall back to English')
check(byLanguage({ it: 'it', en: 'en' }, 'zz') === 'en', 'byLanguage does not fall back to English')
check(byLanguage({ it: 'it' }, 'zz') === 'it', 'byLanguage does not fall back to Italian without English')
check(formatDecimal(1.5, 1, 'it') === '1,5', 'Italian numbers do not use the decimal comma')
check(formatDecimal(1.5, 1, 'en') === '1.5', 'English numbers do not use the decimal point')
for (const l of LANGUAGES) check(l.label !== l.value, l.value + ': the language list shows the code instead of the name')

// Work subfolders: valid Windows names, different from each other.
for (const l of LANGUAGES) {
  const names = ['projects', 'exports', 'sessions'].map((type) => t('common.folders.' + type, undefined, l.value))
  for (const n of names) check(n !== '' && !/[\\/:*?"<>|]/.test(n) && !/[ .]$/.test(n), l.value + ': invalid folder name «' + n + '»')
  check(new Set(names).size === 3, l.value + ': two work subfolders have the same name')
}

// Installer and uninstaller windows (resources/installer/ui/texts.js): the
// same keys and placeholders in every language, and the subfolders it
// creates named as in the program.
// @ts-ignore: a plain browser script without types; it only sets globalThis.installerTexts.
await import('../resources/installer/ui/texts.js')
const installer = (globalThis as { installerTexts?: { TEXTS: Record<string, Record<string, string>> } }).installerTexts
check(installer !== undefined, 'installer texts not loaded')
if (installer) {
  const reference = installer.TEXTS.it
  for (const [language, table] of Object.entries(installer.TEXTS)) {
    for (const key of Object.keys(reference)) {
      check(table[key] !== undefined && table[key] !== '', 'installer ' + language + ': missing text ' + key)
      if (table[key] !== undefined) check(placeholders(table[key]) === placeholders(reference[key]), 'installer ' + language + ': different placeholders in ' + key)
    }
    for (const key of Object.keys(table)) check(key in reference, 'installer ' + language + ': key that Italian lacks: ' + key)
    const folders: Record<string, string> = { folderProjects: 'projects', folderExports: 'exports', folderSessions: 'sessions' }
    for (const [key, type] of Object.entries(folders)) {
      const program = isLanguage(language) ? t('common.folders.' + type, undefined, language) : null
      check(program === null || table[key] === program, 'installer ' + language + ': folder ' + key + ' «' + table[key] + '» differs from the program «' + program + '»')
    }
  }
  check(installer.TEXTS.en !== undefined, 'installer: English is missing')
}

if (problems > 0) {
  console.log('\n' + problems + ' checks failed.')
  process.exit(1)
}
console.log('\nAll checks passed.')
