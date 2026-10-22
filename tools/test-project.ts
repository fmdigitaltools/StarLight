/**
 * Project test: round trip of the state into the `project.slight` file,
 * tolerance of old or damaged files, name sanitizing and a 32-bit FITS image
 * reread identically.
 *
 * Usage: TEST_SCRIPT=tools/test-project.ts node tools/run-test.mjs
 * (with other tests running, compile to a separate output file).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  serializeProject,
  readProject,
  cleanName,
  joinPath,
  folderOf,
  nameOf,
  ProjectError,
  FORMAT_VERSION,
  type ProjectState
} from '../src/core/project'
import { readRecipe, defaultRecipe, serializeRecipe } from '../src/core/recipe'
import { encodeFits } from '../src/core/export/encoding'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { NEUTRAL_PROCESSING, ABRACADABRA_PROCESSING } from '../src/core/image/chain'
import { NEUTRAL_CURVES } from '../src/core/image/curve'
import { NEUTRAL_GHS } from '../src/core/image/ghs'
import { testFile } from './test-files.mjs'

let problems = 0

/** Comparison that does not depend on field order. */
function equal(a: unknown, b: unknown): boolean {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b))
}
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  OK   ' : '  ERROR ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) problems++
}

// Adjustments as in the interface store (copied here so as not to
// pull React into the test).
const ADJUSTMENTS = {
  stretch: { shadows: 0, midtones: 0.5, highlights: 1 },
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  redGain: 1,
  greenGain: 1,
  blueGain: 1,
  gamma: 1,
  noiseReduction: 0,
  sharpness: 0,
  backgroundNeutralization: 0,
  vignette: 0,
  preserveColor: false,
  withGhs: false,
  ghs: NEUTRAL_GHS,
  showStars: false,
  filter: 'none',
  filterIntensity: 0.75
}

console.log('--- STATE ROUND TRIP ---')
const state: ProjectState<typeof ADJUSTMENTS> = {
  name: 'M42 Orion',
  frame: [
    { path: 'E:\\Photos\\M42\\light_001.fit', excluded: false, statistics: null, quality: 71 },
    {
      path: 'E:\\Photos\\M42\\light_002.fit',
      excluded: true,
      statistics: { min: 0, max: 1, mean: 0.1, median: 0.08, stdDev: 0.02, mad: 0.01, saturatedPct: 0.3 },
      quality: null
    }
  ],
  activeFrame: 'E:\\Photos\\M42\\light_001.fit',
  image: 'image.fit',
  originalImage: 'original.fit',
  result: {
    type: 'mosaic',
    width: 5000,
    height: 4200,
    pixelScale: 1.19,
    wcs: null,
    ra: 300.1,
    dec: 22.7,
    panels: ['E:\\Photos\\M42\\light_001.fit', 'E:\\Photos\\M42\\light_002.fit']
  },
  adjustments: {
    ...ADJUSTMENTS,
    stretch: { shadows: 0.031, midtones: 0.5, highlights: 0.87 },
    withGhs: true,
    ghs: { ...NEUTRAL_GHS, strength: 3.2, symmetryPoint: 0.12 },
    preserveColor: true,
    saturation: 0.22,
    vibrance: 0.3,
    vignette: 0.15,
    backgroundNeutralization: 0.6,
    filter: 'teal-orange',
    filterIntensity: 0.4
  },
  // Without local levels the project rereads them as an empty list.
  localAdjustments: [],
  curves: { ...NEUTRAL_CURVES, light: [{ x: 0, y: 0 }, { x: 0.3, y: 0.42 }, { x: 1, y: 1 }] },
  processing: { ...ABRACADABRA_PROCESSING, photometricGains: [1.1, 1, 0.92] },
  appliedProcessing: ABRACADABRA_PROCESSING,
  crop: { x: 0.02, y: 0.03, width: 0.95, height: 0.9 },
  aspectRatio: '3:2',
  preset: 'instagram',
  objects: [],
  withCalibration: false,
  step: 'correct'
}
const text = serializeProject(state, '0.3.5', new Date('2026-10-17T10:00:00Z'))
const reread = readProject(text, ADJUSTMENTS)
result('the reread state matches the saved one', equal(reread, state))
result('the file declares the format version', JSON.parse(text).version === FORMAT_VERSION)
result('GHS and preserve color come back', reread.adjustments.withGhs && reread.adjustments.preserveColor)
result('photometric gains come back', JSON.stringify(reread.processing.photometricGains) === '[1.1,1,0.92]')

console.log('--- INCOMPLETE, OLD OR WRONG FILES ---')
// A file written before some fields existed.
const old = JSON.parse(text)
delete old.adjustments.ghs
delete old.adjustments.withGhs
delete old.processing.deconvolution
delete old.curves
delete old.result
old.adjustments.unknownField = 5
old.adjustments.saturation = 'tanta'
old.step = 'correct'
const fromOld = readProject(JSON.stringify(old), ADJUSTMENTS)
result('missing fields take the neutral value', JSON.stringify(fromOld.adjustments.ghs) === JSON.stringify(NEUTRAL_GHS) && fromOld.adjustments.withGhs === false)
result('missing Process tools are neutral', JSON.stringify(fromOld.processing.deconvolution) === JSON.stringify(NEUTRAL_PROCESSING.deconvolution))
result('without result geometry (old project): none', fromOld.result === null)
result('missing curves are neutral', JSON.stringify(fromOld.curves) === JSON.stringify(NEUTRAL_CURVES))
result('a value of the wrong type is discarded', fromOld.adjustments.saturation === 0)
result('unknown fields are ignored', !('unknownField' in fromOld.adjustments))
result('the rest stays as saved', fromOld.adjustments.preserveColor === true && fromOld.step === 'correct')

// Project saved before manual vibrance and vignette existed.
const preRenameJson = JSON.parse(text)
delete preRenameJson.adjustments.vibrance
delete preRenameJson.adjustments.vignette
const preRenameProject = readProject(JSON.stringify(preRenameJson), ADJUSTMENTS)
result('without vibrance and vignette: neutral values', preRenameProject.adjustments.vibrance === 0 && preRenameProject.adjustments.vignette === 0)

// Batch processing recipes have the same issue.
const oldRecipe = JSON.parse(serializeRecipe({ ...defaultRecipe(ADJUSTMENTS), name: 'Test' }, '0.4.2'))
delete oldRecipe.adjustments.vibrance
delete oldRecipe.adjustments.vignette
const fromRecipe = readRecipe(JSON.stringify(oldRecipe), ADJUSTMENTS)
result('old recipe: vibrance and vignette neutral', fromRecipe.adjustments.vibrance === 0 && fromRecipe.adjustments.vignette === 0)

function reject(name: string, t: string): void {
  try {
    readProject(t, ADJUSTMENTS)
    result(name, false, 'accepted')
  } catch (e) {
    result(name, e instanceof ProjectError, e instanceof Error ? e.message : String(e))
  }
}
reject('damaged text', text.slice(0, 200))
reject('JSON that is not a project', '{"hello": 1}')
reject('newer version', JSON.stringify({ ...JSON.parse(text), version: FORMAT_VERSION + 1 }))

console.log('--- NAMES AND PATHS ---')
const cases: [string, string][] = [
  ['M42 Orion', 'M42 Orion'],
  ['M31: Andromeda / test?', 'M31 Andromeda test'],
  ['  night*of<17>  ', 'night of 17'],
  ['final...', 'final'],
  ['CON', 'CON (progetto)'],
  ['\\/:*?', '']
]
for (const [inside, expected] of cases) {
  const v = cleanName(inside)
  result('«' + inside + '»', v === expected, '«' + v + '»')
}
result('join on Windows', joinPath('C:\\Utenti\\Anna\\Documenti', 'M42') === 'C:\\Utenti\\Anna\\Documenti\\M42')
result('join with trailing slash', joinPath('D:/Photos/', 'M42') === 'D:/Photos/M42')
result('folder and name', folderOf('C:\\P\\M42\\project.slight') === 'C:\\P\\M42' && nameOf('C:\\P\\M42') === 'M42')

console.log('--- 32-BIT FITS IMAGE ---')
const dir = testFile('stacks')
const fit = readdirSync(dir).find((n) => n.toLowerCase().endsWith('.fit'))
if (!fit) {
  result('sample images', false, 'no .fit found')
} else {
  const r = readFits(new Uint8Array(readFileSync(join(dir, fit))), fit)
  const img = debayer(r.image, r.metadata.bayer)
  // Values that cannot be rounded to 16 bits, to detect a loss.
  img.data[0] = 0.123456789
  const t0 = performance.now()
  const data = encodeFits(img, r.header.cards as Record<string, string | number | boolean | null>, 32)
  const time = performance.now() - t0
  const di = readFits(new Uint8Array(data))
  let rejection = 0
  for (let i = 0; i < img.data.length; i++) rejection = Math.max(rejection, Math.abs(di.image.data[i] - img.data[i]))
  result(fit + ' reread identically', rejection === 0 && di.bitpix === -32 && di.image.channels === img.channels, 'deviation ' + rejection + ', ' + img.width + 'x' + img.height + 'x' + img.channels + ', ' + (data.byteLength / 1048576).toFixed(1) + ' MB in ' + time.toFixed(0) + ' ms')
  result('capture data preserved', di.metadata.object === r.metadata.object, String(di.metadata.object))
  if (r.metadata.wcs !== null) {
    const withWcs = readFits(new Uint8Array(encodeFits(img, {}, 32, { wcs: r.metadata.wcs })))
    result('astrometric solution in the 32-bit FITS', withWcs.metadata.wcs !== null && withWcs.metadata.wcs.crpix[0] === r.metadata.wcs.crpix[0] && withWcs.metadata.wcs.a.size === r.metadata.wcs.a.size)
  }
  const a16 = readFits(new Uint8Array(encodeFits(img, {}))).image.data[0]
  result('the 16-bit FITS stays as it was', di.bitpix === -32 && Math.abs(a16 - 0.123456789) > 1e-7 && Math.abs(a16 - 0.123456789) < 1e-5)
}

console.log(problems === 0 ? '\nAll checks passed.' : '\n' + problems + ' problems.')
process.exit(problems === 0 ? 0 : 1)
