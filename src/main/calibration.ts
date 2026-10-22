import { app, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { sameConditions, type MasterEntry } from '@core/stack/calibrationLibrary'
import { t } from '../shared/i18n/i18n'

/**
 * Calibration library, main process side: where the masters are stored and
 * how they are read and written.
 *
 * The masters live in `<user data>/calibrazione/`:
 *   - `library.json`, the index with the capture conditions of each master;
 *   - `<id>.u16.gz`, the compressed 16-bit values, in the sensor layout.
 * Choosing the right master for a frame is done by the interface, using the
 * pure logic in core/stack/calibrationLibrary.ts.
 */

const INDEX_FILE = 'library.json'
const RE_ID = /^[0-9a-f-]{36}$/

function folder(): string {
  return join(app.getPath('userData'), 'calibration')
}

async function readIndex(): Promise<MasterEntry[]> {
  try {
    const data: unknown = JSON.parse(await readFile(join(folder(), INDEX_FILE), 'utf-8'))
    return Array.isArray(data) ? (data as MasterEntry[]).filter((v) => typeof v?.id === 'string' && RE_ID.test(v.id)) : []
  } catch {
    return []
  }
}

/** Writes the index through a temporary file, so it is never left half-written. */
async function writeIndex(entries: MasterEntry[]): Promise<void> {
  await mkdir(folder(), { recursive: true })
  const temporary = join(folder(), INDEX_FILE + '.tmp')
  await writeFile(temporary, JSON.stringify(entries, null, 2))
  await rename(temporary, join(folder(), INDEX_FILE))
}

function fileOf(id: string): string {
  return join(folder(), id + '.u16.gz')
}

export type NewMasterDescription = Omit<MasterEntry, 'id' | 'created' | 'byte'>

export function registerCalibrationHandlers(): void {
  // One operation at a time on the index, so two close saves cannot interfere.
  let tail: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job, job)
    tail = result.catch(() => undefined)
    return result
  }

  ipcMain.handle('calibration:list', (): Promise<MasterEntry[]> => readIndex())

  ipcMain.handle(
    'calibration:save',
    (_e, description: NewMasterDescription, values: ArrayBuffer): Promise<MasterEntry> =>
      enqueue(async () => {
        const expected = description.width * description.height * description.planes * 2
        if (!(values instanceof ArrayBuffer) || values.byteLength !== expected) {
          throw new Error(t('mainCalibration.wrongMasterSize'))
        }
        await mkdir(folder(), { recursive: true })
        const id = randomUUID()
        const compressedValue = gzipSync(Buffer.from(values), { level: 6 })
        await writeFile(fileOf(id), compressedValue)
        const entry: MasterEntry = { ...description, id, created: new Date().toISOString(), byte: compressedValue.length }
        // A master with the same conditions as an existing one replaces it.
        const entries = await readIndex()
        const replaced = entries.filter((v) => sameConditions(description, v))
        await writeIndex([...entries.filter((v) => !replaced.includes(v)), entry])
        for (const v of replaced) await rm(fileOf(v.id), { force: true })
        return entry
      })
  )

  ipcMain.handle('calibration:read', async (_e, id: string): Promise<ArrayBuffer> => {
    if (typeof id !== 'string' || !RE_ID.test(id)) throw new Error(t('mainCalibration.unknownMaster'))
    const data = gunzipSync(await readFile(fileOf(id)))
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  })

  ipcMain.handle(
    'calibration:delete',
    (_e, id: string): Promise<void> =>
      enqueue(async () => {
        if (typeof id !== 'string' || !RE_ID.test(id)) throw new Error(t('mainCalibration.unknownMaster'))
        const entries = await readIndex()
        await writeIndex(entries.filter((v) => v.id !== id))
        await rm(fileOf(id), { force: true })
      })
  )

  ipcMain.handle('calibration:openFolder', async (): Promise<void> => {
    await mkdir(folder(), { recursive: true })
    await shell.openPath(folder())
  })
}
