import { app, BrowserWindow, shell, ipcMain, dialog, nativeTheme, Menu, session, type IpcMainInvokeEvent } from 'electron'
import { join, basename, dirname, resolve } from 'node:path'
import { readFile, writeFile, readdir, stat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { totalmem, freemem, cpus } from 'node:os'
import { WINDOW_TITLE, APP_VERSION, APP_STAGE, APP_CODENAME } from '@shared/version'
import type { RuntimeVersions, FileHandleInfo } from '@shared/types'
import { gaiaStars, type GaiaCatalogStar } from './gaiaCatalog'
import { GaiaCatalogError, type GaiaReply } from '../shared/gaiaCatalog'
import { Watcher } from './watcher'
import { registerPluginHandlers } from './plugin'
import { registerCatalogHandlers } from './catalogs'
import { registerPluginSandbox } from './pluginSandbox'
import { registerCalibrationHandlers } from './calibration'
import { openSplashWindow, accompanyStartup, startupInProgress } from './splash'
import { registerUpdates } from './updates'
import { keepRecoveryCopy, registerRecovery } from './recovery'
import { registerBatchHandlers } from './batch'
import { startLog, writeLog } from './log'
import { guardIpc } from './ipcGuard'
import { isLanguage, languageForLocale, setLanguage, t } from '../shared/i18n/i18n'
import {
  prepareGraphicsAtStartup,
  registerPerformance,
  followComputePriority,
  clearWindowMemoryIfRequested
} from './performance'
import type { WatcherEvent, WatcherStartResult } from '@shared/watcher'
import { RAW_EXTENSIONS, hasRawExtension } from '@core/raw/rawFormats'

/*
 * Hardware acceleration.
 *
 * The graphics card (high performance or power saving) and acceleration are
 * chosen in Settings, Performance tab, and take effect from startup: they
 * must be read here, before everything else (see performance.ts).
 */
prepareGraphicsAtStartup()
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')

/*
 * Memory shared between threads.
 *
 * Decoded frames weigh tens of megabytes, and during stacking every worker
 * needs all of them at the same time. With shared memory they stay in a
 * single place: without it each worker would require its own copy, and
 * sixteen copies of a hundred-frame session would not fit in memory. In a
 * browser this feature requires cross-origin isolation headers, which make
 * no sense here because the only pages loaded are the app's own.
 */
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

/*
 * Memory.
 *
 * By default the JavaScript engine limits itself to just over 4 GB, a
 * threshold that stacking hundreds of frames easily exceeds. The limit is
 * raised in proportion to the memory actually installed, always leaving a
 * reserve for the operating system.
 */
const totalRamMB = Math.floor(totalmem() / 1048576)
const heapLimitMB = Math.max(2048, Math.min(32768, Math.floor(totalRamMB * 0.5)))
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=' + heapLimitMB)

/**
 * Astronomical image extensions: FITS (including tile-compressed .fz files
 * and whole-file gzip) and XISF. The reader then recognizes the content from
 * its signature (src/core/fits/reader.ts).
 */
const FITS_EXTENSIONS = ['.fit', '.fits', '.fts', '.fz', '.fit.gz', '.fits.gz', '.fts.gz', '.xisf']

/**
 * TIFF and PNG open when chosen individually (file dialog, double click,
 * "Open with"), but are not picked up when importing a folder: capture
 * folders often contain previews and thumbnails in these formats, which
 * would end up mixed with the frames.
 */
const IMAGE_FILE_EXTENSIONS = ['.tif', '.tiff', '.png']

function isPlainImage(name: string): boolean {
  const lower = name.toLowerCase()
  return IMAGE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

let mainWindow: BrowserWindow | null = null

function isFitsName(name: string): boolean {
  const lower = name.toLowerCase()
  // Camera RAW files too (src/core/raw), which the installer does not
  // associate with StarLight: they stay with the user's photo software.
  return FITS_EXTENSIONS.some((ext) => lower.endsWith(ext)) || hasRawExtension(name)
}

/** Project file extension (the file lives inside the project folder). */
const PROJECT_EXTENSION = '.slight'

/**
 * Files opened by the operating system (double click, "Open with", command
 * line): the FITS files to import and, at most, one project to open.
 */
interface OpenedFiles {
  fits: FileHandleInfo[]
  project: string | null
}

/**
 * Splits the launch arguments into FITS files and the project. Relative
 * paths are resolved against the folder the launch started from; those that
 * do not lead to an existing file are simply ignored.
 */
async function fileFromArguments(args: string[], folder: string): Promise<OpenedFiles> {
  const result: OpenedFiles = { fits: [], project: null }
  for (const a of args) {
    if (a === '' || a.startsWith('-')) continue
    const path = resolve(folder, a)
    try {
      if (isFitsName(a) || isPlainImage(a)) {
        result.fits.push(await describeFile(path))
      } else if (result.project === null && a.toLowerCase().endsWith(PROJECT_EXTENSION)) {
        if ((await stat(path)).isFile()) result.project = path
      }
    } catch {
      // An invalid path is simply ignored.
    }
  }
  return result
}

/*
 * Delivers to the interface the files opened while StarLight is already
 * running. Until the interface starts listening (startup, reloaded page) the
 * files wait here instead of being lost.
 */
let listeningInterface = false
const pendingFile: OpenedFiles[] = []

function deliverOpenedFiles(): void {
  if (!listeningInterface || !mainWindow || mainWindow.isDestroyed()) return
  while (pendingFile.length > 0) {
    mainWindow.webContents.send('app:openedFiles', pendingFile.shift())
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: WINDOW_TITLE,
    backgroundColor: '#070910',
    // Window icon. The installed app already has it embedded in the
    // executable; when running from source the executable is Electron's.
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    // On Windows the window controls are overlaid on the custom title bar,
    // keeping the native behavior.
    titleBarOverlay: {
      color: '#070910',
      symbolColor: '#8FA2C4',
      // As tall as the menu bar (--sl-menubar-h in theme.css).
      height: 32
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Processing uses buffers of several hundred MB.
      backgroundThrottling: false
    }
  })

  // The window is created hidden: it is shown once the interface has drawn
  // its first content, and meanwhile the splash window is up (see splash.ts).
  accompanyStartup(mainWindow, () => void captureIfRequested())
  followComputePriority(mainWindow.webContents)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  /*
   * Closing with the window's X: if there is unsaved work, instead of
   * closing, the interface is asked to show the confirmation. As soon as it
   * receives the request the interface replies (and from then on the user
   * decides, with no time limit). If it does not reply within a few seconds
   * it is frozen: the window closes anyway and the recovery copy stays, to be
   * offered at the next startup.
   */
  mainWindow.on('close', (e) => {
    if (quitConfirmed || !unsavedWork || !mainWindow) return
    e.preventDefault()
    mainWindow.webContents.send('app:closeRequested')
    if (closeResponseWait !== null) return
    closeResponseWait = setTimeout(() => {
      closeResponseWait = null
      keepRecoveryCopy()
      quitConfirmed = true
      mainWindow?.destroy()
      app.quit()
    }, CLOSE_RESPONSE_WAIT)
  })
  // A reloaded or crashed page no longer has work to save.
  mainWindow.webContents.on('did-start-loading', () => {
    unsavedWork = false
    // The new page will listen for opened files again once it is ready.
    listeningInterface = false
  })
  mainWindow.webContents.on('render-process-gone', () => {
    unsavedWork = false
  })

  // External links open in the browser, not inside the app, and only if they
  // are secure web addresses.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window never leaves its page: a file dragged onto it would replace
  // the page, losing the work and giving that file the interface's
  // permissions.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Development check capture. With STARLIGHT_CAPTURE set to a path, the
 * window is captured as soon as it is ready: used to check the look of the
 * interface without having to describe it in words.
 */
async function captureIfRequested(): Promise<void> {
  // Only when running from source: these commands do not exist in the installed app.
  if (app.isPackaged) return
  const destination = process.env['STARLIGHT_CAPTURE']
  if (!destination || !mainWindow) return

  const wait = Number(process.env['STARLIGHT_CAPTURE_WAIT'] ?? 2500)
  await new Promise((r) => setTimeout(r, wait))
  if (!mainWindow) return

  // Allows triggering a command before the capture, to take a screenshot of
  // the interface once processing has finished.
  const toPress = process.env['STARLIGHT_PRESS']
  if (toPress) {
    await mainWindow.webContents.executeJavaScript(
      'document.querySelector(' + JSON.stringify('[data-guide=' + JSON.stringify(toPress) + ']') + ')?.click()'
    )
    const waitAfter = Number(process.env['STARLIGHT_WAIT_AFTER'] ?? 8000)
    await new Promise((r) => setTimeout(r, waitAfter))
    if (!mainWindow) return
  }

  // Allows querying the page during checks.
  const inspection = process.env['STARLIGHT_INSPECT']
  if (inspection) {
    const result = await mainWindow.webContents.executeJavaScript(inspection)
    console.log('[StarLight] inspection: ' + JSON.stringify(result))
  }

  /*
   * Capture sequence: takes a screenshot of the interface, triggers the
   * given command and repeats. Used to examine every step of a guided
   * procedure in a single run.
   */
  const sequenceSteps = Number(process.env['STARLIGHT_SEQUENCE'] ?? 0)
  if (sequenceSteps > 0) {
    const command = process.env['STARLIGHT_SEQUENCE_PRESS'] ?? 'tour-next'
    for (let i = 1; i <= sequenceSteps; i++) {
      if (!mainWindow) return
      const shot = await mainWindow.webContents.capturePage()
      const name = destination.replace(/.png$/, '-' + String(i).padStart(2, '0') + '.png')
      await writeFile(name, shot.toPNG())
      console.log('[StarLight] capture ' + i + ' saved to ' + name)
      await mainWindow.webContents.executeJavaScript(
        'document.querySelector(' + JSON.stringify('[data-guide=' + JSON.stringify(command) + ']') + ')?.click()'
      )
      await new Promise((r) => setTimeout(r, 700))
    }
    if (process.env['STARLIGHT_CAPTURE_QUIT'] === '1') app.quit()
    return
  }

  const image = await mainWindow.webContents.capturePage()
  await writeFile(destination, image.toPNG())
  console.log('[StarLight] capture saved to ' + destination)

  if (process.env['STARLIGHT_CAPTURE_QUIT'] === '1') app.quit()
}

/** Path of the preferences file in the user's data folder. */
function prefsPath(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

/**
 * True if the request comes from the main window. The channels that read and
 * write arbitrary files answer only to it: the plugin sandbox and splash
 * windows must not be able to use them.
 */
function fromMainWindow(e: IpcMainInvokeEvent): boolean {
  return mainWindow !== null && e.sender === mainWindow.webContents
}

/** Rejects a request that does not come from the main window. */
function onlyMainWindow(e: IpcMainInvokeEvent): void {
  if (!fromMainWindow(e)) throw new Error('request not allowed')
}

function registerHandlers(): void {
  ipcMain.handle('app:versions', (): RuntimeVersions => {
    return {
      app: APP_VERSION,
      stage: APP_STAGE,
      codename: APP_CODENAME,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch
    }
  })

  ipcMain.handle('app:initialStep', (): string | null => {
    return process.env['STARLIGHT_STEP'] ?? null
  })

  /*
   * Files given at launch: they allow opening a FITS file or a project by
   * double-clicking in the operating system or passing them on the command
   * line.
   */
  ipcMain.handle('app:initialFiles', async (): Promise<OpenedFiles> => {
    return fileFromArguments(process.argv.slice(1), process.cwd())
  })

  // The interface is ready to receive files opened by a second launch.
  ipcMain.on('app:listeningOpenedFiles', () => {
    listeningInterface = true
    deliverOpenedFiles()
  })

  ipcMain.handle('app:systemInfo', (): Record<string, number | string> => {
    return {
      totalRam: totalmem(),
      freeRam: freemem(),
      cpuCores: cpus().length,
      cpuModel: cpus()[0]?.model ?? t('mainIndex.notAvailable'),
      heapLimitMB
    }
  })

  ipcMain.handle('app:graphicsInfo', async (): Promise<Record<string, unknown>> => {
    const info = (await app.getGPUInfo('basic')) as Record<string, unknown>
    const state = app.getGPUFeatureStatus() as unknown as Record<string, string>
    return { info, state }
  })

  // Built on every use, so the labels follow the current language.
  const imageFilters = (): Electron.FileFilter[] => [
    {
      name: t('mainIndex.filters.allImages'),
      extensions: ['fit', 'fits', 'fts', 'fz', 'gz', 'xisf', 'tif', 'tiff', 'png', ...RAW_EXTENSIONS]
    },
    { name: t('mainIndex.filters.fits'), extensions: ['fit', 'fits', 'fts', 'fz', 'gz'] },
    { name: t('mainIndex.filters.xisf'), extensions: ['xisf'] },
    { name: t('mainIndex.filters.tiffPng'), extensions: ['tif', 'tiff', 'png'] },
    { name: t('mainIndex.filters.raw'), extensions: [...RAW_EXTENSIONS] },
    { name: t('mainIndex.filters.allFiles'), extensions: ['*'] }
  ]

  ipcMain.handle('dialog:openFile', async (): Promise<FileHandleInfo[]> => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('mainIndex.importFrames.title'),
      buttonLabel: t('mainIndex.importFrames.button'),
      properties: ['openFile', 'multiSelections'],
      filters: imageFilters()
    })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map(describeFile))
  })

  /*
   * Frames from the telescope folder (Settings, Telescope tab): the file
   * dialog opens there. A network path with the telescope switched off can
   * make Windows wait for tens of seconds, so the folder is first checked,
   * with a time limit, to see whether it responds.
   */
  ipcMain.handle(
    'dialog:openTelescopeFile',
    async (_e, folder: string): Promise<{ reachable: boolean; file: FileHandleInfo[] }> => {
      if (!mainWindow) return { reachable: true, file: [] }
      const responds = await Promise.race([
        stat(folder).then((s) => s.isDirectory(), () => false),
        new Promise<boolean>((done) => setTimeout(() => done(false), 5000))
      ])
      if (!responds) return { reachable: false, file: [] }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: t('mainIndex.importFromTelescope.title'),
        buttonLabel: t('mainIndex.importFrames.button'),
        defaultPath: folder,
        properties: ['openFile', 'multiSelections'],
        filters: imageFilters()
      })
      if (result.canceled) return { reachable: true, file: [] }
      return { reachable: true, file: await Promise.all(result.filePaths.map(describeFile)) }
    }
  )

  // null if the choice was cancelled, a list (possibly empty) if a folder was chosen.
  ipcMain.handle('dialog:openFolder', async (): Promise<FileHandleInfo[] | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('mainIndex.importFolder.title'),
      buttonLabel: t('mainIndex.importFolder.button'),
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return listFitsInDirectory(result.filePaths[0])
  })

  ipcMain.handle('fs:listFolder', async (e, dir: string): Promise<FileHandleInfo[]> => {
    onlyMainWindow(e)
    return listFitsInDirectory(dir)
  })

  ipcMain.handle('fs:readFile', async (e, path: string): Promise<ArrayBuffer> => {
    onlyMainWindow(e)
    const buffer = await readFile(path)
    // A file that is not small already has its own ArrayBuffer: return it
    // without a second copy (it makes a difference with a 120 MB RAW file).
    if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
      return buffer.buffer as ArrayBuffer
    }
    // Small files live in a pool shared by several reads: copy them.
    const copy = new ArrayBuffer(buffer.byteLength)
    new Uint8Array(copy).set(buffer)
    return copy
  })

  /*
   * Reads only the head of the file. Importing a folder with hundreds of
   * frames needs only the metadata: reading every file in full would move
   * several gigabytes from disk for no reason.
   */
  ipcMain.handle('fs:readHeader', async (e, path: string, byte: number): Promise<ArrayBuffer> => {
    onlyMainWindow(e)
    // A file header never exceeds a few tens of megabytes.
    byte = Math.max(0, Math.min(Number(byte) || 0, 64 * 1024 * 1024))
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(byte)
      const { bytesRead } = await handle.read(buffer, 0, byte, 0)
      const copy = new ArrayBuffer(bytesRead)
      new Uint8Array(copy).set(buffer.subarray(0, bytesRead))
      return copy
    } finally {
      await handle.close()
    }
  })

  ipcMain.handle('fs:fileInfo', async (e, path: string): Promise<FileHandleInfo> => {
    onlyMainWindow(e)
    return describeFile(path)
  })
}

/** Collects the name and size of a file. */
async function describeFile(path: string): Promise<FileHandleInfo> {
  const info = await stat(path)
  return {
    path,
    // basename handles both separators: on Windows paths use "\".
    fileName: basename(path),
    sizeBytes: info.size
  }
}

/** Lists the FITS files in a folder, in alphabetical order. */
async function listFitsInDirectory(dir: string): Promise<FileHandleInfo[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && isFitsName(e.name))
    .map((e) => join(dir, e.name))
    .sort()
  return Promise.all(files.map(describeFile))
}

function registerSaveHandlers(): void {
  ipcMain.handle(
    'dialog:saveImage',
    async (
      _e,
      suggestedName: string,
      format: string,
      folder: string | null = null
    ): Promise<string | null> => {
      if (!mainWindow) return null
      const filters: Record<string, { name: string; extensions: string[] }> = {
        png: { name: t('mainIndex.saveFilters.png'), extensions: ['png'] },
        jpeg: { name: t('mainIndex.saveFilters.jpeg'), extensions: ['jpg', 'jpeg'] },
        webp: { name: t('mainIndex.saveFilters.webp'), extensions: ['webp'] },
        tiff: { name: t('mainIndex.saveFilters.tiff'), extensions: ['tif', 'tiff'] },
        bmp: { name: t('mainIndex.saveFilters.bmp'), extensions: ['bmp'] },
        fits: { name: t('mainIndex.saveFilters.fits'), extensions: ['fit', 'fits'] }
      }
      const filter = filters[format] ?? filters.png
      // The dialog starts in the exports folder, created here on first use.
      // If it cannot be created (network drive missing, permissions) it
      // starts from the closest existing folder.
      let defaultPath = suggestedName
      if (folder) {
        try {
          await mkdir(folder, { recursive: true })
        } catch {
          // Fall back to the closest existing folder, below.
        }
        defaultPath = join(await firstExisting(folder), suggestedName)
      }
      const result = await dialog.showSaveDialog(mainWindow, {
        title: t('mainIndex.exportImage.title'),
        buttonLabel: t('mainIndex.exportImage.button'),
        defaultPath,
        filters: [filter, { name: t('mainIndex.filters.allFiles'), extensions: ['*'] }]
      })
      return result.canceled || !result.filePath ? null : result.filePath
    }
  )

  ipcMain.handle('fs:writeFile', async (e, path: string, data: ArrayBuffer): Promise<void> => {
    onlyMainWindow(e)
    await writeFile(path, Buffer.from(data))
  })

  ipcMain.handle('shell:showInFolder', (_e, path: string): void => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle(
    'gaia:stars',
    // A failure travels as a code (GaiaReply): the renderer picks the text
    // for the feature that asked and for the interface language.
    async (_e, ra: number, dec: number, radius: number, mag: number): Promise<GaiaReply<GaiaCatalogStar>> => {
      try {
        return { ok: true, stars: await gaiaStars(ra, dec, radius, mag) }
      } catch (e) {
        if (e instanceof GaiaCatalogError) return { ok: false, failure: e.failure }
        throw e
      }
    }
  )

  ipcMain.handle('prefs:read', (): Promise<Record<string, unknown>> => enqueuePreferences(readPreferences))

  // Interface language chosen in the settings (the renderer resolves `auto`).
  ipcMain.handle('app:language', (_e, language: unknown): void => {
    if (isLanguage(language)) setLanguage(language)
  })

  ipcMain.handle('prefs:write', (_e, prefs: Record<string, unknown>): Promise<void> =>
    enqueuePreferences(() => writePreferences(prefs))
  )
}

/*
 * Preferences file. Reads and writes are queued, one at a time, and every
 * write goes to a temporary file that then replaces the old one: a reader
 * always finds the whole file, old or new. Rewriting in place would let a
 * concurrent read (several start at startup) find it empty or half-written:
 * that would look like a first run, with the quick tour, and the following
 * write could wipe all the other preferences.
 */
let preferencesQueue: Promise<unknown> = Promise.resolve()

function enqueuePreferences<T>(operation: () => Promise<T>): Promise<T> {
  const turn = preferencesQueue.then(operation, operation)
  preferencesQueue = turn.catch(() => undefined)
  return turn
}

async function readPreferences(): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(prefsPath(), 'utf-8')
  } catch {
    // First run: no preferences file yet.
    return {}
  }
  try {
    const prefs = JSON.parse(text) as unknown
    if (prefs !== null && typeof prefs === 'object' && !Array.isArray(prefs)) return prefs as Record<string, unknown>
  } catch {
    // Damaged, for example edited by hand: logged below.
  }
  writeLog('warning', 'main', 'The preferences file is not readable, so StarLight uses the default values.')
  return {}
}

async function writePreferences(prefs: Record<string, unknown>): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const destination = prefsPath()
  const temporary = destination + '.tmp'
  await writeFile(temporary, JSON.stringify(prefs, null, 2), 'utf-8')
  // An antivirus or Windows indexing can keep the file open for a moment:
  // retry a few times before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, destination)
      return
    } catch (e) {
      if (attempt >= 5) {
        await unlink(temporary).catch(() => undefined)
        throw e
      }
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
    }
  }
}

/*
 * Watched folder (live session). Only one at a time: starting a new one stops
 * the previous one. It stops by itself if the page is reloaded or closed, so
 * nothing is left watching for nothing.
 */
let watcherActive: Watcher | null = null
/** Pages already hooked to the automatic stop. */
const attachedSenders = new WeakSet<Electron.WebContents>()

function stopWatcher(): void {
  watcherActive?.stop()
  watcherActive = null
}

function registerWatcherHandlers(): void {
  ipcMain.handle(
    'watcher:chooseFolder',
    async (_e, defaultFolder: string | null): Promise<string | null> => {
      if (!mainWindow) return null
      const result = await dialog.showOpenDialog(mainWindow, {
        title: t('mainIndex.watchFolder.title'),
        buttonLabel: t('mainIndex.watchFolder.button'),
        defaultPath: defaultFolder ?? undefined,
        properties: ['openDirectory']
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  )

  ipcMain.handle(
    'watcher:start',
    async (e, folder: string, includeExisting: boolean): Promise<WatcherStartResult> => {
      stopWatcher()
      const sender = e.sender
      const watcher = new Watcher(
        folder,
        (event: WatcherEvent) => {
          if (!sender.isDestroyed()) sender.send('watcher:event', event)
        },
        { includeExisting }
      )
      const result = await watcher.start()
      if (!result.ok) return result
      watcherActive = watcher
      if (!attachedSenders.has(sender)) {
        attachedSenders.add(sender)
        sender.on('did-start-loading', stopWatcher)
        sender.on('destroyed', stopWatcher)
      }
      return result
    }
  )

  ipcMain.handle('watcher:stop', (): void => {
    stopWatcher()
  })
}

/*
 * Work folder. StarLight gathers projects, exports and live sessions in a
 * work folder, with one subfolder for each. Which folder to use is decided
 * by the interface (see `renderer/src/settings.ts`); only the default value,
 * Documents\StarLight, lives here. Subfolders are created only when needed.
 *
 * Projects. A project is a folder with the `project.slight` file and the
 * saved images, created at the first save.
 */
function defaultWorkFolder(): string {
  return join(app.getPath('documents'), 'StarLight')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The given folder if it exists, otherwise the closest existing parent;
 * failing that, Documents. File dialogs thus start from a sensible place
 * even before the work subfolders exist.
 */
async function firstExisting(path: string | null | undefined): Promise<string> {
  let p = path ? path.trim() : ''
  while (p !== '') {
    if (await exists(p)) return p
    const su = dirname(p)
    if (su === p) break
    p = su
  }
  return app.getPath('documents')
}

/** A file name inside the project folder, never a path elsewhere. */
function simpleName(name: string): boolean {
  return name !== '' && name === basename(name) && name !== '.' && name !== '..'
}

function registerProjectHandlers(): void {
  ipcMain.handle('app:defaultWorkFolder', (): string => defaultWorkFolder())

  ipcMain.handle(
    'dialog:chooseFolder',
    async (_e, title: string, current: string | null): Promise<string | null> => {
      if (!mainWindow) return null
      const result = await dialog.showOpenDialog(mainWindow, {
        title: title,
        buttonLabel: t('mainIndex.chooseThisFolder'),
        defaultPath: await firstExisting(current),
        properties: ['openDirectory', 'createDirectory']
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  )

  ipcMain.handle('project:chooseLocation', async (_e, current: string): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('mainIndex.projectLocation.title'),
      buttonLabel: t('mainIndex.chooseThisFolder'),
      defaultPath: await firstExisting(current),
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('project:exists', async (_e, folder: string, fileName: string): Promise<boolean> => {
    if (!simpleName(fileName)) return false
    return exists(join(folder, fileName))
  })

  ipcMain.handle(
    'project:save',
    async (
      _e,
      folder: string,
      fileName: string,
      text: string,
      file: { name: string; data: ArrayBuffer }[],
      toRemove: string[]
    ): Promise<string> => {
      if (!simpleName(fileName) || file.some((f) => !simpleName(f.name))) {
        throw new Error(t('mainIndex.invalidFileName'))
      }
      await mkdir(folder, { recursive: true })
      // Images first, then the project file. Each file is written to a
      // temporary one and renamed only once all are written: a failure
      // halfway (disk full, USB drive removed) leaves the images of the
      // previous save intact instead of truncating them.
      const writtenFiles: string[] = []
      try {
        for (const f of file) {
          const temporary = join(folder, f.name) + '.tmp'
          writtenFiles.push(temporary)
          await writeFile(temporary, Buffer.from(f.data))
        }
      } catch (e) {
        for (const p of writtenFiles) await unlink(p).catch(() => undefined)
        throw e
      }
      for (const f of file) await rename(join(folder, f.name) + '.tmp', join(folder, f.name))
      const destination = join(folder, fileName)
      const temporary = destination + '.tmp'
      await writeFile(temporary, text, 'utf-8')
      await rename(temporary, destination)
      for (const name of toRemove) {
        if (!simpleName(name)) continue
        try {
          await unlink(join(folder, name))
        } catch {
          // Already gone: nothing to do.
        }
      }
      return destination
    }
  )

  // `folder` is the projects folder chosen in the settings.
  ipcMain.handle('project:chooseToOpen', async (_e, folder: string | null): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('mainIndex.openProject.title'),
      buttonLabel: t('mainIndex.openProject.button'),
      defaultPath: await firstExisting(folder ?? join(defaultWorkFolder(), t('common.folders.projects'))),
      properties: ['openFile'],
      filters: [
        { name: t('mainIndex.filters.projects'), extensions: ['slight'] },
        { name: t('mainIndex.filters.allFiles'), extensions: ['*'] }
      ]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('fs:exist', async (e, paths: string[]): Promise<boolean[]> => {
    onlyMainWindow(e)
    return Promise.all(paths.map(exists))
  })

  // File menu "Exit": the interface has already asked for confirmation about
  // unsaved work before getting here.
  ipcMain.handle('app:quit', (): void => {
    quitConfirmed = true
    app.quit()
  })

  /*
   * Restart requested from the Performance tab, for choices that take effect
   * at startup. As with "Exit", the interface has already asked for
   * confirmation and the shutdown is a clean one (the recovery copy is
   * removed as usual, see recovery.ts); then the app reopens by itself.
   */
  ipcMain.handle('app:restart', (): void => {
    quitConfirmed = true
    app.relaunch()
    app.quit()
  })

  ipcMain.on('app:unsavedWork', (_e, value: boolean) => {
    unsavedWork = value === true
  })

  // The interface has received the close request: it is not frozen.
  ipcMain.on('app:closeAcknowledged', () => {
    if (closeResponseWait === null) return
    clearTimeout(closeResponseWait)
    closeResponseWait = null
  })
}

/** The interface reports whether there is work that closing would lose. */
let unsavedWork = false
/** True after "Exit" or after confirmation: the shutdown must no longer be stopped. */
let quitConfirmed = false
/** How long to wait for the interface's reply before closing anyway. */
const CLOSE_RESPONSE_WAIT = 5000
/** Pending wait for the reply to the close request. */
let closeResponseWait: ReturnType<typeof setTimeout> | null = null

// One instance at a time: a second launch brings the existing window to the
// foreground instead of opening another one, and passes it the files it was
// given (double click on a FITS file or a project).
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // The application log starts first, so it also captures startup errors
  // (see log.ts).
  startLog()
  // Before any channel is registered (see ipcGuard.ts).
  guardIpc(() => mainWindow)
  // Before the graphics card starts using its files.
  clearWindowMemoryIfRequested()

  app.on('second-instance', (_e, args, folder) => {
    // During startup the window is still hidden and will appear by itself.
    if (mainWindow && !startupInProgress()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    // The first argument is the executable itself.
    void fileFromArguments(args.slice(1), folder).then((opened) => {
      if (opened.fits.length === 0 && opened.project === null) return
      pendingFile.push(opened)
      deliverOpenedFiles()
    })
  })

  void app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark'
    // Windows language until the interface sends the chosen one.
    setLanguage(languageForLocale(app.getLocale()))
    // No default Electron menu in the installed app: its shortcuts (Ctrl+R
    // reloads, Ctrl+W closes the window) would lose the work. In development
    // it stays, to reload and open the developer tools.
    if (app.isPackaged) Menu.setApplicationMenu(null)
    // First of all, so it appears while the rest gets ready.
    openSplashWindow()
    // No StarLight window asks for camera, microphone, location or
    // notifications: everything is denied except writing to the clipboard
    // (the log report) and full screen.
    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen'])
    session.defaultSession.setPermissionRequestHandler((_c, permission, reply) => reply(allowed.has(permission)))
    session.defaultSession.setPermissionCheckHandler((_c, permission) => allowed.has(permission))
    registerHandlers()
    registerSaveHandlers()
    registerProjectHandlers()
    registerWatcherHandlers()
    registerPluginHandlers(() => mainWindow)
    registerCatalogHandlers(() => mainWindow)
    registerPluginSandbox(() => mainWindow)
    registerCalibrationHandlers()
    registerRecovery()
    registerPerformance()
    registerBatchHandlers(() => mainWindow)
    registerUpdates({
      window: () => mainWindow,
      unsavedWork: () => unsavedWork,
      confirmExit: () => {
        quitConfirmed = true
      }
    })
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
