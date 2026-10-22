import { t } from '@shared/i18n/i18n'
import { prepareRaw, rawReady } from '@core/raw/rawReader'
import { hasRawExtension, detectRaw } from '@core/raw/rawFormats'
import wasmUrl from '@colorhythm/libraw-wasm/libraw.wasm?url'

/**
 * Loading of LibRaw (WebAssembly) in the renderer and in the workers.
 *
 * `readFits` also reads camera RAW files, but synchronously: the
 * WebAssembly module must therefore be prepared beforehand, once for each
 * worker (and for the window), with `prepareRawInBrowser`.
 *
 * The libraw.wasm file (850 kB) is copied by Vite among the program
 * resources and read only the first time it is needed: anyone who never
 * opens RAW files never loads it.
 */

let inProgress: Promise<void> | null = null

/** Prepares LibRaw in this thread; subsequent calls cost nothing. */
export function prepareRawInBrowser(): Promise<void> {
  if (rawReady()) return Promise.resolve()
  if (inProgress === null) {
    inProgress = (async (): Promise<void> => {
      const address = new URL(wasmUrl, self.location.href).href
      const response = await fetch(address)
      if (!response.ok) throw new Error(t('workersLibraw.wasmNotFound', { status: response.status }))
      await prepareRaw(await response.arrayBuffer())
    })().catch((e: unknown) => {
      inProgress = null
      throw e
    })
  }
  return inProgress
}

/**
 * Prepares LibRaw only if the file is a RAW file (from its name or its
 * first bytes). To be called before `readFits` / `readFitsHeaderOnly`.
 */
export async function prepareRawIfNeeded(fileName: string, content?: ArrayBuffer | Uint8Array): Promise<void> {
  if (rawReady()) return
  let raw = hasRawExtension(fileName)
  if (!raw && content !== undefined) {
    const start =
      content instanceof Uint8Array
        ? content.subarray(0, 16)
        : new Uint8Array(content, 0, Math.min(16, content.byteLength))
    raw = detectRaw(start, fileName) !== null
  }
  if (raw) await prepareRawInBrowser()
}
