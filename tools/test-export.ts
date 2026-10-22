/**
 * Export chain check: full-resolution corrections, resizing up to 4K and
 * writing in the formats StarLight generates directly (TIFF, BMP, FITS).
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch } from '../src/core/image/stretch'
import { computeImageStats } from '../src/core/image/stats'
import { applyCorrections } from '../src/core/export/processing'
import { resize, proportionalHeight } from '../src/core/export/resize'
import { encodeTiff, encodeBmp, encodeFits } from '../src/core/export/encoding'
import { testFile } from './test-files.mjs'

const source = process.argv[2] ?? testFile('m27-stacked')
const output = join(tmpdir(), 'starlight-export')
mkdirSync(output, { recursive: true })

const readResult = readFits(new Uint8Array(readFileSync(source)))
const image = debayer(readResult.image, readResult.metadata.bayer)
console.log('source: ' + image.width + ' x ' + image.height + ', channels ' + image.channels)

const stretch = autoStretch(image)
const REMOVAL = 0.5
const BACKGROUND = 0.025
// Compensation also applied by the Filters panel.
stretch.shadows = Math.max(0, stretch.shadows - REMOVAL * BACKGROUND)

console.log('--- FULL-RESOLUTION CORRECTIONS ---')
let t0 = performance.now()
const corrected = applyCorrections(image, {
  stretch,
  brightness: 0.02,
  contrast: 0.15,
  saturation: 0.3,
  redGain: 1.05,
  greenGain: 1,
  blueGain: 1.1,
  gamma: 1.1,
  noiseReduction: 0.4,
  sharpness: 0.25,
  backgroundNeutralization: REMOVAL,
  skyBackground: [BACKGROUND, BACKGROUND, BACKGROUND]
})
console.log('time: ' + (performance.now() - t0).toFixed(0) + ' ms')
const correctStats = computeImageStats(corrected)
console.log('median after corrections: ' + correctStats.median.toFixed(4))

console.log('--- RESIZING TO 4K ---')
t0 = performance.now()
const height4k = proportionalHeight(corrected.width, corrected.height, 3840)
const fourK = resize(corrected, 3840, height4k)
console.log(
  'time: ' + (performance.now() - t0).toFixed(0) + ' ms, result ' +
  fourK.width + ' x ' + fourK.height +
  ' (' + (fourK.width / corrected.width).toFixed(2) + ' times)'
)

console.log('--- WRITING THE FORMATS ---')
const tests: [string, ArrayBuffer][] = [
  ['test-4k.tif', encodeTiff(fourK, 16)],
  ['test-original.tif', encodeTiff(corrected, 16)],
  ['test.bmp', encodeBmp(corrected)],
  ['test.fit', encodeFits(corrected, readResult.header.cards as Record<string, string | number | boolean | null>)]
]

for (const [name, data] of tests) {
  const path = join(output, name)
  writeFileSync(path, Buffer.from(data))
  console.log(name + ': ' + (statSync(path).size / 1048576).toFixed(1) + ' MB')
}

console.log('--- RE-READING THE EXPORTED FITS ---')
const reread = readFits(new Uint8Array(readFileSync(join(output, 'test.fit'))))
console.log('size: ' + reread.image.width + ' x ' + reread.image.height + ', channels ' + reread.image.channels)
console.log('object preserved: ' + reread.metadata.object)
console.log('exposure preserved: ' + reread.metadata.exposure + ' s')
console.log('instrument preserved: ' + reread.metadata.instrument)

const rereadStats = computeImageStats(reread.image)
const rejection = Math.abs(rereadStats.median - correctStats.median)
console.log(
  'median: written ' + correctStats.median.toFixed(4) +
  ', re-read ' + rereadStats.median.toFixed(4) +
  ' (difference ' + rejection.toFixed(5) + ', expected below 0.0001 for 16 bit)'
)
console.log(rejection < 0.001 ? 'ROUND TRIP CORRECT' : 'EXCESSIVE DIFFERENCE')
// Result for the aggregate runner (npm run test): exit code 1 if anything failed.
if (rejection >= 0.001) process.exitCode = 1
