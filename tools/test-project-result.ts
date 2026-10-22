/**
 * Test: mosaic and drizzle saved in the project and reopened.
 *
 * Drizzle and mosaic go into the viewer with their own scale and
 * astrometric solution, different from those of the frame's file (see
 * `temporaryResult`). Using synthetic results and the real header of the
 * M 27 sample file, this checks the complete round trip: displayed result
 * -> project state -> text -> reread state -> frame reopened from the file
 * -> result metadata put back in place; and that opening another image
 * afterwards brings back the file's metadata.
 * Also covers old projects (without the field) and damaged data.
 *
 * Usage (with its own output file, see tools/run-test.mjs):
 *   esbuild tools/test-project-result.ts --bundle --platform=node --format=esm
 *     --alias:@shared=./src/shared --alias:@core=./src/core --outfile=<yours>.mjs
 *   node <yours>.mjs
 */
import { readFileSync } from 'node:fs'
import { readFitsHeaderOnly } from '../src/core/fits/reader'
import { readWcs, wcsScale, scaleArcsec, buildWcs, skyToPixel, pixelToSky } from '../src/core/astrometry/wcs'
import {
  serializeProject,
  readProject,
  readResult,
  resultToSave,
  resultFromProject,
  wcsToSave,
  type ProjectState
} from '../src/core/project'
import { NEUTRAL_PROCESSING } from '../src/core/image/chain'
import { NEUTRAL_CURVES } from '../src/core/image/curve'
import { FULL_CROP } from '../src/core/export/crop'
import { useApp } from '../src/renderer/src/store/appStore'
import {
  originalFrame,
  showStacked,
  showResult,
  restoreResult,
  shownResult
} from '../src/renderer/src/hooks/temporaryResult'
import type { ImageData32, LoadedFrame, Wcs } from '../src/shared/types'
import { testFile } from './test-files.mjs'

let problems = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  OK   ' : '  ERROR ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) problems++
}

/**
 * The two solutions give the same sky for the same pixels and the same
 * pixels for the same sky (forward and inverse distortion).
 */
function sameSolution(a: Wcs | null, b: Wcs | null): boolean {
  if (a === null || b === null) return a === b
  if (a.naxis1 !== b.naxis1 || a.naxis2 !== b.naxis2) return false
  for (const [x, y] of [[1, 1], [a.naxis1, 1], [1, a.naxis2], [a.naxis1, a.naxis2], [a.naxis1 / 2, a.naxis2 / 3]]) {
    const ca = pixelToSky(a, x, y)
    const cb = pixelToSky(b, x, y)
    if (Math.hypot(ca.ra - cb.ra, ca.dec - cb.dec) * 3600 > 1e-6) return false
    const pa = skyToPixel(a, ca.ra, ca.dec)
    const pb = skyToPixel(b, ca.ra, ca.dec)
    if (pa === null || pb === null || Math.hypot(pa.x - pb.x, pa.y - pb.y) > 1e-6) return false
  }
  return true
}

// Three frames "read from the file": the real header of the M 27 sample file, fake paths.
const head = new Uint8Array(readFileSync(testFile('m27')).subarray(0, 64800))
function frameFromFile(id: string, path: string): LoadedFrame {
  const h = readFitsHeaderOnly(head, 'M_27.fit')
  return {
    id,
    path: path,
    fileName: path.split('\\').pop() ?? path,
    sizeBytes: 1,
    width: h.width,
    height: h.height,
    channels: 3,
    bitpix: h.bitpix,
    metadata: h.metadata,
    header: h.header,
    stats: { min: 0, max: 1, mean: 0.1, median: 0.1, stdDev: 0.01, mad: 0.01, saturatedPct: 0 },
    quality: 50,
    excluded: false
  }
}
const PATHS = ['E:\\Foto\\M27\\panel_1.fit', 'E:\\Foto\\M27\\panel_2.fit', 'E:\\Foto\\M27\\panel_3.fit']
const library = (): LoadedFrame[] => PATHS.map((p, i) => frameFromFile('f' + (i + 1), p))

const ofFile = library()[0]
const wcsFile = ofFile.metadata.wcs
if (wcsFile === null) {
  console.log('M_27.fit has no astrometric solution: test impossible.')
  process.exit(1)
}
console.log('frame: ' + ofFile.width + ' x ' + ofFile.height + ', ' + scaleArcsec(wcsFile).toFixed(3) + '″/px')

const emptyImage = (w: number, h: number): ImageData32 => ({ width: w, height: h, channels: 3, data: new Float32Array(w * h * 3) })

const REG = { a: 1 }
function testState(): ProjectState<typeof REG> {
  const s = useApp.getState()
  const r = shownResult()
  return {
    name: 'Test',
    frame: s.frame.map(originalFrame).map((f) => ({
      path: f.path,
      excluded: f.excluded,
      statistics: null,
      quality: f.quality,
      solution: f.metadata.wcs !== null && readWcs(f.header) === null ? wcsToSave(f.metadata.wcs) : null
    })),
    activeFrame: s.frame.find((f) => f.id === s.activeFrameId)?.path ?? null,
    image: 'image.fit',
    originalImage: null,
    result: r !== null ? resultToSave(r) : null,
    adjustments: REG,
    curves: NEUTRAL_CURVES,
    processing: NEUTRAL_PROCESSING,
    appliedProcessing: null,
    crop: FULL_CROP,
    aspectRatio: 'original',
    preset: null,
    objects: [],
    withCalibration: true,
    step: 'process'
  }
}

/**
 * Reopens the project as `openFromPath` does: frames reread from the file,
 * saved image in the viewer, then the result metadata.
 */
function reopen(text: string, image: ImageData32): { ok: boolean; active: LoadedFrame | undefined } {
  const state = readProject(text, REG)
  const frame = library()
  const active = frame.find((f) => f.path === state.activeFrame)
  useApp.setState({ frame, activeFrameId: active?.id ?? null, image, originalImage: image, objects: [] })
  let ok = false
  if (state.result !== null && active) ok = restoreResult(active.id, image, resultFromProject(state.result))
  return { ok, active: useApp.getState().frame.find((f) => f.id === active?.id) }
}

/* ---- Mosaico ---- */
console.log('--- MOSAIC ---')
useApp.setState({ frame: library(), activeFrameId: null, image: null, originalImage: null })
// A mosaic of three panels: wider field, shifted center, with a small
// residual distortion to check that the SIP comes back.
const wcsMosaic = buildWcs({
  crval: [wcsFile.crval[0] + 0.4, wcsFile.crval[1] - 0.1],
  crpix: [2500.5, 2100.5],
  cd: wcsFile.cd,
  naxis1: 5000,
  naxis2: 4200,
  a: new Map([['2_0', 1.3e-7], ['0_2', -2.1e-7]]),
  b: new Map([['1_1', 8.9e-8]]),
  ap: new Map([['2_0', -1.3e-7]]),
  bp: new Map([['1_1', -8.9e-8]])
}) as Wcs
const mosaic = emptyImage(5000, 4200)
showResult('f2', mosaic, () => ({
  wcs: wcsMosaic,
  pixelScale: scaleArcsec(wcsMosaic),
  others: { ra: wcsMosaic.crval[0], dec: wcsMosaic.crval[1] },
  type: 'mosaic',
  panels: PATHS
}))
const shown = shownResult()
result('the displayed result is a mosaic', shown?.type === 'mosaic' && shown.width === 5000 && shown.panels.length === 3)

const mosaicText = serializeProject(testState(), '0.4.0')
const saved = JSON.parse(mosaicText)
result('the saved frame has the file data, not the mosaic’s', saved.frame[1].solution === null)
result('the file contains type, dimensions, scale and panels', saved.result?.type === 'mosaic' && saved.result.height === 4200 && saved.result.panels[2] === PATHS[2] && saved.result.wcs.a.length === 2)

// Close everything and reopen.
useApp.setState({ frame: [], activeFrameId: null, image: null, originalImage: null })
const reopened = emptyImage(5000, 4200)
const rm = reopen(mosaicText, reopened)
result('restore succeeded', rm.ok)
result('mosaic solution (SIP included)', sameSolution(rm.active?.metadata.wcs ?? null, wcsMosaic))
result('mosaic scale', Math.abs((rm.active?.metadata.pixelScale ?? 0) - scaleArcsec(wcsMosaic)) < 1e-9)
result('center of the mosaic field', rm.active?.metadata.ra === wcsMosaic.crval[0] && rm.active?.metadata.dec === wcsMosaic.crval[1])
result('frame dimensions = mosaic', rm.active?.width === 5000 && rm.active?.height === 4200)
result('header with the mosaic solution', sameSolution(rm.active ? readWcs(rm.active.header) : null, wcsMosaic))
result('panels and type known again', shownResult()?.type === 'mosaic' && shownResult()?.panels.join() === PATHS.join())
result('originalFrame still gives the file', sameSolution(rm.active ? originalFrame(rm.active).metadata.wcs : null, wcsFile))
// Saving again right away, the project stays the same.
result('saved again, the result is the same', JSON.stringify(testState().result) === JSON.stringify(saved.result))

// Opening another frame brings back the file's data.
useApp.getState().setActiveFrame('f1', emptyImage(10, 10))
const after = useApp.getState().frame.find((f) => f.id === 'f2')
result('opening another frame brings back the file scale and solution', sameSolution(after?.metadata.wcs ?? null, wcsFile) && after?.width === ofFile.width)
result('and the project no longer sees a result', shownResult() === null)

/* ---- Drizzle ---- */
console.log('--- DRIZZLE ---')
useApp.setState({ frame: library(), activeFrameId: null, image: null, originalImage: null })
const factor = 2
const wcsDrizzle = wcsScale(wcsFile, factor)
showResult('f1', emptyImage(ofFile.width * factor, ofFile.height * factor), (m) => ({
  wcs: m.wcs !== null ? wcsScale(m.wcs, factor) : null,
  pixelScale: m.pixelScale !== null ? m.pixelScale / factor : null,
  type: 'drizzle'
}))
const drizzleText = serializeProject(testState(), '0.4.0')
result('the type in the file is drizzle', JSON.parse(drizzleText).result?.type === 'drizzle')
const rd = reopen(drizzleText, emptyImage(ofFile.width * factor, ofFile.height * factor))
result('restore succeeded', rd.ok)
result('scaled solution (SIP included)', sameSolution(rd.active?.metadata.wcs ?? null, wcsDrizzle))
result('halved scale', Math.abs((rd.active?.metadata.pixelScale ?? 0) - (ofFile.metadata.pixelScale ?? 0) / factor) < 1e-9, String(rd.active?.metadata.pixelScale?.toFixed(4)))
result('doubled dimensions', rd.active?.width === ofFile.width * factor)

// The reopened image does not have the saved dimensions: the file's data is better.
const wrongValue = reopen(drizzleText, emptyImage(ofFile.width, ofFile.height))
result('different dimensions: no restore', !wrongValue.ok && sameSolution(wrongValue.active?.metadata.wcs ?? null, wcsFile))

/* ---- Impilamento normale ---- */
console.log('--- NORMAL STACKING ---')
useApp.setState({ frame: library(), activeFrameId: null, image: null, originalImage: null })
showStacked('f3', emptyImage(ofFile.width, ofFile.height))
const ti = serializeProject(testState(), '0.4.0')
result('the type in the file is stacked', JSON.parse(ti).result?.type === 'stacked')
const ri = reopen(ti, emptyImage(ofFile.width, ofFile.height))
result('reopened: stays stacked, with the file data', ri.ok && shownResult()?.type === 'stacked' && sameSolution(ri.active?.metadata.wcs ?? null, wcsFile))

/* ---- Old projects and damaged data ---- */
console.log('--- OLD PROJECTS AND DAMAGED DATA ---')
const old = JSON.parse(mosaicText)
delete old.result
result('project without the field: no result', readProject(JSON.stringify(old), REG).result === null)
const rv = reopen(JSON.stringify(old), emptyImage(5000, 4200))
result('and on reopening the file data remain', !rv.ok && sameSolution(rv.active?.metadata.wcs ?? null, wcsFile))
result('unknown type discarded', readResult({ ...saved.result, type: 'collage' }) === null)
result('damaged dimensions discarded', readResult({ ...saved.result, width: -3 }) === null)
const wcsBroken = readResult({ ...saved.result, wcs: { crval: [1] } })
result('damaged solution: the scale stays, the solution does not', wcsBroken !== null && resultFromProject(wcsBroken).wcs === null && wcsBroken.pixelScale !== null)
const withoutPanels = readResult({ ...saved.result, panels: ['a', 3, '', null] })
result('damaged panels cleaned up', withoutPanels?.panels.join() === 'a')

console.log(problems === 0 ? '\nAll checks passed.' : '\n' + problems + ' problems.')
process.exit(problems === 0 ? 0 : 1)
