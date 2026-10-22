/**
 * Measures the analysis phase, the full integration, cold reads and memory.
 *
 * The workers here are Node workers, not browser ones, but the JavaScript
 * engine, the system threads and the shared memory are the same, so the
 * timings also hold for the application. The measured code is the real code
 * (`@core/...`), in the same sequence as the application's analysis worker.
 * Worker pools stay alive between measurements, as in `pool.ts`.
 *
 * Usage: TEST_SCRIPT=tools/test-analysis.ts node tools/run-test.mjs [sections]
 * Sections are listed separated by spaces; with no arguments it runs
 * ceiling, integration and cold.
 *
 *   ceiling       how many workers are worth giving to the analysis.
 *                 COUNTS=4,8,12  FRAME=48  ROUNDS=4
 *   integration   analysis + alignment + stacking for sessions of
 *                 various sizes. WORKERS=12  SESSIONS=24,96,300
 *   cold          reads with and without the system cache, on two
 *                 disks. COPIES=96 (how many files to replicate)
 *   sorting       how stacking grows with the number of frames, and
 *                 how much of it is sorting. SESSIONS=24,48,96,300
 *   selection     median by sorting or by selection, outside the engine:
 *                 puts a number on the payoff of an algorithm change.
 *   bands         how many bands are worth giving to the stacking.
 *                 SESSIONS=96  BANDS=8,12,16,20,24,28
 *   limit         how far shared memory allocation can go.
 *                 FRAME_CEILING=1800
 *   overflow      stacking of a session while memory is taken away.
 *                 SESSIONS=300  BALLAST=40 (gigabytes)
 *
 * To pin the workers to the fast cores (for example logical cores 0-15 on
 * a processor with two core types), launch the whole test like this from
 * PowerShell:
 *   cmd /c "start /affinity ffff /wait /b node tools\run-test.mjs ceiling"
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, tmpdir, totalmem, freemem } from 'node:os'
import { execFileSync } from 'node:child_process'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { readFits } from '../src/core/fits/reader'
import { debayer, toLuminance } from '../src/core/image/debayer'
import { computeImageStats, computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { detectStars, evaluateQuality, type Star } from '../src/core/stars/detection'
import { align, IDENTITY_TRANSFORMATION } from '../src/core/stack/alignment'
import {
  stackBand,
  type FrameToStack,
  type StackingOptions,
  type BandParams
} from '../src/core/stack/stacking'
import type { ImageData32 } from '../src/shared/types'
import { sharedFloat32, sharedImage, sharedMemoryAvailable } from '../src/shared/sharedMemory'
import { testFile } from './test-files.mjs'

const OPTIONS: StackingOptions = { method: 'rejection', rejectionThreshold: 3 }
const CORES = cpus().length

/** Timings of the four parts of the analysis of one frame, in ms. */
interface AnalysisTimes {
  fits: number
  debayer: number
  stats: number
  stars: number
  total: number
}

interface AnalysisResult {
  image: ImageData32
  stars: Star[]
  quality: number
  t: AnalysisTimes
}

type Task =
  | { k: 'analysis'; buffer: ArrayBuffer; fileName: string; withStars: boolean }
  | { k: 'band'; p: BandParams }

/**
 * Worker branch: runs the analysis of one frame in the same sequence as
 * `analysis.worker.ts`, or one stacking band.
 */
if (!isMainThread && parentPort) {
  const port = parentPort
  port.on('message', (m: Task) => {
    if (m.k === 'band') {
      port.postMessage(stackBand(m.p))
      return
    }
    const t0 = performance.now()
    const readResult = readFits(new Uint8Array(m.buffer), m.fileName)
    const t1 = performance.now()
    // `sharedImage` is included in the debayer time, as in the
    // application: it is the copy that makes the pixels visible to all.
    const image = sharedImage(debayer(readResult.image, readResult.metadata.bayer))
    const t2 = performance.now()
    const stats = computeImageStats(image)
    const t3 = performance.now()
    let stars: Star[] = []
    let quality = 0
    if (m.withStars) {
      stars = detectStars(image)
      const noise = computeStats(toLuminance(image)).mad * MAD_TO_SIGMA
      quality = evaluateQuality(stars, noise).score
    }
    const t4 = performance.now()
    if (stats.max < -1) throw new Error('impossible')
    port.postMessage({
      image,
      stars,
      quality,
      t: { fits: t1 - t0, debayer: t2 - t1, stats: t3 - t2, stars: t4 - t3, total: t4 - t0 }
    } satisfies AnalysisResult)
  })
}

// The runner always compiles to the same temporary file: if another test
// starts in the meantime it overwrites it and the workers would run the
// wrong program. A private copy bound to the process is made instead.
const THIS_FILE = fileURLToPath(import.meta.url)
const WORKER_FILE = join(tmpdir(), 'starlight-analysis-' + process.pid + '.mjs')
if (isMainThread) copyFileSync(THIS_FILE, WORKER_FILE)

/**
 * Pool of persistent workers, like the worker pool in `pool.ts`: workers
 * stay ready and receive a new task as soon as they are free. Keeping them
 * alive matters: starting one costs tens of ms.
 */
type Solve = (r: unknown) => void

class WorkerPool {
  private workers: Worker[] = []
  private free: Worker[] = []
  private tail: { msg: Task; solve: Solve }[] = []
  private pending = new Map<Worker, Solve>()

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const l = new Worker(WORKER_FILE)
      l.on('message', (r) => {
        const solve = this.pending.get(l)
        this.pending.delete(l)
        this.free.push(l)
        if (solve) solve(r)
        this.start()
      })
      l.on('error', (e) => {
        console.error('worker error:', e)
        process.exit(1)
      })
      this.workers.push(l)
      this.free.push(l)
    }
  }

  get size(): number {
    return this.workers.length
  }

  run<R>(msg: Task): Promise<R> {
    return new Promise<R>((solve) => {
      this.tail.push({ msg, solve: solve as Solve })
      this.start()
    })
  }

  private start(): void {
    while (this.free.length > 0 && this.tail.length > 0) {
      const l = this.free.pop() as Worker
      const c = this.tail.shift() as { msg: Task; solve: Solve }
      this.pending.set(l, c.solve)
      l.postMessage(c.msg, c.msg.k === 'analysis' ? [c.msg.buffer] : [])
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((l) => l.terminate()))
    this.workers = []
    this.free = []
    this.pending.clear()
  }
}

const ms = (x: number): string => (x >= 1000 ? (x / 1000).toFixed(2) + ' s' : x.toFixed(0) + ' ms')
const gb = (b: number): string => (b / 1024 ** 3).toFixed(2) + ' GB'
const col = (s: string, n: number): string => s.padStart(n)

/** Bytes of the sample files, read once and kept in memory. */
function loadSamples(folder: string): { name: string; byte: Buffer }[] {
  const names = readdirSync(folder)
    .filter((f) => /\.fits?$/i.test(f))
    .sort()
  return names.map((name) => ({ name, byte: readFileSync(join(folder, name)) }))
}

/**
 * Prepares the analysis tasks by replicating the samples. Each task has
 * its own buffer because transferring it to the worker empties it: the
 * copy is made before the stopwatch starts, so it is not part of the
 * measurement.
 */
function prepareTasks(
  samples: { name: string; byte: Buffer }[],
  count: number,
  withStars: boolean
): Task[] {
  const tasks: Task[] = []
  for (let i = 0; i < count; i++) {
    const c = samples[i % samples.length]
    const buffer = new ArrayBuffer(c.byte.byteLength)
    new Uint8Array(buffer).set(c.byte)
    tasks.push({ k: 'analysis', buffer, fileName: c.name, withStars })
  }
  return tasks
}

interface LotResult {
  wall: number
  sum: AnalysisTimes
  results: AnalysisResult[]
}

/** Analyzes a batch of frames with the given pool and measures the wall time. */
async function analyzeBatch(
  workerPool: WorkerPool,
  tasks: Task[],
  keep: boolean
): Promise<LotResult> {
  const sum: AnalysisTimes = { fits: 0, debayer: 0, stats: 0, stars: 0, total: 0 }
  const results: AnalysisResult[] = []
  const t = performance.now()
  const workerOutcomes = await Promise.all(tasks.map((c) => workerPool.run<AnalysisResult>(c)))
  const wall = performance.now() - t
  for (const e of workerOutcomes) {
    sum.fits += e.t.fits
    sum.debayer += e.t.debayer
    sum.stats += e.t.stats
    sum.stars += e.t.stars
    sum.total += e.t.total
    if (keep) results.push(e)
  }
  return { wall, sum, results }
}

/** Stacks in bands with a pool of persistent workers. */
async function stackByBands(
  workerPool: WorkerPool,
  frame: FrameToStack[],
  bands: number
): Promise<Float32Array> {
  const first = frame[0].image
  const { width: w, height: h, channels: channelCount } = first
  const output = sharedFloat32(w * h * channelCount)
  const boundary = (i: number): number => Math.round((i * h) / bands)
  await Promise.all(
    Array.from({ length: bands }, (_, i) =>
      workerPool.run({
        k: 'band',
        p: { frame, options: OPTIONS, yStart: boundary(i), yEnd: boundary(i + 1), output }
      })
    )
  )
  return output
}

/**
 * The same analysis on the caller's thread: serves as a yardstick to tell
 * whether a single worker is placed by the system on a slow core (this
 * processor has two core types).
 */
function analyzeHere(tasks: Task[]): AnalysisTimes {
  const s: AnalysisTimes = { fits: 0, debayer: 0, stats: 0, stars: 0, total: 0 }
  for (const m of tasks) {
    if (m.k !== 'analysis') continue
    const t0 = performance.now()
    const readResult = readFits(new Uint8Array(m.buffer), m.fileName)
    const t1 = performance.now()
    const image = sharedImage(debayer(readResult.image, readResult.metadata.bayer))
    const t2 = performance.now()
    computeImageStats(image)
    const t3 = performance.now()
    const stars = detectStars(image)
    const noise = computeStats(toLuminance(image)).mad * MAD_TO_SIGMA
    evaluateQuality(stars, noise)
    const t4 = performance.now()
    s.fits += t1 - t0
    s.debayer += t2 - t1
    s.stats += t3 - t2
    s.stars += t4 - t3
    s.total += t4 - t0
  }
  return s
}

/** SECTION 1: how many workers are worth using for the analysis. */
async function ceilingSection(samples: { name: string; byte: Buffer }[]): Promise<void> {
  console.log('=== 1. ANALYSIS WORKER CEILING ===')
  console.log('FITS parsing + debayer + statistics + stars, replicated frames')
  console.log('buffers prepared in memory before the stopwatch: no disk in the measurement')
  console.log('counts are alternated on every pass, so a machine drift')
  console.log('does not fall on a single count.\n')

  // Reference on the main thread, to compare with a single worker.
  analyzeHere(prepareTasks(samples, 6, true))
  const here = analyzeHere(prepareTasks(samples, 12, true))
  console.log(
    'main thread, no workers: ' + (here.total / 12).toFixed(0) +
      ' ms per frame (fits ' + (here.fits / 12).toFixed(0) + ' debayer ' +
      (here.debayer / 12).toFixed(0) + ' stats ' + (here.stats / 12).toFixed(0) +
      ' stars ' + (here.stars / 12).toFixed(0) + ')'
  )
  console.log('')

  // COUNTS and ROUNDS can be narrowed for a quick test.
  const counts = (process.env.COUNTS ?? '1,4,8,10,12,14,16,20,24,28')
    .split(',')
    .map(Number)
  const frameCount = Number(process.env.FRAME ?? 48)
  const PASSES = Number(process.env.ROUNDS ?? 4)
  const walls = new Map<number, number[]>()
  const cpu = new Map<number, AnalysisTimes[]>()
  for (const q of counts) {
    walls.set(q, [])
    cpu.set(q, [])
  }

  for (let pass = 0; pass < PASSES; pass++) {
    for (const count of counts) {
      const workerPool = new WorkerPool(count)
      // Warm-up: the first pass compiles the code in the workers.
      await analyzeBatch(workerPool, prepareTasks(samples, count * 2, true), false)
      const e = await analyzeBatch(workerPool, prepareTasks(samples, frameCount, true), false)
      await workerPool.close()
      ;(walls.get(count) as number[]).push(e.wall)
      ;(cpu.get(count) as AnalysisTimes[]).push(e.sum)
    }
    process.stdout.write('pass ' + (pass + 1) + '/' + PASSES + ' done\n')
  }

  const medianValue = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
  const reference = medianValue(walls.get(counts[0]) as number[])
  console.log(
    '\n--- ' + frameCount + ' frames, ' + PASSES + ' passes, median value ---\n' +
      col('workers', 11) + col('wall', 10) + col('per frame', 11) + col('factor', 9) +
      col('yield', 7) + '   inside the worker, per frame (ms)'
  )
  for (const count of counts) {
    const m = medianValue(walls.get(count) as number[])
    const t = cpu.get(count) as AnalysisTimes[]
    const med = (f: (x: AnalysisTimes) => number): number => medianValue(t.map(f)) / frameCount
    console.log(
      col(String(count), 11) + col(ms(m), 10) + col(ms(m / frameCount), 11) +
        col((reference / m).toFixed(1) + 'x', 9) +
        col(((med((x) => x.total) * frameCount) / (m * count) * 100).toFixed(0) + '%', 7) +
        '   fits ' + med((x) => x.fits).toFixed(0).padStart(3) +
        '  debayer ' + med((x) => x.debayer).toFixed(0).padStart(3) +
        '  stats ' + med((x) => x.stats).toFixed(0).padStart(3) +
        '  stars ' + med((x) => x.stars).toFixed(0).padStart(3) +
        '  tot ' + med((x) => x.total).toFixed(0).padStart(3)
    )
  }
  console.log('\nwall time of each pass (ms):')
  for (const count of counts) {
    console.log(
      col(String(count), 11) + '  ' +
        (walls.get(count) as number[]).map((x) => x.toFixed(0).padStart(6)).join('')
    )
  }
  console.log('')
}

/** SECTION 2: time of the full integration and memory used. */
async function integrationSection(
  samples: { name: string; byte: Buffer }[],
  analysisWorkers: number,
  sessions: number[]
): Promise<void> {
  console.log('=== 2. FULL INTEGRATION ===')
  console.log(
    'analysis with ' + analysisWorkers + ' workers, sequential alignment on the main ' +
      'thread, stacking in 16 bands'
  )
  console.log('all frames are distinct in memory: no reuse of pixels already in cache\n')

  const analysisPool = new WorkerPool(analysisWorkers)
  const stackingPool = new WorkerPool(16)
  // Warm-up of both pools.
  const warmedUp = await analyzeBatch(analysisPool, prepareTasks(samples, 12, true), true)
  await stackByBands(
    stackingPool,
    warmedUp.results.slice(0, 6).map((r) => ({
      image: r.image,
      transformation: IDENTITY_TRANSFORMATION,
      weight: 1
    })),
    16
  )
  warmedUp.results.length = 0

  console.log(
    col('frames', 6) + col('analysis', 10) + col('align', 10) + col('stack', 10) +
      col('total', 10) + col('pixels', 10) + col('rss', 10) + col('free', 10)
  )
  const rows: { frame: number; analysis: number; align: number; stack: number }[] = []

  for (const count of sessions) {
    const tasks = prepareTasks(samples, count, true)
    const batch = await analyzeBatch(analysisPool, tasks, true)
    const r = batch.results

    const tAll = performance.now()
    const frame: FrameToStack[] = r.map((x, i) => ({
      image: x.image,
      transformation:
        i === 0 ? IDENTITY_TRANSFORMATION : align(r[0].stars, x.stars).transformation,
      weight: 1
    }))
    const dAll = performance.now() - tAll

    const tIm = performance.now()
    await stackByBands(stackingPool, frame, 16)
    const dIm = performance.now() - tIm

    const mem = process.memoryUsage()
    const pixel = count * r[0].image.data.length * 4
    console.log(
      col(String(count), 6) + col(ms(batch.wall), 10) + col(ms(dAll), 10) + col(ms(dIm), 10) +
        col(ms(batch.wall + dAll + dIm), 10) + col(gb(pixel), 10) +
        col(gb(mem.rss), 10) + col(gb(freemem()), 10)
    )
    rows.push({ frame: count, analysis: batch.wall, align: dAll, stack: dIm })
    r.length = 0
    frame.length = 0
    if (global.gc) global.gc()
  }

  console.log('\nshare of the total:')
  console.log(col('frames', 6) + col('analysis', 10) + col('align', 10) + col('stack', 10))
  for (const r of rows) {
    const t = r.analysis + r.align + r.stack
    console.log(
      col(String(r.frame), 6) + col(((r.analysis / t) * 100).toFixed(0) + '%', 10) +
        col(((r.align / t) * 100).toFixed(0) + '%', 10) +
        col(((r.stack / t) * 100).toFixed(0) + '%', 10)
    )
  }

  // Breakdown of the four parts of the analysis, summed over all
  // frames: shows where the compute time goes, not the wall time.
  const detail = await analyzeBatch(analysisPool, prepareTasks(samples, 24, true), false)
  const s = detail.sum
  console.log('\ninside the analysis (sum over 24 frames, compute time):')
  for (const [name, v] of [
    ['FITS parsing', s.fits],
    ['debayer + sharing', s.debayer],
    ['statistics', s.stats],
    ['stars + quality', s.stars]
  ] as [string, number][]) {
    console.log(
      '  ' + name.padEnd(24) + col(ms(v), 9) + col(((v / s.total) * 100).toFixed(0) + '%', 7)
    )
  }
  console.log('  ' + 'total'.padEnd(24) + col(ms(s.total), 9))

  await analysisPool.close()
  await stackingPool.close()
  console.log('')
}

/**
 * Script that opens every file with FILE_FLAG_NO_BUFFERING: to guarantee
 * coherence, Windows flushes that file's pages from the cache. It is the
 * only honest way to re-measure a cold read without rebooting the machine:
 * copying the files to a new folder is not enough, because the copy itself
 * puts them in the cache.
 */
const PURGE = [
  'param([string[]]$Paths)',
  '$NB = [System.IO.FileOptions]0x20000000',
  '$buf = New-Object byte[] 4096',
  'foreach ($p in $Paths) {',
  '  $fs = New-Object System.IO.FileStream($p,[System.IO.FileMode]::Open,' +
    '[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read,4096,$NB)',
  '  [void]$fs.Read($buf,0,4096)',
  '  $fs.Dispose()',
  '}'
].join('\n')

/** SECTION 3: reads with and without the system cache. */
function coldSection(folder: string): void {
  console.log('=== 3. COLD READ ===')
  const script = join(tmpdir(), 'starlight-purga-cache.ps1')
  writeFileSync(script, PURGE)

  const samples = readdirSync(folder).filter((f) => /\.fits?$/i.test(f)).sort()
  // The samples are replicated up to the file count of a real session:
  // six four-megabyte files are not enough to stress either the cache or
  // the system read-ahead.
  const copies = Number(process.env.COPIES ?? 96)
  const names = Array.from(
    { length: copies },
    (_, i) => String(i).padStart(4, '0') + '-' + samples[i % samples.length]
  )
  const source = (n: string): string => join(folder, n.slice(5))
  // The Windows temporary folder and, if given in SECOND_DISK, another
  // disk, to compare the two.
  const destinations = [
    { name: 'system disk', base: join(tmpdir(), 'starlight-read-' + Date.now()) },
    ...(process.env.SECOND_DISK
      ? [{ name: 'second disk', base: join(process.env.SECOND_DISK, 'starlight-read-' + Date.now()) }]
      : [])
  ]

  console.log(
    col('disk', 24) + col('cold', 11) + col('MB/s', 9) + col('cached', 11) + col('MB/s', 9)
  )
  for (const d of destinations) {
    mkdirSync(d.base, { recursive: true })
    const paths = names.map((n) => join(d.base, n))
    for (const n of names) copyFileSync(source(n), join(d.base, n))

    const read = (): { t: number; byte: number } => {
      let byte = 0
      const t = performance.now()
      for (const p of paths) byte += readFileSync(p).byteLength
      return { t: performance.now() - t, byte }
    }

    read() // warm-up of Node's read path
    const purge = (): void => {
      execFileSync('powershell.exe', ['-NoProfile', '-File', script, ...paths], {
        stdio: 'ignore'
      })
    }

    const coldPixels: number[] = []
    const hotPixels: number[] = []
    for (let pass = 0; pass < 3; pass++) {
      purge()
      coldPixels.push(read().t)
      hotPixels.push(read().t)
    }
    const total = names.length * readFileSync(paths[0]).byteLength
    const medianValue = (v: number[]): number => [...v].sort((a, b) => a - b)[1]
    const f = medianValue(coldPixels)
    const c = medianValue(hotPixels)
    console.log(
      col(d.name, 24) + col(ms(f), 11) + col((total / 1024 ** 2 / (f / 1000)).toFixed(0), 9) +
        col(ms(c), 11) + col((total / 1024 ** 2 / (c / 1000)).toFixed(0), 9) +
        '   cold [' + coldPixels.map((x) => x.toFixed(0)).join(' ') + '] warm [' +
        hotPixels.map((x) => x.toFixed(0)).join(' ') + ']'
    )
    rmSync(d.base, { recursive: true, force: true })
  }
  console.log('(' + names.length + ' files, ' + gb(names.length * 4150080) + ' in total)\n')
}

/** SECTION 4: how much shared memory can actually be allocated. */
function limitSection(): void {
  console.log('=== 4. MEMORY LIMIT ===')
  const perFrame = 1080 * 1920 * 3
  const blocks: Float32Array[] = []
  const t = performance.now()
  let hasFailed = 0
  try {
    for (let i = 0; i < Number(process.env.FRAME_CEILING ?? 1800); i++) {
      const b = sharedFloat32(perFrame)
      // Touching the pixels forces the system to provide real pages.
      b[0] = 1
      b[b.length - 1] = 1
      blocks.push(b)
      if ((i + 1) % 400 === 0) {
        console.log(
          '  ' + String(i + 1).padStart(4) + ' frames  ' + col(gb((i + 1) * perFrame * 4), 10) +
            '  rss ' + gb(process.memoryUsage().rss) + '  free ' + gb(freemem())
        )
      }
    }
  } catch (e) {
    hasFailed = blocks.length
    console.log(
      '  allocation failed at frame ' + (hasFailed + 1) + ' (' +
        gb(hasFailed * perFrame * 4) + '): ' + (e instanceof Error ? e.message : String(e))
    )
  }
  console.log(
    '  allocated ' + blocks.length + ' frames, ' + gb(blocks.length * perFrame * 4) +
      ', in ' + ms(performance.now() - t)
  )
  blocks.length = 0
  console.log('')
}

/**
 * SECTION 5: how stacking grows with the number of frames.
 *
 * `stackBand` sorts by insertion the frame values at each pixel: a cost
 * that grows with the square of the number of frames. The 'mean' method
 * sorts nothing and serves as a measure of the rest of the work (pixel
 * reads and interpolation), so the difference between the two tells how
 * much the sorting costs.
 */
async function sortingSection(samples: { name: string; byte: Buffer }[]): Promise<void> {
  console.log('=== 5. STACKING GROWTH ===')
  const analysisPool = new WorkerPool(12)
  const stackingPool = new WorkerPool(16)
  const sessions = (process.env.SESSIONS ?? '24,48,96,192,300').split(',').map(Number)
  const max = Math.max(...sessions)

  const batch = await analyzeBatch(analysisPool, prepareTasks(samples, max, true), true)
  const r = batch.results
  const allItems: FrameToStack[] = r.map((x, i) => ({
    image: x.image,
    transformation:
      i === 0 ? IDENTITY_TRANSFORMATION : align(r[0].stars, x.stars).transformation,
    weight: 1
  }))
  await analysisPool.close()
  // Warm-up of the band workers.
  await stackByBands(stackingPool, allItems.slice(0, 6), 16)

  console.log(
    col('frames', 6) + col('rejection', 13) + col('mean', 10) + col('difference', 12) +
      col('sort share', 11) + col('ms per frame', 14)
  )
  for (const count of sessions) {
    const frame = allItems.slice(0, count)
    const measurement = async (method: 'rejection' | 'mean'): Promise<number> => {
      const save = OPTIONS.method
      OPTIONS.method = method
      const t = performance.now()
      await stackByBands(stackingPool, frame, 16)
      const d = performance.now() - t
      OPTIONS.method = save
      return d
    }
    const a = Math.min(await measurement('rejection'), await measurement('rejection'))
    const b = Math.min(await measurement('mean'), await measurement('mean'))
    console.log(
      col(String(count), 6) + col(ms(a), 13) + col(ms(b), 10) + col(ms(a - b), 12) +
        col(((a - b) / a * 100).toFixed(0) + '%', 11) +
        col((a / count).toFixed(1) + ' / ' + (b / count).toFixed(1), 14)
    )
  }
  await stackingPool.close()
  console.log(
    "\nif the cost were linear in the frames, 'ms per frame' would stay constant.\n"
  )
}

/**
 * SECTION 6: how much it would cost to take the median without sorting.
 *
 * `stackBand` sorts all the values of the pixel just to read the middle
 * one. Here, on the same data, the insertion sort used today is compared
 * with a partition-based selection (quickselect), which finds the middle
 * value without sorting the rest. It is not a code proposal: it serves to
 * put a number on the payoff.
 */
function sortByInsertion(d: Float32Array, count: number): void {
  for (let i = 1; i < count; i++) {
    const v = d[i]
    let j = i - 1
    while (j >= 0 && d[j] > v) {
      d[j + 1] = d[j]
      j--
    }
    d[j + 1] = v
  }
}

/** Places the k-th smallest value at position k, by partitioning. */
function selectK(d: Float32Array, count: number, k: number): number {
  let bottom = 0
  let top = count - 1
  while (bottom < top) {
    const anchor = d[(bottom + top) >> 1]
    let i = bottom
    let j = top
    while (i <= j) {
      while (d[i] < anchor) i++
      while (d[j] > anchor) j--
      if (i <= j) {
        const t = d[i]
        d[i] = d[j]
        d[j] = t
        i++
        j--
      }
    }
    if (k <= j) top = j
    else if (k >= i) bottom = i
    else return d[k]
  }
  return d[bottom]
}

function selectionSection(): void {
  console.log('=== 6. MEDIAN: SORT OR SELECT ===')
  console.log('random values, like those of a pixel read from different frames\n')
  const PIXEL = 1080 * 1920 * 3
  const PASSES = 200000
  const SAMPLES = 512
  console.log(
    col('frames', 6) + col('insertion', 13) + col('selection', 11) + col('ratio', 10) +
      col('on ' + (PIXEL / 1e6).toFixed(1) + ' Mpixel: insert.', 26) + col('select.', 10)
  )
  for (const F of [24, 48, 96, 192, 300]) {
    const sources: Float32Array[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const a = new Float32Array(F)
      for (let j = 0; j < F; j++) a[j] = Math.random()
      sources.push(a)
    }
    const job = new Float32Array(F)
    let sum = 0
    const measurement = (fn: ((d: Float32Array) => void) | null): number => {
      // Warm-up and then measurement: the copy is in both runs, and
      // the copy-only run subtracts it.
      for (let repeat = 0; repeat < 2; repeat++) {
        const t = performance.now()
        for (let i = 0; i < PASSES; i++) {
          job.set(sources[i & (SAMPLES - 1)])
          if (fn) fn(job)
          sum += job[0]
        }
        if (repeat === 1) return performance.now() - t
      }
      return 0
    }
    const onlyCopy = measurement(null)
    const ins = measurement((d) => sortByInsertion(d, F)) - onlyCopy
    const sel = measurement((d) => void selectK(d, F, F >> 1)) - onlyCopy
    const scale = PIXEL / PASSES / 1000
    console.log(
      col(String(F), 6) + col(ms(ins), 13) + col(ms(sel), 11) +
        col((ins / sel).toFixed(1) + 'x', 10) + col(ms(ins * scale * 1000), 26) +
        col(ms(sel * scale * 1000), 10) + (sum < -1 ? '!' : '')
    )
  }
  console.log('')
}

/**
 * SECTION 7: what happens when the frames no longer fit in memory.
 *
 * Memory cannot be taken away from the machine, but it can be occupied: a
 * ballast of pages that are really touched forces Windows to move the
 * session's pixels to the page file, which is exactly the condition of a
 * session that is too large. BALLAST is in gigabytes.
 */
async function overflowSection(samples: { name: string; byte: Buffer }[]): Promise<void> {
  console.log('=== 7. SESSION THAT DOES NOT FIT IN MEMORY ===')
  const count = Number(process.env.SESSIONS ?? 300)
  const ballastGb = Number(process.env.BALLAST ?? 40)
  const analysisPool = new WorkerPool(12)
  const stackingPool = new WorkerPool(16)

  const batch = await analyzeBatch(analysisPool, prepareTasks(samples, count, true), true)
  const r = batch.results
  const frame: FrameToStack[] = r.map((x, i) => ({
    image: x.image,
    transformation:
      i === 0 ? IDENTITY_TRANSFORMATION : align(r[0].stars, x.stars).transformation,
    weight: 1
  }))
  await analysisPool.close()
  const pixel = count * r[0].image.data.length * 4
  console.log(
    count + ' frames, ' + gb(pixel) + ' of pixels, rss ' + gb(process.memoryUsage().rss) +
      ', free memory ' + gb(freemem())
  )

  const measurement = async (method: 'mean' | 'rejection'): Promise<number> => {
    OPTIONS.method = method
    const t = performance.now()
    await stackByBands(stackingPool, frame, 16)
    return performance.now() - t
  }
  await stackByBands(stackingPool, frame.slice(0, 6), 16)

  console.log(
    '\n' + col('state', 30) + col('mean', 10) + col('rejection', 13) + col('free', 10)
  )
  const row = async (state: string): Promise<void> => {
    const a = await measurement('mean')
    const b = await measurement('rejection')
    console.log(col(state, 30) + col(ms(a), 10) + col(ms(b), 13) + col(gb(freemem()), 10))
  }
  await row('all in memory')

  const ballast: Float32Array[] = []
  const block = 64 * 1024 * 1024
  for (let i = 0; i < Math.round((ballastGb * 1024 ** 3) / block); i++) {
    const b = new Float32Array(block / 4)
    // Touch every page: without this Windows does not assign real memory.
    for (let j = 0; j < b.length; j += 1024) b[j] = 1
    ballast.push(b)
  }
  console.log('ballast of ' + gb(ballast.length * block) + ' occupied and touched')
  await row('with the ballast')

  ballast.length = 0
  await stackingPool.close()
  console.log('')
}

/**
 * SECTION 8: how many bands are worth giving to the stacking.
 *
 * Bands are a fixed division with no rebalancing: more bands mean thinner
 * rows and a more uniform load, but also more start-ups and fewer
 * contiguous rows.
 */
async function bandsSection(samples: { name: string; byte: Buffer }[]): Promise<void> {
  console.log('=== 8. NUMBER OF STACKING BANDS ===')
  const count = Number(process.env.SESSIONS ?? 96)
  const counts = (process.env.BANDS ?? '8,12,16,20,24,28').split(',').map(Number)
  const analysisPool = new WorkerPool(12)
  const batch = await analyzeBatch(analysisPool, prepareTasks(samples, count, true), true)
  const r = batch.results
  const frame: FrameToStack[] = r.map((x, i) => ({
    image: x.image,
    transformation:
      i === 0 ? IDENTITY_TRANSFORMATION : align(r[0].stars, x.stars).transformation,
    weight: 1
  }))
  await analysisPool.close()

  const workerPool = new WorkerPool(Math.max(...counts))
  await stackByBands(workerPool, frame.slice(0, 6), Math.max(...counts))
  console.log(count + ' frames\n' + col('bands', 7) + col('stacking', 14) + '   passes')
  for (const bands of counts) {
    const t: number[] = []
    for (let g = 0; g < 3; g++) {
      const t0 = performance.now()
      await stackByBands(workerPool, frame, bands)
      t.push(performance.now() - t0)
    }
    const m = [...t].sort((a, b) => a - b)[1]
    console.log(
      col(String(bands), 7) + col(ms(m), 14) + '   [' + t.map((x) => ms(x)).join(' ') + ']'
    )
  }
  await workerPool.close()
  console.log('')
}

async function main(): Promise<void> {
  if (!sharedMemoryAvailable) {
    console.log('Shared memory not available: the test makes no sense.')
    return
  }
  const sections = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const active = sections.length > 0 ? sections : ['ceiling', 'integration', 'cold']
  const folder = testFile('synthetic-frames')
  const samples = loadSamples(folder)
  const first = readFits(new Uint8Array(samples[0].byte), samples[0].name)
  const img = debayer(first.image, first.metadata.bayer)

  console.log(
    CORES + ' logical threads, ' + gb(totalmem()) + ' of memory, ' + gb(freemem()) +
      ' free\n' + samples.length + ' samples of ' + img.width + 'x' + img.height +
      ' x' + img.channels + ', ' + (img.data.length * 4 / 1024 ** 2).toFixed(1) +
      ' MB per frame once rebuilt\n'
  )

  if (active.includes('ceiling')) await ceilingSection(samples)
  if (active.includes('integration')) {
    const n = Number(process.env.WORKERS ?? 20)
    const sessions = (process.env.SESSIONS ?? '24,96,300').split(',').map(Number)
    await integrationSection(samples, n, sessions)
  }
  if (active.includes('cold')) coldSection(folder)
  if (active.includes('sorting')) await sortingSection(samples)
  if (active.includes('selection')) selectionSection()
  if (active.includes('overflow')) await overflowSection(samples)
  if (active.includes('bands')) await bandsSection(samples)
  if (active.includes('limit')) limitSection()
  rmSync(WORKER_FILE, { force: true })
}

if (isMainThread) void main()
