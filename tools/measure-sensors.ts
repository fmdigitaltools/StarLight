/**
 * Engine measurement with small and large sensors (2, 8, 26, 45, 61 MP):
 * times and memory peaks of reading, debayer, stars, alignment, stacking,
 * drizzle, processing and export. A measurement tool, not a pass/fail check.
 *
 * Two commands. First the synthetic frames are generated (one at a time,
 * on disk: background with gradient, Gaussian noise, ~500 Gaussian stars,
 * shift up to ±15 px and rotation up to ±0.15° between frames), written
 * with the project's FITS encoder (16 bit) and with BAYERPAT=RGGB if raw:
 *
 *   TEST_SCRIPT=tools/measure-sensors.ts node tools/run-test.mjs \
 *     generate <2|8|26|45|61|WxH> <count> <bayer|rgb> <folder>
 *
 * then the measurement is run, in a fresh process for each configuration:
 *
 *   NODE_OPTIONS=--max-old-space-size=4096 TEST_SCRIPT=tools/measure-sensors.ts \
 *     node tools/run-test.mjs measure <folder> [--drizzle] [--process] \
 *     [--workers 12] [--count N] [--parallel-analysis] [--calibrate] [--new] [--whole-masters] [--json file]
 *
 * (--calibrate: synthetic dark and flat as the calibration library keeps
 * them (sensor format, 16 bit), calibration of every frame as in
 * analyzeFrame; with --new the masters stay compact as in loadMaster,
 * unless --whole-masters is given, which keeps them rebuilt at 32 bits
 * per channel: the fingerprint of the stack must stay the same.
 * --new: the app's flow, with the memory fixes: short file queue,
 * analysis with the same function as the app's workers
 * (core/stack/frameAnalysis.ts), frames kept compact until the sum with
 * deferred calibration (core/stack/compactFrame.ts), analysis workers
 * closed before the sum; with --parallel-analysis.
 * Without --new the previous flow is repeated, for comparisons; to
 * really measure the previous code, the tool is compiled with the @core
 * and @shared aliases pointing to a copy of the sources of that time.
 * The "fingerprint" line makes it possible to verify that the stack is
 * identical bit for bit.)
 *
 * (--parallel-analysis: frame analysis runs on the workers as in the app,
 * with all files read in advance; it measures real time and peak.)
 *
 * (--count uses only the first N files of the folder.) If another check
 * runs at the same time, it is better to compile the bundle into a folder
 * of its own with esbuild and launch it with node directly: run-test.mjs
 * always writes the same temporary file, and the threads re-read that one.
 *
 * Rules followed:
 * - before starting it estimates the peak and stops if it exceeds half of
 *   the free memory (os.freemem) at that moment: it says so and nothing more;
 * - at most `--workers` threads (default 12, like the app's analysis
 *   teams; never more than half of the cores);
 * - frame analysis runs here on a single thread, frame by frame: the time
 *   per frame is that of an app worker; the transient peak per frame must
 *   be multiplied by the active workers;
 * - stacking, drizzle, deconvolution and NL-Bayes run in bands/stripes
 *   on Node threads (worker_threads) with the engine's real functions;
 * - RSS peak sampled every 10 ms by a separate thread (valid for the whole
 *   process) and maximum RSS growth within the phase; arrayBuffers read at
 *   the end of each phase (main thread, includes the SharedArrayBuffers);
 * - the freshly written files are in the system cache: the measured read
 *   is the "warm" one.
 * All functions come from src/core (no copy of the code).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { freemem, totalmem, cpus } from 'node:os'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { ImageData32 } from '@shared/types'
import { readFits } from '@core/fits/reader'
import { debayer, toLuminance } from '@core/image/debayer'
import { computeImageStats, computeStats, MAD_TO_SIGMA, estimateNoise } from '@core/image/stats'
import { detectStars, evaluateQuality, type Star } from '@core/stars/detection'
import { computeThumbnail } from '@core/image/thumbnail'
import { sharedImage, sharedFloat32, isShared, sharedUint16 } from '@shared/sharedMemory'
import { align, IDENTITY_TRANSFORMATION, type Transformation } from '@core/stack/alignment'
import { stackBand, type FrameToStack, type RejectionMap, type StackingOptions } from '@core/stack/stacking'
import { drizzleBand, drizzleMemory } from '@core/stack/drizzle'
import { firstStage, thirdStage, applyReductionAmount, ABRACADABRA_PROCESSING } from '@core/image/chain'
import { nlBayes, STRIP_MARGIN } from '@core/image/nlbayes'
import { deconvolve, measureDeconvolution, DECONVOLUTION_MARGIN } from '@core/image/deconvolution'
import { abracadabraFinish } from '@core/image/abracadabraFinish'
import { applyCorrections, type CorrectionParams } from '@core/export/processing'
import { encodeTiff, encodeFits } from '@core/export/encoding'
import { autoStretch } from '@core/image/stretch'
import { imageSkyBackground } from '@core/image/skyBackground'
import { calibrate } from '@core/stack/calibration'
import { dequantize, usableMaster, quantize } from '@core/stack/calibrationLibrary'
import { analyzeContent } from '@core/stack/frameAnalysis'
import { deferredCalibration, isCompact, compactMaster, sharedHold, type HeldImage, type KeptMaster } from '@core/stack/compactFrame'

const MB = 1048576
const GB = 1073741824
const HERE = fileURLToPath(import.meta.url)

/* ------------------------------------------------------------------ */
/* Worker threads: stacking and drizzle bands, deconvolution and NL-Bayes */
/* stripes, memory sampler.                                                 */
/* ------------------------------------------------------------------ */

interface ThreadTask {
  type: 'band' | 'drizzle' | 'nlbayes' | 'deconv' | 'analyze'
  [k: string]: unknown
}

function threadWork(m: ThreadTask): { response: unknown; transfer: ArrayBuffer[] } {
  if (m.type === 'band') {
    const e = stackBand(m.p as Parameters<typeof stackBand>[0])
    return { response: e, transfer: [] }
  }
  if (m.type === 'drizzle') {
    const e = drizzleBand(m.p as Parameters<typeof drizzleBand>[0])
    return { response: e, transfer: [] }
  }
  if (m.type === 'analyze' && m.newValue) {
    // Like analysis.worker.ts: the same function, which keeps the frame
    // compact if the file allows it.
    const source = { buffer: m.buffer as ArrayBuffer | null }
    m.buffer = null
    const a = analyzeContent(source, m.name as string, true, true)
    const image = a.compact ?? (a.image as ImageData32)
    return { response: { image, stars: a.stars, quality: a.quality }, transfer: [] }
  }
  if (m.type === 'analyze') {
    // Like analysis.worker.ts before the memory fixes: the file arrives
    // transferred, the image comes back shared.
    const readResult = readFits(new Uint8Array(m.buffer as ArrayBuffer), m.name as string)
    const image = sharedImage(debayer(readResult.image, readResult.metadata.bayer))
    computeImageStats(image)
    const stars = detectStars(image)
    const quality = evaluateQuality(stars, computeStats(toLuminance(image)).mad * MAD_TO_SIGMA).score
    computeThumbnail(image, 'NONE', true)
    return { response: { image, stars, quality }, transfer: [] }
  }
  if (m.type === 'nlbayes') {
    const r = nlBayes(m.stripe as Float32Array, m.w as number, m.h as number, m.sigma as number)
    return { response: r, transfer: [r.buffer as ArrayBuffer] }
  }
  const r = deconvolve(
    m.stripe as ImageData32,
    m.parameters as Parameters<typeof deconvolve>[1],
    m.measurements as Parameters<typeof deconvolve>[2]
  )
  return { response: r.data, transfer: [r.data.buffer as ArrayBuffer] }
}

/** Sampler: reads the process RSS every 10 ms and keeps the maximum per phase. */
function sampler(state: Int32Array, peaks: Float64Array): void {
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    const phase = Atomics.load(state, 0)
    if (phase < 0) return
    const rss = process.memoryUsage.rss()
    if (rss > peaks[phase]) peaks[phase] = rss
    if (rss > peaks[63]) peaks[63] = rss
    if (rss > peaks[62]) peaks[62] = rss
    Atomics.wait(pause, 0, 0, 10)
  }
}

/* ------------------------------------------------------------------ */
/* Thread pool and phase log                                          */
/* ------------------------------------------------------------------ */

class WorkerPool {
  private free: Worker[] = []
  private tail: { m: ThreadTask; ok: (r: unknown) => void; ko: (e: Error) => void }[] = []
  readonly allItems: Worker[] = []
  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const w = new Worker(HERE, { workerData: { role: 'work' } })
      this.allItems.push(w)
      this.free.push(w)
    }
  }
  run(m: ThreadTask, transfer: ArrayBuffer[] = []): Promise<unknown> {
    return new Promise((ok, ko) => {
      this.tail.push({ m: { ...m, _cedere: transfer }, ok, ko })
      this.start()
    })
  }
  private start(): void {
    while (this.free.length > 0 && this.tail.length > 0) {
      const w = this.free.pop() as Worker
      const c = this.tail.shift() as (typeof this.tail)[number]
      const end = (): void => {
        w.removeAllListeners('message')
        w.removeAllListeners('error')
        this.free.push(w)
        this.start()
      }
      w.once('message', (r) => { end(); c.ok(r) })
      w.once('error', (e) => { end(); c.ko(e) })
      const transfer = (c.m._cedere as ArrayBuffer[]) ?? []
      delete c.m._cedere
      w.postMessage(c.m, transfer)
    }
  }
  async close(): Promise<void> {
    for (const w of this.allItems) await w.terminate()
  }
  /** Closes the threads and replaces them with new ones (like the app does when it dismisses the analysis workers). */
  async renew(): Promise<void> {
    const count = this.allItems.length
    await this.close()
    this.allItems.length = 0
    this.free.length = 0
    for (let i = 0; i < count; i++) {
      const w = new Worker(HERE, { workerData: { role: 'work' } })
      this.allItems.push(w)
      this.free.push(w)
    }
  }
}

const PHASE_NAMES: string[] = ['(outside any phase)']
const sampleState = new Int32Array(new SharedArrayBuffer(4))
const peaksRss = new Float64Array(new SharedArrayBuffer(8 * 64))
const phaseTime = new Map<string, number>()
const arrayBuffersByPhase = new Map<string, number>()
const rssEnd = new Map<string, number>()
/** Maximum RSS growth within a single run of the phase. */
const phaseIncrement = new Map<string, number>()

function phaseIndex(name: string): number {
  let i = PHASE_NAMES.indexOf(name)
  if (i < 0) { PHASE_NAMES.push(name); i = PHASE_NAMES.length - 1 }
  return i
}

/** Runs `fn` inside phase `name`: adds up the time, updates the peaks. */
async function inPhase<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const i = phaseIndex(name)
  // The phase peak starts at least from the RSS at its start.
  const rss0 = process.memoryUsage.rss()
  if (rss0 > peaksRss[i]) peaksRss[i] = rss0
  peaksRss[62] = rss0
  Atomics.store(sampleState, 0, i)
  const t0 = performance.now()
  const r = await fn()
  const dt = performance.now() - t0
  const mu = process.memoryUsage()
  if (mu.rss > peaksRss[i]) peaksRss[i] = mu.rss
  Atomics.store(sampleState, 0, 0)
  phaseTime.set(name, (phaseTime.get(name) ?? 0) + dt)
  arrayBuffersByPhase.set(name, Math.max(arrayBuffersByPhase.get(name) ?? 0, mu.arrayBuffers))
  rssEnd.set(name, mu.rss)
  const inc = Math.max(peaksRss[62], mu.rss) - rss0
  phaseIncrement.set(name, Math.max(phaseIncrement.get(name) ?? 0, inc))
  return r
}

function gcIfPossible(): void {
  const g = (globalThis as { gc?: () => void }).gc
  if (g) g()
}

/* ------------------------------------------------------------------ */
/* Generation of the synthetic frames                                 */
/* ------------------------------------------------------------------ */

const MEASUREMENTS: Record<string, [number, number]> = {
  '2': [1920, 1080],
  '8': [3840, 2160],
  '26': [6248, 4176],
  '45': [8256, 5504],
  '61': [9576, 6388]
}

/** Reproducible pseudo-random generator (mulberry32). */
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

import { colorAt } from '@core/image/debayer'

function generate(measurement: string, count: number, type: 'bayer' | 'rgb', folder: string): void {
  const [w, h] = MEASUREMENTS[measurement] ?? (measurement.split('x').map(Number) as [number, number])
  mkdirSync(folder, { recursive: true })
  const rnd = random(20261018)
  const STARS = 500
  const stars = Array.from({ length: STARS }, () => ({
    x: rnd() * w,
    y: rnd() * h,
    peak: 0.02 * Math.pow(40, rnd()),
    sigma: 1.2 + rnd(),
    color: [0.8 + rnd() * 0.4, 1, 0.8 + rnd() * 0.4]
  }))
  const background = [0.06, 0.08, 0.05]
  const planes = type === 'rgb' ? 3 : 1
  const n = w * h
  for (let f = 0; f < count; f++) {
    const t0 = performance.now()
    const rf = random(1000 + f)
    const ang = ((rf() - 0.5) * 0.3 * Math.PI) / 180
    const dx = (rf() - 0.5) * 30
    const dy = (rf() - 0.5) * 30
    const cos = Math.cos(ang), sin = Math.sin(ang)
    const cx = w / 2, cy = h / 2
    const data = new Float32Array(n * planes)
    // Background with gradient and Gaussian noise (Box-Muller).
    for (let c = 0; c < planes; c++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x += 2) {
          const u = rf() || 1e-12, v = rf()
          const r = Math.sqrt(-2 * Math.log(u)) * 0.004
          for (let k = 0; k < 2 && x + k < w; k++) {
            const xx = x + k
            const channel = planes === 3 ? c : colorAt('RGGB', xx, y)
            const g = k === 0 ? r * Math.cos(2 * Math.PI * v) : r * Math.sin(2 * Math.PI * v)
            data[c * n + y * w + xx] = background[channel] + 0.02 * (xx / w) + g
          }
        }
      }
    }
    // Stars: position in the frame = rotation around the center + shift.
    for (const s of stars) {
      const px = cos * (s.x - cx) - sin * (s.y - cy) + cx + dx
      const py = sin * (s.x - cx) + cos * (s.y - cy) + cy + dy
      const radius = Math.ceil(4 * s.sigma)
      const k2 = 1 / (2 * s.sigma * s.sigma)
      for (let y = Math.max(0, Math.floor(py - radius)); y <= Math.min(h - 1, Math.ceil(py + radius)); y++) {
        for (let x = Math.max(0, Math.floor(px - radius)); x <= Math.min(w - 1, Math.ceil(px + radius)); x++) {
          const e = s.peak * Math.exp(-((x - px) ** 2 + (y - py) ** 2) * k2)
          if (planes === 3) for (let c = 0; c < 3; c++) data[c * n + y * w + x] += e * s.color[c]
          else data[y * w + x] += e * s.color[colorAt('RGGB', x, y)]
        }
      }
    }
    const fits = new Uint8Array(encodeFits({ width: w, height: h, channels: planes as 1 | 3, data }, {}, 16))
    if (type === 'bayer') {
      // The encoder does not keep BAYERPAT: the CREATOR card is replaced.
      const text = Buffer.from(fits.subarray(0, 2880)).toString('latin1')
      const pos = text.indexOf('CREATOR ')
      const card = "BAYERPAT= 'RGGB    '".padEnd(80, ' ')
      for (let i = 0; i < 80; i++) fits[pos + i] = card.charCodeAt(i)
    }
    const name = join(folder, 'frame-' + String(f + 1).padStart(3, '0') + '.fit')
    writeFileSync(name, fits)
    console.log(name, w + 'x' + h, type, (fits.length / MB).toFixed(0) + ' MB', ((performance.now() - t0) / 1000).toFixed(1) + ' s')
  }
}

/* ------------------------------------------------------------------ */
/* The parallel phases, as in the app (stackInParallel, drizzleParallel, */
/* deconvolveParallel, nlbayesParallel) but on worker_threads           */
/* ------------------------------------------------------------------ */

const MIN_ROWS = 24

async function stackParallel(
  sq: WorkerPool, frame: FrameToStack[], options: StackingOptions, rejectionMap?: RejectionMap
): Promise<{ image: ImageData32; rejected: number }> {
  const { width: w, height: h, channels: channelCount } = frame[0].image
  const bands = Math.max(1, Math.min(sq.allItems.length, Math.floor(h / MIN_ROWS)))
  const output = sharedFloat32(w * h * channelCount)
  const boundary = (i: number): number => Math.round((i * h) / bands)
  const results = (await Promise.all(
    Array.from({ length: bands }, (_, i) =>
      sq.run({ type: 'band', p: { frame, options, yStart: boundary(i), yEnd: boundary(i + 1), output, rejectionMap } })
    )
  )) as { rejectedValues: number }[]
  return { image: { width: w, height: h, channels: channelCount, data: output }, rejected: results.reduce((s, e) => s + e.rejectedValues, 0) }
}

async function drizzleInParallel(sq: WorkerPool, frame: FrameToStack[], options: StackingOptions): Promise<ImageData32> {
  const { width: w, height: h, channels: channelCount } = frame[0].image
  const rejection: RejectionMap = { center: sharedFloat32(w * h * channelCount), limit: sharedFloat32(w * h * channelCount) }
  const reference = await stackParallel(sq, frame, options, rejection)
  const s = 2
  const W = w * s, H = h * s
  const output = sharedFloat32(W * H * channelCount)
  const coverage = sharedFloat32(W * H)
  const bands = Math.max(1, Math.min(sq.allItems.length, Math.floor(H / MIN_ROWS)))
  const boundary = (i: number): number => Math.round((i * H) / bands)
  await Promise.all(
    Array.from({ length: bands }, (_, i) =>
      sq.run({
        type: 'drizzle',
        p: { frame, factor: s, pixfrac: 0.8, rejection, reserve: reference.image.data, yStart: boundary(i), yEnd: boundary(i + 1), output, coverage }
      })
    )
  )
  return { width: W, height: H, channels: channelCount, data: output }
}

async function deconvParallel(sq: WorkerPool, im: ImageData32, p: Parameters<typeof deconvolve>[1]): Promise<ImageData32> {
  const { width: w, height: h, channels: c } = im
  const n = w * h
  const measurements = measureDeconvolution(im, p.psfRadius)
  const margin = DECONVOLUTION_MARGIN(p, measurements.sigma)
  const stripes = Math.max(1, Math.min(sq.allItems.length, Math.floor(h / Math.max(64, margin))))
  const useful = Math.ceil(h / stripes)
  const output = new Float32Array(im.data.length)
  const tasks: Promise<void>[] = []
  for (let s = 0; s < stripes; s++) {
    const start = s * useful, end = Math.min(h, start + useful)
    if (start >= end) continue
    const from = Math.max(0, start - margin), a = Math.min(h, end + margin), rows = a - from
    const data = new Float32Array(w * rows * c)
    for (let k = 0; k < c; k++) data.set(im.data.subarray(k * n + from * w, k * n + a * w), k * w * rows)
    tasks.push(
      sq.run({ type: 'deconv', stripe: { width: w, height: rows, channels: c, data: data }, parameters: p, measurements }, [data.buffer])
        .then((r) => {
          const d = r as Float32Array
          for (let k = 0; k < c; k++) {
            output.set(d.subarray(k * w * rows + (start - from) * w, k * w * rows + (end - from) * w), k * n + start * w)
          }
        })
    )
  }
  await Promise.all(tasks)
  return { width: w, height: h, channels: c, data: output }
}

async function nlBayesPar(sq: WorkerPool, im: ImageData32): Promise<ImageData32> {
  const { width: w, height: h, channels: c } = im
  const n = w * h
  const y = new Float32Array(n)
  for (let k = 0; k < c; k++) for (let i = 0; i < n; i++) y[i] += im.data[k * n + i] / c
  const sigma = computeStats(y).mad * MAD_TO_SIGMA * 2.2
  const HEIGHT = 128
  const stripes = Math.max(1, Math.ceil(h / HEIGHT))
  const useful = Math.ceil(h / stripes)
  const cleaned = new Float32Array(n)
  const tasks: Promise<void>[] = []
  for (let s = 0; s < stripes; s++) {
    const start = s * useful, end = Math.min(h, start + useful)
    if (start >= end) continue
    const from = Math.max(0, start - STRIP_MARGIN), a = Math.min(h, end + STRIP_MARGIN)
    const stripe = y.slice(from * w, a * w)
    tasks.push(
      sq.run({ type: 'nlbayes', stripe, w, h: a - from, sigma }, [stripe.buffer]).then((r) => {
        const d = r as Float32Array
        cleaned.set(d.subarray((start - from) * w, (end - from) * w), start * w)
      })
    )
  }
  await Promise.all(tasks)
  const data = im.data.slice()
  for (let i = 0; i < n; i++) { const d = cleaned[i] - y[i]; for (let k = 0; k < c; k++) data[k * n + i] += d }
  return { width: w, height: h, channels: c, data }
}

/* ------------------------------------------------------------------ */
/* Measurement                                                           */
/* ------------------------------------------------------------------ */

interface Options { parallel: boolean; drizzle: boolean; process: boolean; workers: number; json?: string; count?: number; calibrate: boolean; newValue: boolean; wholeMasters: boolean }

function dimensionsFrom(file: string): { w: number; h: number; planes: number } {
  const head = readFileSync(file).subarray(0, 2880 * 4).toString('latin1')
  const v = (k: string): number => Number((head.match(new RegExp(k.padEnd(8, ' ') + '= *([0-9]+)')) ?? [])[1] ?? 1)
  return { w: v('NAXIS1'), h: v('NAXIS2'), planes: v('NAXIS3') }
}

/**
 * True if the process, with `neededItems` more bytes, stays within half of the
 * memory that was free before it started (free now + what the
 * process already occupies). Otherwise the phase is not run.
 */
function withinLimit(what: string, neededItems: number): boolean {
  const already = process.memoryUsage.rss()
  const free = freemem() + already
  neededItems += already
  const ok = neededItems <= free * 0.5
  console.log(
    (ok ? 'limit ok   ' : 'OVER LIMIT ') + what + ': process with this phase ' + (neededItems / GB).toFixed(1) + ' GB, half of the free ' +
      (free / 2 / GB).toFixed(1) + ' GB'
  )
  return ok
}

const gb = (b: number): string => (b / GB).toFixed(2)

/** 32-bit FNV-1a fingerprint of the bytes of an array of values. */
function fingerprintOf(a: Float32Array): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  let x = 0x811c9dc5
  for (let i = 0; i < b.length; i++) x = Math.imul(x ^ b[i], 0x01000193) >>> 0
  return x.toString(16).padStart(8, '0')
}

async function measurement(folder: string, o: Options): Promise<void> {
  const file = readdirSync(folder).filter((f) => f.endsWith('.fit')).sort().map((f) => join(folder, f))
    .slice(0, o.count ?? Infinity)
  const N = file.length
  const { w, h, planes } = dimensionsFrom(file[0])
  const n = w * h
  const frameBytes = n * 3 * 4
  console.log('Total memory ' + gb(totalmem()) + ' GB, free ' + gb(freemem()) + ' GB, cores ' + cpus().length +
    ', compute threads ' + o.workers)
  console.log(N + ' frame ' + w + 'x' + h + ' (' + (n / 1e6).toFixed(1) + ' MP), ' + (planes === 3 ? 'already color' : 'raw Bayer') +
    ', ' + (frameBytes / MB).toFixed(0) + ' MB per frame in Float32, 3 channels')
  // Frames kept + output + transient of one frame (~40 B/px measured) + margin.
  const base = N * frameBytes * (o.calibrate ? 2 : 1) + n * 12 + n * 40 + 0.5 * GB
  if (!withinLimit('analysis + stacking', base)) return

  // Memory sampler on a separate thread.
  const camp = new Worker(HERE, { workerData: { role: 'sample', state: sampleState, peaks: peaksRss } })
  const sq = new WorkerPool(o.workers)
  const v8 = await import('node:v8')
  const vm = await import('node:vm')
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc') as () => void

  // Synthetic masters for --calibrate, as the calibration library keeps and
  // re-reads them: a faint dark with a few hot pixels and a flat
  // with vignetting, in the sensor format (one plane for raw
  // Bayer, three for color files) and at 16 bit (quantize). With --new
  // they stay compact as in loadMaster; with --whole-masters they are kept
  // rebuilt, at 32 bits per channel (usableMaster of the values read).
  let master: { dark: KeptMaster; flat: KeptMaster } | null = null
  if (o.calibrate) {
    const schema = planes === 1 ? 'RGGB' : 'NONE'
    const np = n * planes
    const dark = new Float32Array(np)
    const flat = new Float32Array(np)
    const r = random(7)
    for (let i = 0; i < np; i++) {
      const p = i % n
      const x = (p % w) / w - 0.5
      const y = Math.floor(p / w) / h - 0.5
      dark[i] = 0.002 + (r() < 0.0002 ? 0.3 : r() * 0.001)
      flat[i] = 0.5 * (1 - 0.3 * (x * x + y * y))
    }
    const keep = (data: Float32Array): KeptMaster => {
      const q = quantize(data)
      if (o.newValue && !o.wholeMasters) {
        const codes = sharedUint16(np)
        codes.set(q.values)
        return compactMaster({ width: w, height: h, planes: planes as 1 | 3, codes }, schema, q.minimum, q.max)
      }
      const whole = usableMaster({ width: w, height: h, channels: planes as 1 | 3, data: dequantize(q.values, q.minimum, q.max) }, schema)
      // With --new in shared memory, like the app's masters.
      return o.newValue ? sharedImage(whole) : whole
    }
    master = { dark: keep(dark), flat: keep(flat) }
  }
  // As in analyzeFrame: a compact frame gets the deferred calibration.
  const calibrateIfNeeded = (im: HeldImage): HeldImage =>
    !master ? im
      : isCompact(im) ? deferredCalibration(im, { dark: master.dark, flat: master.flat, bias: null })
      : calibrate(im, { dark: master.dark, flat: master.flat, correctDefectivePixels: true, inPlace: o.newValue })

  interface Analyzed { image: HeldImage; stars: Star[]; quality: number }
  const analyzed: Analyzed[] = []
  let transientMax = 0
  const rssBefore = process.memoryUsage.rss()
  if (o.parallel) {
    // As in useStacking: all files read at once (Promise.all on
    // readFile), then queued to the workers, which receive them transferred.
    // Cold workers, as at the first stacking in the app.
    // With --new the kept frames are compact (2 bytes per plane and per pixel).
    const kept = o.newValue ? N * 2 * n * planes : N * 12 * n
    const estimate = kept + o.workers * 27 * n + N * 2 * n * planes + 0.5 * GB
    if (!withinLimit('parallel analysis', estimate)) { Atomics.store(sampleState, 0, -1); await camp.terminate(); await sq.close(); return }
    const read = (f: string): ArrayBuffer => {
      const b = readFileSync(f)
      return (b.byteOffset === 0 && b.buffer.byteLength === b.length ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) as ArrayBuffer
    }
    const results = await inPhase('1-7 parallel analysis (' + o.workers + ' workers)', async () => {
      if (o.newValue) {
        // As in useStacking today: a short queue, each worker reads its
        // next file only when it has finished the previous one; the
        // in-place calibration as soon as the frame comes back.
        const results: Analyzed[] = new Array(N)
        let next = 0
        const work = async (): Promise<void> => {
          while (next < N) {
            const i = next++
            const buffer = read(file[i])
            const a = (await sq.run({ type: 'analyze', buffer, name: file[i], newValue: true }, [buffer])) as Analyzed
            results[i] = master ? { ...a, image: calibrateIfNeeded(a.image) } : a
          }
        }
        await Promise.all(Array.from({ length: Math.min(o.workers, N) }, work))
        return results
      }
      // As in useStacking before: all files read at once (Promise.all
      // on readFile), then queued to the workers, which receive them transferred.
      const contents = file.map(read)
      return Promise.all(contents.map((buffer, i) => sq.run({ type: 'analyze', buffer, name: file[i] }, [buffer])))
    })
    if (o.newValue) {
      analyzed.push(...(results as Analyzed[]))
      // The analysis workers are closed before the sum (as the app does).
      await inPhase('7c closing the analysis workers', () => sq.renew())
    } else {
      // Calibration on the main thread, as in analyzeFrame.
      for (const a of results as Analyzed[]) analyzed.push(master ? { ...a, image: await inPhase('7b calibration', () => calibrateIfNeeded(a.image)) } : a)
    }
  }
  // Warm-up: the first frame is analyzed once outside the measurement.
  if (!o.parallel) {
    const b = readFileSync(file[0])
    const l = readFits(new Uint8Array(b.buffer, b.byteOffset, b.length), file[0])
    const im = sharedImage(debayer(l.image, l.metadata.bayer))
    computeImageStats(im)
    evaluateQuality(detectStars(im), computeStats(toLuminance(im)).mad)
    computeThumbnail(im, 'NONE', true)
  }
  for (const path of o.parallel ? [] : file) {
    gc()
    const frameStart = process.memoryUsage.rss()
    peaksRss[63] = frameStart
    // Same sequence as analysis.worker.ts.
    const buf = await inPhase('1 file read (cache)', () => readFileSync(path))
    const allocate = o.newValue ? sharedFloat32 : undefined
    const readResult = await inPhase('2 FITS decoding', () => readFits(new Uint8Array(buf.buffer, buf.byteOffset, buf.length), path, allocate))
    let deb: ImageData32 | null = await inPhase('3 debayer', () => debayer(readResult.image, readResult.metadata.bayer, allocate))
    if (o.newValue) (readResult as { image: unknown }).image = null
    const image = await inPhase('4 copy to shared memory', () => sharedImage(deb as ImageData32))
    deb = null
    await inPhase('5 statistics', () => computeImageStats(image))
    const lum = o.newValue ? toLuminance(image) : undefined
    const stars = await inPhase('6 detectStars', () => detectStars(image, {}, lum))
    const quality = await inPhase('7 quality and thumbnail', () => {
      const noise = computeStats(lum ?? toLuminance(image)).mad * MAD_TO_SIGMA
      const q = evaluateQuality(stars, noise).score
      computeThumbnail(image, 'NONE', true)
      return q
    })
    const t = Math.max(peaksRss[63], process.memoryUsage.rss()) - frameStart
    if (t > transientMax) transientMax = t
    const calibrated = master ? await inPhase('7b calibration', () => calibrateIfNeeded(image)) : image
    analyzed.push({ image: calibrated, stars, quality })
  }
  gc()
  const rssKept = process.memoryUsage.rss()
  console.log('stars found per frame: ' + analyzed.map((a) => a.stars.length).join(' '))
  console.log('maximum transient of one frame in analysis: ' + gb(transientMax) + ' GB (' + (transientMax / n).toFixed(1) + ' B/px)')
  console.log('analyzed frames kept in memory: RSS ' + gb(rssKept) + ' GB (+' + gb(rssKept - rssBefore) + ' GB)')

  // Alignment on the best frame, as in stackAnalyzed.
  const qMax = Math.max(...analyzed.map((a) => a.quality), 1e-9)
  const iRef = analyzed.findIndex((a) => a.quality === qMax)
  const ref = analyzed[iRef]
  const frame: FrameToStack[] = [{ image: ref.image, transformation: IDENTITY_TRANSFORMATION, weight: 1 }]
  let validItems = 0
  await inPhase('8 alignment', () => {
    analyzed.forEach((a, i) => {
      if (i === iRef) return
      const r = align(ref.stars, a.stars)
      if (!r.valid) return
      validItems++
      const t: Transformation = r.transformation
      frame.push({ image: a.image, transformation: t, weight: Math.max(0.2, a.quality / qMax) })
    })
  })
  console.log('aligned ' + validItems + ' of ' + (N - 1))

  // As makeShared in stackInParallel: the non-shared frames (for
  // example those calibrated before the corrections) are copied into
  // shared memory, while the originals stay alive. It must be done before
  // every message to the threads: a non-shared frame would be cloned
  // in each message (8 frames of 61 MP: 5.6 GB per band).
  if (o.calibrate && !withinLimit('shared copies for the sum', frame.filter((f) => !isCompact(f.image) && !isShared(f.image.data)).length * frameBytes)) {
    Atomics.store(sampleState, 0, -1); await camp.terminate(); await sq.close(); return
  }
  const summable = await inPhase('8b copy to shared memory', () => frame.map((f) => ({ ...f, image: sharedHold(f.image) })))
  // Stacking: the two variants in the same process, after a warm-up pass
  // on a thin band (compiles the code in the threads).
  for (const method of ['rejection', 'mean'] as const) {
    const test = sharedFloat32(w * h * 3)
    await Promise.all(Array.from({ length: o.workers * 2 }, (_, i) => sq.run({ type: 'band',
      p: { frame: summable, options: { method, rejectionThreshold: 3 }, yStart: i * 8, yEnd: i * 8 + 8, output: test } })))
  }
  gc()
  const sum = await inPhase('9 stacking with rejection', () => stackParallel(sq, summable, { method: 'rejection', rejectionThreshold: 3 }))
  gc()
  await inPhase('10 stacking mean', () => stackParallel(sq, summable, { method: 'mean', rejectionThreshold: 3 }))
  gc()
  console.log('rejected values (rejection): ' + sum.rejected)
  // Fingerprint of the result: comparing it between two versions of the code
  // shows whether stacking gives the same values bit for bit.
  const fingerprint = fingerprintOf(sum.image.data)
  console.log('fingerprint of the stack (rejection): ' + fingerprint)

  if (o.drizzle) {
    const needed = drizzleMemory(w, h, 3, 2, true)
    if (withinLimit('drizzle 2x (in addition to the frames)', needed)) {
      await inPhase('11 drizzle 2x (rejection)', () => drizzleInParallel(sq, summable, { method: 'rejection', rejectionThreshold: 3 }))
      gc()
    }
  }

  // From here on only the result is needed: the frames are let go, as
  // the app should be able to do after stacking.
  frame.length = 0
  summable.length = 0
  analyzed.length = 0
  gc()

  if (o.process && withinLimit('processing (about 12 copies of the stack)', 12 * frameBytes)) {
    let im = sum.image
    await inPhase('12 autoStretch', () => autoStretch(im))
    await inPhase('13 estimateNoise', () => estimateNoise(im))
    const first = await inPhase('14 first stage (cleanup, trails, background, color)', () =>
      firstStage(im, ABRACADABRA_PROCESSING, true, true))
    im = first.image
    if (first.parameters.deconvolution.iterations > 0) {
      im = await inPhase('15 deconvolution (stripes)', () => deconvParallel(sq, im, first.parameters.deconvolution))
    }
    if (first.parameters.nlBayes > 0) {
      const base = im
      im = await inPhase('16 NL-Bayes (stripes)', async () => applyReductionAmount(base, await nlBayesPar(sq, base), first.parameters.nlBayes))
    }
    const third = await inPhase('17 third stage (wavelets, stars, contrast)', () => thirdStage(im, first.parameters, true))
    im = third.image
    gc()
    const final = await inPhase('18 finishing and corrections (export)', () => {
      const fin = abracadabraFinish(im, first.measurements)
      const r = fin.adjustments
      const par: CorrectionParams = { ...r, skyBackground: imageSkyBackground(im), ghs: r.withGhs ? r.ghs : undefined }
      return applyCorrections(im, par)
    })
    await inPhase('19 TIFF 16-bit encoding', () => encodeTiff(final, 16))
    gc()
    await inPhase('20 FITS 16-bit encoding', () => encodeFits(final, {}, 16))
    console.log('parameters: deconvolution ' + JSON.stringify(first.parameters.deconvolution) + ', nlBayes ' + first.parameters.nlBayes)
  }

  Atomics.store(sampleState, 0, -1)
  await camp.terminate()
  await sq.close()

  // Report: time, share, RSS peak, arrayBuffers and RSS at the end of the phase.
  const names = [...phaseTime.keys()]
  const total = names.reduce((s, k) => s + (phaseTime.get(k) ?? 0), 0)
  console.log('\nphase                                             time s   share  peak RSS GB  growth GB  arrayBuffers GB  end RSS GB')
  const rows = names.map((k) => {
    const t = phaseTime.get(k) ?? 0
    const r = {
      phase: k, seconds: t / 1000, share: t / total,
      peakRssGB: peaksRss[phaseIndex(k)] / GB, growthGB: (phaseIncrement.get(k) ?? 0) / GB, arrayBuffersGB: (arrayBuffersByPhase.get(k) ?? 0) / GB, rssEndGB: (rssEnd.get(k) ?? 0) / GB
    }
    console.log(k.padEnd(48) + r.seconds.toFixed(2).padStart(9) + (r.share * 100).toFixed(1).padStart(7) + '%' +
      r.peakRssGB.toFixed(2).padStart(13) + r.growthGB.toFixed(2).padStart(12) + r.arrayBuffersGB.toFixed(2).padStart(17) + r.rssEndGB.toFixed(2).padStart(13))
    return r
  })
  console.log('total'.padEnd(48) + (total / 1000).toFixed(2).padStart(9))
  if (o.json) {
    writeFileSync(o.json, JSON.stringify({
      w, h, planes, N, workers: o.workers, totalmem: totalmem(), transientFrame: transientMax, fingerprint,
      rssKept, rssBefore, rows
    }, null, 1))
  }
}

/* ------------------------------------------------------------------ */
/* Startup                                                            */
/* ------------------------------------------------------------------ */

if (!isMainThread) {
  const d = workerData as { role: string; state?: Int32Array; peaks?: Float64Array }
  if (d.role === 'sample') sampler(d.state as Int32Array, d.peaks as Float64Array)
  else {
    parentPort?.on('message', (m: ThreadTask) => {
      const { response, transfer } = threadWork(m)
      parentPort?.postMessage(response, transfer)
    })
  }
} else {
  const [command, ...remainder] = process.argv.slice(2)
  if (command === 'generate') {
    generate(remainder[0], Number(remainder[1]), remainder[2] === 'rgb' ? 'rgb' : 'bayer', remainder[3])
  } else if (command === 'measure') {
    const i = remainder.indexOf('--workers')
    const j = remainder.indexOf('--json')
    const q = remainder.indexOf('--count')
    const workers = Math.min(i >= 0 ? Number(remainder[i + 1]) : 12, Math.floor(cpus().length / 2))
    await measurement(remainder[0], {
      parallel: remainder.includes('--parallel-analysis'), drizzle: remainder.includes('--drizzle'), process: remainder.includes('--process'), workers, json: j >= 0 ? remainder[j + 1] : undefined,
      count: q >= 0 ? Number(remainder[q + 1]) : undefined,
      calibrate: remainder.includes('--calibrate'),
      newValue: remainder.includes('--new'),
      wholeMasters: remainder.includes('--whole-masters')
    })
  } else {
    console.log('Usage: generate <26|45|61|WxH> <count> <bayer|rgb> <folder>  |  measure <folder> [--drizzle] [--process] [--workers N] [--json f]')
  }
}
