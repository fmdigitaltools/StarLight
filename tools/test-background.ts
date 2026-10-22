/**
 * Test of sky background removal.
 *
 * Checks two properties: that moving the slider forward and back returns
 * the image exactly as it was (which does not happen if the black-point
 * compensation is written into the state and truncated at zero), and that
 * the export chain gives the same values as the shader formula, because
 * the saved file must match what is seen.
 *
 * Usage: TEST_SCRIPT=tools/test-background.ts node tools/run-test.mjs [file.fit]
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { computeStats } from '../src/core/image/stats'
import { autoStretch, mtf, type StretchParams } from '../src/core/image/stretch'
import { applyCorrections, type CorrectionParams } from '../src/core/export/processing'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('m27-stacked')
const readResult = readFits(new Uint8Array(readFileSync(path)), path)
const image = debayer(readResult.image, readResult.metadata.bayer)
const n = image.width * image.height

/** Median of each channel, as the viewer and the export compute it. */
const background: [number, number, number] =
  image.channels === 1
    ? (() => {
        const m = computeStats(image.data.subarray(0, n)).median
        return [m, m, m] as [number, number, number]
      })()
    : [
        computeStats(image.data.subarray(0, n)).median,
        computeStats(image.data.subarray(n, 2 * n)).median,
        computeStats(image.data.subarray(2 * n, 3 * n)).median
      ]

const stretch = autoStretch(image)

const parameters = (removal: number, s: StretchParams): CorrectionParams => ({
  stretch: s,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  redGain: 1,
  greenGain: 1,
  blueGain: 1,
  gamma: 1,
  noiseReduction: 0,
  sharpness: 0,
  backgroundNeutralization: removal,
  skyBackground: background
})

console.log('File: ' + path.split(/[\/]/).pop())
console.log(
  'Background per channel: R ' + background[0].toFixed(5) + '  G ' + background[1].toFixed(5) +
    '  B ' + background[2].toFixed(5)
)
console.log('Starting black point: ' + stretch.shadows.toFixed(5) + '\n')
// --- 1. Slider round trip ---
//
// The incremental behavior is reproduced for comparison: the
// compensation was incremental and truncated at zero, so the way
// back did not return to the starting point.
console.log('--- SLIDER ROUND TRIP ---')
const lightBackground = (background[0] + background[1] + background[2]) / 3
const cursorPath = [0, 0.5, 0.75, 1, 0.5, 0]

let oldBlack = stretch.shadows
let previous = 0
console.log('slider'.padStart(8) + 'incremental black'.padStart(18) + 'stateless black'.padStart(18))
for (const value of cursorPath) {
  // Incremental behavior: difference from the previous value,
  // subtracted from the black point and truncated at zero.
  oldBlack = Math.max(0, oldBlack - (value - previous) * lightBackground)
  previous = value
  console.log(
    (Math.round(value * 100) + '%').padStart(8) +
      oldBlack.toFixed(5).padStart(18) +
      // Stateless behavior: the black point in the state is never touched.
      stretch.shadows.toFixed(5).padStart(18)
  )
}
const offset = ((oldBlack - stretch.shadows) / stretch.shadows) * 100
console.log(
  '\nBack at zero, the incremental black point ended at ' + oldBlack.toFixed(5) +
    ' instead of ' + stretch.shadows.toFixed(5) +
    ' (' + (offset > 0 ? '+' : '') + offset.toFixed(1) + '%).'
)

// Test on pixels: the image with the slider at zero must be identical
// before and after being taken to the maximum and back.
const start = applyCorrections(image, parameters(0, stretch))
const atMaximum = applyCorrections(image, parameters(1, stretch))
const returnValue = applyCorrections(image, parameters(0, stretch))

let differentReturn = 0
let differentMax = 0
let maxResidual = 0
for (let i = 0; i < start.data.length; i++) {
  if (start.data[i] !== returnValue.data[i]) differentReturn++
  const d = Math.abs(start.data[i] - atMaximum.data[i])
  if (d > 0) differentMax++
  if (d > maxResidual) maxResidual = d
}
console.log('Pixels that differ between start and return: ' + differentReturn)
console.log(
  'Pixels the slider changes at maximum: ' + differentMax +
    ' (maximum deviation ' + maxResidual.toFixed(4) + ')'
)
console.log(
  differentReturn === 0 && differentMax > 0
    ? 'RESULT: reversible, and the slider has an effect.\n'
    : 'RESULT: TO BE CHECKED.\n'
)
// Result for whoever runs it together with the others (npm run test): exit code 1 if something is wrong.
if (!(differentReturn === 0 && differentMax > 0)) process.exitCode = 1
// --- 2. The viewer and the export must match ---
//
// The shader runs on the graphics card and cannot be executed here, so
// its formula is rewritten line by line and compared with the export
// chain on the same pixels. If the two diverge, the saved file does not
// match what is seen in the viewer.
console.log('--- VIEWER AND EXPORT ---')

function likeTheShader(value: number, channel: number, removal: number): number {
  let color = Math.max(value, 0)
  let shadows = stretch.shadows
  if (removal > 0.001) {
    color -= background[channel] * removal
    shadows -= lightBackground * removal
  }
  const interval = Math.max(1e-6, stretch.highlights - shadows)
  color = Math.min(1, Math.max(0, (color - shadows) / interval))
  return mtf(color, stretch.midtones)
}

console.log('removal'.padStart(10) + 'maximum deviation'.padStart(17) + 'pixels over 1/65535'.padStart(22))
for (const removal of [0, 0.25, 0.5, 1]) {
  const exported = applyCorrections(image, parameters(removal, stretch))
  let max = 0
  let beyond = 0
  // One pixel in fifty, over the three channels: half a million comparisons.
  for (let i = 0; i < n; i += 50) {
    for (let c = 0; c < 3; c++) {
      const expected = likeTheShader(image.data[(image.channels === 3 ? c : 0) * n + i], c, removal)
      const obtained = exported.data[c * n + i]
      const d = Math.abs(expected - obtained)
      if (d > max) max = d
      if (d > 1 / 65535) beyond++
    }
  }
  console.log(
    (Math.round(removal * 100) + '%').padStart(10) +
      max.toExponential(1).padStart(17) +
      String(beyond).padStart(22)
  )
}
console.log(
  '\nA deviation below 1/65535 is invisible even in a 16-bit-per-channel file.'
)
