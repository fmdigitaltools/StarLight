import type { ImageData32 } from '@shared/types'
import { formatDecimal } from '@shared/i18n/i18n'

/**
 * Working memory management.
 *
 * Decoding a FITS frame costs a disk read, debayering and conversion to
 * floating point: about two hundred milliseconds per frame. Reading it again
 * every time it is viewed would be wasteful, while a computer with plenty of
 * memory can keep several hundred frames in RAM.
 *
 * The cache keeps decoded frames until the budget is used up, then evicts
 * the least recently used ones.
 */

/** Bytes occupied by a decoded image. */
export function imageWeight(img: ImageData32): number {
  return img.data.byteLength
}

interface Entry {
  key: string
  image: ImageData32
  /** Time of the last access, for the eviction policy. */
  lastUse: number
}

export class ImageCache {
  private entries = new Map<string, Entry>()
  private counter = 0
  private usedBytes = 0

  /**
   * @param budgetBytes Maximum memory granted to the cache. It is derived
   * from the installed memory, leaving a wide margin for the system.
   */
  constructor(private budgetBytes: number) {}

  /** Current budget in bytes. */
  get budget(): number {
    return this.budgetBytes
  }

  /** Memory currently occupied by the cached frames. */
  get usage(): number {
    return this.usedBytes
  }

  /** Number of cached frames. */
  get count(): number {
    return this.entries.size
  }

  /** Updates the budget, evicting frames if needed. */
  setBudget(byte: number): void {
    this.budgetBytes = byte
    this.free()
  }

  ha(key: string): boolean {
    return this.entries.has(key)
  }

  /** Retrieves a frame, marking it as recently used. */
  read(key: string): ImageData32 | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    entry.lastUse = ++this.counter
    return entry.image
  }

  /** Stores a decoded frame. */
  write(key: string, image: ImageData32): void {
    const weight = imageWeight(image)

    // A frame larger than the whole budget is not cached.
    if (weight > this.budgetBytes) return

    const existing = this.entries.get(key)
    if (existing) this.usedBytes -= imageWeight(existing.image)

    this.entries.set(key, { key, image, lastUse: ++this.counter })
    this.usedBytes += weight
    this.free()
  }

  /** Removes a specific frame. */
  remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.usedBytes -= imageWeight(entry.image)
    this.entries.delete(key)
  }

  /** Removes every frame whose key is not among the given ones. */
  keepOnly(keys: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!keys.has(key)) this.remove(key)
  }

  /** Empties the cache completely. */
  clear(): void {
    this.entries.clear()
    this.usedBytes = 0
  }

  /** Evicts the least recently used frames until usage is back within the budget. */
  private free(): void {
    if (this.usedBytes <= this.budgetBytes) return
    const sortedList = [...this.entries.values()].sort((a, b) => a.lastUse - b.lastUse)
    for (const entry of sortedList) {
      if (this.usedBytes <= this.budgetBytes) break
      this.usedBytes -= imageWeight(entry.image)
      this.entries.delete(entry.key)
    }
  }
}

/**
 * Computes how much memory to assign to the cache from the installed amount.
 * At least 4 GB, and in any case a quarter of the total, are reserved for
 * the system.
 */
export function recommendedBudget(totalRamBytes: number): number {
  const GB = 1073741824
  const reserve = Math.max(4 * GB, totalRamBytes * 0.25)
  const available = totalRamBytes - reserve
  // The upper limit avoids needlessly inflating the process.
  return Math.max(512 * 1024 * 1024, Math.min(available * 0.6, 24 * GB))
}

/**
 * Memory that the processing chain may give at the same time to work spread
 * over several workers, beyond the image itself: the stripes of
 * deconvolution (see deconvolveParallel.ts), whose overlap margins make all
 * of them together several times larger than the image. Running fewer at
 * once does not change the result, only the time.
 *
 * One and a half times the image, and at least 512 MB, so that ordinary
 * images keep all their stripes running together; never more than a quarter
 * of the memory free at the start (`freeRamBytes`, if known), so that a
 * computer with little memory does not start swapping.
 */
export function parallelWorkBudget(imageBytes: number, freeRamBytes?: number): number {
  const MB = 1048576
  const budget = Math.max(512 * MB, imageBytes * 1.5)
  if (freeRamBytes === undefined || !Number.isFinite(freeRamBytes) || freeRamBytes <= 0) return budget
  return Math.min(budget, freeRamBytes * 0.25)
}

/** Formats a number of bytes in readable form. */
export function formatBytes(byte: number): string {
  if (byte < 1024) return byte + ' B'
  if (byte < 1048576) return formatDecimal(byte / 1024, 0) + ' kB'
  if (byte < 1073741824) return formatDecimal(byte / 1048576, 1) + ' MB'
  return formatDecimal(byte / 1073741824, 2) + ' GB'
}
