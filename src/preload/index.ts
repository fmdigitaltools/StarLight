import { contextBridge, ipcRenderer } from 'electron'
import type { FileHandleInfo, RuntimeVersions } from '@shared/types'
import type { WatcherEvent, WatcherStartResult } from '@shared/watcher'
import type { GaiaReply } from '@shared/gaiaCatalog'
import type { PluginInfo, PluginInstallResult, PluginList, PluginFaultResult, SandboxFailed } from '@shared/plugin'
import type {
  CatalogProgress,
  InstalledCatalog,
  CatalogListResult,
  CatalogInstallResult
} from '@shared/catalogs'
import type { MasterEntry } from '@core/stack/calibrationLibrary'
import type { UpdatesChannel, InstallResult, UpdateStatus } from '@shared/updates'
import type { RecoveryCopy, RecoveryImage, RecoveryInfo } from '@shared/recovery'
import type { SevereError, LogLevel, LogOrigin, LogEntry } from '@shared/log'
import { startupChoices, type ComputerMeasurements, type StartupChoices, type SpaceEntry } from '@shared/performance'

/**
 * Performance choices this session started with (see
 * src/main/performance.ts). Requested once, immediately: they do not change
 * until the program closes, and the viewer needs them as soon as it first
 * appears.
 */
const choicesInUse: StartupChoices = startupChoices(ipcRenderer.sendSync('performance:startup'))

/** Files opened by the operating system: FITS files to import and at most one project. */
export interface OpenedFiles {
  fits: FileHandleInfo[]
  project: string | null
}

/**
 * Secure bridge between the interface and the main process. The interface
 * has no direct access to Node: it can only invoke this closed list of
 * operations.
 */
const api = {
  /** Versions of the application and its components, shown in the interface. */
  versions: (): Promise<RuntimeVersions> => ipcRenderer.invoke('app:versions'),

  /** Workflow step to select at startup, if one is forced. */
  initialStep: (): Promise<string | null> => ipcRenderer.invoke('app:initialStep'),

  /** Files passed at application startup: FITS files to import and a project to open. */
  initialFiles: (): Promise<OpenedFiles> => ipcRenderer.invoke('app:initialFiles'),

  /**
   * Receives the files opened by the operating system while StarLight is
   * already running (double-click on a FITS file or a project). Returns the
   * function that stops listening.
   */
  onFilesOpened: (receive: (opened: OpenedFiles) => void): (() => void) => {
    const listen = (_e: unknown, opened: OpenedFiles): void => receive(opened)
    ipcRenderer.on('app:openedFiles', listen)
    // Only now does the main process deliver the files left waiting.
    ipcRenderer.send('app:listeningOpenedFiles')
    return () => {
      ipcRenderer.removeListener('app:openedFiles', listen)
    }
  },

  /** GPU in use and hardware acceleration status. */
  graphicsInfo: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('app:graphicsInfo'),

  /** Installed memory, available cores and engine memory limit. */
  systemInfo: (): Promise<Record<string, number | string>> => ipcRenderer.invoke('app:systemInfo'),

  /** Opens the dialog to select individual FITS frames. */
  openFile: (): Promise<FileHandleInfo[]> => ipcRenderer.invoke('dialog:openFile'),

  /**
   * Opens the frame selection dialog in the telescope folder; `reachable` is
   * false if the folder does not respond.
   */
  openTelescopeFile: (folder: string): Promise<{ reachable: boolean; file: FileHandleInfo[] }> =>
    ipcRenderer.invoke('dialog:openTelescopeFile', folder),

  /** Opens the dialog to select a folder of frames. */
  openFolder: (): Promise<FileHandleInfo[] | null> => ipcRenderer.invoke('dialog:openFolder'),

  /** Lists the FITS files in an already known folder. */
  listFolder: (dir: string): Promise<FileHandleInfo[]> =>
    ipcRenderer.invoke('fs:listFolder', dir),

  /** Reads a file from disk as a binary buffer. */
  readFile: (path: string): Promise<ArrayBuffer> => ipcRenderer.invoke('fs:readFile', path),

  /** Reads only the first bytes of a file: enough for header and metadata. */
  readHead: (path: string, byte: number): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('fs:readHeader', path, byte),

  /** Name and size of a file. */
  fileInfo: (path: string): Promise<FileHandleInfo> => ipcRenderer.invoke('fs:fileInfo', path),

  /**
   * Asks where to save the exported image. If `folder` is given, the dialog
   * starts there (and the folder is created if missing).
   */
  chooseDestination: (suggestedName: string, format: string, folder: string | null = null): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveImage', suggestedName, format, folder),

  /** Writes a binary file to disk. */
  writeFile: (path: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('fs:writeFile', path, data),

  /** Shows the file just saved in File Explorer. */
  showInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:showInFolder', path),

  /** Default work folder, Documents\StarLight (it may not exist yet). */
  defaultWorkFolder: (): Promise<string> => ipcRenderer.invoke('app:defaultWorkFolder'),

  /** System dialog to choose any folder; null if cancelled. */
  chooseFolder: (title: string, current: string | null): Promise<string | null> =>
    ipcRenderer.invoke('dialog:chooseFolder', title, current),

  /** Asks in which folder to create the project. */
  chooseProjectLocation: (current: string): Promise<string | null> =>
    ipcRenderer.invoke('project:chooseLocation', current),

  /** True if the given file already exists in the folder. */
  projectExists: (folder: string, fileName: string): Promise<boolean> =>
    ipcRenderer.invoke('project:exists', folder, fileName),

  /**
   * Writes the project into its folder: images first, then the project file;
   * finally removes files that are no longer used. Returns the path of the
   * project file.
   */
  saveProject: (
    folder: string,
    fileName: string,
    text: string,
    file: { name: string; data: ArrayBuffer }[],
    toRemove: string[]
  ): Promise<string> => ipcRenderer.invoke('project:save', folder, fileName, text, file, toRemove),

  /** Asks which project to open, starting from `folder`; null if cancelled. */
  chooseProjectToOpen: (folder: string | null): Promise<string | null> =>
    ipcRenderer.invoke('project:chooseToOpen', folder),

  /** For each path, true if the file still exists on disk. */
  exist: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('fs:exist', paths),

  /** Closes the application (Exit item of the File menu). */
  exit: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  /** Closes and reopens the application (the interface asks for confirmation about unsaved work). */
  restart: (): Promise<void> => ipcRenderer.invoke('app:restart'),

  /*
   * Performance (see src/main/performance.ts).
   */

  /** GPU, hardware acceleration and priority this session started with. */
  startupChoices: (): StartupChoices => choicesInUse,

  /** Lowers the computing priority or restores it to normal. False if the system did not allow it. */
  setComputePriority: (low: boolean): Promise<boolean> => ipcRenderer.invoke('performance:priority', low),

  /** CPU (% of the computer) and memory (bytes) currently used by StarLight, all processes combined. */
  starLightUsage: (): Promise<{ cpu: number; memory: number }> => ipcRenderer.invoke('performance:usage'),

  /** Processors, memory, battery and GPUs, used to choose the best settings. */
  computerMeasurements: (): Promise<ComputerMeasurements> => ipcRenderer.invoke('performance:measurements'),

  /** What StarLight keeps on disk by itself and how much space it uses. */
  listDiskUsage: (): Promise<SpaceEntry[]> => ipcRenderer.invoke('diskSpace:list'),

  /** Clears the window's temporary cache (part of it at the next startup). */
  clearWindowMemory: (): Promise<void> => ipcRenderer.invoke('diskSpace:clearWindow'),

  /** Tells the main process whether closing the window would lose work. */
  reportUnsavedWork: (value: boolean): void => ipcRenderer.send('app:unsavedWork', value),

  /** Notifies when the window is being closed with unsaved work. */
  onCloseRequest: (handler: () => void): void => {
    ipcRenderer.removeAllListeners('app:closeRequested')
    ipcRenderer.on('app:closeRequested', () => {
      handler()
      // The reply tells the main process that the interface is not frozen:
      // the confirmation is visible and closing must not be forced.
      ipcRenderer.send('app:closeAcknowledged')
    })
  },

  /*
   * Automatic save for recovery (see src/main/recovery.ts): a copy of the
   * unsaved work in the program data folder.
   */

  /**
   * Writes the recovery copy: the new images (encoded by the main process),
   * the project file and the information; removes the files not listed in
   * `keep`.
   */
  saveRecovery: (text: string, images: RecoveryImage[], keep: string[], info: RecoveryInfo): Promise<void> =>
    ipcRenderer.invoke('recovery:save', text, images, keep, info),

  /**
   * A chunk of the pixels of a recovery copy image, to be sent before
   * `saveRecovery`: `total` is the number of values of the whole image,
   * `start` the position of the chunk.
   */
  recoveryData: (name: string, total: number, start: number, piece: Float32Array): Promise<void> =>
    ipcRenderer.invoke('recovery:data', name, total, start, piece),

  /** Deletes the recovery copy. */
  removeRecovery: (): Promise<void> => ipcRenderer.invoke('recovery:delete'),

  /** The copy left by an abnormal shutdown, or null. */
  readRecovery: (): Promise<RecoveryCopy | null> => ipcRenderer.invoke('recovery:read'),

  /** Recovery was chosen at startup: the copy now follows the open work. */
  recoveryDecided: (): void => ipcRenderer.send('recovery:decided'),

  /*
   * Batch processing (see src/main/batch.ts).
   */

  /** Asks for the images to batch process. */
  chooseBatchFiles: (): Promise<FileHandleInfo[]> => ipcRenderer.invoke('batch:chooseFiles'),

  /**
   * Writes a file produced by the batch without ever overwriting an existing
   * one: if the name is taken, a number is appended. Returns the path
   * actually used.
   */
  writeBatchFile: (folder: string, name: string, data: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('batch:write', folder, name, data),

  /** Asks where to save a recipe and writes it; null if cancelled. */
  saveRecipe: (suggestedName: string, text: string, folder: string | null): Promise<string | null> =>
    ipcRenderer.invoke('batch:saveRecipe', suggestedName, text, folder),

  /** Asks which recipe to open and returns its text; null if cancelled. */
  openRecipe: (folder: string | null): Promise<{ path: string; text: string } | null> =>
    ipcRenderer.invoke('batch:openRecipe', folder),

  /** Reads the saved preferences (guide already seen, last settings). */
  readPreferences: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('prefs:read'),

  /**
   * Gaia DR3 stars in a sky area, for photometric colour calibration.
   * Requires internet access.
   */
  gaiaStars: (
    ra: number,
    dec: number,
    radiusDegrees: number,
    maxMagnitude: number
  ): Promise<GaiaReply<{ ra: number; dec: number; g: number; bpRp: number }>> =>
    ipcRenderer.invoke('gaia:stars', ra, dec, radiusDegrees, maxMagnitude),

  /**
   * Stars from the local package for plate solving (see
   * src/main/catalogs.ts), without internet access: null if the package is
   * not installed or is disabled.
   */
  localStars: (
    ra: number,
    dec: number,
    radiusDegrees: number,
    maxMagnitude: number
  ): Promise<{ stars: { ra: number; dec: number; g: number }[]; limitMagnitude: number } | null> =>
    ipcRenderer.invoke('stars:local', ra, dec, radiusDegrees, maxMagnitude),

  /** Asks for the folder to watch during a capture session. */
  chooseWatchedFolder: (defaultFolder: string | null): Promise<string | null> =>
    ipcRenderer.invoke('watcher:chooseFolder', defaultFolder),

  /**
   * Starts watching a folder, local or on the network. Complete frames then
   * arrive one at a time through `onWatch`.
   */
  startWatcher: (folder: string, includeExisting: boolean): Promise<WatcherStartResult> =>
    ipcRenderer.invoke('watcher:start', folder, includeExisting),

  /** Stops watching the folder. */
  stopWatcher: (): Promise<void> => ipcRenderer.invoke('watcher:stop'),

  /** Receives the watched folder notifications. Returns the function that stops listening. */
  onWatch: (receive: (event: WatcherEvent) => void): (() => void) => {
    const listen = (_e: unknown, event: WatcherEvent): void => receive(event)
    ipcRenderer.on('watcher:event', listen)
    return () => {
      ipcRenderer.removeListener('watcher:event', listen)
    }
  },

  /** Saves the preferences. */
  writePreferences: (prefs: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('prefs:write', prefs),

  /** Tells the main process the interface language (Windows dialogs, file filters, menus). */
  setLanguage: (language: string): Promise<void> => ipcRenderer.invoke('app:language', language),

  /*
   * Plugins. Plugin code arrives here only as text: the interface runs it in
   * an isolated worker, never in the main process.
   */

  /**
   * Installed plugins, with manifest and images ready to display: the loaded
   * ones, the disabled ones and those rejected by the startup checks.
   */
  listPlugins: (): Promise<PluginList> => ipcRenderer.invoke('plugins:list'),

  /** Disables or re-enables a plugin installed from file; the choice persists. */
  enablePluginFromFile: (id: string, active: boolean): Promise<void> => ipcRenderer.invoke('plugins:enableFromFile', id, active),

  /** Records that a plugin stopped; returns in how many sessions it has happened. */
  reportPluginFailure: (id: string, version: string): Promise<PluginFaultResult> =>
    ipcRenderer.invoke('plugins:reportFailure', id, version),

  /**
   * Prepares a run in the plugin sandbox, the separate process plugins run
   * in (see src/main/pluginSandbox.ts). The channel reaches the page through
   * window.postMessage (type "starlight-plugin-sandbox"), because a
   * MessagePort cannot cross the preload bridge. Returns the run id, or null
   * if the sandbox is not available.
   */
  openPluginSandbox: (imageBytes: number): Promise<number | null> => ipcRenderer.invoke('sandbox:open', imageBytes),

  /** End of a sandbox run: stops monitoring its memory. */
  closePluginSandbox: (id: number): Promise<void> => ipcRenderer.invoke('sandbox:close', id),

  /** Notifies if the sandbox closes during a run (out of memory or crash). */
  onSandboxCrashed: (receive: (falloff: SandboxFailed) => void): (() => void) => {
    const f = (_e: unknown, c: SandboxFailed): void => receive(c)
    ipcRenderer.on('sandbox:crashed', f)
    return () => ipcRenderer.removeListener('sandbox:crashed', f)
  },

  /** Plugins of the gallery bundled with the application. */
  pluginGallery: (): Promise<PluginInfo[]> => ipcRenderer.invoke('plugins:gallery'),

  /** Text of the plugin.js file of an installed plugin. */
  pluginCode: (id: string): Promise<string> => ipcRenderer.invoke('plugins:readCode', id),

  /** Enables or disables a bundled gallery plugin; the choice persists. */
  enableBundledPlugin: (id: string, active: boolean): Promise<PluginInstallResult> =>
    ipcRenderer.invoke('plugins:enableBundled', id, active),

  /** Asks for a folder and installs the plugin it contains. */
  installPluginFromFolder: (): Promise<PluginInstallResult> => ipcRenderer.invoke('plugins:installFromFolder'),

  /** Asks for a ZIP archive and installs the plugin it contains. */
  installPluginFromArchive: (): Promise<PluginInstallResult> => ipcRenderer.invoke('plugins:installFromArchive'),

  /** Uninstalls a plugin by deleting its folder. */
  uninstallPlugin: (id: string): Promise<void> => ipcRenderer.invoke('plugins:uninstall', id),

  /*
   * Downloadable deep-sky catalogs (see src/main/catalogs.ts): data only,
   * verified against their SHA-256 hash before installation.
   */

  /** Installed catalogs. */
  installedCatalogs: (): Promise<InstalledCatalog[]> => ipcRenderer.invoke('catalogs:installed'),

  /** List of the catalogs on the server (requires internet access). */
  availableCatalogs: (): Promise<CatalogListResult> => ipcRenderer.invoke('catalogs:available'),

  /** Excludes a catalog for this session: the interface could not use it. */
  excludeCatalog: (id: string, problem: string): Promise<void> => ipcRenderer.invoke('catalogs:exclude', id, problem),

  /** Text of the oggetti.tsv file of an installed catalog. */
  catalogObjects: (id: string): Promise<string> => ipcRenderer.invoke('catalogs:objects', id),

  /** Downloads and installs (or updates) a catalog from the server. */
  installCatalog: (id: string): Promise<CatalogInstallResult> => ipcRenderer.invoke('catalogs:install', id),

  /** Cancels a catalog download. */
  cancelCatalog: (id: string): Promise<void> => ipcRenderer.invoke('catalogs:cancel', id),

  /** Asks for a ZIP archive and installs the catalog it contains. */
  installCatalogFromArchive: (): Promise<CatalogInstallResult> => ipcRenderer.invoke('catalogs:installFromArchive'),

  /** Enables or disables an installed catalog; the choice persists. */
  enableCatalog: (id: string, active: boolean): Promise<void> => ipcRenderer.invoke('catalogs:enable', id, active),

  /** Uninstalls a catalog by deleting its folder. */
  uninstallCatalog: (id: string): Promise<void> => ipcRenderer.invoke('catalogs:uninstall', id),

  /*
   * Calibration library (see src/main/calibration.ts): master darks, flats
   * and biases kept and reused automatically.
   */

  /** Masters stored in the library. */
  calibrationLibraryList: (): Promise<MasterEntry[]> => ipcRenderer.invoke('calibration:list'),

  /** Saves a master (16-bit values); replaces the one with the same conditions. */
  saveCalibrationMaster: (description: Omit<MasterEntry, 'id' | 'created' | 'byte'>, values: ArrayBuffer): Promise<MasterEntry> =>
    ipcRenderer.invoke('calibration:save', description, values),

  /** 16-bit values of a library master. */
  readCalibrationMaster: (id: string): Promise<ArrayBuffer> => ipcRenderer.invoke('calibration:read', id),

  /** Removes a master from the library. */
  removeCalibrationMaster: (id: string): Promise<void> => ipcRenderer.invoke('calibration:delete', id),

  /** Opens the library folder in File Explorer. */
  openCalibrationFolder: (): Promise<void> => ipcRenderer.invoke('calibration:openFolder'),

  /** Download progress; returns the function that stops listening. */
  onCatalogProgress: (receive: (a: CatalogProgress) => void): (() => void) => {
    const listen = (_e: unknown, a: CatalogProgress): void => receive(a)
    ipcRenderer.on('catalogs:progress', listen)
    return () => {
      ipcRenderer.removeListener('catalogs:progress', listen)
    }
  },

  /*
   * Automatic updates (see src/main/updates.ts). The status always arrives
   * whole, at every change, through `onUpdateStatus`.
   */

  /** Current update status. */
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:state'),

  /** Asks the server whether a new version exists (manual = from the menu). */
  checkForUpdates: (manual: boolean, channel: UpdatesChannel): Promise<UpdateStatus> =>
    ipcRenderer.invoke('updates:check', manual, channel),

  /** Downloads the new version in the background; with `installImmediately` it is installed as soon as it is ready. */
  downloadUpdate: (installImmediately: boolean): Promise<void> =>
    ipcRenderer.invoke('updates:download', installImmediately),

  /** Closes StarLight, installs silently and reopens it. */
  installUpdate: (): Promise<InstallResult> => ipcRenderer.invoke('updates:installNow'),

  /** Stops offering this version at startup. */
  skipUpdate: (version: string): Promise<void> => ipcRenderer.invoke('updates:skip', version),

  /** Receives the status at every change. Returns the function that stops listening. */
  onUpdateStatus: (receive: (state: UpdateStatus) => void): (() => void) => {
    const listen = (_e: unknown, state: UpdateStatus): void => receive(state)
    ipcRenderer.on('updates:state', listen)
    return () => {
      ipcRenderer.removeListener('updates:state', listen)
    }
  },

  /*
   * Program log (see src/main/log.ts): it stays on the computer and nothing
   * is sent automatically.
   */

  /** Adds a log entry; `severe` makes it be reported at the next start. */
  writeLog: (level: LogLevel, origin: LogOrigin, text: string, severe = false): void =>
    ipcRenderer.send('log:write', level, origin, text, severe),

  /** The latest log entries, most recent first. */
  logEntries: (): Promise<LogEntry[]> => ipcRenderer.invoke('log:entries'),

  /** Text to paste into a report: version, system and last lines, already anonymised. */
  logReport: (): Promise<string> => ipcRenderer.invoke('log:report'),

  /** Opens the log folder in File Explorer. */
  openLogFolder: (): Promise<void> => ipcRenderer.invoke('log:openFolder'),

  /** Deletes the log files. */
  clearLog: (): Promise<void> => ipcRenderer.invoke('log:clear'),

  /** The severe error that occurred before the restart, if any and not yet seen. */
  severeErrorLog: (): Promise<SevereError | null> => ipcRenderer.invoke('log:severeError'),

  /** The severe error notice has been seen: it must not be shown again. */
  severeErrorSeen: (): Promise<void> => ipcRenderer.invoke('log:severeErrorSeen'),

  /** Notifies about main process errors. Returns the function that stops listening. */
  onInternalError: (receive: () => void): (() => void) => {
    const listen = (): void => receive()
    ipcRenderer.on('log:internalError', listen)
    return () => {
      ipcRenderer.removeListener('log:internalError', listen)
    }
  }
}

export type StarLightApi = typeof api

contextBridge.exposeInMainWorld('starlight', api)

// Channels to the plugin sandbox: forwarded to the page as they arrive.
ipcRenderer.on('sandbox:port', (event, data: { id: number }) => {
  const port = event.ports[0]
  if (port) window.postMessage({ type: 'starlight-plugin-sandbox', id: data.id }, '*', [port])
})
