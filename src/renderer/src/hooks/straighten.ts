import { create } from 'zustand'
import type { ImageData32 } from '@shared/types'
import { useApp } from '../store/appStore'
import { composeGeometry, borderlessRectangle, rotateByAngle, mirror, type AppliedGeometry } from '@core/image/geometry'
import { t } from '@shared/i18n/i18n'

/**
 * Straighten: rotates the image by an arbitrary angle.
 *
 * The rotation is always computed once, from the not yet rotated image, so
 * adjusting the angle several times does not degrade the data. For this
 * reason every rotated image remembers (in a weak map, which does not retain
 * memory) which image and geometry it came from; after an undo the state
 * returns to an image the map already knows.
 *
 * While the angle is being adjusted the viewer shows only a preview (a
 * rotation of the view, without recomputation); the actual computation
 * starts with Apply.
 */

interface Base {
  image: ImageData32
  geometry: AppliedGeometry
}

/** Rotated image → image and geometry it was rotated from. */
const bases = new WeakMap<ImageData32, Base>()

/** Background value per channel (median of a sample), used to fill the uncovered corners. */
function background(img: ImageData32): number[] {
  const n = img.width * img.height
  const step = Math.max(1, Math.floor(n / 50000))
  const result: number[] = []
  for (let c = 0; c < img.channels; c++) {
    const sample: number[] = []
    for (let i = 0; i < n; i += step) sample.push(img.data[c * n + i])
    sample.sort((a, b) => a - b)
    result.push(sample[sample.length >> 1] ?? 0)
  }
  return result
}

/**
 * Rotates `base` by `degrees` and composes the geometry. Used by processing
 * (which always restarts from the original image) and by Apply.
 */
export function rotateFreely(
  base: ImageData32,
  baseGeometry: AppliedGeometry,
  degrees: number
): { image: ImageData32; geometry: AppliedGeometry } {
  if (!Number.isFinite(degrees) || Math.abs(degrees) < 1e-6) return { image: base, geometry: baseGeometry }
  const r = rotateByAngle(base, degrees, background(base))
  const image = r.image as ImageData32
  const geometry = composeGeometry(baseGeometry, r.step)
  bases.set(image, { image: base, geometry: baseGeometry })
  return { image, geometry }
}

/**
 * After mirroring the displayed image (`before` → `after`), the base must be
 * mirrored too, because a mirror after a free rotation by a degrees is the
 * same as a rotation by −a degrees after the mirror. This way Straighten
 * keeps rotating from the not yet rotated image, and the proposed angle, if
 * the panel is open, changes sign along with the state.
 */
export function mirrorStraightenBase(before: ImageData32, after: ImageData32, direction: 'horizontal' | 'vertical'): void {
  const base = bases.get(before)
  if (base) {
    const s = mirror(base.image, direction)
    bases.set(after, { image: s.image, geometry: composeGeometry(base.geometry, s.step) })
  }
  const r = useStraighten.getState()
  if (r.open && Math.abs(r.angle) >= 1e-6) useStraighten.setState({ angle: -r.angle })
}

/** The displayed image as it was before the free rotation, with its geometry. */
function currentBase(): Base | null {
  const s = useApp.getState()
  if (!s.image) return null
  if (Math.abs(s.freeRotation) < 1e-6) return { image: s.image, geometry: s.appliedGeometry }
  return bases.get(s.image) ?? null
}

/* ---- Control panel state ---- */

interface StraightenState {
  open: boolean
  /** Total proposed angle, in degrees clockwise. */
  angle: number
  /** Removes the uncovered corners by setting the crop. */
  trimEdges: boolean
  /** True while the line to straighten is being drawn on the viewer. */
  lineTrace: boolean
}

export const useStraighten = create<StraightenState>(() => ({
  open: false,
  angle: 0,
  trimEdges: true,
  lineTrace: false
}))

export function openStraighten(): void {
  useStraighten.setState({ open: true, angle: useApp.getState().freeRotation, lineTrace: false })
}

export function closeStraighten(): void {
  useStraighten.setState({ open: false, lineTrace: false })
}

/** Preview rotation in the viewer: the remaining difference to the proposed angle. */
export function straightenPreview(): number {
  const r = useStraighten.getState()
  return r.open ? r.angle - useApp.getState().freeRotation : 0
}

/**
 * Applies the proposed angle. Returns an error message, or null on success.
 */
export async function applyStraightening(): Promise<string | null> {
  const s = useApp.getState()
  if (!s.image || s.job.active) return t('hooksStraighten.noImage')
  const base = currentBase()
  if (!base) return t('hooksStraighten.cannotRotateAgain')
  const { angle, trimEdges } = useStraighten.getState()
  // The computation takes about one second on 8 megapixels: show progress
  // first, then let the window repaint.
  s.setJob(t('hooksStraighten.job.rotating'), 0.5)
  await new Promise((done) => window.setTimeout(done, 30))
  let rotated: ReturnType<typeof rotateFreely>
  try {
    rotated = rotateFreely(base.image, base.geometry, angle)
  } finally {
    useApp.getState().finishJob()
  }
  s.setProcessedImage(rotated.image, undefined, rotated.geometry)
  const crop =
    trimEdges && Math.abs(angle) > 1e-6
      ? borderlessRectangle(base.image.width, base.image.height, angle)
      : null
  useApp.setState({
    freeRotation: Math.abs(angle) < 1e-6 ? 0 : angle,
    ...(crop ? { crop, aspectRatio: 'custom', preset: null } : {})
  })
  closeStraighten()
  return null
}

export { angleToStraighten, angleForNorthUp } from '@core/image/straighten'
