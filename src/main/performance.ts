/*
 * Performance, main process side: graphics card and hardware acceleration
 * (chosen at startup), computation priority, disk space.
 *
 * The graphics card and acceleration can only be chosen before the app is
 * ready, so `prepareGraphicsAtStartup` reads the preferences file by itself,
 * before anything else, and the choices hold until the app closes. The
 * interface asks for them with `performance:startup` to know whether the saved
 * ones are already in use or waiting for a restart.
 *
 * Computation priority. The heavy computations (analysis, alignment,
 * stacking) run in the page's threads, that is in the window process:
 * lowering its priority keeps the computer responsive for other work, at the
 * cost of a few extra seconds. It applies immediately and at every startup.
 */
import { app, ipcMain, powerMonitor, session, type WebContents } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { constants, cpus, homedir, setPriority, totalmem } from 'node:os'
import {
  WINDOW_MEMORY_FOLDERS,
  DEFAULT_STARTUP_CHOICES,
  startupChoices,
  type ComputerMeasurements,
  type StartupChoices,
  type SpaceEntry
} from '@shared/performance'
import { RECOVERY_FOLDER } from '@shared/recovery'
import { LOG_FOLDER } from '@shared/log'
import { folderSize } from './folderSize'
import { writeLog } from './log'

/** The choices this session started with. */
let inUse: StartupChoices = DEFAULT_STARTUP_CHOICES

/** Marker left by "Clear": the window cache is deleted at the next startup. */
const CLEAR_WINDOW_MARKER = 'clear-window-memory'

/**
 * Reads the choices from the preferences file and sets up graphics
 * accordingly. Must be called before the app is ready.
 */
export function prepareGraphicsAtStartup(): StartupChoices {
  try {
    const text = readFileSync(join(app.getPath('userData'), 'preferences.json'), 'utf-8')
    inUse = startupChoices((JSON.parse(text) as Record<string, unknown>)['settings'])
  } catch {
    // First run or unreadable file: default values.
    inUse = DEFAULT_STARTUP_CHOICES
  }

  /*
   * On computers with two graphics cards the dedicated one is requested: the
   * image adjustment chain runs in shaders, so the difference shows in how
   * smoothly the sliders respond. With "Power saving" the choice is left to
   * the system, which usually picks the integrated card.
   */
  if (inUse.gpu === 'high-performance') app.commandLine.appendSwitch('force_high_performance_gpu')

  /*
   * Without acceleration, rendering is done by the CPU. The viewer still uses
   * WebGL 2, which in this case must be explicitly allowed for software
   * rendering: otherwise the context is not created and the viewer stays
   * blank.
   */
  if (!inUse.graphicsAcceleration) {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  }
  lowPriority = inUse.lowPriorityComputation
  return inUse
}

/**
 * Deletes the window cache if "Clear" was pressed last time. It happens here,
 * before the graphics card starts working, because those files are in use
 * while the app is open. Must be called only by the instance holding the
 * single-instance lock: a second launch must not touch the files of the one
 * already open.
 */
export function clearWindowMemoryIfRequested(): void {
  const sign = join(app.getPath('userData'), CLEAR_WINDOW_MARKER)
  if (!existsSync(sign)) return
  const base = app.getPath('sessionData')
  for (const name of WINDOW_MEMORY_FOLDERS) {
    try {
      rmSync(join(base, name), { recursive: true, force: true })
    } catch {
      // A locked file (antivirus) stays: it will be retried another time.
    }
  }
  rmSync(sign, { force: true })
}

/* ---- Computation priority ---- */

let lowPriority = false
let window: WebContents | null = null
let repetition: ReturnType<typeof setInterval> | null = null

/**
 * Applies the chosen priority to the window process. When the priority is
 * normal and has never been lowered nothing is touched: the system remains
 * free to manage it as usual.
 */
function applyPriority(alsoNormal: boolean): boolean {
  if (!window || window.isDestroyed()) return false
  if (!lowPriority && !alsoNormal) return true
  const pid = window.getOSProcessId()
  if (!pid) return false
  try {
    setPriority(pid, lowPriority ? constants.priority.PRIORITY_BELOW_NORMAL : constants.priority.PRIORITY_NORMAL)
    return true
  } catch (e) {
    writeLog('warning', 'main', 'Computation priority not changed: ' + (e instanceof Error ? e.message : String(e)))
    return false
  }
}

/**
 * Keeps the chosen priority even when the system changes it on its own (for
 * example when the window returns to the foreground): while it is low it is
 * reapplied periodically, a call of a few microseconds.
 */
function updateRepetition(): void {
  if (lowPriority && !repetition) {
    repetition = setInterval(() => applyPriority(false), 15_000)
  } else if (!lowPriority && repetition) {
    clearInterval(repetition)
    repetition = null
  }
}

/** Binds the priority to the main window: it is applied at every page load. */
export function followComputePriority(contents: WebContents): void {
  window = contents
  // A reloaded page, or one restarted after a crash, may have a new process.
  contents.on('dom-ready', () => applyPriority(false))
  updateRepetition()
}

/* ---- Disk space ---- */

/** Folder where the updater keeps the downloaded versions. */
function updatesFolder(): string {
  // Same name as updaterCacheDirName in updates.ts.
  const name = 'starlight-updater'
  return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), name)
}

async function listDiskUsage(): Promise<SpaceEntry[]> {
  const data = app.getPath('userData')
  const base = app.getPath('sessionData')
  const measurementsWindow = await Promise.all(WINDOW_MEMORY_FOLDERS.map((n) => folderSize(join(base, n))))
  const entry = async (id: SpaceEntry['id'], path: string): Promise<SpaceEntry> => ({
    id,
    path,
    ...(await folderSize(path))
  })
  return [
    {
      id: 'window',
      path: base,
      byte: measurementsWindow.reduce((a, m) => a + m.byte, 0),
      file: measurementsWindow.reduce((a, m) => a + m.file, 0),
      clearOnNextStartup: existsSync(join(data, CLEAR_WINDOW_MARKER))
    },
    await entry('log', join(data, LOG_FOLDER)),
    await entry('recovery', join(data, RECOVERY_FOLDER)),
    await entry('updates', updatesFolder())
  ]
}

/** Handlers for the interface. */
export function registerPerformance(): void {
  // Synchronous: the preload bridge asks once, before the page starts.
  ipcMain.on('performance:startup', (e) => {
    e.returnValue = inUse
  })

  ipcMain.handle('performance:priority', (_e, low: boolean): boolean => {
    const before = lowPriority
    lowPriority = low === true
    updateRepetition()
    // When switching back to normal, the priority is actually restored once.
    return applyPriority(before !== lowPriority)
  })

  /*
   * Current StarLight resource usage, summed over all its processes (main,
   * window with its workers, GPU, helpers): CPU as a percentage of the whole
   * computer and the memory actually in use. Electron measures the CPU since
   * the previous call, so the interface repeats it at regular intervals.
   *
   * Memory is each process's private memory: the working set would count the
   * system libraries shared by all the processes once per process, showing
   * more than twice the real figure at rest.
   */
  ipcMain.handle('performance:usage', (): { cpu: number; memory: number } => {
    let cpu = 0
    let memory = 0
    for (const p of app.getAppMetrics()) {
      cpu += p.cpu.percentCPUUsage
      memory += (p.memory.privateBytes ?? p.memory.workingSetSize) * 1024
    }
    // Electron's percentage refers to a single core.
    return { cpu: Math.min(100, cpu / Math.max(1, cpus().length)), memory }
  })

  ipcMain.handle('performance:measurements', async (): Promise<ComputerMeasurements> => {
    let gpus: ComputerMeasurements['gpus'] = []
    try {
      const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId?: number; active?: boolean }[] }
      gpus = (info.gpuDevice ?? []).map((g) => ({ vendor: Number(g.vendorId ?? 0), active: g.active === true }))
    } catch {
      // Without information about the cards, the decision falls back on the renderer name reported by the viewer.
    }
    return {
      logicalProcessors: cpus().length,
      totalRam: totalmem(),
      onBattery: powerMonitor.isOnBatteryPower(),
      gpus
    }
  })

  ipcMain.handle('diskSpace:list', (): Promise<SpaceEntry[]> => listDiskUsage())

  /*
   * Window cache: the page part is cleared immediately through the session
   * API; the graphics card part is in use and is deleted at the next
   * startup, before it is needed again.
   */
  ipcMain.handle('diskSpace:clearWindow', async (): Promise<void> => {
    await session.defaultSession.clearCache()
    await session.defaultSession.clearCodeCaches({})
    const data = app.getPath('userData')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, CLEAR_WINDOW_MARKER), new Date().toISOString(), 'utf-8')
  })
}
