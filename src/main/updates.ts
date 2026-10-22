/*
 * Automatic updates.
 *
 * StarLight asks a server (a Cloudflare Worker in front of an R2 bucket) for
 * the latest.yml file, which states the latest published version, where its
 * installer is and what is new. If the version is newer than the one in use
 * the interface offers it; the installer is downloaded in the background and
 * installed when StarLight closes, or immediately on request.
 *
 * The actual work is done by electron-updater, which also verifies the
 * fingerprint (sha512) of the downloaded file: a truncated or tampered
 * installer is never run.
 *
 * Installation is always silent. The StarLight installer has a custom window
 * (resources/installer) that must not appear during an update: in silent
 * mode it replaces the files and, when requested, reopens the app.
 *
 * The startup check is requested by the interface, which knows the settings
 * ("Check for updates at startup" and "Allow internet access"); this module
 * only remembers the skipped version.
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { autoUpdater, CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import {
  APP_VERSION,
  UPDATES_KEY,
  UPDATES_KEY_HEADER,
  UPDATES_URL,
  updatesConfigured
} from '@shared/version'
import {
  MAX_WHATS_NEW_VERSIONS,
  splitReleaseNotes,
  type UpdatesChannel,
  type InstallResult,
  type ReleaseNotes,
  type UpdateStatus
} from '@shared/updates'
import { serverAddressReachable, useFallbackAddress } from './server'
import { t } from '../shared/i18n/i18n'

/** What the module needs to know from the rest of the main process. */
export interface UpdatesContext {
  window: () => BrowserWindow | null
  /** True if closing now would lose unsaved work. */
  unsavedWork: () => boolean
  /** To be called before closing to install: the shutdown must no longer be stopped. */
  confirmExit: () => void
}

/*
 * Server address. During development a test server can be targeted with the
 * STARLIGHT_UPDATES_URL environment variable; in the installed app
 * only the constant in version.ts applies.
 */
async function serverAddress(): Promise<string | null> {
  const test = process.env['STARLIGHT_UPDATES_URL']
  if (!app.isPackaged && test) return test.endsWith('/') ? test : test + '/'
  return updatesConfigured() ? serverAddressReachable() : null
}

/** Channel file name on the server for each choice. */
const CHANNEL_FILE: Record<UpdatesChannel, string> = { stable: 'latest', test: 'beta' }

let state: UpdateStatus = {
  phase: 'idle',
  currentVersion: APP_VERSION,
  newVersion: null,
  whatsNew: null,
  releaseDate: null,
  percent: 0,
  downloadedItems: 0,
  total: 0,
  speed: 0,
  installImmediately: false,
  manual: false,
  error: null
}

let context: UpdatesContext | null = null
let prepared = false
/** The automatic check runs only once per session, even if the page reloads. */
let startupCheckDone = false
/** Used to cancel the download when the version is skipped. */
let cancelDownload: CancellationToken | null = null

function update(partial: Partial<UpdateStatus>): void {
  state = { ...state, ...partial }
  const f = context?.window()
  if (f && !f.isDestroyed()) f.webContents.send('updates:state', state)
}

/* ---- Skipped version, remembered in a file of its own ---- */

function memoryPath(): string {
  return join(app.getPath('userData'), 'updates.json')
}

async function skippedVersion(): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(memoryPath(), 'utf-8')) as Record<string, unknown>
    return typeof data['skippedVersion'] === 'string' ? data['skippedVersion'] : null
  } catch {
    return null
  }
}

async function rememberSkippedVersion(version: string | null): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(memoryPath(), JSON.stringify({ skippedVersion: version }, null, 2), 'utf-8')
}

/* ---- Readable error messages ---- */

function explainError(e: unknown, during: 'checking' | 'downloading'): string {
  const text = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: string } | null)?.code ?? ''
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || /\b404\b/.test(text)) {
    return t('mainUpdates.errors.nothingPublished')
  }
  if (/\b(401|403)\b/.test(text)) {
    return t('mainUpdates.errors.refused')
  }
  if (/sha512|checksum/i.test(text)) {
    return t('mainUpdates.errors.checksum')
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_|socket hang up|timeout/i.test(text)) {
    return t('mainUpdates.errors.noResponse')
  }
  return during === 'checking' ? t('mainUpdates.errors.checkFailed') : t('mainUpdates.errors.downloadFailed')
}

/** Plain text of one language section: HTML tags are stripped, the interface shows plain text only. */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Release notes, one text per language (see splitReleaseNotes in
 * src/shared/updates.ts). They may arrive as text, as HTML or as a list per
 * version; of a list only the latest MAX_WHATS_NEW_VERSIONS versions are kept.
 */
function whatsNewNotes(info: UpdateInfo): ReleaseNotes | null {
  const rawValues = info.releaseNotes
  if (rawValues == null) return null
  const notes: ReleaseNotes = {}
  const add = (raw: string, version?: string): void => {
    for (const [language, section] of Object.entries(splitReleaseNotes(raw))) {
      const text = section === undefined ? '' : plainText(section)
      if (text === '') continue
      const heading = version ? t('mainUpdates.versionHeading', { version }, language) + '\n' : ''
      const before = notes[language]
      notes[language] = (before ? before + '\n\n' : '') + heading + text
    }
  }
  if (typeof rawValues === 'string') add(rawValues)
  else for (const n of rawValues.slice(0, MAX_WHATS_NEW_VERSIONS)) if (n.note) add(n.note, n.version)
  return Object.keys(notes).length > 0 ? notes : null
}

/* ---- electron-updater setup ---- */

function prepare(address: string, channel: UpdatesChannel): void {
  /*
   * electron-updater looks for its configuration in an app-update.yml file
   * next to the app, which electron-builder writes only when it finds a
   * "publish" section. Here it is written explicitly to the data folder: it
   * works without that section, and the folder where installers are
   * downloaded has a fixed name.
   */
  if (!prepared) {
    prepared = true
    autoUpdater.logger = {
      info: (m: unknown) => console.log('[StarLight] updates: ' + String(m)),
      warn: (m: unknown) => console.warn('[StarLight] updates: ' + String(m)),
      error: (m: unknown) => console.error('[StarLight] updates: ' + String(m)),
      debug: () => undefined
    }
    autoUpdater.autoDownload = false
    // When running from source nothing is ever installed, neither on quit nor on request.
    autoUpdater.autoInstallOnAppQuit = app.isPackaged
    autoUpdater.disableWebInstaller = true
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true

    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      update({
        phase: 'downloading',
        percent: Math.max(0, Math.min(100, p.percent)),
        downloadedItems: p.transferred,
        total: p.total,
        speed: p.bytesPerSecond
      })
    })
  }

  const configuration = join(app.getPath('userData'), 'app-update.yml')
  void writeFile(
    configuration,
    'provider: generic\nurl: ' + address + '\nupdaterCacheDirName: starlight-updater\n',
    'utf-8'
  ).catch(() => undefined)
  autoUpdater.updateConfigPath = configuration

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: address,
    // A Worker in front of R2 serves one byte range at a time, not multiple
    // ranges in the same request.
    useMultipleRangeRequest: false
  })
  autoUpdater.requestHeaders =
    UPDATES_KEY !== '' ? { [UPDATES_KEY_HEADER]: UPDATES_KEY } : null

  autoUpdater.channel = CHANNEL_FILE[channel]
  autoUpdater.allowPrerelease = channel === 'test'
  // Switching channel must never roll back to an older version.
  autoUpdater.allowDowngrade = false
}

/* ---- Operations ---- */

/**
 * Asks the server whether there is a new version. `manual` is true when the
 * user asks from the menu: in that case a previously skipped version is
 * offered too.
 */
async function check(manual: boolean, channel: UpdatesChannel): Promise<UpdateStatus> {
  // A download already started or finished is not restarted: its progress is shown.
  if (state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'checking') {
    if (manual) update({ manual: true })
    return state
  }
  if (!manual) {
    if (startupCheckDone) return state
    startupCheckDone = true
  }

  const address = await serverAddress()
  if (address === null) {
    update({ phase: 'notConfigured', manual, error: null })
    return state
  }

  update({ phase: 'checking', manual, error: null })
  try {
    const missingChannel = (e: unknown): boolean =>
      (e as { code?: string }).code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    const ask = async (from: string): Promise<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>> => {
      prepare(from, channel)
      try {
        return await autoUpdater.checkForUpdates()
      } catch (e) {
        // Asking for test versions when there are none falls back to the
        // stable ones; asking for stable ones before the first stable release
        // simply finds nothing new.
        if (!missingChannel(e)) throw e
        if (channel !== 'test') return null
        prepare(from, 'stable')
        try {
          return await autoUpdater.checkForUpdates()
        } catch (e2) {
          if (!missingChannel(e2)) throw e2
          return null
        }
      }
    }
    let result
    try {
      result = await ask(address)
    } catch (e) {
      // The domain's hosting may answer with a web page of its own instead of
      // forwarding to the Worker: one more try on the Worker address.
      if (address !== UPDATES_URL || !useFallbackAddress(e instanceof Error ? e.message : String(e))) throw e
      result = await ask(await serverAddressReachable())
    }
    const info = result?.updateInfo
    if (!result || !info || !result.isUpdateAvailable) {
      update({ phase: 'upToDate', newVersion: null, whatsNew: null, releaseDate: null })
      return state
    }
    if (!manual && (await skippedVersion()) === info.version) {
      update({ phase: 'upToDate', newVersion: null, whatsNew: null, releaseDate: null })
      return state
    }
    update({
      phase: 'available',
      newVersion: info.version,
      whatsNew: whatsNewNotes(info),
      releaseDate: info.releaseDate ?? null,
      percent: 0,
      downloadedItems: 0,
      total: 0,
      speed: 0,
      installImmediately: false
    })
  } catch (e) {
    update({ phase: 'error', error: explainError(e, 'checking') })
  }
  return state
}

/**
 * Downloads the installer in the background. With `installImmediately` the
 * interface asks to install once the download finishes; otherwise the
 * installer stays ready and is installed when StarLight closes.
 */
async function download(installImmediately: boolean): Promise<void> {
  if (state.phase === 'downloading' || state.phase === 'ready') {
    update({ installImmediately: installImmediately || state.installImmediately })
    return
  }
  if (state.phase !== 'available') return
  // A version skipped earlier and then chosen from the menu installs on quit again.
  autoUpdater.autoInstallOnAppQuit = app.isPackaged
  update({ phase: 'downloading', installImmediately, percent: 0, downloadedItems: 0, total: 0, speed: 0 })
  const token = new CancellationToken()
  cancelDownload = token
  try {
    await autoUpdater.downloadUpdate(token)
    if (token.cancelled) return
    update({ phase: 'ready', percent: 100 })
  } catch (e) {
    // A download cancelled on purpose (skipped version) is not an error.
    if (token.cancelled) return
    update({ phase: 'error', error: explainError(e, 'downloading') })
  } finally {
    if (cancelDownload === token) cancelDownload = null
  }
}

/** Installs immediately and reopens StarLight, if no work would be lost. */
function installNow(): InstallResult {
  if (state.phase !== 'ready') return { ok: false, reason: 'notReady' }
  if (context?.unsavedWork()) return { ok: false, reason: 'unsavedWork' }
  if (!app.isPackaged) {
    console.log('[StarLight] updates: simulated installation (running from source), nothing is installed')
    return { ok: false, reason: 'development' }
  }
  context?.confirmExit()
  // Silent (no installer window) and reopening the app.
  autoUpdater.quitAndInstall(true, true)
  return { ok: true }
}

/** Stops offering this version in automatic checks. */
async function skip(version: string): Promise<void> {
  cancelDownload?.cancel()
  cancelDownload = null
  // An installer already downloaded must not be installed on quit.
  autoUpdater.autoInstallOnAppQuit = false
  await rememberSkippedVersion(version)
  update({ phase: 'upToDate', installImmediately: false, percent: 0 })
}

export function registerUpdates(c: UpdatesContext): void {
  context = c
  ipcMain.handle('updates:state', (): UpdateStatus => state)
  ipcMain.handle(
    'updates:check',
    (_e, manual: boolean, channel: UpdatesChannel): Promise<UpdateStatus> =>
      check(manual === true, channel === 'test' ? 'test' : 'stable')
  )
  ipcMain.handle('updates:download', (_e, installImmediately: boolean): Promise<void> =>
    download(installImmediately === true)
  )
  ipcMain.handle('updates:installNow', (): InstallResult => installNow())
  ipcMain.handle('updates:skip', (_e, version: string): Promise<void> => skip(String(version)))
}
