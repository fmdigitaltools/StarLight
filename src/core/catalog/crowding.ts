import type { CelestialObject, RecognizedObject, Wcs } from '@shared/types'
import { skyToPixel } from '@core/astrometry/wcs'
import { t } from '@shared/i18n/i18n'

/**
 * Marker crowding filter.
 *
 * In rich fields the catalog finds many objects, often clustered (around
 * NGC 7331 eight lie in Stephan's Quintet): labeling them all produces an
 * unreadable tangle of names. This module decides which markers get a name,
 * with three common-sense rules:
 *
 * 1. objects are taken in order of importance: first the declared target,
 *    then objects with a common name, large and bright ones, with Messier
 *    and NGC ahead of IC and the other catalogs;
 * 2. there is a cap on the number of names, which grows with the available
 *    space (about ten on a full field on screen);
 * 3. if two names would overlap, the more important one stays.
 *
 * Excluded objects do not disappear: if they are close to a named marker
 * they are grouped with it ("Stephan's Quintet and 7 others"), otherwise
 * they remain as a small unnamed circle. Small circles are capped too,
 * again by importance: with the optional catalogs installed a wide field
 * would contain hundreds of them.
 *
 * The density chosen by the viewer (essential, normal, rich) multiplies
 * both caps.
 *
 * The decision is made in drawing pixels, so it depends on the scale: on
 * screen on the viewer zoom (zooming in separates objects and more names
 * appear), in the export on the final size. The module is pure: the caller
 * computes the geometry and asks for the choice.
 */

/** A marker already placed in drawing pixels, candidate for a name. */
export interface MarkerCandidate {
  object: RecognizedObject
  /** Circle center. */
  cx: number
  cy: number
  /**
   * Circle radius, or the semi-major axis if the marker is an ellipse:
   * overlaps are evaluated on the circumscribed circle, which is more than
   * enough to decide who keeps the name.
   */
  radius: number
  /** Baseline of the name (the text is centered on `cx`). */
  yText: number
  /** True if the plain name fits within the drawing limits. */
  nameInside: boolean
}

/** Rectangle in drawing pixels. */
export interface Rectangle {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface CrowdingParams {
  /** Area the names must stay within (the photo, or its visible part). */
  limits: Rectangle
  /** Font size of the names, in pixels. */
  textBody: number
  /** Width in pixels of a text at the given font size. */
  textMeasurer: (text: string) => number
  /** Multiplies the caps on names and small circles: 0.5 essential, 1 normal, 2 rich. */
  density?: number
}

/** Cap factor for each marker density. */
export const DENSITY_FACTOR = { essential: 0.5, normal: 1, rich: 2 } as const
export type MarkerDensity = keyof typeof DENSITY_FACTOR

/** Unnamed small circles allowed per name. */
const SMALL_CIRCLES_PER_NAME = 3

/** Marker that receives a name. */
export interface NamedMarker<C extends MarkerCandidate = MarkerCandidate> {
  candidate: C
  /** Text to write: the name, or the group name. */
  text: string
  /** Nearby objects represented by this name (not drawn). */
  grouped: RecognizedObject[]
}

export interface MarkersChoice<C extends MarkerCandidate = MarkerCandidate> {
  withName: NamedMarker<C>[]
  /** Isolated excluded objects: drawn as a small unnamed circle. */
  unnamed: C[]
}

/**
 * Reference density: on screen a portrait photo fitted to the viewer
 * covers about 500 × 900 pixels, i.e. ~2700 text "cells" (font size ×
 * font size). About ten names are wanted there.
 */
const REFERENCE_TILES = 2700
const REFERENCE_NAMES = 10
const MAX_NAMES = 30

/**
 * Cap on the number of names for a drawing area. It grows with the square
 * root of the area (measured in text cells), not proportionally: a space
 * four times larger gets twice the names, not four times, because an image
 * stays pleasant only with few names.
 */
export function namesCap(width: number, height: number, textBody: number): number {
  if (width <= 0 || height <= 0 || textBody <= 0) return 1
  const tiles = (width * height) / (textBody * textBody)
  const cap = Math.round(REFERENCE_NAMES * Math.sqrt(tiles / REFERENCE_TILES))
  return Math.max(1, Math.min(MAX_NAMES, cap))
}

/** True for the target declared by the telescope (see recognition.ts). */
export function isTarget(o: RecognizedObject): boolean {
  return o.confidence >= 0.98
}

/**
 * The object's actual common name, if it has one: "Triangulum Galaxy",
 * "Stephan's Quintet". A name that repeats the designation, such as
 * "Galaxy NGC 7331" or a plain "NGC 7317", does not count.
 */
export function commonName(o: RecognizedObject): string | null {
  const name = o.object.name.trim()
  if (name === '' || name === o.object.id) return null
  const codes = [o.object.id, ...o.object.aliases]
  if (codes.some((s) => s !== '' && name.includes(s))) return null
  return name
}

/** Weight of the source catalog, inferred from the designation. */
function catalogWeight(id: string): number {
  if (/^M\s?\d/.test(id)) return 150
  if (/^NGC\s?\d/.test(id)) return 100
  if (/^IC\s?\d/.test(id)) return 50
  return 0
}

/**
 * Importance of an object, used to decide who keeps the name. It is a sum
 * of scores: the target always wins; then the common name (what is
 * recognized at a glance), the catalog, the apparent size (on a log scale:
 * 1' → 0, 10' → 100) and the magnitude.
 */
export function importance(o: RecognizedObject): number {
  let points = isTarget(o) ? 10000 : 0
  if (commonName(o) !== null) points += 120
  points += catalogWeight(o.object.id)
  const size = o.object.sizeArcmin
  if (size !== null && size > 0) {
    points += 100 * Math.log10(Math.max(0.1, size))
  }
  const magnitude = o.object.magnitude
  if (magnitude !== null) points += (15 - magnitude) * 15
  return points
}

/** Space occupied by a text centered on `cx` with baseline `y`. */
function box(cx: number, y: number, text: string, p: CrowdingParams): Rectangle {
  const halfSize = p.textMeasurer(text) / 2
  return { x0: cx - halfSize, y0: y - p.textBody, x1: cx + halfSize, y1: y + p.textBody * 0.3 }
}

function doOverlap(a: Rectangle, b: Rectangle, margin: number): boolean {
  return (
    a.x0 - margin < b.x1 && b.x0 - margin < a.x1 && a.y0 - margin < b.y1 && b.y0 - margin < a.y1
  )
}

function inside(a: Rectangle, b: Rectangle): boolean {
  return a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1
}

function groupText(name: string, others: number): string {
  return others === 1
    ? t('coreCrowding.groupOne', { name })
    : t('coreCrowding.groupOther', { name, count: others })
}

/**
 * Chooses which markers get a name, which are grouped and which remain a
 * small circle. Candidates must have their center in the visible area;
 * `width` and `height` are the dimensions of that area, on which the cap
 * is computed.
 */
export function chooseMarkers<C extends MarkerCandidate>(
  candidates: C[],
  width: number,
  height: number,
  p: CrowdingParams
): MarkersChoice<C> {
  const density = p.density ?? 1
  const base = namesCap(width, height, p.textBody)
  const cap = Math.max(1, Math.min(MAX_NAMES * 2, Math.round(base * density)))
  const circlesCap = Math.max(3, Math.round(base * SMALL_CIRCLES_PER_NAME * density))
  const margin = p.textBody * 0.3
  const sortedItems = [...candidates].sort((a, b) => importance(b.object) - importance(a.object))

  // 1-3. Names in order of importance, while there is room and they do not touch.
  const chosenItems: { candidate: C; box: Rectangle; members: C[] }[] = []
  const excludedItems: C[] = []
  for (const c of sortedItems) {
    if (!c.nameInside) {
      excludedItems.push(c)
      continue
    }
    const s = box(c.cx, c.yText, c.object.object.id, p)
    const main = isTarget(c.object)
    const free = chosenItems.every((x) => !doOverlap(s, x.box, margin))
    if (main || (chosenItems.length < cap && free)) {
      chosenItems.push({ candidate: c, box: s, members: [] })
    } else {
      excludedItems.push(c)
    }
  }

  // Excluded objects close to a chosen name join its group. The target
  // does not collect groups: it keeps its own name, and the small objects
  // next to it remain small circles.
  const unnamed: C[] = []
  for (const e of excludedItems) {
    let best: (typeof chosenItems)[number] | null = null
    let bestDistance = Infinity
    for (const x of chosenItems) {
      if (isTarget(x.candidate.object)) continue
      const d = Math.hypot(e.cx - x.candidate.cx, e.cy - x.candidate.cy)
      const reach = x.candidate.radius + p.textBody * 2.5
      if (d <= reach && d < bestDistance) {
        best = x
        bestDistance = d
      }
    }
    if (best) best.members.push(e)
    else unnamed.push(e)
  }

  // Group text: the most important common name among the members (or the
  // representative's designation) followed by the count of the others. If
  // the longer text does not fit, the name goes back to plain and the
  // members become small circles.
  const withName: NamedMarker<C>[] = []
  for (const x of chosenItems) {
    let text = x.candidate.object.object.id
    let grouped: RecognizedObject[] = []
    if (x.members.length > 0) {
      const allItems = [x.candidate, ...x.members].sort(
        (a, b) => importance(b.object) - importance(a.object)
      )
      const withCommonName = allItems.find((c) => commonName(c.object) !== null)
      const name = withCommonName ? (commonName(withCommonName.object) as string) : text
      const proposal = groupText(name, x.members.length)
      const s = box(x.candidate.cx, x.candidate.yText, proposal, p)
      const free = chosenItems.every((y) => y === x || !doOverlap(s, y.box, margin))
      if (free && inside(s, p.limits)) {
        text = proposal
        grouped = x.members.map((m) => m.object)
        x.box = s
      } else {
        unnamed.push(...x.members)
      }
    }
    withName.push({ candidate: x.candidate, text, grouped })
  }

  // Small circles beyond the cap are dropped, least important first.
  unnamed.sort((a, b) => importance(b.object) - importance(a.object))
  return { withName, unnamed: unnamed.slice(0, circlesCap) }
}

/** Radius of the small unnamed circle, proportional to the text. */
export function circleRadius(radius: number, textBody: number): number {
  return Math.max(2, Math.min(radius, textBody * 0.4))
}

/**
 * How large the circle is relative to the catalog size. OpenNGC gives the
 * major diameter in arcminutes: the circle radius is half that diameter
 * times this factor.
 *
 * Galaxies have their own factor because their catalog diameter is measured
 * down to a very faint halo (the D25 isophote) that an amateur photo
 * usually does not reach: on M 33 the visible arms extend to about half the
 * catalog radius, on NGC 7331 and M 110 even less. For nebulae, planetary
 * nebulae and clusters the catalog size matches what is visible instead
 * (M 27: the nebula's edge lies right on the catalog radius), and a little
 * extra keeps the circle just outside it.
 * Calibrated on stacked images with a scale of about 1.19″ per pixel.
 */
export const OBJECT_RADIUS_FACTOR = 1.15
export const GALAXY_RADIUS_FACTOR = 0.55

/**
 * Circle radius of an object, in pixels of the original image, or null if
 * the catalog size or the pixel scale is missing. The caller multiplies it
 * by its own zoom and adds a small fixed margin, so that even tiny objects
 * stay visible. This is the single place where circle size is decided: it
 * is used by the viewer, the framing preview and the export.
 */
export function objectRadiusPixels(object: CelestialObject, pixelScale: number | null): number | null {
  const d = object.sizeArcmin
  if (d === null || !(d > 0) || pixelScale === null || !(pixelScale > 0)) return null
  const factor = object.type === 'galaxy' ? GALAXY_RADIUS_FACTOR : OBJECT_RADIUS_FACTOR
  return ((d * 60) / pixelScale / 2) * factor
}

/**
 * Shape of an object in pixels of the original image: semi-axes and
 * orientation of the ellipse. For an object without a known shape the two
 * semi-axes are equal (a circle).
 */
export interface ObjectEllipse {
  semiMajor: number
  semiMinor: number
  /**
   * Direction of the major axis in the image, in radians, measured from
   * the x axis (rightward) toward the y axis (downward): on screen it is a
   * clockwise angle. This is the convention of `ctx.ellipse` and, in
   * degrees, of SVG `rotate`.
   */
  angle: number
}

/**
 * Direction in the image of a line that forms position angle `pa`
 * (degrees from north through east) on the sky at point (ra, dec).
 *
 * The WCS is asked where two small steps end up, one toward north and one
 * toward east: the two pixel arrows tell how the sky is rotated and
 * whether it is mirrored in the image (in an unmirrored photo east lies to
 * the left of north, in a mirrored one to the right), and the wanted
 * direction is cos(pa) times north plus sin(pa) times east. This holds for
 * any orientation of the capture. Null if the WCS cannot place the point.
 */
export function angleInImage(wcs: Wcs, ra: number, dec: number, pa: number): number | null {
  // One arcminute: small enough to stay linear, large enough not to be
  // lost in rounding.
  const step = 1 / 60
  const cosDec = Math.cos((dec * Math.PI) / 180)
  if (cosDec < 1e-6) return null
  // Near the north pole a northward step would overshoot it: go south instead.
  const towardNorth = dec + step <= 90 ? 1 : -1
  const center = skyToPixel(wcs, ra, dec)
  const north = skyToPixel(wcs, ra, dec + towardNorth * step)
  const east = skyToPixel(wcs, ra + step / cosDec, dec)
  if (center === null || north === null || east === null) return null
  const nx = (north.x - center.x) * towardNorth
  const ny = (north.y - center.y) * towardNorth
  const ex = east.x - center.x
  const ey = east.y - center.y
  const ln = Math.hypot(nx, ny)
  const le = Math.hypot(ex, ey)
  if (!(ln > 0) || !(le > 0)) return null
  const paRad = (pa * Math.PI) / 180
  const dx = (Math.cos(paRad) * nx) / ln + (Math.sin(paRad) * ex) / le
  const dy = (Math.cos(paRad) * ny) / ln + (Math.sin(paRad) * ey) / le
  return Math.atan2(dy, dx)
}

/**
 * Ellipse of an object, in pixels of the original image, or null if the
 * catalog size or the pixel scale is missing. It extends
 * `objectRadiusPixels` (the semi-major axis is exactly that radius, with
 * the same factors): the minor axis is reduced in the catalog's ratio, and
 * the position angle is carried into the image with the WCS. If the minor
 * axis, the angle or the WCS is missing, the ellipse is a circle.
 */
export function objectEllipsePixels(
  object: CelestialObject,
  pixelScale: number | null,
  wcs: Wcs | null
): ObjectEllipse | null {
  const semiMajor = objectRadiusPixels(object, pixelScale)
  if (semiMajor === null) return null
  const circle = { semiMajor, semiMinor: semiMajor, angle: 0 }
  const larger = object.sizeArcmin as number
  const smaller = object.minorArcmin ?? null
  const pa = object.positionAngle ?? null
  if (smaller === null || !(smaller > 0) || smaller >= larger || pa === null || wcs === null) return circle
  const angle = angleInImage(wcs, object.ra, object.dec, pa)
  if (angle === null) return circle
  return { semiMajor, semiMinor: (semiMajor * smaller) / larger, angle }
}

/** Ellipse ready to draw, in drawing pixels. */
export interface DrawingEllipse {
  /** Semi-major and semi-minor axes. */
  rx: number
  ry: number
  /** Orientation of the major axis (see `ObjectEllipse.angle`). */
  angle: number
  /** Half the height of the rectangle containing the ellipse. */
  halfHeight: number
  /**
   * Distance from the center to the edge along the vertical: where the
   * name's leader line touches the ellipse.
   */
  chord: number
}

/**
 * Brings the object's ellipse to the caller's drawing scale, with the same
 * rules as the circular marker: `scale` drawing pixels per image pixel,
 * plus a small fixed `margin`; the semi-major axis stays between `minimum`
 * and `max` (if it is clipped, the minor axis is reduced in the same ratio,
 * so the shape does not change); the minor axis does not go below
 * `minimum`, because a tiny marker must stay visible (small objects thus
 * become circles again). Without an ellipse the result is a circle of
 * radius `defaultValue`.
 */
export function markerEllipse(
  e: ObjectEllipse | null,
  scale: number,
  margin: number,
  minimum: number,
  max: number,
  defaultValue: number
): DrawingEllipse {
  if (e === null) {
    return { rx: defaultValue, ry: defaultValue, angle: 0, halfHeight: defaultValue, chord: defaultValue }
  }
  const free = e.semiMajor * scale + margin
  const rx = Math.min(max, Math.max(minimum, free))
  const cut = free > max ? max / free : 1
  const ry = Math.min(rx, Math.max(minimum, (e.semiMinor * scale + margin) * cut))
  const s = Math.sin(e.angle)
  const c = Math.cos(e.angle)
  const halfHeight = Math.sqrt(rx * rx * s * s + ry * ry * c * c)
  const chord = 1 / Math.sqrt((s * s) / (rx * rx) + (c * c) / (ry * ry))
  return { rx, ry, angle: e.angle, halfHeight, chord }
}

/** A marker group whose `name` is read in the current language each time it is accessed. */
function markerGroup(
  id: string,
  nameKey: string,
  types: CelestialObject['type'][]
): { id: string; name: string; types: CelestialObject['type'][] } {
  return {
    id,
    get name(): string {
      return t('coreCrowding.markerGroups.' + nameKey)
    },
    types
  }
}

/** Groups of types that can be hidden from the markers. */
export const MARKER_GROUPS: { id: string; name: string; types: CelestialObject['type'][] }[] = [
  markerGroup('galaxies', 'galaxies', ['galaxy']),
  markerGroup('galaxy-groups', 'galaxyGroups', ['galaxy-group']),
  markerGroup('nebulae', 'nebulae', ['nebula']),
  markerGroup('dark-nebulae', 'darkNebulae', ['dark-nebula']),
  markerGroup('planetary-nebulae', 'planetaryNebulae', ['planetary-nebula']),
  markerGroup('supernova-remnants', 'supernovaRemnants', ['supernova-remnant']),
  markerGroup('star-clusters', 'starClusters', ['open-cluster', 'globular-cluster']),
  markerGroup('other', 'other', ['other', 'star', 'double-star', 'planet', 'moon', 'sun'])
]

/**
 * Removes the types hidden by the viewer from the markers. The declared
 * target always stays: it is the subject of the capture.
 */
export function filterMarkerTypes(objects: RecognizedObject[], hidden: readonly string[]): RecognizedObject[] {
  if (hidden.length === 0) return objects
  const types = new Set(MARKER_GROUPS.filter((g) => hidden.includes(g.id)).flatMap((g) => g.types))
  return objects.filter((o) => isTarget(o) || !types.has(o.object.type))
}
