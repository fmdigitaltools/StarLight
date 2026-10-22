/**
 * Abracadabra outside the app, to inspect the result by eye.
 *
 *   TEST_SCRIPT=tools/try-abracadabra.ts node tools/run-test.mjs <output folder> [file.fit ...]
 *
 * Without files it tries all the stacked sample images. Each file takes
 * about twenty seconds.
 *
 * Runs the same chain as the button and as batch processing
 * (see runProcessingOn in hooks/useProcessing.ts): first stage with
 * deconvolution, NL-Bayes on the luminance in stripes like the app's
 * workers (here Node threads), third stage, then `abracadabraFinish` and
 * the export chain (`applyCorrections`). The only difference: the catalog
 * zones that protect galaxies from the trail search are missing (object
 * recognition would be needed). For each file it saves as PNG:
 *   <name>-before.png     as on opening (automatic stretch), reduced
 *   <name>-after.png      after Abracadabra, with the edge crop, reduced
 *   <name>-before-100.png and <name>-after-100.png: 100% crop on the center of the object
 * and writes the measurements: background level, share of the object above
 * 0.95, background noise and color.
 *
 * The images after the (long) chain are kept in the output folder: with
 * REUSE=1 it restarts from there and tries only the finishing step.
 * A measurement tool, not a pass/fail test: it is not part of run-tests.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { deflateSync } from 'node:zlib'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'
import type { ImageData32 } from '@shared/types'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch } from '../src/core/image/stretch'
import { computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { firstStage, thirdStage, applyReductionAmount, ABRACADABRA_PROCESSING, type FirstStageMeasurements } from '../src/core/image/chain'
import { nlBayes, STRIP_MARGIN } from '../src/core/image/nlbayes'
import { abracadabraFinish, knownLinear } from '../src/core/image/abracadabraFinish'
import { applyCorrections, type CorrectionParams } from '../src/core/export/processing'
import { resize } from '../src/core/export/resize'
import { cropRegion, FULL_CROP, type Crop } from '../src/core/export/crop'
import { blur } from '../src/core/image/cleanup'
import { deconvolve } from '../src/core/image/deconvolution'
import { detectStars, type Star } from '../src/core/stars/detection'
import { testFile } from './test-files.mjs'

/* ---- NL-Bayes worker (same file, separate thread) ---- */

interface Stripe {
  stripe: Float32Array
  width: number
  height: number
  sigma: number
}


/** Same as nlbayesParallel.ts: same stripes, same noise factor. */
const NOISE_FACTOR = 2.2
const STRIP_HEIGHT = 128

async function nlBayesParallel(image: ImageData32): Promise<ImageData32> {
  const { width: w, height: h, channels: c } = image
  const n = w * h
  const y = new Float32Array(n)
  for (let k = 0; k < c; k++) {
    const plane = image.data.subarray(k * n, (k + 1) * n)
    for (let i = 0; i < n; i++) y[i] += plane[i] / c
  }
  const sigma = computeStats(y).mad * MAD_TO_SIGMA * NOISE_FACTOR
  const stripes = Math.max(1, Math.ceil(h / STRIP_HEIGHT))
  const useful = Math.ceil(h / stripes)
  const tasks: { start: number; end: number }[] = []
  for (let s = 0; s < stripes; s++) {
    const start = s * useful
    const end = Math.min(h, start + useful)
    if (start < end) tasks.push({ start, end })
  }
  const cleaned = new Float32Array(n)
  let next = 0
  const here = fileURLToPath(import.meta.url)
  const count = Math.max(1, Math.min(12, cpus().length - 2))
  const workers = Array.from({ length: count }, () => new Worker(here))
  await Promise.all(
    workers.map(
      (l) =>
        new Promise<void>((solve, reject) => {
          const start = (): void => {
            if (next >= tasks.length) return solve()
            const k = tasks[next++]
            const from = Math.max(0, k.start - STRIP_MARGIN)
            const a = Math.min(h, k.end + STRIP_MARGIN)
            l.removeAllListeners('message')
            l.once('message', (r: Float32Array) => {
              const rejection = (k.start - from) * w
              cleaned.set(r.subarray(rejection, rejection + (k.end - k.start) * w), k.start * w)
              start()
            })
            l.once('error', reject)
            const stripe = y.slice(from * w, a * w)
            l.postMessage({ stripe, width: w, height: a - from, sigma }, [stripe.buffer])
          }
          start()
        })
    )
  )
  for (const l of workers) await l.terminate()
  const data = image.data.slice()
  for (let i = 0; i < n; i++) {
    const d = cleaned[i] - y[i]
    for (let k = 0; k < c; k++) data[k * n + i] += d
  }
  return { width: w, height: h, channels: c, data }
}

/* ---- PNG ---- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function block(type: string, data: Uint8Array): Buffer {
  const lun = Buffer.alloc(4)
  lun.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(body))
  return Buffer.concat([lun, body, c])
}

function png(im: ImageData32): Buffer {
  const { width: w, height: h } = im
  const n = w * h
  const rows = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3)
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const v = im.data[c * n + y * w + x]
        rows[o + 1 + x * 3 + c] = Math.round(Math.min(1, Math.max(0, v)) * 255)
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    block('IHDR', ihdr),
    block('IDAT', deflateSync(rows, { level: 6 })),
    block('IEND', new Uint8Array(0))
  ])
}

function reduced(im: ImageData32, side = 1200): ImageData32 {
  const f = side / Math.max(im.width, im.height)
  if (f >= 1) return im
  return resize(im, Math.round(im.width * f), Math.round(im.height * f))
}

/* ---- Measurements ---- */

function light(im: ImageData32): Float32Array {
  const n = im.width * im.height
  const l = new Float32Array(n)
  for (let i = 0; i < n; i++) l[i] = (im.data[i] + im.data[n + i] + im.data[2 * n + i]) / 3
  return l
}

/**
 * Masks of sky and extended object, measured on the linear data after the
 * chain: blurred luminance (stars are diluted), sky below half the map
 * noise, object above 4 noise units.
 */
function masks(linear: ImageData32): { sky: Uint8Array; object: Uint8Array; center: [number, number] } {
  const { width: w, height: h } = linear
  const map = blur(light(linear), w, h, Math.max(4, Math.min(w, h) / 150))
  const s = computeStats(map)
  const sig = s.mad * MAD_TO_SIGMA
  const sky = new Uint8Array(w * h)
  const object = new Uint8Array(w * h)
  // The edge (8%) is left out: that is where the noisy band of field rotation lies.
  const mx = Math.round(w * 0.08)
  const my = Math.round(h * 0.08)
  // Object center: centroid of the object pixels, weighted by the
  // signal; a bright isolated star weighs little.
  let sx = 0
  let sy = 0
  let sp = 0
  for (let y = my; y < h - my; y++) {
    for (let x = mx; x < w - mx; x++) {
      const i = y * w + x
      if (map[i] < s.median + 0.5 * sig) sky[i] = 1
      if (map[i] > s.median + 4 * sig) {
        object[i] = 1
        const p = map[i] - s.median
        sx += x * p
        sy += y * p
        sp += p
      }
    }
  }
  const center: [number, number] = sp > 0 ? [Math.round(sx / sp), Math.round(sy / sp)] : [w >> 1, h >> 1]
  return { sky, object, center }
}

interface Measurements {
  background: number
  backgroundNoise: number
  backgroundColor: number
  burntObject: number
  meanObject: number
  objectShare: number
}

function measurement(rendered: ImageData32, m: { sky: Uint8Array; object: Uint8Array }): Measurements {
  const n = rendered.width * rendered.height
  const d = rendered.data
  const l = light(rendered)
  const lc: number[] = []
  let chroma = 0
  let nc = 0
  let burnedOut = 0
  let no = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    if (m.sky[i]) {
      lc.push(l[i])
      chroma += Math.max(d[i], d[n + i], d[2 * n + i]) - Math.min(d[i], d[n + i], d[2 * n + i])
      nc++
    }
    if (m.object[i]) {
      no++
      sum += l[i]
      if (l[i] > 0.95) burnedOut++
    }
  }
  const sc = computeStats(Float32Array.from(lc))
  return {
    background: sc.median,
    backgroundNoise: sc.mad * MAD_TO_SIGMA,
    backgroundColor: nc ? chroma / nc : 0,
    burntObject: no ? burnedOut / no : 0,
    meanObject: no ? sum / no : 0,
    objectShare: no / n
  }
}

/**
 * Star color as rendered: for each star, the light above the local
 * background over its disc, channel by channel, and the chroma
 * (strongest − weakest channel) / mean. Returns the median chroma of the
 * brightest stars and of the fainter ones, to see whether the stars came
 * out white compared with the "before".
 */
function starChroma(rendered: ImageData32, stars: Star[]): { bright: number; faint: number } {
  const w = rendered.width
  const h = rendered.height
  const n = w * h
  const d = rendered.data
  const chroma = (s: Star): number | null => {
    const r = Math.max(3, Math.ceil(s.hfr * 3))
    const cx = Math.round(s.x)
    const cy = Math.round(s.y)
    if (cx - r - 6 < 0 || cy - r - 6 < 0 || cx + r + 6 >= w || cy + r + 6 >= h) return null
    const ring: number[][] = [[], [], []]
    const sums = [0, 0, 0]
    for (let dy = -r - 6; dy <= r + 6; dy++) {
      for (let dx = -r - 6; dx <= r + 6; dx++) {
        const d2 = dx * dx + dy * dy
        const i = (cy + dy) * w + cx + dx
        if (d2 > (r + 3) * (r + 3) && d2 <= (r + 6) * (r + 6)) for (let k = 0; k < 3; k++) ring[k].push(d[k * n + i])
      }
    }
    const bg = ring.map((v) => v.sort((a, b) => a - b)[v.length >> 1])
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue
        const i = (cy + dy) * w + cx + dx
        for (let k = 0; k < 3; k++) sums[k] += Math.max(0, d[k * n + i] - bg[k])
      }
    }
    const m = (sums[0] + sums[1] + sums[2]) / 3
    return m > 0 ? (Math.max(...sums) - Math.min(...sums)) / m : null
  }
  const median = (v: number[]): number => (v.length ? v.sort((a, b) => a - b)[v.length >> 1] : 0)
  const sorted = stars.slice().sort((a, b) => b.flux - a.flux)
  const values = (list: Star[]): number[] => list.map(chroma).filter((c): c is number => c !== null)
  return { bright: median(values(sorted.slice(0, 40))), faint: median(values(sorted.slice(40, 400))) }
}

function portion(im: ImageData32, cx: number, cy: number, side: number): ImageData32 {
  const x = Math.max(0, Math.min(im.width - side, cx - side / 2)) / im.width
  const y = Math.max(0, Math.min(im.height - side, cy - side / 2)) / im.height
  return cropRegion(im, { x, y, width: side / im.width, height: side / im.height })
}

function writeF32(path: string, im: ImageData32): void {
  const head = Buffer.alloc(12)
  head.writeUInt32LE(im.width, 0)
  head.writeUInt32LE(im.height, 4)
  head.writeUInt32LE(im.channels, 8)
  writeFileSync(path, Buffer.concat([head, Buffer.from(im.data.buffer, im.data.byteOffset, im.data.byteLength)]))
}

function readF32(path: string): ImageData32 {
  const b = readFileSync(path)
  const w = b.readUInt32LE(0)
  const h = b.readUInt32LE(4)
  const c = b.readUInt32LE(8) as 1 | 3
  const data = new Float32Array(b.buffer.slice(b.byteOffset + 12, b.byteOffset + b.length))
  return { width: w, height: h, channels: c, data }
}

const NEUTRALS = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  redGain: 1,
  greenGain: 1,
  blueGain: 1,
  gamma: 1,
  noiseReduction: 0,
  sharpness: 0,
  backgroundNeutralization: 0
}

function skyBackground(im: ImageData32): [number, number, number] {
  const n = im.width * im.height
  const m = (k: number): number => computeStats(im.data.subarray(k * n, (k + 1) * n)).median
  return im.channels === 3 ? [m(0), m(1), m(2)] : [m(0), m(0), m(0)]
}

async function main(): Promise<void> {
  const [output, ...list] = process.argv.slice(2)
  if (!output) {
    console.log('usage: try-abracadabra <output folder> [file.fit ...]')
    process.exit(2)
  }
  mkdirSync(output, { recursive: true })
  const file = list.length
    ? list
    : readdirSync(testFile('stacks'))
        .filter((f) => f.toLowerCase().endsWith('.fit'))
        .map((f) => join(testFile('stacks'), f))
  const rows: string[] = []
  for (const f of file) {
    const name = basename(f).replace(/\.fit$/i, '').slice(0, 24)
    const t0 = Date.now()
    const readResult = readFits(new Uint8Array(readFileSync(f)), basename(f))
    const original = debayer(readResult.image, readResult.metadata.bayer)

    // The chain, or the result kept from the previous run.
    const cache = join(output, name + '-chain.f32')
    const measurementCache = join(output, name + '-measurements.json')
    let processed: ImageData32
    let chainMeasurements: FirstStageMeasurements | null
    if (process.env.REUSE === '1' && existsSync(cache) && existsSync(measurementCache)) {
      processed = readF32(cache)
      chainMeasurements = JSON.parse(readFileSync(measurementCache, 'utf8')) as FirstStageMeasurements
    } else {
      // As in the app: the caller runs the deconvolution (there in stripes
      // over several workers, with the same result).
      const first = firstStage(original, ABRACADABRA_PROCESSING, true, true)
      let im = first.image
      if (first.parameters.deconvolution.iterations > 0) im = deconvolve(im, first.parameters.deconvolution)
      if (first.parameters.nlBayes > 0) im = applyReductionAmount(im, await nlBayesParallel(im), first.parameters.nlBayes)
      const third = thirdStage(im, first.parameters, true)
      processed = third.image
      chainMeasurements = first.measurements
      writeF32(cache, processed)
      writeFileSync(measurementCache, JSON.stringify(chainMeasurements))
      console.log(name, 'parameters', JSON.stringify({ ...third.parameters, plugin: undefined }))
    }
    const tChain = Date.now()

    const fin = abracadabraFinish(processed, chainMeasurements, knownLinear(readResult.metadata))
    const r = fin.adjustments
    const parAfter: CorrectionParams = {
      ...r,
      skyBackground: skyBackground(processed),
      ghs: r.withGhs ? r.ghs : undefined
    }
    const parBefore: CorrectionParams = {
      ...NEUTRALS,
      stretch: autoStretch(original),
      skyBackground: skyBackground(original),
      preserveColor: false
    }
    const before = applyCorrections(original, parBefore)
    const afterFull = applyCorrections(processed, parAfter)
    const cropBox: Crop = fin.crop ?? FULL_CROP
    const after = cropRegion(afterFull, cropBox)

    const mm = masks(processed)
    const mBefore = measurement(before, mm)
    const mAfter = measurement(afterFull, mm)
    const [cx, cy] = mm.center
    const stars = original.channels === 3 ? detectStars(original, { max: 1000 }) : []
    const cBefore = starChroma(before, stars)
    const cAfter = starChroma(afterFull, stars)
    // Reference: the linear data balanced on the stars, where the star light is measured without any stretch.
    const gains = chainMeasurements?.starGains ?? [1, 1, 1]
    const balanced = { ...original, data: original.data.map((v, i) => v * gains[Math.floor(i / (original.width * original.height))]) }
    const cTrue = starChroma(balanced, stars)
    writeFileSync(join(output, name + '-before.png'), png(reduced(before)))
    writeFileSync(join(output, name + '-after.png'), png(reduced(after)))
    writeFileSync(join(output, name + '-before-100.png'), png(portion(before, cx, cy, 800)))
    writeFileSync(join(output, name + '-after-100.png'), png(portion(afterFull, cx, cy, 800)))

    const t = (v: number): string => v.toFixed(3)
    const row =
      name.padEnd(24) +
      ' background ' + t(mBefore.background) + '→' + t(mAfter.background) +
      ' noise ' + t(mBefore.backgroundNoise) + '→' + t(mAfter.backgroundNoise) +
      ' backgroundColor ' + t(mBefore.backgroundColor) + '→' + t(mAfter.backgroundColor) +
      ' object>0.95 ' + (mBefore.burntObject * 100).toFixed(1) + '%→' + (mAfter.burntObject * 100).toFixed(1) + '%' +
      ' objectMean ' + t(mBefore.meanObject) + '→' + t(mAfter.meanObject) +
      ' (object ' + (mAfter.objectShare * 100).toFixed(1) + '% of the field, center ' + cx + ',' + cy + ')' +
      ' crop ' + (fin.crop ? [cropBox.x, cropBox.y, cropBox.width, cropBox.height].map((v) => v.toFixed(3)).join(',') : 'none') +
      ' edges ' + JSON.stringify(chainMeasurements?.edges ?? null) +
      ' starChroma true ' + t(cTrue.bright) + '/' + t(cTrue.faint) + ' bright ' + t(cBefore.bright) + '→' + t(cAfter.bright) + ' faint ' + t(cBefore.faint) + '→' + t(cAfter.faint) +
      ' sat ' + r.saturation.toFixed(2) +
      ' stretch ' + [r.stretch.shadows, r.stretch.highlights].map((v) => v.toExponential(2)).join('..') +
      ' ghs ' + JSON.stringify(r.ghs) +
      ' [' + ((tChain - t0) / 1000).toFixed(0) + 's chain]'
    console.log(row)
    rows.push(row)
  }
  writeFileSync(join(output, 'measurements.txt'), rows.join('\n') + '\n')
}

/* Startup at the end of the file: the constants above must already be defined. */
if (!isMainThread) {
  parentPort?.on('message', (m: Stripe) => {
    const cleaned = nlBayes(m.stripe, m.width, m.height, m.sigma)
    parentPort?.postMessage(cleaned, [cleaned.buffer as ArrayBuffer])
  })
} else {
  await main()
}
