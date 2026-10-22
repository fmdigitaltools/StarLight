/// <reference lib="webworker" />

import './followLanguage'
import { align, type AlignmentResult } from '@core/stack/alignment'
import type { Star } from '@core/stars/detection'

/**
 * Alignment worker.
 *
 * Each frame is aligned to the reference on its own, without looking at
 * the others: the work can therefore be split across threads without
 * changing the result. The computation is the engine's `align`; only the
 * stars it actually uses arrive here, a few dozen per frame.
 */

export interface AlignmentRequest {
  id: number
  reference: Star[]
  stars: Star[]
}

export interface AlignmentResponse {
  id: number
  status: 'ok' | 'error'
  message?: string
  result?: AlignmentResult
}

self.onmessage = (event: MessageEvent<AlignmentRequest>): void => {
  const request = event.data

  try {
    const response: AlignmentResponse = {
      id: request.id,
      status: 'ok',
      result: align(request.reference, request.stars)
    }
    self.postMessage(response)
  } catch (error) {
    const response: AlignmentResponse = {
      id: request.id,
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
