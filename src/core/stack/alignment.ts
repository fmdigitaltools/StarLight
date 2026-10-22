import type { Star } from '@core/stars/detection'

/**
 * Frame alignment.
 *
 * Between one exposure and the next the field drifts and slowly rotates:
 * summing the images as they are would produce trailed stars. For each frame
 * we therefore need to find the transformation that maps it onto the first
 * one.
 *
 * The method does not compare pixels but stars: it looks for triangles of
 * stars with the same shape in the two frames. The shape of a triangle does
 * not change if the image is shifted, rotated or scaled, so it provides a
 * reliable reference.
 */

/** Similarity transformation: rotation, scale and translation. */
export interface Transformation {
  /** Coefficients of the linear part. */
  a: number
  b: number
  /** Translation. */
  tx: number
  ty: number
}

export const IDENTITY_TRANSFORMATION: Transformation = { a: 1, b: 0, tx: 0, ty: 0 }

/** Applies the transformation to a point. */
export function applyTransform(t: Transformation, x: number, y: number): { x: number; y: number } {
  return { x: t.a * x - t.b * y + t.tx, y: t.b * x + t.a * y + t.ty }
}

/** Rotation angle in degrees. */
export function rotationDegrees(t: Transformation): number {
  return (Math.atan2(t.b, t.a) * 180) / Math.PI
}

/** Scale factor. */
export function scale(t: Transformation): number {
  return Math.hypot(t.a, t.b)
}

/** Inverts a similarity transformation. */
export function invert(t: Transformation): Transformation {
  const denominator = t.a * t.a + t.b * t.b
  if (denominator === 0) return IDENTITY_TRANSFORMATION
  const a = t.a / denominator
  const b = -t.b / denominator
  return { a, b, tx: -(a * t.tx - b * t.ty), ty: -(b * t.tx + a * t.ty) }
}

/** Invariant descriptor of a triangle of stars. */
interface Triangle {
  indices: [number, number, number]
  /** Ratios between sides, independent of position, rotation and scale. */
  r1: number
  r2: number
}

/**
 * Builds the triangles formed by the brightest stars. The number of
 * combinations grows quickly, so only a subset is considered: the bright
 * stars are enough to define the reference.
 */
function buildTriangles(stars: Star[], count: number): Triangle[] {
  const n = Math.min(count, stars.length)
  const triangles: Triangle[] = []

  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        const d1 = Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y)
        const d2 = Math.hypot(stars[j].x - stars[k].x, stars[j].y - stars[k].y)
        const d3 = Math.hypot(stars[k].x - stars[i].x, stars[k].y - stars[i].y)

        const sides = [
          { length: d1, opposing: k },
          { length: d2, opposing: i },
          { length: d3, opposing: j }
        ].sort((a, b) => b.length - a.length)

        const max = sides[0].length
        // Triangles that are too small or degenerate are not reliable.
        if (max < 12 || sides[2].length < 4) continue

        // Indices are ordered by side length, so that two matching
        // triangles list their vertices in the same order.
        triangles.push({
          indices: [sides[0].opposing, sides[1].opposing, sides[2].opposing],
          r1: sides[1].length / max,
          r2: sides[2].length / max
        })
      }
    }
  }

  return triangles
}

/**
 * Computes the similarity transformation that maps the start points onto
 * the destination points, minimising the squared error.
 */
function estimateTransform(
  start: { x: number; y: number }[],
  destination: { x: number; y: number }[]
): Transformation | null {
  const n = start.length
  if (n < 2) return null

  let meanPx = 0
  let meanPy = 0
  let meanAx = 0
  let meanAy = 0
  for (let i = 0; i < n; i++) {
    meanPx += start[i].x
    meanPy += start[i].y
    meanAx += destination[i].x
    meanAy += destination[i].y
  }
  meanPx /= n
  meanPy /= n
  meanAx /= n
  meanAy /= n

  let sumXX = 0
  let sumXY = 0
  let norm = 0

  for (let i = 0; i < n; i++) {
    const px = start[i].x - meanPx
    const py = start[i].y - meanPy
    const ax = destination[i].x - meanAx
    const ay = destination[i].y - meanAy
    sumXX += px * ax + py * ay
    sumXY += px * ay - py * ax
    norm += px * px + py * py
  }

  if (norm < 1e-9) return null

  const a = sumXX / norm
  const b = sumXY / norm

  return {
    a,
    b,
    tx: meanAx - (a * meanPx - b * meanPy),
    ty: meanAy - (b * meanPx + a * meanPy)
  }
}

export interface AlignmentResult {
  transformation: Transformation
  /** How many stars confirmed the transformation. */
  matchingStars: number
  /** Typical error between predicted and actual positions, in pixels. */
  meanError: number
  /** True if the alignment is considered reliable. */
  valid: boolean
}

/**
 * How many of the brightest stars enter the triangles. The others are never
 * looked at: neither for the matches nor for the consensus, which are
 * computed only on the pairs that come from the triangles.
 */
export const USED_STARS = 26

/**
 * Stars used in the second attempt, when the first one fails. In frames
 * hazed by clouds that cover only part of the field, the twenty-six
 * brightest stars of the frame are not the same as those of the reference
 * (those under the cloud drop in the ranking) and the triangles in common
 * are too few; widening the selection restores the matches and recovers
 * hazy frames, accepted on quality, that the first attempt does not align.
 */
export const STARS_SECOND_ATTEMPT = 50

/**
 * The only stars that `align` actually reads: the first
 * `STARS_SECOND_ATTEMPT`, that is the brightest, because detection already
 * returns them sorted. Useful to callers that delegate the alignment to
 * another thread: sending thousands of stars to use fifty would cost more
 * than the computation. The result of `align` does not change, because the
 * check on the minimum of six stars gives the same outcome on the
 * shortened list.
 */
export function requiredStars(stars: Star[], usedStars = STARS_SECOND_ATTEMPT): Star[] {
  return stars.length <= usedStars ? stars : stars.slice(0, usedStars)
}

/**
 * Aligns a frame onto the reference by comparing stars.
 *
 * First, triangles with the same shape are searched for in the two sets,
 * yielding pairs of stars that probably correspond. Since some pairs will
 * be wrong, a consensus procedure is used: a transformation computed on a
 * few pairs is tried many times and the one that convinces the largest
 * number of stars is kept.
 */
export function align(
  reference: Star[],
  frame: Star[],
  options: { tolerance?: number; usedStars?: number } = {}
): AlignmentResult {
  const tolerance = options.tolerance ?? 2.5
  const first = alignWithStars(reference, frame, tolerance, options.usedStars ?? USED_STARS)
  // If the first attempt fails and the caller did not fix the number of
  // stars, try again with more stars (see STARS_SECOND_ATTEMPT). It only
  // costs time on difficult frames.
  if (
    first.valid ||
    options.usedStars !== undefined ||
    (reference.length <= USED_STARS && frame.length <= USED_STARS)
  ) {
    return first
  }
  const second = alignWithStars(reference, frame, tolerance, STARS_SECOND_ATTEMPT)
  return second.valid ? second : first
}

/** One attempt of `align` with a fixed number of stars. */
function alignWithStars(
  reference: Star[],
  frame: Star[],
  tolerance: number,
  usedStars: number
): AlignmentResult {

  const failure: AlignmentResult = {
    transformation: IDENTITY_TRANSFORMATION,
    matchingStars: 0,
    meanError: Infinity,
    valid: false
  }

  if (reference.length < 6 || frame.length < 6) return failure

  const refTriangles = buildTriangles(reference, usedStars)
  const frameTriangles = buildTriangles(frame, usedStars)
  if (refTriangles.length === 0 || frameTriangles.length === 0) return failure

  // Reference triangles are indexed on their rounded ratios, so that
  // matching does not require examining all of them.
  const grid = new Map<string, Triangle[]>()
  const step = 0.02
  const key = (r1: number, r2: number): string =>
    Math.round(r1 / step) + ':' + Math.round(r2 / step)

  for (const t of refTriangles) {
    const k = key(t.r1, t.r2)
    const list = grid.get(k)
    if (list) list.push(t)
    else grid.set(k, [t])
  }

  // Count of the matches between individual stars.
  const votes = new Map<string, number>()

  for (const t of frameTriangles) {
    // Adjacent cells are examined too, because two matching triangles may
    // fall across a cell boundary.
    for (let d1 = -1; d1 <= 1; d1++) {
      for (let d2 = -1; d2 <= 1; d2++) {
        const k = Math.round(t.r1 / step) + d1 + ':' + (Math.round(t.r2 / step) + d2)
        const cellCandidates = grid.get(k)
        if (!cellCandidates) continue

        for (const c of cellCandidates) {
          if (Math.abs(c.r1 - t.r1) > 0.025 || Math.abs(c.r2 - t.r2) > 0.025) continue
          for (let v = 0; v < 3; v++) {
            const pair = t.indices[v] + '-' + c.indices[v]
            votes.set(pair, (votes.get(pair) ?? 0) + 1)
          }
        }
      }
    }
  }

  if (votes.size === 0) return failure

  // Keep the most voted matches, one per star.
  const sortedList = [...votes.entries()].sort((a, b) => b[1] - a[1])
  const usedFrames = new Set<number>()
  const usedRefs = new Set<number>()
  const pairs: { frame: number; reference: number }[] = []

  for (const [pair, count] of sortedList) {
    if (count < 2) break
    const [iFrame, iRef] = pair.split('-').map(Number)
    if (usedFrames.has(iFrame) || usedRefs.has(iRef)) continue
    usedFrames.add(iFrame)
    usedRefs.add(iRef)
    pairs.push({ frame: iFrame, reference: iRef })
  }

  if (pairs.length < 3) return failure

  // Consensus: any two matches are enough to fix a similarity (shift,
  // rotation and scale), and the one that convinces the most stars is kept.
  // All of them are tried, among the most voted: at most a few hundred
  // hypotheses, a negligible computation. A few triples chosen at a fixed
  // step are not enough: with half of the field hazed by clouds (six good
  // stars out of twenty candidate matches) there may be no triple made only
  // of correct pairs, and the frame would be discarded even though the
  // alignment exists.
  let bestTransform: Transformation | null = null
  let bestConsensus: { frame: number; reference: number }[] = []

  const topPairs = pairs.slice(0, 40)
  for (let i = 0; i < topPairs.length - 1; i++) {
    for (let j = i + 1; j < topPairs.length; j++) {
      const choices = [topPairs[i], topPairs[j]]
      const t = estimateTransform(
        choices.map((c) => ({ x: frame[c.frame].x, y: frame[c.frame].y })),
        choices.map((c) => ({ x: reference[c.reference].x, y: reference[c.reference].y }))
      )
      if (!t) continue

      // A valid similarity does not distort the scale.
      const factor = scale(t)
      if (factor < 0.9 || factor > 1.1) continue

      const consensus = pairs.filter((c) => {
        const expected = applyTransform(t, frame[c.frame].x, frame[c.frame].y)
        const real = reference[c.reference]
        return Math.hypot(expected.x - real.x, expected.y - real.y) <= tolerance
      })

      if (consensus.length > bestConsensus.length) {
        bestConsensus = consensus
        bestTransform = t
      }
    }
  }

  if (!bestTransform || bestConsensus.length < 3) return failure

  // Final refinement on all the confirmed matches.
  const final =
    estimateTransform(
      bestConsensus.map((c) => ({ x: frame[c.frame].x, y: frame[c.frame].y })),
      bestConsensus.map((c) => ({
        x: reference[c.reference].x,
        y: reference[c.reference].y
      }))
    ) ?? bestTransform

  let errorSum = 0
  for (const c of bestConsensus) {
    const expected = applyTransform(final, frame[c.frame].x, frame[c.frame].y)
    const real = reference[c.reference]
    errorSum += Math.hypot(expected.x - real.x, expected.y - real.y)
  }
  const meanError = errorSum / bestConsensus.length

  return {
    transformation: final,
    matchingStars: bestConsensus.length,
    meanError,
    valid: bestConsensus.length >= 5 && meanError <= tolerance
  }
}
