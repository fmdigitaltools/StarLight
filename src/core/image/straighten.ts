import type { Wcs } from '@shared/types'
import { skyToPixel, pixelToSky } from '@core/astrometry/wcs'

/** Rotation angle computations for Straighten: from a drawn line or from celestial north. */

/**
 * Clockwise angle, in degrees, by which to rotate the displayed image so
 * that a line drawn on screen (from a to b) becomes horizontal or vertical,
 * whichever is closer.
 */
export function angleToStraighten(a: { x: number; y: number }, b: { x: number; y: number }): number {
  let degrees = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  // Fold into the range -45..45 degrees relative to the horizontal or vertical.
  while (degrees > 45) degrees -= 90
  while (degrees < -45) degrees += 90
  return -degrees
}

/**
 * Clockwise angle, in degrees, by which to rotate the displayed image so
 * that north points up, from its astrometric solution (in pixels, y down,
 * as the viewer shows it). Null if it cannot be computed.
 */
export function angleForNorthUp(wcs: Wcs | null, width: number, height: number): number | null {
  if (!wcs) return null
  const center = pixelToSky(wcs, (width + 1) / 2, (height + 1) / 2)
  if (center.dec > 89.9) return null
  const direction = skyToPixel(wcs, center.ra, Math.min(89.99, center.dec + 0.05))
  if (!direction) return null
  const dx = direction.x - (width + 1) / 2
  const dy = direction.y - (height + 1) / 2
  // North up is the direction (0, -1): this is the angle of the north
  // direction measured clockwise from the top.
  const fromTop = (Math.atan2(dx, -dy) * 180) / Math.PI
  return -fromTop
}
