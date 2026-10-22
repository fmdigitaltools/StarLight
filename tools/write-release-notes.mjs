/**
 * Writes resources/release-notes.md, the release notes that electron-builder
 * puts in latest.yml and that the update window shows, taking them from the
 * entry for the package.json version in every What's new file:
 * src/shared/whatsNew.json (Italian) and src/shared/whatsNew.<language>.json
 * (the other languages). The changes are thus written only once per
 * language: the same entries also appear in the What's new window inside
 * the program.
 *
 * Format: one section per language, each opened by a marker line, Italian
 * first and then the others in alphabetical order:
 *
 *   <!-- lang:it -->
 *   first change
 *   second change
 *
 *   <!-- lang:en -->
 *   …
 *
 * The program splits the sections with splitReleaseNotes
 * (src/shared/updates.ts) and shows the current language, else English.
 *
 * Italian and English are required; a missing entry in another language is
 * only reported. It runs automatically with "npm run dist" and
 * "npm run publish".
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shared = join(root, 'src/shared')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const REQUIRED = ['it', 'en']

/** What's new files: language code → file name. */
const files = { it: 'whatsNew.json' }
for (const name of readdirSync(shared)) {
  const m = /^whatsNew\.([a-z]{2,3}(?:-[a-z]+)?)\.json$/i.exec(name)
  if (m) files[m[1].toLowerCase()] = name
}
const languages = ['it', ...Object.keys(files).filter((l) => l !== 'it').sort()]

const sections = []
const missing = []
for (const language of languages) {
  const whatsNew = JSON.parse(readFileSync(join(shared, files[language]), 'utf8'))
  const entry = whatsNew.find((v) => v.version === version)
  if (!entry || entry.entries.length === 0) {
    missing.push(language)
    continue
  }
  sections.push('<!-- lang:' + language + ' -->\n' + entry.entries.join('\n'))
}

const missingRequired = missing.filter((l) => REQUIRED.includes(l))
if (missingRequired.length > 0) {
  console.error(
    '\nNo entry for version ' + version + ' in ' +
      missingRequired.map((l) => 'src/shared/' + files[l]).join(' and ') + '.\n' +
      'Add it at the top (version and entries) before building the package.\n'
  )
  process.exit(1)
}
for (const l of missing) console.warn('Warning: src/shared/' + files[l] + ' has no entry for ' + version + '.')

writeFileSync(join(root, 'resources/release-notes.md'), sections.join('\n\n') + '\n', 'utf8')
console.log(
  'Changes of ' + version + ' written to resources/release-notes.md (' +
    languages.filter((l) => !missing.includes(l)).join(', ') + ').'
)
