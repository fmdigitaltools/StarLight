/// <reference lib="webworker" />

import './followLanguage'
import {
  stackBand,
  type FrameToStack,
  type RejectionMap,
  type StackingOptions
} from '@core/stack/stacking'
import { drizzleBand } from '@core/stack/drizzle'
import type { BayerPattern } from '@shared/types'

/**
 * Stacking worker.
 *
 * Receives all the frames and the indication of which rows of the result
 * are its responsibility. Frames and output image live in shared memory,
 * so not a single pixel is copied: the worker reads where the others read
 * and writes only to the rows assigned to it, where nobody else writes.
 * For this reason no locking between threads is needed.
 *
 * The same worker also computes the drizzle bands, which have the same
 * shape but write to a finer grid.
 */

/** Band of the normal sum. */
export interface SumRequest {
  type?: 'sum'
  id: number
  frame: FrameToStack[]
  options: StackingOptions
  yStart: number
  yEnd: number
  /** Shared output image: the band writes here. */
  output: Float32Array
  /** Rejection center and limit to write, for the drizzle that follows. */
  rejectionMap?: RejectionMap
}

/** Drizzle band, in rows of the fine grid. */
export interface DrizzleRequest {
  type: 'drizzle'
  id: number
  frame: FrameToStack[]
  factor: number
  pixfrac: number
  /** Bayer drizzle only: the pattern of the raw frames. */
  bayerPattern?: BayerPattern
  rejection?: RejectionMap
  reserve: Float32Array
  yStart: number
  yEnd: number
  output: Float32Array
  coverage: Float32Array
}

export type BandRequest = SumRequest | DrizzleRequest

export interface BandResponse {
  id: number
  result: 'ok' | 'error'
  message?: string
  /** In drizzle: sum of the collected weights. */
  contributions?: number
  rejectedValues?: number
  /** Drizzle only: fine pixels left without drops. */
  blanks?: number
}

self.onmessage = (event: MessageEvent<BandRequest>): void => {
  const request = event.data

  try {
    let response: BandResponse
    if (request.type === 'drizzle') {
      const result = drizzleBand(request)
      response = {
        id: request.id,
        result: 'ok',
        contributions: result.totalWeight,
        rejectedValues: result.rejectedValues,
        blanks: result.blanks
      }
    } else {
      const result = stackBand(request)
      response = {
        id: request.id,
        result: 'ok',
        contributions: result.contributions,
        rejectedValues: result.rejectedValues
      }
    }
    self.postMessage(response)
  } catch (error) {
    const response: BandResponse = {
      id: request.id,
      result: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
