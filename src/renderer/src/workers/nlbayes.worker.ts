/// <reference lib="webworker" />

import './followLanguage'
import { nlBayes } from '@core/image/nlbayes'

/**
 * NL-Bayes noise reduction worker: processes a horizontal stripe of the
 * luminance, overlap margins included.
 */

export interface NlBayesRequest {
  stripe: Float32Array
  width: number
  height: number
  sigma: number
}

export type NlBayesResponse =
  | { result: 'ok'; stripe: Float32Array }
  | { result: 'error'; message: string }

self.onmessage = (event: MessageEvent<NlBayesRequest>): void => {
  try {
    const { stripe, width, height, sigma } = event.data
    const cleaned = nlBayes(stripe, width, height, sigma)
    const response: NlBayesResponse = { result: 'ok', stripe: cleaned }
    self.postMessage(response, [cleaned.buffer])
  } catch (error) {
    const response: NlBayesResponse = {
      result: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
