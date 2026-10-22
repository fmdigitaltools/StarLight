/**
 * Test: the export crop follows the image when a plugin rotates or mirrors
 * it.
 *
 * - with the test plugin "Rotate and mirror" (tools/test-plugin-geometry,
 *   in the sandbox), after each rotation and mirror the adapted box
 *   contains exactly the same pixels as before, with width and height
 *   swapped after a quarter turn, and stays inside the image;
 * - after a quarter turn the aspect ratio becomes its twin (3:2 → 2:3),
 *   every ratio has one, and a preset keeps its shape;
 * - removing the plugin, or going from one rotation to another, puts the
 *   box back where it belongs;
 * - with unknown geometry the box stays inside the image;
 * - in the store: applying the processing adapts the crop, Undo and Redo
 *   restore image, geometry and crop together;
 * - the saved project rereads the adapted crop.
 *
 * No external files are needed: the test image is synthetic.
 */
import { readFileSync } from 'node:fs'
import type { ImageData32 } from '../src/shared/types'
import { APP_VERSION } from '../src/shared/version'
import {
  fitFraming,
  cropDimensions,
  ASPECT_RATIOS,
  FULL_CROP,
  cropRegion,
  centeredCrop,
  type Framing,
  type Crop
} from '../src/core/export/crop'
import { GEOMETRY_UNCHANGED, GEOMETRY_UNKNOWN, type AppliedGeometry } from '../src/core/image/geometry'
import { runInSandbox } from '../src/core/plugin/isolation'
import type { ParameterValues } from '../src/core/plugin/manifest'
import { readProject, serializeProject } from '../src/core/project'
import { NEUTRAL_PROCESSING } from '../src/core/image/chain'
import { NEUTRAL_CURVES } from '../src/core/image/curve'
import { useApp } from '../src/renderer/src/store/appStore'
import { undo, repeat } from '../src/renderer/src/hooks/history'
import { nodeWorker } from './plugin-node'

let problems = 0
function check(condition: boolean, description: string): void {
  if (condition) console.log('  ok   ' + description)
  else {
    problems++
    console.log('  NO   ' + description)
  }
}

const code = readFileSync('tools/test-plugin-geometry/plugin.js', 'utf-8')
const context = { stretch: { black: 0, midtones: 0.5, white: 1 }, starLightVersion: APP_VERSION }

/** Runs "Rotate and mirror" and returns the image and the geometry. */
async function rotate(image: ImageData32, values: ParameterValues): Promise<{ image: ImageData32; geometry: AppliedGeometry }> {
  const r = await runInSandbox(nodeWorker(code), { image, values, context }, 120000, 'transformed')
  if (r.result !== 'ok') throw new Error('the plugin did not work')
  return { image: r.image, geometry: r.geometry ?? GEOMETRY_UNCHANGED }
}

const measurements = (img: ImageData32): { width: number; height: number } => ({ width: img.width, height: img.height })

/** The pixel values of a crop, sorted: equal if the pixels are the same. */
function pixelOf(img: ImageData32, r: Crop): { w: number; h: number; values: string } {
  const part = cropRegion(img, r)
  return { w: part.width, h: part.height, values: Array.from(part.data).sort((a, b) => a - b).join(',') }
}

function inside(r: Crop): boolean {
  const e = 1e-9
  return r.x >= -e && r.y >= -e && r.x + r.width <= 1 + e && r.y + r.height <= 1 + e && r.width > 0 && r.height > 0
}

const neighbors = (a: Crop, b: Crop): boolean =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.width - b.width) < 1e-9 && Math.abs(a.height - b.height) < 1e-9

const CASES: { name: string; values: ParameterValues; quarter: boolean }[] = [
  { name: '90° clockwise', values: { rotation: 'clockwise', mirrorHorizontal: false, mirrorVertical: false }, quarter: true },
  { name: '180°', values: { rotation: 'half', mirrorHorizontal: false, mirrorVertical: false }, quarter: false },
  { name: '90° counterclockwise', values: { rotation: 'counterclockwise', mirrorHorizontal: false, mirrorVertical: false }, quarter: true },
  { name: 'horizontal mirror', values: { rotation: 'none', mirrorHorizontal: true, mirrorVertical: false }, quarter: false },
  { name: 'vertical mirror', values: { rotation: 'none', mirrorHorizontal: false, mirrorVertical: true }, quarter: false },
  { name: 'mirror and 90° clockwise', values: { rotation: 'clockwise', mirrorHorizontal: true, mirrorVertical: false }, quarter: true }
]

async function main(): Promise<void> {
  // 120 x 80 image in which every pixel has a different value.
  const W = 120
  const H = 80
  const image: ImageData32 = { width: W, height: H, channels: 1, data: new Float32Array(W * H).map((_, i) => (i + 1) / (W * H)) }

  // Narrow 3:2 box shifted toward a corner: 60 x 40 pixels at (12, 8).
  const crop32: Crop = { x: 12 / W, y: 8 / H, width: 60 / W, height: 40 / H }
  const inq: Framing = { crop: crop32, aspectRatio: '3-2', preset: null }
  const pixelBefore = pixelOf(image, crop32)

  console.log('--- THE BOX FOLLOWS THE PIXELS ---')
  for (const testCase of CASES) {
    const flipped = await rotate(image, testCase.values)
    const newValue = fitFraming(inq, GEOMETRY_UNCHANGED, flipped.geometry, measurements(image), measurements(flipped.image))
    const pixelAfter = pixelOf(flipped.image, newValue.crop)
    check(inside(newValue.crop), testCase.name + ': the box stays inside the image')
    check(pixelAfter.values === pixelBefore.values, testCase.name + ': the box contains the same pixels as before')
    check(
      testCase.quarter ? pixelAfter.w === pixelBefore.h && pixelAfter.h === pixelBefore.w : pixelAfter.w === pixelBefore.w && pixelAfter.h === pixelBefore.h,
      testCase.name + ': size ' + pixelAfter.w + ' x ' + pixelAfter.h + (testCase.quarter ? ' (swapped)' : ' (equal)')
    )
    check(newValue.aspectRatio === (testCase.quarter ? '2-3' : '3-2'), testCase.name + ': aspect ratio ' + newValue.aspectRatio)

    const removed = fitFraming(newValue, flipped.geometry, GEOMETRY_UNCHANGED, measurements(flipped.image), measurements(image))
    check(neighbors(removed.crop, crop32) && removed.aspectRatio === '3-2', testCase.name + ': removing the plugin the box returns as it was')
  }

  // From one rotation to another without going through the upright image.
  const clockwise = await rotate(image, CASES[0].values)
  const counterclockwise = await rotate(image, CASES[2].values)
  const fromClockwise = fitFraming(inq, GEOMETRY_UNCHANGED, clockwise.geometry, measurements(image), measurements(clockwise.image))
  const fromCounterclockwise = fitFraming(fromClockwise, clockwise.geometry, counterclockwise.geometry, measurements(clockwise.image), measurements(counterclockwise.image))
  check(
    pixelOf(counterclockwise.image, fromCounterclockwise.crop).values === pixelBefore.values && fromCounterclockwise.aspectRatio === '2-3',
    'from 90° clockwise to 90° counterclockwise: same pixels, aspect ratio still 2:3 (it is a half turn)'
  )

  // Box touching the edge: after the turn it stays inside and whole.
  const wide = centeredCrop(W, H, 16 / 9)
  const wideRotated = fitFraming({ crop: wide, aspectRatio: '16-9', preset: null }, GEOMETRY_UNCHANGED, clockwise.geometry, measurements(image), measurements(clockwise.image))
  const d1 = cropDimensions(wide, W, H)
  const d2 = cropDimensions(wideRotated.crop, H, W)
  check(inside(wideRotated.crop) && d1.width === d2.height && d1.height === d2.width && wideRotated.aspectRatio === '9-16', 'full-width 16:9 becomes full-height 9:16')

  // The whole image stays the whole image, with no new objects.
  const filled: Framing = { crop: FULL_CROP, aspectRatio: 'original', preset: null }
  check(fitFraming(filled, GEOMETRY_UNCHANGED, clockwise.geometry, measurements(image), measurements(clockwise.image)) === filled, 'without a crop nothing changes')

  console.log('--- ASPECT RATIOS AND PRESETS ---')
  for (const p of ASPECT_RATIOS) {
    const r = centeredCrop(W, H, p.ratio)
    const flippedValue = fitFraming({ crop: r, aspectRatio: p.id, preset: null }, GEOMETRY_UNCHANGED, clockwise.geometry, measurements(image), measurements(clockwise.image))
    const twin = ASPECT_RATIOS.find((x) => x.id === flippedValue.aspectRatio)
    const correct = p.ratio === null ? flippedValue.aspectRatio === 'original' : twin !== undefined && twin.ratio !== null && Math.abs(twin.ratio * p.ratio - 1) < 1e-9
    check(correct, p.name + ' becomes ' + (twin?.name ?? flippedValue.aspectRatio))
  }

  const format: Framing = { crop: centeredCrop(W, H, 1080 / 1350), aspectRatio: 'custom', preset: 'ig-portrait' }
  const rotatedFormat = fitFraming(format, GEOMETRY_UNCHANGED, clockwise.geometry, measurements(image), measurements(clockwise.image))
  const pf = cropDimensions(rotatedFormat.crop, H, W)
  check(rotatedFormat.preset === 'ig-portrait' && inside(rotatedFormat.crop), 'a preset stays the same, inside the image')
  check(Math.abs(pf.width / pf.height - 1080 / 1350) < 0.05, 'and keeps its shape (' + pf.width + ' x ' + pf.height + ')')

  console.log('--- UNKNOWN GEOMETRY ---')
  const unknown = fitFraming(inq, GEOMETRY_UNCHANGED, GEOMETRY_UNKNOWN, measurements(image), measurements(image))
  check(unknown === inq, 'same size: the crop stays as it is')
  const unknownFlipped = fitFraming(inq, GEOMETRY_UNCHANGED, GEOMETRY_UNKNOWN, measurements(image), { width: H, height: W })
  const pi = cropDimensions(unknownFlipped.crop, H, W)
  check(inside(unknownFlipped.crop) && Math.abs(pi.width / pi.height - 1.5) < 0.05, 'swapped size: 3:2 box recentered inside the image')

  console.log('--- STORE, UNDO AND REDO ---')
  const app = useApp.getState()
  app.addFrame([])
  app.setActiveFrame('test', image)
  await new Promise((r) => setTimeout(r, 20))
  useApp.getState().setAspectRatio('3-2')
  useApp.getState().setCrop(crop32)
  await new Promise((r) => setTimeout(r, 700))
  // As useProcessing does: a job, then the processed image with its geometry.
  useApp.getState().setJob('Processing', 0.5)
  useApp.getState().setProcessedImage(clockwise.image, NEUTRAL_PROCESSING, clockwise.geometry)
  useApp.getState().finishJob()
  let s = useApp.getState()
  check(
    s.aspectRatio === '2-3' && pixelOf(s.image as ImageData32, s.crop).values === pixelBefore.values,
    'after the quarter turn the store has the rotated box and the 2:3 aspect ratio'
  )
  const rotatedCrop = s.crop
  await new Promise((r) => setTimeout(r, 700))
  undo()
  s = useApp.getState()
  check(
    s.image === image && s.appliedGeometry.type === 'unchanged' && s.crop === crop32 && s.aspectRatio === '3-2',
    'Undo restores the upright image, the box and the previous aspect ratio'
  )
  repeat()
  s = useApp.getState()
  check(
    s.image === clockwise.image && s.crop === rotatedCrop && s.aspectRatio === '2-3',
    'Redo restores the quarter turn with the rotated box'
  )
  // The same geometry recomputed (new object, equal values) does not touch the crop.
  useApp.getState().setProcessedImage(clockwise.image, NEUTRAL_PROCESSING, JSON.parse(JSON.stringify(clockwise.geometry)))
  check(useApp.getState().crop === rotatedCrop, 'recomputing the same rotation leaves the crop as it is')

  console.log('--- PROJECT ---')
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
    appliedGeometry: clockwise.geometry,
    crop: rotatedCrop,
    aspectRatio: '2-3',
    preset: null,
    objects: [],
    withCalibration: true,
    step: 'export'
  }
  const readResult = readProject(serializeProject(base, APP_VERSION), {})
  check(neighbors(readResult.crop, rotatedCrop) && readResult.aspectRatio === '2-3', 'the project rereads the rotated box and the 2:3 aspect ratio')
}

main().then(
  () => {
    console.log(problems === 0 ? '\nAll good.' : '\nProblems: ' + problems)
    process.exit(problems === 0 ? 0 : 1)
  },
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
