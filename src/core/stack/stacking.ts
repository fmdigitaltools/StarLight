import type { ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { sharedFloat32 } from '@shared/sharedMemory'
import { invert, type Transformation } from './alignment'
import { isCompact, rebuildRegion, type CompactImage, type HeldImage } from './compactFrame'

/**
 * Sum of the aligned frames.
 *
 * Readout noise is random and changes with every exposure, while the
 * signal of the object always stays the same: by summing many exposures
 * the former is attenuated and the latter emerges. With four times the
 * frames the noise is halved.
 *
 * The inner loop runs for every pixel of every channel of every frame:
 * on a session of two hundred exposures it exceeds a billion iterations.
 * For this reason it avoids creating objects or arrays inside it, always
 * reuses the same buffers and sorts values in place.
 *
 * The work is divided into bands of rows, and each band is computed on
 * its own: it writes rows that no other band touches and reads the frames
 * without modifying them. This is what allows distributing them among
 * several workers (`stackInParallel`, in the interface process); `stack`
 * remains the direct route on a single thread, for small cases and as a
 * fallback.
 */

export type StackingMethod = 'mean' | 'median' | 'rejection'

export interface StackingOptions {
  method: StackingMethod
  /** Number of deviations beyond which a value is rejected. */
  rejectionThreshold: number
  /**
   * In rejection, weighted mean of the kept values instead of the plain
   * mean. Needed when stacking several nights, where the weight of the
   * night must count in the robust method too; absent (a single night)
   * the computation stays the usual one, bit for bit.
   */
  weightsInRejection?: boolean
}

export const DEFAULT_STACKING: StackingOptions = {
  method: 'rejection',
  rejectionThreshold: 3
}

export interface FrameToStack {
  /** Whole or compact (see `compactFrame.ts`): the sum accepts both. */
  image: HeldImage
  transformation: Transformation
  /** Relative weight: the best frames can count more. */
  weight: number
  /**
   * Normalisation of the frame onto the reference night, per channel:
   * value · scale[c] + shift[c]. It is applied on the fly while the pixel
   * is read, without an extra pass over the data. Absent with a single
   * night (see `nights.ts`).
   */
  normalization?: Normalization
}

/** Factor and additive term per channel (see `weighNights` in nights.ts). */
export interface Normalization {
  scale: number[]
  shift: number[]
}

/**
 * Normalisation coefficients in flat arrays (frame · channels), so as not
 * to traverse objects in the inner loops; null if no frame has any.
 */
export function normalizationCoefficients(
  frame: FrameToStack[],
  channels: number
): { scale: Float32Array; shift: Float32Array } | null {
  if (!frame.some((f) => f.normalization)) return null
  const scale = new Float32Array(frame.length * channels).fill(1)
  const shift = new Float32Array(frame.length * channels)
  frame.forEach((f, i) => {
    const n = f.normalization
    if (!n) return
    for (let c = 0; c < channels; c++) {
      scale[i * channels + c] = n.scale[c] ?? n.scale[0] ?? 1
      shift[i * channels + c] = n.shift[c] ?? n.shift[0] ?? 0
    }
  })
  return { scale, shift }
}

export interface StackingResult {
  image: ImageData32
  /** How many frames contributed, on average, to each pixel. */
  meanContribution: number
  /** Values rejected for being too far from the median. */
  rejectedValues: number
}

/**
 * For each pixel of the reference, the central value among the frames and
 * the distance beyond which a value is considered an outlier. They are
 * written by the normal sum when requested, and used by drizzle to reject
 * the same disturbances without comparing frames pixel by pixel.
 * Same dimensions as the output; the limit is infinite where nothing is
 * rejected.
 */
export interface RejectionMap {
  center: Float32Array
  limit: Float32Array
}

export interface BandParams {
  frame: FrameToStack[]
  options: StackingOptions
  /** First row to compute, included. */
  yStart: number
  /** Row after the last one to compute. */
  yEnd: number
  /**
   * Complete output image (width × height × channels): the band fills in
   * only the rows that belong to it, in all channels.
   */
  output: Float32Array
  /** If present, the band also writes the centre and the rejection limit. */
  rejectionMap?: RejectionMap
  /** Side of the tiles for compact frames; if absent it is chosen automatically (`tileSide`). */
  tileSide?: number
}

/**
 * Memory that a sum worker dedicates to the pieces of compact frames
 * reconstructed for the current tile. With larger tiles the sum is not
 * any faster (measured from 4 to 32 MB with tools/measure-sensors.ts),
 * and it even slows down when many workers compete for memory.
 */
export const TILE_MEMORY = 4 * 1048576

/**
 * Side of the tiles in which the sum reconstructs compact frames: the more
 * frames there are, the smaller the tile, so that the reconstructed pieces
 * of all the frames together stay within `TILE_MEMORY`. Below 16 pixels
 * the extra border reconstructed for each piece would cost too much.
 */
export function tileSide(frame: number, channels: number): number {
  const side = Math.floor(Math.sqrt(TILE_MEMORY / (Math.max(1, frame) * channels * 4))) - 4
  return Math.max(16, Math.min(1024, side))
}

export interface BandResult {
  /** Sum of the frames that contributed to the pixels of the band. */
  contributions: number
  rejectedValues: number
}

/**
 * Brings into `data[k]` the k-th smallest value of `data[0..count)`,
 * reordering the array in place. It is a selection by three-way partition
 * (Dutch national flag): it finds the wanted value without sorting the
 * rest, and the three-way block keeps it linear even when many values are
 * equal, which is frequent here because background pixels repeat almost
 * identically across frames.
 */
function selectKth(data: Float32Array, count: number, k: number): void {
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
        const t = data[lt]
        data[lt] = data[i]
        data[i] = t
        lt++
        i++
      } else if (v > pivot) {
        const t = data[gt]
        data[gt] = data[i]
        data[i] = t
        gt--
      } else {
        i++
      }
    }
    if (k < lt) hi = lt - 1
    else if (k > gt) lo = gt + 1
    else return
  }
}

/**
 * Median of `data[0..count)` by selection, without sorting: with an even
 * count it is the mean of the two central values. It reorders the array in
 * place, but the following passes scan all the values anyway and do not
 * depend on the order. It gives the same result as sorting, bit for bit,
 * but costs linear time instead of n·log(n): on sessions of hundreds of
 * frames it makes the difference between seconds and tens of seconds.
 */
function inPlaceMedian(data: Float32Array, count: number): number {
  const meta = count >> 1
  selectKth(data, count, meta)
  const top = data[meta]
  if ((count & 1) === 1) return top
  // With an even count the lower central value is needed too: it is the
  // maximum of the part that the selection left on the left.
  let bottom = data[0]
  for (let i = 1; i < meta; i++) if (data[i] > bottom) bottom = data[i]
  return (bottom + top) * 0.5
}

/**
 * Distance from the median beyond which a value is rejected.
 *
 * The dispersion is the mean absolute deviation from the median (× 1.2533,
 * which converts it to a standard deviation), but computed only on the
 * values that are not already evidently outliers: those within
 * `OUT_OF_RANGE` deviations estimated with the median of the deviations,
 * which two or three outliers do not shift. Computed on all of them, two
 * outliers out of eight (a hot pixel that with dithering lands on the
 * same spot for two frames, two cosmic rays) would inflate the mean
 * deviation to the point of no longer being rejected: with a simulated
 * sensor without darks, thousands of hot pixels would remain in the stack
 * (tools/test-simulated-calibration.ts).
 * Without outliers the result is the plain mean deviation.
 */
const OUT_OF_RANGE = 6

function rejectionLimit(values: Float32Array, count: number, median: number, threshold: number, rejections: Float32Array): number {
  for (let i = 0; i < count; i++) {
    const d = values[i] - median
    rejections[i] = d < 0 ? -d : d
  }
  let rejectionSum = 0
  for (let i = 0; i < count; i++) rejectionSum += rejections[i]
  const clipped = inPlaceMedian(rejections, count) * 1.4826 * OUT_OF_RANGE
  // With fewer than five values the median of the deviations is too uncertain.
  if (count >= 5 && clipped > 0) {
    let sum = 0
    let kept = 0
    for (let i = 0; i < count; i++) {
      if (rejections[i] <= clipped) {
        sum += rejections[i]
        kept++
      }
    }
    if (kept >= 2) rejectionSum = (sum / kept) * count
  }
  return Math.max(1e-5, (rejectionSum / count) * 1.2533 * threshold)
}

/**
 * Computes a band of rows of the result, bringing the frames onto the
 * reference system of the first.
 *
 * @param p frames, options, rows to compute and output image
 * @param progress periodic callback with the fraction of the band done
 */
export function stackBand(
  p: BandParams,
  progress?: (fraction: number) => void
): BandResult {
  const { frame, options, output } = p
  if (frame.length === 0) throw new Error(t('coreStacking.noFrames'))

  const first = frame[0].image
  const w = first.width
  const h = first.height
  const channels = first.channels
  const n = w * h
  const frameCount = frame.length

  const yStart = Math.max(0, p.yStart)
  const yEnd = Math.min(h, p.yEnd)
  if (yEnd <= yStart) return { contributions: 0, rejectedValues: 0 }

  let totalContributions = 0
  let rejected = 0
  // The transformations go from the frame to the reference: to go back from
  // the pixel of the result to the point of the frame the inverse is
  // needed. The coefficients are extracted into flat arrays so as not to
  // traverse objects inside the loop.
  const ca = new Float64Array(frameCount)
  const cb = new Float64Array(frameCount)
  const ctx = new Float64Array(frameCount)
  const cty = new Float64Array(frameCount)
  const widths = new Int32Array(frameCount)
  const heights = new Int32Array(frameCount)
  // Where to read the values of each frame: the whole plane, or the piece
  // reconstructed for the current tile if the frame is compact. Pixel
  // (x, y) of the frame is at data[f][bases[f] + y · steps[f] + x], with
  // bases[f] = channel · area − originY · step − originX, recomputed for
  // every channel of every tile.
  const data: Float32Array[] = []
  const originX = new Int32Array(frameCount)
  const originY = new Int32Array(frameCount)
  const steps = new Int32Array(frameCount)
  const areas = new Int32Array(frameCount)
  const bases = new Int32Array(frameCount)
  const compactOnes: (CompactImage | null)[] = []
  const frameWeights = new Float32Array(frameCount)
  // A frame with no rotation or scale needs only a translation.
  const onlyTranslation = new Uint8Array(frameCount)

  for (let f = 0; f < frameCount; f++) {
    const inverted = invert(frame[f].transformation)
    ca[f] = inverted.a
    cb[f] = inverted.b
    ctx[f] = inverted.tx
    cty[f] = inverted.ty
    widths[f] = frame[f].image.width
    heights[f] = frame[f].image.height
    const im = frame[f].image
    if (isCompact(im)) {
      compactOnes.push(im)
      data.push(new Float32Array(0))
    } else {
      compactOnes.push(null)
      data.push(im.data)
      steps[f] = im.width
      areas[f] = im.width * im.height
    }
    frameWeights[f] = frame[f].weight
    onlyTranslation[f] = Math.abs(inverted.a - 1) < 1e-9 && Math.abs(inverted.b) < 1e-9 ? 1 : 0
  }

  // Buffers reused for all the pixels.
  const values = new Float32Array(frameCount)
  // Distances from the median, for the robust dispersion of the rejection.
  const rejections = new Float32Array(frameCount)
  const weights = new Float32Array(frameCount)
  // Copy of the values in the order of the weights, for weighted rejection:
  // the median reorders `values` and detaches them from their weights.
  const weightedValue = options.weightsInRejection === true
  const copy = weightedValue ? new Float32Array(frameCount) : values
  const norm = normalizationCoefficients(frame, channels)
  const normScale = norm ? norm.scale : null
  const normShift = norm ? norm.shift : null

  const method = options.method
  const map = p.rejectionMap
  const rejectionThreshold = options.rejectionThreshold
  const bandRows = yEnd - yStart
  const rowsPerNotice = Math.max(1, Math.floor(bandRows / 50))

  // With compact frames the result is computed in tiles: for each one,
  // only the piece of each compact frame that the tile reads is
  // reconstructed. Without compact frames the tile is the whole band. The
  // order in which pixels are computed does not change their value.
  const withCompact = compactOnes.some((im) => im !== null)
  const side = withCompact ? (p.tileSide ?? tileSide(frameCount, channels)) : 0
  const sideX = withCompact ? side : w
  const sideY = withCompact ? side : bandRows
  const tiles = Math.ceil(bandRows / sideY) * Math.ceil(w / sideX)
  let tilesDone = 0

  for (let ty0 = yStart; ty0 < yEnd; ty0 += sideY) {
    const ty1 = Math.min(yEnd, ty0 + sideY)
    for (let tx0 = 0; tx0 < w; tx0 += sideX) {
      const tx1 = Math.min(w, tx0 + sideX)
      if (withCompact) {
        for (let f = 0; f < frameCount; f++) {
          const im = compactOnes[f]
          if (im === null) continue
          // Points of the frame read by the tile: for an affine transformation
          // they lie in the rectangle of the four corners. One pixel of
          // margin per side covers the interpolation neighbours and the
          // rounding.
          let xMin = Infinity
          let xMax = -Infinity
          let yMin = Infinity
          let yMax = -Infinity
          for (let k = 0; k < 4; k++) {
            const x = k & 1 ? tx1 - 1 : tx0
            const y = k & 2 ? ty1 - 1 : ty0
            const sx = onlyTranslation[f] === 1 ? x + ctx[f] : ca[f] * x - cb[f] * y + ctx[f]
            const sy = onlyTranslation[f] === 1 ? y + cty[f] : cb[f] * x + ca[f] * y + cty[f]
            if (sx < xMin) xMin = sx
            if (sx > xMax) xMax = sx
            if (sy < yMin) yMin = sy
            if (sy > yMax) yMax = sy
          }
          const rx0 = Math.max(0, Math.floor(xMin) - 1)
          const ry0 = Math.max(0, Math.floor(yMin) - 1)
          const rx1 = Math.min(im.width, Math.floor(xMax) + 3)
          const ry1 = Math.min(im.height, Math.floor(yMax) + 3)
          // Outside the frame: no point of the tile falls there, nothing is read.
          if (rx1 <= rx0 || ry1 <= ry0) continue
          const area = (rx1 - rx0) * (ry1 - ry0)
          if (data[f].length < area * channels) data[f] = new Float32Array(area * channels)
          rebuildRegion(im, rx0, ry0, rx1, ry1, data[f])
          originX[f] = rx0
          originY[f] = ry0
          steps[f] = rx1 - rx0
          areas[f] = area
        }
      }

      for (let c = 0; c < channels; c++) {
        const outputBase = c * n
        for (let f = 0; f < frameCount; f++) {
          bases[f] = (channels === 3 ? c : 0) * areas[f] - originY[f] * steps[f] - originX[f]
        }

        for (let y = ty0; y < ty1; y++) {
          for (let x = tx0; x < tx1; x++) {
            let count = 0

            for (let f = 0; f < frameCount; f++) {
              const wf = widths[f]
              const hf = heights[f]

              let sx: number
              let sy: number
              if (onlyTranslation[f] === 1) {
                sx = x + ctx[f]
                sy = y + cty[f]
              } else {
                sx = ca[f] * x - cb[f] * y + ctx[f]
                sy = cb[f] * x + ca[f] * y + cty[f]
              }

              if (sx < 0 || sy < 0 || sx > wf - 1 || sy > hf - 1) continue

              // Bilinear interpolation: transformations almost always fall
              // between two pixels, and rounding would shift the stars by up
              // to half a pixel.
              const x0 = sx | 0
              const y0 = sy | 0
              const x1 = x0 + 1 < wf ? x0 + 1 : x0
              const y1 = y0 + 1 < hf ? y0 + 1 : y0
              const fx = sx - x0
              const fy = sy - y0

              const plane = data[f]
              const base = bases[f]
              const step = steps[f]
              const row0 = base + y0 * step
              const row1 = base + y1 * step

              const v00 = plane[row0 + x0]
              const v10 = plane[row0 + x1]
              const v01 = plane[row1 + x0]
              const v11 = plane[row1 + x1]

              const top = v00 + (v10 - v00) * fx
              const bottom = v01 + (v11 - v01) * fx

              const readResult = top + (bottom - top) * fy
              values[count] =
                normScale !== null && normShift !== null
                  ? readResult * normScale[f * channels + c] + normShift[f * channels + c]
                  : readResult
              weights[count] = frameWeights[f]
              count++
            }

            if (count === 0) {
              output[outputBase + y * w + x] = 0
              if (map) {
                map.center[outputBase + y * w + x] = 0
                map.limit[outputBase + y * w + x] = Infinity
              }
              continue
            }

            totalContributions += count
            let result: number

            if (method === 'mean') {
              let sum = 0
              let totalWeight = 0
              for (let i = 0; i < count; i++) {
                sum += values[i] * weights[i]
                totalWeight += weights[i]
              }
              result = totalWeight > 0 ? sum / totalWeight : 0
              if (map) {
                map.center[outputBase + y * w + x] = result
                map.limit[outputBase + y * w + x] = Infinity
              }
            } else if (method === 'median' || count < 3) {
              result = inPlaceMedian(values, count)
              if (map) {
                // The median does not reject anything by itself: for drizzle the
                // dispersion is measured as the rejection does.
                let mapLimit = Infinity
                if (count >= 3) {
                  mapLimit = rejectionLimit(values, count, result, rejectionThreshold, rejections)
                }
                map.center[outputBase + y * w + x] = result
                map.limit[outputBase + y * w + x] = mapLimit
              }
            } else {
              // Rejection: the median is found, the dispersion is measured
              // and only what is close to it is averaged. It removes
              // satellite trails and cosmic rays without losing signal.
              if (weightedValue) for (let i = 0; i < count; i++) copy[i] = values[i]
              const median = inPlaceMedian(values, count)

              const limit = rejectionLimit(values, count, median, rejectionThreshold, rejections)
              if (map) {
                map.center[outputBase + y * w + x] = median
                map.limit[outputBase + y * w + x] = limit
              }

              let sum = 0
              let keptCount = 0
              if (weightedValue) {
                // Several nights: values close to the median are averaged with
                // their own weight, so a noisy night counts less here too.
                let keptWeight = 0
                for (let i = 0; i < count; i++) {
                  const d = copy[i] - median
                  if ((d < 0 ? -d : d) > limit) {
                    rejected++
                    continue
                  }
                  sum += copy[i] * weights[i]
                  keptWeight += weights[i]
                }
                result = keptWeight > 0 ? sum / keptWeight : median
                output[outputBase + y * w + x] = result < 0 ? 0 : result > 1 ? 1 : result
                continue
              }
              for (let i = 0; i < count; i++) {
                const d = values[i] - median
                if ((d < 0 ? -d : d) > limit) {
                  rejected++
                  continue
                }
                // Sorting has detached the values from their weights, so in
                // this method they all count the same.
                sum += values[i]
                keptCount++
              }
              result = keptCount > 0 ? sum / keptCount : median
            }

            output[outputBase + y * w + x] = result < 0 ? 0 : result > 1 ? 1 : result
          }


          if (!withCompact && progress && (y - yStart) % rowsPerNotice === 0) {
            progress((c * bandRows + (y - yStart)) / (channels * bandRows))
          }
        }
      }

      tilesDone++
      if (withCompact && progress) progress(tilesDone / tiles)
    }
  }

  if (progress) progress(1)

  return { contributions: totalContributions, rejectedValues: rejected }
}

/**
 * Stacks the frames on the caller's thread, in a single band.
 *
 * @param frame list of the frames with their transformation
 * @param options combination method
 * @param progress periodic callback with the fraction completed
 */
export function stack(
  frame: FrameToStack[],
  options: StackingOptions = DEFAULT_STACKING,
  progress?: (fraction: number) => void,
  rejectionMap?: RejectionMap
): StackingResult {
  if (frame.length === 0) throw new Error(t('coreStacking.noFrames'))

  const first = frame[0].image
  const w = first.width
  const h = first.height
  const channels = first.channels
  // Shared memory here too: the result can thus be picked up by the
  // workers without copies, like the source frames.
  const output = sharedFloat32(w * h * channels)

  const result = stackBand(
    { frame, options, yStart: 0, yEnd: h, output, rejectionMap },
    progress
  )

  return {
    image: { width: w, height: h, channels: channels, data: output },
    meanContribution: result.contributions / (w * h * channels),
    rejectedValues: result.rejectedValues
  }
}
