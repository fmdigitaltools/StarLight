/// <reference lib="webworker" />

import './followLanguage'
import { readFits } from '@core/fits/reader'
import { prepareRawIfNeeded } from './libraw'
import { computeThumbnail, thumbnailFromPreview, THUMBNAIL_SIDE, type Thumbnail } from '@core/image/thumbnail'
import { readRawPreview, rawReady } from '@core/raw/rawReader'
import { detectRaw } from '@core/raw/rawFormats'

/**
 * Library thumbnail worker.
 *
 * Receives the content of an image file and returns only its thumbnail:
 * a few kilobytes of pixels instead of the tens of megabytes of the full
 * image. It works outside the UI thread, so scrolling through a list of
 * hundreds of frames stays smooth.
 *
 * For camera RAW files, the preview that the camera embedded in the file
 * is used first: a few milliseconds instead of one or two seconds of
 * decoding and a few hundred megabytes of memory. It is a temporary
 * thumbnail: the one computed from the sensor data replaces it as soon as
 * the frame is opened or analyzed.
 */

export interface PreviewRequest {
  id: number
  /** File content, transferred without copying. */
  buffer: ArrayBuffer
  fileName: string
}

export interface PreviewResponse {
  id: number
  result: 'ok' | 'error'
  message?: string
  side?: number
  /** RGBA pixels of the thumbnail, transferred without copying. */
  rgba?: ArrayBuffer
  /** True if derived from the preview embedded in the RAW file. */
  temporary?: boolean
}

/** Minimum useful side of an embedded preview worth decoding. */
const PREVIEW_SIDE = THUMBNAIL_SIDE

/**
 * Thumbnail from the preview embedded in a RAW file, or null if there is
 * no suitable one or if it is blown out (flats): the RAW is then decoded.
 */
async function fromEmbeddedPreview(byte: Uint8Array, fileName: string): Promise<Thumbnail | null> {
  const a = readRawPreview(byte, fileName, PREVIEW_SIDE)
  if (a === null) return null
  if (a.type === 'rgb') {
    return thumbnailFromPreview(a.byte, a.width, a.height, a.channels, a.aspectRatios)
  }
  // JPEG: decoded by the browser. Large previews are downscaled during
  // decoding, which is much faster than downscaling them afterwards.
  const side = Math.min(a.width, a.height)
  const reduction = Math.max(1, Math.floor(side / (4 * THUMBNAIL_SIDE)))
  const options: ImageBitmapOptions = { imageOrientation: 'none' }
  if (reduction > 1) {
    options.resizeWidth = Math.round(a.width / reduction)
    options.resizeHeight = Math.round(a.height / reduction)
    options.resizeQuality = 'medium'
  }
  const image = await createImageBitmap(new Blob([a.byte as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), options)
  try {
    const canvas = new OffscreenCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, 0, 0)
    const pixel = ctx.getImageData(0, 0, image.width, image.height).data
    return thumbnailFromPreview(pixel, image.width, image.height, 4, a.aspectRatios)
  } finally {
    image.close()
  }
}

self.onmessage = async (event: MessageEvent<PreviewRequest>): Promise<void> => {
  const { id, buffer, fileName } = event.data
  try {
    // Camera RAW files require loading LibRaw the first time.
    await prepareRawIfNeeded(fileName, buffer)
    const byte = new Uint8Array(buffer)
    let m: Thumbnail | null = null
    if (rawReady() && detectRaw(byte.subarray(0, 16), fileName) !== null) {
      try {
        m = await fromEmbeddedPreview(byte, fileName)
      } catch {
        // Unreadable preview: fall back to the sensor data.
        m = null
      }
    }
    if (m === null) {
      // readFits recognizes the format from the content: FITS, compressed FITS
      // (.fz, .fits.gz), XISF, TIFF, PNG and RAW.
      const readResult = readFits(byte, fileName)
      m = computeThumbnail(readResult.image, readResult.metadata.bayer, readResult.metadata.frameType !== 'stacked')
    }
    const rgba = m.rgba.buffer as ArrayBuffer
    const response: PreviewResponse = { id, result: 'ok', side: m.side, rgba, temporary: m.temporary }
    self.postMessage(response, [rgba])
  } catch (error) {
    const response: PreviewResponse = {
      id,
      result: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
