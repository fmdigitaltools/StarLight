/// <reference lib="webworker" />

import './followLanguage'
import type { ImageData32 } from '@shared/types'
import type { CorrectionParams } from '@core/export/processing'
import type { FilterParams } from '@core/image/photoFilters'
import { computeBase, thumbnailWithFilter, type PreviewCrop } from '@core/image/filterPreviews'

/**
 * Photo filter thumbnail worker.
 *
 * Receives the square already cropped (a few megabytes, once per image,
 * transferred without copying) and the correction parameters; returns the
 * pixels of one thumbnail per filter. The computation, a few hundred
 * milliseconds at most, stays outside the UI thread: sliders and viewer
 * never stall.
 */

export interface FilterPreviewsRequest {
  id: number
  /** Identifies the crop; `crop` is sent only when it changes. */
  cropId: number
  crop?: PreviewCrop
  /** Corrections without the filter, and a key that summarizes them. */
  corrections: Omit<CorrectionParams, 'filter'>
  correctionsKey: string
  filters: { id: string; filter: FilterParams | undefined }[]
}

export interface FilterPreviewsResponse {
  id: number
  result: 'ok' | 'error'
  message?: string
  side?: number
  thumbnails?: { id: string; rgba: ArrayBuffer }[]
  /** Computation time, in milliseconds. */
  ms?: number
}

let crop: PreviewCrop | null = null
let cropId = -1
let base: ImageData32 | null = null
let baseKey = ''

self.onmessage = (event: MessageEvent<FilterPreviewsRequest>): void => {
  const r = event.data
  const start = performance.now()
  try {
    if (r.crop) {
      crop = r.crop
      cropId = r.cropId
      base = null
    }
    if (!crop || cropId !== r.cropId) throw new Error('Crop not available.')
    if (!base || baseKey !== r.correctionsKey) {
      base = computeBase(crop, r.corrections)
      baseKey = r.correctionsKey
    }
    const ready = base
    const fromCrop = crop
    let side = 0
    const thumbnails = r.filters.map((f) => {
      const m = thumbnailWithFilter(ready, fromCrop, f.filter)
      side = m.side
      return { id: f.id, rgba: m.rgba.buffer as ArrayBuffer }
    })
    const response: FilterPreviewsResponse = {
      id: r.id,
      result: 'ok',
      side,
      thumbnails,
      ms: performance.now() - start
    }
    self.postMessage(response, thumbnails.map((m) => m.rgba))
  } catch (e) {
    const response: FilterPreviewsResponse = {
      id: r.id,
      result: 'error',
      message: e instanceof Error ? e.message : String(e)
    }
    self.postMessage(response)
  }
}
