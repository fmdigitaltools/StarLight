import { readFitsHeaderOnly, InsufficientHead, type HeaderRead } from '@core/fits/reader'
import { objectFromFileName } from '@core/formats/objectFromName'
import { searchByName } from '@core/catalog/recognition'
import { hasRawExtension } from '@core/raw/rawFormats'
import { prepareRawInBrowser, prepareRawIfNeeded } from '../workers/libraw'
import { HEADER_READ_WORKERS, HeaderWorkerPool } from '../workers/pool'
import { t } from '@shared/i18n/i18n'

/**
 * Header-only reading for the library, including the cases where the start
 * of the file is not enough.
 *
 * Usually the first 64 kB suffice (see HEAD_BYTES in useLibrary). The
 * exceptions are an XISF file with a very long XML header, a TIFF file that
 * keeps its directory at the end of the file, and RAW files: the reader
 * signals this by throwing `InsufficientHead` with the number of bytes
 * needed, and the file is reread here.
 *
 * For TIFF and PNG, which carry no acquisition metadata, the file name is the
 * only clue about the imaged object: "M_27.tif" or "NGC7000-final.png" give a
 * starting point to object recognition and plate solving, which would
 * otherwise not know where to look.
 */
export async function completeHeader(
  head: Uint8Array,
  path: string,
  fileName: string,
  fileSize: number
): Promise<HeaderRead> {
  let data = head
  let info: HeaderRead | null = null
  for (let attempt = 0; info === null; attempt++) {
    try {
      info = readFitsHeaderOnly(data, fileName, fileSize)
    } catch (e) {
      if (!(e instanceof InsufficientHead) || attempt >= 4 || data.length >= fileSize) throw e
      const neededItems = e.neededBytes
      data = new Uint8Array(
        neededItems >= fileSize * 0.5 || !Number.isFinite(neededItems)
          ? await window.starlight.readFile(path)
          : await window.starlight.readHead(path, Math.ceil(neededItems))
      )
      await prepareRawIfNeeded(fileName, data)
    }
  }
  return withObjectFromName(info, fileName)
}

/** For TIFF and PNG files with no declared object, tries to derive it from the file name. */
export function withObjectFromName(info: HeaderRead, fileName: string): HeaderRead {
  const m = info.metadata
  if (m.object !== null || (m.format !== 'tiff' && m.format !== 'png')) return info
  const object = objectFromFileName(fileName, searchByName)
  return object === null ? info : { ...info, metadata: { ...m, object: object } }
}

let headerCounter = 0

/**
 * Reads the acquisition metadata of a list of files, several at a time, and
 * returns the header or the error for each, in list order. `progress`
 * receives the number of files finished.
 *
 * FITS and the other formats only need the start of the file (see
 * `completeHeader`); RAW files must be read in full and go through a small
 * worker pool, closed at the end, so LibRaw's memory is released and the
 * window does not retain it. At most one file per worker plus one arriving
 * from disk are in flight at any time.
 */
export async function readHeaders(
  file: { path: string; fileName: string; sizeBytes: number }[],
  headBytes: number,
  progress: (finished: number) => void
): Promise<({ info: HeaderRead } | { error: string })[]> {
  const results: ({ info: HeaderRead } | { error: string })[] = new Array(file.length)
  const withRaw = file.some((f) => hasRawExtension(f.fileName))
  let workerPool: HeaderWorkerPool | null = null
  if (withRaw) {
    try {
      workerPool = new HeaderWorkerPool(Math.min(HEADER_READ_WORKERS, file.length))
    } catch {
      // Without workers, files are read in the window.
      workerPool = null
    }
  }

  const readOne = async (f: { path: string; fileName: string; sizeBytes: number }): Promise<HeaderRead> => {
    if (hasRawExtension(f.fileName)) {
      const buffer = await window.starlight.readFile(f.path)
      if (workerPool !== null) {
        const r = await workerPool.read({ id: ++headerCounter, buffer, fileName: f.fileName })
        if (r.result === 'error' || !r.header) throw new Error(r.message ?? t('hooksFileHeader.unreadableMetadata'))
        return r.header
      }
      await prepareRawInBrowser()
      return completeHeader(new Uint8Array(buffer), f.path, f.fileName, f.sizeBytes)
    }
    const head = await window.starlight.readHead(f.path, headBytes)
    return completeHeader(new Uint8Array(head), f.path, f.fileName, f.sizeBytes)
  }

  let next = 0
  let finished = 0
  const simultaneous = withRaw ? HEADER_READ_WORKERS + 1 : 4
  try {
    await Promise.all(
      Array.from({ length: Math.min(simultaneous, file.length) }, async () => {
        while (next < file.length) {
          const i = next++
          try {
            results[i] = { info: await readOne(file[i]) }
          } catch (e) {
            results[i] = { error: e instanceof Error ? e.message : String(e) }
          }
          progress(++finished)
        }
      })
    )
  } finally {
    workerPool?.close()
  }
  return results
}
