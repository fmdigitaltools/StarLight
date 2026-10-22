import type { FitsHeader, FrameMetadata, ImageData32, LoadedFrame, Wcs } from '@shared/types'
import type { InMemoryResult, ResultType } from '@core/project'
import { recognizeObjects } from '@core/catalog/recognition'
import { wcsInHeader } from '@core/astrometry/wcs'
import { useApp } from '../store/appStore'
import type { CaptionIntegration } from '@core/export/caption'

/**
 * Temporary metadata for a result that does not share the geometry of its
 * frame: drizzle (pixels half the size) and mosaic (a wider field).
 *
 * The viewer, the object markers, the field scale and photometry read the
 * astrometric solution and the scale from the metadata of the active frame.
 * When the result replaces the image, that metadata is swapped for the
 * metadata that fits the result; as soon as another image is opened in the
 * viewer (or the same frame from its file) the original metadata comes back,
 * so the library frame stays correct.
 *
 * This module also records what kind of result is shown (stacked, drizzle,
 * mosaic) and with which panels: the project saves it and, on reopening,
 * restores everything with `restoreResult`.
 */

interface Replacement {
  id: string
  /** The image the replaced metadata applies to. */
  image: ImageData32
  type: ResultType
  panels: string[]
  original: {
    metadata: FrameMetadata
    header: FitsHeader
    width: number
    height: number
    channels: 1 | 3
  }
}

let current: Replacement | null = null

/**
 * A normal stack has the geometry of the reference frame: nothing needs
 * replacing, it is enough to remember that the open image is a result and
 * not the frame as it is.
 */
let stacked: { id: string; image: ImageData32 } | null = null

/**
 * Frames and exposures of the last stack shown, for the export caption: valid
 * as long as that image stays in the viewer.
 */
let integration: { id: string; image: ImageData32; data: CaptionIntegration } | null = null

/**
 * Records which frames went into the stack just shown (`id` is the frame that
 * brings it into the viewer). A file that is already a stack counts for the
 * frames and exposure it declares.
 */
export function rememberIntegration(id: string, image: ImageData32, usedIds: string[]): void {
  const allItems = useApp.getState().frame
  const usedValues = usedIds.map((u) => allItems.find((f) => f.id === u)).filter((f): f is LoadedFrame => f !== undefined)
  integration = null
  if (usedValues.length === 0) return
  let frame = 0
  let seconds: number | null = 0
  const exposures = new Set<number>()
  for (const f of usedValues) {
    const m = originalFrame(f).metadata
    const n = m.stackCount !== null && m.stackCount > 1 ? m.stackCount : 1
    frame += n
    const exposure = m.exposure !== null && m.exposure > 0 ? m.exposure : null
    if (exposure !== null) exposures.add(Math.round(exposure * 1000) / 1000)
    const total = n > 1 && m.totalExposure !== null && m.totalExposure > 0 ? m.totalExposure : exposure !== null ? exposure * n : null
    seconds = seconds !== null && total !== null ? seconds + total : null
  }
  const date = usedValues
    .map((f) => originalFrame(f).metadata.dateObs)
    .filter((d): d is string => d !== null && /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort()
  integration = {
    id,
    image,
    data: {
      frame,
      seconds,
      exposure: exposures.size === 1 ? [...exposures][0] : null,
      before: date[0] ?? null,
      last: date[date.length - 1] ?? null
    }
  }
}

/** Frames and exposures of the stack open in the viewer, if the image is that one. */
export function integrationShown(): CaptionIntegration | null {
  const s = useApp.getState()
  const i = integration
  if (i === null || s.activeFrameId !== i.id || s.originalImage !== i.image) return null
  return i.data
}

/**
 * The frame as it is in the file, even if its metadata is currently replaced
 * by that of a result shown in the viewer. Used by code that must read the
 * file again (for example the mosaic) and by the project, which stores the
 * solutions of the frames.
 */
export function originalFrame(f: LoadedFrame): LoadedFrame {
  return current !== null && current.id === f.id ? { ...f, ...current.original } : f
}

/** Result metadata: solution, scale and any other fields. */
export interface ResultMetadata {
  wcs: Wcs | null
  pixelScale: number | null
  others?: Partial<FrameMetadata>
  /** Kind of result; drizzle if missing. */
  type?: Exclude<ResultType, 'stacked'>
  /** Paths of the frames used as panels (mosaic). */
  panels?: string[]
}

/**
 * Shows a result in the viewer in place of frame `id`, with its own
 * astrometric solution and scale.
 *
 * @param compute receives the original metadata of the frame (already
 *                restored if a previous replacement was active) and returns
 *                the metadata of the result
 */
export function showResult(
  id: string,
  image: ImageData32,
  compute: (originals: FrameMetadata) => ResultMetadata
): void {
  // Activating the frame restores any previous replacement.
  useApp.getState().setActiveFrame(id, image)
  replace(id, image, compute, true)
}

/**
 * Opens a normal stack in the viewer and records it as such, so the project
 * knows the image is not the frame as it is.
 */
export function showStacked(id: string, image: ImageData32): void {
  useApp.getState().setActiveFrame(id, image)
  stacked = { id, image }
}

function replace(
  id: string,
  image: ImageData32,
  compute: (originals: FrameMetadata) => ResultMetadata,
  recalculateObjects: boolean
): void {
  const frame = useApp.getState().frame.find((f) => f.id === id)
  if (!frame) return

  const { wcs, pixelScale, others, type, panels } = compute(frame.metadata)
  current = {
    id,
    image,
    type: type ?? 'drizzle',
    panels: panels ?? [],
    original: {
      metadata: frame.metadata,
      header: frame.header,
      width: frame.width,
      height: frame.height,
      channels: frame.channels
    }
  }
  const metadata: FrameMetadata = { ...frame.metadata, ...others, wcs, pixelScale }
  const header = wcs !== null ? wcsInHeader(frame.header, wcs) : frame.header
  useApp.setState((s) => ({
    frame: s.frame.map((f) =>
      f.id === id
        ? { ...f, metadata, header, width: image.width, height: image.height, channels: image.channels }
        : f
    )
  }))
  if (recalculateObjects) useApp.getState().setObjects(recognizeObjects(metadata))
}

/** The result currently shown in the viewer, as the project saves it. */
export type ShownResult = InMemoryResult

/**
 * Describes the result open in the viewer; null if the open image is the
 * frame as it is (or there is no active frame).
 */
export function shownResult(): ShownResult | null {
  const s = useApp.getState()
  const image = s.originalImage
  if (image === null || s.activeFrameId === null) return null
  if (current !== null && current.id === s.activeFrameId && current.image === image) {
    const f = s.frame.find((x) => x.id === current?.id)
    if (!f) return null
    return {
      type: current.type,
      width: image.width,
      height: image.height,
      wcs: f.metadata.wcs,
      pixelScale: f.metadata.pixelScale,
      ra: f.metadata.ra,
      dec: f.metadata.dec,
      panels: [...current.panels]
    }
  }
  if (stacked !== null && stacked.id === s.activeFrameId && stacked.image === image) {
    return {
      type: 'stacked',
      width: image.width,
      height: image.height,
      wcs: null,
      pixelScale: null,
      ra: null,
      dec: null,
      panels: []
    }
  }
  return null
}

/**
 * When a project is reopened: puts the saved result metadata back on frame
 * `id`, for the image `image` already open in the viewer. The frame is not
 * reactivated (the reopened processing stays as it is). Returns false if the
 * saved result does not fit the image.
 */
export function restoreResult(id: string, image: ImageData32, r: ShownResult): boolean {
  current = null
  stacked = null
  if (r.width !== image.width || r.height !== image.height) return false
  if (r.type === 'stacked') {
    stacked = { id, image }
    return true
  }
  const type = r.type
  // The recognized objects come back from the project, already correct for
  // the result: they are not recomputed.
  replace(
    id,
    image,
    (m) => ({
      wcs: r.wcs,
      pixelScale: r.pixelScale,
      others: { ra: r.ra ?? m.ra, dec: r.dec ?? m.dec },
      type,
      panels: r.panels
    }),
    false
  )
  return current !== null
}

/*
 * Restore: as soon as the open image is no longer the result, the frame gets
 * its own metadata back. If that very frame was reopened, the code opening it
 * computes the objects with the metadata it read before the restore: right
 * afterwards (at the end of the operation) they are recomputed with the
 * correct metadata.
 */
useApp.subscribe((s) => {
  const i = stacked
  if (i !== null && !(s.activeFrameId === i.id && s.originalImage === i.image)) stacked = null

  const c = current
  if (c === null) return
  if (s.activeFrameId === c.id && s.originalImage === c.image) return
  current = null
  if (!s.frame.some((f) => f.id === c.id)) return
  useApp.setState((st) => ({
    frame: st.frame.map((f) => (f.id === c.id ? { ...f, ...c.original } : f))
  }))
  if (s.activeFrameId === c.id) {
    const open = s.originalImage
    queueMicrotask(() => {
      const now = useApp.getState()
      if (now.activeFrameId === c.id && now.originalImage === open && current === null) {
        now.setObjects(recognizeObjects(c.original.metadata))
      }
    })
  }
})
