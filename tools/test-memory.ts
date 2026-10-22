/**
 * Check of memory handling with large sensors, in the parts that do not
 * need Electron:
 *  - advance estimate for stacking (core/memoryEstimate.ts): cases that
 *    fit, cases where fewer workers are used, cases where it stops before
 *    starting, with the number of frames that would fit;
 *  - viewer texture (core/image/viewerTexture.ts): reduction factor for
 *    the maximum side of the graphics card, identical values at factor 1,
 *    block means otherwise;
 *  - in-place computations introduced to save copies: they must give the
 *    same result, bit for bit, as those with the copy (calibration with
 *    nearby defective pixels, color reconstruction in shared memory, FITS
 *    normalization, deconvolution of a stripe);
 *  - compact frames (core/stack/compactFrame.ts): color reconstruction,
 *    deferred calibration also in pieces, analysis, sum with all the
 *    methods, tiled and banded, drizzle and Bayer drizzle, always bit for
 *    bit identical to frames kept whole; their weight in the estimate;
 *  - library masters kept compact: rebuilt, defective pixels, flat means,
 *    calibration of whole and compact frames (also in pieces), sum and
 *    drizzle, bit for bit identical to whole masters.
 *
 *   node tools/run-tests.mjs --only memory
 */
import { estimateStacking, usableMemory, compactPlanes, masterPiecesBytes, type FrameToEstimate, type EstimateRequest } from '../src/core/memoryEstimate'
import { texturePlane, textureRows } from '../src/core/image/viewerTexture'
import { calibrate, defectMap, flatMeans } from '../src/core/stack/calibration'
import { dequantize, usableMaster, quantize, unmosaic } from '../src/core/stack/calibrationLibrary'
import { debayer, toLuminance } from '../src/core/image/debayer'
import { sharedFloat32, isShared } from '../src/shared/sharedMemory'
import { readFits } from '../src/core/fits/reader'
import { encodeFits } from '../src/core/export/encoding'
import { detectStars } from '../src/core/stars/detection'
import { deconvolve } from '../src/core/image/deconvolution'
import type { BayerPattern, ImageData32 } from '../src/shared/types'
import { compact, expand, compactMaster, rebuildRegion, deferredCalibration, type CompactImage, type HeldImage, type KeptMaster } from '../src/core/stack/compactFrame'
import { analyzeContent } from '../src/core/stack/frameAnalysis'
import { stack, stackBand, type FrameToStack, type RejectionMap, type StackingOptions } from '../src/core/stack/stacking'
import { drizzle, type DrizzleOptions } from '../src/core/stack/drizzle'

let errors = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? 'ok   ' : 'NO   ') + name + (detail ? '  (' + detail + ')' : ''))
  if (!ok) errors++
}

const GB = 1073741824

/* ---- Advance estimate ---- */

function frame(mp: '2' | '26' | '61', count: number, raw = false): FrameToEstimate[] {
  const [l, a] = mp === '2' ? [1920, 1080] : mp === '26' ? [6248, 4176] : [9576, 6388]
  return Array.from({ length: count }, () => ({ width: l, height: a, channels: 3 as const, fileBytes: l * a * 2 + 5760, raw }))
}

function request(f: FrameToEstimate[], freeGB: number, extra: Partial<EstimateRequest> = {}): EstimateRequest {
  return { frame: f, workers: 12, mastersToLoad: 0, sums: 1, freeMemory: freeGB * GB, recoverableMemory: 0, ...extra }
}

function testEstimate(): void {
  // It fits: 100 frames of 2 MP with 8 GB free.
  const a = estimateStacking(request(frame('2', 100), 8))
  result('2 MP x 100 with 8 GB free: all 12 workers, no notice', a.workers === 12 && a.notice === undefined,
    gb(a.neededItems) + ' of ' + gb(a.usable))

  // It fits by reducing the workers: 20 frames of 61 MP with 24 GB free.
  const b = estimateStacking(request(frame('61', 20), 24))
  result('61 MP x 20 with 24 GB free: fewer workers, with a notice', b.workers >= 1 && b.workers < 12 && b.notice !== undefined,
    b.workers + ' workers, ' + gb(b.neededItems) + ' of ' + gb(b.usable))
  result('the notice says how many processes and why', /l’analisi usa \d+ process[oi] invece di 12/.test(b.notice ?? '') && /61 megapixel/.test(b.notice ?? ''), b.notice)
  result('the estimate with the chosen workers fits in the usable memory', b.neededItems <= b.usable)

  // It does not fit: 60 frames of 61 MP with 24 GB free.
  const c = estimateStacking(request(frame('61', 60), 24))
  result('61 MP x 60 with 24 GB free: stopped before starting', c.workers === 0 && c.notice !== undefined, c.notice)
  result('it says how many frames fit', c.maxFrames >= 2 && c.maxFrames < 60 && (c.notice ?? '').includes('Ne stanno al massimo ' + c.maxFrames))
  // The maximum frames really fit, and one more does not.
  const correctValues = estimateStacking(request(frame('61', c.maxFrames), 24))
  const oneMore = estimateStacking(request(frame('61', c.maxFrames + 1), 24))
  result('with the maximum frames it starts (at least one worker), with one more it does not', correctValues.workers >= 1 && oneMore.workers === 0,
    c.maxFrames + ' frames')

  // Not even two frames.
  const d = estimateStacking(request(frame('61', 10), 2))
  result('61 MP with 2 GB free: stopped, "not even two frames"', d.workers === 0 && /nemmeno due frame/.test(d.notice ?? ''), d.notice)

  // The cache of open frames is freed only if needed.
  const e = estimateStacking(request(frame('26', 30), 12, { recoverableMemory: 8 * GB }))
  const e2 = estimateStacking(request(frame('26', 30), 30, { recoverableMemory: 8 * GB }))
  result('memory of open frames: freed when needed to fit', e.workers >= 1 && e.freeCache, gb(e.neededItems))
  result('memory of open frames: left alone when not needed', e2.workers === 12 && !e2.freeCache)

  // Library masters and comet/HDR weigh.
  const without = estimateStacking(request(frame('26', 30), 64))
  const withMaster = estimateStacking(request(frame('26', 30), 64, { mastersToLoad: 2 }))
  result('library masters enter the estimate', withMaster.neededItems > without.neededItems)
  const withHdr = estimateStacking(request(frame('26', 2), 16, { sums: 4, workers: 1 }))
  const withoutHdr = estimateStacking(request(frame('26', 2), 16, { workers: 1 }))
  result('the HDR sums enter the estimate', withHdr.neededItems > withoutHdr.neededItems)

  // RAW files need more per worker.
  const r1 = estimateStacking(request(frame('61', 10, true), 64, { workers: 4 }))
  const r0 = estimateStacking(request(frame('61', 10, false), 64, { workers: 4 }))
  result('RAW files need more memory per worker', r1.workers === 4 && r1.neededItems > r0.neededItems, gb(r1.neededItems) + ' versus ' + gb(r0.neededItems))

  result('reserve: at least 1 GB, and 15% of the memory', usableMemory(4 * GB, 0) === 3 * GB && usableMemory(20 * GB, 0) === 17 * GB)
}

function gb(b: number): string {
  return (b / GB).toFixed(1) + ' GB'
}

/* ---- Viewer texture ---- */

function testTexture(): void {
  const p1 = texturePlane(9576, 6388, 16384)
  result('61 MP fits the 16384 side without reduction', p1.factor === 1 && p1.width === 9576)
  const p2 = texturePlane(9576 * 2, 6388 * 2, 16384)
  result('2x drizzle from 61 MP: reduced by 2 (9576 x 6388)', p2.factor === 2 && p2.width === 9576 && p2.height === 6388)
  const p3 = texturePlane(8256 * 3, 5504 * 3, 16384)
  result('3x drizzle from 45 MP: reduced by 2 (12384 x 8256)', p3.factor === 2 && p3.width <= 16384 && p3.height <= 16384,
    p3.width + ' x ' + p3.height)
  const p4 = texturePlane(5000, 3000, 4096, 2)
  result('minimum factor respected (retry after memory exhausted)', p4.factor === 2 && p4.width === 2500)

  // Factor 1: the values are the previous ones (interleaved), identical.
  const w = 37
  const h = 23
  const n = w * h
  const img: ImageData32 = { width: w, height: h, channels: 3, data: new Float32Array(n * 3).map((_, i) => Math.sin(i * 0.37) * 0.5 + 0.5) }
  const old = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    old[i * 3] = img.data[i]
    old[i * 3 + 1] = img.data[n + i]
    old[i * 3 + 2] = img.data[2 * n + i]
  }
  const plane = texturePlane(w, h, 4096)
  const newValue = new Float32Array(n * 3)
  // In irregular stripes, as in the viewer.
  const stripe = new Float32Array(w * 5 * 3)
  for (let y = 0; y < h; y += 5) {
    const end = Math.min(h, y + 5)
    textureRows(img, plane, y, end, stripe)
    newValue.set(stripe.subarray(0, w * (end - y) * 3), y * w * 3)
  }
  result('factor 1 in stripes: identical to the whole interleaving', newValue.every((v, i) => v === old[i]))

  // Factor 2: block mean, edges included (37 and 23 are odd).
  const p = texturePlane(w, h, 20)
  const reduced = new Float32Array(p.width * p.height * 3)
  textureRows(img, p, 0, p.height, reduced)
  let max = 0
  for (let Y = 0; Y < p.height; Y++) {
    for (let X = 0; X < p.width; X++) {
      for (let c = 0; c < 3; c++) {
        let s = 0
        let q = 0
        for (let y = Y * 2; y < Math.min(h, Y * 2 + 2); y++) {
          for (let x = X * 2; x < Math.min(w, X * 2 + 2); x++) {
            s += img.data[c * n + y * w + x]
            q++
          }
        }
        max = Math.max(max, Math.abs(reduced[(Y * p.width + X) * 3 + c] - s / q))
      }
    }
  }
  result('factor 2: block mean, also at the edges', p.factor === 2 && p.width === 19 && p.height === 12 && max < 1e-6, 'difference ' + max)

  const mono: ImageData32 = { width: w, height: h, channels: 1, data: img.data.slice(0, n) }
  const m = new Float32Array(n)
  textureRows(mono, plane, 0, h, m)
  result('monochrome at factor 1: identical', m.every((v, i) => v === mono.data[i]))
}

/* ---- In-place computations: identical to those with the copy ---- */

function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function equal(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

function testInPlace(): void {
  const w = 160
  const h = 120
  const n = w * h
  const r = random(42)
  const light = new Float32Array(n * 3).map(() => 0.05 + r() * 0.1)
  const dark = new Float32Array(n * 3).map(() => 0.002 + r() * 0.001)
  // Hot pixels, also close to each other (two steps apart: they would
  // influence each other if the corrections were written immediately).
  for (const [x, y] of [[20, 20], [22, 20], [22, 22], [80, 60], [81, 60], [100, 100], [102, 102]]) {
    for (let c = 0; c < 3; c++) {
      dark[c * n + y * w + x] = 0.4
      light[c * n + y * w + x] = 0.6
    }
  }
  const flat = new Float32Array(n * 3).map((_, i) => 0.5 + 0.1 * Math.cos(i * 0.001))
  const L: ImageData32 = { width: w, height: h, channels: 3, data: light }
  const D: ImageData32 = { width: w, height: h, channels: 3, data: dark }
  const F: ImageData32 = { width: w, height: h, channels: 3, data: flat }
  const opt = { dark: D, flat: F, correctDefectivePixels: true }
  const copy = calibrate(L, opt)
  const shared = sharedFloat32(n * 3)
  shared.set(light)
  const inPlace = calibrate({ ...L, data: shared }, { ...opt, inPlace: true })
  result('in-place calibration identical to the one with the copy (nearby defective pixels)', equal(copy.data, inPlace.data))
  result('in-place calibration: stays in shared memory', inPlace.data === shared && isShared(inPlace.data))
  result('calibration with the copy: the light does not change', equal(light, L.data) && copy.data !== light)

  // Color reconstruction in shared memory.
  const raw: ImageData32 = { width: w, height: h, channels: 1, data: light.slice(0, n) }
  const a = debayer(raw, 'RGGB')
  const b = debayer(raw, 'RGGB', sharedFloat32)
  result('color reconstruction in shared memory: identical', equal(a.data, b.data) && isShared(b.data))

  // FITS read in place and in shared memory: identical to before.
  const fits = new Uint8Array(encodeFits({ width: w, height: h, channels: 3, data: light.map((v) => Math.min(1, v)) }, {}, 16))
  const l1 = readFits(fits, 'test.fit')
  const l2 = readFits(fits, 'test.fit', sharedFloat32)
  result('FITS read in shared memory: identical', equal(l1.image.data, l2.image.data) && isShared(l2.image.data))
  const fits32 = new Uint8Array(encodeFits({ width: w, height: h, channels: 1, data: light.slice(0, n) }, {}, 32))
  const l3 = readFits(fits32, 'test32.fit')
  let allAsExpected = true
  for (let i = 0; i < n; i++) {
    const v = Math.fround(light[i])
    const expected = v > 0 ? (v < 1 ? v : 1) : 0
    if (!Object.is(l3.image.data[i], Math.fround(expected))) allAsExpected = false
  }
  result('32-bit float FITS read normalized in place: expected values', allAsExpected)

  // Stars with the luminance already computed: same result.
  const withStars: ImageData32 = { ...a, data: a.data.slice() }
  for (let k = 0; k < 25; k++) {
    const x = 8 + Math.floor(r() * (w - 16))
    const y = 8 + Math.floor(r() * (h - 16))
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const v = 0.6 * Math.exp(-(dx * dx + dy * dy) / 4)
        for (let c = 0; c < 3; c++) withStars.data[c * n + (y + dy) * w + x + dx] += v
      }
    }
  }
  const starsA = detectStars(withStars)
  const starsB = detectStars(withStars, {}, toLuminance(withStars))
  result('stars with the luminance passed in: same result', starsA.length > 5 && JSON.stringify(starsA) === JSON.stringify(starsB), starsA.length + ' stars')

  // Deconvolution of a stripe in place.
  const imm: ImageData32 = { width: w, height: h, channels: 3, data: light.slice() }
  for (let k = 0; k < 30; k++) {
    const x = 10 + Math.floor(r() * (w - 20))
    const y = 10 + Math.floor(r() * (h - 20))
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const v = 0.5 * Math.exp(-(dx * dx + dy * dy) / 3)
        for (let c = 0; c < 3; c++) imm.data[c * n + (y + dy) * w + x + dx] += v
      }
    }
  }
  const par = { iterations: 8, psfRadius: 0, regularization: 0.5 }
  const d1 = deconvolve(imm, par)
  const d2 = deconvolve({ ...imm, data: imm.data.slice() }, par, undefined, true)
  result('in-place deconvolution identical to the one with the copy', equal(d1.data, d2.data))
}

/* ---- Compact frames: identical to those kept whole ---- */

/** 16-bit test FITS; with `bayer` it declares the pattern in place of the CREATOR card. */
function testFits(im: ImageData32, bayer?: string): Uint8Array {
  const fits = new Uint8Array(encodeFits(im, {}, 16))
  if (bayer) {
    const text = new TextDecoder('latin1').decode(fits.subarray(0, 2880))
    const pos = text.indexOf('CREATOR ')
    const card = ("BAYERPAT= '" + bayer + "    '").padEnd(80, ' ')
    for (let i = 0; i < 80; i++) fits[pos + i] = card.charCodeAt(i)
  }
  return fits
}

/** A synthetic frame: background, gradient, noise and a few stars. */
function sky(w: number, h: number, planes: 1 | 3, seed: number, dx = 0, dy = 0): ImageData32 {
  const r = random(seed)
  const n = w * h
  const data = new Float32Array(n * planes)
  for (let i = 0; i < data.length; i++) {
    const p = i % n
    data[i] = 0.06 + 0.03 * ((p % w) / w) + (r() - 0.5) * 0.01
  }
  const rs = random(7)
  for (let k = 0; k < 30; k++) {
    const sx = 6 + rs() * (w - 12) + dx
    const sy = 6 + rs() * (h - 12) + dy
    const peak = 0.2 + rs() * 0.6
    for (let y = Math.max(0, Math.floor(sy - 5)); y <= Math.min(h - 1, Math.ceil(sy + 5)); y++) {
      for (let x = Math.max(0, Math.floor(sx - 5)); x <= Math.min(w - 1, Math.ceil(sx + 5)); x++) {
        const v = peak * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / 3)
        for (let c = 0; c < planes; c++) data[c * n + y * w + x] = Math.min(1, data[c * n + y * w + x] + v)
      }
    }
  }
  return { width: w, height: h, channels: planes, data }
}

/** Three-channel test masters: dark with hot pixels, also close together, and vignetted flat. */
function sampleMaster(w: number, h: number): { dark: ImageData32; flat: ImageData32 } {
  const n = w * h
  const r = random(99)
  const dark = new Float32Array(n * 3).map(() => 0.002 + r() * 0.001)
  for (const [x, y] of [[20, 20], [22, 20], [22, 22], [80, 60], [81, 60], [100, 100], [102, 102], [2, 2], [w - 3, h - 3]]) {
    for (let c = 0; c < 3; c++) dark[c * n + y * w + x] = c === 1 ? 0.3 : 0.45
  }
  const flat = new Float32Array(n * 3).map((_, i) => {
    const p = i % n
    const x = (p % w) / w - 0.5
    const y = Math.floor(p / w) / h - 0.5
    return 0.5 * (1 - 0.4 * (x * x + y * y))
  })
  // A nearly black flat point: the division is skipped.
  flat[n + 50 * w + 50] = 0.001
  return { dark: { width: w, height: h, channels: 3, data: dark }, flat: { width: w, height: h, channels: 3, data: flat } }
}

function testCompact(): void {
  // Odd sizes, to test the edges of the color reconstruction.
  const w = 203
  const h = 157
  const n = w * h

  // 16-bit Bayer mosaic, with all the patterns.
  for (const schema of ['RGGB', 'BGGR', 'GRBG', 'GBRG'] as const) {
    const readResult = readFits(testFits(sky(w, h, 1, 1)), 'test.fit')
    const expected = debayer(readResult.image, schema)
    const c = compact(readResult.image, schema, [65535])
    result('compact ' + schema + ': rebuilt identical to debayer', c !== null && c.codes.length === n && equal(expand(c).data, expected.data))
  }
  // Mono and three planes: the values are the ones read.
  const mono = readFits(testFits(sky(w, h, 1, 2)), 'mono.fit')
  const cm = compact(mono.image, 'NONE', [65535])
  result('compact mono: identical to what was read', cm !== null && cm.channels === 1 && equal(expand(cm).data, mono.image.data))
  const rgb = readFits(testFits(sky(w, h, 3, 3)), 'rgb.fit')
  const cr = compact(rgb.image, 'NONE', [65535])
  result('compact three-plane: identical to what was read', cr !== null && cr.planes === 3 && equal(expand(cr).data, rgb.image.data))
  // Floating point data is not reduced.
  const real = readFits(new Uint8Array(encodeFits(sky(w, h, 1, 4), {}, 32)), 'float.fit')
  result('32-bit float FITS: stays whole', compact(real.image, 'NONE', [65535, 255]) === null)
  // With 8 bits (values k/255) it is reduced with the right scale, identical.
  const eight = new Float32Array(n).map((_, i) => Math.fround(((i * 7) % 256) * (1 / 255)))
  const c8 = compact({ width: w, height: h, channels: 1, data: eight }, 'NONE', [255])
  result('8-bit values: compact with scale 255, identical', c8 !== null && equal(expand(c8).data, eight))
  // As the RAW reader writes them: (raw − cell black) / saturation.
  const white = 15520
  const inv = 1 / white
  const rg = random(11)
  const rawRaws = new Float32Array(n).map((_, i) => {
    const v = (Math.floor(rg() * 16383) - ((i % w) & 1 ? 2 : 0)) * inv
    return v < 0 ? 0 : v > 1 ? 1 : v
  })
  const craw = compact({ width: w, height: h, channels: 1, data: rawRaws }, 'RGGB', [white, 65535])
  result('RAW values: compact with the saturation as scale, identical',
    craw !== null && craw.fullScale === white && equal(expand(craw).data, debayer({ width: w, height: h, channels: 1, data: rawRaws }, 'RGGB').data))

  // The workers' analysis: same measurements with the compact or whole frame.
  const fitsBayer = testFits(sky(w, h, 1, 5), 'RGGB')
  const wholeAnalysis = analyzeContent({ buffer: fitsBayer.slice().buffer }, 'b.fit', true, false)
  const compactAnalysis = analyzeContent({ buffer: fitsBayer.slice().buffer }, 'b.fit', true, true)
  result('analysis: compact frame when the file allows it', compactAnalysis.compact !== null && compactAnalysis.image === null && wholeAnalysis.compact === null)
  result('analysis: same stars, statistics and quality with the compact frame',
    JSON.stringify([wholeAnalysis.stars, wholeAnalysis.stats, wholeAnalysis.quality, wholeAnalysis.hfr, wholeAnalysis.bayerPattern]) ===
      JSON.stringify([compactAnalysis.stars, compactAnalysis.stats, compactAnalysis.quality, compactAnalysis.hfr, compactAnalysis.bayerPattern]),
    wholeAnalysis.stars.length + ' stars')
  result('analysis: the rebuilt compact frame is the whole one',
    compactAnalysis.compact !== null && wholeAnalysis.image !== null && equal(expand(compactAnalysis.compact).data, wholeAnalysis.image.data))

  // Deferred calibration: identical to calibrate on the rebuilt frame, also in pieces.
  const { dark, flat } = sampleMaster(w, h)
  const raw = readFits(fitsBayer, 'b.fit').image
  const calibratedItem = calibrate(debayer(raw, 'RGGB'), { dark, flat, correctDefectivePixels: true })
  const cc = deferredCalibration(compact(raw, 'RGGB', [65535]) as CompactImage, { dark, flat, bias: null })
  result('deferred calibration: rebuilt frame identical to the calibrated one', equal(expand(cc).data, calibratedItem.data))
  const r = random(5)
  let equalPieces = true
  const rectangles: [number, number, number, number][] = [[0, 0, w, h], [0, 0, 5, 5], [w - 7, h - 4, w, h], [18, 18, 24, 24], [79, 58, 83, 63], [1, 1, 3, 3]]
  for (let k = 0; k < 40; k++) {
    const x0 = Math.floor(r() * (w - 1))
    const y0 = Math.floor(r() * (h - 1))
    rectangles.push([x0, y0, x0 + 1 + Math.floor(r() * (w - x0 - 1)), y0 + 1 + Math.floor(r() * (h - y0 - 1))])
  }
  for (const [x0, y0, x1, y1] of rectangles) {
    const rw = x1 - x0
    const nr = rw * (y1 - y0)
    const piece = new Float32Array(nr * 3)
    rebuildRegion(cc, x0, y0, x1, y1, piece)
    for (let c = 0; c < 3 && equalPieces; c++) {
      for (let y = y0; y < y1 && equalPieces; y++) {
        for (let x = x0; x < x1; x++) {
          if (!Object.is(piece[c * nr + (y - y0) * rw + (x - x0)], calibratedItem.data[c * n + y * w + x])) {
            equalPieces = false
            break
          }
        }
      }
    }
  }
  result('deferred calibration in pieces (edges, nearby hot pixels): identical', equalPieces, rectangles.length + ' rectangles')
  const cb = deferredCalibration(compact(raw, 'RGGB', [65535]) as CompactImage, { dark: null, flat, bias: dark })
  result('deferred calibration with bias and flat: identical', equal(expand(cb).data, calibrate(debayer(raw, 'RGGB'), { flat, bias: dark }).data))
  let differentDimensions = ''
  try {
    deferredCalibration(cc, { dark: { ...dark, width: w - 1 }, flat: null, bias: null })
  } catch (e) {
    differentDimensions = e instanceof Error ? e.message : String(e)
  }
  result('deferred calibration: master of another size rejected as calibrate does', /dimensioni diverse/.test(differentDimensions))

  // Sum: compact frames against the same whole ones, bit for bit.
  const count = 7
  const compactItems: HeldImage[] = []
  for (let f = 0; f < count; f++) {
    const l = readFits(testFits(sky(w, h, 1, 10 + f, f * 0.7, -f * 0.4)), 'f.fit').image
    const c = compact(l, 'RGGB', [65535]) as CompactImage
    compactItems.push(f % 3 === 2 ? c : deferredCalibration(c, { dark, flat, bias: null }))
  }
  const angle = (g: number): { a: number; b: number } => ({ a: Math.cos((g * Math.PI) / 180), b: Math.sin((g * Math.PI) / 180) })
  const transformations = [
    { a: 1, b: 0, tx: 0, ty: 0 },
    { a: 1, b: 0, tx: 0.7, ty: -0.4 },
    { ...angle(0.4), tx: 1.4, ty: -0.8 },
    { ...angle(-3), tx: 5, ty: 3 },
    { a: 1.001, b: 0.002, tx: -2.2, ty: 1.3 },
    { ...angle(90), tx: w, ty: 0 },
    { a: 1, b: 0, tx: 30, ty: -20 }
  ]
  const withFrame = (images: HeldImage[]): FrameToStack[] =>
    images.map((image, i) => ({
      image,
      transformation: transformations[i],
      weight: 0.4 + i * 0.1,
      normalization: i === 3 ? { scale: [1.1, 0.9, 1.05], shift: [0.01, -0.02, 0] } : undefined
    }))
  const integers = compactItems.map((c) => expand(c))
  // A whole frame among the compact ones: the sum accepts them together.
  const mixed = compactItems.map((c, i) => (i === 4 ? integers[i] : c))
  for (const [name, options] of [
    ['mean', { method: 'mean', rejectionThreshold: 3 }],
    ['median', { method: 'median', rejectionThreshold: 3 }],
    ['rejection', { method: 'rejection', rejectionThreshold: 2 }],
    ['weighted rejection (several nights)', { method: 'rejection', rejectionThreshold: 2.5, weightsInRejection: true }]
  ] as [string, StackingOptions][]) {
    const map = (): RejectionMap => ({ center: new Float32Array(n * 3), limit: new Float32Array(n * 3) })
    const mi = map()
    const expected = stack(withFrame(integers), options, undefined, mi)
    let everything = true
    for (const [source, side] of [[compactItems, undefined], [compactItems, 16], [mixed, 23]] as [HeldImage[], number | undefined][]) {
      const mc = map()
      const output = new Float32Array(n * 3)
      const e = stackBand({ frame: withFrame(source), options, yStart: 0, yEnd: h, output, rejectionMap: mc, tileSide: side })
      everything &&=
        equal(output, expected.image.data) && equal(mc.center, mi.center) && equal(mc.limit, mi.limit) &&
        e.rejectedValues === expected.rejectedValues && e.contributions / (n * 3) === expected.meanContribution
    }
    // In bands, as in the workers.
    const bands = new Float32Array(n * 3)
    for (let y = 0; y < h; y += 40) stackBand({ frame: withFrame(compactItems), options, yStart: y, yEnd: y + 40, output: bands, tileSide: 31 })
    everything &&= equal(bands, expected.image.data)
    result('sum of compact frames identical to that of whole frames: ' + name, everything)
  }

  // Drizzle and Bayer drizzle.
  const opt: StackingOptions = { method: 'rejection', rejectionThreshold: 3 }
  for (const [name, d, schema] of [
    ['drizzle 2×', { factor: 2, pixfrac: 0.7 }, undefined],
    ['Bayer drizzle 1×', { factor: 1, pixfrac: 0.9, bayer: true }, 'RGGB']
  ] as [string, DrizzleOptions, BayerPattern | undefined][]) {
    const a = drizzle(withFrame(integers), opt, d, schema)
    const b = drizzle(withFrame(compactItems), opt, d, schema)
    result('drizzle of compact frames identical: ' + name,
      equal(a.image.data, b.image.data) && equal(a.coverage, b.coverage) && a.rejectedValues === b.rejectedValues)
  }

  // Estimate: a compact frame weighs its codes, not the whole frame.
  const library = (compactValue?: 1 | 3): FrameToEstimate[] =>
    Array.from({ length: 300 }, () => ({ width: 1920, height: 1080, channels: 3 as const, fileBytes: 1920 * 1080 * 2 + 5760, raw: false, compactValue }))
  const estimateIntegers = estimateStacking(request(library(), 5, { workers: 4 }))
  const compactEstimate = estimateStacking(request(library(1), 5, { workers: 4 }))
  result('estimate: 300 frames of 2 MP with 5 GB free, whole no, compact yes', estimateIntegers.workers === 0 && compactEstimate.workers >= 1,
    gb(estimateIntegers.neededItems) + ' versus ' + gb(compactEstimate.neededItems))
  result('estimate: with compact frames many more fit', compactEstimate.maxFrames > 4 * estimateIntegers.maxFrames,
    estimateIntegers.maxFrames + ' versus ' + compactEstimate.maxFrames)
  const comet = estimateStacking(request(library(1), 5, { workers: 4, expanded: true }))
  result('estimate: with the comet the compact frames also weigh as whole', comet.neededItems > compactEstimate.neededItems + 300 * 1920 * 1080 * 11)
  result('compact planes: 16-bit Bayer FITS 1, color TIFF 3, floats and unusual scales no, X-Trans no',
    compactPlanes({ bitpix: 16, fileChannels: 1, bayer: 'RGGB', raw: false }) === 1 &&
      compactPlanes({ bitpix: 16, fileChannels: 3, bayer: 'NONE', raw: false }) === 3 &&
      compactPlanes({ bitpix: -32, fileChannels: 1, bayer: 'RGGB', raw: false }) === undefined &&
      compactPlanes({ bitpix: 16, fileChannels: 1, bayer: 'NONE', raw: false, bscale: 2 }) === undefined &&
      compactPlanes({ bitpix: 16, fileChannels: 1, bayer: 'NONE', raw: false, bzero: 0.5 }) === undefined &&
      compactPlanes({ bitpix: 16, fileChannels: 3, bayer: 'NONE', raw: true }) === undefined &&
      compactPlanes({ bitpix: 16, fileChannels: 1, bayer: 'GRBG', raw: true, bzero: 32768 }) === 1)
}

/**
 * A master as the library keeps it (sensor format, 16 bit) and
 * as calibration uses it: whole (`usableMaster` of the dequantized
 * values) and compact.
 */
function libraryMasters(m: ImageData32, schema: BayerPattern): { whole: ImageData32; compactValue: CompactImage } {
  const kept = unmosaic(m, schema)
  const q = quantize(kept.data)
  const whole = usableMaster({ ...kept, data: dequantize(q.values, q.minimum, q.max) }, schema)
  const compactValue = compactMaster({ width: m.width, height: m.height, planes: kept.channels, codes: q.values }, schema, q.minimum, q.max)
  return { whole, compactValue }
}

function testCompactMasters(): void {
  const w = 203
  const h = 157
  const n = w * h
  const test = sampleMaster(w, h)
  const dark = libraryMasters(test.dark, 'RGGB')
  const flat = libraryMasters(test.flat, 'RGGB')
  result('compact master: 2 bytes per pixel, rebuilt identical to the whole master',
    dark.compactValue.codes.byteLength === n * 2 && equal(expand(dark.compactValue).data, dark.whole.data) && equal(expand(flat.compactValue).data, flat.whole.data))
  const rgb = libraryMasters(test.dark, 'NONE')
  const monoM: ImageData32 = { width: w, height: h, channels: 1, data: test.flat.data.slice(0, n) }
  const mono = libraryMasters(monoM, 'NONE')
  result('compact master three-plane and mono: identical',
    rgb.compactValue.planes === 3 && equal(expand(rgb.compactValue).data, rgb.whole.data) && mono.compactValue.channels === 1 && equal(expand(mono.compactValue).data, mono.whole.data))

  const md = defectMap(dark.whole, 6)
  const mc = defectMap(dark.compactValue, 6)
  result('compact master: same defective pixels',
    md.defects === mc.defects && md.pixel.length === mc.pixel.length && md.planes.every((v, i) => v === mc.planes[i]), md.defects + ' defects')
  result('compact master: same flat means',
    JSON.stringify(flatMeans(flat.whole, 3, n)) === JSON.stringify(flatMeans(flat.compactValue, 3, n)) &&
      JSON.stringify(flatMeans(mono.whole, 1, n)) === JSON.stringify(flatMeans(mono.compactValue, 1, n)) &&
      JSON.stringify(flatMeans(mono.whole, 3, n)) === JSON.stringify(flatMeans(mono.compactValue, 3, n)))

  // Whole frames (for example floating point) calibrated with the compact masters.
  const fitsBayer = testFits(sky(w, h, 1, 5), 'RGGB')
  const raw = readFits(fitsBayer, 'b.fit').image
  const light = debayer(raw, 'RGGB')
  const integers = { dark: dark.whole, flat: flat.whole }
  const compactItems = { dark: dark.compactValue, flat: flat.compactValue }
  const expected = calibrate(light, { ...integers, correctDefectivePixels: true })
  const copy = calibrate(light, { ...compactItems, correctDefectivePixels: true })
  const inPlace = calibrate({ ...light, data: light.data.slice() }, { ...compactItems, correctDefectivePixels: true, inPlace: true })
  result('calibration of a whole frame with the compact masters: identical (with the copy and in place)',
    equal(copy.data, expected.data) && equal(inPlace.data, expected.data))
  result('calibration with compact bias and flat: identical',
    equal(calibrate(light, { bias: dark.compactValue, flat: flat.compactValue }).data, calibrate(light, { bias: dark.whole, flat: flat.whole }).data))
  result('calibration with compact three-plane masters: identical',
    equal(calibrate(light, { dark: rgb.compactValue, correctDefectivePixels: true }).data, calibrate(light, { dark: rgb.whole, correctDefectivePixels: true }).data))

  // Compact frames with deferred calibration: whole and in pieces.
  const cc = deferredCalibration(compact(raw, 'RGGB', [65535]) as CompactImage, { ...compactItems, bias: null })
  result('deferred calibration with compact masters: rebuilt frame identical', equal(expand(cc).data, expected.data))
  const r = random(8)
  let equalPieces = true
  const rectangles: [number, number, number, number][] = [[0, 0, w, h], [0, 0, 5, 5], [w - 7, h - 4, w, h], [18, 18, 24, 24], [79, 58, 83, 63], [1, 1, 3, 3]]
  for (let k = 0; k < 40; k++) {
    const x0 = Math.floor(r() * (w - 1))
    const y0 = Math.floor(r() * (h - 1))
    rectangles.push([x0, y0, x0 + 1 + Math.floor(r() * (w - x0 - 1)), y0 + 1 + Math.floor(r() * (h - y0 - 1))])
  }
  for (const [x0, y0, x1, y1] of rectangles) {
    const rw = x1 - x0
    const nr = rw * (y1 - y0)
    const piece = new Float32Array(nr * 3)
    rebuildRegion(cc, x0, y0, x1, y1, piece)
    for (let c = 0; c < 3 && equalPieces; c++) {
      for (let y = y0; y < y1 && equalPieces; y++) {
        for (let x = x0; x < x1; x++) {
          if (!Object.is(piece[c * nr + (y - y0) * rw + (x - x0)], expected.data[c * n + y * w + x])) {
            equalPieces = false
            break
          }
        }
      }
    }
  }
  result('deferred calibration with compact masters, in pieces: identical', equalPieces, rectangles.length + ' rectangles')
  // After the pieces of the sum (enlarged and reused), the calibrate stripes re-read the same pieces.
  rebuildRegion(cc, 0, 0, w, h, new Float32Array(n * 3))
  rebuildRegion(cc, 0, 0, w, h, new Float32Array(n * 3))
  const m5i = defectMap(dark.whole, 5)
  const m5c = defectMap(dark.compactValue, 5)
  result('defective pixels after the pieces of the sum: identical', m5i.defects === m5c.defects && m5i.planes.every((v, i) => v === m5c.planes[i]))
  result('striped calibration after the pieces of the sum: identical', equal(calibrate(light, { ...compactItems, correctDefectivePixels: true }).data, expected.data))

  // Sum and drizzle: compact masters against whole ones, bit for bit.
  const count = 6
  const withMaster = (m: { dark: KeptMaster; flat: KeptMaster }): HeldImage[] =>
    Array.from({ length: count }, (_, f) => {
      const l = readFits(testFits(sky(w, h, 1, 30 + f, f * 0.7, -f * 0.4)), 'f.fit').image
      return deferredCalibration(compact(l, 'RGGB', [65535]) as CompactImage, { ...m, bias: null })
    })
  const fi = withMaster(integers)
  const fc = withMaster(compactItems)
  const transformations = [
    { a: 1, b: 0, tx: 0, ty: 0 },
    { a: 1, b: 0, tx: 0.7, ty: -0.4 },
    { a: Math.cos(0.007), b: Math.sin(0.007), tx: 1.4, ty: -0.8 },
    { a: Math.cos(-0.05), b: Math.sin(-0.05), tx: 5, ty: 3 },
    { a: 1.001, b: 0.002, tx: -2.2, ty: 1.3 },
    { a: 0, b: 1, tx: w, ty: 0 }
  ]
  const withFrame = (images: HeldImage[]): FrameToStack[] =>
    images.map((image, i) => ({ image, transformation: transformations[i], weight: 0.5 + i * 0.1 }))
  let sums = true
  for (const options of [{ method: 'mean', rejectionThreshold: 3 }, { method: 'rejection', rejectionThreshold: 2 }] as StackingOptions[]) {
    const a = new Float32Array(n * 3)
    const b = new Float32Array(n * 3)
    for (let y = 0; y < h; y += 40) {
      stackBand({ frame: withFrame(fi), options, yStart: y, yEnd: y + 40, output: a, tileSide: 31 })
      stackBand({ frame: withFrame(fc), options, yStart: y, yEnd: y + 40, output: b, tileSide: 31 })
    }
    sums &&= equal(a, b)
  }
  result('sum with compact masters identical to that with whole masters (mean, rejection)', sums)
  const opt: StackingOptions = { method: 'rejection', rejectionThreshold: 3 }
  const from = drizzle(withFrame(fi), opt, { factor: 2, pixfrac: 0.7 })
  const db = drizzle(withFrame(fc), opt, { factor: 2, pixfrac: 0.7 })
  result('drizzle with compact masters identical', equal(from.image.data, db.image.data) && equal(from.coverage, db.coverage))

  // Estimate: a library master weighs its codes.
  const f26 = frame('26', 30).map((f) => ({ ...f, compactValue: 1 as const }))
  const without = estimateStacking(request(f26, 64))
  const combined = estimateStacking(request(f26, 64, { mastersToLoad: 2 }))
  const codes = 2 * 6248 * 4176 * 2
  const pieces = 16 * masterPiecesBytes(30, 3)
  // The pieces weigh only if the moment of greatest load is the sum.
  result('estimate: two library masters weigh their codes (2 bytes per pixel) and the pieces rebuilt by the sum workers',
    combined.neededItems - without.neededItems >= codes && combined.neededItems - without.neededItems <= codes + pieces, gb(codes) + ' + ' + gb(pieces))
}

testEstimate()
testTexture()
testInPlace()
testCompact()
testCompactMasters()

if (errors > 0) {
  console.log('\n' + errors + ' checks failed.')
  process.exit(1)
}
console.log('\nAll checks passed.')
