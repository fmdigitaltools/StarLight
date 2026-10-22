/**
 * Test of saving in the project the astrometric solution found by "Solve
 * the field": identical round trip (also with the distortion
 * coefficients), old projects without the field, damaged data discarded.
 *
 *   $env:TEST_SCRIPT='tools/test-project-solution.ts'; node tools/run-test.mjs
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { pixelToSky } from '../src/core/astrometry/wcs'
import {
  readProject,
  serializeProject,
  wcsFromProject,
  wcsToSave,
  type ProjectState
} from '../src/core/project'
import { NEUTRAL_PROCESSING } from '../src/core/image/chain'
import { NEUTRAL_CURVES } from '../src/core/image/curve'
import { FULL_CROP } from '../src/core/export/crop'
import { testFile } from './test-files.mjs'

let errors = 0
function result(name: string, ok: boolean): void {
  console.log((ok ? 'ok   ' : 'NO   ') + name)
  if (!ok) errors++
}

// A real solution, with SIP distortion, taken from a sample file.
const readResult = readFits(new Uint8Array(readFileSync(testFile('m27'))), 'M_27.fit')
const wcs = readResult.metadata.wcs
if (!wcs) throw new Error('M_27.fit should have the solution in the header')
console.log('SIP coefficients: A ' + wcs.a.size + ', B ' + wcs.b.size + ', AP ' + wcs.ap.size + ', BP ' + wcs.bp.size)

const ADJUSTMENTS = { brightness: 0 }
const base: ProjectState<typeof ADJUSTMENTS> = {
  name: 'Test',
  frame: [
    { path: 'E:\\Foto\\a.fit', excluded: false, statistics: null, quality: null, solution: wcsToSave(wcs) },
    { path: 'E:\\Foto\\b.fit', excluded: false, statistics: null, quality: null }
  ],
  activeFrame: 'E:\\Foto\\a.fit',
  image: null,
  originalImage: null,
  result: null,
  adjustments: ADJUSTMENTS,
  curves: NEUTRAL_CURVES,
  processing: NEUTRAL_PROCESSING,
  appliedProcessing: null,
  crop: FULL_CROP,
  aspectRatio: 'original',
  preset: null,
  objects: [],
  withCalibration: true,
  step: 'objects'
}
const reread = readProject(serializeProject(base, '0.0.0'), ADJUSTMENTS)
const shot = wcsFromProject(reread.frame[0].solution)
result('the solution comes back from the file', shot !== null)
if (shot) {
  let rejection = 0
  for (const [x, y] of [[0, 0], [1080, 1920], [2159, 3839], [300, 3500]]) {
    const p = pixelToSky(wcs, x, y)
    const q = pixelToSky(shot, x, y)
    rejection = Math.max(rejection, Math.abs(p.ra - q.ra) * 3600, Math.abs(p.dec - q.dec) * 3600)
  }
  result('same coordinates at every point (deviation ' + rejection.toExponential(1) + '″)', rejection < 1e-9)
  result('distortion coefficients preserved', shot.a.size === wcs.a.size && shot.bp.size === wcs.bp.size)
}
result('a frame without a solution stays without one', wcsFromProject(reread.frame[1].solution) === null)

// Project saved by an earlier version: the field is not there.
const old = JSON.parse(serializeProject({ ...base, frame: [base.frame[1]] }, '0.3.5'))
const rereadOld = readProject(JSON.stringify(old), ADJUSTMENTS)
result('an old project opens, without a solution', rereadOld.frame.length === 1 && wcsFromProject(rereadOld.frame[0].solution) === null)

// Damaged data: discarded, not a wrong solution.
const savedSolution = wcsToSave(wcs)
result('discarded with a missing number', wcsFromProject({ ...savedSolution, crval: [1] }) === null)
result('discarded with text in place of a number', wcsFromProject({ ...savedSolution, cd: [['x', 0], [0, 1]] }) === null)
result('discarded with a damaged distortion', wcsFromProject({ ...savedSolution, a: [['A_2_0', 'x']] }) === null)
result('discarded if it is not an object', wcsFromProject('hello') === null)

console.log(errors === 0 ? '\nALL OK' : '\nERRORS: ' + errors)
if (errors > 0) process.exitCode = 1
