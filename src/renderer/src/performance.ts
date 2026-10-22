import { create } from 'zustand'
import {
  settingsReady,
  readSettings,
  writeSettings,
  subscribeSettings,
  updatePreferences,
  DEFAULT_SETTINGS,
  type Settings
} from './settings'
import { automaticWorkers } from './workers/pool'
import {
  PERFORMANCE_ENTRIES,
  softwareRendering,
  choicesRecap,
  choicesForComputer,
  type ComputerData,
  type PerformanceChoices
} from '@core/automaticPerformance'

/**
 * Performance, interface side.
 *
 * - Computing priority: when the setting changes it is sent to the main
 *   process, which applies it immediately (src/main/performance.ts).
 * - Settings chosen for this computer: at the first startup the computer is
 *   measured and threads, memory, GPU, hardware acceleration and priority
 *   are chosen (the rule is in @core/automaticPerformance). The entries stay
 *   editable by hand; the optimise-for-this-computer button of the
 *   Performance tab repeats the choice, shows what would change and applies
 *   it only after confirmation.
 *
 * The module is loaded with the Settings window, which is part of the
 * interface from startup (MenuBar.tsx).
 */

/* ---- Computing priority ---- */

let prioritySent: boolean | null = null
subscribeSettings(() => {
  const low = readSettings().lowPriorityComputation
  if (low === prioritySent) return
  prioritySent = low
  // With an outdated bridge (page reloaded during development) the function may be missing.
  void window.starlight.setComputePriority?.(low)
})

/* ---- GPU in use ---- */

/** Name of the GPU that renders the viewer, and whether its WebGL 2 context can be created. */
export function testGraphics(): { webgl2: boolean; name: string | null } {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) return { webgl2: false, name: null }
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  const complete = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null
  // The test context is released immediately: only a few contexts can be open.
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  if (!complete) return { webgl2: true, name: null }
  // "ANGLE (vendor, device name (0x…) Direct3D11 …)": only the device name is kept.
  const parts = complete.replace(/^ANGLE \(/, '').replace(/\)$/, '').split(',')
  const name = (parts[1] ?? parts[0]).replace(/\s*\(0x[0-9a-f]+\)/i, '').replace(/\s*Direct3D.*$/i, '').trim()
  return { webgl2: true, name: name || complete }
}

export { softwareRendering }

/* ---- Settings chosen for this computer ---- */

/** What was chosen, when and on which computer. Stored in the preferences under `KEY`. */
export interface RecordedChoice {
  /** Time of the choice, in ISO format. */
  data: string
  computerData: ComputerData
  choices: PerformanceChoices
}

const KEY = 'performanceChoices'

export const useComputerChoice = create<{ registered: RecordedChoice | null }>(() => ({ registered: null }))

/** Measures the computer. Null if the bridge does not provide the measurements (outdated bridge during development). */
export async function measureComputer(): Promise<ComputerData | null> {
  const measurements = await window.starlight.computerMeasurements?.()
  if (!measurements) return null
  const graphics = testGraphics()
  return {
    logicalProcessors: measurements.logicalProcessors,
    totalRam: measurements.totalRam,
    automaticThreads: automaticWorkers(),
    webgl2: graphics.webgl2,
    accelerationActive: window.starlight.startupChoices?.().graphicsAcceleration ?? true,
    gpuName: graphics.name,
    vendors: measurements.gpus.map((s) => s.vendor),
    onBattery: measurements.onBattery
  }
}

/** The current choices of the Performance tab. */
export function currentChoices(settings: Settings = readSettings()): PerformanceChoices {
  return {
    analysisWorkers: settings.analysisWorkers,
    frameMemoryGB: settings.frameMemoryGB,
    gpu: settings.gpu,
    graphicsAcceleration: settings.graphicsAcceleration,
    lowPriorityComputation: settings.lowPriorityComputation
  }
}

/** Summary to show for a recorded choice. */
export function recap(r: RecordedChoice): string {
  return choicesRecap(r.computerData, r.choices)
}

function recordChoices(data: ComputerData, choices: PerformanceChoices): Promise<void> {
  const registered: RecordedChoice = { data: new Date().toISOString(), computerData: data, choices }
  useComputerChoice.setState({ registered })
  return updatePreferences({ [KEY]: registered })
}

/**
 * Applies the computed choices (after the button confirmation) and records
 * them. Every entry takes the computed value.
 */
export async function applyChoices(data: ComputerData, choices: PerformanceChoices): Promise<void> {
  await writeSettings(choices)
  await recordChoices(data, choices)
}

/** Reads the recorded choice, if any. */
function fromPreferences(prefs: Record<string, unknown>): RecordedChoice | null {
  const r = prefs[KEY] as Partial<RecordedChoice> | undefined
  if (!r || typeof r !== 'object' || typeof r.data !== 'string' || !r.computerData || !r.choices) return null
  return r as RecordedChoice
}

/**
 * First startup: if there is no recorded choice yet, the computer is
 * measured and the computed values are applied silently. Only the entries
 * still at their installation values are changed: users who update StarLight
 * and had already chosen something by hand find it unchanged. It starts a
 * few seconds after opening, so it does not slow it down.
 */
async function firstStartup(): Promise<void> {
  const settings = await settingsReady()
  const prefs = await window.starlight.readPreferences()
  const alreadyDone = fromPreferences(prefs)
  if (alreadyDone) {
    useComputerChoice.setState({ registered: alreadyDone })
    return
  }
  await new Promise((r) => setTimeout(r, 4000))
  const data = await measureComputer()
  if (!data) return
  const choices = choicesForComputer(data)
  const defaults = currentChoices(DEFAULT_SETTINGS)
  const current = currentChoices(settings)
  const toChange: Partial<PerformanceChoices> = {}
  for (const { key } of PERFORMANCE_ENTRIES) {
    if (current[key] === defaults[key]) Object.assign(toChange, { [key]: choices[key] })
  }
  await writeSettings(toChange)
  await recordChoices(data, choices)
}

void firstStartup().catch(() => {
  // Without the automatic choice the defaults remain, which work everywhere.
})
