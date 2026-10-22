/*
 * Application log.
 *
 * A text file, `starlight.log`, in the log folder inside the app data
 * folder. It records startup and shutdown (with version, system, memory and
 * graphics card) and errors: those of the main process, the window, the
 * compute workers, the plugins, the error notices shown to the user, and
 * unexpected terminations of the window or of helper processes.
 *
 * The log stays on the computer: nothing is sent automatically. To report a
 * problem, the user opens Help → error log and reporting, copies the report
 * and pastes it wherever they prefer.
 *
 * Privacy: only text goes into the log, never pixels or image contents. The
 * user's home folder becomes %USERPROFILE% and the user name does not
 * appear: the replacement happens before writing, so the file on disk is
 * already anonymous.
 *
 * Size: when the file exceeds about 2 MB it becomes `starlight.1.log` (and
 * the previous one `starlight.2.log`); three files are kept in total.
 *
 * Writing is synchronous: it is rare (startup, shutdown, errors), and an
 * entry written right before a crash still reaches the disk.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { isPluginSandbox } from './pluginSandbox'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { arch, cpus, freemem, homedir, release, totalmem, userInfo, version as osVersion } from 'node:os'
import { APP_CODENAME, APP_NAME, APP_STAGE, APP_VERSION } from '@shared/version'
import {
  LOG_FOLDER,
  windowGraphicsFromEntry,
  type SevereError,
  type LogLevel,
  type LogOrigin,
  type LogEntry
} from '@shared/log'
import { t } from '../shared/i18n/i18n'

/** Beyond this size the file rotates to a new one. */
const MAX_SIZE = 2 * 1024 * 1024
/** Files kept in total: the current one and two previous ones. */
const KEPT_FILES = 3
/** A longer entry is truncated: enough to understand it, and the file stays readable. */
const MAX_ENTRY_LENGTH = 6000
/** Log lines included in the report to copy. */
const REPORT_LINES = 200
/** Entries shown in the log window. */
const DISPLAYED_ENTRIES = 300
/** Marker of a severe error, to be reported at the next start. */
const SEVERE_ERROR_NAME = 'severe-error.json'
/** Text of the shutdown entry: also used at startup to tell whether the last shutdown was clean. */
const CLOSING_TEXT = 'Clean shutdown.'

const ORIGINS: ReadonlySet<string> = new Set<LogOrigin>([
  'startup',
  'main',
  'window',
  'ui',
  'worker',
  'plugin',
  'process'
])
const LEVELS: ReadonlySet<string> = new Set<LogLevel>(['info', 'warning', 'error'])

function folder(): string {
  return join(app.getPath('userData'), LOG_FOLDER)
}

/** Log file: 0 is the current one, 1 and 2 the previous ones. */
function logFile(n: number): string {
  return join(folder(), n === 0 ? 'starlight.log' : 'starlight.' + n + '.log')
}

/* ---- Anonymization ---- */

let replacements: [RegExp, string][] | null = null

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The home folder, in every form it can appear in (backslashes or forward
 * slashes, doubled in JSON text, encoded in file:// URLs), becomes
 * %USERPROFILE%; then the user name, wherever it remains, becomes "<user>".
 */
function prepareReplacements(): [RegExp, string][] {
  if (replacements) return replacements
  const list: [RegExp, string][] = []
  let home = ''
  try {
    home = homedir()
  } catch {
    // Without a home folder only the user name remains to be removed.
  }
  if (home.length > 3) {
    const shapes = new Set<string>()
    for (const f of [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]) {
      shapes.add(f)
      shapes.add(encodeURI(f))
    }
    for (const f of [...shapes].sort((a, b) => b.length - a.length)) {
      list.push([new RegExp(escapeRegExp(f), 'gi'), '%USERPROFILE%'])
    }
  }
  const names = new Set<string>()
  try {
    names.add(userInfo().username)
  } catch {
    // User name not available.
  }
  for (const n of [process.env['USERNAME'], process.env['USER']]) if (n) names.add(n)
  for (const n of names) {
    // A one- or two-letter name would match everywhere by chance.
    if (n.length >= 3) list.push([new RegExp(escapeRegExp(n), 'gi'), '<user>'])
  }
  replacements = list
  return list
}

/** The text without home folder or user name. */
export function anonymize(text: string): string {
  let t = text
  for (const [re, al] of prepareReplacements()) t = t.replace(re, al)
  return t
}

/* ---- Writing ---- */

/** Size of the current file; -1 until it has been read. */
let size = -1
/** Last entry written, so the file is not filled with the same repeated error. */
let last: { key: string; when: number; repetitions: number; level: LogLevel; origin: string } | null =
  null

function two(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(d: Date = new Date()): string {
  return (
    d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' +
    two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds())
  )
}

function entryLine(level: LogLevel, origin: string, text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const head = localDate() + ' [' + level.toUpperCase() + '] ' + origin + ': ' + lines[0]
  // The following lines (for example an error stack trace) are indented.
  const remainder = lines.slice(1).filter((r) => r.trim() !== '').map((r) => '    ' + r.trim())
  return [head, ...remainder].join('\n') + '\n'
}

/** Rotates to a new file when the current one is full. */
function rotate(): void {
  try {
    rmSync(logFile(KEPT_FILES - 1), { force: true })
    for (let n = KEPT_FILES - 2; n >= 0; n--) {
      if (existsSync(logFile(n))) renameSync(logFile(n), logFile(n + 1))
    }
  } catch {
    // If a file is locked, keep appending to the current one.
  }
  size = 0
}

function add(text: string): void {
  mkdirSync(folder(), { recursive: true })
  if (size < 0) {
    try {
      size = statSync(logFile(0)).size
    } catch {
      size = 0
    }
  }
  const byte = Buffer.byteLength(text)
  if (size > 0 && size + byte > MAX_SIZE) rotate()
  appendFileSync(logFile(0), text, 'utf-8')
  size += byte
}

/**
 * Writes an entry to the log. Never throws: a log that cannot be written
 * must not cause an error in turn.
 */
export function writeLog(level: LogLevel, origin: LogOrigin | string, text: string): void {
  try {
    // Strip control characters (except newline and tab): they would make the file unreadable.
    // eslint-disable-next-line no-control-regex
    let t = anonymize(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    if (t.length > MAX_ENTRY_LENGTH) t = t.slice(0, MAX_ENTRY_LENGTH) + ' […]'
    const key = level + '|' + origin + '|' + t
    const now = Date.now()
    // The same error in a burst (for example on every frame) is counted
    // instead of rewritten, so the useful entries stay in the file.
    // Informational entries (startup, window opened) are distinct events even when identical.
    if (level !== 'info' && last && last.key === key && now - last.when < 60000) {
      last.repetitions++
      last.when = now
      return
    }
    let fileText = ''
    if (last && last.repetitions > 0) {
      fileText += entryLine(
        last.level,
        last.origin,
        last.repetitions === 1
          ? 'The previous entry was repeated once more.'
          : 'The previous entry was repeated ' + last.repetitions + ' more times.'
      )
    }
    fileText += entryLine(level, origin, t)
    last = { key, when: now, repetitions: 0, level, origin }
    add(fileText)
  } catch {
    // Disk full or folder not writable: the app carries on anyway.
  }
}

/** Readable text of any error: message and stack trace, never the contents of objects. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack && e.stack.includes(e.message) ? e.stack : e.message + '\n' + (e.stack ?? '')
  if (typeof e === 'string') return e
  try {
    return String(e)
  } catch {
    return 'error that cannot be described'
  }
}

/* ---- Reading ---- */

/** The last `count` lines of the log, oldest first, including the previous files. */
function lastLines(count: number): string[] {
  let lines: string[] = []
  for (let n = 0; n < KEPT_FILES && lines.length < count; n++) {
    try {
      const text = readFileSync(logFile(n), 'utf-8')
      const here = text.split('\n').filter((r) => r !== '')
      lines = [...here, ...lines]
    } catch {
      // File missing: look at the next one.
    }
  }
  return lines.slice(-count)
}

const RE_ENTRY = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \[(INFO|WARNING|ERROR)\] ([^:]+): ?(.*)$/

const LEVELS_BY_TAG: Readonly<Record<string, LogLevel>> = { INFO: 'info', WARNING: 'warning', ERROR: 'error' }

/** Groups lines into entries: indented lines continue the entry above. */
function entriesFromLines(lines: string[]): LogEntry[] {
  const entries: LogEntry[] = []
  for (const r of lines) {
    const m = RE_ENTRY.exec(r)
    if (m) {
      entries.push({ when: m[1], level: LEVELS_BY_TAG[m[2]], origin: m[3], text: m[4] })
    } else if (entries.length > 0) {
      entries[entries.length - 1].text += '\n' + r.trim()
    }
  }
  return entries
}

/* ---- System information ---- */

/** Graphics card, read once at startup (also used by the report). */
let gpu = 'not detected yet'
/** The same as seen by the window (WebGL), once the window has reported it. */
let windowGpu = ''

function gb(byte: number): string {
  return (byte / 1073741824).toFixed(1) + ' GB'
}

function systemName(): string {
  let name = process.platform as string
  try {
    name = osVersion()
  } catch {
    // Node versions without os.version(): the platform name remains.
  }
  return name + ' (' + release() + ', ' + arch() + ')'
}

function systemLines(): string[] {
  const cpu = cpus()
  const limit = app.commandLine.getSwitchValue('js-flags').match(/max-old-space-size=(\d+)/)?.[1]
  return [
    APP_NAME + ' ' + APP_VERSION + ' ' + APP_STAGE + ' «' + APP_CODENAME + '»' +
      (app.isPackaged ? '' : ' (development build)'),
    'Electron ' + process.versions.electron + ', Chrome ' + process.versions.chrome + ', Node ' + process.versions.node,
    'System: ' + systemName(),
    'Memory: ' + gb(totalmem()) + ' (free ' + gb(freemem()) + ')' +
      (limit ? ', processing limit ' + limit + ' MB' : ''),
    'Processor: ' + (cpu[0]?.model.trim() ?? 'not available') + ', ' + cpu.length + ' cores',
    'Graphics card: ' + gpu + (windowGpu ? '\nWindow graphics: ' + windowGpu : '')
  ]
}

async function detectGpu(): Promise<void> {
  try {
    const info = (await app.getGPUInfo('basic')) as {
      gpuDevice?: { active?: boolean; vendorId?: number; deviceId?: number; driverVersion?: string; description?: string }[]
    }
    const gpus = info.gpuDevice ?? []
    const active = gpus.find((s) => s.active) ?? gpus[0]
    if (!active) {
      gpu = 'not detected'
      return
    }
    const hex = (n: number | undefined): string => (n ?? 0).toString(16).padStart(4, '0')
    gpu =
      (active.description && active.description.trim() !== ''
        ? active.description.trim()
        : 'vendor 0x' + hex(active.vendorId) + ', device 0x' + hex(active.deviceId)) +
      (active.driverVersion ? ', driver ' + active.driverVersion : '') +
      (gpus.length > 1 ? ' (' + gpus.length + ' cards present)' : '')
  } catch {
    gpu = 'not detected'
  }
}

/* ---- Severe errors ---- */

function markSevereError(description: string): void {
  try {
    mkdirSync(folder(), { recursive: true })
    const entry: SevereError = { when: localDate(), description: anonymize(description) }
    writeFileSync(join(folder(), SEVERE_ERROR_NAME), JSON.stringify(entry), 'utf-8')
  } catch {
    // At worst, opening the log will not be suggested at the next start.
  }
}

/**
 * The severe error marked earlier (previous session, or the page before a
 * reload). It stays marked until the user has seen the notice
 * (`log:severeErrorSeen`), so a page reloaded before that does not
 * lose it.
 */
function takeSevereError(): SevereError | null {
  const path = join(folder(), SEVERE_ERROR_NAME)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SevereError>
    if (typeof raw.when !== 'string' || typeof raw.description !== 'string') {
      rmSync(path, { force: true })
      return null
    }
    return { when: raw.when, description: raw.description }
  } catch {
    return null
  }
}

/* ---- Unexpected terminations ---- */

const REASONS: Record<string, string> = {
  crashed: 'crash',
  oom: 'out of memory',
  'launch-failed': 'launch failed',
  'integrity-failure': 'integrity check failed',
  'abnormal-exit': 'abnormal exit',
  killed: 'process killed externally',
  'memory-eviction': 'memory reclaimed by the system'
}

function describeReason(reason: string): string {
  return REASONS[reason] ?? reason
}

/** Notifies the window of a main process error (no more than once every 30 seconds). */
let lastWindowNotice = 0
function notifyWindows(): void {
  const now = Date.now()
  if (now - lastWindowNotice < 30000) return
  lastWindowNotice = now
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('log:internalError')
  }
}

/* ---- Tests (development only) ---- */

/**
 * STARLIGHT_TEST_ERROR, development build only: deliberately triggers an
 * error to test the log. Values, possibly several separated by commas:
 * `main` (uncaught exception), `promise` (unhandled promise
 * rejection), `crash` (sudden window termination, reloaded immediately
 * without asking). STARLIGHT_TEST_WAIT is the delay in milliseconds after
 * startup (default 6000).
 */
function developmentTests(): void {
  const tests = (process.env['STARLIGHT_TEST_ERROR'] ?? '').split(',').map((s) => s.trim())
  if (app.isPackaged || tests.every((p) => p === '')) return
  const wait = Number(process.env['STARLIGHT_TEST_WAIT'] ?? 6000)
  const example = join(homedir(), 'Documents', 'StarLight', 'test.fit')
  setTimeout(() => {
    if (tests.includes('promise')) {
      void Promise.reject(new Error('Test: promise rejected in the main process (' + example + ')'))
    }
    if (tests.includes('crash')) {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible())
      w?.webContents.forcefullyCrashRenderer()
    }
    if (tests.includes('main')) {
      throw new Error('Test: error in the main process while reading ' + example)
    }
  }, wait)
}

/* ---- Report ---- */

function ratio(): string {
  return [
    APP_NAME + ' problem report',
    'Created on ' + localDate(),
    '',
    ...systemLines(),
    '',
    'Home folders are shown as %USERPROFILE% and the user name has been removed.',
    'The report contains no images or image data.',
    '',
    'Last log lines:',
    ...lastLines(REPORT_LINES).map(anonymize)
  ].join('\n')
}

/* ---- Startup ---- */

/**
 * To be called as early as possible in the main process (before the app is
 * ready): starts the session log and hooks unhandled errors and unexpected
 * terminations.
 */
export function startLog(): void {
  // How did the previous session end? If its last entry is not the clean
  // shutdown, the app was interrupted (crash, killed process, power loss).
  const previousItems = entriesFromLines(lastLines(40))
  const previousLast = previousItems[previousItems.length - 1]
  if (previousLast && previousLast.text !== CLOSING_TEXT) {
    writeLog(
      'warning',
      'startup',
      'The previous session did not shut down cleanly (last entry at ' + previousLast.when + ').'
    )
  }
  writeLog('info', 'startup', 'Startup. ' + systemLines().slice(0, 5).join('\n'))

  process.on('uncaughtException', (e) => {
    writeLog('error', 'main', 'Uncaught exception: ' + describeError(e))
    notifyWindows()
  })
  process.on('unhandledRejection', (refusalReason) => {
    writeLog('error', 'main', 'Unhandled promise rejection: ' + describeError(refusalReason))
  })

  app.on('render-process-gone', (_e, contents, details) => {
    if (details.reason === 'clean-exit') return
    const reason = describeReason(details.reason)
    if (isPluginSandbox(contents)) {
      // The plugin sandbox: StarLight stays open, the interface warns by itself.
      writeLog('warning', 'process', 'The plugin sandbox terminated unexpectedly: ' + reason + ' (code ' + details.exitCode + ').')
      return
    }
    writeLog(
      'error',
      'process',
      'The window terminated unexpectedly: ' + reason + ' (code ' + details.exitCode + ').'
    )
    const window = BrowserWindow.fromWebContents(contents)
    if (!window || window.isDestroyed() || !window.isVisible()) return
    markSevereError('The StarLight window closed because of an error (' + reason + ')')
    if (!app.isPackaged && process.env['STARLIGHT_TEST_ERROR']) {
      contents.reload()
      return
    }
    /*
     * A single choice: reopen. Once the window reloads, if there was unsaved
     * work StarLight offers to recover it (see recovery.ts).
     */
    void dialog
      .showMessageBox(window, {
        type: 'error',
        title: APP_NAME,
        message: t('mainLog.windowCrashed.message'),
        detail: t('mainLog.windowCrashed.detail'),
        buttons: [t('mainLog.windowCrashed.reopen')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then(() => {
        if (!window.isDestroyed()) window.webContents.reload()
      })
  })

  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    const name = details.name ? details.name + ', ' : ''
    writeLog(
      details.reason === 'killed' ? 'warning' : 'error',
      'process',
      'A helper process (' + name + details.type + ') terminated: ' + describeReason(details.reason) +
        ' (code ' + details.exitCode + ').'
    )
  })

  app.on('browser-window-created', (_e, window) => {
    window.on('unresponsive', () => writeLog('warning', 'window', 'The window is not responding.'))
    window.on('responsive', () => writeLog('info', 'window', 'The window is responding again.'))
  })

  app.on('quit', () => writeLog('info', 'startup', CLOSING_TEXT))

  void app.whenReady().then(async () => {
    registerLogHandlers()
    await detectGpu()
    writeLog('info', 'startup', 'Graphics card: ' + gpu)
    developmentTests()
  })
}

function registerLogHandlers(): void {
  ipcMain.on('log:write', (_e, level: unknown, origin: unknown, text: unknown, severe: unknown) => {
    if (typeof level !== 'string' || !LEVELS.has(level)) return
    if (typeof origin !== 'string' || !ORIGINS.has(origin)) return
    if (typeof text !== 'string') return
    writeLog(level as LogLevel, origin, text)
    // The graphics card name as seen by the window is clearer than the
    // vendor codes: it goes into the report too. The entry starts with a
    // fixed, untranslated prefix (the old Italian one is still accepted).
    const graphics = windowGraphicsFromEntry(text)
    if (graphics) windowGpu = graphics
    if (severe === true) markSevereError(text.split('\n')[0])
  })

  ipcMain.handle('log:entries', (): LogEntry[] => {
    // Most recent entries first.
    return entriesFromLines(lastLines(DISPLAYED_ENTRIES * 4)).slice(-DISPLAYED_ENTRIES).reverse()
  })

  ipcMain.handle('log:report', (): string => ratio())

  ipcMain.handle('log:openFolder', async (): Promise<void> => {
    mkdirSync(folder(), { recursive: true })
    await shell.openPath(folder())
  })

  ipcMain.handle('log:clear', (): void => {
    for (let n = 0; n < KEPT_FILES; n++) rmSync(logFile(n), { force: true })
    rmSync(join(folder(), SEVERE_ERROR_NAME), { force: true })
    size = 0
    last = null
  })

  ipcMain.handle('log:severeError', (): SevereError | null => takeSevereError())

  ipcMain.handle('log:severeErrorSeen', (): void => {
    rmSync(join(folder(), SEVERE_ERROR_NAME), { force: true })
  })
}
