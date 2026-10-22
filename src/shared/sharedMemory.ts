import type { ImageData32 } from './types'

/**
 * Memory shared between threads.
 *
 * A regular `ArrayBuffer` passed to a worker can only be copied or
 * transferred, and stacking needs neither: every band of rows must be able
 * to read all the frames at the same time. A `SharedArrayBuffer` is instead
 * visible to every thread without copies, so the 25 MB of a frame stay in a
 * single place even when sixteen workers read them at once.
 *
 * Its availability depends on it being enabled in the main process, so every
 * use goes through this module and callers always keep a fallback path.
 */

export const sharedMemoryAvailable = typeof SharedArrayBuffer !== 'undefined'

/** Allocates floating-point values visible to every thread. */
export function sharedFloat32(length: number): Float32Array {
  if (!sharedMemoryAvailable) return new Float32Array(length)
  return new Float32Array(new SharedArrayBuffer(length * 4))
}

/** Allocates 16-bit integers visible to every thread. */
export function sharedUint16(length: number): Uint16Array {
  if (!sharedMemoryAvailable) return new Uint16Array(length)
  return new Uint16Array(new SharedArrayBuffer(length * 2))
}

/** True if this data is already in shared memory. */
export function isShared(data: ArrayBufferView): boolean {
  return sharedMemoryAvailable && data.buffer instanceof SharedArrayBuffer
}

/**
 * Returns the image as it is if it is already shared, otherwise a shared
 * copy. The copy costs one pass over memory, far less than duplicating the
 * frame for every worker.
 */
export function sharedImage(image: ImageData32): ImageData32 {
  if (isShared(image.data)) return image
  const data = sharedFloat32(image.data.length)
  data.set(image.data)
  return { width: image.width, height: image.height, channels: image.channels, data }
}
