/**
 * Check of the camera RAW reader (`src/core/raw`).
 *
 * For each RAW in the given folder:
 * - reads only the shooting data and then the whole file, measuring times
 *   and memory (of the process and of WebAssembly);
 * - checks size, Bayer pattern, levels (black, saturation, per-color
 *   medians) and metadata;
 * - tests the Bayer pattern with the "gray world": after the camera white
 *   balance the three colors of an ordinary photo have similar means;
 *   with the wrong pattern red and blue are swapped and the ratio comes
 *   out very far from 1;
 * - checks that the pixels read directly from LibRaw memory match, bit
 *   for bit, those of the package path (getRawImage, which makes a copy);
 * - reads the embedded preview used for the library thumbnails and checks
 *   its shape and size;
 * - saves a reduced PNG preview (StarLight color reconstruction + camera
 *   white + gamma, for viewing only).
 * Then it stacks: the folder's lights if there are at least two (aligned
 *   on the stars), otherwise three copies of the first RAW shifted by a few
 *   pixels, and checks that the alignment recovers the shift.
 *
 * Usage:
 *   esbuild tools/test-raw.ts --bundle --platform=node --format=esm
 *     --alias:@shared=./src/shared --alias:@core=./src/core
 *     --outfile=<your file>.mjs
 *   node <your file>.mjs <RAW folder> <preview folder> [--stack] [--sky] [--calibration <folder with darks/ flats/ biases>] [--max N]
 *   (--sky: previews with the sky background removed, for night shots)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LibRaw } from '@colorhythm/libraw-wasm'
import { prepareRaw, readRaw, readRawHeader, readRawPreview, rawMemory, isRaw } from '../src/core/raw/rawReader'
import { thumbnailFromPreview, THUMBNAIL_SIDE } from '../src/core/image/thumbnail'
import { debayer, colorAt, toLuminance } from '../src/core/image/debayer'
import { detectStars } from '../src/core/stars/detection'
import { align, requiredStars, IDENTITY_TRANSFORMATION } from '../src/core/stack/alignment'
import { stack, type FrameToStack } from '../src/core/stack/stacking'
import { computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { createMaster, calibrate } from '../src/core/stack/calibration'
import type { FitsReadResult, ImageData32 } from '../src/shared/types'
import { encodePng } from './plugin-node'

const args = process.argv.slice(2)
const folder = args[0]
const output = args[1]
const withStacking = args.includes('--stack')
const iCal = args.indexOf('--calibration')
const calibrationFolder = iCal >= 0 ? args[iCal + 1] : null
const iMax = args.indexOf('--max')
const max = iMax >= 0 ? Number(args[iMax + 1]) : Infinity
if (!folder || !output) {
  console.log('Usage: node test-raw.mjs <RAW folder> <preview folder> [--stack] [--max N]')
  process.exit(1)
}
mkdirSync(output, { recursive: true })

const MB = 1048576
let errors = 0
function check(condition: boolean, description: string): void {
  if (!condition) {
    errors++
    console.log('   ERROR: ' + description)
  }
}

/** Approximate median (on a sample) of the pixels of one color of the matrix. */
function colorMedian(r: FitsReadResult, color: 0 | 1 | 2): number {
  const { width: w, height: h, data } = r.image
  const values: number[] = []
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 400000)))
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      // x and y of the right parity are chosen to land on the wanted color.
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < w && yy < h && colorAt(r.metadata.bayer, xx, yy) === color) values.push(data[yy * w + xx])
        }
      }
    }
  }
  values.sort((a, b) => a - b)
  return values[values.length >> 1] ?? 0
}

/**
 * Reference conversion of the raw pixels, for the package path:
 * `getRawImage` (which copies the data out of LibRaw) and the same formula
 * as the reader. Only for Bayer and monochrome sensors; null for the others.
 */
function referenceWithCopy(d: LibRaw, byte: Uint8Array): Float32Array | null {
  d.open(byte.slice().buffer)
  try {
    d.unpack()
    const raw = d.getRawImage()
    if (raw === null) return null
    const filters = d.getFilters() >>> 0
    if (filters === 9) return null
    const cell = filters === 0 ? [0] : [d.color(0, 0), d.color(0, 1), d.color(1, 0), d.color(1, 1)]
    const p = filters === 0 ? 1 : 2
    const blacks = [0, 1, 2, 3].map((i) => {
      const v = d.getBlackLevel(i)
      return Number.isFinite(v) && v > 0 ? v : 0
    })
    const max = d.getColorMaximum()
    const white = Number.isFinite(max) && max > 0 ? max : 65535
    const black = Math.min(...cell.map((c) => blacks[c]))
    const remove = new Float32Array(p * p)
    for (let k = 0; k < p * p; k++) remove[k] = blacks[cell[k]] - black
    const inv = 1 / white
    const w = d.getActiveWidth()
    const h = d.getActiveHeight()
    const sx = d.getLeftMargin()
    const sy = d.getTopMargin()
    const rw = d.getRawWidth()
    const data = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      const row = (y + sy) * rw + sx
      const base = (y % p) * p
      for (let x = 0; x < w; x++) {
        const v = (raw[row + x] - remove[base + (x % p)]) * inv
        data[y * w + x] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    return data
  } finally {
    d.recycle()
  }
}

/** True if the two arrays have the same bytes. */
function sameBytes(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length)
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

/** Mean of one plane of the color image, minus the pedestal. */
function planeMean(im: ImageData32, c: number, pedestal: number): number {
  const n = im.width * im.height
  let s = 0
  for (let i = 0; i < n; i += 7) s += im.data[c * n + i] - pedestal
  return s / Math.ceil(n / 7)
}

/** Reduced color preview, with the camera white and a gamma. */
function savePreview(rgb: ImageData32, r: FitsReadResult, path: string, sky = false, calibrated = false): void {
  const factor = Math.max(1, Math.ceil(rgb.width / 1200))
  const w = Math.floor(rgb.width / factor)
  const h = Math.floor(rgb.height / factor)
  const n = rgb.width * rgb.height
  // A calibrated image no longer has the pedestal: the dark removed it.
  const pedestalValue = calibrated ? 0 : r.metadata.raw?.pedestal ?? 0
  const wb = r.metadata.raw?.whiteBalance ?? [1, 1, 1]
  const planes = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)]
  for (let c = 0; c < 3; c++) {
    const sourceChannel = rgb.channels === 3 ? c : 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) s += rgb.data[sourceChannel * n + (y * factor + dy) * rgb.width + x * factor + dx]
        }
        planes[c][y * w + x] = Math.max(0, s / (factor * factor) - pedestalValue) * wb[c]
      }
    }
  }
  // For the sky, the background of each color (the median) is removed and the
  // image is stretched with a stronger root: this way the color of the objects can be judged.
  if (sky) {
    for (const plane of planes) {
      const m = Array.from(plane.filter((_, i) => i % 13 === 0)).sort((a, b) => a - b)[0 | (plane.length / 26)]
      for (let i = 0; i < plane.length; i++) plane[i] = Math.max(0, plane[i] - m)
    }
  }
  // White point: the 99.5th percentile of green.
  const sample = Array.from(planes[1].filter((_, i) => i % 13 === 0)).sort((a, b) => a - b)
  const white = sample[Math.floor(sample.length * 0.995)] || 1
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(255 * Math.min(1, Math.pow(planes[c][i] / white, sky ? 1 / 4 : 1 / 2.2)))
    rgba[i * 4 + 3] = 255
  }
  writeFileSync(path, encodePng(w, h, rgba))
}

async function main(): Promise<void> {
  // In Node the .wasm file is read from node_modules; in the program
  // it is supplied by `prepareRawInBrowser`.
  const wasm = readFileSync(join('node_modules', '@colorhythm', 'libraw-wasm', 'dist', 'libraw.wasm'))
  const t0 = performance.now()
  await prepareRaw(wasm)
  console.log('LibRaw ' + LibRaw.version() + ' ready in ' + (performance.now() - t0).toFixed(0) + ' ms, ' + LibRaw.cameraCount() + ' known cameras')
  const module = await LibRaw.initialize()
  const heapWasm = (): number => (module as unknown as { HEAPU8: Uint8Array }).HEAPU8.length / MB
  // A second decoder, for the reference read with a copy.
  const reference = new LibRaw()
  await reference.waitUntilReady()
  for (let i = 0; i < 50 && reference.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 0))

  const file = readdirSync(folder)
    .filter((f) => statSync(join(folder, f)).isFile())
    .sort()
  const light: { name: string; r: FitsReadResult }[] = []

  let countedItems = 0
  for (const name of file) {
    const byte = new Uint8Array(readFileSync(join(folder, name)))
    if (!isRaw(byte, name)) continue
    if (countedItems++ >= max) break
    console.log('\n== ' + name + ' (' + (byte.length / MB).toFixed(1) + ' MB)')
    try {
      const ta = performance.now()
      const head = readRawHeader(byte, name)
      const tb = performance.now()
      const r = readRaw(byte, name)
      const tc = performance.now()
      const m = r.metadata
      const mp = (r.image.width * r.image.height) / 1e6
      console.log(
        '   ' + r.image.width + ' x ' + r.image.height + ' (' + mp.toFixed(1) + ' MP), channels ' + r.image.channels +
          ', matrix ' + m.raw?.matrix + ' ' + m.bayer + ', format ' + m.raw?.format
      )
      console.log(
        '   times: shooting data ' + (tb - ta).toFixed(0) + ' ms, full decode ' + (tc - tb).toFixed(0) +
          ' ms; memory: process ' + (process.memoryUsage().rss / MB).toFixed(0) + ' MB, WebAssembly ' + heapWasm().toFixed(0) + ' MB'
      )
      console.log(
        '   ' + m.instrument + ' | lens ' + m.telescope + ' | ' + m.exposure + ' s | ISO ' + m.gain +
          ' | focal length ' + m.focalLength + ' mm | temp ' + m.sensorTemp + ' °C | type ' + m.frameType
      )
      console.log('   camera time ' + m.raw?.cameraTime + ' -> DATE-OBS (UTC) ' + m.dateObs)
      console.log(
        '   black ' + m.raw?.blackLevel + ', saturation ' + m.raw?.whiteLevel + ', pedestal ' +
          m.raw?.pedestal.toFixed(4) + ', camera white ' + (m.raw?.whiteBalance?.map((v) => v.toFixed(3)).join('/') ?? '-')
      )

      check(head.width === r.image.width && head.height === r.image.height, 'different size between header and full read')
      check(head.metadata.exposure === m.exposure && head.metadata.gain === m.gain, 'different shooting data between header and full read')
      check(r.image.data.length === r.image.width * r.image.height * r.image.channels, 'data length')
      check(m.instrument !== null && m.exposure !== null && m.dateObs !== null, 'camera, exposure or date missing')
      check(m.raw !== undefined, 'RAW data missing from the metadata')
      check(Math.abs(rawMemory() / MB - heapWasm()) < 1e-6 && rawMemory() > 0, 'rawMemory does not report the LibRaw memory')

      // Pixels without a copy against pixels with the package copy: bit for bit.
      const ref = r.image.channels === 1 ? referenceWithCopy(reference, byte) : null
      if (ref !== null) {
        const equal = sameBytes(ref, r.image.data)
        console.log('   pixels without a copy ' + (equal ? 'identical bit for bit' : 'DIFFERENT') + ' to those with the package copy')
        check(equal, 'pixels differ from the read with the package copy')
      }

      // Embedded preview, for the temporary library thumbnail.
      const td = performance.now()
      const ant = readRawPreview(byte, name, THUMBNAIL_SIDE)
      const te = performance.now()
      if (ant === null) {
        console.log('   embedded preview: none suitable (' + (te - td).toFixed(0) + ' ms), decoding will be used')
      } else {
        const useful = Math.min(Math.min(ant.width, ant.height * ant.aspectRatios), Math.min(ant.height, ant.width / ant.aspectRatios))
        console.log(
          '   embedded preview: ' + ant.type + ' ' + ant.width + ' x ' + ant.height + ', ' +
            (ant.byte.length / 1024).toFixed(0) + ' kB, in ' + (te - td).toFixed(0) + ' ms (full decode ' + (tc - tb).toFixed(0) + ' ms)'
        )
        check(useful >= THUMBNAIL_SIDE - 1, 'embedded preview too small')
        check(Math.abs(ant.aspectRatios - r.image.width / r.image.height) < 1e-9, 'wrong preview proportions')
        if (ant.type === 'jpeg') {
          check(ant.byte[0] === 0xff && ant.byte[1] === 0xd8, 'the JPEG preview does not start like a JPEG')
        } else {
          check(ant.byte.length >= ant.width * ant.height * ant.channels, 'pixel preview too short')
          const mini = thumbnailFromPreview(ant.byte, ant.width, ant.height, ant.channels, ant.aspectRatios)
          check(mini === null || (mini.side === THUMBNAIL_SIDE && mini.temporary === true), 'wrong thumbnail from the preview')
        }
      }

      let rgb: ImageData32
      if (r.image.channels === 1) {
        check(m.bayer !== 'NONE' || m.raw?.matrix === 'mono', 'Bayer pattern missing')
        const mr = colorMedian(r, 0)
        const mg = colorMedian(r, 1)
        const mb = colorMedian(r, 2)
        console.log('   raw medians R/G/B ' + mr.toFixed(4) + ' / ' + mg.toFixed(4) + ' / ' + mb.toFixed(4))
        rgb = debayer(r.image, m.bayer)
      } else {
        rgb = r.image
      }
      const pedestalValue = m.raw?.pedestal ?? 0
      const wb = m.raw?.whiteBalance
      if (wb && rgb.channels === 3) {
        const mR = planeMean(rgb, 0, pedestalValue) * wb[0]
        const mG = planeMean(rgb, 1, pedestalValue)
        const mB = planeMean(rgb, 2, pedestalValue) * wb[2]
        const swapped = (planeMean(rgb, 2, pedestalValue) * wb[0]) / mG
        console.log(
          '   gray world (with camera white): R/G ' + (mR / mG).toFixed(2) + ', B/G ' + (mB / mG).toFixed(2) +
            ' (with R and B swapped it would be R/G ' + swapped.toFixed(2) + ')'
        )
      }
      savePreview(rgb, r, join(output, name + '.png'), args.includes('--sky'))
      if (m.frameType === 'light' && withStacking) light.push({ name, r })
    } catch (e) {
      errors++
      console.log('   read ERROR: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  if (withStacking && light.length > 0) await testStacking(light)

  console.log('\n' + (errors === 0 ? 'All checks passed.' : errors + ' checks failed.'))
  process.exit(errors === 0 ? 0 : 1)
}

/** Shifts an image by (dx, dy) whole pixels, filling with the edge. */
function shift(im: ImageData32, dx: number, dy: number): ImageData32 {
  const { width: w, height: h, channels: c } = im
  const out = new Float32Array(im.data.length)
  const n = w * h
  for (let k = 0; k < c; k++) {
    for (let y = 0; y < h; y++) {
      const ys = Math.min(h - 1, Math.max(0, y - dy))
      for (let x = 0; x < w; x++) {
        const xs = Math.min(w - 1, Math.max(0, x - dx))
        out[k * n + y * w + x] = im.data[k * n + ys * w + xs]
      }
    }
  }
  return { width: w, height: h, channels: c, data: out }
}

/** Master from a subfolder (darks, flats, biases), from the RAW files debayered as in the app. */
function master(below: string): ImageData32 | null {
  const dir = join(calibrationFolder as string, below)
  let names: string[] = []
  try {
    names = readdirSync(dir).sort()
  } catch {
    return null
  }
  const frame = names.map((n) => {
    const r = readRaw(new Uint8Array(readFileSync(join(dir, n))), n)
    return debayer(r.image, r.metadata.bayer)
  })
  return frame.length > 0 ? createMaster(frame) : null
}

function median(im: ImageData32): number {
  return computeStats(toLuminance(im)).median
}

/**
 * Calibration with RAW dark, flat and bias: the black pedestal left in the
 * data must disappear with the dark, without the background being clipped to zero.
 */
function testCalibration(lights: ImageData32[]): ImageData32[] {
  console.log('\n== Calibration (' + calibrationFolder + ')')
  const dark = master('darks')
  const bias = master('biases')
  let flat = master('flats')
  if (flat && bias) flat = calibrate(flat, { bias })
  console.log('   medians: light ' + median(lights[0]).toFixed(4) + ', dark ' + (dark ? median(dark).toFixed(4) : '-') + ', bias ' + (bias ? median(bias).toFixed(4) : '-') + ', flat ' + (flat ? median(flat).toFixed(4) : '-'))
  const calibratedFrames = lights.map((l) => calibrate(l, { dark, flat, bias, correctDefectivePixels: dark !== null }))
  const c = calibratedFrames[0]
  let zeros = 0
  for (let i = 0; i < c.data.length; i++) if (c.data[i] === 0) zeros++
  const m = median(c)
  console.log('   calibrated light: median ' + m.toFixed(4) + ', pixels clipped to zero ' + ((100 * zeros) / c.data.length).toFixed(2) + ' %')
  check(m > 0 && m < median(lights[0]), 'the calibrated background must stay positive and go down')
  check(zeros / c.data.length < 0.05, 'too many pixels clipped to zero after calibration')
  return calibratedFrames
}

async function testStacking(light: { name: string; r: FitsReadResult }[]): Promise<void> {
  console.log('\n== Stacking')
  const first = light[0].r
  let images: ImageData32[]
  let expected: { dx: number; dy: number }[] | null = null
  if (light.length >= 2) {
    images = light.map((l) => debayer(l.r.image, l.r.metadata.bayer))
    if (calibrationFolder) images = testCalibration(images)
    console.log('   ' + light.length + ' real lights')
  } else {
    // The shifts are even: the Bayer matrix stays in phase.
    const base = debayer(first.image, first.metadata.bayer)
    expected = [
      { dx: 0, dy: 0 },
      { dx: 6, dy: -4 },
      { dx: -10, dy: 8 }
    ]
    images = expected.map((s) => shift(base, s.dx, s.dy))
    console.log('   a single light: three copies shifted by ' + expected.map((s) => s.dx + ',' + s.dy).join(' / '))
  }
  const stars = images.map((im) => detectStars(im))
  console.log('   stars found: ' + stars.map((s) => s.length).join(', '))
  const frame: FrameToStack[] = []
  for (let i = 0; i < images.length; i++) {
    const t =
      i === 0
        ? { transformation: IDENTITY_TRANSFORMATION, valid: true, matchingStars: stars[0].length, meanError: 0 }
        : align(requiredStars(stars[0]), requiredStars(stars[i]))
    console.log(
      '   frame ' + i + ': valid ' + t.valid + ', tx ' + t.transformation.tx.toFixed(2) + ', ty ' + t.transformation.ty.toFixed(2) +
        ', stars ' + t.matchingStars + ', error ' + t.meanError.toFixed(2) + ' px'
    )
    check(t.valid, 'alignment of frame ' + i)
    if (expected) {
      // The transformation brings the frame onto the reference: the opposite of the shift.
      check(
        Math.abs(t.transformation.tx + expected[i].dx) < 0.5 && Math.abs(t.transformation.ty + expected[i].dy) < 0.5,
        'the recovered shift is not the one applied in frame ' + i
      )
    }
    if (t.valid) frame.push({ image: images[i], transformation: t.transformation, weight: 1 })
  }
  if (frame.length < 2) return
  const t0 = performance.now()
  const result = stack(frame)
  console.log('   stacked ' + frame.length + ' frames in ' + (performance.now() - t0).toFixed(0) + ' ms')
  const noise = (im: ImageData32): number => computeStats(toLuminance(im)).mad * MAD_TO_SIGMA
  console.log('   background noise: single ' + noise(images[0]).toExponential(3) + ', stacked ' + noise(result.image).toExponential(3))
  savePreview(result.image, first, join(output, 'stacked.png'), true, calibrationFolder !== null)
}

void main()
