/// <reference lib="webworker" />

import './followLanguage'
import {
  extractChainBands,
  firstStage,
  thirdStage,
  type FirstStageMeasurements,
  type ProcessingParams
} from '@core/image/chain'
import type { ExtractedBands } from '@core/image/narrowband'
import type { ProtectedZone } from '@core/image/trails'
import type { ImageData32 } from '@shared/types'
import { setExecutor } from '@core/image/parallel'
import { createSyncSquad } from './syncSquad'

/**
 * Worker for the stages of the processing chain that run in one piece
 * (the first and the third, and with narrowband the band separation).
 * Deconvolution, at the end of the first stage, and NL-Bayes are
 * distributed across all cores by the caller.
 * Within the stages, blurs, which are the heaviest part, are split among
 * a squad of helpers with exactly the same result (see syncSquad.ts and
 * core/image/parallel.ts).
 */

/** Compute threads, as for NL-Bayes and deconvolution: this one plus the helpers. */
const PARTICIPANTS = Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 2))

/**
 * Stage 2 exists only with narrowband: it separates H-alpha and OIII,
 * which the caller then cleans with NL-Bayes band by band and passes to
 * the third stage.
 */
export interface ChainRequest {
  stage: 1 | 2 | 3
  image: ImageData32
  parameters: ProcessingParams
  automatic: boolean
  /** Narrowband: color balance gains (see chainColorGains). */
  colorGains?: [number, number, number]
  /** Narrowband, third stage: bands already extracted and cleaned. */
  bands?: ExtractedBands
  /** First stage: catalog galaxies and nebulae not to be mistaken for trails. */
  protectedZones?: ProtectedZone[]
}

export type ChainResponse =
  | {
      result: 'ok'
      image: ImageData32
      parameters: ProcessingParams
      measurements?: FirstStageMeasurements
      bands?: ExtractedBands
    }
  | { result: 'error'; message: string }

self.onmessage = async (event: MessageEvent<ChainRequest>): Promise<void> => {
  const workerPool = await createSyncSquad(PARTICIPANTS - 1)
  setExecutor(workerPool?.executor ?? null)
  try {
    const { stage, image, parameters, automatic, colorGains, bands, protectedZones } = event.data
    let r: { image: ImageData32; parameters: ProcessingParams; measurements?: FirstStageMeasurements }
    let extracted: ExtractedBands | undefined
    // The image received belongs to this worker (copied or transferred by
    // the caller): the stages work on it in place, without a copy per tool.
    if (stage === 1) r = firstStage(image, parameters, automatic, true, protectedZones, true)
    else if (stage === 2) {
      // The image goes back as it is (transferred, without copies).
      extracted = extractChainBands(image, parameters, colorGains)
      r = { image, parameters }
    } else r = thirdStage(image, parameters, automatic, bands, colorGains, true)
    // The rest of the application transfers images to other workers, which
    // is impossible with shared memory: if the result ended up there, a
    // normal copy is made.
    const normal = (a: Float32Array): Float32Array => (a.buffer instanceof ArrayBuffer ? a : a.slice())
    const data = normal(r.image.data)
    const finalImage = { ...r.image, data: data }
    const transferred: ArrayBuffer[] = [data.buffer as ArrayBuffer]
    if (extracted) {
      extracted = { ...extracted, ha: normal(extracted.ha), oiii: normal(extracted.oiii) }
      transferred.push(extracted.ha.buffer as ArrayBuffer, extracted.oiii.buffer as ArrayBuffer)
    }
    const response: ChainResponse = {
      result: 'ok',
      image: finalImage,
      parameters: r.parameters,
      measurements: r.measurements,
      bands: extracted
    }
    self.postMessage(response, transferred)
  } catch (error) {
    const response: ChainResponse = {
      result: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  } finally {
    setExecutor(null)
    workerPool?.close()
  }
}
