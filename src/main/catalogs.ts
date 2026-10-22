import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile, writeFile, readdir, mkdir, rm, rename, stat, open, type FileHandle } from 'node:fs/promises'
import {
  UPDATES_KEY,
  UPDATES_KEY_HEADER,
  updatesConfigured
} from '@shared/version'
import type {
  CatalogProgress,
  InstalledCatalog,
  CatalogListResult,
  CatalogInstallResult
} from '@shared/catalogs'
import {
  SERVER_CATALOGS_FOLDER,
  CATALOG_INDEX_FILE,
  OBJECTS_FILE,
  CATALOG_GROUPS,
  OBJECTS_LIMIT_BYTES,
  PACKAGE_LIMIT_BYTES,
  readCatalogsIndex,
  catalogName,
  type CatalogIndex,
  type CatalogManifest,
  type CatalogIndexEntry
} from '@core/catalog/package'
import { fetchFromServer, isWebPage } from './server'
import { writeLog } from './log'
import { validId, isSimpleFileName } from '@core/plugin/manifest'
import {
  STARS_FILE,
  STARS_HEADER_BYTES,
  headerBytes,
  readStarsIndex,
  readStarsHeader,
  starsInCone,
  type StarIndex
} from '@core/astrometry/localStars'
import type { CatalogStar } from '@core/astrometry/solver'
import { CATALOG, REMEDIES, STARS, ZIP } from '@shared/protectionTexts'
import { inspectCatalog, fileFromCatalogZip, recheckCatalog, type RecheckResult } from './catalogInspection'
import { t } from '../shared/i18n/i18n'

/**
 * Downloadable deep-sky catalogs, main process side.
 *
 * The packages live on the updates server (R2 bucket served by the Worker),
 * in the `catalogs/` folder, listed in `catalogs.json`. The address is the
 * app's fixed one: there is no field to enter another, and only the
 * StarLight publisher prepares the packages (tools/prepare-catalogs.mjs).
 *
 * Every downloaded package is verified against the SHA-256 fingerprint in
 * the index before it is opened; then, like those chosen from disk, it goes
 * through the same checks (catalogInspection.ts): complete manifest, open
 * license, readable and plausible objects, star file consistent with its
 * index. Only the expected files are copied to the final folder.
 *
 * Installed catalogs live in `<user data>/catalogs/<id>/`. They are
 * rechecked at every startup (a file may have been damaged or copied by
 * hand): a catalog that fails the checks stays in the list with its problems
 * but is not loaded, and the interface reports it.
 * The same applies to star packages for plate solving (`type: 'stars'` in
 * catalog.json), which carry `stars.bin` instead of objects: the file stays
 * on disk and only the requested sky regions are read. If reading fails
 * during use, the package is excluded for the rest of the session and plate
 * solving falls back to the Gaia catalog.
 * Permission to use the internet is checked by the interface before asking
 * for the index or a download.
 */

function installedFolder(): string {
  return join(app.getPath('userData'), 'catalogs')
}

/** Installed but disabled catalogs: they stay on disk without being loaded. */
function disabledFiles(): string {
  return join(app.getPath('userData'), 'disabled-catalogs.json')
}

async function disabledItems(): Promise<Set<string>> {
  try {
    const data: unknown = JSON.parse(await readFile(disabledFiles(), 'utf-8'))
    return new Set(Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string' && validId(x)) : [])
  } catch {
    return new Set()
  }
}

async function writeDisabled(ids: Set<string>): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(disabledFiles(), JSON.stringify([...ids].sort(), null, 2))
}


function headers(): Record<string, string> {
  return UPDATES_KEY ? { [UPDATES_KEY_HEADER]: UPDATES_KEY } : {}
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Turns a network error into a sentence to show. */
function networkError(e: unknown): string {
  const name = e instanceof Error ? e.name : ''
  if (name === 'TimeoutError') return t('mainCatalogs.network.timeout')
  if (name === 'AbortError') return t('mainCatalogs.network.aborted')
  return t('mainCatalogs.network.connectionFailed')
}

async function listFromServer(): Promise<CatalogIndex> {
  if (!updatesConfigured()) throw new Error(t('mainCatalogs.serverNotConfigured'))
  let response: Response
  try {
    response = await fetchFromServer(SERVER_CATALOGS_FOLDER + CATALOG_INDEX_FILE, {
      headers: { ...headers(), 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(20000)
    })
  } catch (e) {
    throw new Error(t('mainCatalogs.indexUnreachable', { reason: networkError(e) }))
  }
  if (response.status === 404) throw new Error(t('mainCatalogs.noCatalogsYet'))
  if (!response.ok) throw new Error(t('mainCatalogs.catalogServerError', { status: response.status }))
  // A web page or a broken file in place of the index: a clear message, never the raw parser error.
  const unexpected = new Error(t('mainCatalogs.indexUnreachable', { reason: t('mainCatalogs.network.unexpectedReply') }))
  if (isWebPage(response)) {
    writeLog('warning', 'main', 'Catalogs: the server answered with a web page instead of the index.')
    throw unexpected
  }
  let data: unknown
  try {
    data = JSON.parse(await response.text())
  } catch (e) {
    writeLog('warning', 'main', 'Catalogs: unreadable index (' + message(e) + ').')
    throw unexpected
  }
  return readCatalogsIndex(data)
}

/** The download exceeds the declared size: recognized by its class, not by its text. */
class LargerThanDeclared extends Error {}

/** Downloads a package, sending the progress to the interface. */
async function download(
  entry: CatalogIndexEntry,
  advance: (a: CatalogProgress) => void,
  signal: AbortSignal
): Promise<Buffer> {
  let response: Response
  try {
    response = await fetchFromServer(SERVER_CATALOGS_FOLDER + entry.file, {
      headers: headers(),
      signal: signal
    })
  } catch (e) {
    throw new Error(t('mainCatalogs.downloadFailed', { reason: networkError(e) }))
  }
  if (!response.ok || !response.body) throw new Error(t('mainCatalogs.serverError', { status: response.status }))
  if (isWebPage(response)) throw new Error(t('mainCatalogs.downloadFailed', { reason: t('mainCatalogs.network.unexpectedReply') }))
  const parts: Buffer[] = []
  let received = 0
  let last = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > entry.byte) throw new LargerThanDeclared(CATALOG.largest)
      parts.push(Buffer.from(value))
      const now = Date.now()
      if (now - last > 120) {
        last = now
        advance({ id: entry.id, received, total: entry.byte })
      }
    }
  } catch (e) {
    if (e instanceof LargerThanDeclared) throw e
    throw new Error(t('mainCatalogs.downloadFailed', { reason: networkError(e) }))
  }
  advance({ id: entry.id, received, total: entry.byte })
  const data = Buffer.concat(parts)
  if (data.length !== entry.byte) throw new Error(CATALOG.incomplete)
  const fingerprint = createHash('sha256').update(data).digest('hex')
  if (fingerprint !== entry.sha256) throw new Error(CATALOG.fingerprint)
  return data
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Writes the catalog to its folder, replacing any previous version. */
async function write(manifest: CatalogManifest, toCopy: Map<string, Buffer>): Promise<boolean> {
  const root = installedFolder()
  await mkdir(root, { recursive: true })
  const final = join(root, manifest.id)
  const temporary = join(root, '.' + manifest.id + '-' + Date.now())
  // An open star file would prevent replacing the folder on Windows.
  await closeStars()
  await mkdir(temporary)
  try {
    for (const [name, data] of toCopy) {
      if (!isSimpleFileName(name)) continue
      await writeFile(join(temporary, name), data)
    }
    const existed = await exists(final)
    if (existed) await rm(final, { recursive: true, force: true })
    await rename(temporary, final)
    return existed
  } catch (e) {
    await rm(temporary, { recursive: true, force: true })
    throw e
  }
}

async function install(file: Map<string, Buffer>, expectedId?: string): Promise<CatalogInstallResult> {
  const result = inspectCatalog(file, expectedId !== undefined)
  if (!result.ok) return result
  if (expectedId !== undefined && result.manifest.id !== expectedId) {
    return { ok: false, errors: [CATALOG.differentPackage], remedy: REMEDIES.retryServer, name: catalogName(result.manifest) }
  }
  try {
    const updated = await write(result.manifest, result.toCopy)
    // Reinstalled: earlier problems no longer apply.
    failures.delete(result.manifest.id)
    rechecks.delete(result.manifest.id)
    return { ok: true, manifest: result.manifest, updated }
  } catch (e) {
    return { ok: false, errors: [CATALOG.copyFailed(message(e))], remedy: REMEDIES.diskSpace, name: catalogName(result.manifest) }
  }
}

/**
 * Catalogs excluded for this session because reading failed while they were
 * in use (for example a star file damaged after startup): id → problem.
 * Cleared by reinstalling the catalog or restarting StarLight.
 */
const failures = new Map<string, string>()

/**
 * Recheck results, so the indexes are not reread on every request: they hold
 * as long as the size and time of the folder's files do not change.
 */
const rechecks = new Map<string, { fingerprint: string; result: RecheckResult }>()

async function folderFingerprint(folder: string): Promise<string> {
  const parts: string[] = []
  for (const v of await readdir(folder, { withFileTypes: true })) {
    if (!v.isFile()) continue
    const s = await stat(join(folder, v.name))
    parts.push(v.name + ':' + s.size + ':' + s.mtimeMs)
  }
  return parts.sort().join('|')
}

async function recheckWithMemory(name: string): Promise<RecheckResult> {
  const folder = join(installedFolder(), name)
  let fingerprint = ''
  try {
    fingerprint = await folderFingerprint(folder)
  } catch {
    // The folder cannot be read: the recheck will report it.
  }
  const known = rechecks.get(name)
  if (known && fingerprint !== '' && known.fingerprint === fingerprint) return known.result
  let result: RecheckResult
  try {
    result = await recheckCatalog(folder, name)
  } catch (e) {
    result = { ok: false, errors: [message(e)], remedy: REMEDIES.reinstallCatalog, byte: 0 }
  }
  rechecks.set(name, { fingerprint, result })
  return result
}

/** Minimal manifest for a catalog whose manifest cannot be read: enough to show its card. */
function placeholderManifest(id: string, name: string): CatalogManifest {
  return {
    format: 1,
    id,
    name,
    version: '0.0.0',
    type: 'deep-sky',
    group: CATALOG_GROUPS[CATALOG_GROUPS.length - 1],
    description: '',
    authors: '',
    reference: '',
    source: '',
    license: '',
    licenseLink: '',
    objects: 0,
    example: '',
    noteLanguages: [],
    translations: {}
  }
}

async function listInstalled(): Promise<InstalledCatalog[]> {
  let names: string[]
  try {
    names = (await readdir(installedFolder(), { withFileTypes: true }))
      // Folders starting with a dot are temporary: they are not catalogs.
      .filter((v) => v.isDirectory() && !v.name.startsWith('.') && isSimpleFileName(v.name))
      .map((v) => v.name)
  } catch {
    return []
  }
  const disabled = await disabledItems()
  const result: InstalledCatalog[] = []
  for (const name of names.sort()) {
    if (!validId(name)) {
      result.push({
        id: name,
        manifest: placeholderManifest(name, name),
        byte: 0,
        active: false,
        problems: [CATALOG.invalidId],
        remedy: REMEDIES.reinstallCatalog
      })
      continue
    }
    const r = await recheckWithMemory(name)
    const failure = failures.get(name)
    if (r.ok && !failure) {
      result.push({ id: name, manifest: r.manifest, byte: r.byte, active: !disabled.has(name) })
    } else {
      result.push({
        id: name,
        manifest: r.ok ? r.manifest : (r.manifest ?? placeholderManifest(name, r.name ?? name)),
        byte: r.byte,
        active: !disabled.has(name),
        problems: r.ok ? [failure as string] : r.errors,
        remedy: r.ok ? REMEDIES.reinstallCatalog : r.remedy
      })
    }
  }
  return result
}

/** Temporary folders left by an interrupted installation: removed at startup. */
async function removeTemporary(): Promise<void> {
  try {
    for (const v of await readdir(installedFolder(), { withFileTypes: true })) {
      if (v.isDirectory() && /^\.[a-z0-9-]+-\d+$/.test(v.name)) {
        await rm(join(installedFolder(), v.name), { recursive: true, force: true })
      }
    }
  } catch {
    // Folder missing.
  }
}

/*
 * Stars for plate solving: the file of the installed and active package
 * stays open between requests, with the cell index in memory (a few hundred
 * kilobytes); stars are read from disk cell by cell.
 */

interface OpenStarsFile {
  path: string
  handle: FileHandle
  index: StarIndex
}

let openStarFile: OpenStarsFile | null = null

async function closeStars(): Promise<void> {
  const starFile = openStarFile
  openStarFile = null
  if (starFile) await starFile.handle.close().catch(() => undefined)
}

/** The installed, active and problem-free star package, if any. */
async function starPackageActive(): Promise<InstalledCatalog | null> {
  return (await listInstalled()).find((c) => c.manifest.type === 'stars' && c.active && !c.problems) ?? null
}

async function openStars(id: string): Promise<OpenStarsFile> {
  const path = join(installedFolder(), id, STARS_FILE)
  if (openStarFile && openStarFile.path === path) return openStarFile
  await closeStars()
  const handle = await open(path, 'r')
  try {
    const read = async (position: number, length: number): Promise<Uint8Array> => {
      const data = Buffer.alloc(length)
      const { bytesRead } = await handle.read(data, 0, length, position)
      if (bytesRead !== length) throw new Error(STARS.incomplete)
      return data
    }
    const { cells } = readStarsHeader(await read(0, STARS_HEADER_BYTES))
    const index = readStarsIndex(await read(0, headerBytes(cells)), (await handle.stat()).size)
    openStarFile = { path, handle, index }
    return openStarFile
  } catch (e) {
    await handle.close().catch(() => undefined)
    throw e
  }
}

/**
 * Local stars within the given circle, brightest first; null if there is no
 * installed, active and usable star package. If reading fails, the package
 * is excluded for the rest of the session and the error reaching the
 * interface carries its name and the reason (excludedStars in
 * protectionTexts), so the plate solver can warn and fall back to the Gaia
 * catalog.
 */
async function localStars(
  ra: number,
  dec: number,
  radius: number,
  magnitude: number
): Promise<{ stars: CatalogStar[]; limitMagnitude: number } | null> {
  if (![ra, dec, radius, magnitude].every(Number.isFinite)) throw new Error(STARS.coordinates)
  const pkg = await starPackageActive()
  if (!pkg) {
    await closeStars()
    return null
  }
  try {
    const starFile = await openStars(pkg.manifest.id)
    const read = async (position: number, length: number): Promise<Uint8Array> => {
      const data = Buffer.alloc(length)
      const { bytesRead } = await starFile.handle.read(data, 0, length, position)
      // A file truncated after startup would yield stars made of zeros: better to stop.
      if (bytesRead !== length) throw new Error(STARS.incomplete)
      return data
    }
    const stars = await starsInCone(
      starFile.index,
      read,
      ((ra % 360) + 360) % 360,
      Math.min(90, Math.max(-90, dec)),
      Math.min(10, Math.max(0.01, radius)),
      magnitude
    )
    return { stars, limitMagnitude: pkg.manifest.limitMagnitude ?? 12 }
  } catch (e) {
    const problem = message(e)
    failures.set(pkg.manifest.id, problem)
    await closeStars()
    // The text reaches the interface with an Electron prefix: it is recognized by the marker.
    throw new Error('[stars-excluded]' + JSON.stringify({ name: catalogName(pkg.manifest), problem }))
  }
}

export function registerCatalogHandlers(window: () => BrowserWindow | null): void {
  /** Downloads in progress, so they can be cancelled. */
  const inProgress = new Map<string, AbortController>()
  const preparation = removeTemporary()

  ipcMain.handle('catalogs:installed', async (): Promise<InstalledCatalog[]> => {
    await preparation
    return listInstalled()
  })

  ipcMain.handle('catalogs:available', async (): Promise<CatalogListResult> => {
    try {
      const index = await listFromServer()
      return {
        ok: true,
        catalogs: index.catalogs,
        updated: index.updated
      }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  })

  ipcMain.handle(
    'stars:local',
    (_e, ra: number, dec: number, radius: number, magnitude: number) => localStars(ra, dec, radius, magnitude)
  )

  ipcMain.handle('catalogs:objects', async (_e, id: string): Promise<string> => {
    if (typeof id !== 'string' || !validId(id)) throw new Error(CATALOG.unknown)
    const path = join(installedFolder(), id, OBJECTS_FILE)
    if ((await stat(path)).size > OBJECTS_LIMIT_BYTES) throw new Error(CATALOG.objectsTooBig(OBJECTS_LIMIT_BYTES / 1048576))
    return readFile(path, 'utf-8')
  })

  /** Marks a catalog as excluded for this session (the interface failed to use it). */
  ipcMain.handle('catalogs:exclude', (_e, id: string, problem: string): void => {
    if (typeof id !== 'string' || !validId(id) || typeof problem !== 'string') return
    failures.set(id, problem.slice(0, 500))
  })

  ipcMain.handle('catalogs:install', async (event, id: string): Promise<CatalogInstallResult> => {
    if (typeof id !== 'string' || !validId(id)) return { ok: false, errors: [CATALOG.unknown] }
    if (inProgress.has(id))
      return {
        ok: false,
        errors: [t('mainCatalogs.alreadyDownloading')]
      }
    const control = new AbortController()
    inProgress.set(id, control)
    try {
      const entry = (await listFromServer()).catalogs.find((v) => v.id === id)
      if (!entry)
        return {
          ok: false,
          errors: [t('mainCatalogs.noLongerAvailable')]
        }
      const data = await download(
        entry,
        (a) => {
          if (!event.sender.isDestroyed()) event.sender.send('catalogs:progress', a)
        },
        control.signal
      )
      return await install(fileFromCatalogZip(data), id)
    } catch (e) {
      if (control.signal.aborted) return { ok: false, cancelled: true, errors: [] }
      return { ok: false, errors: [message(e)], remedy: REMEDIES.retryServer }
    } finally {
      inProgress.delete(id)
    }
  })

  ipcMain.handle('catalogs:cancel', (_e, id: string): void => {
    inProgress.get(id)?.abort()
  })

  ipcMain.handle('catalogs:installFromArchive', async (): Promise<CatalogInstallResult> => {
    const f = window()
    if (!f) return { ok: false, cancelled: true, errors: [] }
    const choice = await dialog.showOpenDialog(f, {
      title: t('mainCatalogs.chooseArchive.title'),
      buttonLabel: t('mainCatalogs.chooseArchive.button'),
      properties: ['openFile'],
      filters: [
        { name: t('mainCatalogs.filters.zip'), extensions: ['zip'] },
        { name: t('mainCatalogs.filters.allFiles'), extensions: ['*'] }
      ]
    })
    if (choice.canceled || choice.filePaths.length === 0) return { ok: false, cancelled: true, errors: [] }
    try {
      const info = await stat(choice.filePaths[0])
      if (info.size > PACKAGE_LIMIT_BYTES) {
        return { ok: false, errors: [ZIP.archiveTooLarge(t('mainCatalogInspection.whatCatalog'), PACKAGE_LIMIT_BYTES / 1048576)], remedy: REMEDIES.fileChoice }
      }
      return await install(fileFromCatalogZip(await readFile(choice.filePaths[0])))
    } catch (e) {
      return { ok: false, errors: [message(e)], remedy: REMEDIES.downloadAgain }
    }
  })

  ipcMain.handle('catalogs:uninstall', async (_e, id: string): Promise<void> => {
    // Invalid folder names are accepted too: a catalog rejected for its name must still be removable.
    if (typeof id !== 'string' || !isSimpleFileName(id)) throw new Error(CATALOG.unknown)
    await closeStars()
    await rm(join(installedFolder(), id), { recursive: true, force: true })
    failures.delete(id)
    rechecks.delete(id)
    const disabled = await disabledItems()
    if (disabled.delete(id)) await writeDisabled(disabled)
  })

  ipcMain.handle('catalogs:enable', async (_e, id: string, active: boolean): Promise<void> => {
    if (typeof id !== 'string' || !validId(id)) throw new Error(CATALOG.unknown)
    const disabled = await disabledItems()
    if (active) disabled.delete(id)
    else disabled.add(id)
    await writeDisabled(disabled)
  })
}
