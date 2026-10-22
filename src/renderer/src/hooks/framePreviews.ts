import type { ImageData32 } from '@shared/types'
import { computeThumbnail, type Thumbnail } from '@core/image/thumbnail'
import { useApp } from '../store/appStore'
import type { PreviewRequest, PreviewResponse } from '../workers/preview.worker'
import { t } from '@shared/i18n/i18n'

/**
 * Thumbnails of the library frames.
 *
 * Thumbnails are generated only for visible rows, through a queue with at
 * most three files open at once, and are kept in memory by path. They live
 * in this module rather than in the application state: each finished
 * thumbnail updates only its own row, not the whole panel. While the
 * application runs a heavy job (stacking, processing, opening) the queue
 * pauses so as not to take time from it.
 *
 * For camera RAW files the first thumbnail comes from the preview embedded
 * in the file by the camera (see preview.worker): it is temporary and is
 * replaced by the one computed from the sensor data as soon as the frame is
 * opened or analyzed. Workers are closed when the queue stays empty: that is
 * the only way to release the WebAssembly memory used by LibRaw.
 */

/** Outcome of a thumbnail: the pixels, or the reason the file cannot be read. */
export type PreviewState = Thumbnail | { error: string }

/** Files processed at once: enough to fill the list quickly, few enough to stay light. */
const CONCURRENCY = 3

/**
 * Thumbnails kept in memory. At 96 pixels per side each one takes 36 kB:
 * the cap limits them to about thirty megabytes even with huge libraries.
 */
const MAX_IN_MEMORY = 800

const previews = new Map<string, PreviewState>()
const listeners = new Map<string, Set<() => void>>()

interface PendingRequest {
  path: string
  fileName: string
}

/** Pending requests, in the order the rows appeared. */
let tail: PendingRequest[] = []
/** Paths being processed right now. */
const inProgress = new Set<string>()

/** Dedicated workers, created on the first request. */
let idleWorkers: Worker[] = []
let createdItems = 0
let requestCounter = 0

/** Idle time without requests after which the workers are closed. */
const REST_MS = 8000
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** Thumbnail already available for the path, if any. */
export function readPreview(path: string): PreviewState | undefined {
  return previews.get(path)
}

/** Thumbnails currently kept and the memory they use (for the Performance tab). */
export function previewUsage(): { number: number; byte: number } {
  let byte = 0
  for (const a of previews.values()) if ('rgba' in a) byte += a.rgba.byteLength
  return { number: previews.size, byte }
}

/** Notifies when the thumbnail for the path becomes available. */
export function subscribePreview(path: string, notice: () => void): () => void {
  let collection = listeners.get(path)
  if (!collection) {
    collection = new Set()
    listeners.set(path, collection)
  }
  collection.add(notice)
  return () => {
    collection.delete(notice)
    if (collection.size === 0) listeners.delete(path)
  }
}

function remember(path: string, state: PreviewState): void {
  previews.delete(path)
  previews.set(path, state)
  // The map keeps insertion order: the first entry is the oldest.
  while (previews.size > MAX_IN_MEMORY) {
    const oldValue = previews.keys().next().value as string
    previews.delete(oldValue)
  }
  listeners.get(path)?.forEach((notice) => notice())
}

/** Requests the thumbnail of a frame that has just appeared in the list. */
export function requestPreview(path: string, fileName: string): void {
  if (previews.has(path) || inProgress.has(path)) return
  if (tail.some((a) => a.path === path)) return
  tail.push({ path, fileName })
  pump()
}

/** Removes from the queue a frame that left the view before its turn. */
export function cancelPreview(path: string): void {
  tail = tail.filter((a) => a.path !== path)
}

/**
 * Builds the thumbnail from an already decoded image, without reading the
 * file again: used when a frame is opened in the viewer.
 */
export function previewFromImage(path: string, image: ImageData32, singleFrame: boolean): void {
  if (alreadyFinal(path)) return
  cancelPreview(path)
  remember(path, computeThumbnail(image, 'NONE', singleFrame))
}

/** Registers a thumbnail computed elsewhere (for example by the stacking analysis). */
export function registerPreview(path: string, thumbnail: Thumbnail): void {
  if (alreadyFinal(path)) return
  cancelPreview(path)
  remember(path, thumbnail)
}

/** True if the path already has a thumbnail that must not be replaced. */
function alreadyFinal(path: string): boolean {
  const a = previews.get(path)
  return a !== undefined && !('rgba' in a && a.temporary === true)
}

function takeWorker(): Worker | null {
  const idleWorker = idleWorkers.pop()
  if (idleWorker) return idleWorker
  if (createdItems >= CONCURRENCY) return null
  createdItems++
  return new Worker(new URL('../workers/preview.worker.ts', import.meta.url), {
    type: 'module',
    name: 'previews-' + createdItems
  })
}

/** Runs a request on a worker and returns the response. */
function askWorker(worker: Worker, request: PreviewRequest): Promise<PreviewResponse> {
  return new Promise((solve) => {
    worker.onmessage = (e: MessageEvent<PreviewResponse>) => solve(e.data)
    worker.onerror = (e) => {
      e.preventDefault()
      solve({ id: request.id, result: 'error', message: e.message })
    }
    worker.postMessage(request, [request.buffer])
  })
}

async function work(worker: Worker, pending: PendingRequest): Promise<void> {
  try {
    const buffer = await window.starlight.readFile(pending.path)
    const response = await askWorker(worker, {
      id: ++requestCounter,
      buffer,
      fileName: pending.fileName
    })
    if (response.result === 'ok' && response.rgba && response.side) {
      registerPreview(pending.path, {
        side: response.side,
        rgba: new Uint8ClampedArray(response.rgba),
        temporary: response.temporary
      })
    } else {
      remember(pending.path, { error: response.message ?? t('hooksFramePreviews.unreadableFile') })
    }
  } catch (e) {
    remember(pending.path, { error: e instanceof Error ? e.message : String(e) })
  } finally {
    inProgress.delete(pending.path)
    idleWorkers.push(worker)
    pump()
  }
}

/** Starts pending requests while there are idle workers and no heavy job. */
function pump(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (tail.length === 0 && inProgress.size === 0 && createdItems > 0) {
    idleTimer = setTimeout(closeWorkers, REST_MS)
  }
  if (useApp.getState().job.active) return
  while (tail.length > 0) {
    const worker = takeWorker()
    if (!worker) return
    const pending = tail.shift() as PendingRequest
    if (previews.has(pending.path)) {
      idleWorkers.push(worker)
      continue
    }
    inProgress.add(pending.path)
    void work(worker, pending)
  }
}

/** Closes idle workers: they will be created again on the next request. */
function closeWorkers(): void {
  idleTimer = null
  if (tail.length > 0 || inProgress.size > 0) return
  for (const l of idleWorkers) l.terminate()
  createdItems -= idleWorkers.length
  idleWorkers = []
}

// When a heavy job ends, the queue restarts on its own.
useApp.subscribe((state, before) => {
  if (before.job.active && !state.job.active) pump()
})
