/**
 * Determines whether an image is still linear, that is as it leaves the
 * sensor, or has already been stretched by the telescope.
 *
 * A linear frame has almost all pixels squeezed toward black, with a very
 * long tail due to the stars: the median stays very close to the minimum
 * and the distance between the high percentiles is huge compared with that
 * between the low percentiles. An already stretched image instead has the
 * levels distributed over a good part of the scale.
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { debayer, toLuminance } from '../src/core/image/debayer'
import { autoStretch, applyStretchValue } from '../src/core/image/stretch'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('m27-stacked')
const readResult = readFits(new Uint8Array(readFileSync(path)))
const image = debayer(readResult.image, readResult.metadata.bayer)
const lum = toLuminance(image)

const sample = Array.from(lum.filter((_, i) => i % 7 === 0)).sort((a, b) => a - b)
const p = (q: number): number => sample[Math.floor(sample.length * q)]

console.log('file: ' + path.split(/[\/]/).pop())
console.log('declared type: ' + readResult.metadata.frameType + ', stacked frames: ' + readResult.metadata.stackCount)
console.log('--- LUMINANCE PERCENTILES ---')
for (const q of [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
  const bars = '#'.repeat(Math.max(1, Math.round(p(q) * 60)))
  console.log('  ' + (q * 100).toFixed(1).padStart(5) + '%  ' + p(q).toFixed(5) + '  ' + bars)
}

const median = p(0.5)
const centralWidth = p(0.75) - p(0.25)
console.log('--- INDICATORS ---')
console.log('median: ' + median.toFixed(5))
console.log('interquartile width: ' + centralWidth.toFixed(5))
console.log('high tail / body ratio: ' + ((p(0.999) - median) / Math.max(1e-6, centralWidth)).toFixed(1))

// A linear image keeps the median below five percent of the scale and
// concentrates the body of the distribution in a very narrow band.
const looksLinear = median < 0.08 && centralWidth < 0.05
console.log('verdict: ' + (looksLinear ? 'STILL LINEAR' : 'ALREADY STRETCHED by the telescope'))

console.log('--- EFFECT OF THE AUTOMATIC STRETCH ---')
const s = autoStretch(image)
console.log('shadows ' + s.shadows.toFixed(5) + ', midtones ' + s.midtones.toFixed(5))
for (const q of [0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
  const after = applyStretchValue(p(q), s)
  console.log(
    '  percentile ' + (q * 100).toFixed(1).padStart(5) + '%: ' +
    p(q).toFixed(4) + ' becomes ' + after.toFixed(4) +
    (after > 0.97 ? '   <-- BURNED' : '')
  )
}
const burnedCount = sample.filter((v) => applyStretchValue(v, s) > 0.97).length
console.log('pixels pushed beyond 97% of the scale: ' + ((burnedCount / sample.length) * 100).toFixed(2) + '%')
