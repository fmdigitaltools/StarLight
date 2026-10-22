/// <reference lib="webworker" />

import './followLanguage'
import { readFitsHeaderOnly, type HeaderRead } from '@core/fits/reader'
import { prepareRawIfNeeded } from './libraw'

/**
 * Worker that reads the shooting metadata of RAW files during import.
 *
 * LibRaw needs the whole file even just for the shooting metadata (in many
 * formats it is scattered across the file, see rawReader). Doing it here
 * instead of in the window has two advantages: several files are read
 * together while the next one arrives from disk, and the memory LibRaw
 * takes for the largest file (over 100 MB with a 61-megapixel sensor) goes
 * away with the worker once the import is done, instead of staying with
 * the window.
 */

export interface HeaderRequest {
  id: number
  /** File content, transferred without copying. */
  buffer: ArrayBuffer
  fileName: string
}

export interface HeaderResponse {
  id: number
  result: 'ok' | 'error'
  message?: string
  header?: HeaderRead
}

self.onmessage = async (event: MessageEvent<HeaderRequest>): Promise<void> => {
  const { id, buffer, fileName } = event.data
  try {
    await prepareRawIfNeeded(fileName, buffer)
    const header = readFitsHeaderOnly(new Uint8Array(buffer), fileName)
    const response: HeaderResponse = { id, result: 'ok', header }
    self.postMessage(response)
  } catch (error) {
    const response: HeaderResponse = {
      id,
      result: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
