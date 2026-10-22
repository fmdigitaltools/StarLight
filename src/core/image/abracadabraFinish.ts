import type { FrameMetadata, ImageData32 } from '@shared/types'
import type { StretchParams } from './stretch'
import type { Crop } from '@core/export/crop'
import type { FirstStageMeasurements } from './chain'
import type { WedgeMap } from './wedges'
import { buildGhsLut, automaticGhs, GHS_TARGETS, type GhsTargets, type GhsParams } from './ghs'
import { computeStats, MAD_TO_SIGMA } from './stats'
import { blur } from './cleanup'

/**
 * Last step of Abracadabra, after the chain: stretch, color and cropping of
 * the noisy edges, measured on the already processed image.
 *
 * It lives here, outside the button, because it is used both by Abracadabra
 * on the open image and by batch processing with "Abracadabra on every
 * file": the two paths thus give exactly the same result.
 *
 * The criterion is that of a careful, conservative manual edit:
 * - deep but not absolute black sky (around 0.06), so the faint parts of
 *   the object stay visible; at 0.11 the sky looked gray, without the deep
 *   black of space;
 * - white point at the top of the scale: white belongs to bright stars, not
 *   to the body of the object. Measured on the object, on faint galaxies the
 *   white would fall just above the sky and the galaxy would become a
 *   uniform blotch with a burnt core;
 * - the hyperbolic stretch brings the body of the object slightly above the
 *   sky and keeps the core below 0.82, with a strong penalty;
 * - saturation dosed on the color noise: enough to give the object color
 *   without lighting up colored blotches in the background.
 *
 * If the data arrive already stretched (see `alreadyStretched`) they are not
 * stretched a second time as if they were linear: the black point stays at
 * zero and the sky is only slightly brightened, so the center of the object
 * does not end up in the white.
 */

/** The adjustments Abracadabra decides; the others stay as they are. */
export interface AbracadabraAdjustments {
  stretch: StretchParams
  withGhs: boolean
  ghs: GhsParams
  brightness: number
  contrast: number
  saturation: number
  redGain: number
  greenGain: number
  blueGain: number
  gamma: number
  noiseReduction: number
  sharpness: number
  backgroundNeutralization: number
  preserveColor: boolean
}

export interface AbracadabraFinish {
  adjustments: AbracadabraAdjustments
  /** Crop of the noisy edges, or null if the edges are clean. */
  crop: Crop | null
  /** True if the data were already stretched (see `alreadyStretched`). */
  alreadyStretched: boolean
}

/** Levels wanted after the stretch (see the introduction). */
export const ABRACADABRA_TARGETS: GhsTargets = {
  ...GHS_TARGETS,
  sky: 0.06,
  body: 0.15,
  core: 0.7,
  maxCore: 0.82,
  coreWeight: 20,
  // Gentler than the Correct button: after noise reduction the remaining
  // grain is in blotches, and at 0.08 they stood out in the background more
  // than in the plain stretch on opening (M 44, IC 434).
  maxNoise: 0.05
}

/** Black point: how many sky deviations below its level. */
const BLACK_SIGMA = 2.8

/**
 * Sky wanted when the data arrive already stretched: slightly darker than
 * the 0.11 of linear data, because any brightening of the sky with a curve
 * also brightens the center of the object, which in such data is already
 * high. The choice of the curve may stop lower to protect it.
 */
const SKY_ALREADY_STRETCHED = 0.1
/** Thresholds for recognizing already stretched data (see `alreadyStretched`). */
const THOUSANDTH_THRESHOLD = 0.5
const HUNDREDTH_THRESHOLD = 20

/** Average color wanted for the object (maximum minus minimum channel). */
const OBJECT_CHROMA = 0.06
/** Maximum color tolerated for the background: beyond it, colored grain shows. */
const BACKGROUND_CHROMA = 0.012
/** Maximum saturation that Abracadabra sets. */
const MAX_SATURATION = 0.2

/**
 * True if the file data are surely linear: camera RAW files and stacks
 * written by a telescope (they declare the frames integrated). For them the
 * guess of `alreadyStretched` is skipped: a deep M 42, with its large burnt
 * core, once looked already stretched and was left dark.
 */
export function knownLinear(metadata: FrameMetadata | null | undefined): boolean {
  return !!metadata && (metadata.raw !== undefined || (metadata.stackCount ?? 0) > 0)
}

export function abracadabraFinish(
  image: ImageData32,
  measurements: FirstStageMeasurements | null,
  /** See `knownLinear`. */
  linear = false
): AbracadabraFinish {
  const { width: w, height: h, channels } = image
  const n = w * h
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let t = 0
    for (let c = 0; c < channels; c++) t += image.data[c * n + i]
    lum[i] = t / channels
  }

  // Sky measured on the dark areas of a star-free map (see `lightMap`),
  // noise as the spread of the values: after noise reduction the remaining
  // grain is in wide blotches, which the difference between neighboring
  // pixels does not see, and a black point too close to the sky would turn
  // them into black holes.
  const map = lightMap(lum, w, h)
  const sky = map.sky
  const sigma = computeStats(lum).mad * MAD_TO_SIGMA
  // Already stretched data (see `alreadyStretched`): whoever stretched them
  // has already chosen the black point and the curve. Black stays at zero
  // (raising it to just below the sky would take it almost to black, and the
  // curve to bring it back to 0.11 would push toward white even the center
  // of the object, which is already high) and the sky is only slightly
  // brightened.
  const stretched = !linear && alreadyStretched(lum)
  const black = stretched ? 0 : Math.max(0, sky - BLACK_SIGMA * sigma)
  const white = 1
  const ghs = automaticGhs(image, black, white, {
    ...ABRACADABRA_TARGETS,
    ...(stretched ? { sky: SKY_ALREADY_STRETCHED } : {}),
    linearSky: sky
  })

  const saturation =
    channels === 3 ? dosedSaturation(image, map, { shadows: black, midtones: 0.5, highlights: white }, ghs) : 0

  const adjustments: AbracadabraAdjustments = {
    stretch: { shadows: black, midtones: 0.5, highlights: white },
    withGhs: true,
    ghs,
    brightness: 0,
    contrast: 0,
    saturation,
    redGain: 1,
    greenGain: 1,
    blueGain: 1,
    gamma: 1,
    // Noise and sharpness have already been handled in the data, with masks.
    noiseReduction: 0,
    sharpness: 0,
    backgroundNeutralization: 0,
    // Stretching the channels one by one would leave rings of pure color
    // around bright stars and wash out the object.
    preserveColor: true
  }

  const edges = edgeTrimming(measurements)
  const crop = (measurements?.wedges ? cropWithoutWedges(map, w, h, measurements.wedges, edges) : null) ?? edges
  return { adjustments, crop, alreadyStretched: stretched }
}

/**
 * True if the data have already been stretched, like the "enhanced" images
 * some instruments save next to the linear stack. No header keyword says so,
 * but the distribution of the values does: in a linear stack stars and
 * object occupy few pixels, and even the brightest thousandth stays close to
 * the sky (below 4% of the scale between sky and maximum in most linear
 * stacks measured, but 35% on a deep mosaic of M 42, whose large burnt core
 * fills that thousandth); after a stretch the center of the object and the
 * star disks rise toward white and that thousandth exceeds half the scale
 * (85% on an already stretched image). It is also required that the brightest
 * hundredth be well separated from the sky noise (over 20 deviations
 * against 3-7 in linear stacks), so a linear field with a few saturated
 * stars is not enough to fool the measurement.
 */
export function alreadyStretched(lum: Float32Array): boolean {
  const n = lum.length
  if (n < 1000) return false
  const step = Math.max(1, Math.floor(n / 400000))
  const sample = new Float32Array(Math.floor(n / step))
  for (let i = 0; i < sample.length; i++) sample[i] = lum[i * step]
  sample.sort()
  const q = (p: number): number => sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))]
  const median = q(0.5)
  const max = q(0.9999)
  const s = computeStats(lum)
  const sigma = Math.max(1e-7, s.mad * MAD_TO_SIGMA)
  if (max - median <= 1e-6) return false
  return (q(0.999) - median) / (max - median) > THOUSANDTH_THRESHOLD && (q(0.99) - median) / sigma > HUNDREDTH_THRESHOLD
}

/** Reduced light map, without stars, with the sky level. */
interface LightMap {
  values: Float32Array
  width: number
  height: number
  /** Side of the pixel block of each map element. */
  block: number
  /** Sky level (linear). */
  sky: number
  /** Threshold above which the object is clearly present. */
  object: number
}

/**
 * Copy of the brightness reduced to about 250 thousand elements, each the
 * median of its block (a star does not shift the level), then blurred. The
 * sky is the tenth percentile, leaving out a frame where stacking is less
 * covered: in a galaxy field it is the sky, in one filled by a nebula it is
 * the free areas or dark clouds, which must stay dark gray and not become
 * black (with the image median, the sky of a field filled by a nebula would
 * fall on the nebula). The object is the brightest 3% of the map.
 */
function lightMap(l: Float32Array, w: number, h: number): LightMap {
  const f = Math.max(1, Math.round(Math.sqrt((w * h) / 250000)))
  const wr = Math.max(1, Math.floor(w / f))
  const hr = Math.max(1, Math.floor(h / f))
  const reduced = new Float32Array(wr * hr)
  const block = new Float32Array(f * f)
  for (let y = 0; y < hr; y++) {
    for (let x = 0; x < wr; x++) {
      let k = 0
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) block[k++] = l[(y * f + dy) * w + x * f + dx]
      block.sort()
      reduced[y * wr + x] = block[k >> 1]
    }
  }
  const values = blur(reduced, wr, hr, 3)
  const inner: number[] = []
  const mx = Math.round(wr * 0.08)
  const my = Math.round(hr * 0.08)
  for (let y = my; y < hr - my; y++) for (let x = mx; x < wr - mx; x++) inner.push(values[y * wr + x])
  inner.sort((a, b) => a - b)
  const sky = inner.length > 0 ? inner[Math.floor(inner.length * 0.1)] : computeStats(l).median
  const object = inner.length > 0 ? inner[Math.floor(inner.length * 0.97)] : sky
  return { values, width: wr, height: hr, block: f, sky, object }
}

/**
 * Saturation dosed on the color noise.
 *
 * A sample of pixels is stretched as the rendering will do (stretch that
 * preserves color) and the mean color is measured, as the difference between
 * the strongest and the weakest channel, on the sky background and on the
 * object. Saturation multiplies both: the one chosen is that which brings
 * the object to the wanted color without the background exceeding its
 * limit, beyond which colored grain turns into blotches. On an image with a
 * lot of color noise the saturation stays at zero: the colors are still the
 * true ones, preserved by the stretch.
 */
function dosedSaturation(
  image: ImageData32,
  map: LightMap,
  stretch: StretchParams,
  ghs: GhsParams
): number {
  const { width: w, height: h } = image
  const n = w * h
  const d = image.data
  const lut = buildGhsLut(ghs, 4096)
  const interval = Math.max(1e-6, stretch.highlights - stretch.shadows)
  const step = Math.max(1, Math.floor(n / 400000))
  let backgroundChroma = 0
  let backgroundCount = 0
  let objectChroma = 0
  let objectCount = 0
  const f = map.block
  for (let i = 0; i < n; i += step) {
    const x = Math.min(map.width - 1, Math.floor((i % w) / f))
    const y = Math.min(map.height - 1, Math.floor(Math.floor(i / w) / f))
    const level = map.values[y * map.width + x]
    const background = level <= map.sky
    const object = level >= map.object && map.object > map.sky
    if (!background && !object) continue
    const r = Math.max(0, (d[i] - stretch.shadows) / interval)
    const g = Math.max(0, (d[n + i] - stretch.shadows) / interval)
    const b = Math.max(0, (d[2 * n + i] - stretch.shadows) / interval)
    const l = (r + g + b) / 3
    if (l <= 1e-7) continue
    const t = Math.min(1, l) * (lut.length - 1)
    const j = Math.min(lut.length - 2, Math.floor(t))
    const ld = lut[j] + (lut[j + 1] - lut[j]) * (t - j)
    let k = ld / l
    const max = Math.max(r, g, b) * k
    if (max > 1) k /= max
    // Saturated stars are white by nature: they do not count.
    if (Math.min(r, g, b) * k > 0.95) continue
    // Same mask as the rendering: below 0.02-0.06 the color fades into gray.
    const s = Math.min(1, Math.max(0, (ld - 0.02) / 0.04))
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) * k * s * s * (3 - 2 * s)
    if (background) {
      backgroundChroma += chroma
      backgroundCount++
    } else {
      objectChroma += chroma
      objectCount++
    }
  }
  if (objectCount < 50 || backgroundCount < 50) return 0
  const co = objectChroma / objectCount
  const cf = backgroundChroma / backgroundCount
  const perObject = co > 1e-4 ? OBJECT_CHROMA / co - 1 : MAX_SATURATION
  const perBackground = cf > 1e-4 ? BACKGROUND_CHROMA / cf - 1 : MAX_SATURATION
  const s = Math.min(MAX_SATURATION, perObject, perBackground)
  return Math.round(Math.max(0, s) * 100) / 100
}

/**
 * Crop that removes the noisy edges measured by the first stretch of the
 * chain, or null if the edges are clean (or the measurements are missing).
 */
export function edgeTrimming(measurements: FirstStageMeasurements | null): Crop | null {
  if (!measurements) return null
  const { left, rightSide, top, bottom } = measurements.edges
  if (left + rightSide + top + bottom <= 0.005) return null
  return { x: left, y: top, width: 1 - left - rightSide, height: 1 - top - bottom }
}

/*
 * Cropping the wedges around a small object.
 *
 * After equalizing grain and sky (see wedges.ts), thin lines remain at the
 * boundaries of the field-rotation wedges, already in the stack, that no
 * correction removes completely. When the object is small and central, the
 * field around it is almost all sky and it is worth giving it up: the crop
 * proposal becomes more decisive and leaves the wedges out. It remains a
 * proposal, editable in the Export step, and the data stay whole.
 *
 * The object is found on the star-free light map (see `lightMap`): it is the
 * contiguous area above the median by one map-noise unit, reaching at least
 * four noise units, with its center in the central half of the field and the
 * largest excess light. The low threshold also picks up the faint parts:
 * large galaxies that fill the field often have only the bright core
 * detected at the higher threshold.
 *
 * "Small" means that, measured this way, the object spans no more than half
 * the field in either direction and no more than a tenth of its area.
 * Larger objects keep only the edge crop.
 *
 * The rectangle is chosen like the edge one (see cleanup.ts), on the boxes
 * of the wedge map: each clean box kept is worth 1, each wedge box kept
 * costs as much as twenty clean ones. Only what is needed is thus removed:
 * a wedge is left out if removing it loses less than twenty times its field,
 * and among the rectangles that leave it out the largest wins. The rectangle
 * stays inside the edge one and contains the object with a generous margin:
 * half its side on each side, and at least a tenth of the field. A new side
 * also does not pass within about a hundred pixels of an extended bright
 * area, such as the halo of a bright star, which would otherwise be cut in
 * half.
 *
 * The crop is changed only if the wedges, counting the noisy areas
 * connected to the edge, occupy at least a twentieth of the field; an image
 * without wedges typically measures around 1%.
 */

/** Noise ratio from which a box starts to be a wedge, and from which it fully is. */
const WEDGE_FROM = 1.15
const WEDGE_TO = 1.4
/**
 * Minimum share of the field occupied by wedges, counting only those that
 * touch the edge, for the crop to change.
 */
const WEDGE_SHARE = 0.05
/** How many clean boxes it is worth losing to leave out one wedge box. */
const WEDGE_COST = 20
/** Threshold for the faint parts of the object and for its core, in map noise units above the median. */
const FAINT_THRESHOLD = 1
const CORE_THRESHOLD = 4
/** Small object: maximum side and maximum area, as fractions of the field. */
const SMALL_SIDE = 0.5
const SMALL_AREA = 0.1
/** Margin around the object: fraction of its side, and minimum as a fraction of the field. */
const OBJECT_MARGIN = 0.5
const MIN_MARGIN = 0.1

/**
 * Distance, in boxes, that a new side of the crop keeps from a bright area:
 * the halo of a bright star extends beyond the box in which the map sees it.
 */
const BRIGHT_DISTANCE = 3
/** Boxes a bright area must occupy to count (a bright star takes about forty). */
const BRIGHT_AREA = 16

/** Rectangle in fractions of the field, from x0 to x1 and from y0 to y1. */
interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}

/**
 * Bright areas on the boxes of the wedge map, widened by `BRIGHT_DISTANCE`
 * boxes: groups of at least `BRIGHT_AREA` contiguous boxes in which, over at
 * least a quarter of the box, the star-free light map exceeds the median by
 * `CORE_THRESHOLD` noise units. They are the halo of a bright star, another
 * nebula, a nearby galaxy; not ordinary medium stars, which are smaller (on
 * small images the reduced map does not remove them completely).
 */
function brightBoxes(
  map: LightMap,
  columns: number,
  rows: number,
  side: number,
  wedge: Float32Array
): Uint8Array {
  const { values, width: wr, height: hr, block: f } = map
  const s = computeStats(values)
  const threshold = s.median + CORE_THRESHOLD * s.mad * MAD_TO_SIGMA
  const above = new Uint16Array(columns * rows)
  const count = new Uint16Array(columns * rows)
  for (let y = 0; y < hr; y++) {
    const ry = Math.min(rows - 1, Math.floor((y * f) / side))
    for (let x = 0; x < wr; x++) {
      const b = ry * columns + Math.min(columns - 1, Math.floor((x * f) / side))
      count[b]++
      if (values[y * wr + x] > threshold) above[b]++
    }
  }
  // Nothing is protected in the wedges: they are the areas to remove, and
  // their sky may stay slightly different.
  // Bright areas at least `BRIGHT_AREA` boxes large: medium stars, of one or
  // a few boxes, can be cut like the sky.
  const raw = new Uint8Array(columns * rows)
  for (let b = 0; b < raw.length; b++) raw[b] = 4 * above[b] > count[b] && wedge[b] <= 0.5 ? 1 : 0
  const large = new Uint8Array(columns * rows)
  const seen = new Uint8Array(columns * rows)
  const stack: number[] = []
  const zone: number[] = []
  for (let b0 = 0; b0 < raw.length; b0++) {
    if (!raw[b0] || seen[b0]) continue
    seen[b0] = 1
    stack.push(b0)
    zone.length = 0
    while (stack.length > 0) {
      const b = stack.pop() as number
      zone.push(b)
      const x = b % columns
      const y = (b - x) / columns
      const neighbors = [x > 0 ? b - 1 : -1, x < columns - 1 ? b + 1 : -1, y > 0 ? b - columns : -1, y < rows - 1 ? b + columns : -1]
      for (const v of neighbors) {
        if (v >= 0 && raw[v] && !seen[v]) {
          seen[v] = 1
          stack.push(v)
        }
      }
    }
    if (zone.length >= BRIGHT_AREA) for (const b of zone) large[b] = 1
  }
  const k = BRIGHT_DISTANCE
  const bright = new Uint8Array(columns * rows)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      if (!large[y * columns + x]) continue
      for (let yy = Math.max(0, y - k); yy <= Math.min(rows - 1, y + k); yy++) {
        for (let xx = Math.max(0, x - k); xx <= Math.min(columns - 1, x + k); xx++) bright[yy * columns + xx] = 1
      }
    }
  }
  return bright
}

/**
 * Main object on the light map (see above), or null if there is no object
 * at the center of the field.
 */
function mainObject(map: LightMap): Box | null {
  const { values, width: wr, height: hr } = map
  const s = computeStats(values)
  const sigma = s.mad * MAD_TO_SIGMA
  if (!(sigma > 0)) return null
  const faint = s.median + FAINT_THRESHOLD * sigma
  const core = s.median + CORE_THRESHOLD * sigma
  const seen = new Uint8Array(wr * hr)
  const stack: number[] = []
  let best: Box | null = null
  let bestExcess = 0
  for (let i = 0; i < wr * hr; i++) {
    if (seen[i] || values[i] <= faint) continue
    seen[i] = 1
    stack.push(i)
    let x0 = wr
    let x1 = -1
    let y0 = hr
    let y1 = -1
    let excess = 0
    let peak = -Infinity
    while (stack.length > 0) {
      const j = stack.pop() as number
      const x = j % wr
      const y = (j - x) / wr
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      excess += values[j] - s.median
      if (values[j] > peak) peak = values[j]
      const neighbors = [x > 0 ? j - 1 : -1, x < wr - 1 ? j + 1 : -1, y > 0 ? j - wr : -1, y < hr - 1 ? j + wr : -1]
      for (const v of neighbors) {
        if (v >= 0 && !seen[v] && values[v] > faint) {
          seen[v] = 1
          stack.push(v)
        }
      }
    }
    const cx = (x0 + x1 + 1) / 2 / wr
    const cy = (y0 + y1 + 1) / 2 / hr
    if (peak < core || cx < 0.25 || cx > 0.75 || cy < 0.25 || cy > 0.75) continue
    if (excess > bestExcess) {
      bestExcess = excess
      best = { x0: x0 / wr, x1: (x1 + 1) / wr, y0: y0 / hr, y1: (y1 + 1) / hr }
    }
  }
  return best
}

/**
 * Crop that leaves out the wedges around a small, central object (see
 * above), or null if it does not apply: no wedges, large or off-center
 * object, or no gain over the edge crop.
 */
function cropWithoutWedges(
  map: LightMap,
  w: number,
  h: number,
  wedges: WedgeMap,
  edges: Crop | null
): Crop | null {
  const { columns, rows, side, ratio } = wedges
  // A plugin may have changed the dimensions: the map is no longer valid.
  if (Math.floor(w / side) !== columns || Math.floor(h / side) !== rows || ratio.length !== columns * rows) {
    return null
  }
  const weight = new Float32Array(columns * rows)
  for (let b = 0; b < weight.length; b++) {
    const t = Math.min(1, Math.max(0, (ratio[b] - WEDGE_FROM) / (WEDGE_TO - WEDGE_FROM)))
    weight[b] = t * t * (3 - 2 * t)
  }
  // Wedges arise from the edges of the rotating frames: the noisy areas
  // connected to the edge count. Isolated blotches in the field (a nebula
  // rich in detail, a star) are not enough to change the crop.
  const linked = new Uint8Array(weight.length)
  const stack: number[] = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const b = y * columns + x
      if ((x === 0 || y === 0 || x === columns - 1 || y === rows - 1) && weight[b] > 0.5) {
        linked[b] = 1
        stack.push(b)
      }
    }
  }
  let inWedge = stack.length
  while (stack.length > 0) {
    const b = stack.pop() as number
    const x = b % columns
    const y = (b - x) / columns
    const neighbors = [x > 0 ? b - 1 : -1, x < columns - 1 ? b + 1 : -1, y > 0 ? b - columns : -1, y < rows - 1 ? b + columns : -1]
    for (const v of neighbors) {
      if (v >= 0 && !linked[v] && weight[v] > 0.5) {
        linked[v] = 1
        inWedge++
        stack.push(v)
      }
    }
  }
  if (inWedge < WEDGE_SHARE * weight.length) return null

  const object = mainObject(map)
  if (object === null) return null
  const lw = object.x1 - object.x0
  const lh = object.y1 - object.y0
  if (lw > SMALL_SIDE || lh > SMALL_SIDE || lw * lh > SMALL_AREA) return null
  const mx = Math.max(OBJECT_MARGIN * lw, MIN_MARGIN)
  const my = Math.max(OBJECT_MARGIN * lh, MIN_MARGIN)

  // Boundaries between boxes as fractions of the field; the last one reaches
  // the edge (pixels beyond the last whole box go with it).
  const boundaryX = (i: number): number => (i >= columns ? 1 : (i * side) / w)
  const boundaryY = (j: number): number => (j >= rows ? 1 : (j * side) / h)
  const base = edges ?? { x: 0, y: 0, width: 1, height: 1 }
  const e = 1e-9
  let sMin = 0
  while (sMin < columns && boundaryX(sMin) < base.x - e) sMin++
  let dMax = columns
  while (dMax > sMin && boundaryX(dMax) > base.x + base.width + e) dMax--
  let aMin = 0
  while (aMin < rows && boundaryY(aMin) < base.y - e) aMin++
  let bMax = rows
  while (bMax > aMin && boundaryY(bMax) > base.y + base.height + e) bMax--
  // How far one can cut without touching the object with its margin.
  let sMax = sMin
  while (sMax + 1 < dMax && boundaryX(sMax + 1) <= object.x0 - mx) sMax++
  let dMin = dMax
  while (dMin - 1 > sMax && boundaryX(dMin - 1) >= object.x1 + mx) dMin--
  let aMax = aMin
  while (aMax + 1 < bMax && boundaryY(aMax + 1) <= object.y0 - my) aMax++
  let bMin = bMax
  while (bMin - 1 > aMax && boundaryY(bMin - 1) >= object.y1 + my) bMin--

  // A new side must not pass through the middle of a bright area (the halo
  // of a bright star, another nebula): it would cut it in half.
  // Bright boxes: the star-free map exceeds the median by four noise units
  // there, like the core of the object.
  const bright = brightBoxes(map, columns, rows, side, weight)
  const L = columns + 1
  const R = rows + 1
  // crossesV[s * R + y]: rows up to y in which a vertical cut at boundary s
  // separates two bright boxes; crossesH the same for horizontal cuts,
  // column by column.
  const crossesV = new Int32Array(L * R)
  for (let x = 1; x < columns; x++) {
    for (let y = 0; y < rows; y++) {
      const t = bright[y * columns + x - 1] && bright[y * columns + x] ? 1 : 0
      crossesV[x * R + y + 1] = crossesV[x * R + y] + t
    }
  }
  const crossesH = new Int32Array(R * L)
  for (let y = 1; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const t = bright[(y - 1) * columns + x] && bright[y * columns + x] ? 1 : 0
      crossesH[y * L + x + 1] = crossesH[y * L + x] + t
    }
  }
  const cutVertical = (x: number, a: number, b: number): boolean => crossesV[x * R + b] - crossesV[x * R + a] > 0
  const cutHorizontal = (y: number, s: number, d: number): boolean => crossesH[y * L + d] - crossesH[y * L + s] > 0

  // Cumulative sums: the value of a rectangle in four reads.
  const sum = new Float64Array(L * R)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const v = 1 - (1 + WEDGE_COST) * weight[y * columns + x]
      sum[(y + 1) * L + x + 1] = v + sum[y * L + x + 1] + sum[(y + 1) * L + x] - sum[y * L + x]
    }
  }
  const value = (s: number, d: number, a: number, b: number): number =>
    sum[b * L + d] - sum[a * L + d] - sum[b * L + s] + sum[a * L + s]
  let best = value(sMin, dMax, aMin, bMax)
  let choice = [sMin, dMax, aMin, bMax]
  for (let s = sMin; s <= sMax; s++) {
    for (let d = dMin; d <= dMax; d++) {
      for (let a = aMin; a <= aMax; a++) {
        for (let b = bMin; b <= bMax; b++) {
          const v = value(s, d, a, b)
          if (v <= best + e) continue
          if (
            (s !== sMin && cutVertical(s, a, b)) ||
            (d !== dMax && cutVertical(d, a, b)) ||
            (a !== aMin && cutHorizontal(a, s, d)) ||
            (b !== bMax && cutHorizontal(b, s, d))
          ) {
            continue
          }
          best = v
          choice = [s, d, a, b]
        }
      }
    }
  }
  const [s, d, a, b] = choice
  if (s === sMin && d === dMax && a === aMin && b === bMax) return null
  // Where no further cut is made, the boundary of the edge crop remains.
  const x0 = s === sMin ? base.x : boundaryX(s)
  const x1 = d === dMax ? base.x + base.width : boundaryX(d)
  const y0 = a === aMin ? base.y : boundaryY(a)
  const y1 = b === bMax ? base.y + base.height : boundaryY(b)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
