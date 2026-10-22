import { useMemo } from 'react'
import type { RecognizedObject, Wcs } from '@shared/types'
import { transformWcs } from '@core/astrometry/wcs'
import { affineDeterminant, transformNormalizedPosition, type AppliedGeometry } from '@core/image/geometry'
import { useApp } from '../store/appStore'

/**
 * Astrometric solution and recognized objects of the DISPLAYED image.
 *
 * The frame solution (`metadata.wcs`) and the object positions (`objects`)
 * describe the original image. If a plugin rotated or mirrored the pixels,
 * they must be transformed the same way before drawing the markers or
 * writing the FITS file: this module does that, starting from
 * `appliedGeometry`. Everything that displays or exports the processed image
 * goes through here, so they cannot diverge.
 *
 * If a plugin moved the pixels without saying how, the solution is removed
 * and the objects remain recognized by name but without a position: no
 * marker is better than one in the wrong place.
 */
export interface DisplayedAstrometry {
  wcs: Wcs | null
  /** Arcseconds per pixel of the displayed image. */
  pixelScale: number | null
  objects: RecognizedObject[]
  /** True if the positions were removed because the geometry is unknown. */
  hidden: boolean
}

export function displayedAstrometry(
  wcs: Wcs | null,
  pixelScale: number | null,
  objects: RecognizedObject[],
  geometry: AppliedGeometry
): DisplayedAstrometry {
  if (geometry.type === 'unchanged') return { wcs, pixelScale, objects, hidden: false }
  if (geometry.type === 'unknown') {
    return {
      wcs: null,
      pixelScale: null,
      objects: objects.map((o) => (o.position === null ? o : { ...o, position: null })),
      hidden: objects.some((o) => o.position !== null) || wcs !== null
    }
  }
  const { width, height } = geometry.output
  // A pixel area scales by |det|: the linear scale by its square root.
  const factor = Math.sqrt(Math.abs(affineDeterminant(geometry.matrix)))
  return {
    wcs: wcs !== null ? transformWcs(wcs, geometry.matrix, width, height) : null,
    pixelScale: pixelScale !== null && factor > 0 ? pixelScale / factor : pixelScale,
    objects: objects.map((o) =>
      o.position === null ? o : { ...o, position: transformNormalizedPosition(geometry, o.position) }
    ),
    hidden: false
  }
}

/** The same, read from the current state (for non-component callers). */
export function displayedAstrometryNow(): DisplayedAstrometry {
  const s = useApp.getState()
  const active = s.frame.find((f) => f.id === s.activeFrameId) ?? null
  return displayedAstrometry(
    active?.metadata.wcs ?? null,
    active?.metadata.pixelScale ?? null,
    s.objects,
    s.appliedGeometry
  )
}

/** The same, for components: recomputed only when something relevant changes. */
export function useDisplayedAstrometry(): DisplayedAstrometry {
  const metadata = useApp((s) => s.frame.find((f) => f.id === s.activeFrameId)?.metadata ?? null)
  const objects = useApp((s) => s.objects)
  const geometry = useApp((s) => s.appliedGeometry)
  const wcs = metadata?.wcs ?? null
  const pixelScale = metadata?.pixelScale ?? null
  return useMemo(() => displayedAstrometry(wcs, pixelScale, objects, geometry), [wcs, pixelScale, objects, geometry])
}
