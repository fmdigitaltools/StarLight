import type { Wcs } from '@shared/types'
import type { CaptionCorner, CaptionChoice } from '../export/caption'
import { skyToPixel, pixelToSky, scaleArcsec } from './wcs'

/**
 * Coordinates drawn over the image, computed from the astrometric
 * solution: the right ascension and declination grid with values at the
 * edges, the orientation cross (north and east) and the scale bar.
 *
 * This module does not draw: it produces a "scene" of strokes and texts
 * already in destination pixels, the same for the viewer, the Export step
 * preview and the exported file. The renderer (SVG or canvas) only walks
 * it, so the three views cannot diverge.
 *
 * Image positions are normalized from 0 to 1 with the origin at the top
 * left, as for the object markers (see normalizedPosition in wcs.ts).
 */

const DEG_TO_RAD = Math.PI / 180

/** What to draw: the three choices of the Objects step. */
export interface CoordinatesChoice {
  grid: boolean
  orientation: boolean
  scale: boolean
}

export function noCoordinates(s: CoordinatesChoice): boolean {
  return !s.grid && !s.orientation && !s.scale
}

/**
 * Where and how large to draw. The whole image, in destination pixels,
 * occupies the rectangle starting at (ox, oy), `width` wide and `height`
 * tall; only the (normalized) `region` part is visible, for example the
 * exported crop or the zoomed area in the viewer.
 */
export interface CoordinateView {
  ox: number
  oy: number
  width: number
  height: number
  region: { x0: number; y0: number; x1: number; y1: number }
  /** Font size of the texts, in destination pixels: everything else scales with it. */
  body: number
  /** Corner holding orientation and scale (see toolsCorner). */
  angle: CaptionCorner
  /**
   * Areas already taken, in destination pixels (for example the caption):
   * no grid label is placed over them.
   */
  reserved?: { x0: number; y0: number; x1: number; y1: number }[]
}

export type CoordinateMark =
  | {
      type: 'segment'
      points: { x: number; y: number }[]
      /** Grid lines are faint, orientation and scale lines solid. */
      faint: boolean
    }
  | {
      type: 'text'
      x: number
      y: number
      text: string
      align: 'start' | 'middle' | 'end'
      base: 'top' | 'middle' | 'bottom'
      faint: boolean
    }

/**
 * Corner for orientation and scale, away from the caption: on the opposite
 * side of the same edge for the Minimal and Card templates; top right with
 * the Banner, which takes the whole bottom edge.
 */
export function toolsCorner(caption: CaptionChoice | null): CaptionCorner {
  if (caption === null) return 'bottom-right'
  if (caption.model === 'banner') return 'top-right'
  const oppositeCorners: Record<CaptionCorner, CaptionCorner> = {
    'bottom-right': 'bottom-left',
    'bottom-left': 'bottom-right',
    'top-right': 'top-left',
    'top-left': 'top-right'
  }
  return oppositeCorners[caption.angle]
}

/* ---- Conversions between pixels, normalized positions and sky ---- */

function normFromPixel(wcs: Wcs, x: number, y: number): { x: number; y: number } {
  return { x: (x - 0.5) / wcs.naxis1, y: (y - 0.5) / wcs.naxis2 }
}

function skyFromNorm(wcs: Wcs, nx: number, ny: number): { ra: number; dec: number } {
  return pixelToSky(wcs, nx * wcs.naxis1 + 0.5, ny * wcs.naxis2 + 0.5)
}

function normFromSky(wcs: Wcs, ra: number, dec: number): { x: number; y: number } | null {
  const p = skyToPixel(wcs, ra, dec)
  return p === null ? null : normFromPixel(wcs, p.x, p.y)
}

/** Right ascension offset between -180 and 180 degrees. */
function rejection(ra: number, center: number): number {
  return ((((ra - center) % 360) + 540) % 360) - 180
}

/* ---- "Round" steps of the grid and the scale ---- */

/** Declination steps, in arcseconds. */
const DEC_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 18000, 36000, 54000, 108000]
/** Right ascension steps, in seconds of time (1 s = 15″). */
const RA_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600]
/** Scale bar lengths, in arcseconds. */
const SCALE_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 18000, 36000]

/** The smallest step in the list not less than `minimum`. */
function roundStep(steps: number[], minimum: number): number {
  return steps.find((p) => p >= minimum) ?? steps[steps.length - 1]
}

/* ---- Texts ---- */

/** Declination with the step's precision: "+41°", "+41°30′", "+41°30′15″". */
export function declinationText(dec: number, stepArcsec: number): string {
  const unit = stepArcsec >= 3600 ? 3600 : stepArcsec >= 60 ? 60 : 1
  const total = Math.round((Math.abs(dec) * 3600) / unit) * unit
  const g = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const sign = dec < 0 && total > 0 ? '−' : '+'
  if (unit === 3600) return sign + g + '°'
  if (unit === 60) return sign + g + '°' + String(m).padStart(2, '0') + '′'
  return sign + g + '°' + String(m).padStart(2, '0') + '′' + String(s).padStart(2, '0') + '″'
}

/** Right ascension with the step's precision: "3h", "0h42m", "0h42m30s". */
export function rightAscensionText(ra: number, stepSeconds: number): string {
  const unit = stepSeconds >= 3600 ? 3600 : stepSeconds >= 60 ? 60 : 1
  const total = (Math.round((((ra % 360) + 360) % 360) * 240 / unit) * unit) % 86400
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (unit === 3600) return h + 'h'
  if (unit === 60) return h + 'h' + String(m).padStart(2, '0') + 'm'
  return h + 'h' + String(m).padStart(2, '0') + 'm' + String(s).padStart(2, '0') + 's'
}

/** Angular size of the scale bar: "30″", "10′", "2°". */
export function scaleText(arcsec: number): string {
  if (arcsec >= 3600) return arcsec / 3600 + '°'
  if (arcsec >= 60) return arcsec / 60 + '′'
  return arcsec + '″'
}

/* ---- Grid ---- */

export interface GridLine {
  type: 'ra' | 'dec'
  /** Line value, in degrees. */
  value: number
  text: string
  /** Continuous strokes in normalized positions (broken outside the projection). */
  segments: { x: number; y: number }[][]
}

/**
 * Right ascension and declination lines crossing the (normalized) region
 * of the image. The step is round and such that the lines are at least
 * `minDistance` apart (fraction of the shorter side of the region) and
 * about `desiredLines` per side.
 */
export function coordinateGrid(
  wcs: Wcs,
  region: { x0: number; y0: number; x1: number; y1: number },
  desiredLines = 5,
  minDistance = 0.12
): GridLine[] {
  if (wcs.naxis1 <= 0 || wcs.naxis2 <= 0) return []
  const center = skyFromNorm(wcs, (region.x0 + region.x1) / 2, (region.y0 + region.y1) / 2)

  // Sky extent of the region, from a mesh of points (edges included).
  let decMin = Infinity
  let decMax = -Infinity
  let raMin = Infinity
  let raMax = -Infinity
  const N = 12
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const nx = region.x0 + ((region.x1 - region.x0) * i) / N
      const ny = region.y0 + ((region.y1 - region.y0) * j) / N
      const c = skyFromNorm(wcs, nx, ny)
      decMin = Math.min(decMin, c.dec)
      decMax = Math.max(decMax, c.dec)
      const d = rejection(c.ra, center.ra)
      raMin = Math.min(raMin, d)
      raMax = Math.max(raMax, d)
    }
  }
  // A pole inside the region: all right ascensions, declination up to ±90°.
  const inside = (p: { x: number; y: number } | null): boolean =>
    p !== null && p.x >= region.x0 && p.x <= region.x1 && p.y >= region.y0 && p.y <= region.y1
  const northPole = inside(normFromSky(wcs, 0, 90))
  const southPole = inside(normFromSky(wcs, 0, -90))
  if (northPole) decMax = 90
  if (southPole) decMin = -90
  if (northPole || southPole) {
    raMin = -180
    raMax = 180
  }

  // Field scale: degrees per normalized unit along the shorter side.
  const degreesPerPixel = scaleArcsec(wcs) / 3600
  const shortSide = Math.min((region.x1 - region.x0) * wcs.naxis1, (region.y1 - region.y0) * wcs.naxis2)
  const minDegrees = minDistance * shortSide * degreesPerPixel

  const decStep =
    roundStep(DEC_STEPS, Math.max(((decMax - decMin) / desiredLines) * 3600, minDegrees * 3600)) / 3600
  // In right ascension the lines converge toward the poles: the minimum
  // step widens by 1 / cos(dec).
  const cosDec = Math.max(0.05, Math.cos(center.dec * DEG_TO_RAD))
  const raStepSeconds = roundStep(
    RA_STEPS,
    Math.max(((raMax - raMin) / desiredLines) * 240, (minDegrees / cosDec) * 240)
  )
  const raStep = raStepSeconds / 240

  const lines: GridLine[] = []
  const SAMPLES = 160
  // Beyond this a stroke is useless and would produce huge numbers: it is broken.
  const margin = 0.6
  const useful = (p: { x: number; y: number } | null): p is { x: number; y: number } =>
    p !== null &&
    p.x > region.x0 - margin &&
    p.x < region.x1 + margin &&
    p.y > region.y0 - margin &&
    p.y < region.y1 + margin
  const trace = (point: (t: number) => { x: number; y: number } | null): { x: number; y: number }[][] => {
    const segments: { x: number; y: number }[][] = []
    let current: { x: number; y: number }[] = []
    for (let k = 0; k <= SAMPLES; k++) {
      const p = point(k / SAMPLES)
      if (useful(p)) current.push(p)
      else if (current.length > 0) {
        if (current.length > 1) segments.push(current)
        current = []
      }
    }
    if (current.length > 1) segments.push(current)
    return segments
  }

  // Declination lines (parallels), traced along right ascension.
  const raFrom = raMin - raStep
  const raTo = raMax + raStep
  for (let k = Math.ceil(decMin / decStep); k * decStep <= decMax + 1e-9; k++) {
    const dec = k * decStep
    if (Math.abs(dec) >= 90 - 1e-9) continue
    const segments = trace((t) => normFromSky(wcs, center.ra + raFrom + (raTo - raFrom) * t, dec))
    if (segments.length > 0) lines.push({ type: 'dec', value: dec, text: declinationText(dec, decStep * 3600), segments })
  }

  // Right ascension lines (meridians), traced along declination.
  const decDa = Math.max(-89.999, decMin - decStep)
  const decA = Math.min(89.999, decMax + decStep)
  const absoluteRaMin = center.ra + raMin
  const absoluteRaMax = center.ra + raMax
  const seenItems = new Set<number>()
  for (let k = Math.ceil(absoluteRaMin / raStep); k * raStep <= absoluteRaMax + 1e-9; k++) {
    const ra = (((k * raStep) % 360) + 360) % 360
    // With a pole in the field the range covers the full turn: skip duplicates.
    const key = Math.round(ra * 1e6)
    if (seenItems.has(key)) continue
    seenItems.add(key)
    const segments = trace((t) => normFromSky(wcs, ra, decDa + (decA - decDa) * t))
    if (segments.length > 0) lines.push({ type: 'ra', value: ra, text: rightAscensionText(ra, raStepSeconds), segments })
  }
  return lines
}

/* ---- Orientation and scale ---- */

/**
 * Directions of north and east at a (normalized) point, as unit vectors in
 * pixels with the y axis pointing down. Null if they cannot be computed
 * (point outside the projection).
 */
export function northEastDirections(
  wcs: Wcs,
  nx: number,
  ny: number
): { north: { x: number; y: number }; east: { x: number; y: number } } | null {
  const px = nx * wcs.naxis1 + 0.5
  const py = ny * wcs.naxis2 + 0.5
  const c = pixelToSky(wcs, px, py)
  // A step of about twenty pixels: enough for precision, small enough for
  // the curvature of the projection.
  const d = (scaleArcsec(wcs) * 20) / 3600
  const towardNorth = c.dec + d <= 90 ? 1 : -1
  const pn = skyToPixel(wcs, c.ra, c.dec + d * towardNorth)
  const pe = skyToPixel(wcs, c.ra + d / Math.max(0.01, Math.cos(c.dec * DEG_TO_RAD)), c.dec)
  if (pn === null || pe === null) return null
  const unitVector = (dx: number, dy: number): { x: number; y: number } | null => {
    const l = Math.hypot(dx, dy)
    return l > 0 ? { x: dx / l, y: dy / l } : null
  }
  const north = unitVector((pn.x - px) * towardNorth, (pn.y - py) * towardNorth)
  const east = unitVector(pe.x - px, pe.y - py)
  return north && east ? { north, east } : null
}

/**
 * Scale bar: the longest round size not exceeding `fraction` of the given
 * width (in image pixels), with its length in image pixels.
 */
export function scaleBar(
  wcs: Wcs,
  pixelWidth: number,
  fraction = 0.2
): { arcsec: number; pixel: number; text: string } | null {
  const scale = scaleArcsec(wcs)
  if (!(scale > 0) || !(pixelWidth > 0)) return null
  const max = fraction * pixelWidth * scale
  let arcsec = SCALE_STEPS[0]
  for (const p of SCALE_STEPS) if (p <= max) arcsec = p
  return { arcsec, pixel: arcsec / scale, text: scaleText(arcsec) }
}

/* ---- The scene ---- */

/**
 * Strokes and texts to draw, in destination pixels. Grid labels sit just
 * inside the edge of the visible part: declinations on the left (or right)
 * edge, right ascensions on the top (or bottom) edge. Orientation and scale
 * sit together in the chosen corner; grid labels that would overlap them or
 * a reserved area (the caption), or that are too close to each other, are
 * dropped.
 */
export function coordinatesScene(wcs: Wcs, view: CoordinateView, choice: CoordinatesChoice): CoordinateMark[] {
  if (wcs.naxis1 <= 0 || wcs.naxis2 <= 0 || noCoordinates(choice)) return []
  const { ox, oy, width, height, region, body, angle } = view
  const out = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: ox + p.x * width,
    y: oy + p.y * height
  })
  const norm = (x: number, y: number): { x: number; y: number } => ({ x: (x - ox) / width, y: (y - oy) / height })
  // The visible part, in destination pixels.
  const edge = {
    x0: ox + region.x0 * width,
    y0: oy + region.y0 * height,
    x1: ox + region.x1 * width,
    y1: oy + region.y1 * height
  }
  if (edge.x1 - edge.x0 < body * 4 || edge.y1 - edge.y0 < body * 4) return []

  const marks: CoordinateMark[] = []
  const right = angle.endsWith('right')
  const bottom = angle.startsWith('bottom')
  const margin = body * 1.1

  // ---- Orientation and scale, in the corner: first, to know where they are.
  // Reserved areas count the same, with some padding; when close to an
  // edge they extend to the edge, so no label slips between the caption and
  // the edge.
  const neighbor = body * 3
  const footprints: { x0: number; y0: number; x1: number; y1: number }[] = (view.reserved ?? []).map((z) => ({
    x0: z.x0 - neighbor < edge.x0 ? edge.x0 : z.x0 - body * 0.5,
    y0: z.y0 - neighbor < edge.y0 ? edge.y0 : z.y0 - body * 0.5,
    x1: z.x1 + neighbor > edge.x1 ? edge.x1 : z.x1 + body * 0.5,
    y1: z.y1 + neighbor > edge.y1 ? edge.y1 : z.y1 + body * 0.5
  }))
  const arm = body * 2.6
  let xInner = right ? edge.x1 - margin : edge.x0 + margin
  const yRow = bottom ? edge.y1 - margin - arm - body * 0.4 : edge.y0 + margin + arm + body * 0.4
  if (choice.orientation) {
    const cx = right ? xInner - arm - body * 0.6 : xInner + arm + body * 0.6
    const cy = yRow
    const n = norm(cx, cy)
    const dir = northEastDirections(wcs, n.x, n.y)
    if (dir !== null) {
      const pointTo = body * 0.45
      for (const [v, name] of [
        [dir.north, 'N'],
        [dir.east, 'E']
      ] as const) {
        const fx = cx + v.x * arm
        const fy = cy + v.y * arm
        marks.push({ type: 'segment', points: [{ x: cx, y: cy }, { x: fx, y: fy }], faint: false })
        // Arrowhead: two barbs at 30° from the opposite direction.
        const a = Math.atan2(v.y, v.x)
        for (const s of [-1, 1]) {
          const b = a + Math.PI + s * (Math.PI / 6)
          marks.push({
            type: 'segment',
            points: [{ x: fx, y: fy }, { x: fx + Math.cos(b) * pointTo, y: fy + Math.sin(b) * pointTo }],
            faint: false
          })
        }
        marks.push({
          type: 'text',
          x: cx + v.x * (arm + body * 0.75),
          y: cy + v.y * (arm + body * 0.75),
          text: name,
          align: 'middle',
          base: 'middle',
          faint: false
        })
      }
      const radius = arm + body * 1.3
      footprints.push({ x0: cx - radius, y0: cy - radius, x1: cx + radius, y1: cy + radius })
      xInner = right ? cx - radius - body * 0.6 : cx + radius + body * 0.6
    }
  }
  if (choice.scale) {
    // Visible width, in image pixels.
    const visiblePixel = (region.x1 - region.x0) * wcs.naxis1
    const bar = scaleBar(wcs, visiblePixel)
    if (bar !== null) {
      const long = bar.pixel * (width / wcs.naxis1)
      const xa = right ? xInner - long : xInner
      const xb = right ? xInner : xInner + long
      const y = yRow + body * 0.5
      const tick = body * 0.35
      marks.push({ type: 'segment', points: [{ x: xa, y }, { x: xb, y }], faint: false })
      marks.push({ type: 'segment', points: [{ x: xa, y: y - tick }, { x: xa, y: y + tick }], faint: false })
      marks.push({ type: 'segment', points: [{ x: xb, y: y - tick }, { x: xb, y: y + tick }], faint: false })
      marks.push({ type: 'text', x: (xa + xb) / 2, y: y - body * 0.5, text: bar.text, align: 'middle', base: 'bottom', faint: false })
      footprints.push({ x0: xa - body, y0: y - body * 1.8, x1: xb + body, y1: y + body })
    }
  }

  // ---- Grid.
  if (choice.grid) {
    const lines = coordinateGrid(wcs, region)
    const labels: CoordinateMark[] = []
    const busy: { side: string; pos: number }[] = []
    // Estimated footprint of a grid label (font size × 0.9, about 0.6 font
    // sizes per character), from its anchor and alignment.
    const free = (s: CoordinateMark): boolean => {
      if (s.type !== 'text') return true
      const wide = s.text.length * body * 0.9 * 0.6
      const top = body * 0.9
      const x0 = s.align === 'start' ? s.x : s.align === 'end' ? s.x - wide : s.x - wide / 2
      const y0 = s.base === 'top' ? s.y : s.base === 'bottom' ? s.y - top : s.y - top / 2
      return !footprints.some((g) => x0 < g.x1 && x0 + wide > g.x0 && y0 < g.y1 && y0 + top > g.y0)
    }
    for (const line of lines) {
      for (const t of line.segments) marks.push({ type: 'segment', points: t.map(out), faint: true })
      // The first crossed edge where the label fits: if it is covered on the
      // preferred side (by the caption, orientation and scale, or another
      // label), the opposite side is tried.
      const crossings = findCrossings(
        line.segments.map((t) => t.map(out)),
        edge,
        line.type === 'dec' ? ['left', 'right'] : ['top', 'bottom']
      )
      const offset = body * 0.4
      for (const crossing of crossings) {
        const vertical = crossing.side === 'left' || crossing.side === 'right'
        let s: CoordinateMark
        if (vertical) {
          const x = crossing.side === 'left' ? edge.x0 + offset : edge.x1 - offset
          s = { type: 'text', x, y: crossing.y, text: line.text, align: crossing.side === 'left' ? 'start' : 'end', base: 'middle', faint: true }
        } else {
          const y = crossing.side === 'top' ? edge.y0 + offset : edge.y1 - offset
          s = { type: 'text', x: crossing.x, y, text: line.text, align: 'middle', base: crossing.side === 'top' ? 'top' : 'bottom', faint: true }
        }
        const pos = vertical ? crossing.y : crossing.x
        // Along horizontal edges the label is wide: more spacing is needed.
        const distance = vertical ? body * 1.6 : body * line.text.length * 0.62
        const farFromEdges = vertical
          ? pos > edge.y0 + body * 1.4 && pos < edge.y1 - body * 1.4
          : pos > edge.x0 + distance / 2 + body && pos < edge.x1 - distance / 2 - body
        if (!farFromEdges || !free(s)) continue
        if (busy.some((o) => o.side === crossing.side && Math.abs(o.pos - pos) < distance)) continue
        busy.push({ side: crossing.side, pos })
        labels.push(s)
        break
      }
    }
    // Labels above the lines.
    marks.push(...labels)
  }

  // Orientation and scale on top of everything: faint lines first.
  return [...marks.filter((s) => s.faint), ...marks.filter((s) => !s.faint)]
}

type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * For each of the given sides (in order of preference), the first point
 * where one of the polylines crosses it, within the side. Sides that are
 * not crossed are omitted.
 */
function findCrossings(
  segments: { x: number; y: number }[][],
  r: { x0: number; y0: number; x1: number; y1: number },
  sides: Side[]
): { side: Side; x: number; y: number }[] {
  const crossings: { side: Side; x: number; y: number }[] = []
  for (const side of sides) {
    search: for (const t of segments) {
      for (let i = 1; i < t.length; i++) {
        const a = t[i - 1]
        const b = t[i]
        if (side === 'left' || side === 'right') {
          const x = side === 'left' ? r.x0 : r.x1
          if ((a.x - x) * (b.x - x) > 0 || a.x === b.x) continue
          const y = a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y)
          if (y >= r.y0 && y <= r.y1) {
            crossings.push({ side, x, y })
            break search
          }
        } else {
          const y = side === 'top' ? r.y0 : r.y1
          if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) continue
          const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x)
          if (x >= r.x0 && x <= r.x1) {
            crossings.push({ side, x, y })
            break search
          }
        }
      }
    }
  }
  return crossings
}
