/**
 * Performance: choices and messages shared by the main process
 * (src/main/performance.ts), the bridge and the interface (Performance tab of
 * the Settings, renderer/src/performance.ts).
 *
 * Three choices must be read by the main process before the window exists,
 * so directly from the preferences file:
 * - which GPU to request from the system (takes effect at the next startup);
 * - whether to use hardware acceleration (takes effect at the next startup);
 * - whether to lower the priority of the computing process (takes effect
 *   immediately and at every startup).
 * There is a single reader, `startupChoices`, also used by the interface, so
 * a value edited by hand in the file is interpreted the same way by both
 * sides.
 */

/** GPU requested from the system on computers that have two. */
export type Gpu = 'high-performance' | 'low-power'

/** The performance choices the main process reads at startup. */
export interface StartupChoices {
  gpu: Gpu
  graphicsAcceleration: boolean
  lowPriorityComputation: boolean
}

export const DEFAULT_STARTUP_CHOICES: StartupChoices = {
  gpu: 'high-performance',
  graphicsAcceleration: true,
  lowPriorityComputation: false
}

/**
 * The choices stored in the `settings` object of the preferences file.
 * A missing value or one of the wrong type takes the default: a damaged file
 * must not prevent startup.
 */
export function startupChoices(settings: unknown): StartupChoices {
  const g = (settings !== null && typeof settings === 'object' ? settings : {}) as Record<string, unknown>
  const p = DEFAULT_STARTUP_CHOICES
  return {
    gpu: g['gpu'] === 'low-power' ? 'low-power' : 'high-performance',
    graphicsAcceleration:
      typeof g['graphicsAcceleration'] === 'boolean' ? g['graphicsAcceleration'] : p.graphicsAcceleration,
    lowPriorityComputation:
      typeof g['lowPriorityComputation'] === 'boolean' ? g['lowPriorityComputation'] : p.lowPriorityComputation
  }
}

/* ---- Disk space ---- */

/** The things StarLight keeps on disk by itself. */
export type SpaceId = 'window' | 'log' | 'recovery' | 'updates'

export interface SpaceEntry {
  id: SpaceId
  /** Bytes used right now. */
  byte: number
  /** Number of files. */
  file: number
  /** Folder where it lives (the main one, if there are several). */
  path: string
  /**
   * Only for `window`: part of it is cleared at the next startup, because
   * those files are in use while the program is open.
   */
  clearOnNextStartup?: boolean
}

/**
 * Folders of the window's temporary cache inside the data folder: prepared
 * pages and code (Cache, Code Cache) and compiled GPU programs (all the
 * others). They are recreated automatically.
 */
export const WINDOW_MEMORY_FOLDERS: readonly string[] = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache'
]

/** Computer measurements collected by the main process, for the optimisation. */
export interface ComputerMeasurements {
  /** Logical processors reported by the system. */
  logicalProcessors: number
  /** Installed memory, in bytes. */
  totalRam: number
  /** True if the computer is currently on battery (so it is a laptop). */
  onBattery: boolean
  /** GPUs seen by the system: vendor and whether it is the one in use. */
  gpus: { vendor: number; active: boolean }[]
}
