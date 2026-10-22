import { create } from 'zustand'
import type { LoadedFrame } from '@shared/types'
import type { WatcherEvent, WatchMode } from '@shared/watcher'
import type { AlignmentResult } from '@core/stack/alignment'
import { readFitsHeaderOnly } from '@core/fits/reader'
import { hasRawExtension } from '@core/raw/rawFormats'
import { prepareRawInBrowser } from '../workers/libraw'
import { autoStretch } from '@core/image/stretch'
import { DEFAULT_MIN_QUALITY } from '@core/stars/detection'
import { compactPlanes, estimateStacking, type FrameToEstimate } from '@core/memoryEstimate'
import { useApp } from '../store/appStore'
import { frameCache } from './useLibrary'
import { analysisWorkerPool, stackingWorkerPool } from '../workers/pool'
import { updatePreferences, settingsReady } from '../settings'
import { t } from '@shared/i18n/i18n'
import {
  analyzeFrame,
  stackAnalyzed,
  frameReasonText,
  type FrameResult,
  type AnalyzedFrame,
  type StartOptions
} from './useStacking'

/*
 * Live session: stacking while capturing.
 *
 * The main process watches the folder where frames arrive and signals when
 * one is complete. Here each new frame is read once, analyzed by the worker
 * pool and kept in memory ready to use; then the stack is redone with all
 * frames collected so far and the image in the viewer is updated.
 *
 * The alignment reference stays the one chosen at the first stack, so the
 * image does not jump between updates, and frames already aligned to it are
 * not realigned. The sum, however, is rebuilt from all frames every time:
 * rejection (sigma clipping) needs all values of a pixel at once, and with
 * band splitting it takes only a few seconds even on a hundred frames.
 *
 * The quality score is relative to the best frames of the session, so it
 * changes as new frames arrive. Frames already accepted are re-evaluated at
 * every stack: if the capture starts under thin clouds and the sky then
 * clears, the first frames drop below the threshold and leave the sum, which
 * thus stays identical to what "Align and stack" would give once the session
 * is over. Keeping them forever would prevent the stacked frame count from
 * occasionally dropping, but would leave exactly the worst frames in the
 * result. An excluded frame stays in the library and is listed among the
 * rejected ones with its reason. The reference stays fixed until it too falls
 * below the threshold (see `stackAnalyzed`).
 *
 * The crop of edges covered by few frames is also recomputed at every
 * update: the image displayed in the viewer resets it anyway.
 *
 * Memory. Every ready frame stays in memory at full resolution until the end
 * of the session, so before accepting one the same rule as regular stacking
 * (core/memoryEstimate.ts) estimates whether it fits alongside those already
 * held. Free memory is measured at startup, before the session's frames
 * occupy it: measuring later would count those already held twice. When
 * memory runs out the session stops and the result so far stays in the
 * viewer. A running sum keeping only the total would allow continuing, but it
 * cannot re-evaluate the quality of frames already summed nor apply
 * rejection, and would give a result different from "Align and stack".
 *
 * Arrived files wait in a short queue: at most as many concurrent reads as
 * there are workers, so even with hundreds of files already in the folder
 * their contents are not all in memory at once.
 *
 * The state lives outside the components: changing workflow step closes the
 * panel, but the session must keep running.
 */

/** Preferences key holding the last folder used. */
const FOLDER_KEY = 'liveSession.folder'

export interface RejectedFrame {
  fileName: string
  reason: string
}

export interface NoisePoint {
  /** Frames included in the sum. */
  frame: number
  /** Noise of the result. */
  noise: number
  /** Noise of the reference frame alone, for comparison. */
  singleNoise: number
}

export interface SessionState {
  active: boolean
  folder: string
  mode: WatchMode | null
  reachable: boolean
  /** Explanation to show if the folder does not respond. */
  networkNotice: string | null
  /** Files that have appeared and are still being written. */
  incoming: string[]
  /** Complete files received (readable or not). */
  arrived: number
  /** Frames read and analyzed successfully. */
  analyzed: number
  /** Frames currently being analyzed. */
  analyzing: number
  stackingInProgress: boolean
  usedFrames: number
  /** Frames that are unreadable or were left out of the sum, with the reason. */
  rejected: RejectedFrame[]
  /** Per-frame outcome of the last stack. */
  results: FrameResult[]
  noiseHistory: NoisePoint[]
  lastUpdate: number | null
  /** Duration of the last stack, in seconds. */
  lastDuration: number
  /** Problem with the last stack, if any. */
  problem: string | null
  /** True if the last stack suggested cropping the edges. */
  suggestedCrop: boolean
  /**
   * User choice: if true, a frame included in the sum stays there even when
   * better frames arriving later push it below the threshold. If false
   * (default), frames are re-evaluated at every stack.
   */
  keepAccepted: boolean
}

const INITIAL_STATE: Omit<SessionState, 'folder'> = {
  active: false,
  mode: null,
  reachable: true,
  networkNotice: null,
  incoming: [],
  arrived: 0,
  analyzed: 0,
  analyzing: 0,
  stackingInProgress: false,
  usedFrames: 0,
  rejected: [],
  results: [],
  noiseHistory: [],
  lastUpdate: null,
  lastDuration: 0,
  problem: null,
  suggestedCrop: false,
  keepAccepted: false
}

export const useSession = create<SessionState>(() => ({ ...INITIAL_STATE, folder: '' }))

// --- Session data not needed by the UI ---

/** Frames ready to stack, in order of arrival. */
let ready: AnalyzedFrame[] = []
/** Unreadable or calibration frames, which never enter the sum. */
let excludedItems: RejectedFrame[] = []
let referenceId: string | undefined
let alignments = new Map<string, AlignmentResult>()
/** Frames included in the sum, for when the user chooses to keep them once accepted. */
let accepted = new Set<string>()
let currentOptions: StartOptions = {
  method: 'rejection',
  rejectionThreshold: 3,
  minQuality: DEFAULT_MIN_QUALITY,
  alignment: true,
  edgeTrim: true
}
let detachListener: (() => void) | null = null
let toRedo = false
/** Incremented at every start: jobs from a closed session are ignored. */
let generation = 0
let idCounter = 0

/** Complete files waiting to be read, in order of arrival. */
let tail: { path: string; fileName: string; size: number }[] = []
/** Reads and analyses in progress. */
let readings = 0
/** Allowed concurrent reads: the number of workers, or fewer when memory is low. */
let maxReadings = 1
/** Memory measured at startup; null if it cannot be read (no limit). */
let baseMemory: { free: number; recoverable: number } | null = null
/** Accepted frames (being analyzed or ready), by path, as seen by the estimate. */
let busy = new Map<string, FrameToEstimate>()
/** True when the session stopped because memory ran out. */
let memoryFull = false

/*
 * Where the result ends up. The session writes nothing on its own: frames
 * stay where the capture software put them and the stacked image is in the
 * viewer. To keep it the user saves the project, and in that case the
 * suggested location is the live sessions folder inside the work folder
 * (settings, General tab) instead of the projects folder. This applies while
 * the open work comes from a session: from the start until the library is
 * emptied (project closed or another one opened).
 */
let fromSession = false

/** True if the open work originated from a live session. */
export function jobFromLiveSession(): boolean {
  return fromSession
}

useApp.subscribe((s, before) => {
  if (s.frame.length === 0 && before.frame.length > 0) fromSession = false
})

/**
 * Keeps frames once accepted, or re-evaluates them at every stack. The
 * choice takes effect from the next stack, that is, from the next frame
 * that arrives.
 */
export function setKeepAccepted(keep: boolean): void {
  useSession.setState({ keepAccepted: keep })
}

/** The panel reports its current options here (method, thresholds, alignment). */
export function setSessionOptions(options: StartOptions): void {
  if (options.alignment !== currentOptions.alignment) {
    // The combination mode changed: reference and alignments must be redone.
    referenceId = undefined
    alignments = new Map()
    accepted = new Set()
  }
  currentOptions = options
}

/**
 * Suggests the folder to watch: the one chosen in the settings (Telescope
 * tab) if set, otherwise the last one used.
 */
export async function loadRememberedFolder(): Promise<void> {
  try {
    const defaultFolder = (await settingsReady()).telescopeFolder.trim()
    const prefs = await window.starlight.readPreferences()
    const folder = defaultFolder !== '' ? defaultFolder : prefs[FOLDER_KEY]
    if (typeof folder === 'string' && useSession.getState().folder === '') {
      useSession.setState({ folder })
    }
  } catch {
    // Without preferences the field starts empty.
  }
}

export function setFolder(folder: string): void {
  useSession.setState({ folder })
}

async function rememberFolder(folder: string): Promise<void> {
  try {
    // Other preferences must be kept: read, add, write (queued with the other
    // writes, so none is lost).
    await updatePreferences({ [FOLDER_KEY]: folder })
  } catch {
    // Failing to remember it does not prevent working.
  }
}

/** Opens the folder picker. */
export async function browseFolder(): Promise<void> {
  const current = useSession.getState().folder.trim()
  const choice = await window.starlight.chooseWatchedFolder(current === '' ? null : current)
  if (choice) useSession.setState({ folder: choice })
}

/** Starts watching the given folder. */
export async function startSession(includeExisting: boolean): Promise<void> {
  const notify = useApp.getState().notify
  // Paths pasted from File Explorer are often wrapped in quotes.
  const folder = useSession.getState().folder.trim().replace(/^"(.*)"$/, '$1')
  if (folder === '') {
    notify('warning', t('hooksUseSession.noFolder'))
    return
  }

  stopListening()
  generation++
  ready = []
  excludedItems = []
  referenceId = undefined
  alignments = new Map()
  accepted = new Set()
  toRedo = false
  tail = []
  readings = 0
  maxReadings = analysisWorkerPool().size
  busy = new Map()
  memoryFull = false
  // The user's choice about accepted frames is kept.
  useSession.setState((s) => ({ ...INITIAL_STATE, folder, keepAccepted: s.keepAccepted }))

  const ownGeneration = generation
  baseMemory = await measureMemory()
  if (ownGeneration !== generation) return
  detachListener = window.starlight.onWatch((event) => receive(event, ownGeneration))
  const result = await window.starlight.startWatcher(folder, includeExisting)
  if (!result.ok) {
    stopListening()
    notify('error', t('hooksUseSession.watchFailed', { message: result.message ?? '' }))
    return
  }
  useSession.setState({ active: true, mode: result.mode ?? null })
  // An already saved project stays where it is; otherwise the result will be
  // suggested among the live sessions.
  if (useApp.getState().project === null) fromSession = true
  void rememberFolder(folder)
  notify('ok', t('hooksUseSession.started'))
}

/** Stops watching. The collected frames stay in the library. */
export async function stopSession(): Promise<void> {
  stopListening()
  generation++
  await window.starlight.stopWatcher()
  useSession.setState({ active: false, incoming: [], analyzing: 0, stackingInProgress: false })
  // Memory used by analyzed frames is released: to redo the stack with
  // different options, the regular align-and-stack command is still available.
  ready = []
  tail = []
  busy = new Map()
  const s = useSession.getState()
  useApp
    .getState()
    .notify(
      'info',
      fromSession && s.usedFrames > 0
        ? t('hooksUseSession.stoppedSave', { used: s.usedFrames, arrived: s.arrived })
        : t('hooksUseSession.stopped', { used: s.usedFrames, arrived: s.arrived })
    )
}

function stopListening(): void {
  detachListener?.()
  detachListener = null
}

function addDiscard(rejection: RejectedFrame): void {
  excludedItems.push(rejection)
  updateDiscarded(useSession.getState().results)
}

/** Merges files that never entered the sum with those left out of the last one. */
function updateDiscarded(results: FrameResult[]): void {
  const leftOut = results.filter((e) => !e.isUsed).map((e) => ({ fileName: e.fileName, reason: frameReasonText(e.reason) }))
  useSession.setState({ rejected: [...excludedItems, ...leftOut] })
}

function receive(event: WatcherEvent, ownGeneration: number): void {
  if (ownGeneration !== generation) return
  switch (event.type) {
    case 'incoming':
      useSession.setState({ incoming: event.fileNames })
      break
    case 'reachable':
      useSession.setState({
        reachable: event.reachable,
        networkNotice: event.reachable ? null : event.message
      })
      break
    case 'unreadable':
      useSession.setState((s) => ({ arrived: s.arrived + 1 }))
      addDiscard({ fileName: event.fileName, reason: event.reason })
      break
    case 'ready':
      // The file waits in the queue until there is room, and already counts as being analyzed.
      useSession.setState((s) => ({ arrived: s.arrived + 1, analyzing: s.analyzing + 1 }))
      tail.push({ path: event.path, fileName: event.fileName, size: event.size })
      advanceQueue(ownGeneration)
      break
  }
}

/** Starts queued reads while there is room. */
function advanceQueue(ownGeneration: number): void {
  while (ownGeneration === generation && !memoryFull && readings < maxReadings && tail.length > 0) {
    const f = tail.shift() as (typeof tail)[number]
    readings++
    void ingestFile(f.path, f.fileName, f.size, ownGeneration).finally(() => {
      if (ownGeneration !== generation) return
      readings--
      advanceQueue(ownGeneration)
      finishIfFullAndDone(ownGeneration)
    })
  }
}

/** Free memory and memory the application can release, right now. */
async function measureMemory(): Promise<{ free: number; recoverable: number } | null> {
  try {
    const free = Number((await window.starlight.systemInfo()).freeRam)
    if (!Number.isFinite(free) || free <= 0) return null
    // Recently opened frames can be released, except the one in the viewer.
    const shown = useApp.getState().image?.data.byteLength ?? 0
    return { free, recoverable: Math.max(0, frameCache.usage - shown) }
  } catch {
    return null
  }
}

/**
 * True if the frame fits in memory alongside those already accepted; in that
 * case it is registered as held. With little memory it also reduces the
 * concurrent reads, as regular stacking does with workers.
 */
function hasRoom(path: string, frame: FrameToEstimate): boolean {
  if (!baseMemory) {
    busy.set(path, frame)
    return true
  }
  const estimate = estimateStacking({
    frame: [...busy.values(), frame],
    workers: analysisWorkerPool().size,
    workersSum: stackingWorkerPool().size,
    // Calibration library masters the analysis may load: at most one per
    // type (dark, flat, bias) for a single night.
    mastersToLoad: useApp.getState().withCalibration ? 3 : 0,
    sums: 1,
    freeMemory: baseMemory.free,
    recoverableMemory: baseMemory.recoverable
  })
  if (estimate.workers === 0) return false
  if (estimate.freeCache) frameCache.clear()
  maxReadings = estimate.workers
  busy.set(path, frame)
  return true
}

/**
 * Stops the session because another frame would not fit in memory. Reads
 * and stacking already started are allowed to finish, then the user is notified.
 */
function stopForMemory(): void {
  if (memoryFull) return
  memoryFull = true
  stopListening()
  void window.starlight.stopWatcher()
  const queued = tail.length
  tail = []
  useSession.setState((s) => ({ active: false, incoming: [], analyzing: Math.max(0, s.analyzing - queued) }))
}

/** Closes a session stopped for lack of memory once no work is left in progress. */
function finishIfFullAndDone(ownGeneration: number): void {
  if (!memoryFull || ownGeneration !== generation || readings > 0 || toRedo) return
  if (useSession.getState().stackingInProgress) return
  // From here on, no work from this session may continue.
  generation++
  ready = []
  busy = new Map()
  const s = useSession.getState()
  useSession.setState({
    analyzing: 0,
    problem: t('hooksUseSession.memoryProblem', { used: s.usedFrames })
  })
  useApp
    .getState()
    .notify(
      'warning',
      s.usedFrames > 0
        ? t('hooksUseSession.memoryStoppedSave', { used: s.usedFrames })
        : t('hooksUseSession.memoryStopped', { used: s.usedFrames })
    )
}

/** Reads, adds to the library and analyzes a newly arrived frame. */
async function ingestFile(path: string, fileName: string, size: number, ownGeneration: number): Promise<void> {
  let entered = false
  try {
    const buffer = await window.starlight.readFile(path)
    if (ownGeneration !== generation) return

    // The header must be read before handing the contents to the worker.
    // A camera RAW file needs the whole file (LibRaw cannot read the header alone).
    const raw = hasRawExtension(fileName)
    if (raw) await prepareRawInBrowser()
    // The whole file is passed: the reader only looks at the header, and this
    // also covers XISF files with a long XML header and TIFF files that keep
    // the directory at the end.
    const info = readFitsHeaderOnly(new Uint8Array(buffer), fileName)
    const type = info.metadata.frameType
    if (type === 'dark' || type === 'flat' || type === 'bias') {
      addDiscard({ fileName, reason: t('hooksUseSession.reason.calibrationFrame') })
      return
    }

    // Before keeping it: does it fit in memory with those already collected?
    const estimated: FrameToEstimate = {
      width: info.width,
      height: info.height,
      channels: info.header.cards['NAXIS3'] === 3 || info.metadata.bayer !== 'NONE' || raw ? 3 : 1,
      fileBytes: size,
      raw,
      compactValue: compactPlanes({
        bitpix: info.bitpix,
        fileChannels: info.header.cards['NAXIS3'] === 3 ? 3 : 1,
        bayer: info.metadata.bayer,
        raw,
        bscale: info.header.cards['BSCALE'],
        bzero: info.header.cards['BZERO']
      })
    }
    if (memoryFull || !hasRoom(path, estimated)) {
      stopForMemory()
      return
    }

    // Added to the library, so the stack can be redone with other options
    // after the session. If the file was already there, its entry is reused.
    const app = useApp.getState()
    let entry: LoadedFrame | undefined = app.frame.find((f) => f.path === path)
    if (!entry) {
      entry = {
        id: 'live' + ++idCounter,
        path: path,
        fileName: fileName,
        sizeBytes: size,
        width: info.width,
        height: info.height,
        channels: (info.header.cards['NAXIS3'] === 3 ? 3 : 1) as 1 | 3,
        bitpix: info.bitpix,
        metadata: info.metadata,
        header: info.header,
        stats: { min: 0, max: 0, mean: 0, median: 0, stdDev: 0, mad: 0, saturatedPct: 0 },
        quality: null,
        excluded: false
      }
      app.addFrame([entry])
    } else if (entry.excluded) {
      addDiscard({ fileName, reason: t('hooksUseSession.reason.excludedManually') })
      return
    }

    const analyzed = await analyzeFrame(entry, currentOptions.alignment, buffer)
    if (ownGeneration !== generation) return
    ready.push(analyzed)
    entered = true
    useSession.setState((s) => ({ analyzed: s.analyzed + 1 }))
    if (analyzed.calibrationError) {
      useSession.setState({
        problem: t('hooksUseSession.calibrationSkipped', { file: fileName, error: analyzed.calibrationError })
      })
    }
    void restack(ownGeneration)
  } catch (e) {
    if (ownGeneration !== generation) return
    addDiscard({
      fileName,
      reason: t('hooksUseSession.reason.unreadable', { message: e instanceof Error ? e.message : String(e) })
    })
  } finally {
    if (!entered && ownGeneration === generation) busy.delete(path)
    if (ownGeneration === generation) useSession.setState((s) => ({ analyzing: Math.max(0, s.analyzing - 1) }))
  }
}

/**
 * Redoes the stack with all ready frames. If more arrive while it is
 * running, it restarts once at the end with all the new ones.
 */
async function restack(ownGeneration: number): Promise<void> {
  if (useSession.getState().stackingInProgress) {
    toRedo = true
    return
  }
  if (ready.length < 2) return

  useSession.setState({ stackingInProgress: true })
  try {
    do {
      toRedo = false
      const start = performance.now()
      const options = currentOptions
      const keep = useSession.getState().keepAccepted
      const result = await stackAnalyzed([...ready], options, () => {}, {
        referenceId,
        alignments,
        accepted: keep ? accepted : undefined
      })
      if (ownGeneration !== generation) return
      for (const e of result.results) if (e.isUsed) accepted.add(e.id)

      referenceId = result.referenceId
      alignments = result.alignments

      // The image in the viewer becomes the updated result.
      const app = useApp.getState()
      app.setActiveFrame(result.referenceId, result.image)
      app.updateAdjustments({ stretch: autoStretch(result.image) })
      if (result.crop) app.setCrop(result.crop.crop)

      useSession.setState((s) => ({
        suggestedCrop: result.crop !== undefined,
        usedFrames: result.usedFrames,
        results: result.results,
        noiseHistory: [
          ...s.noiseHistory,
          { frame: result.usedFrames, noise: result.noiseAfter, singleNoise: result.noiseBefore }
        ],
        lastUpdate: Date.now(),
        lastDuration: (performance.now() - start) / 1000,
        problem: null
      }))
      updateDiscarded(result.results)
    } while (toRedo && ownGeneration === generation)
  } catch (e) {
    if (ownGeneration !== generation) return
    // Usually there are not yet enough alignable frames: it will be retried
    // on the next arrival.
    useSession.setState({ problem: e instanceof Error ? e.message : String(e) })
  } finally {
    if (ownGeneration === generation) useSession.setState({ stackingInProgress: false })
    // Something arrived while an error was being handled: try again.
    if (toRedo && ownGeneration === generation) {
      toRedo = false
      void restack(ownGeneration)
    }
    finishIfFullAndDone(ownGeneration)
  }
}
