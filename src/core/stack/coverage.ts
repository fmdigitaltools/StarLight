import type { Crop } from '@core/export/crop'
import { invert, type Transformation } from './alignment'

/*
 * Frame coverage and edge cropping.
 *
 * During capture the field drifts a little: after alignment the frames do
 * not all overlap entirely, and towards the edges of the result fewer and
 * fewer frames contribute. There the noise is not averaged down and
 * rejection, with few values, works poorly: a noisy and often coloured
 * border remains. Here we count, for each point of the result, how many
 * frames cover it, and look for the largest rectangle in which enough
 * frames contribute.
 *
 * The count is derived from the alignment transformations alone, with the
 * same rule as the sum (`stackBand`): a frame contributes to a pixel if
 * the corresponding point falls inside the frame. It also holds for
 * drizzle, whose fine grid covers the same field as the reference: the
 * crop is expressed as fractions of the image, so the same rectangle
 * applies to both.
 */

/** A frame as seen by the coverage: where it is and how large it is. */
export interface CoverageFrame {
  /** From the frame to the reference, as in the sum. */
  transformation: Transformation
  width: number
  height: number
}

export interface CoverageMap {
  /** Cells per row and per column. */
  columns: number
  rows: number
  /** Side of a cell in reference pixels. */
  step: number
  /** Frames that contribute at the centre of each cell. */
  counts: Uint16Array
}

/**
 * Counts how many frames cover each cell of the result. Cells are a few
 * pixels wide, so the count stays at a few million steps even with hundreds
 * of frames: more than enough to find an edge.
 */
export function coverageMap(frame: CoverageFrame[], width: number, height: number): CoverageMap {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 800))
  const columns = Math.ceil(width / step)
  const rows = Math.ceil(height / step)
  const counts = new Uint16Array(columns * rows)

  for (const f of frame) {
    const t = invert(f.transformation)
    const wMax = f.width - 1
    const hMax = f.height - 1
    for (let r = 0; r < rows; r++) {
      const y = Math.min(height - 1, r * step + step / 2)
      for (let c = 0; c < columns; c++) {
        const x = Math.min(width - 1, c * step + step / 2)
        const sx = t.a * x - t.b * y + t.tx
        const sy = t.b * x + t.a * y + t.ty
        if (sx >= 0 && sy >= 0 && sx <= wMax && sy <= hMax) counts[r * columns + c]++
      }
    }
  }
  return { columns, rows, step, counts }
}

/**
 * The largest rectangle made only of cells with at least `minimum` frames,
 * in cells (starting column and row included, ending ones excluded).
 * Classic histogram method: for each row, column by column, it keeps how
 * many good cells there are in a row going upward, and a stack finds the
 * widest rectangle resting on that row.
 */
export function largestRectangle(
  map: CoverageMap,
  minimum: number
): { c0: number; r0: number; c1: number; r1: number } | null {
  const { columns, rows, counts } = map
  const heights = new Int32Array(columns)
  const stack = new Int32Array(columns + 1)
  let best = 0
  let result: { c0: number; r0: number; c1: number; r1: number } | null = null

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      heights[c] = counts[r * columns + c] >= minimum ? heights[c] + 1 : 0
    }
    let top = 0
    for (let c = 0; c <= columns; c++) {
      const h = c < columns ? heights[c] : 0
      while (top > 0 && heights[stack[top - 1]] >= h) {
        const high = heights[stack[--top]]
        const left = top > 0 ? stack[top - 1] + 1 : 0
        const area = high * (c - left)
        if (area > best) {
          best = area
          result = { c0: left, r0: r - high + 1, c1: c, r1: r + 1 }
        }
      }
      stack[top++] = c
    }
  }
  return result
}

export interface CropProposal {
  crop: Crop
  /** Fraction of the area that the crop keeps. */
  keptArea: number
  /** Frames covering the least covered point of the rectangle, as a fraction of the total. */
  minCoverage: number
}

/** Never propose keeping less than this: it would be an abnormal drift, not an edge. */
const MIN_AREA = 0.4

/**
 * Proposes cropping the edges covered by few frames.
 *
 * @param fraction share of the frames that must cover every point kept
 * @returns the proposal, or null if there is no edge to remove (or if the
 *          rectangle would be so small as to suggest an error)
 */
export function suggestCoverageCrop(
  frame: CoverageFrame[],
  width: number,
  height: number,
  fraction = 0.7
): CropProposal | null {
  if (frame.length < 2 || width < 2 || height < 2) return null
  const map = coverageMap(frame, width, height)
  const minimum = Math.max(1, Math.ceil(frame.length * fraction))
  const r = largestRectangle(map, minimum)
  if (r === null) return null

  // From cells to pixels. A cell is measured at its centre: to avoid keeping
  // half an uncovered cell, the rectangle is tightened by one cell on every
  // side that does not already touch the image edge.
  const { step, columns, rows } = map
  const x0 = r.c0 === 0 ? 0 : (r.c0 + 1) * step
  const y0 = r.r0 === 0 ? 0 : (r.r0 + 1) * step
  const x1 = r.c1 === columns ? width : (r.c1 - 1) * step
  const y1 = r.r1 === rows ? height : (r.r1 - 1) * step
  if (x1 <= x0 || y1 <= y0) return null

  const crop: Crop = {
    x: x0 / width,
    y: y0 / height,
    width: (x1 - x0) / width,
    height: (y1 - y0) / height
  }
  const keptArea = crop.width * crop.height
  // The crop is always proposed, even for a minimal drift: whoever processes
  // the image decides whether to apply it. Only a rectangle that is too
  // small is excluded, as a sign of wrong alignment.
  if (keptArea >= 1 || keptArea < MIN_AREA) return null

  let minCoverage = Infinity
  for (let rr = r.r0; rr < r.r1; rr++)
    for (let c = r.c0; c < r.c1; c++) minCoverage = Math.min(minCoverage, map.counts[rr * columns + c])

  return { crop, keptArea, minCoverage: minCoverage / frame.length }
}
