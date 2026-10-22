import type { ImageData32 } from '@shared/types'
import { computeStats, MAD_TO_SIGMA } from '@core/image/stats'
import { toLuminance } from '@core/image/debayer'

/**
 * Star detection.
 *
 * It serves two purposes: measuring the quality of each frame (a wider
 * star means worse focus or turbulence) and providing the reference points
 * used to align images with one another.
 *
 * The method is the classic one: the sky background level is estimated
 * zone by zone, pixels exceeding it by a few local noise deviations become
 * candidates, contiguous candidates are grouped, and the center of each
 * group is computed by weighting positions with the collected light; the
 * flux is then measured in an aperture around the center.
 */

export interface Star {
  /** Center position, with sub-pixel precision. */
  x: number
  y: number
  /** Total light collected in an aperture around the center, background subtracted. */
  flux: number
  /** Value of the brightest pixel. */
  peak: number
  /** Radius containing half of the light (half-flux radius): a measure of focus. */
  hfr: number
  /** Number of pixels in the group. */
  pixel: number
}

export interface DetectionParams {
  /** How many deviations above the background for a pixel to be considered. */
  threshold: number
  /** Minimum pixels for a group to count as a star rather than noise. */
  minPixels: number
  /** Maximum pixels: larger groups are nebulae or defects. */
  maxPixels: number
  /** Maximum number of stars returned, the brightest ones. */
  max: number
}

export const DEFAULT_DETECTION: DetectionParams = {
  threshold: 5,
  minPixels: 4,
  maxPixels: 600,
  max: 500
}

/**
 * Radius enclosing half of the group's flux, computed by sorting the
 * pixels by distance from the center.
 */
function computeHfr(
  points: { x: number; y: number; value: number }[],
  cx: number,
  cy: number,
  flux: number
): number {
  if (flux <= 0) return 0

  const sortedItems = points
    .map((p) => ({ distance: Math.hypot(p.x - cx, p.y - cy), value: p.value }))
    .sort((a, b) => a.distance - b.distance)

  const meta = flux / 2
  let accumulated = 0
  for (const p of sortedItems) {
    accumulated += p.value
    if (accumulated >= meta) return Math.max(0.5, p.distance)
  }
  return sortedItems[sortedItems.length - 1]?.distance ?? 0
}

/** Approximate side, in pixels, of the cells on which local background and noise are estimated. */
const BACKGROUND_CELL_SIDE = 64

/** Maximum samples per cell: enough for the median and the dispersion. */
const SAMPLES_PER_CELL = 1024

/**
 * Sky background and noise measured per cell: a grid of values, one per
 * cell, to be interpolated between cell centers.
 */
interface BackgroundMap {
  columns: number
  rows: number
  background: Float32Array
  noise: Float32Array
}

/**
 * Median of the first `count` elements of `data`, found by partitioning
 * without a full sort (reorders the array in place). With thousands of
 * cells per image a full sort would cost almost a second; selection costs
 * a small fraction of that.
 */
function median(data: Float32Array, count: number): number {
  const k = count >> 1
  let lo = 0
  let hi = count - 1
  while (lo < hi) {
    const pivot = data[(lo + hi) >> 1]
    let lt = lo
    let gt = hi
    let i = lo
    while (i <= gt) {
      const v = data[i]
      if (v < pivot) {
        data[i] = data[lt]
        data[lt] = v
        lt++
        i++
      } else if (v > pivot) {
        data[i] = data[gt]
        data[gt] = v
        gt--
      } else {
        i++
      }
    }
    if (k < lt) hi = lt - 1
    else if (k > gt) lo = gt + 1
    else return data[k]
  }
  return data[k]
}

/**
 * Background and noise of a cell: median and robust dispersion of a
 * regular sample of its pixels, repeated once after removing whatever
 * deviates by more than three deviations (mostly stars). Pixels exactly at
 * zero lie outside the covered field (edges of a stack or mosaic) and are
 * left out of the count: if they make up nearly the whole cell, the cell
 * is left without a measurement (NaN).
 */
function measureCell(
  plane: Float32Array,
  w: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  samples: Float32Array,
  rejections: Float32Array
): { background: number; noise: number } {
  const area = (x1 - x0) * (y1 - y0)
  const step = Math.max(1, Math.ceil(Math.sqrt(area / SAMPLES_PER_CELL)))
  let count = 0
  let totals = 0
  for (let y = y0; y < y1; y += step) {
    const base = y * w
    for (let x = x0; x < x1; x += step) {
      totals++
      const v = plane[base + x]
      if (v !== 0 && v === v) samples[count++] = v
    }
  }
  if (count < 16 || count < totals * 0.3) return { background: NaN, noise: NaN }

  let background = median(samples, count)
  let noise = 0
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count; i++) rejections[i] = Math.abs(samples[i] - background)
    noise = median(rejections, count) * MAD_TO_SIGMA
    if (pass === 1 || noise <= 0) break
    // Drop the tails (stars, hot pixels) and measure again.
    const bottom = background - 3 * noise
    const top = background + 3 * noise
    let kept = 0
    for (let i = 0; i < count; i++) {
      const v = samples[i]
      if (v >= bottom && v <= top) samples[kept++] = v
    }
    if (kept < 16) break
    count = kept
    background = median(samples, count)
  }
  return { background, noise }
}

/** Median of the valid (non-NaN) values of a list; NaN if there are none. */
function medianOfValid(v: number[]): number {
  const validItems = v.filter((x) => x === x).sort((a, b) => a - b)
  return validItems.length === 0 ? NaN : validItems[validItems.length >> 1]
}

/**
 * Estimates local background and noise of a plane, cell by cell.
 *
 * The background of a frame is not uniform: thin cloud, haze, light
 * pollution and the Moon raise it more on one side than on the other, and
 * nebulae lift wide areas of it. A single threshold computed over the
 * whole image would end up measuring these gradients instead of the noise:
 * the dispersion would grow, the threshold would rise, and in hazy frames
 * precisely most stars would vanish. With background and noise measured in
 * cells of about 64 pixels the threshold follows the sky zone by zone.
 *
 * After measurement each cell takes the median of itself and its eight
 * neighbors: a cell mostly occupied by a bright star or a nebula knot
 * would otherwise stay too high and hide the surrounding stars. Cells
 * without a measurement take the typical value of the others.
 */
function estimateBackgroundMap(
  plane: Float32Array,
  w: number,
  h: number,
  side = BACKGROUND_CELL_SIDE
): BackgroundMap | null {
  const columns = Math.max(1, Math.round(w / side))
  const rows = Math.max(1, Math.round(h / side))
  const cells = columns * rows
  const rawBackground: number[] = new Array(cells)
  const rawNoise: number[] = new Array(cells)
  const size = Math.ceil(w / columns + 1) * Math.ceil(h / rows + 1)
  const samples = new Float32Array(size)
  const rejections = new Float32Array(size)

  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * h) / rows)
    const y1 = Math.floor(((r + 1) * h) / rows)
    for (let c = 0; c < columns; c++) {
      const x0 = Math.floor((c * w) / columns)
      const x1 = Math.floor(((c + 1) * w) / columns)
      const m = measureCell(plane, w, x0, x1, y0, y1, samples, rejections)
      rawBackground[r * columns + c] = m.background
      rawNoise[r * columns + c] = m.noise
    }
  }

  const typicalBackground = medianOfValid(rawBackground)
  if (typicalBackground !== typicalBackground) return null
  const typicalNoise = medianOfValid(rawNoise)
  for (let i = 0; i < cells; i++) {
    if (rawBackground[i] !== rawBackground[i]) {
      rawBackground[i] = typicalBackground
      rawNoise[i] = typicalNoise
    }
  }

  // Value of a cell, including just outside the grid: there the slope of
  // the last two cells is continued, as if the image went on. This way the
  // median of the edge cells does not flatten a tilted background.
  const cell = (g: number[], r: number, c: number): number => {
    if (c < 0) return columns > 1 ? 2 * cell(g, r, 0) - cell(g, r, 1) : cell(g, r, 0)
    if (c >= columns) return columns > 1 ? 2 * cell(g, r, columns - 1) - cell(g, r, columns - 2) : cell(g, r, columns - 1)
    if (r < 0) return rows > 1 ? 2 * g[c] - g[columns + c] : g[c]
    if (r >= rows) return rows > 1 ? 2 * g[(rows - 1) * columns + c] - g[(rows - 2) * columns + c] : g[(rows - 1) * columns + c]
    return g[r * columns + c]
  }

  // Median over the cell and its neighbors.
  const background = new Float32Array(cells)
  const noise = new Float32Array(cells)
  const neighborsF: number[] = []
  const neighborsR: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      neighborsF.length = 0
      neighborsR.length = 0
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          neighborsF.push(cell(rawBackground, r + dr, c + dc))
          neighborsR.push(Math.max(0, cell(rawNoise, r + dr, c + dc)))
        }
      }
      background[r * columns + c] = medianOfValid(neighborsF)
      noise[r * columns + c] = medianOfValid(neighborsR)
    }
  }
  return { columns, rows, background, noise }
}

/**
 * Value of the map at point (x, y), interpolated between the centers of
 * the four nearest cells.
 */
function mapValue(
  grid: Float32Array,
  columns: number,
  rows: number,
  w: number,
  h: number,
  x: number,
  y: number
): number {
  // Between the center of the last cell and the image edge the same slope
  // is continued instead of stopping: with a tilted background, a constant
  // value would leave a positive residual along the edges, inflating the
  // flux of stars near the edge.
  const gx = columns > 1 ? ((x + 0.5) * columns) / w - 0.5 : 0
  const gy = rows > 1 ? ((y + 0.5) * rows) / h - 0.5 : 0
  const c0 = columns > 1 ? Math.min(columns - 2, Math.max(0, Math.floor(gx))) : 0
  const r0 = rows > 1 ? Math.min(rows - 2, Math.max(0, Math.floor(gy))) : 0
  const c1 = columns > 1 ? c0 + 1 : c0
  const r1 = rows > 1 ? r0 + 1 : r0
  const fx = gx - c0
  const fy = gy - r0
  const top = grid[r0 * columns + c0] + (grid[r0 * columns + c1] - grid[r0 * columns + c0]) * fx
  const bottom = grid[r1 * columns + c0] + (grid[r1 * columns + c1] - grid[r1 * columns + c0]) * fx
  return top + (bottom - top) * fy
}

/** Minimum radius, in pixels, of the aperture on which flux is measured. */
const APERTURE_RADIUS = 5

/**
 * Flux of a star in a circular aperture around the center.
 *
 * The group of pixels above the threshold contains only the core of the
 * star, and how much of it depends on the threshold: in a hazy frame, with
 * higher noise, the group shrinks and its flux drops more for wide stars
 * than for compact ones. The brightness ranking would then change from one
 * frame to another, and alignment, which uses the brightest stars, would
 * not find the same ones. The aperture has the same radius in all frames
 * (larger only for big stars, which stay at the top anyway) and measures
 * the whole star.
 */
function apertureFlux(
  residual: (index: number) => number,
  w: number,
  h: number,
  cx: number,
  cy: number,
  groupPixels: number,
  groupFlux: number
): number {
  const radius = Math.max(APERTURE_RADIUS, Math.sqrt(groupPixels / Math.PI) + 1)
  const r2 = radius * radius
  const x0 = Math.max(0, Math.floor(cx - radius))
  const x1 = Math.min(w - 1, Math.ceil(cx + radius))
  const y0 = Math.max(0, Math.floor(cy - radius))
  const y1 = Math.min(h - 1, Math.ceil(cy + radius))
  let sum = 0
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx
      if (dx * dx + dy * dy <= r2) sum += residual(y * w + x)
    }
  }
  // Noise can make the aperture poorer than the core itself.
  return sum > groupFlux ? sum : groupFlux
}

/**
 * Recognizes a hot pixel (or a cosmic ray) in a color image reconstructed
 * from a sensor with a Bayer matrix.
 *
 * The defect affects a single photosite, which records a single color:
 * after interpolation, at the brightest point only that channel is high,
 * while the other two stay at background level. A real star, even a very
 * red or very blue one, lights up all three channels instead. Without this
 * check, on uncalibrated raw frames from an uncooled sensor (32 °C, no
 * dark) hot pixels would enter the brightest stars as soon as the sky gets
 * hazy, and alignment, which looks for stars at different positions from
 * frame to frame while hot pixels stay put, would fail on good frames.
 *
 * The check triggers only if the lit channel exceeds the noise by a wide
 * margin, so faint stars, whose minor channels blend into the background,
 * are left alone.
 */
function hotPixel(
  data: Float32Array,
  w: number,
  h: number,
  index: number,
  channels: BackgroundMap[]
): boolean {
  const n = w * h
  const x = index % w
  const y = (index - x) / w
  let first = 0
  let second = 0
  let firstSigma = 0
  let firstChannel = 0
  let firstBackground = 0
  for (let c = 0; c < 3; c++) {
    // Background and noise of the channel at that point: with a sloped
    // background, the whole-image values would be badly off at the edges.
    const m = channels[c]
    const background = mapValue(m.background, m.columns, m.rows, w, h, x, y)
    const noise = Math.max(1e-6, mapValue(m.noise, m.columns, m.rows, w, h, x, y))
    const excess = data[c * n + index] - background
    if (excess > first) {
      second = first
      first = excess
      firstSigma = excess / noise
      firstChannel = c
      firstBackground = background
    } else if (excess > second) {
      second = excess
    }
  }
  if (firstSigma > 12 && second < first * 0.15) return true
  if (firstSigma <= 4) return false

  // Second check, on shape: in the lit channel, photosites of the same
  // color two pixels away (those actually measured, not reconstructed from
  // neighbors) stay at background level around a hot pixel, whereas a star,
  // which spreads over several pixels, still lights up a fifth or a quarter
  // of it. This is for warm pixels, not strong enough for the color check:
  // with the threshold set by local noise, lower on hazy frames, they would
  // get in by the dozen.
  const base = firstChannel * n
  let sum = 0
  let count = 0
  if (x >= 2) {
    sum += data[base + index - 2]
    count++
  }
  if (x + 2 < w) {
    sum += data[base + index + 2]
    count++
  }
  if (y >= 2) {
    sum += data[base + index - 2 * w]
    count++
  }
  if (y + 2 < h) {
    sum += data[base + index + 2 * w]
    count++
  }
  if (count === 0) return false
  return sum / count - firstBackground < first * 0.12
}

/**
 * Detects the stars in an image. It works on luminance, so the result does
 * not depend on color.
 *
 * @param luminance the image luminance (`toLuminance`), if the caller has
 * already computed it for other purposes: it is only read, which avoids
 * computing it again.
 */
export function detectStars(
  image: ImageData32,
  parameters: Partial<DetectionParams> = {},
  luminance: Float32Array = toLuminance(image)
): Star[] {
  const p = { ...DEFAULT_DETECTION, ...parameters }
  const w = image.width
  const h = image.height

  // Local background and noise (see `estimateBackgroundMap`): each pixel is
  // compared with the background at its position, and the light exceeding
  // it (the residual) with a limit proportional to the noise at that
  // position, not to that of the whole image.
  const pixelCount = w * h
  const map = estimateBackgroundMap(luminance, w, h)
  if (map === null) return []

  // A floor for the noise. With a noise-free background (synthetic images)
  // the dispersion vanishes everywhere: a fraction of the image standard
  // deviation is then used. Otherwise the floor is a fraction of the
  // typical noise, so that a flat zone (for example a burned-out one) does
  // not drive the threshold down to zero.
  const typicalNoise = medianOfValid(Array.from(map.noise))
  let minNoise: number
  if (typicalNoise > 1e-7) {
    minNoise = typicalNoise * 0.25
  } else {
    const stats = computeStats(luminance)
    const sigma = stats.mad * MAD_TO_SIGMA
    minNoise = sigma > 1e-7 ? sigma : Math.max(1e-6, stats.stdDev * 0.5)
  }

  // Same interpolation as `mapValue`, but row by row: cells are
  // interpolated first along the vertical, then along the row, with column
  // positions and weights computed only once.
  const { columns, rows } = map
  const columnX = new Int32Array(w)
  const weightX = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const gx = columns > 1 ? ((x + 0.5) * columns) / w - 0.5 : 0
    const c0 = columns > 1 ? Math.min(columns - 2, Math.max(0, Math.floor(gx))) : 0
    columnX[x] = c0
    weightX[x] = gx - c0
  }
  const backgroundRow = new Float32Array(columns + 1)
  const noiseRow = new Float32Array(columns + 1)
  // For each pixel it is enough to know whether it exceeds the limit
  // (bit 0) and whether it has already been visited (bit 1): one byte
  // instead of two floating-point planes, which on large sensors weigh
  // hundreds of megabytes per worker. The residual is needed only at star
  // pixels and in apertures, and there it is recomputed (`residualIn`) with
  // the same operations and the same rounding as the pass below.
  const ABOVE = 1
  const VISITED = 2
  const state = new Uint8Array(pixelCount)
  for (let y = 0; y < h; y++) {
    const gy = rows > 1 ? ((y + 0.5) * rows) / h - 0.5 : 0
    const r0 = rows > 1 ? Math.min(rows - 2, Math.max(0, Math.floor(gy))) : 0
    const r1 = rows > 1 ? r0 + 1 : r0
    const fy = gy - r0
    for (let c = 0; c < columns; c++) {
      const f0 = map.background[r0 * columns + c]
      const n0 = map.noise[r0 * columns + c]
      backgroundRow[c] = f0 + (map.background[r1 * columns + c] - f0) * fy
      noiseRow[c] = n0 + (map.noise[r1 * columns + c] - n0) * fy
    }
    // With a single column the "next" one is the same column.
    backgroundRow[columns] = backgroundRow[columns - 1]
    noiseRow[columns] = noiseRow[columns - 1]
    const base = y * w
    for (let x = 0; x < w; x++) {
      const c0 = columnX[x]
      const fx = weightX[x]
      const background = backgroundRow[c0] + (backgroundRow[c0 + 1] - backgroundRow[c0]) * fx
      const noise = noiseRow[c0] + (noiseRow[c0 + 1] - noiseRow[c0]) * fx
      const residual = Math.fround(luminance[base + x] - background)
      const limit = Math.fround(p.threshold * (noise > minNoise ? noise : minNoise))
      if (!(residual <= limit)) state[base + x] = ABOVE
    }
  }

  // Background interpolated vertically in cell column `c`, at row `y`: the
  // same value that the pass above stores in `backgroundRow`.
  const columnBackground = (y: number, c: number): number => {
    const gy = rows > 1 ? ((y + 0.5) * rows) / h - 0.5 : 0
    const r0 = rows > 1 ? Math.min(rows - 2, Math.max(0, Math.floor(gy))) : 0
    const r1 = rows > 1 ? r0 + 1 : r0
    const fy = gy - r0
    const f0 = map.background[r0 * columns + c]
    return Math.fround(f0 + (map.background[r1 * columns + c] - f0) * fy)
  }
  /** Light of the pixel above the local background, identical to that of the pass above. */
  const residualIn = (index: number): number => {
    const x = index % w
    const y = (index - x) / w
    const c0 = columnX[x]
    const a = columnBackground(y, c0)
    const b = columns > 1 ? columnBackground(y, c0 + 1) : a
    return Math.fround(luminance[index] - (a + (b - a) * weightX[x]))
  }

  // Local background and noise of each channel, to recognize hot pixels.
  // Larger cells are enough here: the check only needs to know whether one
  // channel stands far above the others.
  const perChannel =
    image.channels === 3
      ? [0, 1, 2].map((c) =>
          estimateBackgroundMap(image.data.subarray(c * pixelCount, (c + 1) * pixelCount), w, h, BACKGROUND_CELL_SIDE * 2)
        )
      : null
  const channelMaps =
    perChannel !== null && perChannel.every((m) => m !== null) ? (perChannel as BackgroundMap[]) : null

  const stars: Star[] = []

  // Explicit stack instead of recursion: a group can contain thousands of
  // pixels and the call stack would not suffice.
  const stack = new Int32Array(p.maxPixels * 4 + 64)

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const index = y * w + x
      if (state[index] !== ABOVE) continue

      let top = 0
      stack[top++] = index
      state[index] |= VISITED

      const points: { x: number; y: number; value: number }[] = []
      let weightSum = 0
      let sumX = 0
      let sumY = 0
      let peak = 0
      let peakIndex = index
      let tooLarge = false

      while (top > 0) {
        const current = stack[--top]
        const cx = current % w
        const cy = (current - cx) / w
        const value = residualIn(current)

        points.push({ x: cx, y: cy, value })
        weightSum += value
        sumX += cx * value
        sumY += cy * value
        if (luminance[current] > peak) {
          peak = luminance[current]
          peakIndex = current
        }

        if (points.length > p.maxPixels) {
          tooLarge = true
          break
        }

        // Neighbors in the eight directions.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            const neighbor = ny * w + nx
            if (state[neighbor] !== ABOVE) continue
            state[neighbor] |= VISITED
            if (top < stack.length) stack[top++] = neighbor
          }
        }
      }

      if (tooLarge || points.length < p.minPixels || weightSum <= 0) continue
      if (channelMaps !== null && hotPixel(image.data, w, h, peakIndex, channelMaps)) continue

      const centerX = sumX / weightSum
      const centerY = sumY / weightSum

      stars.push({
        x: centerX,
        y: centerY,
        flux: apertureFlux(residualIn, w, h, centerX, centerY, points.length, weightSum),
        peak,
        hfr: computeHfr(points, centerX, centerY, weightSum),
        pixel: points.length
      })
    }
  }

  stars.sort((a, b) => b.flux - a.flux)
  return stars.slice(0, p.max)
}

/** Quality measurements derived from the detected stars. */
export interface FrameQuality {
  /** Number of detected stars. */
  starCount: number
  /** Median half-flux radius: the smaller, the sharper the frame. */
  medianHfr: number
  /** Ratio between the star flux and the background noise. */
  signalToNoiseRatio: number
  /** Overall score from 0 to 100. */
  score: number
}

/**
 * Evaluates a frame from its stars. The score rewards frames with many
 * sharp stars: frames that are trailed, out of focus or veiled by clouds
 * show fewer and wider ones.
 */
export function evaluateQuality(stars: Star[], backgroundNoise: number): FrameQuality {
  if (stars.length === 0) {
    return { starCount: 0, medianHfr: 0, signalToNoiseRatio: 0, score: 0 }
  }

  const sortedHfr = stars.map((s) => s.hfr).sort((a, b) => a - b)
  const medianHfr = sortedHfr[Math.floor(sortedHfr.length / 2)]

  const medianFlux = stars
    .map((s) => s.flux)
    .sort((a, b) => a - b)[Math.floor(stars.length / 2)]
  const snr = backgroundNoise > 0 ? medianFlux / backgroundNoise : 0

  // The score combines star count and sharpness. The reference values
  // correspond to a good-quality frame from a small, short-focal-length
  // telescope.
  const starPoints = Math.min(1, stars.length / 220)
  const sharpnessPoints = medianHfr > 0 ? Math.min(1, 3.2 / medianHfr) : 0
  const score = Math.round((starPoints * 0.45 + sharpnessPoints * 0.55) * 100)

  return {
    starCount: stars.length,
    medianHfr,
    signalToNoiseRatio: snr,
    score: Math.max(0, Math.min(100, score))
  }
}

/** The two measurements of a frame needed for comparison with the session. */
export interface SessionMeasurement {
  starCount: number
  medianHfr: number
}

/** Value of the sorted list at fraction `q` (0 the lowest, 1 the highest). */
function percentile(sortedItems: number[], q: number): number {
  return sortedItems[Math.round(q * (sortedItems.length - 1))]
}

/**
 * Session-relative quality score, from 0 to 100: how close a frame comes
 * to the best ones of the same imaging run.
 *
 * The absolute score of `evaluateQuality` depends on telescope, field and
 * exposure time: on a star-rich field even frames veiled by clouds exceed
 * the absolute thresholds. By comparing each frame with the others of the
 * same session the scale holds for any instrument: 100 is a frame as good
 * as the best ones, 50 one that sees half of their stars or has them twice
 * as wide.
 *
 * The score is the product of two ratios, each at most 1:
 * - detected stars relative to the 90th percentile of the session. Clouds
 *   extinguish faint stars, so the count drops immediately. The percentile
 *   is used rather than the maximum so that a single exceptional frame does
 *   not pull all the others down;
 * - the 10th-percentile HFR of the session divided by the frame's own: a
 *   trailed or out-of-focus frame has wider stars. Here too the minimum is
 *   not used, because hazy frames, where only the brightest and most
 *   compact stars remain, sometimes have the smallest HFR of all.
 *
 * Results are in the order of the measurements received.
 */
export function relativeQuality(measurements: SessionMeasurement[]): number[] {
  const withStars = measurements.filter((m) => m.starCount > 0 && m.medianHfr > 0)
  if (withStars.length === 0) return measurements.map(() => 0)

  const stars = withStars.map((m) => m.starCount).sort((a, b) => a - b)
  const referenceStars = percentile(stars, 0.9)
  // The reference HFR is taken only from frames that see at least half the
  // stars of the best ones: in a nearly blank frame the few "stars" found
  // are often isolated pixels, with a tiny HFR that says nothing about
  // sharpness.
  const hfr = withStars
    .filter((m) => m.starCount >= referenceStars / 2)
    .map((m) => m.medianHfr)
    .sort((a, b) => a - b)
  const referenceHfr = percentile(hfr, 0.1)

  return measurements.map((m) => {
    if (m.starCount <= 0 || m.medianHfr <= 0) return 0
    const starRatio = Math.min(1, m.starCount / referenceStars)
    const hfrRatio = Math.min(1, referenceHfr / m.medianHfr)
    return Math.round(starRatio * hfrRatio * 100)
  })
}

/**
 * Default threshold of the relative score. On a real series of a very rich
 * field with passing clouds, frames covered by clouds fall between 20 and
 * 38, slightly hazy ones between 40 and 53 (they are included, with
 * reduced weight, and all align), clean ones above 55. On the synthetic
 * hazy frame of `test-hazy.ts` (half the light and a sloped background)
 * the score is 49.
 */
export const DEFAULT_MIN_QUALITY = 40
