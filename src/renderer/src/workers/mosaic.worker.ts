/// <reference lib="webworker" />

import './followLanguage'
import { t } from '@shared/i18n/i18n'
import type { Wcs } from '@shared/types'
import { readFits } from '@core/fits/reader'
import { prepareRawIfNeeded } from './libraw'
import { debayer } from '@core/image/debayer'
import {
  composeMosaic,
  coverageThumbnail,
  type PanelCorrection,
  type Overlap
} from '@core/stack/mosaic'

/**
 * Mosaic worker: receives the panel files, decodes them one at a time (so
 * only one is in memory, besides the reprojected ones) and composes the
 * mosaic. The UI stays free in the meantime.
 */

export interface MosaicRequest {
  panels: { buffer: ArrayBuffer; fileName: string; wcs: Wcs; width: number; height: number }[]
  blend: boolean
}

export type MosaicResponse =
  | { type: 'progress'; label: string; fraction: number }
  | {
      type: 'done'
      width: number
      height: number
      channels: 1 | 3
      data: Float32Array
      wcs: Wcs
      scale: number
      coveredFraction: number
      overlapFraction: number
      corrections: PanelCorrection[]
      overlaps: Overlap[]
      isolated: number[]
      thumbnail: { data: Uint8Array; width: number; height: number }
    }
  | { type: 'error'; message: string }

self.onmessage = async (event: MessageEvent<MosaicRequest>): Promise<void> => {
  const { panels, blend } = event.data
  const buffer: (ArrayBuffer | null)[] = panels.map((p) => p.buffer)
  try {
    // Camera RAW files require loading LibRaw the first time.
    for (const p of panels) await prepareRawIfNeeded(p.fileName, p.buffer)
    const r = composeMosaic(
      panels.map((p) => ({ width: p.width, height: p.height, wcs: p.wcs })),
      (k) => {
        const content = buffer[k]
        if (content === null) throw new Error(t('workersMosaic.panelAlreadyRead'))
        const readResult = readFits(new Uint8Array(content), panels[k].fileName)
        // The file is no longer needed: release its memory.
        buffer[k] = null
        return debayer(readResult.image, readResult.metadata.bayer)
      },
      { blend },
      (label, fraction) => {
        const msg: MosaicResponse = { type: 'progress', label, fraction }
        self.postMessage(msg)
      }
    )
    const thumbnail = coverageThumbnail(r.coverage, r.image.width, r.image.height)
    const response: MosaicResponse = {
      type: 'done',
      width: r.image.width,
      height: r.image.height,
      channels: r.image.channels,
      data: r.image.data,
      wcs: r.wcs,
      scale: r.scale,
      coveredFraction: r.coveredFraction,
      overlapFraction: r.overlapFraction,
      corrections: r.corrections,
      overlaps: r.overlaps,
      isolated: r.isolated,
      thumbnail
    }
    self.postMessage(response, [r.image.data.buffer as ArrayBuffer])
  } catch (error) {
    const response: MosaicResponse = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
