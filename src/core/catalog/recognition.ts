import type { CelestialObject, FrameMetadata, RecognizedObject } from '@shared/types'
import { CATALOG, searchCatalog, placeableInField } from './catalog'
import { normalizedPosition, scaleArcsec } from '@core/astrometry/wcs'

/**
 * Recognition of the framed objects.
 *
 * Two independent routes are used, in order of reliability:
 *
 * 1. the name declared by the telescope in the file header, which for
 *    automated telescopes matches the target chosen in their app;
 * 2. the coordinates of the field center, compared with the catalog: this
 *    also finds objects in the frame that were not the main target.
 */

const DEGREES_TO_RADIANS = Math.PI / 180

/**
 * Angular distance between two points of the celestial sphere, in degrees.
 * The haversine formula is used, which is stable for small angles too.
 */
export function angularDistance(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const phi1 = dec1 * DEGREES_TO_RADIANS
  const phi2 = dec2 * DEGREES_TO_RADIANS
  const dPhi = phi2 - phi1
  const dLambda = (ra2 - ra1) * DEGREES_TO_RADIANS

  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2)

  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / DEGREES_TO_RADIANS
}

/**
 * Looks up a catalog entry by identifier or alternative name. If the name
 * is shared by several objects the curated one wins, then Messier, NGC, IC
 * (see `searchCatalog`).
 */
export function searchByName(name: string): CelestialObject | null {
  return searchCatalog(name)
}

/**
 * Size of the framed field in degrees, if it can be derived from the
 * metadata. With an astrometric solution its scale, the true one, is used;
 * otherwise the one computed from focal length and pixel size.
 */
export function framedField(
  metadata: FrameMetadata,
  pixelWidth: number,
  pixelHeight: number
): { width: number; height: number } | null {
  const wcsScale = metadata.wcs ? scaleArcsec(metadata.wcs) : null
  const scale = wcsScale !== null && Number.isFinite(wcsScale) && wcsScale > 0 ? wcsScale : metadata.pixelScale
  if (scale === null || scale <= 0) return null
  return {
    width: (scale * pixelWidth) / 3600,
    height: (scale * pixelHeight) / 3600
  }
}

/**
 * Recognizes the objects in the field. The result is sorted by decreasing
 * reliability.
 *
 * When the header carries an astrometric solution, the position of every
 * object is computed exactly, not estimated. Without one, the object is
 * still recognized by name or by proximity to the pointing coordinates,
 * but the position stays `null`: no circle is drawn where the position is
 * unknown; it is described in words instead.
 */
export function recognizeObjects(
  metadata: FrameMetadata,
  pixelWidth = 0,
  pixelHeight = 0
): RecognizedObject[] {
  void pixelWidth
  void pixelHeight
  const foundItems = new Map<string, RecognizedObject>()
  const wcs = metadata.wcs

  const main = metadata.object !== null ? searchByName(metadata.object) : null
  const offsetOf = (o: CelestialObject): number | null =>
    metadata.ra !== null && metadata.dec !== null
      ? angularDistance(metadata.ra, metadata.dec, o.ra, o.dec) * 60
      : null

  // With an astrometric solution: computed position.
  if (wcs) {
    for (const object of CATALOG) {
      const isTarget = main !== null && object.id === main.id
      // Stars and Solar System bodies: only if they are the target, and in
      // any case without a position circle (stars are marked at the center
      // where the go-to pointed, the Solar System has no fixed catalog
      // position).
      if (!placeableInField(object.type)) {
        if (!isTarget) continue
        foundItems.set(object.id, {
          object: object,
          confidence: 0.99,
          method: 'header-name',
          offsetArcmin: offsetOf(object),
          position: null
        })
        continue
      }
      const position = normalizedPosition(wcs, object.ra, object.dec)
      if (position === null && !isTarget) continue
      foundItems.set(object.id, {
        object: object,
        confidence: isTarget ? 0.99 : 0.9,
        method: position === null ? 'header-name' : 'wcs',
        offsetArcmin: offsetOf(object),
        position: position
      })
    }
    addUnknownTarget(foundItems, metadata, main)
    return sort(foundItems)
  }

  // Without a solution: recognize, but do not place.
  if (main) {
    foundItems.set(main.id, {
      object: main,
      confidence: 0.98,
      method: 'header-name',
      offsetArcmin: 0,
      position: null
    })
  }

  if (metadata.ra !== null && metadata.dec !== null) {
    for (const object of CATALOG) {
      if (!placeableInField(object.type)) continue
      const distance = angularDistance(metadata.ra, metadata.dec, object.ra, object.dec)
      const extension = object.sizeArcmin !== null ? object.sizeArcmin / 120 : 0
      if (distance > 0.5 + extension) continue

      const existing = foundItems.get(object.id)
      if (existing) {
        existing.offsetArcmin = distance * 60
        continue
      }
      foundItems.set(object.id, {
        object: object,
        confidence: Math.max(0.35, 0.95 - distance / 0.5),
        method: distance < 0.05 ? 'coordinates' : 'solved-field',
        offsetArcmin: distance * 60,
        position: null
      })
    }
  }

  addUnknownTarget(foundItems, metadata, main)
  return sort(foundItems)
}

function sort(foundItems: Map<string, RecognizedObject>): RecognizedObject[] {
  return [...foundItems.values()].sort((a, b) => b.confidence - a.confidence)
}

/**
 * Target declared by the telescope but missing from the catalog: a passing
 * comet, or any uncatalogued object. Instead of showing nothing, the raw
 * name is shown as a label, without a position.
 */
function addUnknownTarget(
  foundItems: Map<string, RecognizedObject>,
  metadata: FrameMetadata,
  main: CelestialObject | null
): void {
  if (main !== null || metadata.object === null) return
  const name = metadata.object.trim()
  if (name === '') return
  foundItems.set('__bersaglio__', {
    object: {
      id: name,
      name: name,
      aliases: [],
      type: 'other',
      ra: metadata.ra ?? 0,
      dec: metadata.dec ?? 0,
      magnitude: null,
      sizeArcmin: null,
      constellation: '',
      description: ''
    },
    confidence: 0.9,
    method: 'header-name',
    offsetArcmin: 0,
    position: null
  })
}


/** Converts decimal degrees into hours, minutes and seconds of right ascension. */
export function formatRightAscension(degrees: number): string {
  // Rounded to tenths of a second before splitting, so 59.96 s never shows as 60.0.
  const tenths = Math.round((degrees / 15) * 36000) % 864000
  const h = Math.floor(tenths / 36000)
  const m = Math.floor((tenths % 36000) / 600)
  const s = (tenths % 600) / 10
  return h + 'h ' + String(m).padStart(2, '0') + 'm ' + s.toFixed(1) + 's'
}

/** Converts decimal degrees into degrees, minutes and seconds of declination. */
export function formatDeclination(degrees: number): string {
  const sign = degrees < 0 ? '-' : '+'
  // Rounded to whole seconds before splitting, so 59.6" never shows as 60".
  const seconds = Math.round(Math.abs(degrees) * 3600)
  const g = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return sign + g + '° ' + String(m).padStart(2, '0') + "' " + s.toFixed(0) + '"'
}
