/**
 * Estimate of the memory a stacking run will need, made before it starts.
 *
 * With large sensors the limit of stacking is memory, not time: every
 * analyzed frame stays in memory until the sum, and every analysis worker
 * holds one more while decoding it. A frame read from a file of 16 bits or
 * less stays compact (2 bytes per pixel for the sensor mosaic or mono, 6 for
 * three planes: see core/stack/compactFrame.ts); the others stay full, at
 * 32 bits per channel. Without an estimate, an oversized stack would notice
 * the problem halfway through, after minutes of work, or would slow down the
 * whole computer. The computation is done up front here: if memory is not
 * enough with all workers, fewer are used; if it is not enough even with
 * one, the run stops immediately and reports how many frames fit.
 *
 * No system access: the caller passes the measurements (free memory,
 * frames, workers), so the rule can be tested on its own
 * (tools/test-memory.ts).
 *
 * The coefficients are in bytes per sensor pixel and come from the
 * measurements of tools/measure-sensors.ts on frames from 2 to 61 megapixels.
 */

import { tileSide } from './stack/stacking'
import { MASTER_CHUNK_MARGIN } from './stack/compactFrame'
import { formatDecimal, formatNumber, t } from '@shared/i18n/i18n'

const GB = 1073741824

/**
 * Working memory of an analysis worker, beyond the file read, the frame
 * held and the full frame it measures on: luminance, star pixel masks,
 * statistics, and the leftovers of the previous frame the worker has not
 * yet released. Measured with tools/measure-sensors.ts (parallel analysis of
 * 16-bit raw frames of 26 and 61 megapixels, 8-12 workers): beyond the held
 * frames, 14-17 bytes per pixel per worker, including file and full frame;
 * the estimate with these 6 counts 22.
 */
export const ANALYSIS_WORK_PER_PIXEL = 6

/**
 * Fixed memory of each analysis worker (JavaScript engine, code, tables):
 * with small frames it weighs more than the pixels. Measured with 96 frames
 * of 2 megapixels and 12 workers: about 35-60 MB each.
 */
export const WORKER_BASE = 64 * 1048576

/** Extra for camera RAW files: LibRaw's memory and its 16-bit image. */
export const RAW_WORK_PER_PIXEL = 12

/**
 * Fixed margin for the rest of the application during stacking: window,
 * viewer, thumbnails, stars and alignments.
 */
export const APPLICATION_MARGIN = 0.5 * GB

/** Share of free memory always left to the system and other programs. */
export const RESERVE_SHARE = 0.15

/** Minimum reserve, even with plenty of free memory. */
export const MIN_RESERVE = 1 * GB

/**
 * Memory of the frame pieces rebuilt by each sum worker when frames are
 * compact (`TILE_MEMORY` in core/stack/stacking.ts, with a margin for the
 * tile borders).
 */
export const TILES_PER_WORKER = 6 * 1048576

/**
 * Transient memory, per pixel, when a library dark is loaded for the first
 * time: to find its defective pixels one full plane at a time is rebuilt
 * (4 bytes), with the deviations from the neighbors (4) and the defect map
 * (1), which then stays.
 */
export const MASTER_DEFECTS_PER_PIXEL = 9

/**
 * Compact master pieces rebuilt by each sum worker for the current tile
 * (dark or bias, and flat), with the margin that lets them be reused across
 * frames (`masterAccess` in core/stack/compactFrame.ts).
 */
export function masterPiecesBytes(frame: number, channels: number): number {
  const side = tileSide(frame, channels) + 4 + 2 * MASTER_CHUNK_MARGIN
  return 2 * side * side * channels * 4
}

/** A frame to stack, as described by the library (without decoding it). */
export interface FrameToEstimate {
  width: number
  height: number
  /** Channels after color reconstruction: 3 for color sensors. */
  channels: 1 | 3
  /** Size of the file on disk. */
  fileBytes: number
  /** True for camera RAW files, decoded by LibRaw. */
  raw: boolean
  /**
   * Code planes if the frame stays compact until the sum: 1 for the sensor
   * mosaic and mono, 3 for files that are already in color (see
   * `compactPlanes`). Absent: the frame stays full.
   */
  compactValue?: 1 | 3
}

/**
 * Code planes with which a frame will stay compact, from the library data;
 * undefined if it will stay full. Compact frames are 8- or 16-bit integer
 * files without unusual scaling (BSCALE 1, integer BZERO) and RAW files with
 * a Bayer mosaic; color RAW files that are already demosaiced (X-Trans)
 * stay full.
 */
export function compactPlanes(f: {
  bitpix: number
  fileChannels: 1 | 3
  bayer: string
  raw: boolean
  bscale?: unknown
  bzero?: unknown
}): 1 | 3 | undefined {
  if (f.bitpix !== 8 && f.bitpix !== 16) return undefined
  if (f.bscale !== undefined && f.bscale !== null && f.bscale !== 1) return undefined
  if (f.bzero !== undefined && f.bzero !== null && !Number.isInteger(f.bzero)) return undefined
  if (f.raw) return f.bayer !== 'NONE' ? 1 : undefined
  return f.bayer !== 'NONE' ? 1 : f.fileChannels
}

export interface EstimateRequest {
  frame: FrameToEstimate[]
  /** Analysis workers that would be used with plenty of memory. */
  workers: number
  /** Sum workers; 16 are assumed when absent. */
  workersSum?: number
  /**
   * True if the sum rebuilds compact frames in full (comet stacking works on
   * full frames): then they also weigh as full frames.
   */
  expanded?: boolean
  /**
   * Calibration library masters that could be loaded during analysis: with
   * several groups of lights (different exposures, temperatures, filters)
   * possibly more than one per type. They stay compact, with the codes
   * stored in the library.
   */
  mastersToLoad: number
  /**
   * Frame-sized images held together by the sum: normally 1; 3 with comet
   * and fixed stars (sum on the comet, comet layer, final sum); with HDR
   * merging one per series plus two.
   */
  sums: number
  /** Memory free right now, in bytes. */
  freeMemory: number
  /**
   * Memory the application can release on its own before starting (the
   * recently opened frames, kept to reopen them quickly).
   */
  recoverableMemory: number
}

export interface EstimateResult {
  /** Analysis workers to use; 0 if the stack does not fit. */
  workers: number
  /** Estimated memory at the moment of peak usage, with those workers. */
  neededItems: number
  /** Memory the stacking run can rely on, net of the reserve. */
  usable: number
  /** Frames that would fit with a single worker. */
  maxFrames: number
  /** True if the recently opened frames must be released to fit. */
  freeCache: boolean
  /** Explanation to show: why the run stopped, or why it uses fewer workers. */
  notice?: string
}

/** Bytes of the full frame, demosaiced and at 32 bits per channel: like the result. */
export function imageBytes(f: FrameToEstimate): number {
  return f.width * f.height * f.channels * 4
}

/**
 * Bytes of a library master for frames like this one: 16-bit codes, one
 * plane for the sensor mosaic and mono, three for files already in color
 * (core/stack/compactFrame.ts, `compactMaster`). For frames that do not stay
 * compact the channel planes are counted, the heaviest case.
 */
export function masterBytes(f: FrameToEstimate): number {
  return f.width * f.height * (f.compactValue ?? f.channels) * 2
}

/** Bytes of an analyzed frame, held in memory until the sum. */
export function frameBytes(f: FrameToEstimate): number {
  return f.compactValue ? f.width * f.height * f.compactValue * 2 : imageBytes(f)
}

/**
 * Memory of an analysis worker while it works on this frame: the fixed
 * part, the file, the held frame, the full frame it measures on (released at
 * the end of the analysis for a compact frame) and the working memory.
 */
export function analysisJobBytes(f: FrameToEstimate): number {
  const pixel = f.width * f.height
  const whole = f.compactValue ? imageBytes(f) : 0
  return (
    WORKER_BASE +
    f.fileBytes +
    frameBytes(f) +
    whole +
    pixel * (ANALYSIS_WORK_PER_PIXEL + (f.raw ? RAW_WORK_PER_PIXEL : 0))
  )
}

/** Memory that can be relied on, net of the reserve for the system. */
export function usableMemory(free: number, recoverable: number): number {
  const total = Math.max(0, free) + Math.max(0, recoverable)
  return Math.max(0, total - Math.max(MIN_RESERVE, total * RESERVE_SHARE))
}

/** Readable size with one decimal and the current language's separator: "22.5 GB", "512 MB". */
export function formatGigabytes(byte: number): string {
  const g = byte / GB
  if (g < 1) return formatNumber(Math.max(1, Math.round(byte / 1048576))) + ' MB'
  return formatDecimal(Math.round(g * 10) / 10, 1) + ' GB'
}

/** Readable megapixels: "61 megapixels", "2.1 megapixels". */
function megapixel(f: FrameToEstimate): string {
  const mp = (f.width * f.height) / 1e6
  return t('coreMemoryEstimate.megapixels', { value: mp >= 10 ? formatNumber(Math.round(mp)) : formatDecimal(mp, 1) })
}

/**
 * Decides how many workers to use, or whether to stop.
 *
 * The moment of peak usage is either the analysis (all frames already
 * analyzed plus those being processed) or the sum (all frames plus the
 * result, or the results with comet and HDR; with compact frames also one
 * full frame rebuilt for the measurements and the pieces rebuilt by the sum
 * workers). Frames read from disk wait in a short queue, one per worker, so
 * files weigh no more than those being processed. Drizzle has its own check,
 * made once the frames are analyzed: if it does not fit, the stack is made
 * without it and the user is told.
 */
export function estimateStacking(r: EstimateRequest): EstimateResult {
  const usable = usableMemory(r.freeMemory, r.recoverableMemory)
  const withoutCache = usableMemory(r.freeMemory, 0)
  if (r.frame.length === 0) {
    return { workers: Math.max(1, r.workers), neededItems: 0, usable, maxFrames: 0, freeCache: false }
  }

  // The largest frame determines the per-worker load and the sums.
  const large = r.frame.reduce((a, f) => (analysisJobBytes(f) > analysisJobBytes(a) ? f : a))
  const largeFrame = imageBytes(large)
  const job = analysisJobBytes(large)
  // With the comet all compact frames are rebuilt: they also weigh as full frames.
  const keptWeight = (f: FrameToEstimate): number => frameBytes(f) + (r.expanded && f.compactValue ? imageBytes(f) : 0)
  const kept = r.frame.reduce((s, f) => s + keptWeight(f), 0)
  const master = Math.max(0, r.mastersToLoad) * masterBytes(large)
  // The first library dark goes through a full plane (defective pixels)
  // while the workers analyze the first frames.
  const defects = r.mastersToLoad > 0 ? large.width * large.height * MASTER_DEFECTS_PER_PIXEL : 0
  const compactItems = r.frame.some((f) => f.compactValue)
  const sum =
    largeFrame * Math.max(1, r.sums) +
    (compactItems ? largeFrame + Math.max(1, r.workersSum ?? 16) * TILES_PER_WORKER : 0) +
    (compactItems && r.mastersToLoad > 0 ? Math.max(1, r.workersSum ?? 16) * masterPiecesBytes(r.frame.length, large.channels) : 0)
  const fixed = kept + master + APPLICATION_MARGIN
  const neededWith = (l: number): number =>
    Math.max(fixed + Math.max(l * job, sum), master + APPLICATION_MARGIN + l * job + defects)

  const wantedItems = Math.max(1, Math.floor(r.workers))
  // Frames that fit with a single worker, measured on the heaviest one.
  const frameSpace = usable - master - APPLICATION_MARGIN - Math.max(job, sum)
  const maxWeight = r.frame.reduce((m, f) => Math.max(m, keptWeight(f)), 0)
  const maxFrames = Math.max(0, Math.floor(frameSpace / maxWeight))

  for (let l = wantedItems; l >= 1; l--) {
    const neededItems = neededWith(l)
    if (neededItems > usable) continue
    const freeCache = neededItems > withoutCache
    if (l === wantedItems) return { workers: l, neededItems, usable, maxFrames, freeCache }
    return {
      workers: l,
      neededItems,
      usable,
      maxFrames,
      freeCache,
      notice: t(l === 1 ? 'coreMemoryEstimate.fewerWorkersOne' : 'coreMemoryEstimate.fewerWorkersOther', {
        count: l,
        wanted: wantedItems,
        megapixels: megapixel(large)
      })
    }
  }

  // It does not fit even with one worker: stop before starting.
  const neededItems = neededWith(1)
  const n = r.frame.length
  const intro = t('coreMemoryEstimate.insufficient', {
    count: n,
    megapixels: megapixel(large),
    needed: formatGigabytes(neededItems),
    available: formatGigabytes(usable)
  })
  const recommendation =
    maxFrames >= 2
      ? t('coreMemoryEstimate.maxFrames', { count: maxFrames })
      : t('coreMemoryEstimate.notEvenTwo')
  const calibration =
    r.mastersToLoad > 0 && maxFrames >= 2
      ? ' ' + t('coreMemoryEstimate.calibrationMasters', { size: formatGigabytes(master) })
      : ''
  return {
    workers: 0,
    neededItems,
    usable,
    maxFrames,
    freeCache: true,
    notice: intro + ' ' + recommendation + calibration
  }
}
