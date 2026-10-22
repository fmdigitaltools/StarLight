import { create } from 'zustand'
import { useApp, type Adjustments } from '../store/appStore'
import type { ImageData32 } from '@shared/types'
import type { LocalLayer, Mask, LayerAdjustments } from '@core/image/masks'
import { t } from '@shared/i18n/i18n'

/*
 * Edit history, with Undo and Redo.
 *
 * It subscribes to the store and takes snapshots of the parts that change the
 * image: adjustments, curves, processing with its image, crop. Snapshots are
 * references to the same store objects (which are never modified in place),
 * so they are cheap; only processed images take real memory, which is why a
 * limited number of them is kept.
 *
 * An "edit" is a burst of changes: dragging a slider produces dozens of
 * updates, which become a single step once the slider stays still for a
 * moment. A processing run in progress (active job) keeps the burst open
 * until it ends, so the parameters and the resulting image end up in the
 * same step.
 *
 * Opening another frame or a project, or closing everything, resets the
 * history: the source image is no longer the same.
 */

interface Snapshot {
  adjustments: Adjustments
  localAdjustments: LocalLayer[]
  curves: ReturnType<typeof useApp.getState>['curves']
  crop: ReturnType<typeof useApp.getState>['crop']
  aspectRatio: string
  preset: string | null
  processing: ReturnType<typeof useApp.getState>['processing']
  appliedProcessing: ReturnType<typeof useApp.getState>['appliedProcessing']
  appliedGeometry: ReturnType<typeof useApp.getState>['appliedGeometry']
  rotation: number
  mirrored: boolean
  freeRotation: number
  image: ImageData32 | null
}

export interface HistoryStep {
  label: string
  /** Time of the edit, in milliseconds. */
  now: number
}

interface Step extends HistoryStep {
  photo: Snapshot
}

/** Quiet time, in milliseconds, that closes a burst of changes. */
const QUIET_MS = 500
/** Maximum number of steps kept, including the initial one. */
const MAX_STEPS = 100
/** Maximum memory for processed images held only by the history. */
const IMAGE_MEMORY = 1.5 * 1024 ** 3

let steps: Step[] = []
let index = -1
/** True while a step is being applied: those changes are not edits. */
let applying = false
/** True right after the source image changes, until the next tick. */
let settling = false
let burstOpen = false
let timer: ReturnType<typeof setTimeout> | null = null
/** Label of the job seen during the burst (for example «Abracadabra»). */
let seenJob: string | null = null
/** Name imposed on the next step by the caller that records it (see `recordStep`). */
let setLabel: string | null = null

/** State for the interface: list of steps and current position. */
export const useHistory = create<{ steps: HistoryStep[]; index: number }>(() => ({
  steps: [],
  index: -1
}))

function publish(): void {
  useHistory.setState({
    steps: steps.map((p) => ({ label: p.label, now: p.now })),
    index
  })
}

function takeSnapshot(): Snapshot {
  const s = useApp.getState()
  return {
    adjustments: s.adjustments,
    localAdjustments: s.localAdjustments,
    curves: s.curves,
    crop: s.crop,
    aspectRatio: s.aspectRatio,
    preset: s.preset,
    processing: s.processing,
    appliedProcessing: s.appliedProcessing,
    appliedGeometry: s.appliedGeometry,
    rotation: s.rotation,
    mirrored: s.mirrored,
    freeRotation: s.freeRotation,
    image: s.image
  }
}

/* ---- Step labels (language-file keys, translated when the label is built) ---- */

const ADJUSTMENT_KEYS: Partial<Record<keyof Adjustments, string>> = {
  stretch: 'hooksHistory.adjustment.stretch',
  brightness: 'hooksHistory.adjustment.brightness',
  contrast: 'hooksHistory.adjustment.contrast',
  saturation: 'hooksHistory.adjustment.saturation',
  vibrance: 'hooksHistory.adjustment.vibrance',
  redGain: 'hooksHistory.adjustment.colorBalance',
  greenGain: 'hooksHistory.adjustment.colorBalance',
  blueGain: 'hooksHistory.adjustment.colorBalance',
  gamma: 'hooksHistory.adjustment.gamma',
  noiseReduction: 'hooksHistory.adjustment.noiseReduction',
  sharpness: 'hooksHistory.adjustment.sharpness',
  backgroundNeutralization: 'hooksHistory.adjustment.backgroundNeutralization',
  vignette: 'hooksHistory.adjustment.vignette',
  preserveColor: 'hooksHistory.adjustment.preserveColor',
  withGhs: 'hooksHistory.adjustment.ghs',
  ghs: 'hooksHistory.adjustment.ghs',
  filter: 'hooksHistory.adjustment.filter',
  filterIntensity: 'hooksHistory.adjustment.filterIntensity'
}

const PROCESSING_KEYS: Record<string, string> = {
  hotPixels: 'hooksHistory.processing.hotPixels',
  trails: 'hooksHistory.processing.trails',
  background: 'hooksHistory.processing.background',
  rbfBackground: 'hooksHistory.processing.background',
  balance: 'hooksHistory.processing.balance',
  photometricGains: 'hooksHistory.processing.photometricGains',
  colorNoise: 'hooksHistory.processing.colorNoise',
  deconvolution: 'hooksHistory.processing.deconvolution',
  nlBayes: 'hooksHistory.processing.nlBayes',
  wavelets: 'hooksHistory.processing.wavelets',
  narrowband: 'hooksHistory.processing.narrowband',
  starReduction: 'hooksHistory.processing.starReduction',
  localContrast: 'hooksHistory.processing.localContrast',
  plugin: 'hooksHistory.processing.plugin'
}

/** Highlighted stars are a way of looking, not an edit. */
function adjustmentsChanged(a: Adjustments, b: Adjustments): (keyof Adjustments)[] {
  if (a === b) return []
  return (Object.keys(b) as (keyof Adjustments)[]).filter((k) => k !== 'showStars' && a[k] !== b[k])
}

const MASK_KEYS: Record<Mask['type'], string> = {
  whole: 'hooksHistory.mask.whole',
  brightness: 'hooksHistory.mask.brightness',
  color: 'hooksHistory.mask.color',
  stars: 'hooksHistory.mask.stars',
  object: 'hooksHistory.mask.object',
  linear: 'hooksHistory.mask.linear',
  radial: 'hooksHistory.mask.radial'
}

const LOCAL_KEYS: Record<keyof LayerAdjustments, string> = {
  brightness: 'hooksHistory.local.brightness',
  contrast: 'hooksHistory.local.contrast',
  saturation: 'hooksHistory.local.saturation',
  vibrance: 'hooksHistory.local.vibrance',
  temperature: 'hooksHistory.local.temperature',
  tint: 'hooksHistory.local.tint',
  sharpness: 'hooksHistory.local.sharpness',
  noiseReduction: 'hooksHistory.local.noiseReduction'
}

/** Names of the changes to local adjustments, for example «Mask: brightness». */
function describeLocals(before: LocalLayer[], after: LocalLayer[]): string[] {
  if (before === after) return []
  if (after.length > before.length) return [t('hooksHistory.step.localAdded')]
  if (after.length < before.length) return [t('hooksHistory.step.localRemoved')]
  const names: string[] = []
  for (let i = 0; i < after.length; i++) {
    const a = before[i]
    const b = after[i]
    if (a === b) continue
    if (a.id !== b.id) {
      names.push(t('hooksHistory.step.localOrder'))
      continue
    }
    if (a.active !== b.active) names.push(t(b.active ? 'hooksHistory.step.localOn' : 'hooksHistory.step.localOff'))
    if (a.name !== b.name) names.push(t('hooksHistory.step.localName'))
    if (a.mask.painted !== b.mask.painted) names.push(t('hooksHistory.step.maskBrush'))
    const keys = (Object.keys(b.mask) as (keyof Mask)[]).filter((k) => k !== 'painted')
    if (keys.some((k) => a.mask[k] !== b.mask[k])) {
      names.push(t('hooksHistory.step.maskChanged', { mask: t(MASK_KEYS[b.mask.type]) }))
    }
    for (const k of Object.keys(b.adjustments) as (keyof LayerAdjustments)[]) {
      if (a.adjustments[k] !== b.adjustments[k]) {
        names.push(t('hooksHistory.step.localChanged', { adjustment: t(LOCAL_KEYS[k]) }))
      }
    }
  }
  return names
}

function describe(before: Snapshot, after: Snapshot): string | null {
  // A step recorded with an explicit name (for example a brush stroke).
  if (setLabel) return setLabel
  const names: string[] = []
  const add = (n: string): void => {
    if (!names.includes(n)) names.push(n)
  }

  // A processing run takes the name of the command that started it.
  if (before.image !== after.image || before.appliedProcessing !== after.appliedProcessing) {
    if (seenJob) add(seenJob)
    else if (after.appliedProcessing === null) add(t('hooksHistory.processing.removed'))
    else add(t('hooksHistory.processing.applied'))
  }
  if (before.processing !== after.processing && !seenJob) {
    for (const k of Object.keys(after.processing)) {
      const key = k as keyof typeof after.processing
      if (before.processing[key] !== after.processing[key]) {
        add(t(PROCESSING_KEYS[k] ?? 'hooksHistory.processing.generic'))
      }
    }
  }
  for (const k of adjustmentsChanged(before.adjustments, after.adjustments)) {
    if (seenJob && names.length > 0) break
    add(t(ADJUSTMENT_KEYS[k] ?? 'hooksHistory.adjustment.generic'))
  }
  if (!seenJob) for (const n of describeLocals(before.localAdjustments, after.localAdjustments)) add(n)
  if (before.curves !== after.curves && !seenJob) add(t('hooksHistory.step.curves'))
  if (before.appliedGeometry !== after.appliedGeometry && !seenJob) add(t('hooksHistory.step.rotationOrMirror'))
  if (
    !seenJob &&
    (before.crop !== after.crop || before.aspectRatio !== after.aspectRatio || before.preset !== after.preset)
  ) {
    add(t('hooksHistory.step.crop'))
  }

  if (names.length === 0) return null
  if (names.length <= 2) return names.join(', ')
  return t('hooksHistory.step.andOthers', { names: names.slice(0, 2).join(', '), count: names.length - 2 })
}

/** True if the two snapshots produce the same image. */
function equal(a: Snapshot, b: Snapshot): boolean {
  return (
    adjustmentsChanged(a.adjustments, b.adjustments).length === 0 &&
    a.localAdjustments === b.localAdjustments &&
    a.curves === b.curves &&
    a.crop === b.crop &&
    a.aspectRatio === b.aspectRatio &&
    a.preset === b.preset &&
    a.processing === b.processing &&
    a.appliedProcessing === b.appliedProcessing &&
    a.appliedGeometry === b.appliedGeometry &&
    a.rotation === b.rotation &&
    a.mirrored === b.mirrored &&
    a.freeRotation === b.freeRotation &&
    a.image === b.image
  )
}

/* ---- Memory ---- */

function byte(img: ImageData32): number {
  return img.data.byteLength
}

/**
 * Removes the oldest steps (never the initial one) until the number of steps
 * and the memory of the images held only by the history are within limits.
 */
function contains(): void {
  const s = useApp.getState()
  const alive = new Set<ImageData32 | null>([s.image, s.originalImage])
  const memory = (): number => {
    const views = new Set<ImageData32>()
    let total = 0
    for (const p of steps) {
      const img = p.photo.image
      if (img && !alive.has(img) && !views.has(img)) {
        views.add(img)
        total += byte(img)
      }
    }
    return total
  }
  while (steps.length > 2 && index > 1 && (steps.length > MAX_STEPS || memory() > IMAGE_MEMORY)) {
    steps.splice(1, 1)
    index--
  }
}

/* ---- Recording ---- */

function closeBurst(): void {
  timer = null
  if (!burstOpen) return
  // A processing run in progress keeps the burst open until it ends.
  if (useApp.getState().job.active) {
    timer = setTimeout(closeBurst, QUIET_MS)
    return
  }
  burstOpen = false
  const current = steps[index]
  const photo = takeSnapshot()
  const label = current ? describe(current.photo, photo) : null
  seenJob = null
  if (!current || label === null || equal(current.photo, photo)) return
  steps = steps.slice(0, index + 1)
  steps.push({ label, now: Date.now(), photo })
  index = steps.length - 1
  contains()
  publish()
}

/** Closes a pending burst immediately, before Undo or Redo. */
function closeNow(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (burstOpen && !useApp.getState().job.active) closeBurst()
}

/**
 * Records `edit` as a step of its own, with the given name: it first closes
 * the burst in progress (a slider just moved stays its own step) and then,
 * immediately, the burst of the edit. Used for gestures that are a whole step
 * even when close together, such as a brush stroke on a mask.
 */
export function recordStep(label: string, edit: () => void): void {
  closeNow()
  edit()
  if (timer) clearTimeout(timer)
  timer = null
  if (!burstOpen || useApp.getState().job.active) {
    // During a long operation the step closes together with it.
    if (burstOpen) timer = setTimeout(closeBurst, QUIET_MS)
    return
  }
  setLabel = label
  try {
    closeBurst()
  } finally {
    setLabel = null
  }
}

/** Restarts the history from the current source image. */
export function resetHistory(): void {
  if (timer) clearTimeout(timer)
  timer = null
  burstOpen = false
  seenJob = null
  const s = useApp.getState()
  if (s.image === null) {
    steps = []
    index = -1
  } else {
    steps = [{ label: t('hooksHistory.step.imageOpened'), now: Date.now(), photo: takeSnapshot() }]
    index = 0
  }
  publish()
}

useApp.subscribe((s, before) => {
  if (applying) return

  // New source image: the history restarts from here. Commands that follow
  // in the same tick (for example the automatic stretch on opening) are part
  // of the starting point.
  if (s.originalImage !== before.originalImage || s.activeFrameId !== before.activeFrameId) {
    steps = []
    index = -1
    burstOpen = false
    if (timer) clearTimeout(timer)
    timer = null
    publish()
    if (!settling) {
      settling = true
      setTimeout(() => {
        settling = false
        resetHistory()
      }, 0)
    }
    return
  }
  if (settling) return

  if (s.job.active && s.job.label) {
    const name = s.job.label.split(':')[0].replace(/[….]+$/, '').trim()
    if (burstOpen || !before.job.active) seenJob ??= name
  }

  const changedValue =
    s.adjustments !== before.adjustments ||
    s.localAdjustments !== before.localAdjustments ||
    s.curves !== before.curves ||
    s.crop !== before.crop ||
    s.aspectRatio !== before.aspectRatio ||
    s.preset !== before.preset ||
    s.processing !== before.processing ||
    s.appliedProcessing !== before.appliedProcessing ||
    s.appliedGeometry !== before.appliedGeometry ||
    s.image !== before.image
  if (!changedValue) {
    // A job started without changing anything yet (for example Abracadabra
    // measuring the image) still opens the burst.
    if (s.job.active && !before.job.active && index >= 0 && !burstOpen) {
      burstOpen = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(closeBurst, QUIET_MS)
    }
    return
  }
  if (index < 0) return
  burstOpen = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(closeBurst, QUIET_MS)
})

/* ---- Undo, Redo, jump to a step ---- */

function apply(i: number): void {
  const step = steps[i]
  if (!step) return
  const f = step.photo
  applying = true
  try {
    useApp.setState((s) => ({
      // Highlighted stars stay as the viewer chose them.
      adjustments: { ...f.adjustments, showStars: s.adjustments.showStars },
      localAdjustments: f.localAdjustments,
      curves: f.curves,
      crop: f.crop,
      aspectRatio: f.aspectRatio,
      preset: f.preset,
      processing: f.processing,
      appliedProcessing: f.appliedProcessing,
      appliedGeometry: f.appliedGeometry,
      rotation: f.rotation,
      mirrored: f.mirrored,
      freeRotation: f.freeRotation,
      image: f.image
    }))
  } finally {
    applying = false
  }
  // The step snapshot stays as recorded: highlighted stars do not count in
  // comparisons.
  index = i
  publish()
}

/** True if an operation is in progress: the history is not touched meanwhile. */
function busy(): boolean {
  const s = useApp.getState()
  if (!s.job.active) return false
  s.notify('warning', t('hooksHistory.waitForJob'))
  return true
}

export function undo(): void {
  if (busy()) return
  closeNow()
  if (index <= 0) return
  apply(index - 1)
}

export function repeat(): void {
  if (busy()) return
  closeNow()
  if (index >= steps.length - 1) return
  apply(index + 1)
}

/** Takes the image back to step `i` of the list; later steps are kept until the next edit. */
export function goToStep(i: number): void {
  if (busy()) return
  closeNow()
  if (i < 0 || i >= steps.length || i === index) return
  apply(i)
}
