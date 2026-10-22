/**
 * Test of the protections against faulty or malicious plugins and catalogs.
 *
 * Each check has a purpose-built case, here, in memory or in a temporary
 * folder (never test files in the project): it must be rejected with the
 * right message (the one in shared/protectionTexts.ts) and the rest must
 * keep working. In addition, the bundled plugins in resources/plugin and
 * the catalogs published in dist-catalogs/ must all pass.
 *
 * Sections:
 *  1. ZIP archives: escaping paths, too many files, too large, decompression
 *     bombs, false declared sizes, duplicate names, passwords, unknown
 *     compression, multiple manifests, truncated archives;
 *  2. plugin installation: manifest, parameters, code, images, huge
 *     folders;
 *  3. plugin execution (in the Node sandbox): errors, time, dimensions,
 *     channels, non-numeric and out-of-range values, inconsistent geometry,
 *     shared memory;
 *  4. object catalogs: manifest, malformed rows, impossible values, sizes,
 *     object count, protected registration;
 *  5. star packages: index, length, limit magnitude, cells; recheck at
 *     startup of catalogs installed and then damaged;
 *  6. sandbox in Electron (if Electron is present): a plugin that exhausts
 *     memory brings down only the sandbox, not the StarLight window.
 *
 *   $env:TEST_SCRIPT='tools/test-protection.ts'; node tools/run-test.mjs
 */
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import type { ImageData32 } from '../src/shared/types'
import { APP_VERSION } from '../src/shared/version'
import { t } from '../src/shared/i18n/i18n'
import {
  CATALOG as T_CATALOG,
  EXECUTION,
  NAMES,
  PLUGIN,
  REMEDIES,
  STARS,
  ZIP,
  installationRejected,
  notLoadedSummary,
  pluginStopped,
  pluginStoppedAgain
} from '../src/shared/protectionTexts'
import { readZip } from '../src/main/zip'
import { inspectPlugin, fileFromPluginZip, readPluginFolder } from '../src/main/pluginInspection'
import { inspectCatalog, fileFromCatalogZip, CATALOG_ZIP_LIMITS, recheckCatalog } from '../src/main/catalogInspection'
import { validId, isSimpleFileName, checkManifest } from '../src/core/plugin/manifest'
import { runInSandbox, toleratedNonFinite, type PluginResponse } from '../src/core/plugin/isolation'
import { analyzeCatalogObjects, OBJECTS_LIMIT_BYTES } from '../src/core/catalog/package'
import { registerProtectedCatalogs, removeCatalog, searchCatalog } from '../src/core/catalog/catalog'
import { cellsInBand, checkStarFile } from '../src/core/astrometry/localStars'
import { solveWithSources } from '../src/core/astrometry/solveSources'
import { encodePng, nodeWorker } from './plugin-node'

let problems = 0
function check(ok: boolean, what: string): void {
  if (!ok) problems++
  console.log((ok ? '  ok   ' : '  NO   ') + what)
}

/** The case must be rejected with an error that contains the expected text. */
function rejected(result: { ok: boolean; errors?: string[] }, expected: string, what: string): void {
  const errors = result.ok ? [] : (result.errors ?? [])
  const ok = !result.ok && errors.some((e) => e.includes(expected))
  check(ok, what + (ok ? '' : ' — got: ' + (result.ok ? 'ACCEPTED' : errors.join(' | '))))
}

/** The function must throw an error with the expected text. */
function launch(f: () => unknown, expected: string, what: string): void {
  let message = 'NO ERROR'
  try {
    f()
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  check(message.includes(expected), what + (message.includes(expected) ? '' : ' — got: ' + message))
}

const job = mkdtempSync(join(tmpdir(), 'starlight-protection-'))

/* ---- ZIP archives built by hand ---- */

interface TestEntry {
  name: string
  data: Buffer
  method?: 0 | 8
  /** Declared extracted size, if different from the real one. */
  declared?: number
  options?: number
  /** Compression method written in the headers, if different from the one used. */
  fakeMethod?: number
}

function createZip(entries: TestEntry[], truncateTo?: number): Buffer {
  const locals: Buffer[] = []
  const centralOnes: Buffer[] = []
  let position = 0
  for (const v of entries) {
    const method = v.method ?? 8
    const compressedItems = method === 8 ? deflateRawSync(v.data) : v.data
    const name = Buffer.from(v.name, 'utf8')
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0)
    l.writeUInt16LE(20, 4)
    l.writeUInt16LE(v.options ?? 0, 6)
    l.writeUInt16LE(v.fakeMethod ?? method, 8)
    l.writeUInt32LE(compressedItems.length, 18)
    l.writeUInt32LE(v.declared ?? v.data.length, 22)
    l.writeUInt16LE(name.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(v.options ?? 0, 8)
    c.writeUInt16LE(v.fakeMethod ?? method, 10)
    c.writeUInt32LE(compressedItems.length, 20)
    c.writeUInt32LE(v.declared ?? v.data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(position, 42)
    locals.push(l, name, compressedItems)
    centralOnes.push(c, name)
    position += 30 + name.length + compressedItems.length
  }
  const central = Buffer.concat(centralOnes)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(position, 16)
  const everything = Buffer.concat([...locals, central, end])
  return truncateTo === undefined ? everything : Buffer.concat([everything.subarray(0, truncateTo), everything.subarray(position)])
}

/* ---- A valid plugin, to be broken one piece at a time ---- */

function png(side = 8): Buffer {
  const rgba = new Uint8Array(side * side * 4).fill(200)
  return encodePng(side, side, rgba)
}

const GOOD_MANIFEST = {
  id: 'protection-test',
  name: 'Protection test',
  version: '1.0.0',
  author: 'Test',
  license: 'MIT',
  category: 'photography',
  description: 'Test plugin for the protection checks.',
  icon: 'icon.png',
  previews: { before: 'before.png', after: 'after.png' },
  minimumStarLightVersion: '0.1.0',
  parameters: [
    { type: 'slider', id: 'strength', label: 'Strength', min: 0, max: 1, step: 0.01, default: 0.5 },
    {
      type: 'choice',
      id: 'mode',
      label: 'Mode',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ],
      default: 'a'
    }
  ]
}
const GOOD_CODE = 'export function processImage(im) { return { ...im, data: new Float32Array(im.data) } }\n'

function pluginFile(manifest: unknown = GOOD_MANIFEST, code: string | Buffer = GOOD_CODE): Map<string, Buffer> {
  return new Map<string, Buffer>([
    ['plugin.json', Buffer.from(typeof manifest === 'string' ? manifest : JSON.stringify(manifest))],
    ['plugin.js', typeof code === 'string' ? Buffer.from(code) : code],
    ['icon.png', png()],
    ['before.png', png()],
    ['after.png', png()]
  ])
}

const inspect = (f: Map<string, Buffer>, fromArchive = false): ReturnType<typeof inspectPlugin> => inspectPlugin(f, APP_VERSION, fromArchive)
const withManifest = (edit: Record<string, unknown>): Map<string, Buffer> => pluginFile({ ...GOOD_MANIFEST, ...edit })
const withParameter = (p: unknown): Map<string, Buffer> => pluginFile({ ...GOOD_MANIFEST, parameters: [p] })

async function main(): Promise<void> {
  /* ================= 1. ZIP ARCHIVES ================= */
  console.log('--- ZIP ARCHIVES ---')
  const goodZip = createZip([...pluginFile()].map(([name, data]) => ({ name: 'protection-test/' + name, data })))
  check(inspect(fileFromPluginZip(goodZip), true).ok, 'a valid plugin in an archive (inside a folder) installs')
  launch(() => readZip(Buffer.from('not an archive, just arbitrary text')), ZIP.notZip, 'a file that is not a ZIP')
  launch(() => readZip(createZip([{ name: '../outside.txt', data: Buffer.from('x') }])), ZIP.disallowedPaths, 'path with "../" that escapes the folder')
  launch(() => readZip(createZip([{ name: 'a/../../outside.txt', data: Buffer.from('x') }])), ZIP.disallowedPaths, 'path with "../" in the middle')
  launch(() => readZip(createZip([{ name: '/absolute.txt', data: Buffer.from('x') }])), ZIP.disallowedPaths, 'absolute path')
  launch(() => readZip(createZip([{ name: 'C:/Windows/x.dll', data: Buffer.from('x') }])), ZIP.disallowedPaths, 'path with a drive letter')
  launch(() => readZip(createZip([{ name: 'a\\..\\..\\x.txt', data: Buffer.from('x') }])), ZIP.disallowedPaths, 'path with backslashes that escapes')
  launch(
    () => readZip(createZip(Array.from({ length: 201 }, (_, i) => ({ name: 'f' + i + '.txt', data: Buffer.from('x'), method: 0 as const })))),
    ZIP.tooManyFiles(t('mainZip.whatPlugin'), 200),
    'too many files (201 of 200)'
  )
  launch(
    () => readZip(createZip([{ name: 'large.bin', data: Buffer.alloc(41 * 1024 * 1024, 7), method: 8 }])),
    ZIP.tooLarge(t('mainZip.whatPlugin'), 40),
    'extracted content over 40 MB'
  )
  launch(
    () => readZip(createZip([{ name: 'zeros.bin', data: Buffer.alloc(100 * 1024 * 1024) }]), CATALOG_ZIP_LIMITS),
    ZIP.zipBomb,
    'decompression bomb (100 MB of zeros in a few kB)'
  )
  launch(
    () => readZip(createZip([{ name: 'liar.txt', data: Buffer.alloc(5 * 1024 * 1024, 65), declared: 1000 }])),
    ZIP.zipBomb,
    'false declared size (smaller than the real one): extraction stops'
  )
  launch(
    () => readZip(createZip([{ name: 'short.txt', data: Buffer.from('hello everyone'), declared: 4000 }])),
    ZIP.damaged,
    'declared size larger than the real one'
  )
  launch(
    () =>
      readZip(
        createZip([
          { name: 'plugin.js', data: Buffer.from('one') },
          { name: 'PLUGIN.JS', data: Buffer.from('two') }
        ])
      ),
    ZIP.duplicateNames,
    'same file twice with different contents'
  )
  launch(
    () => readZip(createZip([{ name: 'stars.bin', data: Buffer.from('x'), method: 0, declared: 280 * 1024 * 1024 }]), CATALOG_ZIP_LIMITS),
    ZIP.fileTooLarge('stars.bin', 256),
    'file declared as 280 MB in a catalog (256 MB at most)'
  )
  launch(() => readZip(createZip([{ name: 'secret.txt', data: Buffer.from('x'), options: 1 }])), ZIP.password, 'password-protected archive')
  launch(() => readZip(createZip([{ name: 'x.txt', data: Buffer.from('x'), method: 0, fakeMethod: 14 }])), ZIP.unknownCompression, 'unknown compression')
  launch(() => readZip(createZip([{ name: 'x.txt', data: Buffer.alloc(2000, 66), method: 0 }], 500)), ZIP.damaged, 'truncated archive')
  launch(
    () =>
      fileFromPluginZip(
        createZip([
          { name: 'a/plugin.json', data: Buffer.from('{}') },
          { name: 'b/plugin.json', data: Buffer.from('{}') }
        ])
      ),
    ZIP.multipleManifests('plugin.json'),
    'two plugins in the same archive'
  )
  launch(() => fileFromPluginZip(createZip([{ name: 'readme.txt', data: Buffer.from('x') }])), PLUGIN.isMissing.archiveManifest, 'archive without plugin.json')
  const withDirt = fileFromPluginZip(
    createZip([...pluginFile()].map(([name, data]) => ({ name, data })).concat([{ name: 'sub/other.js', data: Buffer.from('x') }, { name: 'nul.txt', data: Buffer.from('x') }]))
  )
  check(!withDirt.has('sub/other.js') && !withDirt.has('nul.txt') && inspect(withDirt).ok, 'files in subfolders and reserved names ignored, the plugin installs')

  /* ================= 2. PLUGIN INSTALLATION ================= */
  console.log('--- PLUGIN INSTALLATION ---')
  const bundledFolder = join('resources', 'plugin')
  let bundled = 0
  for (const id of readdirSync(bundledFolder, { withFileTypes: true }).filter((v) => v.isDirectory()).map((v) => v.name)) {
    const result = inspect(await readPluginFolder(join(bundledFolder, id)))
    bundled++
    check(result.ok && result.manifest.id === id, 'bundled "' + id + '" passes all checks' + (result.ok ? '' : ' — ' + result.errors.join(' ')))
  }
  check(bundled >= 10, bundled + ' bundled plugins checked')
  check(inspect(pluginFile()).ok, 'the valid test plugin passes')

  const without = pluginFile()
  without.delete('plugin.json')
  rejected(inspect(without), PLUGIN.isMissing.folderManifest, 'missing manifest')
  rejected(inspect(pluginFile('{ "id": "broken", ')), PLUGIN.manifestNotJson, 'manifest with broken JSON')
  rejected(inspect(pluginFile('[1, 2, 3]')), PLUGIN.manifestNotObject, 'manifest that is not an object')
  rejected(inspect(pluginFile({ ...GOOD_MANIFEST, description: 'x'.repeat(70 * 1024) })), PLUGIN.manifestTooLarge(64), 'huge manifest (70 kB)')
  rejected(inspect(withManifest({ id: 'Upper Case' })), PLUGIN.invalidId('Upper Case'), 'id with uppercase letters and spaces')
  rejected(inspect(withManifest({ id: '../outside' })), PLUGIN.invalidId('../outside'), 'id with a path')
  rejected(inspect(withManifest({ id: 'con' })), NAMES.reserved('con'), 'id reserved by Windows ("con")')
  rejected(inspect(withManifest({ id: 'com1' })), NAMES.reserved('com1'), 'id reserved by Windows ("com1")')
  rejected(inspect(withManifest({ name: 'Plugin \u202Egnp.exe' })), NAMES.controlCharacters('name'), 'name with a character that reverses the writing direction')
  rejected(inspect(withManifest({ author: 'A\u0007B' })), NAMES.controlCharacters('author'), 'author with a control character')
  rejected(inspect(withManifest({ version: '1.0' })), PLUGIN.invalidVersion, 'version in the wrong form')
  rejected(inspect(withManifest({ license: 'Proprietary' })), PLUGIN.nonOpenLicense('Proprietary'), 'non-free license')
  const future = inspect(withManifest({ minimumStarLightVersion: '99.0.0' }))
  rejected(future, PLUGIN.futureMinVersion('99.0.0', APP_VERSION), 'required StarLight version in the future')
  check(!future.ok && future.remedy === REMEDIES.updateStarLight, '… with the remedy "update StarLight"')
  rejected(inspect(withManifest({ category: 'games' })), PLUGIN.category, 'unknown category')
  rejected(inspect(withManifest({ geometry: 'rotated' })), PLUGIN.geometry, 'unknown geometry')
  rejected(inspect(withManifest({ site: 'http://insecure.example' })), PLUGIN.site, 'non-https site')
  rejected(inspect(withManifest({ icon: '../../image.png' })), PLUGIN.icon, 'icon outside the folder')
  rejected(inspect(withManifest({ icon: 'nul.png' })), PLUGIN.icon, 'icon with a reserved name ("nul.png")')
  rejected(inspect(withManifest({ icon: 'icon.png.' })), PLUGIN.icon, 'icon with a trailing dot')
  rejected(inspect(withManifest({ icon: 'icon.svg' })), PLUGIN.icon, 'icon in a format that is not allowed')
  rejected(inspect(withManifest({ previews: 'before.png' })), PLUGIN.missingPreviews, 'missing previews')
  rejected(inspect(withManifest({ parameters: 'many' })), PLUGIN.paramsNotListed, 'parameters that are not a list')
  rejected(
    inspect(withManifest({ parameters: Array.from({ length: 25 }, (_, i) => ({ type: 'toggle', id: 'p' + i, label: 'P', default: true })) })),
    PLUGIN.tooManyParameters(24),
    'too many parameters (25)'
  )
  const P = PLUGIN.parameter
  const slider = { type: 'slider', id: 'x', label: 'X', min: 0, max: 1, step: 0.1, default: 0.5 }
  rejected(inspect(withParameter({ ...slider, min: 2, max: 1 })), P.minMax, 'slider with min greater than max')
  rejected(inspect(withParameter({ ...slider, min: 1, max: 1 })), P.minMax, 'slider with min equal to max')
  rejected(inspect(withParameter({ ...slider, max: 'one' })), P.minMax, 'slider with a non-numeric max')
  rejected(inspect(withParameter({ ...slider, min: -1e12 })), P.tooLargeItems, 'slider with huge values')
  rejected(inspect(withParameter({ ...slider, step: 0 })), P.step, 'slider with a zero step')
  rejected(inspect(withParameter({ ...slider, step: 5 })), P.step, 'slider with a step larger than the range')
  rejected(inspect(withParameter({ ...slider, default: 5 })), P.defaultOutside, 'slider with a default above the maximum')
  rejected(inspect(withParameter({ ...slider, default: -1 })), P.defaultOutside, 'slider with a default below the minimum')
  rejected(inspect(withParameter({ ...slider, format: 'hexadecimal' })), P.format, 'slider with an unknown format')
  rejected(inspect(withParameter({ ...slider, format: 'integer' })), P.whole, 'integer slider with decimal values')
  rejected(inspect(withParameter({ type: 'knob', id: 'x', label: 'X' })), P.type('knob'), 'unknown parameter type')
  rejected(inspect(withParameter({ type: 'slider', id: '1x', label: 'X' })), P.id, 'invalid parameter id')
  rejected(inspect(withParameter({ ...slider, label: '' })), P.label, 'parameter without a label')
  rejected(inspect(withParameter({ type: 'toggle', id: 'x', label: 'X', default: 'yes' })), P.toggle, 'toggle with a default that is not true/false')
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' }
  ]
  rejected(inspect(withParameter({ type: 'choice', id: 'x', label: 'X', options: [options[0]], default: 'a' })), P.optionCount, 'choice with a single option')
  rejected(
    inspect(withParameter({ type: 'choice', id: 'x', label: 'X', options: [options[0], { value: 'a', label: 'Double' }], default: 'a' })),
    P.duplicateOption('a'),
    'choice with two options of the same value'
  )
  rejected(inspect(withParameter({ type: 'choice', id: 'x', label: 'X', options: [options[0], { value: '', label: 'Empty' }], default: 'a' })), P.option, 'choice with an empty value')
  rejected(inspect(withParameter({ type: 'choice', id: 'x', label: 'X', options: options, default: 'c' })), P.defaultChosen, 'choice with a default that is not an option')
  rejected(inspect(withManifest({ parameters: [slider, slider] })), PLUGIN.duplicateParameter('x'), 'parameter declared twice')

  // Translations: optional, checked against the declared parameters and options.
  const T = PLUGIN.translations
  const goodTranslation = {
    it: { name: 'Prova', description: 'Plugin di prova.', parameters: { strength: { label: 'Forza', hint: 'Quanto.' }, mode: { options: { a: 'A it', b: { label: 'B it', hint: 'Seconda.' } } } } },
    'pt-BR': { name: 'Teste' }
  }
  const translated = inspect(withManifest({ translations: goodTranslation }))
  check(
    translated.ok && translated.manifest.translations?.it?.parameters?.mode?.options?.a?.label === 'A it',
    'valid translations accepted (option text as a string or as an object)'
  )
  rejected(inspect(withManifest({ translations: ['it'] })), T.notObject, 'translations that are not an object')
  rejected(inspect(withManifest({ translations: { italian: { name: 'X' } } })), T.language('italian'), 'translation with an invalid language code')
  rejected(inspect(withManifest({ translations: { it: 'Prova' } })), T.entry('it'), 'translation that is not an object')
  rejected(inspect(withManifest({ translations: { it: { name: 'x'.repeat(61) } } })), T.text('it', 'name', 60), 'translated name too long')
  rejected(inspect(withManifest({ translations: { it: { name: 'Prova‮' } } })), T.text('it', 'name', 60), 'translated name with a direction-reversal character')
  rejected(
    inspect(withManifest({ translations: { it: { parameters: { other: { label: 'Altro' } } } } })),
    T.unknownParameter('it', 'other'),
    'translation of an undeclared parameter'
  )
  rejected(
    inspect(withManifest({ translations: { it: { parameters: { mode: { options: { c: 'C' } } } } } })),
    T.unknownOption('it', 'mode', 'c'),
    'translation of an undeclared option'
  )
  rejected(
    inspect(withManifest({ translations: { it: { parameters: { strength: { options: { a: 'A' } } } } } })),
    T.options('it', 'strength'),
    'options translated for a parameter that is not a choice'
  )
  rejected(
    inspect(withManifest({ translations: Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['l' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)), {}])) })),
    T.tooMany(40),
    'more than 40 languages'
  )
  // The old Italian keys are no longer read: such a manifest misses the English fields.
  rejected(
    inspect(withManifest({ name: undefined, nome: 'Vecchio' })),
    PLUGIN.missingField(t('coreManifest.fields.name')),
    'manifest with the Italian key "nome" instead of "name": the name is missing'
  )

  const withoutCode = pluginFile()
  withoutCode.delete('plugin.js')
  rejected(inspect(withoutCode), PLUGIN.isMissing.code, 'missing code')
  rejected(inspect(pluginFile(GOOD_MANIFEST, 'export function other(im) { return im }')), PLUGIN.codeWithoutProcess, 'code without the process function')
  rejected(inspect(pluginFile(GOOD_MANIFEST, "import fs from 'node:fs'\n" + GOOD_CODE)), PLUGIN.importCode, 'code with a static import')
  rejected(inspect(pluginFile(GOOD_MANIFEST, GOOD_CODE + "\nawait import('https://example.org/x.js')")), PLUGIN.importCode, 'code with a dynamic import')
  rejected(inspect(pluginFile(GOOD_MANIFEST, GOOD_CODE + '\nconsole.log(import.meta.url)')), PLUGIN.importCode, 'code with import.meta')
  rejected(inspect(pluginFile(GOOD_MANIFEST, Buffer.concat([Buffer.from(GOOD_CODE), Buffer.from([0xff, 0xfe, 0x00])]))), PLUGIN.codeNotText, 'code that is not UTF-8 text')
  rejected(inspect(pluginFile(GOOD_MANIFEST, GOOD_CODE + '/*' + 'x'.repeat(2 * 1024 * 1024) + '*/')), PLUGIN.codeTooLarge(2), 'code over 2 MB')

  const image = (name: string, data: Buffer | null): Map<string, Buffer> => {
    const f = pluginFile()
    if (data === null) f.delete(name)
    else f.set(name, data)
    return f
  }
  rejected(inspect(image('icon.png', null)), PLUGIN.isMissing.image('icon.png'), 'missing icon')
  rejected(inspect(image('before.png', Buffer.from('<html>not a PNG</html>'))), PLUGIN.fakeImage('before.png'), 'preview that is not an image')
  rejected(inspect(image('after.png', Buffer.concat([png(), Buffer.alloc(4 * 1024 * 1024)]))), PLUGIN.imageTooLarge('after.png', 4), 'preview over 4 MB')
  const oversized = png()
  oversized.writeUInt32BE(100000, 16)
  oversized.writeUInt32BE(100000, 20)
  rejected(inspect(image('icon.png', oversized)), PLUGIN.oversizedImage('icon.png', 4096), 'PNG that declares 100,000 × 100,000 pixels')

  // Huge folder chosen by mistake: only the plugin files are read.
  const largeFolder = join(job, 'photo-folder')
  mkdirSync(largeFolder)
  for (const [name, data] of pluginFile()) writeFileSync(join(largeFolder, name), data)
  for (let i = 0; i < 400; i++) writeFileSync(join(largeFolder, 'photo-' + i + '.png'), Buffer.alloc(64 * 1024, i % 256))
  writeFileSync(join(largeFolder, 'video.mp4'), Buffer.alloc(8 * 1024 * 1024, 1))
  const readCount = await readPluginFolder(largeFolder)
  check(readCount.size === 5 && inspect(readCount).ok, 'folder with 400 images and a video: only the 5 plugin files read (' + readCount.size + ')')
  check(!isSimpleFileName('CON.png') && !isSimpleFileName('aux') && !validId('lpt1') && validId('negative'), 'names reserved by Windows excluded from files and ids')

  /* ================= 3. PLUGIN EXECUTION ================= */
  console.log('--- PLUGIN EXECUTION ---')
  const test = (w = 16, h = 16): ImageData32 => {
    const data = new Float32Array(w * h * 3)
    for (let i = 0; i < data.length; i++) data[i] = (i % 50) / 50
    return { width: w, height: h, channels: 3, data }
  }
  const NEUTRAL = { stretch: { black: 0, midtones: 0.5, white: 1 }, starLightVersion: APP_VERSION }
  const run = (code: string, geometry: 'unchanged' | 'transformed' | 'unknown' = 'unchanged', time = 4000, im = test()): Promise<PluginResponse> =>
    runInSandbox(nodeWorker(code), { image: im, values: {}, context: NEUTRAL }, time, geometry)
  const error = async (code: string, expected: string, what: string, geometry: 'unchanged' | 'transformed' = 'unchanged', time = 4000): Promise<void> => {
    const original = test()
    const copy = original.data.slice()
    const r = await runInSandbox(nodeWorker(code), { image: original, values: {}, context: NEUTRAL }, time, geometry)
    const ok = r.result === 'error' && r.message.includes(expected)
    const intact = original.data.every((v, i) => v === copy[i])
    check(ok && intact, what + (ok ? '' : ' — got: ' + (r.result === 'ok' ? 'ACCEPTED' : r.message)) + (intact ? '' : ' — SOURCE IMAGE TOUCHED'))
  }
  await error(`export function processImage() { throw new Error('intended failure') }`, 'intended failure', 'exception in the plugin: error reported, source image intact')
  // The reasons written by StarLight are marked as such (shown as they are,
  // in any language); the plugin's own errors are not (shown in quotes).
  const ownError = await run(`export function processImage() { throw new Error('the plugin is fine') }`)
  const ownMissing = await run(`export function other(im) { return im }`)
  check(
    ownError.result === 'error' && ownError.own !== true && ownMissing.result === 'error' && ownMissing.own === true,
    'StarLight reasons marked as own, plugin errors not (even when they look like a StarLight reason)'
  )
  await error(`export function processImage(im) { while (true) {} }`, EXECUTION.time(1), 'infinite loop stopped when time runs out', 'unchanged', 1000)
  await error(`export function other(im) { return im }`, EXECUTION.withoutProcess, 'plugin without the process function')
  await error(`export function processImage(im) { return 42 }`, EXECUTION.noImage, 'returns a number instead of an image')
  await error(`export function processImage(im) { return { ...im, width: 0 } }`, EXECUTION.dimensions, 'zero width')
  await error(`export function processImage(im) { return { ...im, width: 3.5 } }`, EXECUTION.dimensions, 'non-integer width')
  await error(`export function processImage(im) { return { ...im, channels: 4, data: new Float32Array(im.width * im.height * 4) } }`, EXECUTION.channels, 'four channels')
  await error(`export function processImage(im) { return { ...im, data: Array.from(im.data) } }`, EXECUTION.dataType, 'data in an Array instead of a Float32Array')
  await error(`export function processImage(im) { return { ...im, width: im.width + 1 } }`, EXECUTION.length, 'dimensions that do not match the data')
  await error(`export function processImage(im) { return { width: 100000, height: 100000, channels: 3, data: new Float32Array(3) } }`, EXECUTION.tooLarge, 'huge image')
  await error(`export function processImage(im) { return { ...im, data: new Float32Array(im.data.length).fill(NaN) } }`, EXECUTION.nonFinite(768, 768), 'all values NaN')
  await error(`export function processImage(im) { const d = new Float32Array(im.data); for (let i = 0; i < 40; i++) d[i * 7] = Infinity; return { ...im, data: d } }`, EXECUTION.nonFinite(40, 768), '40 infinite values out of 768 (beyond the tolerance)')
  const fewItems = await run(`export function processImage(im) { const d = new Float32Array(im.data); d[0] = NaN; d[5] = -Infinity; return { ...im, data: d } }`)
  check(fewItems.result === 'ok' && fewItems.image.data[0] === 0 && fewItems.image.data[5] === 0, 'two isolated non-numeric values zeroed (tolerance ' + toleratedNonFinite(768) + ')')
  await error(`export function processImage(im) { const d = new Float32Array(im.data).map((v) => v * 65535); return { ...im, data: d } }`, EXECUTION.outOfRange(65535 * (49 / 50)).slice(0, 50), 'out-of-range values (unnormalized data, ×65535)')
  const justNow = await run(`export function processImage(im) { const d = new Float32Array(im.data).map((v) => v * 1.5 - 0.1); return { ...im, data: d } }`)
  check(justNow.result === 'ok', 'values slightly outside 0…1 accepted')
  await error(`export function processImage(im) { return { ...im, data: new Float32Array(im.data) } }`, EXECUTION.withoutTransform, '"transformed" without a matrix', 'transformed')
  await error(
    `export function processImage(im) { return { ...im, data: new Float32Array(im.data), transform: [[1, 0, 5000], [0, 1, 0]] } }`,
    EXECUTION.incoherentTransformation,
    '"transformed" with a matrix that moves the pixels outside the image',
    'transformed'
  )
  const rotated = await run(
    `export function processImage(im) { const { width: w, height: h } = im; const d = new Float32Array(im.data.length); for (let c = 0; c < 3; c++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[c*w*h + x*h + (h-1-y)] = im.data[c*w*h + y*w + x]; return { width: h, height: w, channels: 3, data: d, transform: [[0, -1, h - 1], [1, 0, 0]] } }`,
    'transformed',
    4000,
    test(16, 8)
  )
  check(rotated.result === 'ok' && rotated.geometry?.type === 'transformed', 'consistent 90° rotation accepted')
  const shared = await run(`export function processImage(im) { const d = new Float32Array(new SharedArrayBuffer(im.data.length * 4)); d.set(im.data); return { ...im, data: d } }`)
  check(shared.result === 'ok' && shared.image.data.buffer instanceof ArrayBuffer, 'data on shared memory copied before the check')
  check(
    pluginStopped('Test', EXECUTION.time(30)).includes('«Test»') && pluginStoppedAgain('Test', EXECUTION.crashed, 2).includes('2ª sessione'),
    'stopped-plugin messages: name, reason and suggestion to disable it at the second session'
  )

  /* ================= 4. OBJECT CATALOGS ================= */
  console.log('--- OBJECT CATALOGS ---')
  const publishedFolder = 'dist-catalogs'
  if (existsSync(publishedFolder)) {
    for (const f of readdirSync(publishedFolder).filter((x) => x.endsWith('.zip')).sort()) {
      const result = inspectCatalog(fileFromCatalogZip(readFileSync(join(publishedFolder, f))), true)
      check(result.ok, 'published ' + f + ' passes all checks' + (result.ok ? '' : ' — ' + result.errors.join(' ')))
    }
  } else console.log('  --   dist-catalogs/ missing: published catalogs not checked')

  const MANIFEST_CATALOG = {
    format: 2,
    id: 'test-catalog',
    type: 'deep-sky',
    name: 'Test catalog',
    version: '1.0.0',
    group: 'galaxies',
    description: 'Catalog for the test.',
    authors: 'Test',
    reference: 'None',
    source: 'https://example.org',
    license: 'CC0-1.0',
    licenseLink: 'https://creativecommons.org/publicdomain/zero/1.0/',
    objects: 100,
    example: 'PRV 1',
    noteLanguages: ['it'],
    translations: { it: { name: 'Catalogo di prova' } }
  }
  const row = (i: number): string => ['PRV ' + i, 'Alias ' + i, 'galaxy', (i * 3.1) % 360, -60 + (i % 120), '2.5', '1.2', '45', '12.3', '', ''].join('\t')
  const goodRows = (n: number): string[] => Array.from({ length: n }, (_, i) => row(i + 1))
  const catalogFile = (manifest: unknown = MANIFEST_CATALOG, tsv: string | Buffer | null = goodRows(100).join('\n'), license = true): Map<string, Buffer> => {
    const m = new Map<string, Buffer>([['catalog.json', Buffer.from(typeof manifest === 'string' ? manifest : JSON.stringify(manifest))]])
    if (tsv !== null) m.set('objects.tsv', typeof tsv === 'string' ? Buffer.from(tsv) : tsv)
    if (license) m.set('LICENSE.txt', Buffer.from('CC0'))
    return m
  }
  const withManifestShort = (mod: Record<string, unknown>): Map<string, Buffer> => catalogFile({ ...MANIFEST_CATALOG, ...mod })
  check(inspectCatalog(catalogFile()).ok, 'the valid test catalog passes')
  const withoutMan = catalogFile()
  withoutMan.delete('catalog.json')
  rejected(inspectCatalog(withoutMan), T_CATALOG.isMissing.manifest, 'missing manifest')
  rejected(inspectCatalog(catalogFile('{"format": 2,')), T_CATALOG.manifestNotJson, 'manifest with broken JSON')
  const cat = (e: ReturnType<typeof inspectCatalog>): ReturnType<typeof inspectCatalog> => e
  const futureFormat = cat(inspectCatalog(withManifestShort({ format: 3 })))
  rejected(futureFormat, T_CATALOG.futureFormat, 'newer format')
  check(!futureFormat.ok && futureFormat.remedy === REMEDIES.updateStarLight, '… with the remedy "update StarLight"')
  rejected(inspectCatalog(withManifestShort({ format: 'two' })), T_CATALOG.unrecognizedFormat, 'non-numeric format')
  rejected(inspectCatalog(withManifestShort({ type: 'planets' })), T_CATALOG.unknownType('planets'), 'unknown package type')
  rejected(inspectCatalog(withManifestShort({ id: 'aux' })), NAMES.reserved('aux'), 'id reserved by Windows')
  rejected(inspectCatalog(withManifestShort({ id: 'With Spaces' })), T_CATALOG.invalidId, 'invalid id')
  rejected(inspectCatalog(withManifestShort({ license: 'CC-BY-NC-4.0' })), T_CATALOG.nonOpenLicense('CC-BY-NC-4.0'), 'non-commercial license')
  rejected(inspectCatalog(withManifestShort({ group: 'planets' })), T_CATALOG.unknownGroup('planets'), 'unknown group')
  rejected(inspectCatalog(withManifestShort({ group: 'stars' })), T_CATALOG.inconsistentGroup('stars'), 'group inconsistent with the type')
  rejected(inspectCatalog(withManifestShort({ objects: -3 })), T_CATALOG.objectCount, 'negative object count')
  rejected(inspectCatalog(withManifestShort({ objects: 9_000_000 })), T_CATALOG.tooManyObjects(500_000), 'catalog that declares 9 million objects')
  rejected(inspectCatalog(withManifestShort({ name: 'Catalog\u202Eexe' })), NAMES.controlCharacters('name'), 'name with reversal characters')
  rejected(inspectCatalog(withManifestShort({ translations: { it: { name: 'Catalogo\u202Eexe' } } })), NAMES.controlCharacters('translations.it.name'), 'translated name with reversal characters')
  rejected(inspectCatalog(withManifestShort({ translations: ['it'] })), T_CATALOG.invalidTranslations, 'translations that are not an object')
  rejected(inspectCatalog(withManifestShort({ translations: { 'it IT': { name: 'x' } } })), T_CATALOG.invalidTranslations, 'translation with an invalid language code')
  rejected(inspectCatalog(withManifestShort({ noteLanguages: ['it', 'it'] })), T_CATALOG.invalidNoteLanguages(20), 'note languages repeated')
  rejected(inspectCatalog(withManifestShort({ noteLanguages: ['en'] })), T_CATALOG.invalidNoteLanguages(20), 'English among the note languages (it is the main column)')
  rejected(inspectCatalog(catalogFile(MANIFEST_CATALOG, null)), T_CATALOG.isMissing.objects, 'missing objects.tsv')
  rejected(inspectCatalog(catalogFile(MANIFEST_CATALOG, goodRows(100).join('\n'), false)), T_CATALOG.isMissing.license, 'missing data license')
  const withLines = (wrongItems: string[], goodOnes = 100 - wrongItems.length): ReturnType<typeof inspectCatalog> =>
    inspectCatalog(catalogFile(MANIFEST_CATALOG, [...goodRows(goodOnes), ...wrongItems].join('\n')))
  const R = T_CATALOG.row
  const many = (f: (i: number) => string): string[] => Array.from({ length: 20 }, (_, i) => f(i))
  rejected(withLines(many((i) => ['X ' + i, '', 'g', '400', '10'].join('\t'))), R.coordinates, '20 rows out of 100 with an RA of 400 degrees')
  rejected(withLines(many((i) => ['X ' + i, '', 'g', '10', '-95'].join('\t'))), R.coordinates, '20 rows with a Dec beyond the pole')
  rejected(withLines(many((i) => ['X ' + i, '', 'g', '10', '10', '-5'].join('\t'))), R.dimensions, '20 rows with negative dimensions')
  rejected(withLines(many((i) => ['X ' + i, '', 'g', '10', '10', '99999'].join('\t'))), R.dimensions, '20 rows with dimensions of 1600 degrees')
  rejected(withLines(many((i) => ['X ' + i, '', 'g', '10', '10', '', '', '', '120'].join('\t'))), R.magnitude, '20 rows with magnitude 120')
  rejected(withLines(many((i) => ['X ' + i, '', 'g', '10', '10', '', '', '9000'].join('\t'))), R.angle, '20 rows with position angle 9000')
  rejected(withLines(many((i) => ['X ' + i, '', 'g', '10', '10', 'lots'].join('\t'))), R.number, '20 rows with unreadable numbers')
  rejected(withLines(many(() => ['', '', 'g', '10', '10'].join('\t'))), R.code, '20 rows without a designation')
  rejected(withLines(many((i) => 'X ' + i + '\t' + 'a|'.repeat(3000) + '\tg\t10\t10')), R.long, '20 rows of more than 4096 characters')
  rejected(withLines(many((i) => 'arbitrary text row ' + i)), T_CATALOG.malformedRows(20, 100, R.coordinates).slice(0, 40), 'file that is not in the format (free text)')
  const tolerated = withLines(many((i) => ['X ' + i, '', 'g', '400', '10'].join('\t')).slice(0, 3))
  check(tolerated.ok, 'three wrong rows out of a hundred tolerated (below the 5% share)')
  rejected(inspectCatalog(catalogFile(MANIFEST_CATALOG, goodRows(50).join('\n'))), T_CATALOG.differentNumber(50, 100), 'half of the declared objects (truncated file)')
  rejected(inspectCatalog(catalogFile(MANIFEST_CATALOG, goodRows(130).join('\n'))), T_CATALOG.differentNumber(130, 100), 'more objects than declared')
  rejected(inspectCatalog(catalogFile(MANIFEST_CATALOG, '# comments only\n# no objects\n')), T_CATALOG.objectsEmpty, 'no objects')
  rejected(inspectCatalog(catalogFile(MANIFEST_CATALOG, Buffer.concat([Buffer.from(goodRows(100).join('\n')), Buffer.from([0xff, 0xfe])]))), T_CATALOG.objectsNotText, 'objects.tsv that is not UTF-8 text')
  const huge = analyzeCatalogObjects('x'.repeat(OBJECTS_LIMIT_BYTES + 1), MANIFEST_CATALOG)
  check(huge.errors.includes(T_CATALOG.objectsTooBig(48)), 'objects.tsv over 48 MB rejected')
  const zeros = fileFromCatalogZip(createZip([...catalogFile()].map(([name, data]) => ({ name, data }))))
  check(inspectCatalog(zeros).ok, 'valid catalog inside a ZIP archive')
  launch(
    () =>
      fileFromCatalogZip(
        createZip([
          { name: 'a/catalog.json', data: Buffer.from('{}') },
          { name: 'b/catalog.json', data: Buffer.from('{}') }
        ])
      ),
    ZIP.multipleManifests('catalog.json'),
    'two catalogs in the same archive'
  )

  // Protected registration: a catalog with data that breaks construction does not take the others down.
  const goodItems = analyzeCatalogObjects(goodRows(10).join('\n'), MANIFEST_CATALOG).objects
  const failure = [{ ...goodItems[0], id: 'FAULTY 1', aliases: null }] as unknown as typeof goodItems
  const excludedItems = registerProtectedCatalogs([
    { id: 'test-good', objects: goodItems },
    { id: 'test-broken', objects: failure }
  ])
  check(
    excludedItems.length === 1 && excludedItems[0].id === 'test-broken' && searchCatalog('PRV 3') !== null && searchCatalog('M 31') !== null,
    'catalog that breaks construction excluded, the others and the bundled catalog remain'
  )
  removeCatalog('test-good')

  /* ================= 5. STAR PACKAGES ================= */
  console.log('--- STAR PACKAGES ---')
  const STRIPS = 18
  /** A miniature stars.bin file: one star at the center of each cell, given magnitude. */
  const createStars = (mag = 10, options: { outsideCell?: boolean; version?: number; signature?: string; brokenIndex?: boolean } = {}): Buffer => {
    const cellsPerBand = Array.from({ length: STRIPS }, (_, k) => cellsInBand(k, STRIPS))
    const cells = cellsPerBand.reduce((a, b) => a + b, 0)
    const head = Buffer.alloc(20 + (cells + 1) * 4)
    head.write(options.signature ?? 'SLST', 0, 'ascii')
    head.writeUInt16LE(options.version ?? 1, 4)
    head.writeUInt16LE(STRIPS, 6)
    head.writeUInt32LE(cells, 8)
    head.writeFloatLE(2025, 12)
    head.writeUInt32LE(cells, 16)
    const stars = Buffer.alloc(cells * 6)
    let c = 0
    for (let k = 0; k < STRIPS; k++) {
      for (let j = 0; j < cellsPerBand[k]; j++) {
        head.writeUInt32LE(options.brokenIndex && c === 5 ? cells : c, 20 + c * 4)
        const ra = options.outsideCell && c % 3 === 0 ? ((j + 0.5 + cellsPerBand[k] / 2) * 360) / cellsPerBand[k] : ((j + 0.5) * 360) / cellsPerBand[k]
        const a = Math.floor(((ra % 360) / 360) * 16777216)
        stars.writeUIntLE(a, c * 6, 3)
        stars.writeUInt16LE(32768, c * 6 + 3)
        stars[c * 6 + 5] = Math.round((mag + 2) * 16)
        c++
      }
    }
    head.writeUInt32LE(cells, 20 + cells * 4)
    return Buffer.concat([head, stars])
  }
  const goodStars = createStars()
  const count = goodStars.readUInt32LE(8)
  const MANIFEST_STARS = {
    ...MANIFEST_CATALOG,
    id: 'test-stars',
    name: 'Test stars',
    type: 'stars',
    group: 'stars',
    objects: count,
    limitMagnitude: 12
  }
  const starsFile = (data: Buffer | null, man: unknown = MANIFEST_STARS): Map<string, Buffer> => {
    const m = new Map<string, Buffer>([
      ['catalog.json', Buffer.from(JSON.stringify(man))],
      ['LICENSE.txt', Buffer.from('public domain')]
    ])
    if (data) m.set('stars.bin', data)
    return m
  }
  check(inspectCatalog(starsFile(goodStars)).ok, 'valid star package (' + count + ' stars) accepted')
  rejected(inspectCatalog(starsFile(null)), T_CATALOG.isMissing.stars, 'missing stars.bin')
  rejected(inspectCatalog(starsFile(goodStars, { ...MANIFEST_STARS, limitMagnitude: undefined })), T_CATALOG.limitMagnitude, 'missing limit magnitude')
  rejected(inspectCatalog(starsFile(goodStars, { ...MANIFEST_STARS, limitMagnitude: 55 })), T_CATALOG.limitMagnitude, 'impossible limit magnitude (55)')
  rejected(inspectCatalog(starsFile(goodStars, { ...MANIFEST_STARS, objects: count + 7 })), T_CATALOG.starsDifferentCount(count, count + 7), 'star count different from the manifest')
  rejected(inspectCatalog(starsFile(createStars(13.5))), T_CATALOG.fainterStars(13.5, 12), 'stars fainter than the declared limit magnitude')
  const outside = checkStarFile(createStars(10, { outsideCell: true }), count, 12)
  check(outside.some((p) => p.includes('zona di cielo sbagliata')), 'stars recorded in the wrong cell rejected')
  rejected(inspectCatalog(starsFile(createStars(10, { brokenIndex: true }))), STARS.corrupted(t('coreLocalStars.parts.index')), 'cell index not increasing')
  rejected(inspectCatalog(starsFile(goodStars.subarray(0, goodStars.length - 6))), STARS.incomplete, 'truncated star file')
  rejected(inspectCatalog(starsFile(createStars(10, { version: 9 }))), STARS.futureFormat, 'newer star file format')
  rejected(inspectCatalog(starsFile(createStars(10, { signature: 'ABCD' }))), STARS.signature, 'file that is not a star file')

  // Recheck at startup: catalogs installed and then damaged or copied by hand.
  const installedItems = join(job, 'catalogs')
  const install = (name: string, file: Map<string, Buffer>): string => {
    const c = join(installedItems, name)
    mkdirSync(c, { recursive: true })
    for (const [n, d] of file) writeFileSync(join(c, n), d)
    return c
  }
  const cs = install('test-stars', starsFile(goodStars))
  check((await recheckCatalog(cs, 'test-stars')).ok, 'at startup: intact star package loaded')
  truncateSync(join(cs, 'stars.bin'), goodStars.length - 100)
  rejected(await recheckCatalog(cs, 'test-stars'), STARS.incomplete, 'at startup: star file shortened after installation')
  const co = install('wrong-name', catalogFile())
  rejected(await recheckCatalog(co, 'wrong-name'), T_CATALOG.differentFolder('wrong-name', 'test-catalog'), 'at startup: folder not named like the id')
  const cl = install('test-catalog', catalogFile(MANIFEST_CATALOG, goodRows(100).join('\n'), false))
  rejected(await recheckCatalog(cl, 'test-catalog'), T_CATALOG.isMissing.license, 'at startup: license removed by hand')
  writeFileSync(join(cl, 'LICENSE.txt'), 'CC0')
  writeFileSync(join(cl, 'catalog.json'), '{ damaged')
  rejected(await recheckCatalog(cl, 'test-catalog'), T_CATALOG.manifestNotJson, 'at startup: damaged manifest')

  // A star package that breaks during use does not stop plate solving.
  const estimate = { ra: 10, dec: 20, radius: 1, magnitude: 12, scale: 2 }
  let gaiaRequested = false
  const resolved = await solveWithSources([], estimate as never, 1000, 800, {
    locals: async () => {
      throw new Error(STARS.incomplete)
    },
    gaiaInMemory: () => true,
    gaia: async () => {
      gaiaRequested = true
      return []
    },
    internetAllowed: () => true
  })
  check(!resolved.ok && resolved.localReason === 'error' && gaiaRequested, 'unreadable local stars: solving falls back to Gaia without stopping')

  console.log('--- MESSAGES ---')
  const text = installationRejected('plugin', 'Test', [PLUGIN.isMissing.code], REMEDIES.pluginAuthor)
  check(text.includes('«Test»') && text.includes(PLUGIN.isMissing.code) && text.includes(REMEDIES.pluginAuthor), 'installation rejected: name, problem and remedy in the same notice')
  const recap = notLoadedSummary([
    { name: 'A', problem: PLUGIN.isMissing.code },
    { name: 'B', problem: STARS.incomplete }
  ])
  check(recap.startsWith('2 fra plugin e cataloghi') && recap.includes('«A»') && recap.includes('«B»'), 'at startup a single summary notice with the names')

  /* ================= 6. SANDBOX IN ELECTRON ================= */
  console.log('--- SANDBOX IN ELECTRON ---')
  testElectronSandbox()

  rmSync(job, { recursive: true, force: true })
  console.log(problems === 0 ? '\nAll checks passed.' : '\nProblems: ' + problems)
  process.exit(problems === 0 ? 0 : 1)
}

/**
 * Test of the sandbox inside real Electron, with pluginSandbox.ts and the
 * project's resources/sandbox/sandbox.html page: a fake "app" window runs a
 * good plugin, one that exhausts JavaScript memory, and one that fills data
 * memory, and checks that it stays alive. The test files are written and
 * compiled here, in a temporary folder.
 */
function testElectronSandbox(): void {
  const electron = resolve('node_modules/electron/dist/electron.exe')
  const esbuild = resolve('node_modules/@esbuild/win32-x64/esbuild.exe')
  if (!existsSync(electron) || !existsSync(esbuild)) {
    console.log('  --   Electron not found: sandbox test skipped')
    return
  }
  const base = join(job, 'electron')
  const src = join(base, 'src')
  for (const d of ['src', 'main', 'preload', 'page']) mkdirSync(join(base, d), { recursive: true })
  writeFileSync(
    join(src, 'main.ts'),
    `import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { registerPluginSandbox } from '@project/main/pluginSandbox'
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024')
let appWindow: BrowserWindow | null = null
app.whenReady().then(async () => {
  registerPluginSandbox(() => appWindow)
  appWindow = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/app.js'), sandbox: true, contextIsolation: true } })
  appWindow.webContents.on('render-process-gone', () => { console.log('RESULT app-crashed'); app.exit(2) })
  ipcMain.on('line', (_e, r: string) => console.log(r))
  ipcMain.on('done', () => app.exit(0))
  setTimeout(() => { console.log('RESULT timeout'); app.exit(3) }, 240000)
  await appWindow.loadFile(join(__dirname, '../page/app.html'))
})
`
  )
  writeFileSync(
    join(src, 'app.ts'),
    `import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('starlight', {
  openPluginSandbox: (b: number) => ipcRenderer.invoke('sandbox:open', b),
  closePluginSandbox: (id: number) => ipcRenderer.invoke('sandbox:close', id),
  onSandboxCrashed: (f: (c: unknown) => void) => { ipcRenderer.on('sandbox:crashed', (_e, c) => f(c)); return () => undefined },
  line: (r: string) => ipcRenderer.send('line', r),
  done: () => ipcRenderer.send('done')
})
ipcRenderer.on('sandbox:port', (event, data: { id: number }) => {
  const port = event.ports[0]
  if (port) window.postMessage({ type: 'starlight-plugin-sandbox', id: data.id }, '*', [port])
})
`
  )
  writeFileSync(
    join(src, 'page.ts'),
    `import { workerInSandbox } from '@project/renderer/src/plugin/sandbox'
import { composeSource, runInSandbox } from '@project/core/plugin/isolation'
const s = (window as any).starlight
async function execute(code: string): Promise<string> {
  const data = new Float32Array(64 * 64 * 3).fill(0.3)
  const worker = await workerInSandbox(composeSource(code), 'test', data.byteLength)
  if (!worker) return 'no-sandbox'
  const r = await runInSandbox(worker, { image: { width: 64, height: 64, channels: 3, data }, values: {}, context: { stretch: { black: 0, midtones: 0.5, white: 1 }, starLightVersion: '0' } }, 120000)
  return r.result === 'ok' ? 'ok' : r.message
}
async function start(): Promise<void> {
  const good = 'export function processImage(im) { return { ...im, data: new Float32Array(im.data) } }'
  s.line('RESULT good ' + (await execute(good)))
  s.line('RESULT heap ' + (await execute('export function processImage(im) { const a = []; for (;;) a.push(new Array(1e6).fill(Math.random())) }')))
  s.line('RESULT after ' + (await execute(good)))
  s.line('RESULT data ' + (await execute('export function processImage(im) { const a = []; for (let i = 0; i < 200; i++) { const b = new Uint8Array(256 * 1024 * 1024); b.fill(1); a.push(b) } return im }')))
  s.line('RESULT eval ' + (await execute("export function processImage(im) { (0, eval)('1'); return im }")))
  s.line('RESULT app-alive')
  s.done()
}
start().catch((e) => { s.line('RESULT exception ' + e); s.done() })
`
  )
  writeFileSync(
    join(base, 'page', 'app.html'),
    `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; worker-src 'self' blob:"></head><body><script src="page.js"></script></body></html>`
  )
  writeFileSync(join(base, 'package.json'), JSON.stringify({ name: 'sandbox-test', main: 'main/main.js' }))
  const alias = ['--alias:@shared=./src/shared', '--alias:@core=./src/core', '--alias:@project=./src', '--log-level=warning']
  try {
    execFileSync(esbuild, [join(src, 'main.ts'), '--bundle', '--platform=node', '--format=cjs', '--external:electron', ...alias, '--outfile=' + join(base, 'main', 'main.js')])
    execFileSync(esbuild, ['src/preload/sandbox.ts', '--bundle', '--platform=node', '--format=cjs', '--external:electron', ...alias, '--outfile=' + join(base, 'preload', 'sandbox.js')])
    execFileSync(esbuild, [join(src, 'app.ts'), '--bundle', '--platform=node', '--format=cjs', '--external:electron', ...alias, '--outfile=' + join(base, 'preload', 'app.js')])
    execFileSync(esbuild, [join(src, 'page.ts'), '--bundle', '--platform=browser', '--format=iife', ...alias, '--outfile=' + join(base, 'page', 'page.js')])
  } catch (e) {
    check(false, 'compiling the sandbox test: ' + (e instanceof Error ? e.message : String(e)))
    return
  }
  // pluginSandbox.ts looks for the page in ../../resources relative to main/.
  mkdirSync(join(job, 'resources', 'sandbox'), { recursive: true })
  writeFileSync(join(job, 'resources', 'sandbox', 'sandbox.html'), readFileSync('resources/sandbox/sandbox.html'))
  const result = spawnSync(electron, [base], { encoding: 'utf-8', timeout: 300000 })
  const rows = (result.stdout ?? '').split(/\r?\n/).filter((r) => r.startsWith('RESULT '))
  const value = (key: string): string => rows.find((r) => r.startsWith('RESULT ' + key + ' '))?.slice('RESULT '.length + key.length + 1) ?? 'no answer'
  check(value('good').trim() === 'ok', 'Electron: good plugin run in the sandbox (' + value('good').trim() + ')')
  check(value('heap').includes('troppa memoria'), 'Electron: JavaScript memory exhausted, stopped with the right message (' + value('heap').trim() + ')')
  check(value('after').trim() === 'ok', 'Electron: after the crash the sandbox is recreated')
  check(value('data').includes('troppa memoria'), 'Electron: data memory above the monitored limit (' + value('data').trim() + ')')
  check(value('eval').includes('unsafe-eval'), 'Electron: eval forbidden by the sandbox security policy')
  check(rows.includes('RESULT app-alive') && !rows.includes('RESULT app-crashed'), 'Electron: the StarLight window stays alive throughout the test')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
