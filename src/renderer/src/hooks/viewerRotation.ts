import { useApp } from '../store/appStore'
import { composeGeometry, rotateQuarters, mirror, mirrorOrientation } from '@core/image/geometry'
import { recordStep } from './history'
import { mirrorStraightenBase } from './straighten'
import { t } from '@shared/i18n/i18n'

/**
 * Rotates the displayed image by a quarter turn (1 clockwise, -1
 * counterclockwise).
 *
 * The rotation is real, not just a view change: it becomes part of the
 * applied geometry, so export, astrometric solution, markers, masks and crop
 * all follow it, and it can be undone. The state records how many quarter
 * turns were requested, because every new processing run starts again from
 * the source image and reapplies them at the end.
 */
export function rotateImage(direction: 1 | -1): void {
  const s = useApp.getState()
  if (!s.image || s.job.active) return
  const { image, step } = rotateQuarters(s.image, direction)
  const rotation = (((s.rotation + direction) % 4) + 4) % 4
  s.setProcessedImage(image, undefined, composeGeometry(s.appliedGeometry, step), rotation)
}

/**
 * Mirrors the displayed image left to right (`horizontal`) or top to bottom
 * (`vertical`), as it is currently seen, i.e. after any rotations already
 * applied.
 *
 * Like rotation, mirroring is real and lossless: it becomes part of the
 * applied geometry (the astrometric solution changes parity; markers, masks
 * and crop follow), it applies to export, can be undone and is saved in the
 * project. The state rewrites it in canonical order (mirror, quarter turns,
 * free rotation: see Orientation in @core/image/geometry), which every new
 * processing run reapplies at the end.
 */
export function mirrorImage(direction: 'horizontal' | 'vertical'): void {
  const s = useApp.getState()
  if (!s.image || s.job.active) return
  const before = s.image
  const { image, step } = mirror(before, direction)
  const o = mirrorOrientation({ mirrored: s.mirrored, quarters: s.rotation, degrees: s.freeRotation }, direction)
  const geometry = composeGeometry(s.appliedGeometry, step)
  recordStep(
    direction === 'horizontal' ? t('hooksViewerRotation.mirrorHorizontal') : t('hooksViewerRotation.mirrorVertical'),
    () => {
      useApp.getState().setProcessedImage(image, undefined, geometry, o.quarters, o.mirrored)
      if (o.degrees !== useApp.getState().freeRotation) useApp.setState({ freeRotation: o.degrees })
    }
  )
  mirrorStraightenBase(before, image, direction)
}
