import { create } from 'zustand'
import type { FileHandleInfo, ImageData32, LoadedFrame, Wcs } from '@shared/types'
import { APP_VERSION } from '@shared/version'
import { readFits } from '@core/fits/reader'
import { readHeaders } from './fileHeader'
import { prepareRawIfNeeded } from '../workers/libraw'
import { debayer } from '@core/image/debayer'
import { encodeFits } from '@core/export/encoding'
import { readWcs, scaleArcsec } from '@core/astrometry/wcs'
import {
  ProjectError,
  PROJECT_FILE_NAME,
  IMAGE_NAME,
  ORIGINAL_NAME,
  folderOf,
  readProject,
  nameOf,
  cleanName,
  serializeProject,
  joinPath,
  resultFromProject,
  resultToSave,
  wcsFromProject,
  wcsToSave,
  type ProjectFrame,
  type ProjectState
} from '@core/project'
import { useApp, NEUTRAL_ADJUSTMENTS, EMPTY_MASTERS, type WorkflowStep, type Adjustments } from '../store/appStore'
import { updatePreferences, workFolderOf } from '../settings'
import { jobFromLiveSession } from './useSession'
import { originalFrame, restoreResult, shownResult } from './temporaryResult'
import { displayedAstrometryNow } from './displayedAstrometry'
import { GEOMETRY_UNCHANGED, GEOMETRY_UNKNOWN } from '@core/image/geometry'
import { infoOf } from '../plugin/registry'
import { t } from '@shared/i18n/i18n'
import {
  MAX_LAYERS,
  fromBase64,
  decompressMask,
  layersToSave,
  layerFromSaved,
  maskFileName,
  type LocalLayer,
  type SavedLayer,
  type PaintedMask
} from '@core/image/masks'

/**
 * Projects: save, open, close.
 *
 * This module holds the steps that touch the disk and the application state;
 * converting the state to text lives in `@core/project`. The confirmation and
 * name dialogs are in `ProjectDialogs`, driven by the small
 * `useProjectDialogs` store.
 */

/** Action to resume after a confirmation or after a name has been chosen. */
export type Action = 'close' | 'new' | 'open' | 'quit' | 'restart' | 'frame'
export type NextAction = Action | null

export type ProjectDialog =
  | { type: 'saveAs'; next: NextAction }
  | { type: 'confirm'; next: Action }
  | null

export const useProjectDialogs = create<{
  dialog: ProjectDialog
  openDialog: (d: ProjectDialog) => void
}>((set) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog })
}))

/* ---- Unsaved work ---- */

/** State fields that belong to the project. */
export const PROJECT_FIELDS = [
  'frame',
  'activeFrameId',
  'image',
  'originalImage',
  'adjustments',
  'localAdjustments',
  'curves',
  'processing',
  'crop',
  'aspectRatio',
  'preset',
  'objects',
  'withCalibration'
] as const

/** While a project is being opened, changes do not count as modifications. */
let suspended = false
/** Incremented on every change; tells whether the state changed during a save. */
let changeCounter = 0

useApp.subscribe((s, before) => {
  if (suspended) return
  if (!PROJECT_FIELDS.some((k) => s[k] !== before[k])) return
  changeCounter++
  // An empty workspace has nothing to lose.
  const empty = s.frame.length === 0 && s.image === null
  if (!empty && !s.modified) s.markModified(true)
})

/*
 * The main process needs to know whether there is unsaved work, so it can
 * stop closing via the window's X button and ask for confirmation here.
 */
let reported = false
useApp.subscribe(() => {
  const v = hasUnsavedWork()
  if (v === reported) return
  reported = v
  window.starlight.reportUnsavedWork?.(v)
})
window.starlight.onCloseRequest?.(() => exitProgram())

/** True if closing now would lose work. */
export function hasUnsavedWork(): boolean {
  const s = useApp.getState()
  return s.modified && (s.frame.length > 0 || s.image !== null)
}

/**
 * True if opening a frame in the viewer would lose an unsaved result
 * (stacked, drizzle, mosaic) or unsaved processing: the frame can be reread
 * from its file, the rest cannot.
 */
export function imageAtRisk(): boolean {
  const s = useApp.getState()
  if (!s.modified || s.image === null) return false
  return (
    shownResult() !== null ||
    s.appliedProcessing !== null ||
    s.image !== s.originalImage ||
    s.localAdjustments.length > 0
  )
}

/** Callback waiting for the confirmation answer before a frame is opened. */
let frameResponse: ((shouldProceed: boolean) => void) | null = null

/**
 * Called before replacing the displayed image with a frame: asks for
 * confirmation if there is an unsaved result or unsaved processing.
 * Resolves to true if it is safe to proceed, including after saving.
 */
export function confirmImageChange(): Promise<boolean> {
  if (!imageAtRisk()) return Promise.resolve(true)
  return new Promise((resolve) => {
    frameResponse?.(false)
    frameResponse = resolve
    useProjectDialogs.getState().openDialog({ type: 'confirm', next: 'frame' })
  })
}

/** The pending action will not run: notifies whoever was waiting for the confirmation. */
export function giveUp(next: NextAction): void {
  if (next !== 'frame') return
  const r = frameResponse
  frameResponse = null
  r?.(false)
}

/* ---- State of the open project ---- */

/**
 * Frames the project references that were not on disk when it was opened
 * (for example on a disconnected external drive). They are not in the
 * library, but are written back to the file on every save so they are not lost.
 */
let missingFrames: ProjectFrame[] = []

/**
 * Images already written to the project folder. If they have not changed,
 * a new save rewrites only the text file, which is instant even with
 * images of hundreds of megabytes.
 */
let alreadyWritten: { folder: string; image: ImageData32 | null; original: ImageData32 | null } | null = null

let idCounter = 0

const HEAD_BYTES = 64800

const EMPTY_STATISTICS = { min: 0, max: 0, mean: 0, median: 0, stdDev: 0, mad: 0, saturatedPct: 0 }

const STEPS: WorkflowStep[] = ['import', 'calibrate', 'align', 'process', 'correct', 'filters', 'objects', 'export']

/** Suggested name for a new project. */
export function proposedName(): string {
  const s = useApp.getState()
  if (s.project) return s.project.name
  const active = s.frame.find((f) => f.id === s.activeFrameId) ?? s.frame[0]
  const object = active?.metadata.object
  return cleanName(object ?? '') || t('hooksUseProject.defaultName')
}

/** Folder suggested for creating a new project. */
export async function proposedPosition(): Promise<string> {
  const s = useApp.getState()
  if (s.project) return folderOf(s.project.folder)
  // A live session result goes with the other sessions; everything else goes
  // to the projects folder. Both come from the settings (General tab) and
  // live inside the work folder.
  return workFolderOf(jobFromLiveSession() ? 'sessions' : 'projects')
}

/** Preferences key holding the file of the last project saved or opened. */
export const LAST_PROJECT_KEY = 'lastProject'

/*
 * Every time a project is saved or opened its file is remembered, so it can
 * be reopened at startup (General tab of the settings).
 */
useApp.subscribe((s, before) => {
  if (s.project === null || s.project.folder === before.project?.folder) return
  void updatePreferences({
    [LAST_PROJECT_KEY]: joinPath(s.project.folder, PROJECT_FILE_NAME)
  })
})

function busy(): boolean {
  const s = useApp.getState()
  if (!s.job.active) return false
  s.notify('warning', t('hooksUseProject.busy'))
  return true
}

/* ---- Saving ---- */

/** Saves to the open project; if there is none yet, asks for a name. */
export async function saveProject(next: NextAction = null): Promise<void> {
  const s = useApp.getState()
  if (busy()) {
    giveUp(next)
    return
  }
  if (!s.project) {
    saveProjectAs(next)
    return
  }
  const ok = await writeProject(s.project.folder)
  if (ok) await proceed(next)
  else giveUp(next)
}

/** Opens the dialog for choosing the project name and location. */
export function saveProjectAs(next: NextAction = null): void {
  const s = useApp.getState()
  if (busy()) {
    giveUp(next)
    return
  }
  if (s.frame.length === 0 && s.image === null) {
    s.notify('info', t('hooksUseProject.nothingToSave'))
    return
  }
  useProjectDialogs.getState().openDialog({ type: 'saveAs', next })
}

/** Called by the name dialog: creates the folder and saves. */
export async function saveAsChosen(position: string, name: string, next: NextAction): Promise<boolean> {
  const cleaned = cleanName(name)
  if (!cleaned) {
    giveUp(next)
    return false
  }
  const ok = await writeProject(joinPath(position, cleaned))
  if (ok) await proceed(next)
  else giveUp(next)
  return ok
}

/**
 * Everything that must be written to save the current work as a project
 * named `name`: the state for the text file and the headers for the images.
 * Used by both the regular save and the recovery copy (see `recovery.ts`),
 * so they always share the same format.
 */
export function contentToSave(name: string): {
  state: ProjectState<Adjustments>
  /** True if the original image must be written separately because it differs from the displayed one. */
  originalDiffers: boolean
  cards: Record<string, string | number | boolean | null>
  fitsOptions: { wcs: Wcs | null }
  shownOptions: { wcs: Wcs | null }
} {
  const s = useApp.getState()
  const active = s.frame.find((f) => f.id === s.activeFrameId) ?? null
  const originalDiffers = s.originalImage !== null && s.originalImage !== s.image
  // Drizzle and mosaic results have their own scale and solution, different
  // from those in the frame file: they must be saved, or reopening would
  // bring back the ones from the file.
  const result = shownResult()

  const state: ProjectState<Adjustments> = {
    name,
    frame: [
      // Every frame with the data from its own file, including the one
      // currently showing a drizzle or mosaic result.
      ...s.frame.map(originalFrame).map((f) => ({
        path: f.path,
        excluded: f.excluded,
        statistics: f.stats.max > 0 ? f.stats : null,
        quality: f.quality,
        // Only a solution found by plate solving: one written in the header
        // is reread from the file.
        solution: f.metadata.wcs !== null && readWcs(f.header) === null ? wcsToSave(f.metadata.wcs) : null
      })),
      ...missingFrames
    ],
    activeFrame: active?.path ?? null,
    image: s.image ? IMAGE_NAME : null,
    originalImage: originalDiffers ? ORIGINAL_NAME : null,
    result: result !== null ? resultToSave(result) : null,
    adjustments: s.adjustments,
    // Painted masks are stored here compressed: the regular save moves them
    // into separate files (see writeProject), while the recovery copy, which
    // writes only text and images, keeps them in the text.
    localAdjustments: layersToSave(s.localAdjustments),
    curves: s.curves,
    processing: s.processing,
    appliedProcessing: s.appliedProcessing,
    appliedGeometry: s.appliedGeometry,
    rotation: s.rotation,
    mirrored: s.mirrored,
    freeRotation: s.freeRotation,
    crop: s.crop,
    aspectRatio: s.aspectRatio,
    preset: s.preset,
    objects: s.objects,
    withCalibration: s.withCalibration,
    step: s.step
  }

  const cards = (active ? originalFrame(active).header.cards : {}) as Record<
    string,
    string | number | boolean | null
  >
  // With the result's solution, the saved images can also be opened on their
  // own, in another application, with the correct geometry. The original
  // image carries the frame's solution; the displayed one carries the same
  // solution transformed like the pixels if a plugin rotated or mirrored
  // them (none if the plugin moved them without saying how).
  return {
    state,
    originalDiffers,
    cards,
    fitsOptions: { wcs: active?.metadata.wcs ?? null },
    shownOptions: { wcs: displayedAstrometryNow().wcs }
  }
}

async function writeProject(folder: string): Promise<boolean> {
  const s = useApp.getState()
  const version = changeCounter
  const sameFolder = alreadyWritten !== null && alreadyWritten.folder === folder
  const { state, originalDiffers, cards, fitsOptions, shownOptions } = contentToSave(nameOf(folder))

  try {
    s.setJob(t('hooksUseProject.job.saving'), 0.2)
    // Let the progress indicator appear before encoding, which blocks briefly.
    await new Promise((r) => setTimeout(r, 30))
    const file: { name: string; data: ArrayBuffer }[] = []
    const toRemove: string[] = []

    if (s.image) {
      if (!(sameFolder && alreadyWritten?.image === s.image)) {
        file.push({ name: IMAGE_NAME, data: encodeFits(s.image, cards, 32, shownOptions) })
      }
    } else {
      toRemove.push(IMAGE_NAME)
    }
    if (originalDiffers && s.originalImage) {
      if (!(sameFolder && alreadyWritten?.original === s.originalImage)) {
        s.setJob(t('hooksUseProject.job.saving'), 0.5)
        file.push({ name: ORIGINAL_NAME, data: encodeFits(s.originalImage, cards, 32, fitsOptions) })
      }
    } else {
      toRemove.push(ORIGINAL_NAME)
    }

    // Painted masks of the local adjustments: one compressed file each, next
    // to the project, instead of bloating the text file.
    const usedItems = new Set<string>()
    state.localAdjustments = (state.localAdjustments ?? []).map((l, i) => {
      const data = l.mask.painted?.data
      const compressed = data !== undefined ? fromBase64(data) : null
      if (compressed === null) return l
      const name = maskFileName(i)
      usedItems.add(name)
      file.push({ name, data: compressed.slice().buffer })
      return { ...l, mask: { ...l.mask, painted: { file: name } } }
    })
    for (let i = 0; i < MAX_LAYERS; i++) {
      if (!usedItems.has(maskFileName(i))) toRemove.push(maskFileName(i))
    }

    s.setJob(t('hooksUseProject.job.saving'), 0.75)
    const text = serializeProject(state, APP_VERSION)
    await window.starlight.saveProject(folder, PROJECT_FILE_NAME, text, file, toRemove)

    alreadyWritten = {
      folder,
      image: s.image,
      original: originalDiffers ? s.originalImage : null
    }
    const now = useApp.getState()
    now.setProject({ name: state.name, folder })
    // If something changed in the meantime, that change still needs saving.
    if (changeCounter === version) now.markModified(false)
    now.finishJob()
    now.notify('ok', t('hooksUseProject.saved', { name: state.name }))
    return true
  } catch (e) {
    const now = useApp.getState()
    now.finishJob()
    now.notify('error', t('hooksUseProject.saveFailed', { message: e instanceof Error ? e.message : String(e) }))
    return false
  }
}

/* ---- Closing and opening ---- */

/**
 * Runs an action that replaces the current work, asking for confirmation
 * first if anything is unsaved.
 */
async function withConfirm(action: Action): Promise<void> {
  // Quitting does not wait: a stuck operation must not prevent it.
  if (action !== 'quit' && action !== 'restart' && busy()) return
  if (hasUnsavedWork()) {
    useProjectDialogs.getState().openDialog({ type: 'confirm', next: action })
    return
  }
  await proceed(action)
}

/** Closes the project: empties the library and resets all processing. */
export function closeProject(): void {
  void withConfirm('close')
}

/** Starts from scratch with a new project, the same as closing the open one. */
export function newProject(): void {
  void withConfirm('new')
}

/**
 * Project already chosen outside StarLight (double-click on a .slight file),
 * opened instead of showing the file picker. Only `openProjectFromFile` sets
 * it and `openProject` clears it, so a cancelled confirmation does not leave
 * a stale path for the next open.
 */
let pathToOpen: string | null = null

/** Asks which project to open. */
export async function openProject(): Promise<void> {
  pathToOpen = null
  await withConfirm('open')
}

/**
 * Opens the given project, like File → Open project but without the file
 * picker; if there is unsaved work, asks for confirmation first.
 */
export async function openProjectFromFile(path: string): Promise<void> {
  pathToOpen = path
  await withConfirm('open')
}

/** Quits StarLight. */
export function exitProgram(): void {
  void withConfirm('quit')
}

/**
 * Quits and relaunches StarLight, for options that take effect at startup
 * (Settings, Performance tab). As when quitting, unsaved work triggers a
 * confirmation first.
 */
export function restartProgram(): void {
  void withConfirm('restart')
}

/** Runs the action left pending after a save or a confirmation. */
export async function proceed(next: NextAction): Promise<void> {
  if (next === 'close' || next === 'new') {
    closeImmediately()
    if (next === 'new') useApp.getState().notify('info', t('hooksUseProject.newProject'))
  } else if (next === 'open') await openImmediately()
  else if (next === 'quit') await window.starlight.exit()
  else if (next === 'restart') await window.starlight.restart()
  else if (next === 'frame') {
    const r = frameResponse
    frameResponse = null
    r?.(true)
  }
}

function closeImmediately(): void {
  missingFrames = []
  alreadyWritten = null
  suspended = true
  useApp.getState().closeProject()
  suspended = false
}

async function openImmediately(): Promise<void> {
  const chosen = pathToOpen
  pathToOpen = null
  const path = chosen ?? (await window.starlight.chooseProjectToOpen(await workFolderOf('projects')))
  if (!path) return
  await openFromPath(path)
}

/**
 * Work recovered after a crash (see `recovery.ts`): the file opened is the
 * recovery copy, but the work belongs to the original project, if any, and
 * still needs saving.
 */
export interface AsRecovery {
  project: { name: string; folder: string } | null
}

/**
 * Opens a project. The acquisition metadata of all frames is reread (only
 * the file headers, as fast as importing) along with the saved image, which
 * goes straight into the viewer. Frames missing from disk are reported
 * without blocking the open.
 *
 * With `recovery`, the recovery copy is opened: the open project becomes the
 * original one (or none, for unnamed work) and the work is marked as
 * modified, so the user decides whether to save it. Returns true if the
 * project was opened successfully.
 */
export async function openFromPath(path: string, recovery: AsRecovery | null = null): Promise<boolean> {
  const app = useApp.getState()
  let state: ProjectState<Adjustments>
  try {
    app.setJob(t('hooksUseProject.job.opening'), 0.05)
    const text = new TextDecoder().decode(await window.starlight.readFile(path))
    state = readProject(text, NEUTRAL_ADJUSTMENTS)
  } catch (e) {
    app.finishJob()
    const message = e instanceof ProjectError ? e.message : t('hooksUseProject.unreadableFile')
    app.notify(
      'error',
      recovery ? t('hooksUseProject.recoveryFailed', { message }) : t('hooksUseProject.openFailed', { message })
    )
    return false
  }

  const folder = folderOf(path)
  const name = nameOf(folder)

  // Acquisition metadata of the frames still present.
  const presentItems = await window.starlight.exist(state.frame.map((f) => f.path))
  const frame: LoadedFrame[] = []
  const missingItems: ProjectFrame[] = []
  // First the name and size of the files present, then the acquisition
  // metadata, several files at a time (RAW files in a small worker pool).
  const toRead: { f: ProjectFrame; info: FileHandleInfo }[] = []
  for (let i = 0; i < state.frame.length; i++) {
    const f = state.frame[i]
    if (!presentItems[i]) {
      missingItems.push(f)
      continue
    }
    try {
      toRead.push({ f, info: await window.starlight.fileInfo(f.path) })
    } catch {
      missingItems.push(f)
    }
  }
  const results = await readHeaders(
    toRead.map((d) => ({ path: d.f.path, fileName: d.info.fileName, sizeBytes: d.info.sizeBytes })),
    HEAD_BYTES,
    (finished) => app.setJob(t('hooksUseProject.job.readingMetadata'), 0.1 + (0.5 * finished) / Math.max(1, toRead.length))
  )
  for (let i = 0; i < toRead.length; i++) {
    const { f, info } = toRead[i]
    const result = results[i]
    if ('error' in result) {
      missingItems.push(f)
      continue
    }
    const h = result.info
    // A solution found by plate solving is not in the header: it is taken
    // from the project, with its scale (see usePlateSolve).
    const solution = h.metadata.wcs === null ? wcsFromProject(f.solution) : null
    const metadata = solution !== null ? { ...h.metadata, wcs: solution, pixelScale: scaleArcsec(solution) } : h.metadata
    frame.push({
      id: 'p' + ++idCounter,
      path: f.path,
      fileName: info.fileName,
      sizeBytes: info.sizeBytes,
      width: h.width,
      height: h.height,
      channels: (h.header.cards['NAXIS3'] === 3 ? 3 : 1) as 1 | 3,
      bitpix: h.bitpix,
      metadata,
      header: h.header,
      stats: f.statistics ?? EMPTY_STATISTICS,
      quality: f.quality,
      excluded: f.excluded
    })
  }

  const active = frame.find((f) => f.path === state.activeFrame) ?? null
  // Notices raised while parsing, for example a plugin that no longer exists.
  const notices: string[] = [...(state.notices ?? [])]

  // The image saved in the project, and the original one if it differs.
  app.setJob(t('hooksUseProject.job.openingImage'), 0.7)
  let image = state.image ? await readImage(joinPath(folder, state.image)) : null
  const imageFromProject = image
  let original = state.originalImage
    ? await readImage(joinPath(folder, state.originalImage))
    : null
  let appliedProcessing = state.appliedProcessing
  // How plugins moved the pixels of the saved image. When a project does not
  // record it and the processing used a plugin that moves pixels, or the two
  // images have different dimensions, the geometry is left unknown (solution
  // removed, markers hidden) rather than being wrong.
  const shiftPixels =
    appliedProcessing?.plugin.some(
      (p) => p.active && (infoOf(p.id)?.manifest.geometry ?? 'unchanged') !== 'unchanged'
    ) ?? false
  const differentMeasurements =
    image !== null && original !== null && (image.width !== original.width || image.height !== original.height)
  let appliedGeometry =
    state.appliedGeometry ?? (shiftPixels || differentMeasurements ? GEOMETRY_UNKNOWN : GEOMETRY_UNCHANGED)

  if (!image && active) {
    // Project image missing or corrupted: start again from the frame.
    image = await readFrame(active)
    original = null
    appliedProcessing = null
    appliedGeometry = GEOMETRY_UNCHANGED
    if (state.image) {
      notices.push(t('hooksUseProject.notices.imageMissing'))
    }
  } else if (image && state.originalImage && !original) {
    notices.push(t('hooksUseProject.notices.originalMissing'))
  }

  if (missingItems.length > 0) {
    const first = nameOf(missingItems[0].path)
    notices.push(
      missingItems.length === 1
        ? t('hooksUseProject.notices.missingFramesOne', { first })
        : t('hooksUseProject.notices.missingFramesOther', { count: missingItems.length, first })
    )
  }

  // Local adjustments, with painted masks read from their files.
  const localAdjustments = await readLevels(state.localAdjustments ?? [], folder)
  if (localAdjustments.missingItems > 0) {
    notices.push(
      localAdjustments.missingItems === 1
        ? t('hooksUseProject.notices.masksUnreadableOne')
        : t('hooksUseProject.notices.masksUnreadableOther', { count: localAdjustments.missingItems })
    )
  }

  missingFrames = missingItems
  // The recovery copy images are not in the project folder: they must all be
  // written on the first save.
  alreadyWritten = recovery
    ? null
    : {
        folder,
        image: imageFromProject,
        original
      }

  suspended = true
  useApp.setState({
    frame,
    activeFrameId: active?.id ?? null,
    image,
    originalImage: original ?? image,
    adjustments: state.adjustments,
    localAdjustments: localAdjustments.levels,
    curves: state.curves,
    processing: state.processing,
    appliedProcessing,
    appliedGeometry,
    rotation: appliedGeometry.type === 'unchanged' && !state.rotation ? 0 : (state.rotation ?? 0),
    mirrored: appliedGeometry.type === 'unchanged' ? false : (state.mirrored ?? false),
    freeRotation: appliedGeometry.type === 'unchanged' ? 0 : (state.freeRotation ?? 0),
    crop: state.crop,
    aspectRatio: state.aspectRatio,
    preset: state.preset,
    objects: state.objects,
    withCalibration: state.withCalibration,
    master: EMPTY_MASTERS,
    step: STEPS.includes(state.step as WorkflowStep) ? (state.step as WorkflowStep) : 'import',
    zoom: 0,
    pan: { x: 0, y: 0 },
    project: recovery ? recovery.project : { name, folder },
    modified: recovery !== null
  })
  // Drizzle and mosaic: put the result's scale and solution back on the
  // frame, replacing those read from the file.
  if (state.result !== null && active !== null && imageFromProject !== null) {
    const r = state.result
    const start = original ?? image
    const ok =
      start !== null &&
      restoreResult(active.id, start, resultFromProject(r))
    if (!ok && r.type !== 'stacked') {
      notices.push(
        r.type === 'drizzle'
          ? t('hooksUseProject.notices.drizzleNotRestored')
          : t('hooksUseProject.notices.mosaicNotRestored')
      )
    }
  }
  suspended = false

  const now = useApp.getState()
  now.finishJob()
  now.notify(
    'ok',
    recovery
      ? recovery.project
        ? t('hooksUseProject.recoveredInProject', { name: recovery.project.name })
        : t('hooksUseProject.recovered')
      : t('hooksUseProject.opened', { name })
  )
  if (notices.length > 0) {
    const text = notices.join('; ')
    now.notify('warning', text.charAt(0).toUpperCase() + text.slice(1) + '.')
  }
  return true
}

/**
 * Local adjustment layers saved in the project, with their painted masks read
 * from their own files (project) or from the text (recovery copy). A mask
 * that cannot be read is dropped and counted, so the user can be warned.
 */
async function readLevels(
  savedItems: SavedLayer[],
  folder: string
): Promise<{ levels: LocalLayer[]; missingItems: number }> {
  const levels: LocalLayer[] = []
  let missingItems = 0
  for (const l of savedItems.slice(0, MAX_LAYERS)) {
    const d = l.mask.painted
    let painted: PaintedMask | null = null
    if (d) {
      let byte: Uint8Array | null = null
      if (d.file) {
        try {
          byte = new Uint8Array(await window.starlight.readFile(joinPath(folder, d.file)))
        } catch {
          byte = null
        }
      } else if (d.data) byte = fromBase64(d.data)
      painted = byte ? decompressMask(byte) : null
      if (painted === null) missingItems++
    }
    levels.push(layerFromSaved(l, painted))
  }
  return { levels, missingItems }
}

/** Reads an image saved in the project; null if it is missing or unreadable. */
async function readImage(path: string): Promise<ImageData32 | null> {
  try {
    const [present] = await window.starlight.exist([path])
    if (!present) return null
    const data = await window.starlight.readFile(path)
    return readFits(new Uint8Array(data)).image
  } catch {
    return null
  }
}

/** Decodes a frame from disk, as when opening it from the library. */
async function readFrame(frame: LoadedFrame): Promise<ImageData32 | null> {
  try {
    const data = await window.starlight.readFile(frame.path)
    await prepareRawIfNeeded(frame.fileName, data)
    const r = readFits(new Uint8Array(data), frame.fileName)
    return debayer(r.image, r.metadata.bayer)
  } catch {
    return null
  }
}

/** Command bundle for components. */
export function useProject(): {
  save: () => Promise<void>
  saveAs: () => void
  open: () => Promise<void>
  close: () => void
  newValue: () => void
  exit: () => void
} {
  return {
    save: () => saveProject(),
    saveAs: () => saveProjectAs(),
    open: openProject,
    close: closeProject,
    newValue: newProject,
    exit: exitProgram
  }
}
