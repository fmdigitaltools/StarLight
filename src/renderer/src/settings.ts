import { MARKER_GROUPS, DENSITY_FACTOR, type MarkerDensity } from '@core/catalog/crowding'
import { useSyncExternalStore } from 'react'
import { joinPath } from '@core/project'
import type { UpdatesChannel } from '@shared/updates'
import { PRERELEASE } from '@shared/version'
import { DEFAULT_STARTUP_CHOICES, startupChoices, type Gpu } from '@shared/performance'
import type { CaptionCorner, CaptionTemplate, CaptionChoice } from '@core/export/caption'
import type { CoordinatesChoice } from '@core/astrometry/imageCoordinates'
import { getLanguage, isLanguage, LANGUAGES, languageForLocale, setLanguage, t, type Language } from '@shared/i18n/i18n'

/** Language setting: `auto` follows the Windows language. */
export type LanguageSetting = 'auto' | Language

/**
 * StarLight settings, chosen in the Settings window.
 *
 * This is the only place that reads and writes them: callers use
 * `readSettings()` for the current value, `subscribeSettings()` to know when
 * they change, or `useSettings()` inside a React component.
 *
 * They are stored in the preferences file under the `settings` key. That
 * file also holds other things (onboarding completed, the last live session
 * folder…), so it is never overwritten whole: it is read, the changed part is
 * merged in, and it is written back.
 *
 * Work folder chosen during installation. The installer can ask where to put
 * the work folder and write it into the preferences file (preferences.json in
 * the user data folder, %APPDATA%\StarLight) as the `workFolder` key inside
 * `settings`:
 *
 *   { "settings": { "workFolder": "D:\\Astrophotography" } }
 *
 * At startup it is read like every other setting, with no extra code;
 * missing keys take the default value. If the file already exists (for
 * example during an update) the installer must add the key without deleting
 * the others.
 */

export interface Settings {
  /* General */
  /** Language of the interface; `auto` follows Windows (Italian for Italian, English otherwise). */
  language: LanguageSetting
  /**
   * Work folder, containing the projects, exports and live sessions
   * subfolders (see subfolderName); empty = Documents\StarLight.
   */
  workFolder: string
  /** Projects folder; empty = the projects subfolder of the work folder. */
  projectsFolder: string
  /** Folder suggested for exports; empty = the exports subfolder. */
  exportsFolder: string
  /** Folder suggested for saving live sessions; empty = the live sessions subfolder. */
  sessionsFolder: string
  /** At startup, reopens the last project saved or opened. */
  reopenLastProject: boolean
  /** Copy of unsaved work, to resume it if StarLight closes unexpectedly (see hooks/recovery.ts). */
  recoverySave: boolean

  /* Performance */
  /** Workers for frame analysis and alignment; 0 = automatic. */
  analysisWorkers: number
  /** Memory for frames already opened, in gigabytes; 0 = automatic. */
  frameMemoryGB: number
  /**
   * GPU requested from the system and use of hardware acceleration: read by
   * the main process at startup (src/main/performance.ts), they take effect
   * from the next startup.
   */
  gpu: Gpu
  graphicsAcceleration: boolean
  /** Low priority for the computing process: takes effect immediately (see performance.ts). */
  lowPriorityComputation: boolean

  /* Telescope */
  /** Folder or network path suggested for the live session; empty = the last one used. */
  telescopeFolder: string
  /** Automatically reuses calibration library masters when the conditions match. */
  calibrationLibrary: boolean

  /* Object markers */
  /** How many names and circles are drawn on the image. */
  markerDensity: MarkerDensity
  /** Object type groups hidden from the markers (see MARKER_GROUPS). */
  hiddenMarkerTypes: string[]

  /* Coordinates on the image (Objects step; also used in the export) */
  /** Right ascension and declination lines with the values at the edges. */
  coordinatesGrid: boolean
  /** Cross showing the north and east directions. */
  coordinatesOrientation: boolean
  /** Bar with a round angular measure. */
  coordinatesScale: boolean

  /* Export caption (Export panel, also used by batch processing) */
  /** Adds the caption with the exposure data to the display formats. */
  caption: boolean
  captionModel: CaptionTemplate
  /** Corner of the Minimal template. */
  captionCorner: CaptionCorner
  /** Author name written in the caption; empty = none. */
  captionAuthor: string
  /** Writes the location name, if the file records it (never the coordinates). */
  captionLocation: boolean

  /* Network and catalogs */
  /** If false, no feature connects to the internet. */
  internet: boolean
  /** Gaia catalog stars requested for calibration: down to this magnitude. */
  gaiaMagnitude: number

  /* Appearance */
  /** Animated glow and sparkles on the Abracadabra button. */
  animatedAbracadabra: boolean
  /** Turns off interface animations, even if the system does not request it. */
  reducedMotion: boolean
  /** Splash window with the logo shown while the program opens (also read by src/main/splash.ts). */
  splashWindow: boolean

  /* Updates */
  /** At startup, asks the server whether a new version exists (only if internet access is allowed). */
  checkForUpdates: boolean
  /** Versions offered: stable only, or test versions as well. */
  updatesChannel: UpdatesChannel
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'auto',
  workFolder: '',
  projectsFolder: '',
  exportsFolder: '',
  sessionsFolder: '',
  reopenLastProject: false,
  recoverySave: true,
  analysisWorkers: 0,
  frameMemoryGB: 0,
  ...DEFAULT_STARTUP_CHOICES,
  telescopeFolder: '',
  calibrationLibrary: true,
  markerDensity: 'normal',
  hiddenMarkerTypes: [],
  coordinatesGrid: false,
  coordinatesOrientation: false,
  coordinatesScale: false,
  caption: true,
  captionModel: 'minimal',
  captionCorner: 'bottom-right',
  captionAuthor: '',
  captionLocation: false,
  internet: true,
  // The same value as CATALOG_MAGNITUDE in core/image/photometry.ts.
  gaiaMagnitude: 15.5,
  animatedAbracadabra: true,
  reducedMotion: false,
  splashWindow: true,
  checkForUpdates: true,
  // A test release (1.0.0-beta.1) is published only on the test channel:
  // while the installed version is one, that channel is the default, so the
  // next test release arrives. A stable release defaults to stable releases.
  updatesChannel: PRERELEASE !== '' ? 'test' : 'stable'
}

/** Accepted limits for the Gaia catalog magnitude. */
export const GAIA_MAGNITUDE_MIN = 12
export const GAIA_MAGNITUDE_MAX = 18

const KEY = 'settings'

let currentValues: Settings = DEFAULT_SETTINGS
const listeners = new Set<() => void>()

/** Current values. Until the file has been read, they are the defaults. */
export function readSettings(): Settings {
  return currentValues
}

/**
 * Calls `listen` at every change, including the first load from the file.
 * Returns the function that stops listening.
 */
export function subscribeSettings(listen: () => void): () => void {
  listeners.add(listen)
  return () => {
    listeners.delete(listen)
  }
}

/** Current settings inside a component, which re-renders automatically. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, readSettings)
}

function notifyAll(): void {
  for (const a of listeners) a()
}

const CAPTION_MODELS: readonly CaptionTemplate[] = ['banner', 'card', 'minimal']
const CAPTION_CORNERS: readonly CaptionCorner[] = ['bottom-left', 'top-right', 'top-left', 'bottom-right']
/** The value if it is allowed, otherwise the default. */
function oneOf<T extends string>(v: unknown, values: readonly T[], d: T): T {
  return values.find((x) => x === v) ?? d
}

/** Keeps only values of the right type: a hand-edited file must not break anything. */
function clean(rawValues: unknown): Settings {
  const g = (rawValues !== null && typeof rawValues === 'object' ? rawValues : {}) as Record<string, unknown>
  const p = DEFAULT_SETTINGS
  const text = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
  const asBoolean = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const number = (v: unknown, d: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d
  return {
    language: g['language'] === 'auto' || isLanguage(g['language']) ? g['language'] : p.language,
    workFolder: text(g['workFolder'], p.workFolder).trim(),
    projectsFolder: text(g['projectsFolder'], p.projectsFolder).trim(),
    exportsFolder: text(g['exportsFolder'], p.exportsFolder).trim(),
    sessionsFolder: text(g['sessionsFolder'], p.sessionsFolder).trim(),
    reopenLastProject: asBoolean(g['reopenLastProject'], p.reopenLastProject),
    recoverySave: asBoolean(g['recoverySave'], p.recoverySave),
    analysisWorkers: Math.round(number(g['analysisWorkers'], p.analysisWorkers, 0, 256)),
    frameMemoryGB: number(g['frameMemoryGB'], p.frameMemoryGB, 0, 1024),
    // The same reader as the main process, which uses them at startup.
    ...startupChoices(g),
    telescopeFolder: text(g['telescopeFolder'], p.telescopeFolder),
    calibrationLibrary: asBoolean(g['calibrationLibrary'], p.calibrationLibrary),
    markerDensity:
      g['markerDensity'] === 'essential' || g['markerDensity'] === 'rich' || g['markerDensity'] === 'normal'
        ? g['markerDensity']
        : p.markerDensity,
    hiddenMarkerTypes: Array.isArray(g['hiddenMarkerTypes'])
      ? (g['hiddenMarkerTypes'] as unknown[]).filter((x): x is string => MARKER_GROUPS.some((gr) => gr.id === x))
      : p.hiddenMarkerTypes,
    coordinatesGrid: asBoolean(g['coordinatesGrid'], p.coordinatesGrid),
    coordinatesOrientation: asBoolean(g['coordinatesOrientation'], p.coordinatesOrientation),
    coordinatesScale: asBoolean(g['coordinatesScale'], p.coordinatesScale),
    caption: asBoolean(g['caption'], p.caption),
    captionModel: oneOf(g['captionModel'], CAPTION_MODELS, p.captionModel),
    captionCorner: oneOf(g['captionCorner'], CAPTION_CORNERS, p.captionCorner),
    // A name, not a long text.
    captionAuthor: text(g['captionAuthor'], p.captionAuthor).slice(0, 80),
    captionLocation: asBoolean(g['captionLocation'], p.captionLocation),
    internet: asBoolean(g['internet'], p.internet),
    gaiaMagnitude: number(
      g['gaiaMagnitude'],
      p.gaiaMagnitude,
      GAIA_MAGNITUDE_MIN,
      GAIA_MAGNITUDE_MAX
    ),
    // These three choices are not exposed in the Settings window: the
    // defaults always apply, even if an older file stores another value.
    animatedAbracadabra: p.animatedAbracadabra,
    reducedMotion: p.reducedMotion,
    splashWindow: p.splashWindow,
    checkForUpdates: asBoolean(g['checkForUpdates'], p.checkForUpdates),
    updatesChannel: oneOf(g['updatesChannel'], ['stable', 'test'] as const, p.updatesChannel)
  }
}

/*
 * Queued writes: two saves in quick succession (for example two toggles
 * flipped quickly) must not read the same file and lose one of the two
 * changes.
 */
let queue: Promise<void> = Promise.resolve()

/**
 * Adds or changes some keys of the preferences file, leaving all the others
 * untouched. Also suitable for keys that are not settings (for example the
 * last project opened).
 */
export function updatePreferences(partial: Record<string, unknown>): Promise<void> {
  queue = queue
    .then(async () => {
      const prefs = await window.starlight.readPreferences()
      await window.starlight.writePreferences({ ...prefs, ...partial })
    })
    .catch(() => {
      // Failing to remember a choice does not prevent working.
    })
  return queue
}

/** Changes some settings: they take effect immediately and are saved to the file. */
export function writeSettings(partial: Partial<Settings>): Promise<void> {
  // Before the file is read, the defaults would be written over the saved
  // choices: wait for the read to finish.
  if (!loadedItems) return loading.then(() => writeSettings(partial))
  currentValues = clean({ ...currentValues, ...partial })
  applyLanguage()
  notifyAll()
  const toWrite = currentValues
  return updatePreferences({ [KEY]: toWrite })
}

/** Resets all settings to their default values. */
export function resetSettings(): Promise<void> {
  return writeSettings(DEFAULT_SETTINGS)
}

let loadedItems = false

/** Language actually in use: the chosen one, or the Windows one for `auto`. */
export function effectiveLanguage(setting: LanguageSetting = currentValues.language): Language {
  // Outside the app (automated tests) there is no navigator: Italian, the reference language.
  if (setting !== 'auto') return setting
  return typeof navigator !== 'undefined' ? languageForLocale(navigator.language) : 'it'
}

/** Applies the language setting here and in the main process (dialogs, file filters). */
function applyLanguage(): void {
  const language = effectiveLanguage()
  setLanguage(language)
  // The bridge to the main process exists only inside the app.
  const bridge = typeof window !== 'undefined' ? window.starlight : undefined
  void bridge?.setLanguage?.(language)?.catch(() => undefined)
}

/** Initial read from the file, once at startup. */
const loading: Promise<Settings> = (async () => {
  try {
    const prefs = await window.starlight.readPreferences()
    currentValues = clean(prefs[KEY])
  } catch {
    // Without a file, the defaults remain.
  }
  applyLanguage()
  notifyAll()
  loadedItems = true
  return currentValues
})()

/** Resolves when the saved settings have been read. */
export function settingsReady(): Promise<Settings> {
  return loading
}

/* ---- Work folders ---- */

/** The three folders created inside the work folder. */
export type FolderType = 'projects' | 'exports' | 'sessions'

const FOLDER_TYPES: readonly FolderType[] = ['projects', 'exports', 'sessions']

/**
 * Name of a subfolder in a language (`common.folders` in the language
 * files). New subfolders are created in the interface language; the
 * installer creates them in the Windows language.
 */
export function subfolderName(type: FolderType, language: Language = getLanguage()): string {
  return t('common.folders.' + type, undefined, language)
}

/** Subfolders found on disk in the work folder `foundIn`, by type. */
let foundSubfolders: Partial<Record<FolderType, string>> = {}
let foundIn = ''

/**
 * Looks in the work folder for subfolders already created in any language,
 * the current one first: after a language change StarLight keeps using them
 * instead of creating new ones next to them. Notifies the listeners when
 * the result changes.
 */
async function findSubfolders(job: string): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.starlight : undefined
  if (!bridge || job === '') return
  const names = FOLDER_TYPES.map((type) => [
    ...new Set([subfolderName(type), ...LANGUAGES.map((l) => subfolderName(type, l.value))])
  ])
  let exist: boolean[]
  try {
    exist = await bridge.exist(names.flat().map((n) => joinPath(job, n)))
  } catch {
    return
  }
  const found: Partial<Record<FolderType, string>> = {}
  let i = 0
  FOLDER_TYPES.forEach((type, k) => {
    for (const name of names[k]) if (exist[i++] && found[type] === undefined) found[type] = name
  })
  const changed = job !== foundIn || FOLDER_TYPES.some((type) => found[type] !== foundSubfolders[type])
  foundSubfolders = found
  foundIn = job
  if (changed) notifyAll()
}

/** Name of the subfolder of this type in the work folder: the existing one, or the one to create. */
function subfolderIn(job: string, type: FolderType): string {
  return (job === foundIn ? foundSubfolders[type] : undefined) ?? subfolderName(type)
}

/** Setting that, when not empty, replaces the subfolder. */
export const FOLDER_FIELD: Record<
  FolderType,
  'projectsFolder' | 'exportsFolder' | 'sessionsFolder'
> = {
  projects: 'projectsFolder',
  exports: 'exportsFolder',
  sessions: 'sessionsFolder'
}

export interface WorkPaths {
  job: string
  projects: string
  exports: string
  sessions: string
}

/**
 * Actual folder paths, given the settings and the system default work
 * folder. The folders may not exist yet: they are created only when needed
 * (on the first project save, on the first export).
 */
export function workPaths(settings: Settings, systemWork: string): WorkPaths {
  const job = settings.workFolder !== '' ? settings.workFolder : systemWork
  const per = (type: FolderType): string => {
    const choice = settings[FOLDER_FIELD[type]]
    return choice !== '' ? choice : joinPath(job, subfolderIn(job, type))
  }
  if (job !== foundIn) void findSubfolders(job)
  return { job, projects: per('projects'), exports: per('exports'), sessions: per('sessions') }
}

/** Name shown for a subfolder in the work folder (existing, or to be created). */
export function shownSubfolder(settings: Settings, systemWork: string, type: FolderType): string {
  return subfolderIn(settings.workFolder !== '' ? settings.workFolder : systemWork, type)
}

let systemWork: Promise<string> | null = null

/** System default work folder (Documents\StarLight), requested only once. */
export function systemWorkFolder(): Promise<string> {
  systemWork ??= window.starlight.defaultWorkFolder()
  return systemWork
}

/** Actual path of one of the work folders, once the settings have been read. */
export async function workFolderOf(type: FolderType): Promise<string> {
  const [, system] = await Promise.all([settingsReady(), systemWorkFolder()])
  // Looks on disk first, so the path is right even if a folder was created
  // or renamed outside StarLight in the meantime.
  await findSubfolders(currentValues.workFolder !== '' ? currentValues.workFolder : system)
  return workPaths(currentValues, system)[type]
}

/* ---- Markers ---- */

/** Marker density and hidden types, for code that draws outside React (export). */
export function markerPreferences(): { density: number; hidden: string[] } {
  return { density: DENSITY_FACTOR[currentValues.markerDensity], hidden: currentValues.hiddenMarkerTypes }
}

/* ---- Coordinates on the image ---- */

/** Grid, orientation and scale chosen in the Objects step, for code that draws outside React. */
export function coordinatesChoice(): CoordinatesChoice {
  return {
    grid: currentValues.coordinatesGrid,
    orientation: currentValues.coordinatesOrientation,
    scale: currentValues.coordinatesScale
  }
}

/* ---- Caption ---- */

/**
 * Caption chosen for the export, or null if it is off. For code that exports
 * outside React (batch processing).
 */
export function captionChoice(): (CaptionChoice & { author: string; place: boolean }) | null {
  if (!currentValues.caption) return null
  return {
    model: currentValues.captionModel,
    angle: currentValues.captionCorner,
    author: currentValues.captionAuthor,
    place: currentValues.captionLocation
  }
}

/* ---- Calibration ---- */

/** True if calibration library masters are reused automatically. */
export function calibrationLibraryReuse(): boolean {
  return currentValues.calibrationLibrary
}

/* ---- Network ---- */

/** True if the user allows StarLight to connect to the internet. */
export function internetAllowed(): boolean {
  return currentValues.internet
}

/** Message shown when a network feature is used while internet access is off. */
export function noInternetNotice(feature: string): string {
  return t('rendererSettings.noInternetNotice', { feature })
}

/* ---- Appearance ---- */

/**
 * True if animations must be avoided, by choice in the settings or because
 * the operating system requests it. Used by animations driven from code,
 * which the stylesheet cannot stop.
 */
export function reducedMotionActive(): boolean {
  if (currentValues.reducedMotion) return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Classes on the document read by the stylesheets (see styles/components.css and styles/updates.css). */
function applyAppearance(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement.classList
  root.toggle('sl-reduced-motion', currentValues.reducedMotion)
  root.toggle('sl-abracadabra-still', !currentValues.animatedAbracadabra)
}

subscribeSettings(applyAppearance)
