/// <reference lib="webworker" />

import './followLanguage'
import {
  deconvolveBrightness,
  type DeconvolutionMeasurements,
  type DeconvolutionParams
} from '@core/image/deconvolution'

/**
 * Deconvolution worker: processes the brightness of a horizontal stripe
 * using the measurements taken on the whole image, so that each stripe
 * gives the same result as the computation in one piece. It receives only
 * the brightness and the saturated pixels of the stripe, not the channels:
 * the caller keeps the image and carries the result over to it (see
 * deconvolveParallel.ts).
 */

export interface DeconvolutionRequest {
  /** Brightness of the stripe, overlap margins included (see `deconvolutionLuminance`). */
  y: Float32Array
  /** Pixels of the stripe with a saturated channel (see `saturatedPixels`). */
  saturated: Uint8Array
  width: number
  height: number
  parameters: DeconvolutionParams
  measurements: DeconvolutionMeasurements
}

/** `u` and `weight` are null if the stripe has no signal to work on. */
export type DeconvolutionResponse =
  | { result: 'ok'; u: Float32Array | null; weight: Float32Array | null }
  | { result: 'error'; message: string }

self.onmessage = (event: MessageEvent<DeconvolutionRequest>): void => {
  try {
    const { y, saturated, width, height, parameters, measurements } = event.data
    const r = deconvolveBrightness(y, saturated, width, height, parameters, measurements)
    const response: DeconvolutionResponse = { result: 'ok', u: r?.u ?? null, weight: r?.weight ?? null }
    self.postMessage(response, r ? [r.u.buffer, r.weight.buffer] : [])
  } catch (error) {
    const response: DeconvolutionResponse = {
      result: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
