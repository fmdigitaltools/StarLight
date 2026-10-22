import type { FrameStats, ImageData32 } from '@shared/types'

/**
 * Robust statistics of an image plane. Median and MAD (median absolute
 * deviation) are preferred to mean and standard deviation because they are
 * not skewed by bright stars, which are extreme values.
 */

/** Constant that makes the MAD comparable to the standard deviation. */
export const MAD_TO_SIGMA = 1.4826

/**
 * Approximate median over a regular sample of the pixels.
 * On multi-megapixel images sampling keeps the error negligible and cuts
 * the computation time by more than an order of magnitude.
 */
function sampledSort(data: Float32Array, maxSamples: number): Float32Array {
  const step = Math.max(1, Math.floor(data.length / maxSamples))
  const n = Math.floor(data.length / step)
  const sample = new Float32Array(n)
  for (let i = 0; i < n; i++) sample[i] = data[i * step]
  return sample.sort()
}

/** Computes the statistics of a whole buffer of values in [0,1]. */
export function computeStats(data: Float32Array, maxSamples = 200000): FrameStats {
  if (data.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, stdDev: 0, mad: 0, saturatedPct: 0 }
  }

  let min = Infinity
  let max = -Infinity
  let sum = 0
  let saturated = 0

  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    if (v >= 0.999) saturated++
  }

  const mean = sum / data.length

  let varSum = 0
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - mean
    varSum += d * d
  }
  const stdDev = Math.sqrt(varSum / data.length)

  const sorted = sampledSort(data, maxSamples)
  const median = sorted[Math.floor(sorted.length / 2)]

  // MAD: median of the absolute deviations from the median.
  const dev = new Float32Array(sorted.length)
  for (let i = 0; i < sorted.length; i++) dev[i] = Math.abs(sorted[i] - median)
  dev.sort()
  const mad = dev[Math.floor(dev.length / 2)]

  return {
    min,
    max,
    mean,
    median,
    stdDev,
    mad,
    saturatedPct: (saturated / data.length) * 100
  }
}

/** Statistics of the luminance channel of a 1- or 3-channel image. */
export function computeImageStats(image: ImageData32): FrameStats {
  if (image.channels === 1) return computeStats(image.data)

  const n = image.width * image.height
  const lum = new Float32Array(n)
  // Rec. 709 luminance weights.
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * image.data[i] + 0.7152 * image.data[n + i] + 0.0722 * image.data[2 * n + i]
  }
  return computeStats(lum)
}

/** 256- or 512-bin histogram per channel, ready for plotting. */
export function computeHistogram(image: ImageData32, bins = 256): Uint32Array[] {
  const n = image.width * image.height
  const result: Uint32Array[] = []
  const last = bins - 1

  for (let c = 0; c < image.channels; c++) {
    const hist = new Uint32Array(bins)
    const base = c * n
    for (let i = 0; i < n; i++) {
      const v = image.data[base + i]
      let bin = Math.round(v * last)
      if (bin < 0) bin = 0
      else if (bin > last) bin = last
      hist[bin]++
    }
    result.push(hist)
  }

  return result
}


/** Side of the blocks on which noise is measured, in original pixels. */
const NOISE_BLOCK_SIDE = 4

/**
 * Estimates the true noise of an image, expressed as the noise of a single
 * pixel at the original scale.
 *
 * The deviation computed over the whole image also includes the
 * light-pollution gradient and the signal of the objects, which change from
 * area to area: the result would be much higher than the real noise, and
 * the effect of integration would appear to be nil.
 *
 * Neighboring areas are therefore compared, because the sky varies slowly
 * in space and what remains between two adjacent areas is mainly noise; the
 * median of the differences is not affected by stars.
 *
 * The areas are 4x4 pixel blocks rather than single pixels. Color
 * reconstruction, alignment interpolation and drizzle blend neighboring
 * pixels: the noise remains but becomes correlated over one or two pixels,
 * and the difference between adjacent pixels no longer sees it. Measured
 * that way, the noise reduction of a long stack would come out higher than
 * statistics allow (the square root of the number of frames). The mean of a
 * block, instead, does not depend on how the noise is distributed inside
 * it: its noise, multiplied by the block side, is that of an independent
 * pixel. It is measured on the luminance, that is, on all channels.
 *
 * @param scaleFactor Image pixels per original pixel: 2 for a result of a
 *   double-grid drizzle. The blocks then cover the same patch of sky, and
 *   the value stays comparable with that of a single frame.
 */
export function estimateNoise(image: ImageData32, scaleFactor = 1): number {
  const w = image.width
  const h = image.height
  const n = w * h
  const side = Math.max(1, Math.round(NOISE_BLOCK_SIDE * scaleFactor))
  const bx = Math.floor(w / side)
  const by = Math.floor(h / side)
  if (bx < 3 || by < 3) return 0

  const d = image.data
  const three = image.channels === 3
  const means = new Float64Array(bx * by)
  // A block containing zero-valued pixels falls outside the covered field
  // (edges of the stack or mosaic): it must not be compared, because two
  // adjacent empty blocks would have zero difference and make the noise
  // look lower than it is.
  const valid = new Uint8Array(bx * by).fill(1)

  for (let y = 0; y < by * side; y++) {
    const blockRow = Math.floor(y / side) * bx
    const base = y * w
    for (let x = 0; x < bx * side; x++) {
      const i = base + x
      const v = three ? 0.2126 * d[i] + 0.7152 * d[n + i] + 0.0722 * d[2 * n + i] : d[i]
      const b = blockRow + Math.floor(x / side)
      if (v === 0) valid[b] = 0
      means[b] += v
    }
  }
  const area = side * side
  for (let b = 0; b < means.length; b++) means[b] /= area

  const differences: number[] = []
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      const b = y * bx + x
      if (valid[b] === 0) continue
      if (x + 1 < bx && valid[b + 1] === 1) differences.push(Math.abs(means[b + 1] - means[b]))
      if (y + 1 < by && valid[b + bx] === 1) differences.push(Math.abs(means[b + bx] - means[b]))
    }
  }
  if (differences.length === 0) return 0

  differences.sort((a, b) => a - b)
  const median = differences[Math.floor(differences.length / 2)]

  // The difference between two independent blocks has a spread larger by
  // a factor of sqrt(2) than the noise of a single block; the block noise,
  // times the side (in original pixels), is that of one pixel.
  return ((median * MAD_TO_SIGMA) / Math.SQRT2) * NOISE_BLOCK_SIDE
}
