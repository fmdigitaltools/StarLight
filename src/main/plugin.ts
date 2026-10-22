import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, readdir, mkdir, rm, rename, stat } from 'node:fs/promises'
import { APP_VERSION } from '@shared/version'
import type {
  PluginList,
  PluginFaultResult,
  PluginInstallResult,
  PluginInfo,
  PluginNotLoaded
} from '@shared/plugin'
import { PLUGIN_CODE_CHANGED } from '@shared/plugin'
import {
  CODE_FILE,
  CODE_LIMIT_BYTES,
  validId,
  isSimpleFileName,
  checkCode,
  localizeManifest,
  type PluginManifest
} from '@core/plugin/manifest'
import { PLUGIN, REMEDIES } from '@shared/protectionTexts'
import { inspectPlugin, fileFromPluginZip, readPluginFolder, PLUGIN_ARCHIVE_LIMIT } from './pluginInspection'
import { ZIP } from '@shared/protectionTexts'
import { getLanguage, t } from '../shared/i18n/i18n'

/**
 * Plugins, main process side: where they live, how they are installed and
 * removed. Plugin code is never executed here: it is read as text and handed
 * to the interface, which runs it in an isolated worker inside a separate
 * process (see pluginSandbox.ts and core/plugin/isolation.ts).
 *
 * - Plugins installed from a folder or an archive live in
 *   `<user data>/plugins/<id>/`.
 * - The gallery bundled with the app lives in `resources/plugin/` (in the
 *   installed version, next to the executable among the resources). These
 *   plugins are not copied: they are enabled and disabled, and the list of
 *   enabled ones is in `<user data>/bundled-plugins.json`. A bundled plugin
 *   is therefore updated together with StarLight.
 * - Plugins installed from file that the user has disabled (for example
 *   after repeated errors) are listed in `disabled-plugins.json`.
 *
 * Every installation, whatever its origin, goes through the same checks
 * (pluginInspection.ts); the same checks are repeated at every startup on
 * the plugins already present, because a file may have been damaged or
 * copied into the folder by hand. A plugin that fails them is not loaded:
 * the interface shows it in the gallery with the reason and warns the user.
 * Only the expected files are copied to the final folder.
 */

function installedFolder(): string {
  return join(app.getPath('userData'), 'plugins')
}

function activeBundledFiles(): string {
  return join(app.getPath('userData'), 'bundled-plugins.json')
}

function disabledFiles(): string {
  return join(app.getPath('userData'), 'disabled-plugins.json')
}

/** Plugin failures in past sessions, used to suggest disabling them. */
function faultyFiles(): string {
  return join(app.getPath('userData'), 'broken-plugins.json')
}

async function readIdSet(file: string): Promise<Set<string>> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf-8'))
    return new Set(Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string' && validId(x)) : [])
  } catch {
    return new Set()
  }
}

async function writeTogether(file: string, ids: Set<string>): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(file, JSON.stringify([...ids].sort(), null, 2))
}

const enabledBundled = (): Promise<Set<string>> => readIdSet(activeBundledFiles())
const writeBundledEnabled = (ids: Set<string>): Promise<void> => writeTogether(activeBundledFiles(), ids)
const disabledItems = (): Promise<Set<string>> => readIdSet(disabledFiles())
const writeDisabled = (ids: Set<string>): Promise<void> => writeTogether(disabledFiles(), ids)

/**
 * Older versions "installed" gallery plugins by copying them among the
 * user's plugins. Such a copy is removed and the bundled plugin is enabled in
 * its place, so the up-to-date bundled version applies.
 */
async function migrateGalleryCopies(): Promise<void> {
  const gallery = new Set((await listIn(galleryFolder())).validItems.map((i) => i.manifest.id))
  const copies = (await listIn(installedFolder())).validItems.filter((i) => gallery.has(i.manifest.id))
  if (copies.length === 0) return
  const enabledIds = await enabledBundled()
  for (const c of copies) enabledIds.add(c.manifest.id)
  await writeBundledEnabled(enabledIds)
  for (const c of copies) await rm(join(installedFolder(), c.manifest.id), { recursive: true, force: true })
}

/**
 * Temporary folders left by an interrupted installation (the app closed
 * halfway through a copy): removed at startup.
 */
async function removeTemporary(): Promise<void> {
  try {
    for (const v of await readdir(installedFolder(), { withFileTypes: true })) {
      if (v.isDirectory() && /^\.[a-z0-9-]+-\d+$/.test(v.name)) {
        await rm(join(installedFolder(), v.name), { recursive: true, force: true })
      }
    }
  } catch {
    // Folder missing: nothing to remove.
  }
}

/** Plugins available in the app, disabled ones and those rejected by the checks. */
async function fullList(): Promise<PluginList> {
  const enabledIds = await enabledBundled()
  const disabled = await disabledItems()
  const gallery = await listIn(galleryFolder())
  const fromFile = await listIn(installedFolder())
  const bundled = gallery.validItems.filter((i) => enabledIds.has(i.manifest.id)).map((i) => ({ ...i, origin: 'bundled' as const }))
  const bundledIds = new Set(bundled.map((i) => i.manifest.id))
  const notLoaded: PluginNotLoaded[] = [
    // A damaged bundled plugin matters only if it was enabled: the others were not requested.
    ...gallery.rejected.filter((s) => enabledIds.has(s.id)).map((s) => ({ ...s, origin: 'bundled' as const, remedy: REMEDIES.reinstallStarLight })),
    ...fromFile.rejected.filter((s) => !bundledIds.has(s.id)).map((s) => ({ ...s, origin: 'file' as const }))
  ]
  const ownItems = fromFile.validItems.filter((i) => !bundledIds.has(i.manifest.id)).map((i) => ({ ...i, origin: 'file' as const }))
  return {
    loadedItems: [...bundled, ...ownItems.filter((i) => !disabled.has(i.manifest.id))],
    disabledItems: ownItems.filter((i) => disabled.has(i.manifest.id)),
    notLoaded
  }
}

function galleryFolder(): string {
  return app.isPackaged ? join(process.resourcesPath, 'plugin') : join(__dirname, '../../resources/plugin')
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function extension(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

function dataAddress(name: string, data: Buffer | undefined): string | null {
  if (!data) return null
  return 'data:' + (MIME[extension(name)] ?? 'application/octet-stream') + ';base64,' + data.toString('base64')
}

/** Writes the plugin to its folder, replacing any previous version. */
async function write(manifest: PluginManifest, toCopy: Map<string, Buffer>): Promise<boolean> {
  const root = installedFolder()
  await mkdir(root, { recursive: true })
  const final = join(root, manifest.id)
  const temporary = join(root, '.' + manifest.id + '-' + Date.now())
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function install(file: Map<string, Buffer>, fromArchive: boolean): Promise<PluginInstallResult> {
  const result = inspectPlugin(file, APP_VERSION, fromArchive)
  if (!result.ok) return result
  try {
    const updated = await write(result.manifest, result.toCopy)
    // Reinstalled from file: it is enabled again, and the old version's failures no longer count.
    const disabled = await disabledItems()
    if (disabled.delete(result.manifest.id)) await writeDisabled(disabled)
    return { ok: true, manifest: result.manifest, updated }
  } catch (e) {
    return { ok: false, errors: [PLUGIN.copyFailed(message(e))], remedy: REMEDIES.diskSpace, name: localizeManifest(result.manifest, getLanguage()).name }
  }
}

/**
 * Rechecks an existing plugin folder with the same checks as installation:
 * returns either the information to show or the reason for rejection.
 */
async function describe(
  folder: string,
  folderName: string
): Promise<{ ok: true; info: PluginInfo } | { ok: false; discarded: Omit<PluginNotLoaded, 'origin'> }> {
  const discard = (problems: string[], remedy: string, name?: string): { ok: false; discarded: Omit<PluginNotLoaded, 'origin'> } => ({
    ok: false,
    discarded: { id: folderName, name: name ?? folderName, problems, remedy }
  })
  let file: Map<string, Buffer>
  try {
    file = await readPluginFolder(folder)
  } catch (e) {
    return discard([PLUGIN.unreadableFolder(message(e))], REMEDIES.reinstallPlugin)
  }
  const result = inspectPlugin(file, APP_VERSION)
  if (!result.ok) {
    // For an installed plugin the remedy is reinstalling it, unless a newer StarLight is required.
    const remedy = result.remedy === REMEDIES.updateStarLight ? result.remedy : REMEDIES.reinstallPlugin + ' ' + REMEDIES.pluginAuthor
    return discard(result.errors, remedy, result.name)
  }
  const m = result.manifest
  if (m.id !== folderName) return discard([PLUGIN.differentFolder(folderName, m.id)], REMEDIES.reinstallPlugin, localizeManifest(m, getLanguage()).name)
  return {
    ok: true,
    info: {
      manifest: m,
      icon: dataAddress(m.icon, result.toCopy.get(m.icon)),
      previewBefore: dataAddress(m.previews.before, result.toCopy.get(m.previews.before)),
      previewAfter: dataAddress(m.previews.after, result.toCopy.get(m.previews.after))
    }
  }
}

async function listIn(root: string): Promise<{ validItems: PluginInfo[]; rejected: Omit<PluginNotLoaded, 'origin'>[] }> {
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      // Folders starting with a dot are temporary or hidden: they are not plugins.
      .filter((v) => v.isDirectory() && !v.name.startsWith('.'))
      .map((v) => v.name)
  } catch {
    return { validItems: [], rejected: [] }
  }
  const validItems: PluginInfo[] = []
  const rejected: Omit<PluginNotLoaded, 'origin'>[] = []
  for (const name of entries.sort()) {
    if (!validId(name)) {
      rejected.push({ id: name, name, problems: [PLUGIN.invalidId(name)], remedy: REMEDIES.reinstallPlugin })
      continue
    }
    try {
      const result = await describe(join(root, name), name)
      if (result.ok) validItems.push(result.info)
      else rejected.push(result.discarded)
    } catch (e) {
      // No plugin, however damaged, may stop the startup.
      rejected.push({ id: name, name, problems: [PLUGIN.unreadableFolder(message(e))], remedy: REMEDIES.reinstallPlugin })
    }
  }
  return { validItems, rejected }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/* ---- Failures during execution ---- */

/** Identifies this session: a plugin counts once per session. */
const SESSION = String(Date.now())

interface RecordedFailure {
  version: string
  sessions: string[]
}

/** The failure record by plugin id; empty if there is none yet. */
async function readFailures(): Promise<Record<string, RecordedFailure>> {
  try {
    const readResult: unknown = JSON.parse(await readFile(faultyFiles(), 'utf-8'))
    return typeof readResult === 'object' && readResult !== null && !Array.isArray(readResult)
      ? (readResult as Record<string, RecordedFailure>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Records that a plugin stopped in this session and returns in how many
 * sessions this happened to the same version. A new version starts from
 * zero: the author may have fixed the problem.
 */
async function registerFailure(id: string, version: string): Promise<PluginFaultResult> {
  const allItems = await readFailures()
  const before = allItems[id]
  const entry: RecordedFailure =
    before && before.version === version && Array.isArray(before.sessions) ? { version, sessions: before.sessions.slice(-20) } : { version, sessions: [] }
  if (!entry.sessions.includes(SESSION)) entry.sessions.push(SESSION)
  allItems[id] = entry
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(faultyFiles(), JSON.stringify(allItems, null, 2))
  } catch {
    // Failing to write the record does not change this session's notice.
  }
  return { sessions: entry.sessions.length }
}

async function forgetFailures(id: string): Promise<void> {
  try {
    const allItems = await readFailures()
    if (Object.hasOwn(allItems, id)) {
      delete allItems[id]
      await writeFile(faultyFiles(), JSON.stringify(allItems, null, 2))
    }
  } catch {
    // No record.
  }
}

export function registerPluginHandlers(window: () => BrowserWindow | null): void {
  const preparation = removeTemporary()
    .then(migrateGalleryCopies)
    .catch(() => undefined)

  ipcMain.handle('plugins:list', async (): Promise<PluginList> => {
    await preparation
    return fullList()
  })

  ipcMain.handle(
    'plugins:gallery',
    async (): Promise<PluginInfo[]> => (await listIn(galleryFolder())).validItems.map((i) => ({ ...i, origin: 'bundled' as const }))
  )

  ipcMain.handle('plugins:readCode', async (_e, id: string): Promise<string> => {
    if (typeof id !== 'string' || !validId(id)) throw new Error(PLUGIN.unknown)
    const read = async (path: string): Promise<string> => {
      const info = await stat(path)
      if (info.size > CODE_LIMIT_BYTES) throw new Error(PLUGIN_CODE_CHANGED)
      const code = await readFile(path, 'utf-8')
      // The file may have changed after startup: it is rechecked on every read.
      if (checkCode(code).length > 0) throw new Error(PLUGIN_CODE_CHANGED)
      return code
    }
    // An enabled bundled plugin is read from the gallery; the others from the user folder.
    if ((await enabledBundled()).has(id)) {
      try {
        return await read(join(galleryFolder(), id, CODE_FILE))
      } catch (e) {
        if (e instanceof Error && e.message === PLUGIN_CODE_CHANGED) throw e
        // No longer bundled in this version: try the user's plugins.
      }
    }
    return read(join(installedFolder(), id, CODE_FILE))
  })

  ipcMain.handle('plugins:enableBundled', async (_e, id: string, active: boolean): Promise<PluginInstallResult> => {
    if (typeof id !== 'string' || !validId(id)) return { ok: false, errors: [PLUGIN.unknown] }
    const enabledIds = await enabledBundled()
    if (!active) {
      enabledIds.delete(id)
      await writeBundledEnabled(enabledIds)
      const name = (await describe(join(galleryFolder(), id), id).catch(() => null))
      return name && name.ok
        ? { ok: true, manifest: name.info.manifest, updated: false }
        : { ok: false, errors: [], cancelled: true }
    }
    const result = await describe(join(galleryFolder(), id), id)
    if (!result.ok) {
      return { ok: false, errors: result.discarded.problems, remedy: REMEDIES.reinstallStarLight, name: result.discarded.name }
    }
    enabledIds.add(id)
    await writeBundledEnabled(enabledIds)
    await forgetFailures(id)
    return { ok: true, manifest: result.info.manifest, updated: false }
  })

  /** Disables or re-enables a plugin installed from file, without removing it from disk. */
  ipcMain.handle('plugins:enableFromFile', async (_e, id: string, active: boolean): Promise<void> => {
    if (typeof id !== 'string' || !validId(id)) throw new Error(PLUGIN.unknown)
    const disabled = await disabledItems()
    if (active) {
      disabled.delete(id)
      await forgetFailures(id)
    } else disabled.add(id)
    await writeDisabled(disabled)
  })

  ipcMain.handle('plugins:reportFailure', async (_e, id: string, version: string): Promise<PluginFaultResult> => {
    if (typeof id !== 'string' || !validId(id) || typeof version !== 'string' || version.length > 20) return { sessions: 1 }
    return registerFailure(id, version)
  })

  ipcMain.handle('plugins:installFromFolder', async (): Promise<PluginInstallResult> => {
    const f = window()
    if (!f) return { ok: false, cancelled: true, errors: [] }
    const choice = await dialog.showOpenDialog(f, {
      title: t('mainPlugin.chooseFolder.title'),
      buttonLabel: t('mainPlugin.installButton'),
      properties: ['openDirectory']
    })
    if (choice.canceled || choice.filePaths.length === 0) return { ok: false, cancelled: true, errors: [] }
    try {
      return await install(await readPluginFolder(choice.filePaths[0]), false)
    } catch (e) {
      return { ok: false, errors: [PLUGIN.unreadableFolder(message(e))], remedy: REMEDIES.fileChoice }
    }
  })

  ipcMain.handle('plugins:installFromArchive', async (): Promise<PluginInstallResult> => {
    const f = window()
    if (!f) return { ok: false, cancelled: true, errors: [] }
    const choice = await dialog.showOpenDialog(f, {
      title: t('mainPlugin.chooseArchive.title'),
      buttonLabel: t('mainPlugin.installButton'),
      properties: ['openFile'],
      filters: [
        { name: t('mainPlugin.filters.zip'), extensions: ['zip'] },
        { name: t('mainPlugin.filters.allFiles'), extensions: ['*'] }
      ]
    })
    if (choice.canceled || choice.filePaths.length === 0) return { ok: false, cancelled: true, errors: [] }
    try {
      const info = await stat(choice.filePaths[0])
      if (info.size > PLUGIN_ARCHIVE_LIMIT) {
        return { ok: false, errors: [ZIP.archiveTooLarge(t('mainZip.whatPlugin'), PLUGIN_ARCHIVE_LIMIT / 1048576)], remedy: REMEDIES.fileChoice }
      }
      return await install(fileFromPluginZip(await readFile(choice.filePaths[0])), true)
    } catch (e) {
      return { ok: false, errors: [message(e)], remedy: REMEDIES.downloadAgain }
    }
  })

  ipcMain.handle('plugins:uninstall', async (_e, id: string): Promise<void> => {
    // Invalid folder names are accepted too: a plugin rejected for its name must still be removable.
    if (typeof id !== 'string' || !isSimpleFileName(id)) throw new Error(PLUGIN.unknown)
    await rm(join(installedFolder(), id), { recursive: true, force: true })
    const disabled = await disabledItems()
    if (disabled.delete(id)) await writeDisabled(disabled)
    await forgetFailures(id)
  })
}
