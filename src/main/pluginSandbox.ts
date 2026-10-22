import { app, BrowserWindow, ipcMain, MessageChannelMain, type WebContents } from 'electron'
import { join } from 'node:path'
import { totalmem } from 'node:os'
import type { SandboxFailed } from '@shared/plugin'

/**
 * Plugin sandbox: a process separate from the interface where plugins run,
 * each in its own worker (see resources/sandbox/sandbox.html and
 * core/plugin/isolation.ts).
 *
 * Why a separate process: in Chromium a worker's memory cannot be capped,
 * and a worker that exhausts the JavaScript engine's heap brings down the
 * whole process hosting it. With the plugin inside the interface, a loop
 * that fills a list would close StarLight with all the open work (this was
 * tested). Here only this invisible page goes down: the interface receives a
 * notice, the plugin is suspended and the page is recreated on the next
 * request.
 *
 * In addition, during an execution the main process checks the memory used
 * by the sandbox every quarter of a second and kills it if it exceeds the
 * allowed limit: twelve times the image plus a 1.5 GB margin, never less than
 * 2 GB and never more than 60% of the computer's memory. A memory-hungry
 * plugin is thus stopped before it puts the whole system in trouble.
 *
 * Every execution has its own channel (MessageChannelMain) connecting the
 * interface directly to the sandbox: the image does not pass through here.
 *
 * A minute after the last execution ends the sandbox is closed, giving back
 * its memory; the next plugin recreates it.
 */

const WATCH_INTERVAL_MS = 250
const IDLE_CLOSE_MS = 60 * 1000

/**
 * Exit codes of a process that died from running out of memory, which
 * Electron reports as "crashed" rather than "oom": -36861 (0xFFFF7003) is the
 * one measured with a worker filling the JavaScript engine's heap
 * (Electron 44, Windows); 0xE0000008 is Chromium's out-of-memory code.
 */
const OUT_OF_MEMORY_CODES = [-36861, -536870904]
const MIN_BYTES = 2 * 1024 ** 3
const MARGIN_BYTES = 1.5 * 1024 ** 3

interface Execution {
  sender: WebContents
  limit: number
}

let sandbox: BrowserWindow | null = null
let ready: Promise<BrowserWindow> | null = null
let exceeded: number | null = null
let watchdog: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let nextId = 1
const executions = new Map<number, Execution>()
/** Every sandbox created, so it can still be recognized after it crashes. */
const sandboxContents = new WeakSet<WebContents>()

function resourcesFolder(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
}

/** True if these contents are the sandbox: its crash is not a StarLight crash. */
export function isPluginSandbox(contents: WebContents): boolean {
  return sandboxContents.has(contents)
}

/** Memory allowed for an execution with an image of this many bytes. */
export function memoryLimit(imageBytes: number): number {
  const cap = totalmem() * 0.6
  return Math.min(cap, Math.max(MIN_BYTES, 12 * Math.max(0, imageBytes) + MARGIN_BYTES))
}

function cancelIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function closeWhenIdle(): void {
  cancelIdleClose()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (executions.size === 0) destroy()
  }, IDLE_CLOSE_MS)
}

function destroy(): void {
  cancelIdleClose()
  const w = sandbox
  sandbox = null
  ready = null
  if (w && !w.isDestroyed()) w.destroy()
}

function crashed(reason: SandboxFailed['reason']): void {
  for (const [id, e] of executions) {
    if (!e.sender.isDestroyed()) {
      const c: SandboxFailed = { id, reason, limitMB: Math.round(e.limit / 1048576) }
      e.sender.send('sandbox:crashed', c)
    }
  }
  executions.clear()
  stopWatcher()
}

function open(appWindow: () => BrowserWindow | null): Promise<BrowserWindow> {
  if (ready && sandbox && !sandbox.isDestroyed()) return ready
  const w = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/sandbox.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      webgl: false
    }
  })
  sandbox = w
  const contents = w.webContents
  sandboxContents.add(contents)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (e) => e.preventDefault())
  contents.on('render-process-gone', (_e, details) => {
    // Killed by us for memory, or crashed on its own from running out of memory.
    const memory = exceeded !== null || details.reason === 'oom' || OUT_OF_MEMORY_CODES.includes(details.exitCode)
    exceeded = null
    crashed(memory ? 'memory' : 'crashed')
    if (sandbox === w) destroy()
  })
  w.on('closed', () => {
    if (sandbox === w) {
      sandbox = null
      ready = null
    }
  })
  // The sandbox lives with the StarLight window: when that closes, so does the sandbox.
  appWindow()?.once('closed', destroy)
  ready = w
    .loadFile(join(resourcesFolder(), 'sandbox', 'sandbox.html'))
    .then(() => w)
    .catch((e) => {
      destroy()
      throw e
    })
  return ready
}

function stopWatcher(): void {
  if (watchdog) clearInterval(watchdog)
  watchdog = null
}

function watch(): void {
  if (watchdog) return
  watchdog = setInterval(() => {
    const w = sandbox
    if (!w || w.isDestroyed() || executions.size === 0) {
      stopWatcher()
      return
    }
    const pid = w.webContents.getOSProcessId()
    const measurement = app.getAppMetrics().find((m) => m.pid === pid)
    if (!measurement) return
    // In kilobytes; on Windows, private memory not yet touched counts too.
    const wasUsed = Math.max(measurement.memory.workingSetSize, measurement.memory.privateBytes ?? 0) * 1024
    let limit = 0
    for (const e of executions.values()) limit += e.limit
    limit = Math.min(limit, totalmem() * 0.6)
    if (wasUsed > limit) {
      exceeded = wasUsed
      w.webContents.forcefullyCrashRenderer()
    }
  }, WATCH_INTERVAL_MS)
}

export function registerPluginSandbox(appWindow: () => BrowserWindow | null): void {
  ipcMain.handle('sandbox:open', async (event, imageBytes: number): Promise<number | null> => {
    // Only the StarLight window can request an execution.
    const app_ = appWindow()
    if (!app_ || event.sender !== app_.webContents) return null
    cancelIdleClose()
    let w: BrowserWindow
    try {
      w = await open(appWindow)
    } catch {
      return null
    }
    const id = nextId++
    const { port1, port2 } = new MessageChannelMain()
    w.webContents.postMessage('sandbox:port', { id }, [port2])
    event.sender.postMessage('sandbox:port', { id }, [port1])
    executions.set(id, {
      sender: event.sender,
      limit: memoryLimit(Number.isFinite(imageBytes) ? imageBytes : 0)
    })
    watch()
    return id
  })

  ipcMain.handle('sandbox:close', (_e, id: number): void => {
    executions.delete(id)
    if (executions.size === 0) {
      stopWatcher()
      closeWhenIdle()
    }
  })

  app.on('before-quit', destroy)
}
