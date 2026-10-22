/// <reference lib="webworker" />

import './followLanguage'
import { prepareRawIfNeeded } from './libraw'
import type { BayerPattern, FrameStats, FrameMetadata } from '@shared/types'
import { isShared } from '@shared/sharedMemory'
import type { Star } from '@core/stars/detection'
import type { Thumbnail } from '@core/image/thumbnail'
import { rawMemory } from '@core/raw/rawReader'
import { analyzeContent } from '@core/stack/frameAnalysis'
import type { CompactImage } from '@core/stack/compactFrame'

/**
 * Analysis worker.
 *
 * Decoding a frame, reconstructing its color and detecting its stars takes
 * a few hundred milliseconds. Running this work in the UI thread would
 * freeze it; handing it to several workers in parallel instead uses all
 * the processor cores and keeps the window responsive. The actual work is
 * in core/stack/frameAnalysis.ts.
 */

export interface AnalysisRequest {
  id: string
  path: string
  /** File content, transferred without copying. */
  buffer: ArrayBuffer
  /** If false, star detection and quality measurement are skipped. */
  withStars: boolean
  /** File name, also used to recognize calibration frames. */
  fileName?: string
  /**
   * True if the frame may come back in compact form (see
   * core/stack/compactFrame.ts): only stacking asks for it, since it can
   * rebuild the frame. If absent, the full frame is returned.
   */
  compactValue?: boolean
}

export interface AnalysisResponse {
  id: string
  result: 'ok' | 'error'
  message?: string
  width?: number
  height?: number
  channels?: 1 | 3
  bitpix?: number
  /**
   * Planes of the reconstructed image, transferred without copying; absent
   * if the frame comes back compact.
   */
  data?: ArrayBufferLike
  /** The frame reduced to the integer codes of the file (see core/stack/compactFrame.ts). */
  compact?: CompactImage
  stars?: Star[]
  stats?: FrameStats
  metadata?: FrameMetadata
  header?: Record<string, string | number | boolean | null>
  quality?: number
  hfr?: number
  /**
   * Present if the file was raw data from a color sensor, reconstructed
   * here with this Bayer pattern. Bayer drizzle needs it to know which
   * color each pixel measured.
   */
  bayerPattern?: BayerPattern
  /**
   * Thumbnail for the library, derived here from the already decoded pixels:
   * it costs a few milliseconds and saves a second read of the file.
   */
  thumbnail?: Thumbnail
  /**
   * Memory that LibRaw holds in this worker (zero if it has never read a
   * RAW file): the pool uses it to decide which workers to replace when it
   * is idle.
   */
  rawMemory?: number
}

self.onmessage = async (event: MessageEvent<AnalysisRequest>): Promise<void> => {
  const request = event.data

  try {
    // Camera RAW files require loading LibRaw the first time.
    await prepareRawIfNeeded(request.fileName ?? '', request.buffer)
    // The file content is handed to the analysis, which releases it as soon as it is read.
    const source = { buffer: request.buffer as ArrayBuffer | null }
    ;(request as { buffer: ArrayBuffer | null }).buffer = null
    const a = analyzeContent(source, request.fileName ?? '', request.withStars, request.compactValue === true)

    const response: AnalysisResponse = {
      id: request.id,
      result: 'ok',
      thumbnail: a.thumbnail,
      width: a.width,
      height: a.height,
      channels: a.channels,
      bitpix: a.bitpix,
      data: a.image ? (a.image.data.buffer as ArrayBuffer) : undefined,
      compact: a.compact ?? undefined,
      stars: a.stars,
      stats: a.stats,
      metadata: a.metadata,
      header: a.header,
      quality: a.quality,
      hfr: a.hfr,
      rawMemory: rawMemory(),
      bayerPattern: a.bayerPattern
    }

    // With shared memory there is nothing to transfer: the caller already
    // sees the same pixels. Otherwise the buffer is transferred instead of
    // duplicated: with tens of megabytes the difference matters.
    const transfer: ArrayBuffer[] = []
    if (a.image && !isShared(a.image.data)) transfer.push(a.image.data.buffer as ArrayBuffer)
    if (a.compact && !isShared(a.compact.codes)) transfer.push(a.compact.codes.buffer as ArrayBuffer)
    self.postMessage(response, transfer)
  } catch (error) {
    const response: AnalysisResponse = {
      id: request.id,
      result: 'error',
      message: error instanceof Error ? error.message : String(error),
      rawMemory: rawMemory()
    }
    self.postMessage(response)
  }
}
