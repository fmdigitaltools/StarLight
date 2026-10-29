import type { ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import {
  DECONVOLUTION_MARGIN,
  measureDeconvolution,
  deconvolutionLuminance,
  saturatedPixels,
  carryOver,
  type DeconvolutionParams
} from '@core/image/deconvolution'
import type { DeconvolutionRequest, DeconvolutionResponse } from './deconvolution.worker'

/**
 * Deconvolution distributed across several workers.
 *
 * On a single core ten iterations take several seconds. The measurements
 * (background, noise, blur shape) are taken once on the whole image; then
 * the image is cut into horizontal stripes, each with a margin wide enough
 * to contain everything the iterations propagate, and only the central
 * part of each stripe is kept.
 *
 * Memory. Each worker receives only the brightness of its stripe and the
 * map of its saturated pixels, and returns the deconvolved brightness with
 * its weight; the image stays here and the result is carried over to it in
 * place, stripe by stripe (see `carryOver` in core/image/deconvolution.ts).
 * The brightness and the saturated pixels of the whole image are taken
 * before any stripe is carried over, so later stripes, whose margins cover
 * rows already written, still read the data from before. On large images
 * all the stripes at once would take several times the image, margins
 * included: no more run at the same time than `budget` allows (at least
 * one). Which stripes there are does not depend on it, so neither does the
 * result.
 */
export async function deconvolveParallel(
  image: ImageData32,
  p: DeconvolutionParams,
  progress?: (fraction: number) => void,
  /** Bytes the stripes may take at the same time (see `parallelWorkBudget` in core/memory.ts). */
  budget = Infinity,
  /** A plane of the image size to hold the brightness, if the caller has one to reuse. */
  scratch?: Float32Array
): Promise<ImageData32> {
  const w = image.width
  const h = image.height
  const n = w * h
  const c = image.channels
  const measurements = measureDeconvolution(image, p.psfRadius)
  const margin = DECONVOLUTION_MARGIN(p, measurements.sigma)

  const workers = Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 2))
  // Stripes that are not too thin: the margin is recomputed for each one.
  const stripes = Math.max(1, Math.min(workers, Math.floor(h / Math.max(64, margin))))
  const usableHeight = Math.ceil(h / stripes)
  const tasks: { start: number; end: number }[] = []
  for (let s = 0; s < stripes; s++) {
    const start = s * usableHeight
    const end = Math.min(h, start + usableHeight)
    if (start < end) tasks.push({ start, end })
  }

  // With a single channel the brightness is the image itself, which the
  // carry-over rewrites: a copy is kept for the stripes still to come.
  const y = scratch && scratch.length === n ? scratch : new Float32Array(n)
  if (c === 1) y.set(image.data.subarray(0, n))
  else deconvolutionLuminance(image, y)
  const saturated = saturatedPixels(image, measurements)
  const rowsOf = (task: { start: number; end: number }): [number, number] => [
    Math.max(0, task.start - margin),
    Math.min(h, task.end + margin)
  ]
  let largest = 0
  for (const task of tasks) {
    const [from, a] = rowsOf(task)
    largest = Math.max(largest, (a - from) * w)
  }
  const concurrent = Math.max(1, Math.min(tasks.length, Math.floor(budget / (largest * STRIP_BYTES_PER_PIXEL))))

  let completedItems = 0
  // After the first failure the other stripes are stopped and report
  // nothing more: a late progress report would reopen the job that the
  // caller has just closed, and the bar would stay stuck.
  let failed = false
  const running = new Set<Worker>()
  const fail = (worker: Worker, reject: (e: Error) => void, error: Error): void => {
    worker.terminate()
    running.delete(worker)
    if (failed) return
    failed = true
    for (const other of running) other.terminate()
    running.clear()
    reject(error)
  }
  const run = (task: { start: number; end: number }, index: number): Promise<void> =>
    new Promise((solve, reject) => {
      if (failed) {
        solve()
        return
      }
      const [from, a] = rowsOf(task)
      const worker = new Worker(new URL('./deconvolution.worker.ts', import.meta.url), {
        type: 'module',
        name: 'deconvolution-' + (index + 1)
      })
      running.add(worker)
      worker.onmessage = (e: MessageEvent<DeconvolutionResponse>): void => {
        if (e.data.result === 'error') {
          fail(worker, reject, new Error(e.data.message))
          return
        }
        worker.terminate()
        running.delete(worker)
        if (failed) {
          solve()
          return
        }
        const { u, weight } = e.data
        if (u && weight) {
          const offset = (task.start - from) * w
          carryOver(
            image.data,
            image.data,
            y.subarray(task.start * w),
            u.subarray(offset),
            weight.subarray(offset),
            measurements,
            c,
            task.start,
            task.end,
            w
          )
        }
        completedItems++
        progress?.(completedItems / tasks.length)
        solve()
      }
      worker.onerror = (e): void => {
        // A worker that cannot even start gives an empty message.
        fail(worker, reject, new Error(e.message || t('workersDeconvolveParallel.workerFailed')))
      }
      const request: DeconvolutionRequest = {
        y: y.slice(from * w, a * w),
        saturated: saturated.slice(from * w, a * w),
        width: w,
        height: a - from,
        parameters: p,
        measurements
      }
      worker.postMessage(request, [request.y.buffer, request.saturated.buffer])
    })

  // The stripes are started in order, `concurrent` at a time.
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++
      await run(tasks[index], index)
    }
  }
  await Promise.all(Array.from({ length: concurrent }, lane))
  return image
}

/**
 * Memory of a stripe in its worker, per pixel: brightness, saturated pixels
 * and the planes of the deconvolution (see `deconvolveBrightness`), with
 * the most taken while the weight is computed.
 */
const STRIP_BYTES_PER_PIXEL = 28
