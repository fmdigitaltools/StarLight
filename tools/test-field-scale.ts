/**
 * Test of the pixel scale and the framed field: when the header carries
 * the astrometric solution the scale must be its own (on drizzle-stacked
 * images it is half of the one computed from focal length and pixel size).
 *
 *   $env:TEST_SCRIPT='tools/test-field-scale.ts'; node tools/run-test.mjs
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { scaleArcsec } from '../src/core/astrometry/wcs'
import { framedField } from '../src/core/catalog/recognition'
import { testFile } from './test-files.mjs'

let errors = 0
for (const name of ['m27', 'ngc7331', 'm27-stacked']) {
  const readResult = readFits(new Uint8Array(readFileSync(testFile(name))), name + '.fit')
  const m = readResult.metadata
  const field = framedField(m, readResult.image.width, readResult.image.height)
  const optics = m.focalLength && m.pixelSize ? (206.265 * m.pixelSize) / m.focalLength : null
  const text =
    name.padEnd(56) +
    'scale ' + (m.pixelScale?.toFixed(3) ?? '-') +
    '  (focal length: ' + (optics?.toFixed(3) ?? '-') + ')' +
    '  field ' + (field ? (field.width * 60).toFixed(1) + "' x " + (field.height * 60).toFixed(1) + "'" : '-')
  let ok = true
  if (m.wcs) {
    // With the solution the scale is the WCS one and the field follows it.
    const actual = scaleArcsec(m.wcs)
    ok = m.pixelScale !== null && Math.abs(m.pixelScale - actual) < 1e-9 && field !== null &&
      Math.abs(field.width * 3600 - actual * readResult.image.width) < 1e-6
    // Stacked with solution: 2160 px at ~1.19″ → about 43 arcminutes.
    if (name !== 'm27-stacked') ok = ok && field !== null && Math.abs(field.width * 60 - 42.8) < 1
  } else {
    // Without a solution the focal-length scale remains.
    ok = optics !== null && m.pixelScale !== null && Math.abs(m.pixelScale - optics) < 1e-9
  }
  if (!ok) errors++
  console.log((ok ? 'ok   ' : 'NO   ') + text)
}
console.log(errors === 0 ? '\nALL OK' : '\nERRORS: ' + errors)
if (errors > 0) process.exitCode = 1
