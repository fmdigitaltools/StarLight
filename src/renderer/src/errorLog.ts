import { useApp, type Notice } from './store/appStore'
import { WINDOW_OPENED_PREFIX, type LogLevel, type LogOrigin } from '@shared/log'
import { t } from '@shared/i18n/i18n'
import { broadcastLanguageChanges, nameWithLanguage } from './workers/language'

/**
 * Program log, window side.
 *
 * The file is written by the main process (src/main/log.ts); this module
 * sends it the window's entries:
 * - unhandled errors and unhandled promise rejections;
 * - errors of compute workers and plugins (every `new Worker` goes through a
 *   subclass that records its errors; the only other thing it does is pass
 *   the interface language to the compute workers, see workers/language.ts);
 * - error and warning notices shown to the user (by subscribing to the
 *   store: `notify` stays as it is);
 * - at startup, the GPU as seen by the window.
 *
 * Text only: never pixels or image contents. The home folder and the user
 * name are removed by the main process before writing.
 *
 * It must be imported first (main.tsx), before the modules that create
 * workers.
 */

/** True if the bridge supports the log (a window opened with an outdated preload does not). */
export function logAvailable(): boolean {
  try {
    return typeof window.starlight?.writeLog === 'function'
  } catch {
    return false
  }
}

/** Adds a log entry; never throws. */
export function writeLog(level: LogLevel, origin: LogOrigin, text: string, severe = false): void {
  if (!logAvailable()) return
  try {
    window.starlight.writeLog(level, origin, text, severe)
  } catch {
    // Bridge not available: the entry is lost, the program is not.
  }
}

/** Text of any error: message and stack trace, never the contents of objects. */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    const trace = e.stack ?? ''
    return trace.includes(e.message) ? trace : e.message + (trace ? '\n' + trace : '')
  }
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  try {
    return String(e)
  } catch {
    return 'error that cannot be described'
  }
}

/** Text of the notice shown when the main process fails. */
export function internalErrorNotice(): string {
  return t('rendererErrorLog.internalError')
}

/* ---- Unhandled window errors ---- */

/**
 * Messages of the worker errors just recorded: if the code that created the
 * worker does not handle an error, the same error reaches the window right
 * after, and it must not be written twice.
 */
const recentWorkerErrors = new Map<string, number>()

window.addEventListener('error', (event) => {
  // Code errors only: an image that fails to load does not arrive as an ErrorEvent.
  if (!(event instanceof ErrorEvent)) return
  const alreadySeen = recentWorkerErrors.get(event.message)
  if (alreadySeen !== undefined && performance.now() - alreadySeen < 2000) return
  const where = event.filename ? ' (' + event.filename + ':' + event.lineno + ':' + event.colno + ')' : ''
  const trace = event.error instanceof Error && event.error.stack ? '\n' + event.error.stack : ''
  writeLog('error', 'window', 'Unhandled error: ' + (event.message || 'no description') + where + trace)
})

window.addEventListener('unhandledrejection', (event) => {
  writeLog('error', 'window', 'Unhandled promise rejection: ' + errorText(event.reason))
})

/* ---- Workers and plugins ---- */

/** Readable name of a worker: the name given at creation, or the file. */
function workerName(address: string | URL, options?: WorkerOptions): string {
  if (options?.name) return options.name
  const text = String(address)
  if (text.startsWith('blob:')) return 'unnamed'
  return text.split('?')[0].split('/').pop() || text
}

/**
 * Options of a compute worker with the interface language at the end of its
 * name; plugins, which never receive it, keep theirs unchanged.
 */
function withLanguage(options: WorkerOptions | undefined): WorkerOptions | undefined {
  if (options?.name?.startsWith('plugin-')) return options
  return { ...options, name: nameWithLanguage(options?.name ?? '') }
}

const OriginalWorker = window.Worker
if (typeof OriginalWorker === 'function') {
  broadcastLanguageChanges()
  class WorkerWithLog extends OriginalWorker {
    constructor(address: string | URL, options?: WorkerOptions) {
      super(address, withLanguage(options))
      const name = workerName(address, options)
      const plugin = name.startsWith('plugin-')
      const who = plugin ? 'Plugin "' + name.slice('plugin-'.length) + '"' : 'Worker "' + name + '"'
      // One extra listener: the code that created the worker still receives
      // its own errors through onerror.
      this.addEventListener('error', (event: ErrorEvent) => {
        recentWorkerErrors.set(event.message, performance.now())
        if (recentWorkerErrors.size > 50) recentWorkerErrors.clear()
        const where = event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : ''
        writeLog('error', plugin ? 'plugin' : 'worker', who + ': ' + (event.message || 'error with no description') + where)
      })
      this.addEventListener('messageerror', () => {
        writeLog('error', plugin ? 'plugin' : 'worker', who + ': unreadable message.')
      })
    }
  }
  window.Worker = WorkerWithLog
}

/* ---- Notices shown ---- */

let lastNotice = 0

function noticeOrigin(a: Notice): LogOrigin {
  return /\bplugin\b/i.test(a.text) ? 'plugin' : 'ui'
}

useApp.subscribe((s, before) => {
  if (s.notices === before.notices) return
  for (const a of s.notices) {
    if (a.id <= lastNotice) continue
    lastNotice = a.id
    if (a.text === internalErrorNotice()) continue
    if (a.type === 'error') writeLog('error', noticeOrigin(a), 'Notice shown: ' + a.text)
    else if (a.type === 'warning') writeLog('warning', noticeOrigin(a), 'Notice shown: ' + a.text)
  }
})

/* ---- Main process errors ---- */

if (logAvailable()) {
  window.starlight.onInternalError(() => useApp.getState().notify('error', internalErrorNotice()))
}

/* ---- Window startup ---- */

/** The GPU as seen by the window (the one that runs the shader computations). */
function windowGraphics(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return 'WebGL 2 not available'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return name
  } catch {
    return 'not detected'
  }
}

writeLog(
  'info',
  'window',
  WINDOW_OPENED_PREFIX + windowGraphics() + '; screen ' + screen.width + '×' + screen.height +
    ', scale ' + window.devicePixelRatio
)
