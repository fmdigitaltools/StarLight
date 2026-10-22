import type { ImageData32 } from '@shared/types'

/**
 * Color reconstruction for Fujifilm X-Trans sensors.
 *
 * Instead of the 2x2 Bayer cell, X-Trans repeats a 6x6 pixel pattern; the
 * reconstruction of `debayer` does not apply, so here the missing colors of
 * each pixel are the mean of the neighboring pixels of the same color
 * within a 3x3 square (5x5 if that color is absent from the 3x3). This is
 * a simple linear interpolation: it does not shift levels, applies no
 * white balance, and after stacking many exposures its small artifacts
 * disappear just like those of bilinear Bayer interpolation. The value
 * measured by a pixel is left intact in its own color.
 */

/** Offsets to the neighbors to average: (dy, dx) pairs. */
type Neighbors = Int8Array

/**
 * For each of the 36 positions of the cell and each color, the neighbors
 * of the same color. `color(y, x)` returns 0 for red, 1 for green, 2 for
 * blue for the first rows and columns of the visible area.
 */
function neighborTable(color: (y: number, x: number) => number): Neighbors[][] {
  const table: Neighbors[][] = []
  for (let py = 0; py < 6; py++) {
    for (let px = 0; px < 6; px++) {
      const byColor: Neighbors[] = []
      for (let c = 0; c < 3; c++) {
        let chosenItems: number[] = []
        for (const radius of [1, 2]) {
          chosenItems = []
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (color((py + dy + 12) % 6, (px + dx + 12) % 6) === c) chosenItems.push(dy, dx)
            }
          }
          if (chosenItems.length > 0) break
        }
        byColor.push(Int8Array.from(chosenItems))
      }
      table.push(byColor)
    }
  }
  return table
}

/** Converts the single-plane X-Trans mosaic into a planar RGB image. */
export function demosaicXtrans(
  cfa: Float32Array,
  width: number,
  height: number,
  color: (y: number, x: number) => number
): ImageData32 {
  const w = width
  const h = height
  const n = w * h
  const out = new Float32Array(n * 3)
  const table = neighborTable(color)
  const cellColor = new Uint8Array(36)
  for (let k = 0; k < 36; k++) cellColor[k] = color(Math.floor(k / 6), k % 6)

  for (let y = 0; y < h; y++) {
    const edgeY = y < 2 || y >= h - 2
    const py = y % 6
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const phase = py * 6 + (x % 6)
      const cells = table[phase]
      const own = cellColor[phase]
      const edge = edgeY || x < 2 || x >= w - 2
      for (let c = 0; c < 3; c++) {
        if (c === own) {
          out[c * n + i] = cfa[i]
          continue
        }
        const v = cells[c]
        let sum = 0
        let count = 0
        for (let k = 0; k < v.length; k += 2) {
          const yy = y + v[k]
          const xx = x + v[k + 1]
          if (edge) {
            // At the edge, neighbors falling outside the image are skipped:
            // mirroring the coordinates would change the pixel's color.
            if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue
          }
          sum += cfa[yy * w + xx]
          count++
        }
        out[c * n + i] = count > 0 ? sum / count : cfa[i]
      }
    }
  }

  return { width: w, height: h, channels: 3, data: out }
}
