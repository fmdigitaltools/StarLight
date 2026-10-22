/**
 * Checks the astrometry module on a real telescope file. It verifies
 * three things: that the WCS can be read, that the transformation is
 * invertible (pixel -> sky -> pixel returns to the starting point), and
 * that a catalog object lands where it should.
 *
 * Usage: TEST_SCRIPT=tools/test-wcs.ts node tools/run-test.mjs [file]
 */
import { readFileSync } from 'node:fs'
import { readFitsHeaderOnly } from '../src/core/fits/reader'
import { readWcs, pixelToSky, skyToPixel, normalizedPosition, scaleArcsec } from '../src/core/astrometry/wcs'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('ngc7331-wcs')
const { header } = readFitsHeaderOnly(new Uint8Array(readFileSync(path)))
const wcs = readWcs(header)

console.log('File: ' + path.split(/[\/]/).pop())
// The test file carries the solution: if it cannot be read, that is an error (exit code 1).
if (!wcs) { console.log('No readable WCS.'); process.exit(1) }

const W = wcs.naxis1, H = wcs.naxis2
console.log('Image ' + W + ' x ' + H + ', scale ' + scaleArcsec(wcs).toFixed(3) + ' arcsec/pixel\n')

// --- 1. Invertibility over a grid of points ---
console.log('--- ROUND TRIP pixel -> sky -> pixel ---')
let maxError = 0
for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.5, 0.9]) {
  const x = fx * W, y = fy * H
  const { ra, dec } = pixelToSky(wcs, x, y)
  const p = skyToPixel(wcs, ra, dec)
  if (!p) { console.log('  point lost in projection'); continue }
  const e = Math.hypot(p.x - x, p.y - y)
  if (e > maxError) maxError = e
}
console.log('Maximum round-trip error: ' + maxError.toExponential(2) + ' pixel')
console.log(maxError < 0.01 ? 'RESULT: transformation is invertible.\n' : 'RESULT: NEEDS CHECKING.\n')
// Result for the aggregate runner (npm run test): exit code 1 if anything failed.
if (!(maxError < 0.01)) process.exitCode = 1

// --- 2. The reference point maps back onto itself ---
const refPix = skyToPixel(wcs, wcs.crval[0], wcs.crval[1])
if (!refPix) {
  console.log('CRVAL does not map to a pixel.')
  process.exit(1)
}
console.log('--- REFERENCE CONSISTENCY ---')
console.log('CRVAL -> pixel: [' + refPix.x.toFixed(2) + ', ' + refPix.y.toFixed(2) +
  ']  (declared CRPIX: [' + wcs.crpix[0].toFixed(2) + ', ' + wcs.crpix[1].toFixed(2) + '])\n')

// --- 3. NGC 7331 from the catalog (22h37m04.1s +34d24'57") ---
const raNGC = (22 + 37/60 + 4.1/3600) * 15
const decNGC = 34 + 24/60 + 57/3600
const pos = normalizedPosition(wcs, raNGC, decNGC)
console.log('--- NGC 7331 (catalog) ---')
if (pos) {
  console.log('Position in the image: ' + (pos.x*100).toFixed(1) + '% width, ' +
    (pos.y*100).toFixed(1) + '% height')
  console.log((Math.abs(pos.x-0.5)<0.1 && Math.abs(pos.y-0.5)<0.1)
    ? 'RESULT: lands at the center, as expected.' : 'RESULT: not at the center.')
  if (!(Math.abs(pos.x-0.5)<0.1 && Math.abs(pos.y-0.5)<0.1)) process.exitCode = 1
} else { console.log('Outside the field (unexpected).'); process.exitCode = 1 }
