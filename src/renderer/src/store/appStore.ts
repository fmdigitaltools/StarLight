import { create } from 'zustand'
import type { LoadedFrame, ImageData32, RecognizedObject, RuntimeVersions } from '@shared/types'
import type { StretchParams } from '@core/image/stretch'
import type { Crop } from '@core/export/crop'
import { CURVE_KEY, type CurveChannel, type Curves, type CurvePoint } from '@core/image/curve'
import { NEUTRAL_CURVES } from '@core/image/curve'
import { FULL_CROP, fitFraming } from '@core/export/crop'
import { NEUTRAL_STRETCH } from '@core/image/stretch'
import { NEUTRAL_GHS, type GhsParams } from '@core/image/ghs'
import { NEUTRAL_PROCESSING, type ProcessingParams } from '@core/image/chain'
import { GEOMETRY_UNCHANGED, sameGeometry, type AppliedGeometry } from '@core/image/geometry'
import type { LocalLayer } from '@core/image/masks'
import type { MasterEntry } from '@core/stack/calibrationLibrary'

/** Workflow steps, in the order they are presented. */
export type WorkflowStep =
  | 'import'
  | 'calibrate'
  | 'align'
  | 'process'
  | 'correct'
  | 'filters'
  | 'objects'
  | 'export'

/** Correction adjustments applied in real time on the GPU. */
export interface Adjustments {
  stretch: StretchParams
  /** Additional brightness, from -1 to 1. */
  brightness: number
  /** Contrast, from -1 to 1. */
  contrast: number
  /** Colour saturation, from -1 to 1. */
  saturation: number
  /**
   * Vibrance, from -1 to 1: saturates mostly the muted colours. It adds to
   * the photo filter's vibrance, and the total stays between -1 and 1.
   */
  vibrance: number
  /** Colour balance: gain of the three channels, 1 means unchanged. */
  redGain: number
  greenGain: number
  blueGain: number
  /** Gamma correction. */
  gamma: number
  /** Noise reduction strength, from 0 to 1. */
  noiseReduction: number
  /** Sharpening strength, from 0 to 1. */
  sharpness: number
  /**
   * Background neutralization, from 0 to 1: subtracts from each channel a
   * constant level equal to the measured sky background (not a gradient).
   */
  backgroundNeutralization: number
  /**
   * Vignette, from 0 to 1: darkens the edges. It adds to the photo filter's
   * vignette, and the total stays between 0 and 1.
   */
  vignette: number
  /**
   * Colour-preserving stretch: the luminance is stretched and the three
   * channels follow it proportionally, instead of being stretched one by
   * one. This avoids coloured rings around bright stars.
   */
  preserveColor: boolean
  /**
   * Generalised hyperbolic stretch instead of the midtones transfer: the GHS
   * curve is applied between the black point and the white point.
   */
  withGhs: boolean
  ghs: GhsParams
  /** Shows the detected stars overlaid on the image. */
  showStars: boolean
  /** Id of the chosen photo filter. */
  filter: string
  /** How strongly the filter is applied, from 0 to 1. */
  filterIntensity: number
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  stretch: NEUTRAL_STRETCH,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  redGain: 1,
  greenGain: 1,
  blueGain: 1,
  gamma: 1,
  noiseReduction: 0,
  sharpness: 0,
  backgroundNeutralization: 0,
  vignette: 0,
  preserveColor: false,
  withGhs: false,
  ghs: NEUTRAL_GHS,
  showStars: false,
  filter: 'none',
  filterIntensity: 0.75
}

/**
 * A master built in the Calibrate panel from a group of frames with the same
 * capture conditions. The entry has the same format as those of the
 * calibration library, so each light picks its master with the same rules
 * (core/stack/calibrationGroups.ts): the id starts with "sessione:", and the
 * frame count, the defective pixels (dark) and the flat correction are
 * stored in the entry.
 */
export interface SessionMaster {
  entry: MasterEntry
  image: ImageData32
}

/** Calibration masters built from the imported frames: one per group of conditions. */
export interface CalibrationMaster {
  groups: SessionMaster[]
}

export const EMPTY_MASTERS: CalibrationMaster = { groups: [] }

/** Message shown in the status bar or as a notice. */
export interface Notice {
  id: number
  type: 'info' | 'ok' | 'warning' | 'error'
  text: string
  /**
   * Optional: a button in the notice that acts only when clicked (for
   * example, to re-enable internet access). The notice stays visible longer,
   * to leave time to decide.
   */
  action?: NoticeAction
}

/** Notice button: label and action. */
export interface NoticeAction {
  label: string
  run: () => void
}

interface AppState {
  /** Versions to show in the interface. */
  versions: RuntimeVersions | null
  /** Frames imported into the library. */
  frame: LoadedFrame[]
  /** Id of the frame shown in the viewer. */
  activeFrameId: string | null
  /** Image currently displayed, after debayering. */
  image: ImageData32 | null
  /**
   * Image as it was opened, before the magic wand cleanup: reset returns to
   * it. It is the same as `image` until a cleanup is applied.
   */
  originalImage: ImageData32 | null
  /** Data processing tools (Process step). */
  processing: ProcessingParams
  /** Parameters used to compute the displayed image; null if it is the original. */
  appliedProcessing: ProcessingParams | null
  /**
   * How the applied plugins moved the pixels of the displayed image relative
   * to the source image (rotated, mirrored…). The frame's astrometric
   * solution describes the source image: for markers and export it must be
   * transformed with this (see hooks/displayedAstrometry).
   */
  appliedGeometry: AppliedGeometry
  /**
   * Clockwise quarter turns requested with the rotation buttons (0 to 3).
   * They are already included in `appliedGeometry`; they are stored
   * separately because every new processing run starts again from the
   * source image and must reapply them at the end (see useProcessing).
   */
  rotation: number
  /**
   * Left-right mirror requested with the Mirror buttons, before the quarter
   * turns: the canonical order is mirror, quarter turns, free rotation (see
   * Orientation in @core/image/geometry). A top-bottom mirror is expressed
   * as a mirror plus a half turn. Like the rotations, it is already included
   * in `appliedGeometry` and every new processing run reapplies it at the
   * end.
   */
  mirrored: boolean
  /**
   * Free rotation requested with Straighten, in degrees clockwise, after the
   * quarter turns. Like those, it is already included in `appliedGeometry`
   * and every new processing run reapplies it at the end (see
   * useProcessing).
   */
  freeRotation: number
  /** Selected workflow step. */
  step: WorkflowStep
  /** Current adjustments. */
  adjustments: Adjustments
  /**
   * Local adjustments: each acts only inside its mask, after the global ones
   * (see @core/image/masks). Like the rest of the state, layers are never
   * modified in place but replaced, so the history can keep snapshots of
   * them.
   */
  localAdjustments: LocalLayer[]
  /** Celestial objects recognised in the field. */
  objects: RecognizedObject[]
  /** Available calibration masters. */
  master: CalibrationMaster
  /** Applies calibration during integration. */
  withCalibration: boolean
  /** Job in progress, with progress from 0 to 1. */
  job: { active: boolean; label: string; progress: number }
  /** Recent notices. */
  notices: Notice[]
  /** Onboarding tour in progress. */
  onboardingActive: boolean
  /** Help center open. */
  helpOpenActive: boolean
  /** About window open. */
  infoOpen: boolean
  /** Side tool panel open (slide-out drawer). */
  openPanel: boolean
  /** Tone curves for luminance and individual channels. */
  curves: Curves
  /** Portion of the image to export. */
  crop: Crop
  /** Aspect ratio chosen for the crop. */
  aspectRatio: string
  /** Selected preset, if any. */
  preset: string | null
  /** Viewer zoom: 1 means one image pixel per screen pixel. */
  zoom: number
  /** Viewer pan in pixels. */
  pan: { x: number; y: number }
  /** Open project (name and folder), or null if the work has not been saved yet. */
  project: { name: string; folder: string } | null
  /** True if the project has unsaved changes. */
  modified: boolean

  setVersions: (v: RuntimeVersions) => void
  addFrame: (f: LoadedFrame[]) => void
  removeFrame: (id: string) => void
  clearLibrary: () => void
  setActiveFrame: (id: string, image: ImageData32) => void
  /** Replaces the displayed image with a processed version, keeping the original. */
  setProcessedImage: (
    image: ImageData32,
    applied?: ProcessingParams,
    geometry?: AppliedGeometry,
    rotation?: number,
    mirrored?: boolean
  ) => void
  setProcessing: (patch: Partial<ProcessingParams>) => void
  toggleExclusion: (id: string) => void
  setStep: (p: WorkflowStep) => void
  updateAdjustments: (patch: Partial<Adjustments>) => void
  setLocalAdjustments: (levels: LocalLayer[]) => void
  /** Restores everything to the state in which the image was opened. */
  resetView: (stretch: StretchParams) => void
  /** Removes every correction, showing the data as stored in the file. */
  showLinear: () => void
  setObjects: (o: RecognizedObject[]) => void
  setMaster: (m: Partial<CalibrationMaster>) => void
  setUseCalibration: (v: boolean) => void
  setJob: (label: string, progress: number) => void
  finishJob: () => void
  notify: (type: Notice['type'], text: string, action?: NoticeAction) => void
  closeNotice: (id: number) => void
  setOnboarding: (active: boolean) => void
  setHelpOpen: (active: boolean) => void
  setInfo: (opened: boolean) => void
  togglePanel: () => void
  setCurve: (channel: CurveChannel, points: CurvePoint[]) => void
  resetCurves: () => void
  setCrop: (r: Crop) => void
  setAspectRatio: (id: string) => void
  setPreset: (id: string | null) => void
  setZoom: (z: number) => void
  setPan: (x: number, y: number) => void
  fitView: () => void
  setProject: (p: { name: string; folder: string } | null) => void
  markModified: (v: boolean) => void
  /**
   * Closes the project: empties the library and resets all processing,
   * returning the program to its just-started state.
   */
  closeProject: () => void
}

let noticeCounter = 0

export const useApp = create<AppState>((set) => ({
  versions: null,
  frame: [],
  activeFrameId: null,
  image: null,
  originalImage: null,
  processing: NEUTRAL_PROCESSING,
  appliedProcessing: null,
  appliedGeometry: GEOMETRY_UNCHANGED,
  rotation: 0,
  mirrored: false,
  freeRotation: 0,
  step: 'import',
  adjustments: NEUTRAL_ADJUSTMENTS,
  localAdjustments: [],
  objects: [],
  master: EMPTY_MASTERS,
  withCalibration: true,
  job: { active: false, label: '', progress: 0 },
  notices: [],
  onboardingActive: false,
  helpOpenActive: false,
  infoOpen: false,
  openPanel: true,
  curves: NEUTRAL_CURVES,
  crop: FULL_CROP,
  aspectRatio: 'original',
  preset: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  project: null,
  modified: false,

  setVersions: (versions) => set({ versions }),

  addFrame: (newOnes) =>
    set((s) => {
      // Files already present are not duplicated.
      const presentItems = new Set(s.frame.map((f) => f.path))
      const toAdd = newOnes.filter((f) => !presentItems.has(f.path))
      return { frame: [...s.frame, ...toAdd] }
    }),

  removeFrame: (id) =>
    set((s) => ({
      frame: s.frame.filter((f) => f.id !== id),
      activeFrameId: s.activeFrameId === id ? null : s.activeFrameId,
      image: s.activeFrameId === id ? null : s.image,
      originalImage: s.activeFrameId === id ? null : s.originalImage
    })),

  clearLibrary: () =>
    set({
      frame: [],
      activeFrameId: null,
      image: null,
      originalImage: null,
      objects: [],
      processing: NEUTRAL_PROCESSING,
      appliedProcessing: null,
      appliedGeometry: GEOMETRY_UNCHANGED,
      rotation: 0,
      mirrored: false,
      freeRotation: 0,
      localAdjustments: []
    }),

  setActiveFrame: (id, image) =>
    set({
      activeFrameId: id,
      image,
      originalImage: image,
      processing: NEUTRAL_PROCESSING,
      appliedProcessing: null,
      appliedGeometry: GEOMETRY_UNCHANGED,
      rotation: 0,
      mirrored: false,
      freeRotation: 0,
      curves: NEUTRAL_CURVES,
      // Masks are drawn on a specific image: they would be meaningless on
      // another one.
      localAdjustments: [],
      crop: FULL_CROP,
      aspectRatio: 'original',
      preset: null
    }),

  toggleExclusion: (id) =>
    set((s) => ({
      frame: s.frame.map((f) => (f.id === id ? { ...f, excluded: !f.excluded } : f))
    })),

  // Choosing a step always opens the tool drawer: if it stayed closed, the
  // click would seem to do nothing.
  setStep: (step) => set({ step, openPanel: true }),

  updateAdjustments: (patch) =>
    set((s) => ({ adjustments: { ...s.adjustments, ...patch } })),

  setLocalAdjustments: (localAdjustments) => set({ localAdjustments }),

  /*
   * If plugins rotated or mirrored the image differently than before, the
   * export crop (in fractions of the displayed image) follows it in the same
   * update: the history records a single step, and Undo restores image and
   * crop together.
   */
  setProcessedImage: (image, applied, geometry, rotation, mirrored) =>
    set((s) => {
      const appliedGeometry = geometry ?? s.appliedGeometry
      const framing =
        s.image && !sameGeometry(s.appliedGeometry, appliedGeometry)
          ? fitFraming(
              { crop: s.crop, aspectRatio: s.aspectRatio, preset: s.preset },
              s.appliedGeometry,
              appliedGeometry,
              { width: s.image.width, height: s.image.height },
              { width: image.width, height: image.height }
            )
          : null
      return {
        image,
        appliedProcessing: applied ?? s.appliedProcessing,
        appliedGeometry,
        rotation: rotation ?? s.rotation,
        mirrored: mirrored ?? s.mirrored,
        ...(framing ? framing : {})
      }
    }),

  setProcessing: (patch) =>
    set((s) => ({ processing: { ...s.processing, ...patch } })),

  /*
   * Reset: the adjustments return to neutral, but the stretch is restored to
   * what it was when the image was opened. Without it the image would look
   * almost black, a state the user has never seen, while they expect to
   * return to the starting point.
   */
  resetView: (stretch) =>
    set((s) => ({
      adjustments: { ...NEUTRAL_ADJUSTMENTS, stretch },
      localAdjustments: [],
      curves: NEUTRAL_CURVES,
      image: s.originalImage ?? s.image,
      processing: NEUTRAL_PROCESSING,
      appliedProcessing: null,
      appliedGeometry: GEOMETRY_UNCHANGED,
      // The image returns to the source one, mirror and rotations included.
      rotation: 0,
      mirrored: false,
      freeRotation: 0,
      crop: FULL_CROP
    })),

  showLinear: () => set({ adjustments: NEUTRAL_ADJUSTMENTS }),

  setObjects: (objects) => set({ objects }),

  setMaster: (patch) => set((s) => ({ master: { ...s.master, ...patch } })),

  setUseCalibration: (withCalibration) => set({ withCalibration }),

  setJob: (label, progress) =>
    set({ job: { active: true, label, progress } }),

  finishJob: () => set({ job: { active: false, label: '', progress: 0 } }),

  notify: (type, text, action) =>
    set((s) => ({
      notices: [...s.notices.slice(-4), { id: ++noticeCounter, type, text, ...(action ? { action } : {}) }]
    })),

  closeNotice: (id) => set((s) => ({ notices: s.notices.filter((a) => a.id !== id) })),

  setOnboarding: (onboardingActive) => set({ onboardingActive }),
  setHelpOpen: (helpOpenActive) => set({ helpOpenActive }),
  setInfo: (infoOpen) => set({ infoOpen }),
  togglePanel: () => set((s) => ({ openPanel: !s.openPanel })),

  setCurve: (channel, points) =>
    set((s) => ({ curves: { ...s.curves, [CURVE_KEY[channel]]: points } })),

  resetCurves: () => set({ curves: NEUTRAL_CURVES }),

  setCrop: (crop) => set({ crop }),
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),
  setPreset: (preset) => set({ preset }),

  setZoom: (zoom) => set({ zoom: Math.min(16, Math.max(0.02, zoom)) }),
  setPan: (x, y) => set({ pan: { x, y } }),
  fitView: () => set({ zoom: 0, pan: { x: 0, y: 0 } }),

  setProject: (project) => set({ project }),
  markModified: (modified) => set({ modified }),

  closeProject: () =>
    set({
      frame: [],
      activeFrameId: null,
      image: null,
      originalImage: null,
      objects: [],
      processing: NEUTRAL_PROCESSING,
      appliedProcessing: null,
      appliedGeometry: GEOMETRY_UNCHANGED,
      rotation: 0,
      mirrored: false,
      freeRotation: 0,
      adjustments: NEUTRAL_ADJUSTMENTS,
      localAdjustments: [],
      curves: NEUTRAL_CURVES,
      crop: FULL_CROP,
      aspectRatio: 'original',
      preset: null,
      master: EMPTY_MASTERS,
      withCalibration: true,
      step: 'import',
      zoom: 0,
      pan: { x: 0, y: 0 },
      project: null,
      modified: false
    })
}))
