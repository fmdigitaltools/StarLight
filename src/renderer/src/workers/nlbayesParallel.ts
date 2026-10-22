import type { ImageData32 } from '@shared/types'
import { computeStats, MAD_TO_SIGMA } from '@core/image/stats'
import { STRIP_MARGIN } from '@core/image/nlbayes'
import { applyBrightnessReduction } from '@core/image/chain'
import type { NlBayesRequest, NlBayesResponse } from './nlbayes.worker'

/**
 * NL-Bayes noise reduction distributed across several workers.
 *
 * The luminance is cleaned and the resulting correction is applied to the
 * three channels in the same way, so the color stays the one already
 * smoothed by the cleaning. The image is cut into horizontal stripes with
 * an overlap margin; only the central part of each stripe is kept, where
 * the search for similar patches did not see the cut.
 *
 * With narrowband, the H-alpha and OIII planes are instead cleaned one at
 * a time (see `reducePlaneNlBayes`): they have different noise, and the
 * luminance, mostly H-alpha, would say nothing about the grain of the OIII.
 */

/**
 * The noise of stacked images comes in clumps a few pixels wide, not
 * independent from pixel to pixel as the method assumes: measured pixel by
 * pixel it comes out lower than what is visible. This factor compensates
 * for it; it was calibrated on real stacks of M 33 and M 27.
 */
const NOISE_FACTOR = 2.2

/** Useful rows of each stripe, besides the overlap margins. */
const STRIP_HEIGHT = 128

export async function reduceNoiseNlBayes(
  image: ImageData32,
  progress?: (fraction: number) => void
): Promise<ImageData32> {
  const data = image.data.slice()
  await reduceNoiseNlBayesInPlace({ ...image, data }, 1, progress)
  return { width: image.width, height: image.height, channels: image.channels, data }
}

/**
 * Like `reduceNoiseNlBayes` followed by `applyReductionAmount` with the
 * given strength, with the same values, but written into the pixels of
 * `image`: each strip is carried over to the channels as soon as it comes
 * back (see `applyBrightnessReduction`), without a copy of the image or a
 * full cleaned plane. The processing chain uses it on the image that
 * belongs to it alone.
 */
export async function reduceNoiseNlBayesInPlace(
  image: ImageData32,
  strength: number,
  progress?: (fraction: number) => void,
  /** A plane of the image size to hold the brightness, if the caller has one to reuse. */
  scratch?: Float32Array
): Promise<void> {
  const w = image.width
  const h = image.height
  const n = w * h
  const c = image.channels
  const y = scratch && scratch.length === n ? scratch.fill(0) : new Float32Array(n)
  for (let k = 0; k < c; k++) {
    const plane = image.data.subarray(k * n, (k + 1) * n)
    for (let i = 0; i < n; i++) y[i] += plane[i] / c
  }
  // The strips read only `y`, which does not change: the image can be
  // written as they come back.
  await cleanInStrips(y, w, h, sigmaNlBayes(y), progress, (rows, start, end) =>
    applyBrightnessReduction(image.data, y, rows, strength, c, start, end, w)
  )
}

/** Noise to give NL-Bayes for a plane: robust dispersion, corrected for clumping. */
export function sigmaNlBayes(plane: Float32Array): number {
  return computeStats(plane).mad * MAD_TO_SIGMA * NOISE_FACTOR
}

/**
 * Cleans any plane (the luminance, or a band) with NL-Bayes in stripes
 * across several workers and returns the cleaned plane. The input plane
 * is not modified.
 */
export async function reducePlaneNlBayes(
  y: Float32Array,
  w: number,
  h: number,
  sigma: number,
  progress?: (fraction: number) => void
): Promise<Float32Array> {
  const cleaned = new Float32Array(w * h)
  await cleanInStrips(y, w, h, sigma, progress, (rows, start) => cleaned.set(rows, start * w))
  return cleaned
}

/**
 * The work of `reducePlaneNlBayes`: each cleaned strip, without its margins
 * (the rows from `start` to `end`), is handed to `deliver` as soon as it
 * comes back.
 */
async function cleanInStrips(
  y: Float32Array,
  w: number,
  h: number,
  sigma: number,
  progress: ((fraction: number) => void) | undefined,
  deliver: (rows: Float32Array, start: number, end: number) => void
): Promise<void> {
  const workers = Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 2))
  // Stripes of fixed height, independent of the number of cores: the cut
  // slightly affects the result, and the same image must give the same
  // processing on any computer. There are more of them than workers, so
  // whoever finishes first takes another.
  const stripes = Math.max(1, Math.ceil(h / STRIP_HEIGHT))
  const usableHeight = Math.ceil(h / stripes)
  const tasks: { start: number; end: number }[] = []
  for (let s = 0; s < stripes; s++) {
    const start = s * usableHeight
    const end = Math.min(h, start + usableHeight)
    if (start < end) tasks.push({ start, end })
  }

  let completedItems = 0
  let next = 0

  const run = (worker: Worker): Promise<void> =>
    new Promise((solve, reject) => {
      const start = (): void => {
        if (next >= tasks.length) {
          solve()
          return
        }
        const task = tasks[next++]
        const from = Math.max(0, task.start - STRIP_MARGIN)
        const a = Math.min(h, task.end + STRIP_MARGIN)
        const request: NlBayesRequest = {
          stripe: y.slice(from * w, a * w),
          width: w,
          height: a - from,
          sigma
        }
        worker.onmessage = (e: MessageEvent<NlBayesResponse>): void => {
          if (e.data.result === 'error') {
            reject(new Error(e.data.message))
            return
          }
          const offset = (task.start - from) * w
          deliver(e.data.stripe.subarray(offset, offset + (task.end - task.start) * w), task.start, task.end)
          completedItems++
          progress?.(completedItems / tasks.length)
          start()
        }
        worker.onerror = (e): void => reject(new Error(e.message))
        worker.postMessage(request, [request.stripe.buffer])
      }
      start()
    })

  const workerPool = Array.from(
    { length: Math.min(workers, tasks.length) },
    (_, i) =>
      new Worker(new URL('./nlbayes.worker.ts', import.meta.url), {
        type: 'module',
        name: 'nlbayes-' + (i + 1)
      })
  )
  try {
    await Promise.all(workerPool.map(run))
  } finally {
    for (const l of workerPool) l.terminate()
  }
}
