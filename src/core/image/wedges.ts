import type { ImageData32 } from '@shared/types'
import { kth } from './selection'
import { takeShared, returnShared } from './parallel'

/**
 * Wedges and bands poorly covered by stacking, detected from the image.
 *
 * In stacks with field rotation (alt-azimuth mounts) the frames do not all
 * overlap: toward the edges there remain wedges and bands seen by fewer
 * frames, with noise two to six times higher and a slightly different sky
 * level (each frame has its own background, and there the average counts
 * fewer of them). Cropping removes the bands along the sides, but a diagonal
 * wedge could only be cropped away at the cost of much of the field, and
 * after stretching it remains as a lighter, grainier triangle.
 *
 * During stacking the number of frames covering each point is known (see
 * stack/coverage.ts), but an already stacked file does not carry that map.
 * It is therefore read from the image: the noise measured on boxes, from the
 * second difference between pixels two steps apart (the signal varies
 * slowly, the grain does not), divided by the typical value of the field,
 * tells how much less covered each area is. The second difference (a minus
 * two b plus c) is blind to slopes: with the simple difference, the halo of
 * a very bright star, where light falls off steeply, would look like a noisy
 * wedge, and sky equalization would bring it to the background level, leaving
 * a dark disk around the star. With that estimate:
 * - wavelets reduce the grain of the wedges in proportion to their noise,
 *   so that in the end it matches the rest of the field (`localNoiseRatio`);
 * - immediately afterwards, the sky level of the wedges is equalized with
 *   that of the nearby field (`equalizeWedgeBackground`): background
 *   extraction is a smooth surface and does not follow their sharp step.
 *
 * Filling the wedges with a fake sky, as free rotation does in the empty
 * corners, would erase the stars that are there: the wedges hold real data,
 * only noisier, and it is better to keep them.
 *
 * Only sky boxes count: where the object is, noise grows with the light (and
 * fine detail inflates the measurement), and it is right for it to stay as
 * it is.
 */

/** Side of the boxes on which noise and level are measured. */
const BOX = 32
/** Number of times its own noise above the sky beyond which a box is considered object. */
const NOISE_OBJECT = 12
/** Below this ratio the noise is considered the typical one. */
const MIN_RATIO = 1.15
/** If no area exceeds this ratio, there are no wedges. */
const WEDGE_RATIO = 1.3
/** Radius, in boxes, within which the clean reference sky is searched. */
const REFERENCE_RADIUS = 6
/** Number of clean sky boxes needed for the reference. */
const MIN_REFERENCES = 12
/**
 * The two-step second difference (see `measureBoxes`) on structureless grain
 * is sqrt(3) times the simple difference: it is divided out, so the noise
 * stays on the usual scale and the object threshold does not change.
 */
const SECOND_DIFFERENCE = Math.sqrt(3)

interface Boxes {
  columns: number
  rows: number
  /** Noise of each box divided by the typical one, 1 where normal or where the object is. */
  ratio: Float32Array
  object: Uint8Array
  max: number
}

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function measureBoxes(plane: Float32Array, w: number, h: number): Boxes | null {
  const B = BOX
  const columns = Math.floor(w / B)
  const rows = Math.floor(h / B)
  if (columns < 4 || rows < 4) return null
  const noise = new Float32Array(columns * rows)
  const level = new Float32Array(columns * rows)
  const differences = new Float32Array(B * B)
  const values = new Float32Array(B * B)
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      let k = 0
      let d = 0
      for (let y = cy * B; y < (cy + 1) * B; y++) {
        const o = y * w + cx * B
        for (let x = 0; x < B; x++) {
          values[k++] = plane[o + x]
          if (x + 4 < B) differences[d++] = Math.abs(plane[o + x + 4] - 2 * plane[o + x + 2] + plane[o + x])
        }
      }
      noise[cy * columns + cx] = kth(differences, d >> 1, d) / SECOND_DIFFERENCE
      level[cy * columns + cx] = kth(values, k >> 1, k)
    }
  }
  const typical = Math.max(1e-12, kth(Float32Array.from(noise), noise.length >> 1))
  // Sky from the low end of the levels: in a field filled by a nebula the
  // median would fall on the nebula. A wedge's level differs from the sky by
  // a few times its noise; where the object's light raises the noise by more
  // than 15%, it is tens of times above the sky.
  const sky = kth(Float32Array.from(level), level.length >> 2)
  const object = new Uint8Array(columns * rows)
  const raw = new Float32Array(columns * rows)
  for (let b = 0; b < raw.length; b++) {
    object[b] = level[b] - sky > NOISE_OBJECT * noise[b] ? 1 : 0
    raw[b] = object[b] ? 1 : Math.max(1, noise[b] / typical)
  }
  // Median over neighboring boxes: removes isolated ones with a bright star;
  // wedges are contiguous and remain.
  const ratio = new Float32Array(columns * rows)
  const neighbors = new Float32Array(9)
  let max = 1
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      let k = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(rows - 1, Math.max(0, cy + dy))
          const xx = Math.min(columns - 1, Math.max(0, cx + dx))
          neighbors[k++] = raw[yy * columns + xx]
        }
      }
      const q = kth(neighbors, 4, 9)
      const b = cy * columns + cx
      const v = object[b] ? 1 : 1 + (q - 1) * smooth(MIN_RATIO, MIN_RATIO + 0.25, q)
      ratio[b] = v
      if (v > max) max = v
    }
  }
  return { columns, rows, ratio, object, max }
}

/** From boxes to pixels, interpolating between the centers (into `map`, if given). */
function toPixel(
  values: Float32Array,
  columns: number,
  rows: number,
  w: number,
  h: number,
  map: Float32Array = new Float32Array(w * h)
): Float32Array {
  const B = BOX
  for (let y = 0; y < h; y++) {
    const fy = Math.min(rows - 1, Math.max(0, (y + 0.5) / B - 0.5))
    const j0 = Math.floor(fy)
    const j1 = Math.min(rows - 1, j0 + 1)
    const ty = fy - j0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(columns - 1, Math.max(0, (x + 0.5) / B - 0.5))
      const i0 = Math.floor(fx)
      const i1 = Math.min(columns - 1, i0 + 1)
      const tx = fx - i0
      const a = values[j0 * columns + i0] * (1 - tx) + values[j0 * columns + i1] * tx
      const b = values[j1 * columns + i0] * (1 - tx) + values[j1 * columns + i1] * tx
      map[y * w + x] = a * (1 - ty) + b * ty
    }
  }
  return map
}

/**
 * How many times the sky noise, pixel by pixel, exceeds the typical noise of
 * the field (1 where normal); null if there are no wedges.
 */
export function localNoiseRatio(
  plane: Float32Array,
  w: number,
  h: number,
  /** Called for the array of the map, if there is one (it may return an array from a pool). */
  allocate: (length: number) => Float32Array = (length) => new Float32Array(length)
): Float32Array | null {
  const r = measureBoxes(plane, w, h)
  if (r === null || r.max < WEDGE_RATIO) return null
  return toPixel(r.ratio, r.columns, r.rows, w, h, allocate(w * h))
}

/** Wedges found in an image, to be passed to `equalizeWedgeBackground`. */
export type Wedges = Boxes

/**
 * Finds the poorly covered wedges from the luminance noise; null if there
 * are none. Must be called before noise reduction, which would make them
 * indistinguishable from the rest.
 */
export function findWedges(im: ImageData32): Wedges | null {
  const { width: w, height: h, channels: c } = im
  const n = w * h
  // A temporary plane from the pool of parallel.ts, given back at once.
  const lum = takeShared(n).fill(0)
  for (let k = 0; k < c; k++) {
    const plane = im.data.subarray(k * n, (k + 1) * n)
    for (let i = 0; i < n; i++) lum[i] += plane[i] / c
  }
  const r = measureBoxes(lum, w, h)
  returnShared(lum)
  return r === null || r.max < WEDGE_RATIO ? null : r
}

/**
 * Map of the wedges to preserve in the chain's measurements, for the crop
 * proposal (see abracadabraFinish.ts): plain numbers, which pass between
 * workers and are saved as they are.
 */
export interface WedgeMap {
  columns: number
  rows: number
  /** Side of the boxes, in pixels. */
  side: number
  /** Noise of each box divided by the typical one (1 where normal or where the object is), row by row. */
  ratio: number[]
}

/** Like `findWedges`, as a `WedgeMap`; null if there are none. */
export function wedgeMap(im: ImageData32): WedgeMap | null {
  const r = findWedges(im)
  if (r === null) return null
  return {
    columns: r.columns,
    rows: r.rows,
    side: BOX,
    ratio: Array.from(r.ratio, (v) => Math.round(v * 100) / 100)
  }
}

/**
 * Brings the sky level of the wedges (found with `findWedges`) to that of the
 * nearby clean sky, channel by channel. Returns the image (the same one if
 * there is nothing to correct) and the share of the field corrected.
 *
 * It is done after noise reduction, when the grain of the wedges already
 * matches that of the field: with more noise the sky median falls slightly
 * lower (faint small stars shift the high tail, which noise widens), and an
 * equalization done earlier would resurface as a step as soon as noise
 * reduction removed the difference.
 */
export function equalizeWedgeBackground(
  im: ImageData32,
  r: Wedges,
  /**
   * If true, the correction is applied to the pixels of `im` instead of a
   * copy: the processing chain uses it on images that belong to it alone.
   * Each channel is measured before it is corrected, so the result is the
   * same.
   */
  inPlace = false
): { image: ImageData32; share: number } {
  const { width: w, height: h, channels: c } = im
  const n = w * h
  const { columns, rows } = r
  const count = columns * rows
  const weight = new Float32Array(count)
  let correctedItems = 0
  for (let b = 0; b < count; b++) {
    weight[b] = r.object[b] ? 0 : smooth(MIN_RATIO, MIN_RATIO + 0.35, r.ratio[b])
    if (weight[b] > 0.5) correctedItems++
  }
  if (correctedItems === 0) return { image: im, share: 0 }

  const B = BOX
  const data = inPlace ? im.data : im.data.slice()
  const values = new Float32Array(B * B)
  // One correction plane, reused channel after channel (from the pool of
  // parallel.ts, given back at the end).
  const correction = takeShared(n)
  const level = new Float32Array(count)
  const reference = new Float32Array(count)
  const rejection = new Float32Array(count)
  for (let k = 0; k < c; k++) {
    const plane = im.data.subarray(k * n, (k + 1) * n)
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < columns; cx++) {
        let q = 0
        for (let y = cy * B; y < (cy + 1) * B; y++) {
          const o = y * w + cx * B
          for (let x = 0; x < B; x++) values[q++] = plane[o + x]
        }
        level[cy * columns + cx] = kth(values, q >> 1, q)
      }
    }
    // Reference: median of the nearby clean sky boxes, so that a gradient
    // remaining in the field is not mistaken for a step.
    rejection.fill(0)
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < columns; cx++) {
        const b = cy * columns + cx
        if (weight[b] <= 0) continue
        // A wide wedge may have its clean sky farther away: the radius
        // grows until enough boxes are found.
        let q = 0
        for (let radius = REFERENCE_RADIUS; q < MIN_REFERENCES && radius <= Math.max(columns, rows); radius *= 2) {
          q = 0
          for (let dy = -radius; dy <= radius; dy++) {
            const yy = cy + dy
            if (yy < 0 || yy >= rows) continue
            for (let dx = -radius; dx <= radius; dx++) {
              const xx = cx + dx
              if (xx < 0 || xx >= columns) continue
              const v = yy * columns + xx
              if (weight[v] === 0 && !r.object[v]) reference[q++] = level[v]
            }
          }
        }
        if (q < MIN_REFERENCES) continue
        rejection[b] = weight[b] * (level[b] - kth(reference, q >> 1, q))
      }
    }
    toPixel(rejection, columns, rows, w, h, correction)
    const output = data.subarray(k * n, (k + 1) * n)
    for (let i = 0; i < n; i++) output[i] -= correction[i]
  }
  returnShared(correction)
  return { image: { width: w, height: h, channels: c, data }, share: correctedItems / count }
}
