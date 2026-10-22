import { create } from 'zustand'
import type { ImageData32 } from '@shared/types'
import { VALUES_PER_CHUNK, type RecoveryCopy, type RecoveryImage } from '@shared/recovery'
import { APP_VERSION } from '@shared/version'
import { PROJECT_FILE_NAME, serializeProject, joinPath } from '@core/project'
import { useApp } from '../store/appStore'
import { readSettings, subscribeSettings } from '../settings'
import { PROJECT_FIELDS, openFromPath, contentToSave, hasUnsavedWork, proposedName } from './useProject'
import { t, formatDate } from '@shared/i18n/i18n'

/**
 * Automatic save for crash recovery.
 *
 * When there is unsaved work and nothing has been touched for half a minute,
 * StarLight stores a copy of it in the application data folder (written by
 * src/main/recovery.ts). This is not a project save: the user's project is
 * never touched, and no project is created without the user knowing. The
 * copy is removed when the work is actually saved, when the project is
 * closed and when the application shuts down normally; if it is still there
 * at startup, StarLight did not shut down cleanly and offers to recover it
 * (`suggestRecovery`).
 *
 * To keep it fast, the images (the heavy part) are rewritten only when they
 * change (after processing, not after moving a slider), and the main process
 * encodes them. All that is left here is composing the project text. No save
 * happens during a long operation (stacking, processing): it waits for it
 * to finish.
 */

/** Idle time required after the last change before saving the copy. */
const QUIET_MS = 30000

/** Saving starts only after the startup decision about the previous copy. */
let enabled = false
let timer = 0
/** True if there is a change not yet in the copy. */
let toSave = false
let inProgress = false
/** True if a copy written by this session (or recovered) is on disk. */
let copyPresent = false
/**
 * Images already in the copy, with their file names. An unchanged image is
 * not rewritten: saving an adjustment writes only the text file.
 */
let labels: { image: ImageData32; name: string }[] = []
let sequential = 0

/** Timings of the last save, in milliseconds (for tests). */
export interface RecoveryMeasurement {
  /** Total work on the UI thread: composing the text and handing over the data. */
  ui: number
  /** Longest stretch during which the UI stayed busy without a break. */
  longest: number
  /** From the start to the end of the disk write. */
  total: number
  /** Images rewritten. */
  images: number
}
let lastMeasurement: RecoveryMeasurement | null = null

/** Timings of the last automatic save; null if there has not been one yet. */
export function measureRecovery(): RecoveryMeasurement | null {
  return lastMeasurement
}

function active(): boolean {
  return enabled && readSettings().recoverySave
}

function cancelTimer(): void {
  window.clearTimeout(timer)
  timer = 0
}

function program(): void {
  cancelTimer()
  timer = window.setTimeout(() => void saveCopy(), QUIET_MS)
}

/** Nothing to recover: removes the copy, if any. */
function removeCopy(): void {
  cancelTimer()
  toSave = false
  if (!copyPresent) return
  copyPresent = false
  labels = []
  void window.starlight.removeRecovery().catch(() => undefined)
}

useApp.subscribe((s, before) => {
  if (!enabled) return
  if (!active() || !hasUnsavedWork()) {
    removeCopy()
    return
  }
  const changedValue = PROJECT_FIELDS.some((k) => s[k] !== before[k]) || s.modified !== before.modified
  if (changedValue) {
    toSave = true
    program()
  } else if (toSave && before.job.active && !s.job.active) {
    // A long operation finished: restart the idle countdown.
    program()
  }
})

// Turned off in the settings: the copy is removed immediately; turned back
// on, it is saved at the next idle period.
subscribeSettings(() => {
  if (!enabled) return
  if (!readSettings().recoverySave) removeCopy()
  else if (hasUnsavedWork() && !copyPresent && timer === 0) {
    toSave = true
    program()
  }
})

function newName(base: string): string {
  return base + '-' + Date.now().toString(36) + '-' + ++sequential + '.fit'
}

/** Lets the UI breathe between chunks. */
function pause(): Promise<void> {
  return new Promise((r) => window.setTimeout(r, 0))
}

/**
 * Sends an image's pixels to the main process in chunks. Each chunk is a
 * separate copy (`slice`, not `subarray`: the bridge would copy the whole
 * underlying buffer for every chunk); this also works with the shared memory
 * of stacking results, which the bridge would not accept as is.
 */
async function sendPixels(name: string, image: ImageData32, measurement: (ms: number) => void): Promise<void> {
  const data = image.data
  for (let start = 0; start < data.length; start += VALUES_PER_CHUNK) {
    const t0 = performance.now()
    const sending = window.starlight.recoveryData(name, data.length, start, data.slice(start, start + VALUES_PER_CHUNK))
    measurement(performance.now() - t0)
    await sending
    await pause()
  }
}

/** Writes the recovery copy of the current work. */
async function saveCopy(): Promise<void> {
  timer = 0
  const s = useApp.getState()
  if (!active() || !hasUnsavedWork()) return
  // Never during a long operation, nor on top of a save in progress: it is
  // retried at the end (see the subscription above).
  if (s.job.active) return
  if (inProgress) {
    program()
    return
  }
  inProgress = true
  toSave = false
  const start = performance.now()
  let ui = 0
  let longest = 0
  const measurement = (ms: number): void => {
    ui += ms
    longest = Math.max(longest, ms)
  }
  try {
    // The whole state is captured now, in one go: images in the store are
    // never modified in place, only replaced, so those taken here stay valid
    // even if work continues in the meantime.
    const { state, originalDiffers, cards, fitsOptions, shownOptions } = contentToSave(
      s.project?.name ?? proposedName()
    )

    // Images: reused if already in the copy, otherwise given a new name.
    const newOnes: { meta: RecoveryImage; image: ImageData32 }[] = []
    const timeText: { image: ImageData32; name: string }[] = []
    const nameOf = (image: ImageData32, base: string, wcs: typeof fitsOptions.wcs): string => {
      const already = labels.find((x) => x.image === image) ?? timeText.find((x) => x.image === image)
      const name = already?.name ?? newName(base)
      if (!already) {
        const { width, height, channels } = image
        newOnes.push({ meta: { name, width, height, channels, cards, wcs }, image })
      }
      if (!timeText.some((x) => x.image === image)) timeText.push({ image, name })
      return name
    }
    state.image = s.image ? nameOf(s.image, 'image', shownOptions.wcs) : null
    state.originalImage =
      originalDiffers && s.originalImage ? nameOf(s.originalImage, 'original', fitsOptions.wcs) : null

    const text = serializeProject(state, APP_VERSION)
    const info = { project: s.project, savedAt: new Date().toISOString(), cleanShutdown: false }
    measurement(performance.now() - start)

    for (const n of newOnes) await sendPixels(n.meta.name, n.image, measurement)
    const t0 = performance.now()
    const writing = window.starlight.saveRecovery(
      text,
      newOnes.map((n) => n.meta),
      timeText.map((x) => x.name),
      info
    )
    measurement(performance.now() - t0)
    // The rest (encoding and writing) is done by the main process.
    await writing
    labels = timeText
    copyPresent = true
    lastMeasurement = { ui, longest, total: performance.now() - start, images: newOnes.length }
    // The project was saved in the meantime: the copy just written is not needed.
    if (!hasUnsavedWork()) removeCopy()
  } catch {
    // A failed automatic save is silent: it is retried at the next change.
    toSave = true
  } finally {
    inProgress = false
  }
}

/* ---- At startup ---- */

/** State of the recovery window shown after an unclean shutdown, driven from here. */
export const useRecoveryWindow = create<{
  copy: RecoveryCopy | null
  choose: ((recover: boolean) => void) | null
}>(() => ({ copy: null, choose: null }))

export type RecoveryResult = 'recovered' | 'discarded' | 'none'

let proposal: Promise<RecoveryResult> | null = null

/**
 * At startup: if the previous shutdown was not clean and left a copy, asks
 * whether to recover it. Must be called before opening anything else (last
 * project, file opened by double-click). When called several times, it asks
 * only once.
 */
export function suggestRecovery(): Promise<RecoveryResult> {
  proposal ??= (async (): Promise<RecoveryResult> => {
    try {
      const copy = await window.starlight.readRecovery()
      if (copy === null) return 'none'
      const recover = await new Promise<boolean>((choose) => {
        useRecoveryWindow.setState({ copy, choose })
      })
      useRecoveryWindow.setState({ copy: null, choose: null })
      if (!recover) {
        await window.starlight.removeRecovery().catch(() => undefined)
        return 'discarded'
      }
      return (await openCopy(copy)) ? 'recovered' : 'discarded'
    } catch {
      return 'none'
    } finally {
      enabled = true
    }
  })()
  return proposal
}

/** Opens the copy as a project, linked to the original project if it still exists. */
async function openCopy(copy: RecoveryCopy): Promise<boolean> {
  let project = copy.info.project
  if (project !== null) {
    const [exists] = await window.starlight.exist([joinPath(project.folder, PROJECT_FILE_NAME)])
    if (!exists) project = null
  }
  const ok = await openFromPath(copy.path, { project })
  // Decision made: from now on a clean shutdown deletes the copy.
  window.starlight.recoveryDecided()
  if (!ok) return false
  // The copy on disk matches the work just opened: its images need not be
  // rewritten at the next automatic save.
  try {
    const raw = JSON.parse(new TextDecoder().decode(await window.starlight.readFile(copy.path))) as Record<
      string,
      unknown
    >
    const s = useApp.getState()
    const imageName = raw['image']
    const originalName = raw['originalImage']
    labels = []
    if (s.image && typeof imageName === 'string') labels.push({ image: s.image, name: imageName })
    if (s.originalImage && s.originalImage !== s.image && typeof originalName === 'string') {
      labels.push({ image: s.originalImage, name: originalName })
    }
  } catch {
    labels = []
  }
  copyPresent = true
  return true
}

/** Save time in words ("at 22:41"), with the day if it is not today. */
export function whenSaved(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = formatDate(d, { hour: '2-digit', minute: '2-digit' })
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return t('hooksRecovery.whenSaved.today', { time })
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return t('hooksRecovery.whenSaved.yesterday', { time })
  const date = formatDate(d, { day: 'numeric', month: 'long' })
  return t('hooksRecovery.whenSaved.otherDay', { date, time })
}
