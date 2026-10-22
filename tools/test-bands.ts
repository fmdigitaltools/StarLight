/**
 * Banded stacking check.
 *
 * Verifies two things: that splitting the result into bands gives exactly
 * the same pixels as the whole computation, and how much time is saved by
 * handing the bands to several threads. The workers here are Node workers
 * rather than browser workers, but the JavaScript engine and the system
 * threads are the same, so the timings also apply to the application.
 * They are in fact slightly pessimistic, because this test starts one
 * worker per band whereas the application keeps its workers ready.
 *
 * Usage: TEST_SCRIPT=tools/test-bands.ts node tools/run-test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { detectStars } from '../src/core/stars/detection'
import { align, IDENTITY_TRANSFORMATION } from '../src/core/stack/alignment'
import {
  stack,
  stackBand,
  type FrameToStack,
  type StackingOptions,
  type BandParams
} from '../src/core/stack/stacking'
import { sharedFloat32, sharedImage, sharedMemoryAvailable } from '../src/shared/sharedMemory'
import { testFile } from './test-files.mjs'

const OPTIONS: StackingOptions = { method: 'rejection', rejectionThreshold: 3 }

/** Worker branch: computes its own band and reports the counts. */
if (!isMainThread && parentPort) {
  parentPort.postMessage(stackBand(workerData as BandParams))
}


const cron = async <T>(fn: () => Promise<T> | T): Promise<[number, T]> => {
  const t = performance.now()
  const r = await fn()
  return [performance.now() - t, r]
}

const ms = (x: number): string => (x / 1000).toFixed(2) + ' s'

/** Compares two images pixel by pixel. */
function differences(a: Float32Array, b: Float32Array): { max: number; different: number } {
  let max = 0
  let different = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > 0) {
      different++
      if (d > max) max = d
    }
  }
  return { max, different }
}

async function main(): Promise<void> {
  if (!sharedMemoryAvailable) {
    console.log('Shared memory not available: the test is meaningless.')
    return
  }

  const folder = process.argv[2] ?? testFile('synthetic-frames')
  const names = readdirSync(folder)
    .filter((f) => /\.fits?$/i.test(f))
    .sort()

  const base = names.map((name) => {
    const readResult = readFits(new Uint8Array(readFileSync(join(folder, name))), name)
    const image = sharedImage(debayer(readResult.image, readResult.metadata.bayer))
    return { name, image, stars: detectStars(image) }
  })

  const first = base[0]
  const w = first.image.width
  const h = first.image.height
  const channels = first.image.channels
  const baseFrame: FrameToStack[] = base.map((b, i) => ({
    image: b.image,
    transformation:
      i === 0 ? IDENTITY_TRANSFORMATION : align(first.stars, b.stars).transformation,
    weight: 1
  }))

  const workers = Math.max(1, Math.min(16, cpus().length - 2))
  const thisFile = fileURLToPath(import.meta.url)

  console.log(
    names.length + ' frames of ' + w + 'x' + h + ' x' + channels +
      ', ' + cpus().length + ' cores, ' + workers + ' workers\n'
  )

  const replica = (count: number): FrameToStack[] =>
    Array.from({ length: count }, (_, i) => baseFrame[i % baseFrame.length])

  /** Stacks by splitting the work among real workers, one per band. */
  const inParallel = async (
    frame: FrameToStack[],
    bands: number
  ): Promise<{ data: Float32Array; rejected: number }> => {
    const output = sharedFloat32(w * h * channels)
    const boundary = (i: number): number => Math.round((i * h) / bands)

    const results = await Promise.all(
      Array.from(
        { length: bands },
        (_, i) =>
          new Promise<{ contributions: number; rejectedValues: number }>((solve, reject) => {
            const worker = new Worker(thisFile, {
              workerData: {
                frame,
                options: OPTIONS,
                yStart: boundary(i),
                yEnd: boundary(i + 1),
                output
              }
            })
            worker.on('message', (m) => {
              void worker.terminate()
              solve(m)
            })
            worker.on('error', reject)
          })
      )
    )

    return { data: output, rejected: results.reduce((a, e) => a + e.rejectedValues, 0) }
  }

  console.log('--- CORRECTNESS (' + names.length + ' frames) ---')
  const [tWhole, whole] = await cron(() => stack(baseFrame, OPTIONS))
  const [tBands, bandsResult] = await cron(() => inParallel(baseFrame, workers))
  const d = differences(whole.image.data, bandsResult.data)
  console.log('whole computation: ' + ms(tWhole) + ', ' + whole.rejectedValues + ' rejected values')
  console.log('banded:            ' + ms(tBands) + ', ' + bandsResult.rejected + ' rejected values')
  console.log(
    'different pixels: ' + d.different + ' of ' + whole.image.data.length +
      ' (maximum difference ' + d.max.toExponential(1) + ')'
  )
  console.log(d.different === 0 ? 'RESULT: identical.\n' : 'RESULT: DIFFERENCES FOUND.\n')
  // Result for the aggregate runner (npm run test): exit code 1 if anything failed.
  if (d.different !== 0) process.exitCode = 1

  console.log('--- SPEEDUP ---')
  console.log('frames'.padStart(6) + 'one thread'.padStart(12) + 'banded'.padStart(12) + 'factor'.padStart(10))
  for (const count of [6, 24, 96]) {
    const frame = replica(count)
    const [t1] = await cron(() => stack(frame, OPTIONS))
    const [t2] = await cron(() => inParallel(frame, workers))
    console.log(
      String(count).padStart(6) + ms(t1).padStart(12) + ms(t2).padStart(12) +
        (t1 / t2).toFixed(1).padStart(9) + 'x'
    )
  }
}

if (isMainThread) void main()
