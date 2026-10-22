/*
 * Automatic recovery save, disk side.
 *
 * When there is unsaved work and nothing has been touched for a while, the
 * interface sends the project state and the changed images here; they are
 * written to the `recovery` folder inside the app data folder. The images are
 * encoded to FITS here rather than in the interface, so the heavy work
 * (hundreds of megabytes for a large image) does not stall the sliders.
 *
 * Every write is atomic: a temporary file is written and then renamed. Images
 * get a new name every time they change, and the project file is replaced
 * only once they are all in place: a crash halfway leaves the previous copy
 * intact, at most with a few extra files that the next save removes.
 *
 * On a clean shutdown the copy is deleted. If it is still there at startup,
 * the previous shutdown was not clean (crash, power loss, killed process) and
 * the interface offers to recover the work.
 */
import { app, ipcMain } from 'electron'
import { isPluginSandbox } from './pluginSandbox'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { rmSync, writeFileSync, renameSync } from 'node:fs'
import { encodeFits } from '@core/export/encoding'
import {
  RECOVERY_FOLDER,
  RECOVERY_INFO_NAME,
  type RecoveryCopy,
  type RecoveryImage,
  type RecoveryInfo
} from '@shared/recovery'

/**
 * Same name as PROJECT_FILE_NAME in @core/project, repeated here so the main
 * process does not pull in the whole processing chain that module depends on.
 */
const PROJECT_FILE_NAME = 'project.slight'

function recoveryFolder(): string {
  return join(app.getPath('userData'), RECOVERY_FOLDER)
}

/** A plain file name, never a path that leaves the folder. */
function validName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..'
}

/** Writes a file through a temporary one, so it is never left half-written. */
async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = path + '.tmp'
  await writeFile(temporary, data)
  await rename(temporary, path)
}

/*
 * Operations are queued: a save and the deletion requested right after it
 * (the project was actually saved) must not overlap, or the copy would
 * reappear after being removed.
 */
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job, job)
  queue = result.catch(() => undefined)
  return result
}

/** True once a clean shutdown has started: no new copies. */
let closed = false
/**
 * True while, at startup, the interface asks whether to recover: if the app
 * is closed at that moment the copy must not be deleted, because nobody has
 * chosen to discard it yet.
 */
let toDecide = false
/** Disk operations still running, to wait for before quitting. */
let inProgress = 0

/** Pixels of the images arriving in chunks, by file name. */
const incoming = new Map<string, { data: Float32Array; received: number }>()

function receiveChunk(name: string, total: number, start: number, piece: Float32Array): void {
  if (!validName(name) || !Number.isInteger(total) || total <= 0 || !(piece instanceof Float32Array)) return
  let entry = incoming.get(name)
  if (start === 0 || !entry || entry.data.length !== total) {
    entry = { data: new Float32Array(total), received: 0 }
    incoming.set(name, entry)
  }
  if (!Number.isInteger(start) || start < 0 || start + piece.length > total) return
  entry.data.set(piece, start)
  entry.received += piece.length
}

async function save(
  text: string,
  images: RecoveryImage[],
  keep: string[],
  info: RecoveryInfo
): Promise<void> {
  try {
    if (closed) return
    if (images.some((i) => !validName(i.name)) || keep.some((n) => !validName(n))) {
      throw new Error('Invalid file name.')
    }
    const folder = recoveryFolder()
    await mkdir(folder, { recursive: true })
    // First the new images, then the project file that references them.
    for (const i of images) {
      if (closed) return
      const pixel = incoming.get(i.name)
      if (!pixel || pixel.received !== pixel.data.length || pixel.data.length !== i.width * i.height * i.channels) {
        throw new Error('Incomplete image pixels.')
      }
      const image = { width: i.width, height: i.height, channels: i.channels, data: pixel.data }
      const data = encodeFits(image, i.cards, 32, { wcs: i.wcs })
      await writeAtomic(join(folder, i.name), new Uint8Array(data))
    }
    await writeText(folder, text, keep, info)
  } finally {
    for (const i of images) incoming.delete(i.name)
  }
}

/** Writes the project file and the info, then removes the files no longer referenced. */
async function writeText(folder: string, text: string, keep: string[], info: RecoveryInfo): Promise<void> {
  if (closed) return
  await writeAtomic(join(folder, PROJECT_FILE_NAME), text)
  await writeAtomic(join(folder, RECOVERY_INFO_NAME), JSON.stringify({ ...info, cleanShutdown: false }, null, 2))
  // Remove images the project no longer references and leftover temporary files.
  const remaining = new Set([...keep, PROJECT_FILE_NAME, RECOVERY_INFO_NAME])
  for (const name of await readdir(folder)) {
    if (remaining.has(name)) continue
    try {
      await unlink(join(folder, name))
    } catch {
      // A file that cannot be removed now will be removed next time.
    }
  }
}

async function remove(): Promise<void> {
  toDecide = false
  incoming.clear()
  await rm(recoveryFolder(), { recursive: true, force: true })
}

/** The copy left by an unclean shutdown, if any. */
async function read(): Promise<RecoveryCopy | null> {
  const folder = recoveryFolder()
  const path = join(folder, PROJECT_FILE_NAME)
  try {
    await stat(path)
  } catch {
    return null
  }
  let info: RecoveryInfo
  try {
    const raw = JSON.parse(await readFile(join(folder, RECOVERY_INFO_NAME), 'utf-8')) as Partial<RecoveryInfo>
    const p = raw.project
    info = {
      project:
        p && typeof p.name === 'string' && typeof p.folder === 'string' ? { name: p.name, folder: p.folder } : null,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : (await stat(path)).mtime.toISOString(),
      cleanShutdown: raw.cleanShutdown === true
    }
  } catch {
    // Missing or damaged info: the work is still there, without a name.
    info = { project: null, savedAt: (await stat(path)).mtime.toISOString(), cleanShutdown: false }
  }
  if (info.cleanShutdown) {
    await remove().catch(() => undefined)
    return null
  }
  toDecide = true
  return { path, info }
}

/** On a clean shutdown: deletes the copy, or at least marks it as not to be offered. */
function deleteOnClose(): void {
  if (toDecide) return
  const folder = recoveryFolder()
  try {
    rmSync(folder, { recursive: true, force: true })
  } catch {
    try {
      const path = join(folder, RECOVERY_INFO_NAME)
      writeFileSync(path + '.tmp', JSON.stringify({ project: null, savedAt: '', cleanShutdown: true }))
      renameSync(path + '.tmp', path)
    } catch {
      // Worst case, recovery will be offered at the next startup.
    }
  }
}

function withCount<T>(job: () => Promise<T>): Promise<T> {
  inProgress++
  return enqueue(job).finally(() => {
    inProgress--
  })
}

/**
 * Forced shutdown because the interface is not responding: the work did not
 * have a clean shutdown, and the copy remains to be offered at startup.
 */
export function keepRecoveryCopy(): void {
  toDecide = true
}

export function registerRecovery(): void {
  ipcMain.handle(
    'recovery:save',
    (_e, text: string, images: RecoveryImage[], keep: string[], info: RecoveryInfo): Promise<void> =>
      withCount(() => save(text, images, keep, info))
  )
  ipcMain.handle('recovery:data', (_e, name: string, total: number, start: number, piece: Float32Array): void => {
    receiveChunk(name, total, start, piece)
  })
  ipcMain.handle('recovery:delete', (): Promise<void> => withCount(remove))
  ipcMain.handle('recovery:read', (): Promise<RecoveryCopy | null> => withCount(read))
  // Choice made at startup (Recover): from now on the copy follows the work.
  ipcMain.on('recovery:decided', () => {
    toDecide = false
  })

  // Window gone unexpectedly: the work did not have a clean shutdown, so the
  // copy stays even if the app is then quit without reopening the window.
  // Recovery is offered at the next start.
  app.on('render-process-gone', (_e, contents, details) => {
    // A crash of the plugin sandbox does not affect the open work.
    if (isPluginSandbox(contents)) return
    if (details.reason !== 'clean-exit') toDecide = true
  })

  /*
   * Clean shutdown: any write in progress is awaited (a few moments), then
   * the copy is deleted. A crash or a killed process never gets here, which
   * is exactly how the next startup can tell what happened.
   */
  let waitDone = false
  app.on('will-quit', (e) => {
    closed = true
    if (inProgress > 0 && !waitDone) {
      waitDone = true
      e.preventDefault()
      void queue.finally(() => {
        deleteOnClose()
        app.quit()
      })
      return
    }
    deleteOnClose()
  })
}
