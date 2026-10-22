import type { ImageData32, ObjectType, RecognizedObject, Wcs } from '@shared/types'
import { objectEllipsePixels } from '@core/catalog/crowding'
import { scaleArcsec } from '@core/astrometry/wcs'
import { MAD_TO_SIGMA } from './stats'
import { blurInPlace } from './cleanup'
import { takeShared, returnShared } from './parallel'
import { kth, medianAndMad } from './selection'

/**
 * Airplane and satellite trails on a single frame.
 *
 * A trail is the path of an object crossing the field during the exposure:
 * a thin straight line, as wide as a star. It often crosses the whole frame,
 * but not always: a satellite entering Earth's shadow fades out mid-field, an
 * exposure may start or end while the object is already inside, an airplane
 * leaves a row of dashes (its flashing lights) and sometimes two or three
 * parallel lines (the wing lights). On stacked files tail rejection already
 * removes it; on a single frame it remains, and has to be found and rebuilt.
 *
 * Detection proceeds in three steps.
 *
 * 1. Wide search (Hough transform). The fine part of the image (the
 *    brightness minus a blurred version of it) is kept, which removes the
 *    sky background and extended nebulae; its positive part is kept up to one
 *    noise unit, so a star weighs as much as a few sky pixels; the image is
 *    reduced by blocks and summed along all possible lines. Summing along a
 *    line thousands of pixels long brings out even a trail fainter than the
 *    single-pixel noise. Each sum is compared with nearby parallel lines (a
 *    nebula or a cluster raise those too, a trail does not) and with the
 *    spread measured at the same inclination: the threshold is statistical,
 *    not a fixed value.
 *
 * 2. Straightening and full-resolution measurement. Each candidate line is
 *    divided into segments; in each one the transverse profile is measured
 *    (a high quantile of the distribution along the segment: it ignores
 *    stars but sees the dashes of an airplane) and the trail's peak is
 *    sought, higher than both sides. The line is straightened onto the peaks
 *    found. It is then walked in short steps to find the stretch where the
 *    trail really is: where it starts and where it ends.
 *
 * 3. The judgment. Edge-on galaxies, nebula filaments and cirrus are also
 *    long thin streaks; a trail, however, has characteristics that those do
 *    not all have together, and it is required to have them:
 *    - constant width, close to that of the stars, along the whole track (a
 *      trail is a star that moves: its transverse profile is that of a
 *      star); a galaxy is wider and tapers toward the tips;
 *    - length many times the width (at least 60 times that of a star, and
 *      at least 200 pixels);
 *    - almost perfect straightness: the measured centers lie on the line to
 *      within a pixel, while a filament bends;
 *    - brightness along the track that is constant or changes only once
 *      (the step of the shadow, the flash of a satellite), while a filament
 *      switches on and off several times; and not spindle-shaped (brightest
 *      at the center and fading at the tips, like a galaxy) if the track is
 *      also wider than a star;
 *    - if the position of the catalog objects is known (astrometric
 *      solution), a partial track lying inside an elongated galaxy or nebula
 *      and following its axis is the object, not a trail.
 *    A trail crossing the whole frame is accepted under looser conditions
 *    (seen almost everywhere along the line), plus star-like width: no sky
 *    object is a thin straight line from one edge to the other.
 *
 *    A short trail stands out little in the sum along a line crossing the
 *    whole image: the wide search is therefore repeated on windows of about
 *    450 pixels, with the cut at three deviations, which gives more weight
 *    to a bright or dashed trail.
 *
 * The reconstruction replaces the trail's pixels, only along the stretch
 * where the trail is and at the width measured step by step, with the local
 * background taken from the two sides and blended linearly, plus grain
 * copied from sky pixels just outside the trail: without grain a smooth
 * stripe would remain, clearly visible after stretching. It works channel by
 * channel, so the colored flashes of satellites disappear too.
 */

export interface TrailsParams {
  /** Detection and reconstruction of trails. */
  active: boolean
  /**
   * From 0 to 1: how faint a trail can be and still be picked up. Higher
   * values find fainter trails but risk mistaking a structure of the subject
   * for a trail; 0.5 is the balanced choice.
   */
  sensitivity: number
}

export const NEUTRAL_TRAILS: TrailsParams = { active: false, sensitivity: 0.5 }

/**
 * Area occupied by a catalog object (galaxy, nebula), in image pixels: an
 * ellipse. A partial track lying inside it and following its major axis is
 * not taken for a trail.
 */
export interface ProtectedZone {
  cx: number
  cy: number
  semiMajor: number
  semiMinor: number
  /**
   * Direction of the major axis in radians, from the x axis toward the y
   * axis (like the ellipse angle from catalog/crowding.ts), or null if
   * unknown: the zone is then a circle and applies to every direction.
   */
  angle: number | null
}

/** Catalog objects that can look like a trail: extended, sometimes thin and straight. */
const PROTECTED_TYPES = new Set<ObjectType>([
  'galaxy',
  'nebula',
  'planetary-nebula',
  'supernova-remnant',
  'dark-nebula'
])

/**
 * Protected zones of the recognized objects that have a position in the
 * frame (that is, with the astrometric solution): the ellipse of each one in
 * pixels, with the orientation from the catalog (see `objectEllipsePixels`).
 * Object positions are normalized over the image of `width` x `height`
 * pixels.
 */
export function buildProtectedZones(
  objects: RecognizedObject[],
  pixelScale: number | null,
  wcs: Wcs | null,
  width: number,
  height: number
): ProtectedZone[] {
  const zones: ProtectedZone[] = []
  // Without the header's scale, that of the solution is used.
  const scale = pixelScale ?? (wcs !== null ? scaleArcsec(wcs) : null)
  for (const o of objects) {
    if (o.position === null || !PROTECTED_TYPES.has(o.object.type)) continue
    const e = objectEllipsePixels(o.object, scale, wcs)
    if (e === null) continue
    zones.push({
      cx: o.position.x * width,
      cy: o.position.y * height,
      semiMajor: e.semiMajor,
      semiMinor: e.semiMinor,
      // A circle has no orientation: it applies to every direction.
      angle: e.semiMinor < e.semiMajor ? e.angle : null
    })
  }
  return zones
}

/** A trail found, in the image's pixel coordinates. */
export interface Trail {
  /** Endpoints of the stretch where the trail is (on the edges if it crosses everything). */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Inclination from the horizontal, in degrees from 0 to 180. */
  angle: number
  /** Maximum replaced width, in pixels. */
  width: number
  /** Full width at half maximum of the trail's profile, in pixels. */
  fwhm: number
  /** Half-width replaced at each step, from endpoint 1 to endpoint 2. */
  halfWidths: number[]
  /** Fraction of the stretch's steps in which the trail was seen, from 0 to 1. */
  coverage: number
  /** True if the trail crosses the whole frame, from one edge to the other. */
  whole: boolean
  /** Nearby parallel lines treated together (the wing lights of an airplane). */
  lines: number
  /** How much the trail stands out from the noise in the wide search, in deviations. */
  strength: number
}

export interface TrailsResult {
  image: ImageData32
  trails: Trail[]
}

/** Maximum side of the reduced image on which the wide search is done. */
const REDUCED_SIDE = 480
/** Radius of the blur that separates the fine part. */
const FINE_RADIUS = 8
/** Segments into which a line is divided to straighten it. */
const SEGMENTS = 24
/** Length of the short steps used to look for the trail's endpoints. */
const STEP = 32
/** Maximum distance from the trail's center at which the profile is examined. */
const PROFILE = 40
/** Maximum half-width accepted for replacement. */
const MAX_HALF_WIDTH = 26
/** Candidates of the wide search verified at most. */
const MAX_CANDIDATES = 24
/**
 * Position in the distribution of a segment's values used for the profile.
 * The median (0.5) ignores stars but also the dashes of an airplane that
 * cover less than half the segment; a little higher the dashes are seen,
 * and a star, which occupies few pixels of the segment, still stays out.
 */
const QUANTILE = 0.65
/** Minimum length of a partial trail, in star widths. */
const LENGTH_IN_FWHM = 60
/** Absolute minimum length of a partial trail, in pixels. */
const MIN_LENGTH = 200

/**
 * Sensitivity chosen by measuring the image (for Abracadabra).
 *
 * The detection thresholds are already relative to the measured noise; here
 * account is taken of how much fine structure there is beyond the noise
 * (dense stars, nebula filaments): in a very rich field it is better to be a
 * little more cautious, in a sparse field it is possible to search deeper.
 */
export function automaticTrails(img: ImageData32): TrailsParams {
  const part = endPart(img)
  const { end, sigma } = part
  if (sigma <= 0) {
    releaseEndPart(part, img)
    return { active: true, sensitivity: 0.5 }
  }
  // In Gaussian noise one pixel in 30,000 lies beyond 4 deviations:
  // whatever exceeds that is structure of the subject.
  let beyond = 0
  const step = 3
  let count = 0
  for (let i = 0; i < end.length; i += step) {
    count++
    if (end[i] > 4 * sigma) beyond++
  }
  releaseEndPart(part, img)
  const richness = beyond / Math.max(1, count)
  // Up to 0.8: at 0.6 at most, a faint satellite trail crossing the
  // Rosette (62 frames, the trail diluted by the stack) was left in place.
  const sensitivity = Math.max(0.35, Math.min(0.8, 0.8 - richness * 4))
  return { active: true, sensitivity: Math.round(sensitivity * 100) / 100 }
}

/** Finds the trails, whole or partial. */
export function detectTrails(img: ImageData32, sensitivity = 0.5, protectedZones: ProtectedZone[] = []): Trail[] {
  return detect(img, sensitivity, protectedZones).map((r) => r.trail)
}

/**
 * Finds and reconstructs the trails. The input image is not modified, unless
 * `inPlace` is true: the processing chain uses it on images that belong to it
 * alone, saving a full copy (the result is the same).
 * `protectedZones` are the zones of the catalog objects, if their position
 * is known (see `ProtectedZone`).
 */
export function removeTrails(
  img: ImageData32,
  p: TrailsParams,
  protectedZones: ProtectedZone[] = [],
  inPlace = false
): TrailsResult {
  if (!p.active) return { image: img, trails: [] }
  const foundAll = detect(img, p.sensitivity, protectedZones)
  if (foundAll.length === 0) return { image: img, trails: [] }
  const w = img.width
  const h = img.height
  const n = w * h
  const data = inPlace ? img.data : img.data.slice()
  // Pixels already rebuilt, cleared for each trail (one array for all).
  const visited = new Uint8Array(n)
  for (let c = 0; c < img.channels; c++) {
    const plane = data.subarray(c * n, (c + 1) * n)
    const sigma = planeNoise(plane, w, h)
    for (const r of foundAll) rebuild(plane, w, h, r.line, sigma, visited)
  }
  return { image: { ...img, data }, trails: foundAll.map((r) => r.trail) }
}

// ---------------------------------------------------------------------------
// Geometry

/**
 * A line with a point, the (unit) direction and the limits inside the image
 * (t1, t2). The trail occupies the stretch from `start` to `end`: for a
 * whole trail they go beyond the edges, for a partial one they are its
 * endpoints.
 */
interface Line {
  px: number
  py: number
  dx: number
  dy: number
  t1: number
  t2: number
  start: number
  end: number
  /** Half-width at each step, from t1 to t2 in equal steps. */
  seeds: number[]
}

/**
 * Range of the parameter t for which the point (px + t dx, py + t dy) lies
 * in the rectangle [x0, x1] x [y0, y1], or null if the line misses it.
 */
function cropRegion(
  px: number,
  py: number,
  dx: number,
  dy: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number
): [number, number] | null {
  let a = -Infinity
  let b = Infinity
  const sides: [number, number, number, number][] = [
    [px, dx, x0, x1],
    [py, dy, y0, y1]
  ]
  for (const [p, d, lo, hi] of sides) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return null
      continue
    }
    let u = (lo - p) / d
    let v = (hi - p) / d
    if (u > v) [u, v] = [v, u]
    a = Math.max(a, u)
    b = Math.min(b, v)
  }
  return b > a ? [a, b] : null
}

/**
 * Length of the piece of line inside the rectangle (like `cropRegion`,
 * without creating anything: in the wide search it is called millions of
 * times).
 */
function lengthInside(
  px: number,
  py: number,
  dx: number,
  dy: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number
): number {
  let a = -Infinity
  let b = Infinity
  if (Math.abs(dx) < 1e-12) {
    if (px < x0 || px > x1) return 0
  } else {
    const u = (x0 - px) / dx
    const v = (x1 - px) / dx
    a = Math.max(a, Math.min(u, v))
    b = Math.min(b, Math.max(u, v))
  }
  if (Math.abs(dy) < 1e-12) {
    if (py < y0 || py > y1) return 0
  } else {
    const u = (y0 - py) / dy
    const v = (y1 - py) / dy
    a = Math.max(a, Math.min(u, v))
    b = Math.min(b, Math.max(u, v))
  }
  return b > a ? b - a : 0
}

function newLine(px: number, py: number, dx: number, dy: number, w: number, h: number): Line | null {
  const lim = cropRegion(px, py, dx, dy, 0, w - 1, 0, h - 1)
  if (!lim) return null
  return {
    px,
    py,
    dx,
    dy,
    t1: lim[0],
    t2: lim[1],
    start: -Infinity,
    end: Infinity,
    seeds: []
  }
}

// ---------------------------------------------------------------------------
// Detection

interface Found {
  trail: Trail
  line: Line
}

/**
 * Luminance (the plane itself, with one channel). With three channels it is
 * a temporary plane from the pool of parallel.ts (see `releaseEndPart`).
 */
function luminance(img: ImageData32): Float32Array {
  const n = img.width * img.height
  if (img.channels === 1) return img.data.subarray(0, n)
  const y = takeShared(n)
  const d = img.data
  for (let i = 0; i < n; i++) y[i] = (d[i] + d[n + i] + d[2 * n + i]) / 3
  return y
}

/** Luminance, its fine part and the noise of the fine part. */
function endPart(img: ImageData32): {
  lum: Float32Array
  end: Float32Array
  sigma: number
} {
  const w = img.width
  const h = img.height
  const lum = luminance(img)
  // The smoothed luminance is computed into the array of the fine part,
  // which then replaces it value by value.
  const end = takeShared(lum.length)
  end.set(lum)
  blurInPlace(end, w, h, FINE_RADIUS)
  for (let i = 0; i < end.length; i++) end[i] = lum[i] - end[i]
  const sigma = medianAndMad(end).mad * MAD_TO_SIGMA
  return { lum, end, sigma }
}

/** Gives back to the pool the temporary planes of `endPart`. */
function releaseEndPart(part: { lum: Float32Array; end: Float32Array }, img: ImageData32): void {
  if (img.channels !== 1) returnShared(part.lum)
  returnShared(part.end)
}

/** Everything needed to verify a candidate line. */
interface Context {
  lum: Float32Array
  end: Float32Array
  w: number
  h: number
  /** Sensitivity, from 0 to 1. */
  s: number
  /** Full width at half maximum of the stars, in pixels. */
  fwhm: number
  /** Value beyond which a pixel is near saturation. */
  saturation: number
  protectedZones: ProtectedZone[]
}

function detect(img: ImageData32, sensitivity: number, protectedZones: ProtectedZone[]): Found[] {
  const w = img.width
  const h = img.height
  if (w < 64 || h < 64) return []
  const s = Math.max(0, Math.min(1, sensitivity))
  const part = endPart(img)
  try {
    return detectIn(part, w, h, s, protectedZones)
  } finally {
    releaseEndPart(part, img)
  }
}

/** The work of `detect`, on the luminance and its fine part. */
function detectIn(
  part: { lum: Float32Array; end: Float32Array; sigma: number },
  w: number,
  h: number,
  s: number,
  protectedZones: ProtectedZone[]
): Found[] {
  const { lum, end, sigma } = part
  if (!(sigma > 0)) return []
  let max = 0
  for (let i = 0; i < lum.length; i++) if (lum[i] > max) max = lum[i]
  const ctx: Context = {
    lum,
    end,
    w,
    h,
    s,
    fwhm: starFwhm(lum, end, sigma, w, h, max),
    saturation: 0.9 * max,
    protectedZones
  }

  const candidates = wideSearch(end, w, h, sigma, 9 - 5 * s)
  const foundAll: Found[] = []
  for (const c of candidates) {
    // A candidate near an already accepted trail is the same trail seen
    // from another cell of the wide search.
    const rawValue = lineFrom(c.theta, c.rho, w, h)
    if (!rawValue || foundAll.some((t) => alreadyTaken(t.line, rawValue, 12) || lobe(t.line, rawValue))) continue
    const v = check(ctx, rawValue)
    if (!v || foundAll.some((t) => alreadyTaken(t.line, v.line, 3))) continue
    foundAll.push({ line: v.line, trail: describe(v.line, v, c.z) })
  }
  return foundAll
}

/**
 * True if line `b` is almost parallel to `a`, its midpoint lies within the
 * replaced band of `a` (plus `margin` pixels) and the two stretches overlap:
 * it is the same trail, or a line that `a` already covers.
 */
function alreadyTaken(a: Line, b: Line, margin: number): boolean {
  const sine = Math.abs(a.dx * b.dy - a.dy * b.dx)
  if (sine > Math.sin((1.5 * Math.PI) / 180)) return false
  const bi = Math.max(b.t1, b.start)
  const bf = Math.min(b.t2, b.end)
  const tm = (bi + bf) / 2
  const qx = b.px + tm * b.dx - a.px
  const qy = b.py + tm * b.dy - a.py
  const seeds = a.seeds.length > 0 ? Math.max(...a.seeds) : 0
  if (Math.abs(qx * a.dy - qy * a.dx) >= Math.max(margin, seeds + 3)) return false
  // Overlap of the stretches, measured along a.
  const project = (t: number): number => (b.px + t * b.dx - a.px) * a.dx + (b.py + t * b.dy - a.py) * a.dy
  const p1 = project(bi)
  const p2 = project(bf)
  const ai = Math.max(a.t1, a.start)
  const af = Math.min(a.t2, a.end)
  return Math.min(af, Math.max(p1, p2)) - Math.max(ai, Math.min(p1, p2)) > -STEP
}

/**
 * True if line `b`, slightly inclined with respect to trail `a`, crosses it
 * within the stretch where the trail is: it is a lobe of the wide search
 * around the trail already taken, not another trail.
 */
function lobe(a: Line, b: Line): boolean {
  const sine = a.dx * b.dy - a.dy * b.dx
  if (Math.abs(sine) > Math.sin(LOBE) || Math.abs(sine) < 1e-9) return false
  // Crossing point, as position t along a.
  const qx = b.px - a.px
  const qy = b.py - a.py
  const t = (qx * b.dy - qy * b.dx) / sine
  return t >= Math.max(a.t1, a.start) && t <= Math.min(a.t2, a.end)
}

/**
 * Typical full width at half maximum of the stars, measured on stars well
 * above the noise and far from saturation. The profile of a trail is that of
 * a star that moves: it is the width reference.
 */
function starFwhm(
  lum: Float32Array,
  end: Float32Array,
  sigma: number,
  w: number,
  h: number,
  max: number
): number {
  const threshold = 20 * sigma
  const peaks: { i: number; v: number }[] = []
  const edge = 12
  for (let y = edge; y < h - edge; y++) {
    for (let x = edge; x < w - edge; x++) {
      const i = y * w + x
      const v = end[i]
      if (v < threshold || lum[i] > 0.7 * max) continue
      if (
        v < end[i - 1] ||
        v < end[i + 1] ||
        v < end[i - w] ||
        v < end[i + w] ||
        v < end[i - w - 1] ||
        v < end[i - w + 1] ||
        v < end[i + w - 1] ||
        v <= end[i + w + 1]
      ) {
        continue
      }
      peaks.push({ i, v })
      if (peaks.length > 20000) break
    }
    if (peaks.length > 20000) break
  }
  if (peaks.length < 5) return 3
  // The brightest, up to 300, leaving out the highest tenth (near
  // saturation or double).
  peaks.sort((a, b) => b.v - a.v)
  const choices = peaks.slice(Math.floor(peaks.length * 0.1), Math.floor(peaks.length * 0.1) + 300)
  const measurements: number[] = []
  const ring = new Float32Array(16)
  for (const { i } of choices) {
    const x = i % w
    const y = (i - x) / w
    // Background: median of a ring at 9 pixels.
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI
      ring[k] = lum[Math.round(y + 9 * Math.sin(a)) * w + Math.round(x + 9 * Math.cos(a))]
    }
    const background = kth(ring, 8)
    const half = (lum[i] - background) / 2
    if (!(half > 0)) continue
    // Width in four directions (horizontal, vertical, diagonals): only round
    // stars are kept, so a piece of trail or a double star does not enter
    // the measurement.
    const widths: number[] = []
    for (const [px, py, scale] of [
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2]
    ]) {
      let wide = 0
      for (const direction of [-1, 1]) {
        let d = 1
        let before = lum[i] - background
        for (; d < 8; d++) {
          const v = lum[i + direction * d * (px + py * w)] - background
          if (v < half) {
            wide += d - 1 + (before - half) / Math.max(1e-12, before - v)
            break
          }
          before = v
        }
        if (d >= 8) wide = NaN
      }
      widths.push(wide * scale)
    }
    if (!widths.every((v) => Number.isFinite(v))) continue
    if (Math.max(...widths) > 1.4 * Math.min(...widths)) continue
    measurements.push(widths.reduce((a, b) => a + b, 0) / 4)
  }
  if (measurements.length < 5) return 3
  measurements.sort((a, b) => a - b)
  return Math.max(1.2, measurements[measurements.length >> 1])
}

interface Candidate {
  theta: number
  rho: number
  z: number
}

/**
 * Reduced grid of the fine part, in noise units, with each value clipped at
 * `cuts` deviations.
 */
function reducedGrid(
  end: Float32Array,
  w: number,
  h: number,
  sigma: number,
  cuts: number,
  b: number,
  bw: number,
  bh: number
): Float32Array {
  const cut = cuts * sigma
  // Block reduction of the fine part, in noise units. Only the positive part
  // is kept, clipped at `cuts` deviations (one in the search over the whole
  // image): a star thus weighs as much as a few sky pixels (dense stars,
  // summed along lines, are the main disturbance), while a trail, even a
  // bright one, adds a full contribution over thousands of pixels. With the
  // clip at three deviations the faintest trail found would be almost twice
  // as bright. The negative part must be discarded because the fine part,
  // being the image minus a blurred version of it, sums to zero across the
  // trail: on the sides of the peak two troughs remain that, summed, would
  // cancel it. The mean level added by positive noise is the same for all
  // lines and is removed afterwards, by comparing parallel lines.
  const reduced = new Float32Array(bw * bh)
  const count = new Float32Array(bw * bh)
  const zeros = new Float32Array(bw * bh)
  const column = new Int32Array(w)
  for (let x = 0; x < w; x++) column[x] = (x / b) | 0
  const inverse = 1 / sigma
  for (let y = 0; y < h; y++) {
    const ry = ((y / b) | 0) * bw
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = end[row + x]
      const k = ry + column[x]
      if (v === 0) zeros[k]++
      if (v < 0) v = 0
      else if (v > cut) v = cut
      reduced[k] += v * inverse
      count[k]++
    }
  }
  for (let k = 0; k < reduced.length; k++) reduced[k] = reduced[k] / Math.max(1, count[k])
  // The level left by positive noise grows where noise is stronger (edges
  // poorly covered by stacking, the bright core of a galaxy): the median of
  // the surrounding blocks, which a trail one block wide does not shift, is
  // subtracted from each block. Only thin structures remain. Blocks on the
  // perimeter, which feel the edge of the blur, and those without data (the
  // black corners left by field rotation) are zeroed: false lines would
  // arise at their margins.
  const LEVEL_RADIUS = 2
  const around = new Float32Array((2 * LEVEL_RADIUS + 1) ** 2)
  const leveled = new Float32Array(bw * bh)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const k = y * bw + x
      if (x < 2 || y < 2 || x >= bw - 2 || y >= bh - 2 || zeros[k] > count[k] / 2) continue
      let m = 0
      for (let yy = Math.max(0, y - LEVEL_RADIUS); yy <= Math.min(bh - 1, y + LEVEL_RADIUS); yy++) {
        for (let xx = Math.max(0, x - LEVEL_RADIUS); xx <= Math.min(bw - 1, x + LEVEL_RADIUS); xx++) {
          around[m++] = reduced[yy * bw + xx]
        }
      }
      leveled[k] = reduced[k] - kth(around, m >> 1, m)
    }
  }
  reduced.set(leveled)
  return reduced
}

/**
 * Hough transform on the reduced image. Each line is described by the angle
 * θ of its normal and the distance ρ from the image center, in pixels of the
 * full image.
 */
function wideSearch(end: Float32Array, w: number, h: number, sigma: number, threshold: number): Candidate[] {
  const b = Math.max(1, Math.ceil(Math.max(w, h) / REDUCED_SIDE))
  const bw = Math.ceil(w / b)
  const bh = Math.ceil(h / b)

  const reduced = reducedGrid(end, w, h, sigma, 1, b, bw, bh)

  // Search over the whole image, then over windows overlapping by half: a
  // short trail, which occupies a small part of a line as long as the frame,
  // stands out much better when summed over a short line. On the reduced
  // grid the windows cost little.
  const candidates = hough(reduced, bw, 0, 0, bw, bh, b, w, h, threshold, MAX_CANDIDATES, false)
  // The windows work on a grid clipped at three deviations instead of one:
  // a short trail must be bright to emerge from the noise, and with the
  // higher clip it weighs more (even if dashed).
  const side = Math.min(bw, bh, 56)
  if (side < Math.min(bw, bh)) {
    const high = reducedGrid(end, w, h, sigma, 3, b, bw, bh)
    const halfSize = side >> 1
    for (let gy = 0; gy + halfSize < bh; gy += halfSize) {
      for (let gx = 0; gx + halfSize < bw; gx += halfSize) {
        const x0 = Math.min(gx, bw - side)
        const y0 = Math.min(gy, bh - side)
        candidates.push(...hough(high, bw, x0, y0, side, side, b, w, h, threshold + 1.5, 3, true))
      }
    }
  }
  // From the strongest; the same line found by several windows (or nearby
  // cells) is kept only once.
  candidates.sort((p, q) => q.z - p.z)
  const kept: Candidate[] = []
  const angleTolerance = (1.5 * Math.PI) / 180
  for (const c of candidates) {
    const isDuplicate = kept.some((t) => {
      let dt = Math.abs(c.theta - t.theta)
      let rho = c.rho
      // θ and θ ± π are the same line with opposite ρ.
      if (dt > Math.PI / 2) {
        dt = Math.PI - dt
        rho = -rho
      }
      if (dt < angleTolerance) return Math.abs(rho - t.rho) < 3 * b
      // Slightly inclined lines that cross a stronger line inside the image
      // are its lobes: the sum along them collects a piece of the real
      // trail.
      return dt < LOBE && crossingInside(c.theta, c.rho, t.theta, t.rho, w, h)
    })
    if (!isDuplicate) kept.push(c)
    if (kept.length >= MAX_CANDIDATES) break
  }
  return kept
}

/** Maximum inclination, relative to a strong line, of one of its lobes in the wide search. */
const LOBE = (6 * Math.PI) / 180

/** True if the two lines (normal angle, distance from the center) cross inside the image. */
function crossingInside(t1: number, r1: number, t2: number, r2: number, w: number, h: number): boolean {
  const a1 = Math.cos(t1)
  const b1 = Math.sin(t1)
  const a2 = Math.cos(t2)
  const b2 = Math.sin(t2)
  const det = a1 * b2 - a2 * b1
  if (Math.abs(det) < 1e-9) return false
  const x = (r1 * b2 - r2 * b1) / det
  const y = (a1 * r2 - a2 * r1) / det
  return Math.abs(x) <= w / 2 && Math.abs(y) <= h / 2
}

/**
 * Hough transform on a window of the reduced grid (gx0, gy0, gw blocks wide
 * and gh blocks high). Returns the `count` strongest maxima, described as
 * lines of the whole image.
 */
function hough(
  reduced: Float32Array,
  bw: number,
  gx0: number,
  gy0: number,
  gw: number,
  gh: number,
  b: number,
  wImage: number,
  hImage: number,
  threshold: number,
  count: number,
  /** Simpler and faster normalization, for the windows. */
  fast: boolean
): Candidate[] {
  // Window in image pixels.
  const X0 = gx0 * b
  const Y0 = gy0 * b
  const w = Math.min(wImage, (gx0 + gw) * b) - X0
  const h = Math.min(hImage, (gy0 + gh) * b) - Y0
  const bwF = gw
  const bhF = gh
  const diagonal = Math.hypot(w, h)
  // Angular step such that along the whole diagonal the line does not
  // move by more than one cell.
  const angles = Math.min(1600, Math.ceil((Math.PI * diagonal) / (2 * b)))
  const rhoCells = Math.ceil(diagonal / b) + 4
  const meta = rhoCells >> 1
  const cosines = new Float32Array(angles)
  const sines = new Float32Array(angles)
  for (let a = 0; a < angles; a++) {
    const t = (a / angles) * Math.PI
    cosines[a] = Math.cos(t) / b
    sines[a] = Math.sin(t) / b
  }
  const acc = new Float32Array(angles * rhoCells)
  for (let y = 0; y < bhF; y++) {
    const yc = Math.min(Y0 + h, (gy0 + y + 0.5) * b) - Y0 - h / 2
    for (let x = 0; x < bwF; x++) {
      const v = reduced[(gy0 + y) * bw + gx0 + x]
      // Zeroed blocks add nothing: they are skipped.
      if (v === 0) continue
      const xc = Math.min(X0 + w, (gx0 + x + 0.5) * b) - X0 - w / 2
      for (let a = 0, base = 0; a < angles; a++, base += rhoCells) {
        acc[base + ((xc * cosines[a] + yc * sines[a] + meta + 0.5) | 0)] += v
      }
    }
  }

  // For each angle the sums along the lines are read on a grid of half
  // cells: even positions are a single cell (a thin trail falls almost
  // entirely in one), odd ones two contiguous cells (a trail straddling
  // them). Each sum is divided by the square root of the length, so long and
  // short lines have the same noise; then it is compared with the median of
  // the nearby parallel lines and with the spread at that angle.
  const positions = 2 * rhoCells
  const z = new Float32Array(angles * positions)
  const minimum = 0.25 * Math.min(bwF, bhF)
  const values = new Float32Array(positions)
  const validOnes = new Uint8Array(positions)
  const window = new Float32Array(64)
  const rejections = new Float32Array(positions)
  const medians = new Float32Array(positions)
  const sums = new Float64Array(positions + 2)
  const tallies = new Int32Array(positions + 2)
  const RADIUS = 24
  for (let a = 0; a < angles; a++) {
    const t = (a / angles) * Math.PI
    const nx = Math.cos(t)
    const ny = Math.sin(t)
    const base = a * rhoCells
    validOnes.fill(0)
    for (let q = 0; q < positions - 2; q++) {
      const r = q >> 1
      const double = (q & 1) === 1
      const rho = (q / 2 - meta) * b
      const length = lengthInside(rho * nx, rho * ny, -ny, nx, -w / 2, w / 2, -h / 2, h / 2) / b
      if (length < minimum) continue
      validOnes[q] = 1
      values[q] = double
        ? (acc[base + r] + acc[base + r + 1]) / Math.sqrt(2 * length)
        : acc[base + r] / Math.sqrt(length)
    }
    for (let parity = 0; parity < 2; parity++) {
      let m = 0
      if (fast) {
        // Mean instead of median, with running sums: in the windows, which
        // are many, the median would cost too much.
        let sum = 0
        let countValue = 0
        let j = 0
        for (let q = parity; q < positions; q += 2, j++) {
          if (validOnes[q]) {
            sum += values[q]
            countValue++
          }
          sums[j + 1] = sum
          tallies[j + 1] = countValue
        }
        const last = j - 1
        const R = RADIUS >> 1
        j = 0
        for (let q = parity; q < positions; q += 2, j++) {
          if (!validOnes[q]) continue
          const lo = Math.max(0, j - R)
          const hi = Math.min(last, j + R)
          const lo2 = Math.max(0, j - 1)
          const hi2 = Math.min(last, j + 1)
          const k = tallies[hi + 1] - tallies[lo] - (tallies[hi2 + 1] - tallies[lo2])
          if (k < 6) {
            validOnes[q] = 0
            continue
          }
          medians[q] = (sums[hi + 1] - sums[lo] - (sums[hi2 + 1] - sums[lo2])) / k
        }
      } else
        for (let q = parity; q < positions; q += 2) {
          if (!validOnes[q]) continue
          let k = 0
          for (let u = Math.max(parity, q - RADIUS); u <= Math.min(positions - 1, q + RADIUS); u += 2) {
            if (validOnes[u] && Math.abs(u - q) > 2) window[k++] = values[u]
          }
          if (k < 6) {
            validOnes[q] = 0
            continue
          }
          medians[q] = kth(window, k >> 1, k)
        }
      for (let q = parity; q < positions; q += 2) {
        if (!validOnes[q]) continue
        values[q] -= medians[q]
        rejections[m++] = Math.abs(values[q])
      }
      if (m < 10) continue
      const spread = kth(rejections, m >> 1, m) * MAD_TO_SIGMA
      if (!(spread > 0)) continue
      for (let q = parity; q < positions; q += 2) if (validOnes[q]) z[a * positions + q] = values[q] / spread
    }
  }

  // Local maxima above the threshold, strongest first.
  const candidates: Candidate[] = []
  for (let a = 0; a < angles; a++) {
    for (let q = 0; q < positions; q++) {
      const v = z[a * positions + q]
      if (v < threshold) continue
      let max = true
      for (let from = -2; from <= 2 && max; from++) {
        let aa = a + from
        let q0 = q
        // The angle is circular: θ + π is the same line with opposite ρ.
        if (aa < 0 || aa >= angles) {
          aa = aa < 0 ? aa + angles : aa - angles
          q0 = 4 * meta - q
        }
        for (let dq = -4; dq <= 4; dq++) {
          const qq = q0 + dq
          if (qq < 0 || qq >= positions || (from === 0 && dq === 0)) continue
          if (z[aa * positions + qq] > v) {
            max = false
            break
          }
        }
      }
      if (!max) continue
      // Distance from the center of the whole image instead of the window.
      const theta = (a / angles) * Math.PI
      const rho =
        (q / 2 - meta) * b + (X0 + w / 2 - wImage / 2) * Math.cos(theta) + (Y0 + h / 2 - hImage / 2) * Math.sin(theta)
      candidates.push({ theta, rho, z: v })
    }
  }
  candidates.sort((p, q) => q.z - p.z)
  return candidates.slice(0, count)
}

/** Transverse profile of a segment: a high quantile of the distribution along the segment, for each distance. */
interface Profile {
  /** Values from -PROFILE to +PROFILE. */
  p: Float32Array
  /** Noise of a single pixel in the segment. */
  sigma: number
  /** Noise of a profile value (statistic of many pixels). */
  sigmaP: number
  empty: boolean
}

/** Transverse profile of the line's segment between ta and tb. */
function profile(
  ctx: Context,
  r: Line,
  ta: number,
  tb: number,
  column: Float32Array,
  noise: Float32Array
): Profile {
  const { lum, end, w, h } = ctx
  const side = 2 * PROFILE + 1
  const nx = r.dy
  const ny = -r.dx
  const p = new Float32Array(side)
  let nr = 0
  let zeros = 0
  let samples = 0
  for (let k = 0; k < side; k++) {
    const d = k - PROFILE
    let m = 0
    for (let t = ta; t < tb; t += 1) {
      const x = Math.round(r.px + t * r.dx + d * nx)
      const y = Math.round(r.py + t * r.dy + d * ny)
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const i = y * w + x
      column[m++] = lum[i]
      samples++
      if (lum[i] === 0) zeros++
      // Segment noise from the far sides, on the fine part.
      if (Math.abs(d) >= 30 && (k & 3) === 0 && nr < noise.length) noise[nr++] = Math.abs(end[i])
    }
    p[k] = m > 0 ? kth(column, Math.min(m - 1, Math.floor(m * QUANTILE)), m) : NaN
  }
  const sigma = nr > 10 ? kth(noise, nr >> 1, nr) * MAD_TO_SIGMA : 0
  const long = Math.max(1, tb - ta)
  // Profile noise. In theory it is that of an order statistic of `length`
  // pixels, but neighboring pixels of a demosaiced, stacked image are not
  // independent and the real noise is higher: it is also measured directly,
  // from the differences between profile values three pixels apart on the
  // sides, and the larger of the two is kept.
  const differences = new Float32Array(2 * (PROFILE - 15))
  let nd = 0
  for (let d = 12; d + 3 <= PROFILE; d++) {
    differences[nd++] = Math.abs(p[PROFILE + d] - p[PROFILE + d + 3])
    differences[nd++] = Math.abs(p[PROFILE - d] - p[PROFILE - d - 3])
  }
  const measured = nd > 0 ? (kth(differences, nd >> 1, nd) * MAD_TO_SIGMA) / Math.SQRT2 : 0
  return {
    p,
    sigma,
    sigmaP: Math.max((1.3 * sigma) / Math.sqrt(long), Number.isNaN(measured) ? 0 : measured),
    empty: sigma <= 0 || zeros > samples * 0.3 || p.some((v) => Number.isNaN(v))
  }
}

/** Profiles of `count` equal segments from t1 to t2. */
function profiles(ctx: Context, r: Line, count: number): Profile[] {
  const length = r.t2 - r.t1
  const long = Math.ceil(length / count) + 2
  const column = new Float32Array(long)
  const noise = new Float32Array(long * 2 * 8)
  const result: Profile[] = []
  for (let s = 0; s < count; s++) {
    result.push(profile(ctx, r, r.t1 + (s * length) / count, r.t1 + ((s + 1) * length) / count, column, noise))
  }
  return result
}

/**
 * Trail peak in a profile near center `c`: position, significance (relative
 * to the higher of the two sides) and height.
 */
function peak(pr: Profile, c: number, radius: number): { position: number; z: number; height: number } | null {
  if (pr.empty) return null
  const p = pr.p
  const k0 = Math.round(c) + PROFILE
  let best = -Infinity
  let km = -1
  for (let k = Math.max(9, k0 - radius); k <= Math.min(p.length - 10, k0 + radius); k++) {
    const v = p[k - 1] + p[k] + p[k + 1]
    if (v > best) {
      best = v
      km = k
    }
  }
  if (km < 0) return null
  const center = best / 3
  // Nearby sides, a few pixels from the peak: a trail stands above both, a
  // step (edge of a nebula, edge of the field) only above one.
  let sx = 0
  let dx = 0
  for (let q = 4; q <= 9; q++) {
    sx += p[km - q]
    dx += p[km + q]
  }
  sx /= 6
  dx /= 6
  const background = Math.max(sx, dx)
  // Sub-pixel center: centroid of the three values above the background.
  const a = Math.max(0, p[km - 1] - background)
  const b = Math.max(0, p[km] - background)
  const d = Math.max(0, p[km + 1] - background)
  const shift = a + b + d > 0 ? (d - a) / (a + b + d) : 0
  const z = (center - background) / (pr.sigmaP * Math.sqrt(1 / 3 + 1 / 6))
  return {
    position: km - PROFILE + shift,
    z,
    height: center - (sx + dx) / 2
  }
}

function lineFrom(theta: number, rho: number, w: number, h: number): Line | null {
  const nx = Math.cos(theta)
  const ny = Math.sin(theta)
  return newLine(w / 2 + rho * nx, h / 2 + rho * ny, -ny, nx, w, h)
}

/**
 * Measurement of an average profile: center, height above the background,
 * full width at half maximum. The background is a line between the two
 * sides (12-20 pixels), so a sloping nebula does not widen the measurement.
 */
function measureProfile(p: Float32Array): {
  center: number
  height: number
  fwhm: number
  max: number
} {
  const c = PROFILE
  let sx = 0
  let dx = 0
  for (let q = 12; q <= 20; q++) {
    sx += p[c - q]
    dx += p[c + q]
  }
  sx /= 9
  dx /= 9
  const background = (d: number): number => (sx + dx) / 2 + ((dx - sx) * d) / 32
  let km = c
  for (let k = c - 3; k <= c + 3; k++) if (p[k] - background(k - c) > p[km] - background(km - c)) km = k
  const height = p[km] - background(km - c)
  if (!(height > 0)) return { center: 0, height: 0, fwhm: Infinity, max: p[km] }
  const half = height / 2
  let width = 0
  for (const direction of [-1, 1]) {
    let before = height
    let d = 1
    for (; d <= 20; d++) {
      const v = p[km + direction * d] - background(km - c + direction * d)
      if (v < half) {
        width += d - 1 + (before - half) / Math.max(1e-12, before - v)
        break
      }
      before = v
    }
    if (d > 20) return { center: km - c, height, fwhm: Infinity, max: p[km] }
  }
  const a = Math.max(0, p[km - 1] - background(km - 1 - c))
  const b = height
  const e = Math.max(0, p[km + 1] - background(km + 1 - c))
  return {
    center: km - c + (e - a) / (a + b + e),
    height,
    fwhm: width,
    max: p[km]
  }
}

/** Average profile of several profiles, each brought to its own far background. */
function meanProfile(pr: Profile[]): { p: Float32Array; sigmaP: number } {
  // Median of the profiles, not mean: a bright star or another trail
  // crossing one step must not widen the profile of the whole block.
  const side = 2 * PROFILE + 1
  const result = new Float32Array(side)
  const filledItems = pr.filter((q) => !q.empty)
  if (filledItems.length === 0) return { p: result, sigmaP: Infinity }
  const sides = new Float32Array(2 * (PROFILE - 23))
  const levels = filledItems.map((q) => {
    let m = 0
    for (let d = 24; d <= PROFILE; d++) {
      sides[m++] = q.p[PROFILE + d]
      sides[m++] = q.p[PROFILE - d]
    }
    return kth(sides, m >> 1, m)
  })
  const column = new Float32Array(filledItems.length)
  for (let k = 0; k < side; k++) {
    for (let i = 0; i < filledItems.length; i++) column[i] = filledItems[i].p[k] - levels[i]
    result[k] = kth(column, filledItems.length >> 1)
  }
  const s2 = filledItems.reduce((acc, q) => acc + q.sigmaP * q.sigmaP, 0)
  return { p: result, sigmaP: (1.25 * Math.sqrt(s2)) / filledItems.length }
}

/**
 * All the peaks of a profile within ±radius pixels of the center, higher
 * than their sides by `threshold` times the noise and at least 4 pixels
 * apart: the positions, highest first.
 */
function multiplePeaks(pr: Profile, radius: number, threshold: number): number[] {
  if (pr.empty) return []
  const p = pr.p
  const sum = (k: number): number => p[k - 1] + p[k] + p[k + 1]
  const foundItems: { d: number; z: number }[] = []
  for (let k = Math.max(10, PROFILE - radius); k <= Math.min(p.length - 11, PROFILE + radius); k++) {
    const v = sum(k)
    if (v < sum(k - 1) || v < sum(k + 1) || v < sum(k - 2) || v < sum(k + 2)) continue
    const q = peak(pr, k - PROFILE, 0)
    if (q && q.z > threshold) foundItems.push({ d: q.position, z: q.z })
  }
  foundItems.sort((a, b) => b.z - a.z)
  const kept: number[] = []
  for (const t of foundItems) if (kept.every((d) => Math.abs(d - t.d) >= 4)) kept.push(t.d)
  return kept.slice(0, 4)
}

/** The line's profiles at short steps, with the trail's significance in each. */
interface Series {
  n: number
  step: number
  pr: Profile[]
  /** Significance of the trail exactly on the line; NaN where the step is empty. */
  z: number[]
  firstValid: number
  lastValid: number
}

/**
 * The line is walked in short steps: in each one the significance of the
 * trail exactly on the line (radius of one pixel: no search, hence no random
 * noise peaks). Null if the line is too short or half empty.
 */
function series(ctx: Context, r: Line): Series | null {
  const length = r.t2 - r.t1
  if (length < 0.25 * Math.min(ctx.w, ctx.h)) return null
  const n = Math.max(8, Math.round(length / STEP))
  const pr = profiles(ctx, r, n)
  const z: number[] = pr.map((q) => {
    if (q.empty) return NaN
    const v = peak(q, 0, 1)
    return v ? v.z : 0
  })
  if (z.filter((v) => !Number.isNaN(v)).length < n / 2) return null
  const firstValid = z.findIndex((v) => !Number.isNaN(v))
  let lastValid = n - 1
  while (lastValid > 0 && Number.isNaN(z[lastValid])) lastValid--
  return { n, step: length / n, pr, z, firstValid, lastValid }
}

/**
 * The stretch where the trail is: the one that maximizes the sum of (z - θ).
 * Each step with the trail adds, each empty step subtracts θ; a pause
 * between two dashes costs little and is crossed, a long empty stretch is
 * not. A step's contribution is bounded, so a bright star is not enough to
 * keep a stretch alive; and bounded below too: a star next to the line makes
 * a step very negative, and must not break the trail. Returns the first and
 * last step.
 */
function bestPiece(z: number[], theta: number): [number, number] {
  const cap = Math.max(8, 2 * theta)
  let best = -Infinity
  let a = 0
  let b = -1
  let current = 0
  let currentStart = 0
  for (let k = 0; k < z.length; k++) {
    const v = Number.isNaN(z[k]) ? 0 : Math.max(-3, Math.min(z[k], cap)) - theta
    if (current <= 0) {
      current = 0
      currentStart = k
    }
    current += v
    if (current > best) {
      best = current
      a = currentStart
      b = k
    }
  }
  while (a <= b && (Number.isNaN(z[a]) || z[a] < theta)) a++
  while (b >= a && (Number.isNaN(z[b]) || z[b] < theta)) b--
  return [a, b]
}

/** Outcome of verifying a line. */
interface Checked {
  line: Line
  coverage: number
  whole: boolean
  fwhm: number
  lines: number
}

function check(ctx: Context, initial: Line): Checked | null {
  const { w, h, s } = ctx
  let r = initial
  if (r.t2 - r.t1 < 0.25 * Math.min(w, h)) {
    return null
  }
  const segmentThreshold = 4.5 - s

  // Straightening: peaks are sought in a wide band, then ever narrower, and
  // the line is made to pass through the peaks found. In the first pass all
  // the peaks of each segment are kept, not just the highest: with the two or
  // three parallel lines of an airplane the highest jumps from one line to
  // another, and the line that collects the most of them is one of the lines,
  // with its correct inclination.
  const rays = [24, 6, 3]
  for (let pass = 0; pass < rays.length; pass++) {
    const pr = profiles(ctx, r, SEGMENTS)
    const length = r.t2 - r.t1
    const points: { t: number; d: number }[] = []
    for (let k = 0; k < SEGMENTS; k++) {
      const t = r.t1 + ((k + 0.5) * length) / SEGMENTS
      if (pass === 0) {
        for (const d of multiplePeaks(pr[k], rays[pass], segmentThreshold)) points.push({ t, d })
        continue
      }
      const q = peak(pr[k], 0, rays[pass])
      if (q && q.z > segmentThreshold) points.push({ t, d: q.position })
    }
    if (points.length < 3) return null
    const fit = robustLine(points)
    if (!fit) {
      return null
    }
    // New line: shifted by a along the normal, rotated by atan(b).
    const nx = r.dy
    const ny = -r.dx
    let dx = r.dx + fit.b * nx
    let dy = r.dy + fit.b * ny
    const norm = Math.hypot(dx, dy)
    dx /= norm
    dy /= norm
    const newValue = newLine(r.px + fit.a * nx, r.py + fit.a * ny, dx, dy, w, h)
    if (!newValue) return null
    r = newValue
  }

  // The line is walked in short steps (see `series`) and the stretch where
  // the trail is sought (see `bestPiece`).
  let ser = series(ctx, r)
  if (!ser) return null
  let [a, b] = bestPiece(ser.z, 1.5)
  if (b - a + 1 < 3) return null
  // A short trail occupies few segments of the straightening, done over the
  // whole line: it is straightened again on the stretch's steps alone, and
  // the search is repeated.
  for (let pass = 0; pass < 2 && (a > ser.firstValid + 2 || b < ser.lastValid - 2); pass++) {
    const points: { t: number; d: number }[] = []
    for (let k = Math.max(0, a - 2); k <= Math.min(ser.n - 1, b + 2); k++) {
      const q = peak(ser.pr[k], 0, 3)
      if (q && q.z > 3) points.push({ t: r.t1 + (k + 0.5) * ser.step, d: q.position })
    }
    const fit = points.length >= 3 ? robustLine(points) : null
    if (fit) {
      const nx = r.dy
      const ny = -r.dx
      let dx = r.dx + fit.b * nx
      let dy = r.dy + fit.b * ny
      const norm = Math.hypot(dx, dy)
      dx /= norm
      dy /= norm
      const newValue = newLine(r.px + fit.a * nx, r.py + fit.a * ny, dx, dy, w, h)
      const newSeries = newValue ? series(ctx, newValue) : null
      if (newValue && newSeries) {
        r = newValue
        ser = newSeries
        ;[a, b] = bestPiece(ser.z, 1.5)
        if (b - a + 1 < 3) return null
      }
    }
  }
  // Second pass with the threshold suited to the trail: on a nebula the
  // steps beyond the endpoint often remain slightly above the background,
  // and with the low threshold the stretch would extend past the end of the
  // trail. The lowest quarter of the steps is used, not the median: between
  // the dashes of an airplane there are empty steps, and a high threshold
  // would break the trail.
  const inChunk = ser.z
    .slice(a, b + 1)
    .filter((v) => !Number.isNaN(v))
    .sort((p, q) => p - q)
  const theta = Math.max(1.5, 0.2 * inChunk[inChunk.length >> 2])
  if (theta > 1.5) {
    ;[a, b] = bestPiece(ser.z, theta)
    if (b - a + 1 < 3) return null
  }
  const { z, pr, step, firstValid, lastValid } = ser
  const piece: number[] = []
  for (let k = a; k <= b; k++) if (!Number.isNaN(z[k])) piece.push(k)
  const seenItems = piece.filter((k) => z[k] > 2)
  const coverage = seenItems.length / piece.length
  const significance = piece.reduce((acc, k) => acc + Math.min(z[k], 8), 0) / Math.sqrt(piece.length)

  // A whole trail: looser conditions. The line is divided into 16 segments,
  // summing the short steps (a very faint trail is not visible in a single
  // step, but is in a segment): the trail must be seen in the large majority
  // of segments, and in the segments at both ends. The profile, taken a
  // little above the median to see the dashes, is slightly noisier than the
  // one at the median: hence the 0.9.
  const fullCoverage = 0.85 - 0.25 * s
  const segments: boolean[] = []
  for (let g = 0; g < 16; g++) {
    const from = firstValid + Math.floor((g * (lastValid - firstValid + 1)) / 16)
    const until = firstValid + Math.floor(((g + 1) * (lastValid - firstValid + 1)) / 16)
    const values = z.slice(from, until).filter((v) => !Number.isNaN(v))
    if (values.length === 0) continue
    segments.push(values.reduce((acc, v) => acc + Math.min(v, 8), 0) / Math.sqrt(values.length) > 4.5 - s)
  }
  const fullView =
    segments.length >= 8 &&
    segments.filter((v) => v).length / segments.length >= 0.9 * fullCoverage &&
    (segments[0] || segments[1]) &&
    (segments[segments.length - 1] || segments[segments.length - 2])
  // Average profile of the stretch and its width: even a whole trail must
  // be as wide as a star.
  const measurement = measureProfile(meanProfile(piece.map((k) => pr[k])).p)
  const saturatedValue = measurement.max >= ctx.saturation
  const widthLimit = saturatedValue ? 4 * ctx.fwhm + 4 : 1.5 * ctx.fwhm + 1
  const allValid = z.filter((v) => !Number.isNaN(v))
  const fullSignificance = allValid.reduce((acc, v) => acc + Math.min(v, 8), 0) / Math.sqrt(allValid.length)
  let accepted = fullView && fullSignificance > 12 - 4 * s && measurement.fwhm <= widthLimit
  if (accepted) {
    // Whole: from edge to edge, even where a step stayed below.
    a = firstValid
    b = lastValid
  }

  if (!accepted) {
    // A partial trail: all the characteristics of a trail.
    const chunkLength = (b - a + 1) * step
    if (chunkLength < Math.max(MIN_LENGTH, LENGTH_IN_FWHM * ctx.fwhm)) return null
    if (coverage < 0.6 - 0.15 * s) return null
    if (significance < 16 - 6 * s) return null
    // The trail is present in at least half of the steps, and well above the
    // noise: a row of stars aligned by chance gives few high steps and many
    // empty ones.
    const sortedItems = piece.map((k) => z[k]).sort((p, q) => p - q)
    if (sortedItems[sortedItems.length >> 1] < 4) return null
    if (!(measurement.fwhm <= widthLimit) || measurement.fwhm < 0.45 * ctx.fwhm) return null
    if (!shape(ctx, pr, piece, z, measurement.fwhm, saturatedValue)) return null
    if (insideAnObject(ctx, r, r.t1 + a * step, r.t1 + (b + 1) * step)) return null
    accepted = true
  }

  // Endpoints: for a whole trail beyond the edges; for a partial one they
  // are sought pixel by pixel around the extreme steps, going beyond by two
  // star widths, where the round end of the trail is faded. A faint trail
  // that reaches almost to the edge, with the few missing steps still
  // slightly above the background, reaches the edge: the stretch ended
  // earlier only because of noise.
  const beyond = 2 * ctx.fwhm + 4
  const mean = (from: number, a: number): number => {
    const v = z.slice(from, a + 1).filter((x) => !Number.isNaN(x))
    return v.length > 0 ? v.reduce((p, q) => p + q, 0) / v.length : 0
  }
  const atEdge1 = a <= firstValid + 2 || (a <= firstValid + 6 && mean(firstValid, a - 1) >= 1)
  const atEdge2 = b >= lastValid - 2 || (b >= lastValid - 6 && mean(b + 1, lastValid) >= 1)
  r.start = atEdge1 ? -Infinity : refineEnd(ctx, r, r.t1 + (a + 1) * step, -1, step) - beyond
  r.end = atEdge2 ? Infinity : refineEnd(ctx, r, r.t1 + b * step, 1, step) + beyond
  const seenStep = z.map((v, k) => k >= a && k <= b && v > 2)
  const heights = pr.map((q, k) => (seenStep[k] ? (peak(q, 0, 1)?.height ?? 0) : 0))
  r.seeds = halfWidths(pr, seenStep, heights)

  // Nearby parallel lines (the wing lights of an airplane): the replaced
  // band is widened to include them.
  const lines = parallelLines(meanProfile(piece.map((k) => pr[k])), ctx.fwhm, widthLimit)
  if (lines.length > 0) {
    const dMin = Math.min(0, ...lines)
    const dMax = Math.max(0, ...lines)
    const shift = (dMin + dMax) / 2
    const nx = r.dy
    const ny = -r.dx
    const widened = newLine(r.px + shift * nx, r.py + shift * ny, r.dx, r.dy, w, h)
    if (widened) {
      // The shifted line has the same starting point along the direction:
      // the t parameters stay the same.
      widened.t1 = r.t1
      widened.t2 = r.t2
      widened.start = r.start
      widened.end = r.end
      widened.seeds = r.seeds.map((v) => Math.min(MAX_HALF_WIDTH + 30, v + (dMax - dMin) / 2))
      r = widened
    }
  }
  return accepted
    ? {
        line: r,
        coverage,
        whole: r.start === -Infinity && r.end === Infinity,
        fwhm: measurement.fwhm,
        lines: lines.length + 1
      }
    : null
}

/**
 * Where the trail ends, searching from `inside` (where it is) outward
 * (`direction` is +1 or -1 along the line); ±Infinity if it reaches the
 * edge. At each pixel along the line it measures how far the center stands
 * above the sides, and sums its deviation from half the trail's height: the
 * sum grows while the trail is there and falls afterwards, and its maximum
 * is the endpoint. The same holds for the dashes of an airplane: the
 * endpoint is the end of the last dash.
 */
function refineEnd(ctx: Context, r: Line, inside: number, direction: number, step: number): number {
  const { lum, w, h } = ctx
  const nx = r.dy
  const ny = -r.dx
  const value = (t: number, d: number): number => {
    const x = Math.round(r.px + t * r.dx + d * nx)
    const y = Math.round(r.py + t * r.dy + d * ny)
    return x < 0 || y < 0 || x >= w || y >= h ? NaN : lum[y * w + x]
  }
  const side = Math.max(4, Math.ceil(1.5 * ctx.fwhm))
  const above = (t: number): number =>
    (value(t, -1) + value(t, 0) + value(t, 1)) / 3 -
    (value(t, -side) + value(t, -side - 1) + value(t, side) + value(t, side + 1)) / 4
  // Average height of the trail over the three steps toward the inside,
  // without the highest tenth (stars): with dashes it is the mean between
  // dashes and pauses, which is the one needed.
  const insideValues: number[] = []
  for (let q = 0; q < 3 * step; q++) {
    const v = above(inside - direction * q)
    if (!Number.isNaN(v)) insideValues.push(v)
  }
  if (insideValues.length < 10) return inside
  insideValues.sort((p, q) => p - q)
  const kept = insideValues.slice(0, Math.ceil(insideValues.length * 0.9))
  const mean = kept.reduce((acc, v) => acc + v, 0) / kept.length
  if (!(mean > 0)) return inside
  // It goes outward for two steps (the stretch's extreme step and the next),
  // or to the edge: farther on, in a nebula, the filaments crossing the line
  // would wrongly lengthen the trail.
  const edge = direction > 0 ? r.t2 : r.t1
  const steps = Math.min(2 * step, Math.abs(edge - inside))
  let sum = 0
  let max = 0
  let extreme = inside
  for (let q = 0; q <= steps; q++) {
    const t = inside + direction * q
    const a = above(t)
    if (Number.isNaN(a)) continue
    // A star next to the line must not shift the endpoint.
    sum += Math.max(-3 * mean, Math.min(3 * mean, a)) - mean / 2
    if (sum > max) {
      max = sum
      extreme = t
    }
  }
  // Having come within a few pixels of the edge, the trail leaves the image.
  if (Math.abs(edge - extreme) < 8) return direction > 0 ? Infinity : -Infinity
  return extreme
}

/**
 * Shape of the track along its path, in blocks of steps: the width must stay
 * constant (a galaxy tapers at the tips), the centers must lie on the line
 * to within about a pixel (a filament bends), and the brightness must not be
 * spindle-shaped (brightest at the center and faded at the tips) if the
 * track is also wider than a star. True if the track has the shape of a
 * trail.
 */
function shape(ctx: Context, pr: Profile[], piece: number[], z: number[], fwhm: number, saturatedValue: boolean): boolean {
  const blocks = Math.max(3, Math.min(10, Math.floor(piece.length / 3)))
  const measurements: {
    t: number
    center: number
    fwhm: number
    height: number
    snr: number
  }[] = []
  for (let k = 0; k < blocks; k++) {
    const from = Math.floor((k * piece.length) / blocks)
    const a = Math.floor(((k + 1) * piece.length) / blocks)
    const chosenItems = piece.slice(from, a).filter((q) => z[q] > 0)
    if (chosenItems.length === 0) {
      measurements.push({ t: k, center: 0, fwhm: NaN, height: 0, snr: 0 })
      continue
    }
    const averagedProfile = meanProfile(chosenItems.map((q) => pr[q]))
    const m = measureProfile(averagedProfile.p)
    measurements.push({
      t: k,
      center: m.center,
      fwhm: m.fwhm,
      height: m.height,
      snr: m.height / averagedProfile.sigmaP
    })
  }

  // Constant width: among the well-measured blocks, the widest does not
  // exceed the narrowest by much. With five or more blocks the widest and
  // the narrowest are left out: a star next to the trail can alter one.
  const goodOnes = measurements.filter((m) => m.snr > 10 && Number.isFinite(m.fwhm))
  // Nor much narrower than a star: the trail is a star that moves, and its
  // profile cannot be finer.
  if (!saturatedValue && goodOnes.length >= 2) {
    const all = goodOnes.map((m) => m.fwhm).sort((p, q) => p - q)
    const widths = all.length >= 5 ? all.slice(1, -1) : all
    const median = widths[widths.length >> 1]
    if ((widths[widths.length - 1] - widths[0]) / median > 0.6) return false
    if (widths[0] < 0.4 * ctx.fwhm) return false
  }

  // Straightness: root-mean-square deviation of the centers from the line
  // (which is already the one that best passes through the peaks). The
  // uncertainty of a measured center is about the width divided by the
  // signal-to-noise ratio. Only well-measured blocks count (between the
  // dashes of an airplane a block can be almost empty), and relative to the
  // line that best fits them: a small inclination is a defect of our line,
  // not of the trail.
  const centered = measurements.filter((m) => m.snr > 15)
  if (centered.length >= 3) {
    const n = centered.length
    const mt = centered.reduce((acc, m) => acc + m.t, 0) / n
    const mc = centered.reduce((acc, m) => acc + m.center, 0) / n
    const stt = centered.reduce((acc, m) => acc + (m.t - mt) ** 2, 0)
    const slope = stt > 0 ? centered.reduce((acc, m) => acc + (m.t - mt) * (m.center - mc), 0) / stt : 0
    const deviation = Math.sqrt(centered.reduce((acc, m) => acc + (m.center - mc - slope * (m.t - mt)) ** 2, 0) / n)
    const uncertainty = centered.map((m) => (0.7 * fwhm) / m.snr).sort((p, q) => p - q)[centered.length >> 1]
    if (deviation > 1 + 2 * uncertainty) return false
  }

  // Curvature: a parabola through the centers of the single steps. On an arc
  // the sagitta (the offset halfway between chord and arc) exceeds a pixel
  // over just a few hundred pixels; on a trail it stays within the noise.
  if (curve(pr, piece, z, fwhm)) return false

  // Spindle-shaped brightness with a track wider than a star: it is an
  // edge-on galaxy.
  const heights = measurements.map((m) => m.height)
  const peak = Math.max(...heights)
  const where = heights.indexOf(peak)
  const tips = Math.max(heights[0], heights[heights.length - 1])
  const central = where > 0 && where < heights.length - 1
  if (central && tips < 0.35 * peak && fwhm > 1.4 * ctx.fwhm) return false

  // Regular brightness. A trail is constant, or changes only once: a step
  // (Earth's shadow), a rise and a fall (the flash of a satellite); the
  // dashes of an airplane, summed in blocks, look constant. A nebula
  // filament switches on and off several times: the reversals between rises
  // and falls larger than the noise and than two fifths of the maximum are
  // counted. The first and last block are left out: the trail may cover
  // them only partly.
  const inner = measurements.length >= 5 ? measurements.slice(1, -1) : measurements
  let top = inner[0].height
  let bottom = inner[0].height
  let direction = 0
  let inversions = 0
  for (let k = 1; k < inner.length; k++) {
    const v = inner[k].height
    const noise = inner[k].snr > 0 ? inner[k].height / inner[k].snr : 0
    const tolerance = Math.max(4 * noise, 0.4 * peak)
    if (direction === 0) {
      top = Math.max(top, v)
      bottom = Math.min(bottom, v)
      if (top - bottom > tolerance) direction = v === top ? 1 : -1
    } else if (direction === 1) {
      if (v > top) top = v
      else if (top - v > tolerance) {
        inversions++
        direction = -1
        bottom = v
      }
    } else if (v < bottom) bottom = v
    else if (v - bottom > tolerance) {
      inversions++
      direction = 1
      top = v
    }
  }
  return inversions < 2
}

/**
 * True if the centers of the track, step by step, lie on a curve and not on
 * a line: the sagitta of the parabola that follows them exceeds one pixel
 * and three times its uncertainty.
 */
function curve(pr: Profile[], piece: number[], z: number[], fwhm: number): boolean {
  const points: { t: number; d: number; weight: number }[] = []
  for (const k of piece) {
    if (!(z[k] > 3)) continue
    const q = peak(pr[k], 0, 3)
    if (!q || q.z < 3) continue
    // Uncertainty of a center: about the width divided by the signal.
    const error = Math.max(0.15, (0.7 * fwhm) / q.z)
    points.push({ t: k, d: q.position, weight: 1 / (error * error) })
  }
  if (points.length < 6) return false
  const sum = points.reduce((a, p) => a + p.weight, 0)
  const tm = points.reduce((a, p) => a + p.weight * p.t, 0) / sum
  // Weighted least squares for d = a + b u + c u², with u = t - tm.
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  const v = [0, 0, 0]
  for (const p of points) {
    const u = p.t - tm
    const f = [1, u, u * u]
    for (let i = 0; i < 3; i++) {
      v[i] += p.weight * f[i] * p.d
      for (let j = 0; j < 3; j++) m[i][j] += p.weight * f[i] * f[j]
    }
  }
  const inverted = invert3(m)
  if (!inverted) return false
  const c = inverted[2][0] * v[0] + inverted[2][1] * v[1] + inverted[2][2] * v[2]
  const sigmaC = Math.sqrt(Math.max(0, inverted[2][2]))
  const meta = (points[points.length - 1].t - points[0].t) / 2
  const arrow = Math.abs(c) * meta * meta
  return arrow > 1 && Math.abs(c) > 3 * sigmaC
}

/** Inverse of a 3 x 3 matrix, or null if it is singular. */
function invert3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0]
  const [d, e, f] = m[1]
  const [g, h, i] = m[2]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (!(Math.abs(det) > 1e-300)) return null
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
  ]
}

/**
 * Peaks parallel to the trail in the average profile, within 30 pixels of
 * the center, as tall and narrow as a trail: the distances from the center.
 */
function parallelLines(averagedProfile: { p: Float32Array; sigmaP: number }, fwhm: number, limit: number): number[] {
  const p = averagedProfile.p
  const c = PROFILE
  const main = p[c]
  const foundAll: number[] = []
  const minimum = Math.max(4, Math.ceil(1.8 * fwhm))
  for (let d = -30; d <= 30; d++) {
    if (Math.abs(d) < minimum) continue
    const k = c + d
    if (k < 11 || k > p.length - 12) continue
    if (!(p[k] >= p[k - 1] && p[k] > p[k + 1] && p[k] >= p[k - 2] && p[k] > p[k + 2])) continue
    // Local background a few pixels from the two sides of the secondary peak.
    const side = Math.max(3, Math.ceil(fwhm * 1.5))
    const background = Math.max((p[k - side] + p[k - side - 1]) / 2, (p[k + side] + p[k + side + 1]) / 2)
    const height = p[k] - background
    if (height < 6 * averagedProfile.sigmaP || height < 0.15 * main) continue
    // Narrow like a trail: the peak falls to half within the limit.
    let wide = 0
    for (const direction of [-1, 1]) {
      let q = 1
      while (q < limit && p[k + direction * q] - background > height / 2) q++
      wide += q
    }
    if (wide > limit + 2) continue
    foundAll.push(d)
  }
  return foundAll
}

/**
 * True if the stretch of line between ta and tb lies mostly inside a
 * protected zone (a catalog object) and follows its major axis.
 */
function insideAnObject(ctx: Context, r: Line, ta: number, tb: number): boolean {
  for (const z of ctx.protectedZones) {
    const a = z.semiMajor * 1.25 + 3 * ctx.fwhm
    const b = z.semiMinor * 1.25 + 3 * ctx.fwhm
    if (!(a > 0) || !(b > 0)) continue
    const angle = z.angle ?? 0
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    if (z.angle !== null) {
      // Direction of the track relative to the major axis, within 15°.
      const cosine = Math.abs(r.dx * ca + r.dy * sa)
      if (cosine < Math.cos((15 * Math.PI) / 180)) continue
    }
    let inside = 0
    let count = 0
    for (let t = ta; t <= tb; t += 4) {
      const x = r.px + t * r.dx - z.cx
      const y = r.py + t * r.dy - z.cy
      const u = x * ca + y * sa
      const v = -x * sa + y * ca
      count++
      if ((u / a) ** 2 + (v / b) ** 2 <= 1) inside++
    }
    if (count > 0 && inside / count >= 0.7) return true
  }
  return false
}

/** Line d = a + b·t through the points, discarding distant ones (stars, filaments). */
function robustLine(points: { t: number; d: number }[]): { a: number; b: number } | null {
  // Start: the line through two points that leaves the most points near it.
  // With the parallel lines of an airplane the peaks fall now on one, now
  // on another, and an average line among all of them would lie on none.
  let usedValues = points
  let bestOnes = -1
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dt = points[j].t - points[i].t
      if (Math.abs(dt) < 1e-6) continue
      const b = (points[j].d - points[i].d) / dt
      const a = points[i].d - b * points[i].t
      const neighbors = points.filter((p) => Math.abs(p.d - a - b * p.t) < 2.5)
      if (neighbors.length > bestOnes) {
        bestOnes = neighbors.length
        usedValues = neighbors
      }
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    const n = usedValues.length
    if (n < 3) return null
    let st = 0
    let sd = 0
    for (const p of usedValues) {
      st += p.t
      sd += p.d
    }
    const mt = st / n
    const md = sd / n
    let stt = 0
    let std = 0
    for (const p of usedValues) {
      stt += (p.t - mt) * (p.t - mt)
      std += (p.t - mt) * (p.d - md)
    }
    const b = stt > 0 ? std / stt : 0
    const a = md - b * mt
    const residuals = usedValues.map((p) => Math.abs(p.d - a - b * p.t))
    const kept = usedValues.filter((_, i) => residuals[i] < 2.5)
    if (pass === 2 || kept.length === usedValues.length) return { a, b }
    usedValues = kept
  }
  return null
}

/**
 * Half-width of the trail at each step: from the center outward, until the
 * profile falls to the background level (within the profile noise) or starts
 * rising again for something else. Steps where the trail was not seen get
 * the typical width; each step also takes the maximum of its neighbors,
 * because the brightness (and with it the visible width) of a flash changes
 * along the trail.
 */
function halfWidths(pr: Profile[], seenItems: boolean[], heights: number[]): number[] {
  const n = pr.length
  const measurements: number[] = new Array(n).fill(0)
  for (let k = 0; k < n; k++) {
    if (!seenItems[k]) continue
    const p = pr[k].p
    const c = PROFILE
    // Background from the far sides, blended linearly.
    let sx = 0
    let dx = 0
    for (let q = 30; q <= PROFILE; q++) {
      sx += p[c - q]
      dx += p[c + q]
    }
    sx /= PROFILE - 29
    dx /= PROFILE - 29
    const threshold = Math.max(2.5 * pr[k].sigmaP, 0.002 * heights[k])
    let max = 0
    for (const direction of [-1, 1]) {
      // Profile smoothed over three values, minus the background, at distance d.
      const above = (d: number): number => {
        const k0 = c + direction * d
        const background = (sx + dx) / 2 + ((dx - sx) * (direction * d)) / (2 * 35)
        return (p[k0 - 1] + p[k0] + p[k0 + 1]) / 3 - background
      }
      let d = 1
      for (; d < MAX_HALF_WIDTH; d++) {
        const v = above(d)
        // End of the trail: the profile has fallen to the background, or no
        // longer falls (the near background is not the far one: halo of a
        // galaxy, nebula), and then what remains is not part of the trail.
        if (v < threshold || v - above(d + 2) < pr[k].sigmaP) break
      }
      max = Math.max(max, d)
    }
    measurements[k] = max
  }
  const views = measurements.filter((v) => v > 0).sort((a, b) => a - b)
  const typical = views.length > 0 ? views[views.length >> 1] : 2
  const base = measurements.map((v) => Math.max(v, typical))
  // Maximum over two steps per side: with short steps the measurement of a
  // single step is noisy, and a slightly wider band costs nothing.
  return base.map((_, k) => {
    let m = 1.5
    for (let q = Math.max(0, k - 2); q <= Math.min(n - 1, k + 2); q++) m = Math.max(m, base[q])
    return Math.min(MAX_HALF_WIDTH, m + 1)
  })
}

function describe(r: Line, v: Checked, strength: number): Trail {
  let angle = (Math.atan2(r.dy, r.dx) * 180) / Math.PI
  if (angle < 0) angle += 180
  if (angle >= 180) angle -= 180
  const ti = Math.max(r.t1, r.start)
  const tf = Math.min(r.t2, r.end)
  // Half-widths of the steps of the present stretch only.
  const n = r.seeds.length
  const from = Math.max(0, Math.floor(((ti - r.t1) / (r.t2 - r.t1)) * n))
  const a = Math.min(n, Math.ceil(((tf - r.t1) / (r.t2 - r.t1)) * n))
  const seeds = r.seeds.slice(from, Math.max(from + 1, a))
  return {
    x1: r.px + ti * r.dx,
    y1: r.py + ti * r.dy,
    x2: r.px + tf * r.dx,
    y2: r.py + tf * r.dy,
    angle,
    width: 2 * Math.max(...seeds),
    fwhm: v.fwhm,
    halfWidths: seeds,
    coverage: v.coverage,
    whole: v.whole,
    lines: v.lines,
    strength
  }
}

// ---------------------------------------------------------------------------
// Reconstruction

/**
 * Noise of a plane from the difference between pixels three columns apart
 * (stars do not weigh). Contiguous pixels are not used: in demosaiced and
 * stacked files they are correlated and the noise would come out much lower
 * than the real one.
 */
function planeNoise(p: Float32Array, w: number, h: number): number {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 60000)))
  const diff: number[] = []
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 4; x += step) diff.push(Math.abs(p[y * w + x + 3] - p[y * w + x]))
  }
  if (diff.length === 0) return 0
  const a = Float32Array.from(diff)
  return (kth(a, a.length >> 1) * MAD_TO_SIGMA) / Math.SQRT2
}

/** Half-width at position t, blended between the step centers. */
function halfWidthIn(r: Line, t: number): number {
  const n = r.seeds.length
  const f = ((t - r.t1) / (r.t2 - r.t1)) * n - 0.5
  if (f <= 0) return r.seeds[0]
  if (f >= n - 1) return r.seeds[n - 1]
  const k = Math.floor(f)
  const u = f - k
  return r.seeds[k] * (1 - u) + r.seeds[k + 1] * u
}

/** Repeatable Gaussian pseudo-random number, tied to the position. */
function gaussianFrom(i: number): number {
  let x = (i * 2654435761) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 2246822519) >>> 0
  x ^= x >>> 13
  const u1 = ((x & 0xffff) + 0.5) / 65536
  const u2 = ((x >>> 16) + 0.5) / 65536
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Distance from the trail at which the background of the two sides is measured. */
const GAP = 2
/** Thickness of the background stripe on each side, and half length along the trail. */
const STRIPE = 4
const HALF_WINDOW = 10
/** Every how many pixels along the trail the background is measured. */
const BACKGROUND_STEP = 3
/** Shift along the trail of the band from which the grain is copied. */
const GRAIN_SHIFT = 7
/** Length of the fade toward the original at the endpoints of a partial trail. */
const FEATHER_EXTREMES = 4

/**
 * Replaces in place the trail's pixels in a plane, only in the stretch
 * between `start` and `end`.
 *
 * The background comes from the two sides: median of a stripe just outside
 * the trail (so neighboring stars do not weigh), blended linearly across the
 * trail. The grain is copied from a parallel band of sky, as wide as the
 * trail and just outside it, shifted all together: copying it pixel by pixel
 * from different places, the grain (which in demosaiced files forms specks
 * of a few pixels) would break into a visible seam. Only the band's
 * deviation from its own background is taken. Where the band contains a
 * star, the band from the other side is used, and if there is a star there
 * too, synthetic grain of the same amplitude.
 */
function rebuild(plane: Float32Array, w: number, h: number, r: Line, sigma: number, visited: Uint8Array): void {
  const nx = r.dy
  const ny = -r.dx
  const maxHalfWidth = Math.max(...r.seeds) + 1
  // Distance of the band from which the grain is copied: its inner edge
  // sits just outside the trail's fade.
  const grainDistance = (seeds: number): number => 2 * seeds + GAP + 1
  // Margin beyond the endpoints: near the edges the oblique band extends past
  // the point where the line leaves, and the grain is taken shifted.
  const margin = Math.ceil(maxHalfWidth) + GRAIN_SHIFT + HALF_WINDOW + 2
  // Stretch to replace: for a partial trail only between its endpoints.
  const tA = Math.max(r.t1 - margin, r.start)
  const tB = Math.min(r.t2 + margin, r.end)
  const t0 = Math.floor(tA) - margin
  const length = Math.ceil(tB) - t0 + margin + 1
  const pixel = (t: number, d: number): number => {
    const x = Math.round(r.px + t * r.dx + d * nx)
    const y = Math.round(r.py + t * r.dy + d * ny)
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x
  }

  /**
   * Median, for each position along the trail, of the pixels at the given
   * distances. The background changes slowly along the trail: it is computed
   * every `BACKGROUND_STEP` pixels and blended in between.
   */
  const longBackground = (distances: (seeds: number) => number[], half = HALF_WINDOW, jump = 1): Float32Array => {
    const f = new Float32Array(length)
    const samples = new Float32Array((2 * half + 1) * 8)
    for (let i = 0; i < length; i++) {
      if (i % BACKGROUND_STEP !== 0 && i !== length - 1) continue
      const t = t0 + i
      const dd = distances(halfWidthIn(r, t))
      let m = 0
      for (let dt = -half; dt <= half; dt += jump) {
        for (const d of dd) {
          const j = pixel(t + dt, d)
          if (j >= 0) samples[m++] = plane[j]
        }
      }
      if (m < 4) {
        f[i] = NaN
        continue
      }
      // Median, then again without the values far above it: a star next to
      // the trail occupies part of the window and would raise the
      // background, leaving a bright stripe along the trail.
      const median = kth(samples, m >> 1, m)
      let q = 0
      for (let k = 0; k < m; k++) if (Math.abs(samples[k] - median) <= 2.5 * sigma) samples[q++] = samples[k]
      f[i] = q >= 4 ? kth(samples, q >> 1, q) : median
    }
    for (let i = 0; i < length - 1; i++) {
      if (i % BACKGROUND_STEP === 0) continue
      const a = i - (i % BACKGROUND_STEP)
      const b = Math.min(length - 1, a + BACKGROUND_STEP)
      const u = (i - a) / (b - a)
      f[i] = Number.isNaN(f[a]) ? f[b] : Number.isNaN(f[b]) ? f[a] : f[a] + (f[b] - f[a]) * u
    }
    return f
  }
  const stripe =
    (direction: number) =>
    (seeds: number): number[] =>
      Array.from({ length: STRIPE }, (_, q) => direction * (seeds + GAP + q))
  const strip =
    (direction: number) =>
    (seeds: number): number[] =>
      [-1, -0.5, 0, 0.5, 1].map((u) => direction * (grainDistance(seeds) + u * seeds))
  // Background of the two sides next to the trail, and background of the
  // two grain bands. The background of each side is compared with the same
  // measured over a stretch three times longer: where it departs by more
  // than the noise there is a large star in the stripe, and the long one is
  // used. Without this, the star would stretch across the trail as a bright
  // rectangle.
  const backgrounds = [-1, 1].map((direction) => {
    const shortValue = longBackground(stripe(direction))
    const long = longBackground(stripe(direction), 3 * HALF_WINDOW, 3)
    for (let i = 0; i < length; i++) if (Math.abs(shortValue[i] - long[i]) > sigma) shortValue[i] = long[i]
    return shortValue
  })
  const stripBackgrounds = [longBackground(strip(-1)), longBackground(strip(1))]

  // Where one side is outside the image the other is used; where both are
  // missing (beyond the endpoints) the nearest valid position is used.
  for (const pair of [backgrounds, stripBackgrounds]) {
    for (let i = 0; i < length; i++) {
      if (Number.isNaN(pair[0][i])) pair[0][i] = pair[1][i]
      if (Number.isNaN(pair[1][i])) pair[1][i] = pair[0][i]
    }
    for (const f of pair) {
      for (let i = 1; i < length; i++) if (Number.isNaN(f[i])) f[i] = f[i - 1]
      for (let i = length - 2; i >= 0; i--) if (Number.isNaN(f[i])) f[i] = f[i + 1]
      if (Number.isNaN(f[0])) return
    }
  }
  const valueIn = (f: Float32Array, t: number): number => f[Math.max(0, Math.min(length - 1, Math.round(t) - t0))]

  const grainLimit = 3 * sigma
  const newOnes: [number, number][] = []
  visited.fill(0)
  // The pixels along and across the trail are scanned in half-pixel steps so
  // that no holes remain on oblique lines; for each pixel the true position
  // and distance of its center are then computed.
  for (let t2 = 2 * Math.floor(tA); t2 <= 2 * Math.ceil(tB); t2++) {
    for (let d2 = -2 * maxHalfWidth; d2 <= 2 * maxHalfWidth; d2++) {
      const j = pixel(t2 / 2, d2 / 2)
      if (j < 0 || visited[j]) continue
      visited[j] = 1
      const x = j % w
      const y = (j - x) / w
      const t = (x - r.px) * r.dx + (y - r.py) * r.dy
      if (t < r.start || t > r.end) continue
      const d = (x - r.px) * nx + (y - r.py) * ny
      const seeds = halfWidthIn(r, t)
      const ad = Math.abs(d)
      if (ad >= seeds + 1) continue
      // Background blended between the two stripes, at whose centers it was measured.
      const amplitude = seeds + GAP + (STRIPE - 1) / 2
      const u = Math.max(0, Math.min(1, (d + amplitude) / (2 * amplitude)))
      const fs = valueIn(backgrounds[0], t)
      const background = fs + (valueIn(backgrounds[1], t) - fs) * u
      // Grain: same point in the shifted band, first from one side then the other.
      let grain = NaN
      for (const v of [1, -1]) {
        const tSource = t + v * GRAIN_SHIFT
        const js = pixel(tSource, d + v * grainDistance(seeds))
        if (js < 0) continue
        const g = plane[js] - valueIn(stripBackgrounds[v < 0 ? 0 : 1], tSource)
        if (Math.abs(g) <= grainLimit) {
          grain = g
          break
        }
      }
      if (Number.isNaN(grain)) grain = sigma * gaussianFrom(j)
      // On the outer edge (between seeds and seeds + 1) it fades toward the
      // original, and likewise at the endpoints of a partial trail.
      const towardExtremes = Math.min(t - r.start, r.end - t) / FEATHER_EXTREMES
      const weight = Math.min(1, seeds + 1 - ad, towardExtremes)
      newOnes.push([j, plane[j] + (background + grain - plane[j]) * weight])
    }
  }
  // Pixels are written at the end: the grain is always read from the original pixels.
  for (const [j, v] of newOnes) plane[j] = v
}
