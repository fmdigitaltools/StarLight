import { t } from '@shared/i18n/i18n'
import { sharedFloat32, sharedMemoryAvailable } from '@shared/sharedMemory'
import { isCompact, sharedHold } from '@core/stack/compactFrame'
import {
  stack,
  type FrameToStack,
  type RejectionMap,
  type StackingOptions,
  type StackingResult
} from '@core/stack/stacking'
import type { BayerPattern } from '@shared/types'
import {
  withRejection,
  meanContribution,
  drizzle,
  isDrizzleActive,
  drizzleMemory,
  type DrizzleOptions,
  type DrizzleResult
} from '@core/stack/drizzle'
import { formatBytes } from '@core/memory'
import { stackingWorkerPool } from './pool'

/**
 * Stacking distributed across the workers.
 *
 * Summing the frames is the slowest phase of integration and the only one
 * that gets worse as the number of exposures grows: on a single thread,
 * ninety-six two-megapixel frames take eighteen seconds, with the UI
 * frozen the whole time. The result, however, can be split into
 * independent bands of rows, and the frames live in shared memory: each
 * worker takes its band and writes directly into the common result,
 * without a single pixel being copied.
 */

/**
 * Minimum rows per band. Below this size the worker startup time weighs
 * more than the computation assigned to it.
 */
const MIN_ROWS = 24

/**
 * Analyzed frames are already shared, including the calibration masters of
 * compact frames; the others are copied here, once.
 */
function makeShared(frame: FrameToStack[]): FrameToStack[] {
  return frame.map((f) => ({
    image: sharedHold(f.image),
    transformation: f.transformation,
    weight: f.weight,
    normalization: f.normalization
  }))
}

export async function stackInParallel(
  frame: FrameToStack[],
  options: StackingOptions,
  progress?: (fraction: number) => void,
  rejectionMap?: RejectionMap
): Promise<StackingResult> {
  if (frame.length === 0) throw new Error(t('workersStackInParallel.noFrames'))

  const first = frame[0].image
  const w = first.width
  const h = first.height
  const channels = first.channels

  // Without shared memory every worker would need a copy of all the
  // frames: the remedy would cost more than the problem, so the stack is
  // computed here, on a single thread.
  if (!sharedMemoryAvailable) return stack(frame, options, progress, rejectionMap)

  const workerPool = stackingWorkerPool()
  const bands = Math.max(1, Math.min(workerPool.size, Math.floor(h / MIN_ROWS)))
  if (bands === 1) return stack(frame, options, progress, rejectionMap)

  const sharedItems = makeShared(frame)

  const output = sharedFloat32(w * h * channels)
  const boundary = (i: number): number => Math.round((i * h) / bands)

  let completed = 0
  const responses = await Promise.all(
    Array.from({ length: bands }, (_, i) =>
      workerPool
        .band({
          id: i,
          frame: sharedItems,
          options,
          yStart: boundary(i),
          yEnd: boundary(i + 1),
          output,
          rejectionMap
        })
        .then((response) => {
          completed++
          if (progress) progress(completed / bands)
          return response
        })
    )
  )

  const failed = responses.find((r) => r.result === 'error')
  if (failed) throw new Error(failed.message ?? t('workersStackInParallel.stackingFailed'))

  let contributions = 0
  let rejectedValues = 0
  for (const response of responses) {
    contributions += response.contributions ?? 0
    rejectedValues += response.rejectedValues ?? 0
  }

  return {
    image: { width: w, height: h, channels: channels, data: output },
    meanContribution: contributions / (w * h * channels),
    rejectedValues
  }
}

/**
 * Checks that there is enough memory for drizzle. With a doubled grid the
 * result has four times the pixels, and temporary sums and the normal
 * reference stack are needed as well.
 *
 * @returns null if memory is sufficient, otherwise the explanation
 */
export async function insufficientDrizzleMemory(
  frame: FrameToStack[],
  options: StackingOptions,
  d: DrizzleOptions
): Promise<string | null> {
  // Even 1x Bayer drizzle needs the per-channel sums.
  if (frame.length === 0 || !isDrizzleActive(d)) return null
  const first = frame[0].image
  const neededItems = drizzleMemory(
    first.width,
    first.height,
    first.channels,
    d.factor,
    withRejection(options),
    frame.some((f) => isCompact(f.image))
  )
  let free: number
  try {
    const info = await window.starlight.systemInfo()
    free = Number(info.freeRam)
  } catch {
    return null
  }
  if (!Number.isFinite(free) || free <= 0) return null
  // A quarter of the free memory is left to the system and the rest of the app.
  if (neededItems <= free * 0.75) return null
  return t(d.bayer ? 'workersStackInParallel.insufficientMemoryBayer' : 'workersStackInParallel.insufficientMemory', {
    needed: formatBytes(neededItems),
    free: formatBytes(free)
  })
}

/**
 * Drizzle distributed across the workers.
 *
 * First a normal stack, which provides the reference value for outlier
 * rejection and fills any pixels without data; then the deposit of the
 * drops onto the fine grid, split into bands of rows like the normal sum.
 *
 * With `bayerPattern` it is a Bayer drizzle: each pixel of the frames
 * deposits only the color the sensor had measured (see `drizzle.ts`).
 */
export async function drizzleParallel(
  frame: FrameToStack[],
  options: StackingOptions,
  d: DrizzleOptions,
  progress?: (fraction: number) => void,
  bayerPattern?: BayerPattern
): Promise<DrizzleResult> {
  if (frame.length === 0) throw new Error(t('workersStackInParallel.noFrames'))

  const workerPool = stackingWorkerPool()
  if (!sharedMemoryAvailable || workerPool.size < 2) return drizzle(frame, options, d, bayerPattern)

  const first = frame[0].image
  const w = first.width
  const h = first.height
  const channels = first.channels
  const s = d.factor

  const sharedItems = makeShared(frame)

  // --- Normal reference stack ---
  const rejection: RejectionMap | undefined = withRejection(options)
    ? { center: sharedFloat32(w * h * channels), limit: sharedFloat32(w * h * channels) }
    : undefined
  const reference = await stackInParallel(
    sharedItems,
    options,
    (f) => progress?.(f * 0.35),
    rejection
  )

  // --- Deposit of the drops onto the fine grid ---
  const W = w * s
  const H = h * s
  const output = sharedFloat32(W * H * channels)
  const coverage = sharedFloat32(W * H)
  const bands = Math.max(1, Math.min(workerPool.size, Math.floor(H / MIN_ROWS)))
  const boundary = (i: number): number => Math.round((i * H) / bands)

  let completed = 0
  const responses = await Promise.all(
    Array.from({ length: bands }, (_, i) =>
      workerPool
        .band({
          type: 'drizzle',
          id: i,
          frame: sharedItems,
          factor: s,
          pixfrac: d.pixfrac,
          bayerPattern,
          rejection,
          reserve: reference.image.data,
          yStart: boundary(i),
          yEnd: boundary(i + 1),
          output,
          coverage
        })
        .then((response) => {
          completed++
          progress?.(0.35 + (completed / bands) * 0.65)
          return response
        })
    )
  )

  const failed = responses.find((r) => r.result === 'error')
  if (failed) throw new Error(failed.message ?? t('workersStackInParallel.drizzleFailed'))

  let totalWeight = 0
  let rejectedValues = 0
  let blanks = 0
  for (const r of responses) {
    totalWeight += r.contributions ?? 0
    rejectedValues += r.rejectedValues ?? 0
    blanks += r.blanks ?? 0
  }

  return {
    image: { width: W, height: H, channels: channels, data: output },
    coverage,
    meanContribution: meanContribution(totalWeight, W * H, channels, frame, d, bayerPattern),
    rejectedValues,
    emptyFraction: blanks / (W * H)
  }
}
