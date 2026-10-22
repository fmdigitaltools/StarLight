import type { ImageData32 } from '@shared/types'

/**
 * Pixel preparation for the viewer texture.
 *
 * The graphics card expects the channels of each pixel side by side (red,
 * green, blue, then the next pixel), while StarLight keeps channels in
 * separate planes. Copying the whole image into the new layout would cost
 * 12 bytes per pixel (734 MB for a 61-megapixel frame), so it is prepared
 * in strips of a few rows that are uploaded one after the other.
 *
 * Every GPU also has a maximum texture side (often 16384 pixels), which a
 * 2x drizzle of a 45 or 61 megapixel sensor exceeds. In that case the viewer
 * receives the image reduced by an integer factor, averaging each pixel
 * block; the full data stays with the application for processing and
 * export. The image dimensions used by the viewer (zoom, coordinates, crop)
 * remain the true ones: the reduction only affects what the GPU draws.
 */

/** Texture dimensions for an image, given the GPU maximum side. */
export interface TexturePlane {
  /** Side of the pixel block that becomes one texture pixel (1 = no reduction). */
  factor: number
  width: number
  height: number
}

/** The smallest integer factor that makes the image fit within the maximum side. */
export function texturePlane(width: number, height: number, maxSide: number, minFactor = 1): TexturePlane {
  const side = Math.max(1, Math.floor(maxSide))
  const factor = Math.max(1, Math.floor(minFactor), Math.ceil(Math.max(width, height) / side))
  return { factor, width: Math.ceil(width / factor), height: Math.ceil(height / factor) }
}

/**
 * Writes the texture rows from `y0` to `y1` (exclusive) into `output`, with
 * the channels of each pixel interleaved. With factor 1 the values are
 * identical to the image; with a larger factor each value is the mean of its
 * block (at the edges, of the pixels that actually exist).
 */
export function textureRows(
  image: ImageData32,
  plane: TexturePlane,
  y0: number,
  y1: number,
  output: Float32Array
): void {
  const { width: w, height: h, channels, data } = image
  const n = w * h
  const k = plane.factor
  const W = plane.width

  if (k === 1) {
    for (let y = y0; y < y1; y++) {
      const row = (y - y0) * W * channels
      const base = y * w
      if (channels === 3) {
        for (let x = 0; x < w; x++) {
          const o = row + x * 3
          output[o] = data[base + x]
          output[o + 1] = data[n + base + x]
          output[o + 2] = data[2 * n + base + x]
        }
      } else {
        output.set(data.subarray(base, base + w), row)
      }
    }
    return
  }

  for (let Y = y0; Y < y1; Y++) {
    const ya = Y * k
    const yb = Math.min(h, ya + k)
    const row = (Y - y0) * W * channels
    for (let X = 0; X < W; X++) {
      const xa = X * k
      const xb = Math.min(w, xa + k)
      const count = (yb - ya) * (xb - xa)
      for (let c = 0; c < channels; c++) {
        const plane = c * n
        let sum = 0
        for (let y = ya; y < yb; y++) {
          const base = plane + y * w
          for (let x = xa; x < xb; x++) sum += data[base + x]
        }
        output[row + X * channels + c] = sum / count
      }
    }
  }
}
