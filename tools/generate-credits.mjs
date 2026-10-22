/**
 * Generates THIRD-PARTY-NOTICES.md, the third-party acknowledgements of StarLight.
 *
 * Two sources:
 * - node_modules: for each package shipped with the app, the version,
 *   license, author and full license text are read;
 * - src/shared/credits.ts: the short list shown in the app, with what npm
 *   does not know about (Chromium, Node.js, data, services, methods).
 *
 * The file is written in English: it uses the English texts of the short
 * list (CREDITS_EN, CATEGORY_TITLES_EN); the checks below use the
 * reference list (CREDITS), whose names are the keys of the English texts.
 *
 * Which packages are "shipped": the production dependencies of
 * package.json, which electron-builder copies into the package, plus those
 * that Vite bundles into the interface even though they are declared among
 * the development dependencies (React, React DOM, Zustand), plus Electron.
 * For each of them their dependencies are followed too, resolved as Node
 * does (first the package's own node_modules folder, then the ones above).
 *
 * The script reports, without stopping, the differences between the license
 * written in credits.ts and the package's real one, and the new packages
 * not yet cited in the short list.
 *
 * Usage: node tools/generate-credits.mjs   (Node 22.18 or later,
 * which reads TypeScript files directly)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Development dependencies that end up in the app anyway, bundled by Vite. */
const BUNDLED = ['react', 'react-dom', 'zustand', '@colorhythm/libraw-wasm']

/**
 * Licenses that live in subfolders rather than in the package root.
 * @colorhythm/libraw-wasm (MIT) contains compiled LibRaw, which has its own
 * license: LGPL-2.1 or CDDL-1.0 at one's choice. StarLight chooses the
 * LGPL-2.1 (the CDDL is not compatible with the GPL): its text and the
 * copyright notice are included, not the CDDL.
 */
const INNER_LICENSES = {
  '@colorhythm/libraw-wasm': ['LibRaw/COPYRIGHT', 'LibRaw/LICENSE.LGPL']
}

// Node warns that the .ts file does not declare the module type: it is
// harmless (the project is not "type": "module") and is silenced here.
const originalEmitWarning = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('Module type')) return
  originalEmitWarning.call(process, warning, ...rest)
}

const { CREDITS, CREDITS_EN, CATEGORY_TITLES_EN, GAIA_CITATION } = await import(
  pathToFileURL(join(root, 'src/shared/credits.ts')).href
)

const appPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// --- Collecting the packages --------------------------------------------

/** Finds the folder of `name` starting from `from`, like Node's resolution. */
function resolvePackage(name, from) {
  let folder = from
  for (;;) {
    const candidate = join(folder, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(folder)
    if (parent === folder) return null
    folder = parent
  }
}

function authorText(author) {
  if (!author) return ''
  if (typeof author === 'string') return author.replace(/\s*[<(].*$/, '').trim()
  return author.name ?? ''
}

function websiteOf(p) {
  if (p.homepage) return p.homepage
  const r = typeof p.repository === 'string' ? p.repository : p.repository?.url
  if (!r) return 'https://www.npmjs.com/package/' + p.name
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return 'https://github.com/' + r
  return r
    .replace(/^git\+/, '')
    .replace(/^(ssh:\/\/)?git@github\.com[:/]/, 'https://github.com/')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
}

function licenseFiles(folder) {
  const names = readdirSync(folder).filter((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f))
  // Electron ships its own license together with Chromium's: the latter
  // must be cited separately (it is an HTML file several megabytes large).
  return names.filter((f) => !/chromium/i.test(f)).sort()
}

/** folder -> package data (a different folder is a different copy). */
const collected = new Map()

function collect(name, from) {
  const folder = resolvePackage(name, from)
  if (!folder) {
    console.warn('Warning: package not found in node_modules: ' + name)
    return
  }
  if (collected.has(folder)) return
  const p = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  const licenses = [...licenseFiles(folder), ...(INNER_LICENSES[p.name] ?? [])]
  collected.set(folder, {
    name: p.name,
    version: p.version,
    license: typeof p.license === 'string' ? p.license : (p.license?.type ?? 'not declared'),
    author: authorText(p.author),
    website: websiteOf(p),
    texts: licenses.map((f) => ({ file: f, text: readFileSync(join(folder, f), 'utf8').trim() }))
  })
  // Electron is a ready-made program: its npm dependencies serve only to
  // download it and are not distributed.
  if (name === 'electron') return
  for (const dependency of Object.keys(p.dependencies ?? {})) collect(dependency, folder)
}

for (const name of Object.keys(appPackage.dependencies ?? {})) collect(name, root)
for (const name of BUNDLED) collect(name, root)
collect('electron', root)

const packages = [...collected.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
)

// --- Consistency checks against the short list --------------------------

let warnings = 0
for (const r of CREDITS) {
  if (!r.pkg) continue
  const p = packages.find((x) => x.name === r.pkg)
  if (!p) {
    console.warn('Warning: ' + r.pkg + ' is in the short list but not among the distributed packages')
    warnings++
  } else if (p.license !== r.license) {
    console.warn('Warning: ' + r.pkg + ' has license ' + p.license + ', the short list says ' + r.license)
    warnings++
  }
}
const group = CREDITS.find((r) => r.name === 'Librerie di supporto di electron-updater')
for (const p of packages) {
  const cited = CREDITS.some((r) => r.pkg === p.name) || group?.note?.includes(p.name)
  if (!cited) {
    console.warn('Warning: ' + p.name + ' is not cited in src/shared/credits.ts')
    warnings++
  }
}

// --- Writing ------------------------------------------------------------

/** English name of the entry whose reference (Italian) name is `name`. */
const englishName = (name) => CREDITS_EN[CREDITS.findIndex((r) => r.name === name)]?.name
const groupEn = group ? englishName(group.name) : undefined

const lines = []
const write = (...r) => lines.push(...r)

write(
  '# Third-party acknowledgements',
  '',
  '<!-- File generated by tools/generate-credits.mjs: do not edit it by hand. -->',
  '',
  'StarLight is distributed under the GNU General Public License',
  'version 3 or, at your option, any later version (GPL-3.0-or-later). The full text',
  'is in the `LICENSE` file.',
  '',
  'StarLight relies on the work of others, listed below with the relevant',
  'licenses and terms of use.',
  ''
)

function cell(t) {
  return String(t ?? '').replace(/\|/g, '\\|')
}

for (const category of Object.keys(CATEGORY_TITLES_EN)) {
  const entries = CREDITS_EN.filter((r) => r.category === category)
  if (entries.length === 0) continue
  write('## ' + CATEGORY_TITLES_EN[category], '')

  if (category === 'component') {
    write(
      'Packages distributed with the program, read from `node_modules`. The full',
      'license texts are at the end of the document.',
      '',
      '| Package | Version | License | Author | Website |',
      '|---|---|---|---|---|'
    )
    for (const p of packages) {
      write('| ' + [p.name, p.version, p.license, p.author || '—', p.website].map(cell).join(' | ') + ' |')
    }
    write('')
    for (const r of entries.filter((v) => !v.pkg && v.name !== groupEn)) {
      write('- **' + r.name + '** — ' + r.author + ' — ' + r.license + ' — ' + r.link + (r.note ? '. ' + r.note : ''))
    }
    write('')
    continue
  }

  for (const r of entries) {
    write('### ' + r.name, '', '- Author: ' + r.author, '- License or terms: ' + r.license, '- Link: ' + r.link)
    if (r.reference) write('- Reference: ' + r.reference)
    if (r.note && !r.note.includes(GAIA_CITATION)) write('- Note: ' + r.note)
    if (r.note?.includes(GAIA_CITATION)) {
      write('- Note: ' + r.note.replace(GAIA_CITATION, '').trim(), '', 'Acknowledgement requested by ESA:', '', '> ' + GAIA_CITATION)
    }
    if (r.name === englishName('Catalogo OpenNGC')) {
      write(
        '- License text: `resources/catalog/openngc/CC-BY-SA-4.0.txt`,',
        '  or https://creativecommons.org/licenses/by-sa/4.0/legalcode'
      )
    }
    write('')
  }
  if (category === 'algorithm') {
    write(
      'The methods were implemented in StarLight starting from the cited papers:',
      'they contain no third-party code and are listed as an acknowledgement.',
      ''
    )
  }
}

write('## Package license texts', '')
for (const p of packages) {
  write('### ' + p.name + ' ' + p.version, '')
  if (p.texts.length === 0) {
    write('The package does not contain a license file. Declared license: ' + p.license + '.', '')
    continue
  }
  for (const t of p.texts) {
    if (p.texts.length > 1) write('File `' + t.file + '`:', '')
    write('```text', t.text, '```', '')
  }
}
write(
  '### Chromium',
  '',
  'The licenses of Chromium and its components are collected in the file',
  '`LICENSES.chromium.html`, distributed by Electron in the program folder.',
  ''
)

writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'), 'utf8')
console.log('THIRD-PARTY-NOTICES.md written: ' + packages.length + ' packages, ' + CREDITS.length + ' entries')
if (warnings > 0) console.log(warnings + ' warnings to check')
