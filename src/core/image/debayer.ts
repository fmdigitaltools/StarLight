import type { BayerPattern, ImageData32 } from '@shared/types'

/**
 * Bayer matrix interpolation (demosaicing).
 *
 * Sub-frames from color sensors are monochrome with a Bayer matrix (for
 * example GRBG, read from the header): each pixel records a single color
 * and the two missing ones are reconstructed from its neighbors. Bilinear
 * interpolation is used, the best compromise between quality and speed over
 * thousands of frames: residual artifacts are irrelevant once many
 * exposures are integrated.
 */

/** Position of the color within the 2x2 cell of the given pattern. */
type ColorIndex = 0 | 1 | 2

/**
 * Color recorded by pixel (x, y): 0 red, 1 green, 2 blue.
 *
 * Exported for Bayer drizzle. The interpolation below leaves untouched, in
 * every pixel, the value of the color the sensor actually measured and
 * reconstructs only the other two: whoever knows the pattern can therefore
 * read the raw data back from the color image without keeping it in memory
 * twice.
 */
export function colorAt(pattern: BayerPattern, x: number, y: number): ColorIndex {
  const ox = x & 1
  const oy = y & 1
  switch (pattern) {
    case 'RGGB':
      return oy === 0 ? (ox === 0 ? 0 : 1) : ox === 0 ? 1 : 2
    case 'BGGR':
      return oy === 0 ? (ox === 0 ? 2 : 1) : ox === 0 ? 1 : 0
    case 'GRBG':
      return oy === 0 ? (ox === 0 ? 1 : 0) : ox === 0 ? 2 : 1
    case 'GBRG':
      return oy === 0 ? (ox === 0 ? 1 : 2) : ox === 0 ? 0 : 1
    default:
      return 1
  }
}

/** Reads a pixel, replicating the edge when the coordinates fall outside the image. */
function sample(data: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y
  return data[cy * w + cx]
}

/**
 * Converts an image with a Bayer matrix to planar RGB.
 * Returns the original image if no pattern is declared.
 *
 * @param allocate Provider of the result's value arrays: the analysis worker
 * passes a shared-memory allocator so the image is created directly in
 * shared memory and needs no copy (saving 12 bytes per pixel).
 */
export function debayer(
  image: ImageData32,
  pattern: BayerPattern,
  allocate: (length: number) => Float32Array = (l) => new Float32Array(l)
): ImageData32 {
  if (pattern === 'NONE' || image.channels === 3) return image

  const { width: w, height: h, data } = image
  const n = w * h
  const out = allocate(n * 3)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const c = colorAt(pattern, x, y)
      const value = data[i]

      let r = 0
      let g = 0
      let b = 0

      if (c === 1) {
        // Green pixel: red and blue come from the two neighbors on the same axis.
        g = value
        // The axis holding the red neighbors depends on the row.
        const redIsHorizontal = colorAt(pattern, x + 1, y) === 0
        if (redIsHorizontal) {
          r = (sample(data, w, h, x - 1, y) + sample(data, w, h, x + 1, y)) * 0.5
          b = (sample(data, w, h, x, y - 1) + sample(data, w, h, x, y + 1)) * 0.5
        } else {
          b = (sample(data, w, h, x - 1, y) + sample(data, w, h, x + 1, y)) * 0.5
          r = (sample(data, w, h, x, y - 1) + sample(data, w, h, x, y + 1)) * 0.5
        }
      } else {
        // Red or blue pixel: green is the mean of the four orthogonal neighbors,
        // the opposite color the mean of the four diagonal neighbors.
        const own = value
        const green =
          (sample(data, w, h, x - 1, y) +
            sample(data, w, h, x + 1, y) +
            sample(data, w, h, x, y - 1) +
            sample(data, w, h, x, y + 1)) *
          0.25
        const opposite =
          (sample(data, w, h, x - 1, y - 1) +
            sample(data, w, h, x + 1, y - 1) +
            sample(data, w, h, x - 1, y + 1) +
            sample(data, w, h, x + 1, y + 1)) *
          0.25
        g = green
        if (c === 0) {
          r = own
          b = opposite
        } else {
          b = own
          r = opposite
        }
      }

      out[i] = r
      out[n + i] = g
      out[2 * n + i] = b
    }
  }

  return { width: w, height: h, channels: 3, data: out }
}

/**
 * Extracts the luminance of an RGB image, or returns the single plane of a
 * monochrome image.
 *
 * @param output Where to write it, if the caller already has a free plane of
 * the right size
 */
export function toLuminance(image: ImageData32, output?: Float32Array): Float32Array {
  if (image.channels === 1) return image.data
  const n = image.width * image.height
  const lum = output && output.length === n ? output : new Float32Array(n)
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * image.data[i] + 0.7152 * image.data[n + i] + 0.0722 * image.data[2 * n + i]
  }
  return lum
}
