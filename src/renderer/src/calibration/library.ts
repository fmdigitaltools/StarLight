import { create } from 'zustand'
import type { FrameMetadata, ImageData32 } from '@shared/types'
import { sharedUint16 } from '@shared/sharedMemory'
import { compactMaster, type KeptMaster } from '@core/stack/compactFrame'
import type { MasterType } from '@core/stack/calibration'
import {
  conditionsOf,
  quantize,
  unmosaic,
  type FrameConditions,
  type MasterEntry
} from '@core/stack/calibrationLibrary'
import { masterConditions, chooseForLight } from '@core/stack/calibrationGroups'
import { calibrationLibraryReuse } from '../settings'

/**
 * Calibration library on the interface side: the list of stored masters,
 * saving the masters built in the Calibrate panel, and reading the masters to
 * reuse during stacking. The frame-by-frame choice lives in
 * core/stack/calibrationGroups.ts (`chooseForLight`).
 *
 * Masters read from disk stay in memory while needed: a session usually uses
 * one per type and per group of lights, and reading them again for every
 * frame would cost far more than the computation. They are kept as they are
 * on disk, 16-bit codes in the sensor layout (`compactMaster`): calibration
 * rebuilds from them, region by region, the same values as the full master.
 */

interface LibraryState {
  entries: MasterEntry[]
  loaded: boolean
}

export const useCalibrationLibrary = create<LibraryState>(() => ({ entries: [], loaded: false }))

export async function reloadLibrary(): Promise<MasterEntry[]> {
  try {
    const entries = await window.starlight.calibrationLibraryList()
    useCalibrationLibrary.setState({ entries, loaded: true })
    return entries
  } catch {
    useCalibrationLibrary.setState({ loaded: true })
    return []
  }
}

void reloadLibrary()

/**
 * Stores a newly built master in the library, with the capture conditions of
 * the frames it was built from (`masterConditions`, the same as for the
 * session master). Each group of the Calibrate panel becomes a separate
 * entry. Returns the saved entry.
 */
export async function saveToLibrary(
  type: MasterType,
  master: ImageData32,
  meta: FrameMetadata[],
  defectivePixels: number,
  flatCorrection: 'dark' | 'bias' | null
): Promise<MasterEntry> {
  const conditions = masterConditions(type, master.width, master.height, master.channels, meta)
  const kept = unmosaic(master, conditions.bayer)
  const { values, minimum, max } = quantize(kept.data)
  const entry = await window.starlight.saveCalibrationMaster(
    {
      ...conditions,
      planes: kept.channels,
      defectivePixels,
      flatCorrection,
      minimum,
      max
    },
    values.buffer as ArrayBuffer
  )
  memory.clear()
  await reloadLibrary()
  return entry
}

export async function removeFromLibrary(id: string): Promise<void> {
  await window.starlight.removeCalibrationMaster(id)
  memory.delete(id)
  await reloadLibrary()
}

/* ---- Cached reading ---- */

const memory = new Map<string, Promise<KeptMaster>>()
/**
 * Maximum number of masters kept in memory: enough for two groups of lights
 * with different conditions (a dark and a flat each).
 */
const MAX_IN_MEMORY = 4

/**
 * The master ready for calibration: read and kept in memory in compact form;
 * to get it whole, use `expand` (core/stack/compactFrame.ts).
 */
export function loadMaster(entry: MasterEntry): Promise<KeptMaster> {
  const known = memory.get(entry.id)
  if (known) {
    // The most recently used moves to the end: with several groups of lights
    // the least recently used master is evicted, not the first one read.
    memory.delete(entry.id)
    memory.set(entry.id, known)
    return known
  }
  const promise = (async () => {
    const readCount = new Uint16Array(await window.starlight.readCalibrationMaster(entry.id))
    // In shared memory: it travels with the compact frames to the summing
    // workers, which therefore do not receive copies of it.
    const codes = sharedUint16(readCount.length)
    codes.set(readCount)
    return compactMaster({ width: entry.width, height: entry.height, planes: entry.planes, codes }, entry.bayer, entry.minimum, entry.max)
  })()
  promise.catch(() => memory.delete(entry.id))
  memory.set(entry.id, promise)
  while (memory.size > MAX_IN_MEMORY) memory.delete(memory.keys().next().value as string)
  return promise
}

/* ---- Choice during stacking ---- */

/**
 * The library entries to consider during stacking: all of them if reuse is
 * on, none if it is off.
 */
export async function entriesToReuse(): Promise<MasterEntry[]> {
  if (!calibrationLibraryReuse()) return []
  return useCalibrationLibrary.getState().loaded ? useCalibrationLibrary.getState().entries : await reloadLibrary()
}

/**
 * How many masters the library could load during stacking, for the memory
 * estimate: for each light condition, the masters the session lacks and the
 * library has (`chooseForLight`), counted once. At most MAX_IN_MEMORY stay in
 * memory: the others are read again from disk when needed.
 */
export async function possibleMastersToLoad(lights: FrameConditions[], session: MasterEntry[]): Promise<number> {
  const entries = await entriesToReuse()
  if (entries.length === 0) return 0
  const ids = new Set<string>()
  const views = new Set<string>()
  for (const c of lights) {
    const key = [
      c.width,
      c.height,
      c.channels,
      c.bayer,
      c.exposure,
      c.gain,
      c.temperature === null ? '' : Math.round(c.temperature),
      c.instrument,
      c.filter,
      (c.data ?? '').slice(0, 10)
    ].join('|')
    if (views.has(key)) continue
    views.add(key)
    const choice = chooseForLight(session, entries, c)
    for (const m of [choice.dark, choice.flat, choice.bias]) if (m && m.origin === 'library') ids.add(m.entry.id)
  }
  return Math.min(ids.size, MAX_IN_MEMORY)
}

export { conditionsOf }
