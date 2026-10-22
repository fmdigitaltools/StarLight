/**
 * Check: plugins that move pixels carry the astrometric solution with
 * them.
 *
 * - a plugin that moves pixels (the "Rotate and mirror" test one, in
 *   tools/test-plugin-geometry: not bundled with the app) returns a
 *   matrix that describes exactly where each pixel ends up;
 * - the transformed solution (`transformWcs`) places M 27, on the real
 *   telescope file, in the same pixel where the plugin moved M 27;
 * - the transformation is exact even with SIP distortion and for any
 *   affine transformation (non-right-angle rotation plus scale);
 * - the markers (normalized positions) coincide with those computed from
 *   the transformed solution;
 * - an exported FITS is re-read with the right solution;
 * - the geometry is saved and re-read in the project;
 * - a plugin that moves pixels without saying so makes the geometry unknown;
 * - the toolbar Mirror buttons: lossless mirror, round trip, canonical
 *   order (mirror, quarter turns, free rotation) equal to the mirror done
 *   last, astrometric solution with inverted parity (M 27 stays where it
 *   is in the sky), markers, masks, crop, saved and reopened project,
 *   projects with the old plugin.
 *
 * Usage: TEST_SCRIPT=tools/test-geometry.ts node tools/run-test.mjs
 * (or compiling with esbuild to a dedicated output file).
 */
import { readFileSync } from 'node:fs'
import type { ImageData32, Wcs } from '../src/shared/types'
import { APP_VERSION } from '../src/shared/version'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { skyToPixel, buildWcs, pixelToSky, normalizedPosition, transformWcs } from '../src/core/astrometry/wcs'
import { angleForNorthUp, angleToStraighten } from '../src/core/image/straighten'
import { recognizeObjects } from '../src/core/catalog/recognition'
import {
  applyAffine,
  composeGeometry,
  GEOMETRY_UNCHANGED,
  rotateQuarters,
  rotateByAngle,
  borderlessRectangle,
  transformNormalizedPosition,
  mirror,
  mirrorOrientation,
  orientQuarters,
  sameGeometry,
  affineDeterminant,
  type Orientation,
  type AppliedGeometry,
  type AffineMatrix
} from '../src/core/image/geometry'
import { runInSandbox, type PluginResponse } from '../src/core/plugin/isolation'
import { checkCode, checkManifest, type ParameterValues } from '../src/core/plugin/manifest'
import { encodeFits } from '../src/core/export/encoding'
import { FULL_CROP, fitFraming, cropRegion, exportedWcs, type Crop } from '../src/core/export/crop'
import { mapToSource } from '../src/core/image/masks'
import { readProject, serializeProject } from '../src/core/project'
import { NEUTRAL_PROCESSING } from '../src/core/image/chain'
import { NEUTRAL_CURVES } from '../src/core/image/curve'
import { nodeWorker } from './plugin-node'
import { testFile } from './test-files.mjs'

let problems = 0
function check(condition: boolean, description: string): void {
  if (condition) console.log('  ok   ' + description)
  else {
    problems++
    console.log('  NO   ' + description)
  }
}

const folder = 'tools/test-plugin-geometry/'
const manifest = checkManifest(JSON.parse(readFileSync(folder + 'plugin.json', 'utf-8')), APP_VERSION)
const code = readFileSync(folder + 'plugin.js', 'utf-8')
const context = { stretch: { black: 0, midtones: 0.5, white: 1 }, starLightVersion: APP_VERSION }

function run(image: ImageData32, values: ParameterValues, geometry = 'transformed' as const): Promise<PluginResponse> {
  return runInSandbox(nodeWorker(code), { image, values, context }, 120000, geometry)
}

function transformed(r: PluginResponse): Extract<AppliedGeometry, { type: 'transformed' }> | null {
  return r.result === 'ok' && r.geometry?.type === 'transformed' ? r.geometry : null
}

const CASES: { name: string; values: ParameterValues }[] = [
  { name: '90° clockwise', values: { rotation: 'clockwise', mirrorHorizontal: false, mirrorVertical: false } },
  { name: '180°', values: { rotation: 'half', mirrorHorizontal: false, mirrorVertical: false } },
  { name: '90° counterclockwise', values: { rotation: 'counterclockwise', mirrorHorizontal: false, mirrorVertical: false } },
  { name: 'horizontal mirror', values: { rotation: 'none', mirrorHorizontal: true, mirrorVertical: false } },
  { name: 'vertical mirror', values: { rotation: 'none', mirrorHorizontal: false, mirrorVertical: true } },
  { name: 'mirror and 90° clockwise', values: { rotation: 'clockwise', mirrorHorizontal: true, mirrorVertical: false } }
]

async function main(): Promise<void> {
  console.log('--- MANIFEST AND CONTRACT ---')
  check(manifest.ok && manifest.manifest.geometry === 'transformed', 'Rotate and mirror declares the "transformed" geometry')
  check(checkCode(code).length === 0, 'the plugin code passes the installation checks')
  const withoutField = checkManifest({ ...JSON.parse(readFileSync(folder + 'plugin.json', 'utf-8')), geometry: undefined }, APP_VERSION)
  check(withoutField.ok && withoutField.manifest.geometry === 'unchanged', 'without the field the geometry is "unchanged"')
  const wrong = checkManifest({ ...JSON.parse(readFileSync(folder + 'plugin.json', 'utf-8')), geometry: 'crooked' }, APP_VERSION)
  check(!wrong.ok, 'an unexpected geometry is rejected')

  console.log('--- THE MATRIX REALLY DESCRIBES THE MOVEMENT (7 x 5 image) ---')
  const w = 7
  const h = 5
  const small: ImageData32 = { width: w, height: h, channels: 1, data: new Float32Array(w * h).map((_, i) => i + 1) }
  for (const testCase of CASES) {
    const r = await run(small, testCase.values)
    const g = transformed(r)
    let exact = g !== null && r.result === 'ok'
    if (g && r.result === 'ok') {
      for (let y = 0; y < h && exact; y++)
        for (let x = 0; x < w; x++) {
          const q = applyAffine(g.matrix, x, y)
          if (r.image.data[q.y * r.image.width + q.x] !== small.data[y * w + x]) exact = false
        }
    }
    check(exact, testCase.name + ': every pixel is where the matrix says')
  }
  const none = await run(small, { rotation: 'none', mirrorHorizontal: false, mirrorVertical: false })
  check(none.result === 'ok' && none.geometry?.type === 'unchanged', 'without rotation or mirror the geometry stays unchanged')

  // A plugin that changes the size without declaring it: unknown geometry.
  const muted = await runInSandbox(
    nodeWorker(code),
    { image: small, values: CASES[0].values, context },
    120000,
    'unchanged'
  )
  check(muted.result === 'ok' && muted.geometry?.type === 'unknown', '"unchanged" plugin that changes the size: unknown geometry')
  const misleading = await runInSandbox(
    nodeWorker('export function processImage(i) { return { ...i, data: i.data } }'),
    { image: small, values: {}, context },
    120000,
    'transformed'
  )
  check(misleading.result === 'error', '"transformed" plugin without a matrix: result rejected')

  console.log('--- COMPOSITION OF TWO PLUGINS ---')
  {
    const a = await run(small, CASES[0].values)
    const b = a.result === 'ok' ? await run(a.image, CASES[3].values) : a
    const ga = a.result === 'ok' ? a.geometry ?? GEOMETRY_UNCHANGED : GEOMETRY_UNCHANGED
    const gb = b.result === 'ok' ? b.geometry ?? GEOMETRY_UNCHANGED : GEOMETRY_UNCHANGED
    const g = composeGeometry(composeGeometry(GEOMETRY_UNCHANGED, ga), gb)
    let exact = g.type === 'transformed' && b.result === 'ok'
    if (g.type === 'transformed' && b.result === 'ok') {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const q = applyAffine(g.matrix, x, y)
          if (b.image.data[q.y * b.image.width + q.x] !== small.data[y * w + x]) exact = false
        }
    }
    check(exact, '90° clockwise then mirror: the composed matrix is exact')
  }

  console.log('--- M 27 ON THE REAL FILE ---')
  const readResult = readFits(new Uint8Array(readFileSync(testFile('m27'))), 'M_27.fit')
  const wcs = readResult.metadata.wcs as Wcs
  check(wcs !== null, 'the file carries the astrometric solution (SIP: ' + (wcs?.a.size ?? 0) + ' A terms)')
  const whole = debayer(readResult.image, readResult.metadata.bayer)
  const W = whole.width
  const H = whole.height
  const m27 = recognizeObjects(readResult.metadata).find((o) => o.object.id === 'M 27')
  check(m27 !== undefined && m27.position !== null, 'M 27 recognized and placed')
  if (!m27 || !m27.position) return
  const { ra, dec } = m27.object
  const before = skyToPixel(wcs, ra, dec) as { x: number; y: number }
  console.log('       M 27 in the original: FITS pixel (' + before.x.toFixed(2) + ', ' + before.y.toFixed(2) + ') of ' + W + ' x ' + H)

  for (const testCase of CASES) {
    const r = await run(whole, testCase.values)
    const g = transformed(r)
    if (!g || r.result !== 'ok') {
      check(false, testCase.name + ': the plugin worked')
      continue
    }
    const wcsT = transformWcs(wcs, g.matrix, g.output.width, g.output.height) as Wcs
    const after = skyToPixel(wcsT, ra, dec) as { x: number; y: number }
    // Where the plugin took the M 27 pixel (coordinates from 0 in the matrix).
    const expected = applyAffine(g.matrix, before.x - 1, before.y - 1)
    const rejection = Math.hypot(after.x - 1 - expected.x, after.y - 1 - expected.y)
    check(rejection < 1e-6, testCase.name + ': M 27 at (' + after.x.toFixed(2) + ', ' + after.y.toFixed(2) + '), deviation ' + rejection.toExponential(1) + ' pixel')

    // The pixel indicated by the transformed WCS really contains what was under M 27.
    const xi = Math.round(before.x - 1)
    const yi = Math.round(before.y - 1)
    const q = applyAffine(g.matrix, xi, yi)
    const n0 = W * H
    const n1 = r.image.width * r.image.height
    let same = true
    for (let c = 0; c < 3; c++) {
      if (r.image.data[c * n1 + q.y * r.image.width + q.x] !== whole.data[c * n0 + yi * W + xi]) same = false
    }
    check(same, testCase.name + ': the indicated pixel holds the same values that were under M 27')

    // Marker: shifted normalized position = the one computed from the new WCS.
    const pos = transformNormalizedPosition(g, m27.position)
    const fromWcs = normalizedPosition(wcsT, ra, dec) as { x: number; y: number }
    check(
      Math.abs(pos.x - fromWcs.x) < 1e-9 && Math.abs(pos.y - fromWcs.y) < 1e-9,
      testCase.name + ': marker at ' + (pos.x * 100).toFixed(1) + '% x ' + (pos.y * 100).toFixed(1) + '%, as the WCS says'
    )

    // The whole field, distortion included: same sky for every pixel.
    let max = 0
    for (let k = 0; k < 400; k++) {
      const x = (k * 7919) % W
      const y = (k * 104729) % H
      const a = pixelToSky(wcs, x + 1, y + 1)
      const t = applyAffine(g.matrix, x, y)
      const b = pixelToSky(wcsT, t.x + 1, t.y + 1)
      max = Math.max(max, Math.hypot((a.ra - b.ra) * Math.cos((a.dec * Math.PI) / 180), a.dec - b.dec) * 3600)
    }
    check(max < 1e-6, testCase.name + ': over 400 pixels the sky matches (maximum deviation ' + max.toExponential(1) + '″)')

    if (testCase.name === '90° clockwise') {
      console.log('--- FITS EXPORT OF THE ROTATED IMAGE AND RE-READING ---')
      const wcsFile = exportedWcs(wcsT, r.image.width, r.image.height, FULL_CROP, r.image.width, r.image.height)
      const data = encodeFits(r.image, readResult.header.cards as Record<string, string | number | boolean | null>, 16, { wcs: wcsFile })
      const reread = readFits(new Uint8Array(data), 'rotated.fit')
      const wcsR = reread.metadata.wcs
      check(wcsR !== null, 'the exported FITS carries the solution')
      if (wcsR) {
        const p = skyToPixel(wcsR, ra, dec) as { x: number; y: number }
        const d = Math.hypot(p.x - after.x, p.y - after.y)
        check(d < 1e-3, 're-read: M 27 in the same pixel (' + p.x.toFixed(2) + ', ' + p.y.toFixed(2) + '), deviation ' + d.toExponential(1))
        check(reread.image.width === r.image.width && reread.image.height === r.image.height, 're-read: ' + reread.image.width + ' x ' + reread.image.height + ' pixels')
        const obj = recognizeObjects(reread.metadata).find((o) => o.object.id === 'M 27')
        check(
          obj?.position != null && Math.abs(obj.position.x - pos.x) < 1e-4 && Math.abs(obj.position.y - pos.y) < 1e-4,
          're-read: recognition places M 27 where the viewer puts it'
        )
      }
    }
  }

  console.log('--- ANY AFFINE TRANSFORMATION (30° plus scale 1.5, with SIP) ---')
  {
    const c = Math.cos(Math.PI / 6) * 1.5
    const s = Math.sin(Math.PI / 6) * 1.5
    const m: AffineMatrix = [
      [c, -s, 1234.5],
      [s, c, -321.25]
    ]
    const wcsT = transformWcs(wcs, m, 5000, 6000) as Wcs
    let next = 0
    let back = 0
    for (let k = 0; k < 400; k++) {
      const x = (k * 7919) % W
      const y = (k * 104729) % H
      const a = pixelToSky(wcs, x + 1, y + 1)
      const t = applyAffine(m, x, y)
      const b = pixelToSky(wcsT, t.x + 1, t.y + 1)
      next = Math.max(next, Math.hypot((a.ra - b.ra) * Math.cos((a.dec * Math.PI) / 180), a.dec - b.dec) * 3600)
      const p0 = skyToPixel(wcs, a.ra, a.dec) as { x: number; y: number }
      const p1 = skyToPixel(wcsT, a.ra, a.dec) as { x: number; y: number }
      const q = applyAffine(m, p0.x - 1, p0.y - 1)
      back = Math.max(back, Math.hypot(p1.x - 1 - q.x, p1.y - 1 - q.y))
    }
    check(next < 1e-6, 'pixel → sky: maximum deviation ' + next.toExponential(1) + '″')
    check(back < 1e-6, 'sky → pixel: maximum deviation ' + back.toExponential(1) + ' pixel')
  }

  console.log('--- PROJECT ---')
  {
    const g: AppliedGeometry = {
      type: 'transformed',
      matrix: [
        [0, -1, H - 1],
        [1, 0, 0]
      ],
      input: { width: W, height: H },
      output: { width: H, height: W }
    }
    const base = {
      name: 'test',
      frame: [],
      activeFrame: null,
      image: null,
      originalImage: null,
      result: null,
      adjustments: {},
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
    const loaded = readProject(serializeProject({ ...base, appliedGeometry: g }, APP_VERSION), {})
    check(JSON.stringify(loaded.appliedGeometry) === JSON.stringify(g), 'the geometry is saved and re-read the same')
    const unknownValue = readProject(serializeProject({ ...base, appliedGeometry: { type: 'unknown' } }, APP_VERSION), {})
    check(unknownValue.appliedGeometry?.type === 'unknown', 'also the unknown one')
    const old = readProject(serializeProject(base, APP_VERSION), {})
    check(old.appliedGeometry === undefined, 'an old project says nothing (the opener decides)')
    const rotatedImage = readProject(serializeProject({ ...base, appliedGeometry: g, rotation: 3 }, APP_VERSION), {})
    check(rotatedImage.rotation === 3, 'the quarter turns of the viewer buttons are saved in the project')
  }

  console.log('--- STRAIGHTEN: FREE ROTATION ---')
  {
    const w = 40
    const h = 26
    const test: ImageData32 = { width: w, height: h, channels: 3, data: new Float32Array(w * h * 3) }
    for (let i = 0; i < test.data.length; i++) test.data[i] = 0.2 + 0.6 * Math.abs(Math.sin(i * 0.37))
    check(rotateByAngle(test, 0).image === test, 'zero angle: the image stays the same')
    const ninety = rotateByAngle(test, 90)
    const quarter = rotateQuarters(test, 1)
    let rejection = 0
    for (let i = 0; i < quarter.image.data.length; i++) rejection = Math.max(rejection, Math.abs(ninety.image.data[i] - quarter.image.data[i]))
    check(
      ninety.image.width === quarter.image.width && ninety.image.height === quarter.image.height && rejection < 1e-5,
      'a free rotation of 90° matches the quarter turn (deviation ' + rejection.toExponential(1) + ')'
    )
    // The matrix takes every pixel where it really ends up (at 90° without interpolation).
    let consistent = true
    if (ninety.step.type === 'transformed') {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const d = applyAffine(ninety.step.matrix, x, y)
          const k = Math.round(d.y) * ninety.image.width + Math.round(d.x)
          if (Math.abs(ninety.image.data[k] - test.data[y * w + x]) > 1e-5) consistent = false
        }
    } else consistent = false
    check(consistent, 'the free rotation matrix matches the moved pixels')
    // Forth and back: the center returns as it was, up to interpolation.
    const smoothed: ImageData32 = { width: 60, height: 60, channels: 1, data: new Float32Array(3600) }
    for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) smoothed.data[y * 60 + x] = 0.5 + 0.3 * Math.sin(x / 7) * Math.cos(y / 9)
    const outbound = rotateByAngle(smoothed, 17)
    const returnValue = rotateByAngle(outbound.image, -17)
    const ox = Math.round((returnValue.image.width - 60) / 2)
    const oy = Math.round((returnValue.image.height - 60) / 2)
    let error = 0
    for (let y = 20; y < 40; y++)
      for (let x = 20; x < 40; x++)
        error = Math.max(error, Math.abs(returnValue.image.data[(y + oy) * returnValue.image.width + x + ox] - smoothed.data[y * 60 + x]))
    check(error < 0.01, '17° forth and back: the center returns as it was (deviation ' + error.toFixed(4) + ')')
    // The borderless rectangle lies entirely inside the rotated image.
    let inside = true
    for (const angle of [3, 12, 30, 45, -20, 80]) {
      const r = rotateByAngle({ width: 300, height: 200, channels: 1, data: new Float32Array(60000).fill(1) }, angle, [0])
      const q = borderlessRectangle(300, 200, angle)
      const W = r.image.width
      const H = r.image.height
      for (const [fx, fy] of [[q.x, q.y], [q.x + q.width, q.y], [q.x, q.y + q.height], [q.x + q.width, q.y + q.height]]) {
        const px = Math.min(W - 1, Math.max(0, Math.round(fx * W - 0.5 + (fx < 0.5 ? 2 : -2))))
        const py = Math.min(H - 1, Math.max(0, Math.round(fy * H - 0.5 + (fy < 0.5 ? 2 : -2))))
        if (r.image.data[py * W + px] < 0.99) inside = false
      }
    }
    check(inside, 'the borderless crop contains no uncovered corners')
    const filled = borderlessRectangle(300, 200, 0)
    check(filled.width === 1 && filled.height === 1, 'at zero degrees the crop is the whole image')
    check(Math.abs(angleToStraighten({ x: 0, y: 0 }, { x: 100, y: 100 * Math.tan((10 * Math.PI) / 180) }) + 10) < 1e-9, 'a line descending by 10° is straightened by rotating by −10°')
    check(Math.abs(angleToStraighten({ x: 0, y: 0 }, { x: 100 * Math.tan((4 * Math.PI) / 180), y: -100 }) - 4) < 1e-9 || Math.abs(angleToStraighten({ x: 0, y: 0 }, { x: 100 * Math.tan((4 * Math.PI) / 180), y: -100 }) + 4) < 1e-9, 'a nearly vertical line is straightened onto the vertical')
    // North: a field whose north points 30° to the right of up must be rotated by −30°.
    const t = (30 * Math.PI) / 180
    const s = 2 / 3600
    const rotatedImage = buildWcs({
      crval: [180, 20],
      crpix: [100.5, 100.5],
      cd: [
        [-s * Math.cos(t), -s * Math.sin(t)],
        [-s * Math.sin(t), s * Math.cos(t)]
      ].map((r) => r) as [[number, number], [number, number]],
      naxis1: 200,
      naxis2: 200
    })
    const north = angleForNorthUp(rotatedImage, 200, 200)
    console.log('     angle for north: ' + (north === null ? 'none' : north.toFixed(2)))
    check(north !== null && Number.isFinite(north), 'with the astrometric solution the angle for north up can be computed')
    // After the proposed rotation north is up.
    if (rotatedImage && north !== null) {
      const r = rotateByAngle({ width: 200, height: 200, channels: 1, data: new Float32Array(40000) }, north)
      const after = r.step.type === 'transformed' ? transformWcs(rotatedImage, r.step.matrix, r.image.width, r.image.height) : null
      const leftover = angleForNorthUp(after, r.image.width, r.image.height)
      check(leftover !== null && Math.abs(leftover) < 0.05, 'after the rotation north is up (remainder ' + (leftover ?? NaN).toFixed(3) + '°)')
    }
  }

  console.log('--- ROTATION FROM THE VIEWER BUTTONS ---')
  {
    const w = 7
    const h = 4
    const test: ImageData32 = { width: w, height: h, channels: 3, data: new Float32Array(w * h * 3) }
    for (let i = 0; i < test.data.length; i++) test.data[i] = i
    const equal = (a: ImageData32, b: ImageData32): boolean =>
      a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i])
    let pass: ImageData32 = test
    let geometry: AppliedGeometry = GEOMETRY_UNCHANGED
    for (let k = 0; k < 4; k++) {
      const r = rotateQuarters(pass, 1)
      pass = r.image
      geometry = composeGeometry(geometry, r.step)
    }
    check(equal(pass, test), 'four quarter turns bring the image back identical')
    const next = rotateQuarters(test, 1)
    check(next.image.width === h && next.image.height === w, 'a quarter turn swaps width and height')
    check(equal(rotateQuarters(next.image, -1).image, test), 'clockwise then counterclockwise cancel out')
    check(equal(rotateQuarters(test, 2).image, rotateQuarters(next.image, 1).image), 'a half turn is two quarters')
    // The declared matrix takes every pixel where it really ends up.
    let consistent = true
    for (const q of [1, 2, 3]) {
      const r = rotateQuarters(test, q)
      if (r.step.type !== 'transformed') {
        consistent = false
        continue
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = applyAffine(r.step.matrix, x, y)
          if (r.image.data[d.y * r.image.width + d.x] !== test.data[y * w + x]) consistent = false
        }
      }
    }
    check(consistent, 'the declared matrix matches the moved pixels (markers and WCS follow)')
  }

  await checkMirror(wcs, whole, m27.position, ra, dec)
}

/* ---- Mirror from the toolbar buttons ---- */

const equalImages = (a: ImageData32, b: ImageData32): boolean =>
  a.width === b.width && a.height === b.height && a.channels === b.channels && a.data.every((v, i) => v === b.data[i])

/** Every pixel of `from` is in `a` where the matrix of the step says. */
function pixelWhereMatrixSays(from: ImageData32, a: ImageData32, g: AppliedGeometry): boolean {
  if (g.type !== 'transformed') return false
  const n0 = from.width * from.height
  const n1 = a.width * a.height
  for (let c = 0; c < from.channels; c++)
    for (let y = 0; y < from.height; y++)
      for (let x = 0; x < from.width; x++) {
        const q = applyAffine(g.matrix, x, y)
        if (a.data[c * n1 + Math.round(q.y) * a.width + Math.round(q.x)] !== from.data[c * n0 + y * from.width + x]) return false
      }
  return true
}

/** Like sameGeometry, but identity counts as "unchanged" (two equal mirrors in a row give identity). */
function sameTransform(a: AppliedGeometry, b: AppliedGeometry, w: number, h: number): boolean {
  const asMatrix = (g: AppliedGeometry): AppliedGeometry =>
    g.type === 'unchanged'
      ? { type: 'transformed', matrix: [[1, 0, 0], [0, 1, 0]], input: { width: w, height: h }, output: { width: w, height: h } }
      : g
  return sameGeometry(asMatrix(a), asMatrix(b))
}

/** The whole orientation applied in canonical order (free rotation without fill). */
function orient(img: ImageData32, o: Orientation): { image: ImageData32; geometry: AppliedGeometry } {
  const q = orientQuarters(img, o.mirrored, o.quarters)
  const l = rotateByAngle(q.image, o.degrees)
  return { image: l.image, geometry: composeGeometry(composeGeometry(GEOMETRY_UNCHANGED, q.step), l.step) }
}

async function checkMirror(
  wcs: Wcs,
  whole: ImageData32,
  position: { x: number; y: number },
  ra: number,
  dec: number
): Promise<void> {
  console.log('--- MIRROR FROM THE TOOLBAR BUTTONS ---')
  const w = 7
  const h = 4
  const test: ImageData32 = { width: w, height: h, channels: 3, data: new Float32Array(w * h * 3).map((_, i) => i) }
  for (const direction of ['horizontal', 'vertical'] as const) {
    const s = mirror(test, direction)
    check(pixelWhereMatrixSays(test, s.image, s.step), direction + ': every pixel is where the matrix says, no value changes')
    const returnValue = mirror(s.image, direction)
    check(equalImages(returnValue.image, test), direction + ': twice brings the image back identical')
    const g = composeGeometry(s.step, returnValue.step)
    check(
      g.type === 'transformed' && g.matrix.every((r, i) => r.every((v, j) => v === [[1, 0, 0], [0, 1, 0]][i][j])),
      direction + ': round trip, the composed geometry is the identity'
    )
    check(s.step.type === 'transformed' && affineDeterminant(s.step.matrix) === -1, direction + ': determinant −1 (inverted parity)')
  }
  const hv = mirror(mirror(test, 'horizontal').image, 'vertical').image
  check(equalImages(hv, rotateQuarters(test, 2).image), 'the two mirrors together are a half turn')
  check(
    equalImages(orientQuarters(test, true, 2).image, mirror(test, 'vertical').image),
    'horizontal mirror and a half turn are the vertical mirror (its canonical form)'
  )

  console.log('--- CANONICAL ORDER: MIRROR, QUARTER TURNS, FREE ROTATION ---')
  {
    // For each of the eight orientations without free rotation: mirroring
    // the displayed image gives exactly the new orientation recomputed
    // from the starting image (pixels and geometry).
    let exactValues = 0
    let cases = 0
    for (const mirrored of [false, true])
      for (let quarters = 0; quarters < 4; quarters++)
        for (const direction of ['horizontal', 'vertical'] as const) {
          cases++
          const o: Orientation = { mirrored, quarters, degrees: 0 }
          const shown = orientQuarters(test, mirrored, quarters)
          const done = mirror(shown.image, direction)
          const gDone = composeGeometry(composeGeometry(GEOMETRY_UNCHANGED, shown.step), done.step)
          const n = mirrorOrientation(o, direction)
          const redone = orientQuarters(test, n.mirrored, n.quarters)
          if (equalImages(done.image, redone.image) && sameTransform(gDone, redone.step, w, h) && n.degrees === 0) exactValues++
        }
    check(exactValues === cases, 'mirror on the displayed image = recomputed canonical orientation (' + exactValues + ' of ' + cases + ' cases, identical pixels)')

    // With free rotation: same geometry, and pixels equal up to the
    // rounding of the interpolation.
    const smoothed: ImageData32 = { width: 61, height: 43, channels: 1, data: new Float32Array(61 * 43) }
    for (let y = 0; y < 43; y++) for (let x = 0; x < 61; x++) smoothed.data[y * 61 + x] = 0.5 + 0.3 * Math.sin(x / 5) * Math.cos(y / 7) + x / 400
    let equalGeometries = true
    let rejection = 0
    for (const o of [
      { mirrored: false, quarters: 0, degrees: 17 },
      { mirrored: true, quarters: 1, degrees: -8.5 },
      { mirrored: false, quarters: 3, degrees: 33 },
      { mirrored: true, quarters: 2, degrees: 4 }
    ])
      for (const direction of ['horizontal', 'vertical'] as const) {
        const shown = orient(smoothed, o)
        const done = mirror(shown.image, direction)
        const gDone = composeGeometry(shown.geometry, done.step)
        const n = mirrorOrientation(o, direction)
        const redone = orient(smoothed, n)
        if (!sameTransform(gDone, redone.geometry, 61, 43)) equalGeometries = false
        if (redone.image.width !== done.image.width || redone.image.height !== done.image.height) equalGeometries = false
        else for (let i = 0; i < done.image.data.length; i++) rejection = Math.max(rejection, Math.abs(done.image.data[i] - redone.image.data[i]))
      }
    check(equalGeometries, 'with free rotation the mirror inverts the angle: same matrix and same size')
    check(rejection < 1e-4, 'with free rotation: same pixels, maximum deviation ' + rejection.toExponential(1))
    const two = mirrorOrientation(mirrorOrientation({ mirrored: false, quarters: 1, degrees: 12 }, 'vertical'), 'vertical')
    check(!two.mirrored && two.quarters === 1 && two.degrees === 12, 'two equal mirrors in a row return to the previous orientation')
    const mixed = mirrorOrientation(mirrorOrientation({ mirrored: false, quarters: 0, degrees: 0 }, 'horizontal'), 'vertical')
    check(!mixed.mirrored && mixed.quarters === 2, 'horizontal then vertical: a half turn')
  }

  console.log('--- MIRROR AND ASTROMETRIC SOLUTION (M 27) ---')
  const W = whole.width
  const H = whole.height
  const before = skyToPixel(wcs, ra, dec) as { x: number; y: number }
  const sign = (x: Wcs): number => Math.sign(x.cd[0][0] * x.cd[1][1] - x.cd[0][1] * x.cd[1][0])
  // Direction from north to east around a pixel: with a mirror it inverts.
  const towardNorthEast = (x: Wcs, p: { x: number; y: number }): number => {
    const c = pixelToSky(x, p.x, p.y)
    const n = skyToPixel(x, c.ra, c.dec + 0.01) as { x: number; y: number }
    const e = skyToPixel(x, c.ra + 0.01 / Math.cos((c.dec * Math.PI) / 180), c.dec) as { x: number; y: number }
    return Math.sign((n.x - p.x) * (e.y - p.y) - (n.y - p.y) * (e.x - p.x))
  }
  const zero: Orientation = { mirrored: false, quarters: 0, degrees: 0 }
  for (const testCase of [
    { name: 'horizontal mirror', o: mirrorOrientation(zero, 'horizontal') },
    { name: 'vertical mirror', o: mirrorOrientation(zero, 'vertical') },
    { name: '90° clockwise then horizontal mirror', o: mirrorOrientation({ ...zero, quarters: 1 }, 'horizontal') },
    { name: 'straightened by 12° then vertical mirror', o: mirrorOrientation({ ...zero, degrees: 12 }, 'vertical') }
  ]) {
    const r = orient(whole, testCase.o)
    const g = r.geometry
    if (g.type !== 'transformed') {
      check(false, testCase.name + ': known geometry')
      continue
    }
    const wcsT = transformWcs(wcs, g.matrix, g.output.width, g.output.height) as Wcs
    check(sign(wcsT) === -sign(wcs), testCase.name + ': the solution has inverted parity')
    const after = skyToPixel(wcsT, ra, dec) as { x: number; y: number }
    const expected = applyAffine(g.matrix, before.x - 1, before.y - 1)
    const rejection = Math.hypot(after.x - 1 - expected.x, after.y - 1 - expected.y)
    check(rejection < 1e-6, testCase.name + ': M 27 in the right pixel (' + after.x.toFixed(2) + ', ' + after.y.toFixed(2) + '), deviation ' + rejection.toExponential(1))
    const sky = pixelToSky(wcsT, after.x, after.y)
    const arcsec = Math.hypot((sky.ra - ra) * Math.cos((dec * Math.PI) / 180), sky.dec - dec) * 3600
    check(arcsec < 1e-3, testCase.name + ': in that pixel the coordinates are those of M 27 (deviation ' + arcsec.toExponential(1) + '″)')
    if (testCase.o.degrees === 0) {
      // The indicated pixel holds exactly the values that were under M 27.
      const xi = Math.round(before.x - 1)
      const yi = Math.round(before.y - 1)
      const q = applyAffine(g.matrix, xi, yi)
      const n0 = W * H
      const n1 = r.image.width * r.image.height
      let same = true
      for (let c = 0; c < 3; c++)
        if (r.image.data[c * n1 + Math.round(q.y) * r.image.width + Math.round(q.x)] !== whole.data[c * n0 + yi * W + xi]) same = false
      check(same, testCase.name + ': the indicated pixel holds the values that were under M 27')
    }
    check(towardNorthEast(wcsT, after) === -towardNorthEast(wcs, before), testCase.name + ': north and east swap direction')
    // Marker: shifted normalized position = the one of the new WCS.
    const pos = transformNormalizedPosition(g, position)
    const fromWcs = normalizedPosition(wcsT, ra, dec) as { x: number; y: number }
    check(Math.abs(pos.x - fromWcs.x) < 1e-9 && Math.abs(pos.y - fromWcs.y) < 1e-9, testCase.name + ': the M 27 marker follows the image')
    // Masks: from the displayed pixel back to the right starting pixel.
    const p0 = applyAffine(mapToSource(g), expected.x, expected.y)
    check(Math.hypot(p0.x - (before.x - 1), p0.y - (before.y - 1)) < 1e-6, testCase.name + ': the masks (anchored to the starting image) follow')
  }

  console.log('--- MIRROR AND CROP ---')
  {
    const L = 120
    const A = 80
    const img: ImageData32 = { width: L, height: A, channels: 1, data: new Float32Array(L * A).map((_, i) => i + 1) }
    const r0: Crop = { x: 12 / L, y: 8 / A, width: 60 / L, height: 40 / A }
    const values = (im: ImageData32, r: Crop): string => Array.from(cropRegion(im, r).data).sort((a, b) => a - b).join(',')
    for (const testCase of [
      { name: 'horizontal mirror', o: { mirrored: true, quarters: 0, degrees: 0 } },
      { name: 'vertical mirror', o: { mirrored: true, quarters: 2, degrees: 0 } },
      { name: 'mirror and 90° clockwise', o: { mirrored: true, quarters: 1, degrees: 0 } }
    ]) {
      const r = orient(img, testCase.o)
      const inq = fitFraming(
        { crop: r0, aspectRatio: '3-2', preset: null },
        GEOMETRY_UNCHANGED,
        r.geometry,
        { width: L, height: A },
        { width: r.image.width, height: r.image.height }
      )
      check(values(r.image, inq.crop) === values(img, r0), testCase.name + ': the crop contains the same pixels (ratio ' + inq.aspectRatio + ')')
    }
    // The horizontal mirror takes a crop on the left over to the right.
    const s = orient(img, { mirrored: true, quarters: 0, degrees: 0 })
    const inq = fitFraming(
      { crop: r0, aspectRatio: '3-2', preset: null },
      GEOMETRY_UNCHANGED,
      s.geometry,
      { width: L, height: A },
      { width: L, height: A }
    )
    check(
      Math.abs(inq.crop.x - (1 - r0.x - r0.width)) < 1e-9 && Math.abs(inq.crop.y - r0.y) < 1e-9,
      'horizontal mirror: the crop moves to the other side, at the same height'
    )
  }

  console.log('--- MIRROR IN THE PROJECT ---')
  {
    const base = {
      name: 'test',
      frame: [],
      activeFrame: null,
      image: null,
      originalImage: null,
      result: null,
      adjustments: {},
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
    const o = mirrorOrientation({ mirrored: false, quarters: 1, degrees: 7.5 }, 'vertical')
    const r = orient(test, o)
    const saved = { ...base, appliedGeometry: r.geometry, mirrored: o.mirrored, rotation: o.quarters, freeRotation: o.degrees }
    const readResult = readProject(serializeProject(saved, APP_VERSION), {})
    check(
      readResult.mirrored === true &&
        readResult.rotation === o.quarters &&
        readResult.freeRotation === o.degrees &&
        sameGeometry(readResult.appliedGeometry ?? GEOMETRY_UNCHANGED, r.geometry),
      'mirror, quarter turns, angle and geometry are saved and re-read the same'
    )
    check(readResult.notices === undefined, 'no notice for a normal project')
    check(readProject(serializeProject(base, APP_VERSION), {}).mirrored === undefined, 'a project without a mirror does not mention it (none applies)')
    const withNotices = serializeProject({ ...saved, notices: ['test'] }, APP_VERSION)
    check(!withNotices.includes('"notices"'), 'the reading notices are not written to the file')

  }
}

main().then(() => {
  console.log(problems === 0 ? '\nAll good.' : '\nProblems: ' + problems)
  process.exit(problems === 0 ? 0 : 1)
})
