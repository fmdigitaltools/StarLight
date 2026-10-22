/**
 * Full test of the stacking workflow on real raw frames.
 *
 * Repeats in Node, with Node workers in place of the browser ones, what the
 * application does when "Stack" is pressed (`hooks/useStacking.ts` and
 * `workers/analysis.worker.ts`): reading and color reconstruction, star
 * detection and quality score, reference choice, rejection of frames below
 * the threshold, star-based alignment, sum with outlier rejection.
 * The computing functions are the same as in `src/core`; the selection
 * logic is copied from `stackAnalyzed` (which lives in a React hook and
 * cannot be imported here) and must be kept in line by hand.
 *
 * Writes the timings of each phase, the rejected frames and why, the
 * estimated field rotation, the noise before and after, the crop proposed
 * for edges covered by few frames, and the stretched images (a single
 * frame, the result, the cropped result and the coverage map) to inspect
 * by eye.
 *
 * The quality score is the session-relative one (`relativeQuality`), as in
 * the application; the table also shows the absolute score of the frame
 * taken alone.
 *
 * Usage (meant for a series of about a hundred real raw frames):
 *   esbuild tools/try-real-stacking.ts --bundle --platform=node
 *     --format=esm --alias:@shared=./src/shared --alias:@core=./src/core
 *     --outfile=<your file>.mjs
 *   node <your file>.mjs <frames folder> <images folder>
 *     [minimum quality in %, 40] [rejection threshold, 3]
 *
 * About 80 MB of memory per 6-megapixel color frame are needed:
 * 120 frames are almost 10 GB.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { readFits } from '../src/core/fits/reader'
import { debayer, toLuminance } from '../src/core/image/debayer'
import { computeStats, MAD_TO_SIGMA, estimateNoise } from '../src/core/image/stats'
import { autoStretch, applyStretchValue } from '../src/core/image/stretch'
import {
  DEFAULT_MIN_QUALITY,
  relativeQuality,
  detectStars,
  evaluateQuality,
  type Star
} from '../src/core/stars/detection'
import { coverageMap, suggestCoverageCrop } from '../src/core/stack/coverage'
import {
  align,
  rotationDegrees,
  scale,
  requiredStars,
  IDENTITY_TRANSFORMATION,
  type Transformation
} from '../src/core/stack/alignment'
import { stackBand, type FrameToStack, type BandParams } from '../src/core/stack/stacking'
import { sharedFloat32, sharedImage } from '../src/shared/sharedMemory'
import type { FrameMetadata, ImageData32 } from '../src/shared/types'
import { encodePng } from './plugin-node'

// ---------------------------------------------------------------------------
// Workers: analysis of one frame or sum of one band.
// ---------------------------------------------------------------------------

interface AnalysisTask {
  type: 'analysis'
  path: string
  name: string
}
interface BandTask {
  type: 'band'
  parameters: BandParams
}

interface AnalysisResult {
  name: string
  image: ImageData32
  metadata: FrameMetadata
  stars: Star[]
  /** Session-relative score, assigned after all frames are analyzed. */
  quality: number
  /** Absolute score of the frame taken alone. */
  absolute: number
  hfr: number
  background: number
  noise: number
  ms: number
}

if (!isMainThread && parentPort) {
  const port = parentPort
  port.on('message', (c: AnalysisTask | BandTask) => {
    if (c.type === 'band') {
      port.postMessage(stackBand(c.parameters))
      return
    }
    const t0 = performance.now()
    // Come analysis.worker.ts.
    const r = readFits(new Uint8Array(readFileSync(c.path)), c.name)
    const image = sharedImage(debayer(r.image, r.metadata.bayer))
    const stars = detectStars(image)
    const lumStats = computeStats(toLuminance(image))
    const noise = lumStats.mad * MAD_TO_SIGMA
    const q = evaluateQuality(stars, noise)
    const result: AnalysisResult = {
      name: c.name,
      image,
      metadata: { ...r.metadata, instrumentInfo: null },
      stars,
      quality: 0,
      absolute: q.score,
      hfr: q.medianHfr,
      background: lumStats.median,
      noise,
      ms: performance.now() - t0
    }
    port.postMessage(result)
  })
}

/** Small pool of Node workers with a queue. */
class WorkerPool {
  private free: Worker[] = []
  private tail: { task: unknown; solve: (v: unknown) => void }[] = []
  private allItems: Worker[] = []
  constructor(count: number) {
    const file = fileURLToPath(import.meta.url)
    for (let i = 0; i < count; i++) {
      const w = new Worker(file)
      this.allItems.push(w)
      this.free.push(w)
    }
  }
  run<T>(task: unknown): Promise<T> {
    return new Promise((solve) => {
      this.tail.push({ task, solve: solve as (v: unknown) => void })
      this.start()
    })
  }
  private start(): void {
    while (this.free.length > 0 && this.tail.length > 0) {
      const w = this.free.pop() as Worker
      const { task, solve } = this.tail.shift() as { task: unknown; solve: (v: unknown) => void }
      w.once('message', (m) => {
        this.free.push(w)
        solve(m)
        this.start()
      })
      w.postMessage(task)
    }
  }
  close(): void {
    for (const w of this.allItems) void w.terminate()
  }
}

// ---------------------------------------------------------------------------
// Images to look at.
// ---------------------------------------------------------------------------

/** Downsamples by an integer factor by averaging blocks. */
function reduce(im: ImageData32, f: number): ImageData32 {
  const w = Math.floor(im.width / f)
  const h = Math.floor(im.height / f)
  const n = im.width * im.height
  const d = new Float32Array(w * h * im.channels)
  for (let c = 0; c < im.channels; c++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let j = 0; j < f; j++)
          for (let i = 0; i < f; i++) s += im.data[c * n + (y * f + j) * im.width + x * f + i]
        d[c * w * h + y * w + x] = s / (f * f)
      }
  return { width: w, height: h, channels: im.channels, data: d }
}

/** Rectangular crop at full resolution. */
function cropRegion(im: ImageData32, x0: number, y0: number, w: number, h: number): ImageData32 {
  const n = im.width * im.height
  const d = new Float32Array(w * h * im.channels)
  for (let c = 0; c < im.channels; c++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) d[c * w * h + y * w + x] = im.data[c * n + (y0 + y) * im.width + x0 + x]
  return { width: w, height: h, channels: im.channels, data: d }
}

/**
 * Neutral background: brings the median and spread of each channel to
 * those of green, as background neutralization does. For viewing only: raw
 * frames have no white balance.
 */
function neutralize(im: ImageData32): ImageData32 {
  const n = im.width * im.height
  const s = [0, 1, 2].map((c) => computeStats(im.data.subarray(c * n, (c + 1) * n)))
  const d = new Float32Array(im.data.length)
  for (let c = 0; c < 3; c++) {
    const k = s[1].mad / Math.max(1e-9, s[c].mad)
    for (let i = 0; i < n; i++) d[c * n + i] = s[1].median + (im.data[c * n + i] - s[c].median) * k
  }
  return { ...im, data: d }
}

/** PNG stretched with the application's automatic stretch. */
function png(im: ImageData32, path: string, stretch = autoStretch(im)): void {
  const n = im.width * im.height
  const rgba = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = im.data[(im.channels === 3 ? c : 0) * n + i]
      rgba[i * 4 + c] = Math.round(applyStretchValue(v < 0 ? 0 : v > 1 ? 1 : v, stretch) * 255)
    }
    rgba[i * 4 + 3] = 255
  }
  writeFileSync(path, encodePng(im.width, im.height, rgba))
}

// ---------------------------------------------------------------------------
// Main flow.
// ---------------------------------------------------------------------------

const sec = (ms: number): string => (ms / 1000).toFixed(1) + ' s'

async function main(): Promise<void> {
  const folder = process.argv[2]
  const output = process.argv[3]
  const minQuality = Number(process.argv[4] ?? DEFAULT_MIN_QUALITY)
  const rejectionThreshold = Number(process.argv[5] ?? 3)
  if (!folder || !output) throw new Error('Usage: <frames folder> <images folder> [quality] [threshold]')
  mkdirSync(output, { recursive: true })

  const names = readdirSync(folder)
    .filter((f) => /\.fits?$/i.test(f))
    .sort()
  const analysisCount = Math.min(12, cpus().length)
  const bandCount = Math.max(2, cpus().length - 2)
  console.log(names.length + ' frames, ' + analysisCount + ' analysis workers, ' + bandCount + ' sum workers')

  // --- Analysis ---
  const tAnalysis = performance.now()
  const workerPool = new WorkerPool(Math.max(analysisCount, bandCount))
  const analyzed: AnalysisResult[] = []
  let doneItems = 0
  // The queue is limited to the analysis workers, as the application does.
  const batches: Promise<void>[] = []
  let next = 0
  for (let k = 0; k < analysisCount; k++) {
    batches.push(
      (async () => {
        while (next < names.length) {
          const name = names[next++]
          const e = await workerPool.run<AnalysisResult>({ type: 'analysis', path: join(folder, name), name })
          analyzed.push(e)
          if (++doneItems % 20 === 0) console.log('  analyzed ' + doneItems)
        }
      })()
    )
  }
  await Promise.all(batches)
  analyzed.sort((a, b) => a.name.localeCompare(b.name))
  const analysisMs = performance.now() - tAnalysis
  const m0 = analyzed[0].metadata
  console.log(
    'Metadata of the first: type ' + m0.frameType + ', exposure ' + m0.exposure + ' s, Bayer ' + m0.bayer +
      ', pixel ' + m0.pixelSize + ' um, scale ' + (m0.pixelScale?.toFixed(2) ?? '-') + '"/px, sensor ' +
      m0.sensorTemp + ' C'
  )
  const types = new Map<string, number>()
  for (const a of analyzed) types.set(a.metadata.frameType, (types.get(a.metadata.frameType) ?? 0) + 1)
  console.log('Recognized types: ' + [...types].map(([t, q]) => t + ' ' + q).join(', '))
  console.log('Analysis: ' + sec(analysisMs) + ' (mean per frame on one worker ' +
    (analyzed.reduce((s, a) => s + a.ms, 0) / analyzed.length).toFixed(0) + ' ms)')

  // --- Session-relative score (as in stackAnalyzed) ---
  const relative = relativeQuality(analyzed.map((a) => ({ starCount: a.stars.length, medianHfr: a.hfr })))
  analyzed.forEach((a, i) => (a.quality = relative[i]))

  // --- Reference and alignment (as in stackAnalyzed) ---
  const tAlign = performance.now()
  const byQuality = [...analyzed].sort((a, b) => b.quality - a.quality)
  const ref = byQuality[0]
  const refStars = requiredStars(ref.stars)
  interface Row {
    a: AnalysisResult
    isUsed: boolean
    reason: string
    t: Transformation
    error: number
    matching: number
  }
  const rows: Row[] = analyzed.map((a) => {
    if (a === ref) return { a, isUsed: true, reason: 'reference', t: IDENTITY_TRANSFORMATION, error: 0, matching: 0 }
    if (a.quality < minQuality) {
      return { a, isUsed: false, reason: 'quality below the threshold relative to the best frames', t: IDENTITY_TRANSFORMATION, error: 0, matching: 0 }
    }
    const r = align(refStars, requiredStars(a.stars))
    return {
      a,
      isUsed: r.valid,
      reason: r.valid ? 'stacked' : 'stars not recognized',
      t: r.transformation,
      error: r.meanError,
      matching: r.matchingStars
    }
  })
  const alignMs = performance.now() - tAlign

  console.log('\nReference: ' + ref.name + ' (quality ' + ref.quality + ', HFR ' + ref.hfr.toFixed(2) + ')')
  console.log('frame            qual   abs  stars   HFR    bkg  noise      dx     dy     rot°   scale    err  result')
  for (const r of rows) {
    console.log(
      r.a.name.padEnd(16) +
        (r.a.quality + '%').padStart(5) +
        String(r.a.absolute).padStart(5) +
        String(r.a.stars.length).padStart(8) +
        r.a.hfr.toFixed(2).padStart(6) +
        (r.a.background * 65535).toFixed(0).padStart(7) +
        (r.a.noise * 65535).toFixed(1).padStart(7) +
        r.t.tx.toFixed(1).padStart(8) +
        r.t.ty.toFixed(1).padStart(7) +
        rotationDegrees(r.t).toFixed(3).padStart(8) +
        scale(r.t).toFixed(4).padStart(8) +
        (Number.isFinite(r.error) ? r.error.toFixed(2) : 'inf').padStart(6) +
        '  ' +
        r.reason
    )
  }
  const usedValues = rows.filter((r) => r.isUsed)
  const rejected = rows.filter((r) => !r.isUsed)
  const rotations = usedValues.map((r) => rotationDegrees(r.t))
  console.log(
    '\nUsed ' + usedValues.length + ' of ' + rows.length + '; rejected ' + rejected.length +
      ' (' + rejected.map((r) => r.a.name + ': ' + r.reason).join('; ') + ')'
  )
  console.log(
    'Estimated rotation between the used frames: from ' + Math.min(...rotations).toFixed(3) + '° to ' +
      Math.max(...rotations).toFixed(3) + '°; maximum shift ' +
      Math.max(...usedValues.map((r) => Math.hypot(r.t.tx, r.t.ty))).toFixed(1) + ' px'
  )
  console.log('Alignment: ' + sec(alignMs))

  // --- Sum with rejection, in parallel bands ---
  const tSum = performance.now()
  const frame: FrameToStack[] = usedValues.map((r) => ({
    image: r.a.image,
    transformation: r.t,
    weight: Math.max(0.2, r.a.quality / 100)
  }))
  // The reference goes first: stackBand works on its grid.
  frame.sort((x, y) => (x.image === ref.image ? -1 : y.image === ref.image ? 1 : 0))
  const { width: w, height: h, channels: channelCount } = ref.image
  const data = sharedFloat32(w * h * channelCount)
  const step = Math.ceil(h / bandCount)
  const results = await Promise.all(
    Array.from({ length: bandCount }, (_, k) =>
      workerPool.run<{ contributions: number; rejectedValues: number }>({
        type: 'band',
        parameters: {
          frame,
          options: { method: 'rejection', rejectionThreshold },
          yStart: k * step,
          yEnd: Math.min(h, (k + 1) * step),
          output: data
        }
      })
    )
  )
  const sumMs = performance.now() - tSum
  workerPool.close()
  const rejectedValues = results.reduce((s, e) => s + e.rejectedValues, 0)
  const contributions = results.reduce((s, e) => s + e.contributions, 0)
  const stackedImage: ImageData32 = { width: w, height: h, channels: channelCount, data: data }
  console.log(
    'Sum: ' + sec(sumMs) + ', rejected values ' + rejectedValues + ' (' +
      ((rejectedValues / contributions) * 100).toFixed(2) + '% of samples)'
  )

  // --- Noise ---
  const noiseBefore = estimateNoise(ref.image)
  const noiseAfter = estimateNoise(stackedImage)
  console.log(
    'Noise (app estimate) single frame ' + (noiseBefore * 65535).toFixed(2) + ' ADU, stacked ' +
      (noiseAfter * 65535).toFixed(2) + ' ADU: reduced by a factor of ' + (noiseBefore / noiseAfter).toFixed(2) +
      ' (expected for ' + usedValues.length + ' frame circa ' + Math.sqrt(usedValues.length).toFixed(1) + ')'
  )
  const total = analysisMs + alignMs + sumMs
  console.log('Total time ' + sec(total))

  // --- Images ---
  const single = neutralize(ref.image)
  const sum = neutralize(stackedImage)
  // Same stretch for both, computed on the result, so the
  // noise comparison is fair.
  const dist = autoStretch(sum)
  png(reduce(single, 3), join(output, 'single-reduced.png'), autoStretch(single))
  png(reduce(sum, 3), join(output, 'stacked-reduced.png'), dist)
  png(reduce(stackedImage, 3), join(output, 'stacked-raw-colors.png'), autoStretch(stackedImage))
  const cx = Math.round(w / 2 - 400)
  const cy = Math.round(h / 2 - 300)
  png(cropRegion(single, cx, cy, 800, 600), join(output, 'single-crop.png'), dist)
  png(cropRegion(sum, cx, cy, 800, 600), join(output, 'stacked-crop.png'), dist)

  // --- Edges covered by few frames (as in stackAnalyzed) ---
  const tCoverage = performance.now()
  const geometries = frame.map((f) => ({
    transformation: f.transformation,
    width: f.image.width,
    height: f.image.height
  }))
  const proposal = suggestCoverageCrop(geometries, w, h, 0.7)
  const coverageMs = performance.now() - tCoverage
  if (proposal === null) {
    console.log('Edges: no crop proposed (' + sec(coverageMs) + ')')
  } else {
    const rg = proposal.crop
    const px = {
      x: Math.round(rg.x * w),
      y: Math.round(rg.y * h),
      w: Math.round(rg.width * w),
      h: Math.round(rg.height * h)
    }
    console.log(
      'Edges covered by few frames: proposed crop x ' + px.x + ', y ' + px.y + ', ' + px.w + 'x' + px.h +
        ' px (keeps ' + (proposal.keptArea * 100).toFixed(1) + '% of the area; minimum coverage ' +
        (proposal.minCoverage * 100).toFixed(0) + '% of frames; computation ' + coverageMs.toFixed(0) + ' ms)'
    )
    png(reduce(cropRegion(sum, px.x, px.y, px.w, px.h), 3), join(output, 'stacked-cropped-reduced.png'), dist)
    // The bottom-right corner at full resolution, before and after: that is
    // where the noisy frame shows.
    const side = { w: Math.min(600, w), h: Math.min(400, h) }
    png(cropRegion(sum, w - side.w, h - side.h, side.w, side.h), join(output, 'edge-before.png'), dist)
    png(
      cropRegion(sum, px.x + px.w - side.w, px.y + px.h - side.h, side.w, side.h),
      join(output, 'edge-after.png'),
      dist
    )

    // Coverage map in grays (black no frames, white all), with the
    // proposed rectangle in red.
    const m = coverageMap(geometries, w, h)
    const rgba = new Uint8Array(m.columns * m.rows * 4)
    for (let i = 0; i < m.columns * m.rows; i++) {
      const v = Math.round((m.counts[i] / frame.length) * 255)
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v
      rgba[i * 4 + 3] = 255
    }
    const c0 = Math.floor(px.x / m.step)
    const r0 = Math.floor(px.y / m.step)
    const c1 = Math.min(m.columns - 1, Math.floor((px.x + px.w - 1) / m.step))
    const r1 = Math.min(m.rows - 1, Math.floor((px.y + px.h - 1) / m.step))
    const red = (c: number, r: number): void => {
      const i = (r * m.columns + c) * 4
      rgba[i] = 255
      rgba[i + 1] = 40
      rgba[i + 2] = 40
    }
    for (let c = c0; c <= c1; c++) {
      red(c, r0)
      red(c, r1)
    }
    for (let r = r0; r <= r1; r++) {
      red(c0, r)
      red(c1, r)
    }
    writeFileSync(join(output, 'coverage-map.png'), encodePng(m.columns, m.rows, rgba))
  }
  console.log('Images in ' + output)
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
