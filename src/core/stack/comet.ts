import type { ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { detectStars } from '@core/stars/detection'
import { invert, applyTransform, type Transformation } from './alignment'

/**
 * Comet stacking.
 *
 * A comet moves among the stars by a few pixels every few minutes.
 * Aligning the frames on the stars, as for any other object, the stars
 * stay point-like but the comet comes out smeared, elongated along its
 * path. Aligning them on the comet does the opposite: the comet is sharp
 * and the stars become streaks.
 *
 * This file holds the pieces needed to obtain one, the other or both:
 *
 * - where the nucleus is in each frame, measured automatically or from
 *   two user clicks, and described as a uniform motion in time (over a
 *   couple of hours of capture the path of a comet is a straight line
 *   covered at constant speed);
 * - the transformation that, besides aligning on the stars, compensates
 *   for the path of the nucleus;
 * - the "comet layer": the comet alone, obtained from the sum aligned on
 *   it with the sky background removed, which is subtracted from the
 *   frames before summing them on the stars and put back on top of the
 *   result. It is the way to get point-like stars and a sharp comet
 *   together, without double nuclei or halos, whatever the speed of the
 *   comet.
 *
 * All positions are in pixels of the reference frame (the one onto which
 * the alignment brings the others), unless stated otherwise.
 */

/** What must stay fixed in the result. */
export type CometMode = 'stars' | 'comet' | 'both'

export interface Point {
  x: number
  y: number
}

/** Uniform motion of the nucleus: position = (x0, y0) + v·(t − t0). */
export interface NucleusMotion {
  t0: number
  x0: number
  y0: number
  /** Speed in pixels per unit of time (hours, if the times are real). */
  vx: number
  vy: number
}

/** Position of the nucleus at time `t`. */
export function nucleusPosition(m: NucleusMotion, t: number): Point {
  return { x: m.x0 + m.vx * (t - m.t0), y: m.y0 + m.vy * (t - m.t0) }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Least-squares line of `values` against `times`, around t0. */
function leastSquaresLine(times: number[], values: number[], t0: number): { q: number; v: number } {
  const n = times.length
  let st = 0
  let sv = 0
  for (let i = 0; i < n; i++) {
    st += times[i] - t0
    sv += values[i]
  }
  const mt = st / n
  const mv = sv / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dt = times[i] - t0 - mt
    num += dt * (values[i] - mv)
    den += dt * dt
  }
  const v = den > 1e-12 ? num / den : 0
  return { q: mv - v * mt, v }
}

/** Theil-Sen slope: the median of the slopes between all pairs. */
function robustSlope(times: number[], values: number[]): number {
  const slopes: number[] = []
  const n = times.length
  // Beyond a few hundred points the pairs become too many: a part of them
  // is taken at a fixed step, which is enough for the median.
  const step = n > 300 ? Math.ceil(n / 300) : 1
  for (let i = 0; i < n; i += step) {
    for (let j = i + 1; j < n; j += step) {
      const dt = times[j] - times[i]
      if (Math.abs(dt) > 1e-9) slopes.push((values[j] - values[i]) / dt)
    }
  }
  return slopes.length > 0 ? median(slopes) : 0
}

/** Outcome of fitting the motion to the measured positions. */
export interface MotionFit {
  motion: NucleusMotion
  /** Typical deviation of the kept positions from the line, in pixels. */
  rejection: number
  /** For each position, whether it was kept (false = wrong measurement). */
  kept: boolean[]
}

/**
 * Fits a uniform motion to positions measured over time, without being
 * dragged by wrong measurements.
 *
 * A measurement can be wrong when a star passes over the coma or a cloud
 * hazes a frame: the line is first estimated with medians (Theil-Sen,
 * which holds up to almost a third of wrong measurements), distant
 * measurements are discarded and the line is redone by least squares with
 * the remaining ones.
 */
export function fitMotion(points: { t: number; x: number; y: number }[]): MotionFit | null {
  const n = points.length
  if (n === 0) return null
  const times = points.map((p) => p.t)
  const t0 = median(times)
  const vx = robustSlope(times, points.map((p) => p.x))
  const vy = robustSlope(times, points.map((p) => p.y))
  const x0 = median(points.map((p) => p.x - vx * (p.t - t0)))
  const y0 = median(points.map((p) => p.y - vy * (p.t - t0)))
  let motion: NucleusMotion = { t0, x0, y0, vx, vy }

  const distances = (m: NucleusMotion): number[] =>
    points.map((p) => {
      const q = nucleusPosition(m, p.t)
      return Math.hypot(p.x - q.x, p.y - q.y)
    })

  let kept = points.map(() => true)
  for (let pass = 0; pass < 2; pass++) {
    const d = distances(motion)
    // Threshold: three times the typical deviation, but never below a
    // pixel, because the centroid itself is no more precise than a few tenths.
    const threshold = Math.max(1, 3 * 1.4826 * median(d))
    kept = d.map((v) => v <= threshold)
    const indices = kept.flatMap((t, i) => (t ? [i] : []))
    if (indices.length < 2) break
    const ti = indices.map((i) => times[i])
    const rx = leastSquaresLine(ti, indices.map((i) => points[i].x), t0)
    const ry = leastSquaresLine(ti, indices.map((i) => points[i].y), t0)
    motion = { t0, x0: rx.q, y0: ry.q, vx: rx.v, vy: ry.v }
  }

  const d = distances(motion)
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    if (!kept[i]) continue
    sum += d[i] * d[i]
    count++
  }
  return { motion, rejection: count > 0 ? Math.sqrt(sum / count) : 0, kept }
}

/** Brightness of a pixel: the mean of the channels. */
function light(img: ImageData32, x: number, y: number): number {
  const w = img.width
  const i = y * w + x
  if (img.channels === 1) return img.data[i]
  const n = w * img.height
  return (img.data[i] + img.data[n + i] + img.data[2 * n + i]) / 3
}

/**
 * Refines the position of the nucleus near an estimated point, in pixels
 * of the frame itself.
 *
 * The nucleus is the brightest point of the coma. The local background
 * is removed (median of a surrounding ring), the maximum of the light
 * averaged over 3×3 pixels is found, then the centroid weighted by the
 * square of the light in a small circle around it: the square keeps the
 * centroid on the peak instead of letting it slide towards the tail,
 * where the coma is asymmetric. Returns null if there is nothing brighter
 * than the background there.
 */
export function refineNucleus(img: ImageData32, estimate: Point, radius: number): Point | null {
  const w = img.width
  const h = img.height
  const r = Math.max(2, Math.round(radius))
  const cx = Math.round(estimate.x)
  const cy = Math.round(estimate.y)
  if (cx < 1 || cy < 1 || cx > w - 2 || cy > h - 2) return null

  // Local background: median of the ring between r and 2r, sampled.
  const ring: number[] = []
  const r2 = 2 * r
  const step = Math.max(1, Math.floor(r / 4))
  for (let y = cy - r2; y <= cy + r2; y += step) {
    if (y < 0 || y >= h) continue
    for (let x = cx - r2; x <= cx + r2; x += step) {
      if (x < 0 || x >= w) continue
      const d = Math.hypot(x - cx, y - cy)
      if (d >= r && d <= r2) ring.push(light(img, x, y))
    }
  }
  const background = median(ring)

  // Maximum of the light averaged over 3×3 within the radius.
  let best = -Infinity
  let mx = cx
  let my = cy
  for (let y = Math.max(1, cy - r); y <= Math.min(h - 2, cy + r); y++) {
    for (let x = Math.max(1, cx - r); x <= Math.min(w - 2, cx + r); x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) continue
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += light(img, x + dx, y + dy)
      if (s > best) {
        best = s
        mx = x
        my = y
      }
    }
  }
  if (!(best / 9 > background)) return null

  // Centroid weighted by the square, in a small circle, repeated twice so
  // that the centre settles.
  const rc = Math.max(2, Math.round(r * 0.5))
  let px = mx
  let py = my
  for (let pass = 0; pass < 2; pass++) {
    let sw = 0
    let sx = 0
    let sy = 0
    const ix = Math.round(px)
    const iy = Math.round(py)
    for (let y = Math.max(0, iy - rc); y <= Math.min(h - 1, iy + rc); y++) {
      for (let x = Math.max(0, ix - rc); x <= Math.min(w - 1, ix + rc); x++) {
        if ((x - px) * (x - px) + (y - py) * (y - py) > rc * rc) continue
        const v = light(img, x, y) - background
        if (v <= 0) continue
        const weight = v * v
        sw += weight
        sx += weight * x
        sy += weight * y
      }
    }
    if (sw <= 0) break
    px = sx / sw
    py = sy / sw
  }
  return { x: px, y: py }
}

/** A frame as seen by the nucleus search. */
export interface FrameForNucleus {
  image: ImageData32
  /** Transformation from the frame to the reference, derived from the stars. */
  transformation: Transformation
  /** Mid-exposure time (hours), or the sequence number if the date is missing. */
  t: number
}

/** Where the nucleus is and how it moves. */
export interface NucleusResult {
  motion: NucleusMotion
  /** Position of the nucleus in each frame, in reference pixels. */
  positions: Point[]
  /** Typical deviation of the measurements from the uniform motion, in pixels. */
  rejection: number
  /** Frames in which the nucleus was measured and confirmed. */
  measured: number
}

/** Brings a point of the reference into the frame, and vice versa. */
function inFrame(t: Transformation, p: Point): Point {
  return applyTransform(invert(t), p.x, p.y)
}

/**
 * Refines the positions predicted by the motion with the centroid in each
 * frame, and redoes the motion on the measurements. Returns null if too
 * few measurements succeed.
 */
function refineMotion(frame: FrameForNucleus[], motion: NucleusMotion, radius: number): MotionFit | null {
  const measurements: { t: number; x: number; y: number }[] = []
  for (const f of frame) {
    const expected = nucleusPosition(motion, f.t)
    const q = refineNucleus(f.image, inFrame(f.transformation, expected), radius)
    if (!q) continue
    const r = applyTransform(f.transformation, q.x, q.y)
    measurements.push({ t: f.t, x: r.x, y: r.y })
  }
  if (measurements.length < Math.max(2, Math.ceil(frame.length * 0.3))) return null
  return fitMotion(measurements)
}

function resultFromMotion(frame: FrameForNucleus[], a: MotionFit): NucleusResult {
  return {
    motion: a.motion,
    positions: frame.map((f) => nucleusPosition(a.motion, f.t)),
    rejection: a.rejection,
    measured: a.kept.filter(Boolean).length
  }
}

/**
 * Nucleus from two points indicated by the user, one on the first and one
 * on the last frame (in pixels of those frames). Between the two it
 * interpolates in time, then each frame refines the position with the
 * centroid; if the refinement strays too far from the clicks (a coma
 * without an evident nucleus, a bright star nearby) the clicks are used.
 */
export function nucleusFromTwoPoints(
  frame: FrameForNucleus[],
  first: { index: number; point: Point },
  last: { index: number; point: Point }
): NucleusResult | { error: string } {
  const fa = frame[first.index]
  const fb = frame[last.index]
  if (!fa || !fb) return { error: t('coreComet.framesNotStacked') }
  if (Math.abs(fb.t - fa.t) < 1e-9) {
    return { error: t('coreComet.sameMoment') }
  }
  const pa = applyTransform(fa.transformation, first.point.x, first.point.y)
  const pb = applyTransform(fb.transformation, last.point.x, last.point.y)
  // The clicks themselves, refined with the centroid on their frames.
  const qa = refineNucleus(fa.image, first.point, 8)
  const qb = refineNucleus(fb.image, last.point, 8)
  const ra = qa ? applyTransform(fa.transformation, qa.x, qa.y) : pa
  const rb = qb ? applyTransform(fb.transformation, qb.x, qb.y) : pb
  const dt = fb.t - fa.t
  const fromClick: NucleusMotion = { t0: fa.t, x0: ra.x, y0: ra.y, vx: (rb.x - ra.x) / dt, vy: (rb.y - ra.y) / dt }

  let best: MotionFit = { motion: fromClick, rejection: 0, kept: [true, true] }
  const pass1 = refineMotion(frame, fromClick, 8)
  const pass2 = pass1 ? refineMotion(frame, pass1.motion, 5) : null
  if (pass2) {
    // The refinement is valid only if it stays close to the clicks at both ends.
    const far = Math.max(
      Math.hypot(nucleusPosition(pass2.motion, fa.t).x - ra.x, nucleusPosition(pass2.motion, fa.t).y - ra.y),
      Math.hypot(nucleusPosition(pass2.motion, fb.t).x - rb.x, nucleusPosition(pass2.motion, fb.t).y - rb.y)
    )
    if (far <= 6) best = pass2
  }
  return resultFromMotion(frame, best)
}

/** Mean brightness by blocks of `b`×`b` pixels, in the coordinates of the frame. */
function reduce(img: ImageData32, b: number): { w: number; h: number; data: Float32Array } {
  const w = Math.floor(img.width / b)
  const h = Math.floor(img.height / b)
  const data = new Float32Array(w * h)
  const W = img.width
  const N = W * img.height
  const channels = img.channels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let dy = 0; dy < b; dy++) {
        const row = (y * b + dy) * W + x * b
        for (let dx = 0; dx < b; dx++) {
          const i = row + dx
          s += channels === 1 ? img.data[i] : img.data[i] + img.data[N + i] + img.data[2 * N + i]
        }
      }
      data[y * w + x] = s / (b * b * channels)
    }
  }
  return { w, h, data }
}

/** 3×3 median of a grid (NaN outside the frame stays NaN). */
function median3x3(data: Float32Array, w: number, h: number): Float32Array {
  const output = new Float32Array(w * h).fill(NaN)
  const v = new Float32Array(9)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let k = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = data[(y + dy) * w + x + dx]
          if (q === q) v[k++] = q
        }
      }
      if (k < 9) continue
      v.sort()
      output[y * w + x] = v[4]
    }
  }
  return output
}

/**
 * Searches for the nucleus on its own, without help.
 *
 * After alignment on the stars, everything fixed in the sky stays still;
 * the comet does not. Work is done on reduced copies of the frames (about
 * 640 pixels per side), mapped onto the reference: the pixel-by-pixel
 * median across the frames is the fixed sky, and what in a frame stays
 * above it is the comet at that moment (plus noise, satellite residuals
 * and hot pixels, almost all removed by a 3×3 median). In each frame the
 * highest points are taken as candidates, and among all of them the line
 * covered at constant speed that brings the largest number into agreement
 * is searched for: a satellite or a defect does not move like that, the
 * comet does. Once the line is found, the position is refined at full
 * resolution with the centroid in each frame.
 */
export function findNucleus(
  frame: FrameForNucleus[],
  width: number,
  height: number
): NucleusResult | { error: string } {
  if (frame.length < 3) return { error: t('coreComet.needThreeFrames') }

  const b = Math.max(1, Math.ceil(Math.max(width, height) / 640))
  const wb = Math.floor(width / b)
  const hb = Math.floor(height / b)
  const nb = wb * hb

  // At most forty frames, distributed over the whole capture.
  const order = frame.map((_, i) => i).sort((p, q) => frame[p].t - frame[q].t)
  const count = Math.min(40, order.length)
  const chosenItems = Array.from({ length: count }, (_, k) =>
    order[Math.round((k * (order.length - 1)) / Math.max(1, count - 1))]
  )

  // Reduced copies, mapped onto the reduced grid of the reference.
  const grids: Float32Array[] = []
  for (const i of chosenItems) {
    const f = frame[i]
    const r = reduce(f.image, b)
    const inv = invert(f.transformation)
    const g = new Float32Array(nb).fill(NaN)
    for (let Y = 0; Y < hb; Y++) {
      for (let X = 0; X < wb; X++) {
        // Centre of the block in reference pixels, then in the frame, then
        // in blocks of the frame.
        const xr = (X + 0.5) * b - 0.5
        const yr = (Y + 0.5) * b - 0.5
        const sx = ((inv.a * xr - inv.b * yr + inv.tx) + 0.5) / b - 0.5
        const sy = ((inv.b * xr + inv.a * yr + inv.ty) + 0.5) / b - 0.5
        if (sx < 0 || sy < 0 || sx > r.w - 1 || sy > r.h - 1) continue
        const x0 = Math.floor(sx)
        const y0 = Math.floor(sy)
        const x1 = Math.min(r.w - 1, x0 + 1)
        const y1 = Math.min(r.h - 1, y0 + 1)
        const fx = sx - x0
        const fy = sy - y0
        const a0 = r.data[y0 * r.w + x0] + (r.data[y0 * r.w + x1] - r.data[y0 * r.w + x0]) * fx
        const a1 = r.data[y1 * r.w + x0] + (r.data[y1 * r.w + x1] - r.data[y1 * r.w + x0]) * fx
        g[Y * wb + X] = a0 + (a1 - a0) * fy
      }
    }
    grids.push(median3x3(g, wb, hb))
  }

  // Fixed sky: median across the frames, pixel by pixel.
  const fixed = new Float32Array(nb).fill(NaN)
  const values = new Float32Array(count)
  for (let i = 0; i < nb; i++) {
    let k = 0
    for (let f = 0; f < count; f++) {
      const v = grids[f][i]
      if (v === v) values[k++] = v
    }
    if (k < 3) continue
    const s = values.subarray(0, k).sort()
    fixed[i] = k % 2 === 1 ? s[k >> 1] : (s[(k >> 1) - 1] + s[k >> 1]) / 2
  }

  // Candidates in each frame: the local maxima of what lies above the
  // fixed sky, smoothed over 3×3 blocks.
  const candidates: { x: number; y: number; strength: number }[][] = []
  const difference = new Float32Array(nb)
  const soft = new Float32Array(nb)
  for (let f = 0; f < count; f++) {
    const g = grids[f]
    for (let i = 0; i < nb; i++) {
      const d = g[i] - fixed[i]
      difference[i] = d === d ? d : 0
    }
    soft.fill(0)
    for (let y = 1; y < hb - 1; y++) {
      for (let x = 1; x < wb - 1; x++) {
        let s = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += difference[(y + dy) * wb + x + dx]
        soft[y * wb + x] = s / 9
      }
    }
    // Typical noise of the difference, from the median absolute deviation.
    const samples: number[] = []
    const step = Math.max(1, Math.floor(nb / 20000))
    for (let i = 0; i < nb; i += step) samples.push(soft[i])
    const med = median(samples)
    const sigma = 1.4826 * median(samples.map((v) => Math.abs(v - med))) || 1e-6
    const here: { x: number; y: number; strength: number }[] = []
    for (let y = 3; y < hb - 3; y++) {
      for (let x = 3; x < wb - 3; x++) {
        const v = soft[y * wb + x]
        if (v < med + 5 * sigma) continue
        let max = true
        for (let dy = -2; dy <= 2 && max; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if ((dx !== 0 || dy !== 0) && soft[(y + dy) * wb + x + dx] > v) {
              max = false
              break
            }
          }
        }
        if (max) here.push({ x, y, strength: (v - med) / sigma })
      }
    }
    here.sort((p, q) => q.strength - p.strength)
    candidates.push(here.slice(0, 8))
  }

  // Consensus: two candidates, one at the start and one at the end of the
  // capture, fix a line; the one that passes close to a candidate in the
  // largest number of frames wins.
  const times = chosenItems.map((i) => frame[i].t)
  const third = Math.max(1, Math.floor(count / 3))
  const tolerance = 2.5
  let bestVotes = 0
  let bestStrength = 0
  let bestLine: { t0: number; x0: number; y0: number; vx: number; vy: number } | null = null
  for (let i = 0; i < Math.min(third, 10); i++) {
    for (let j = count - 1; j >= Math.max(count - third, count - 10); j--) {
      const dt = times[j] - times[i]
      if (Math.abs(dt) < 1e-9) continue
      for (const ci of candidates[i]) {
        for (const cj of candidates[j]) {
          const line = { t0: times[i], x0: ci.x, y0: ci.y, vx: (cj.x - ci.x) / dt, vy: (cj.y - ci.y) / dt }
          let votes = 0
          let strength = 0
          for (let f = 0; f < count; f++) {
            const px = line.x0 + line.vx * (times[f] - line.t0)
            const py = line.y0 + line.vy * (times[f] - line.t0)
            let neighbor: { strength: number } | null = null
            for (const c of candidates[f]) {
              if (Math.hypot(c.x - px, c.y - py) <= tolerance && (!neighbor || c.strength > neighbor.strength)) neighbor = c
            }
            if (neighbor) {
              votes++
              strength += neighbor.strength
            }
          }
          if (votes > bestVotes || (votes === bestVotes && strength > bestStrength)) {
            bestVotes = votes
            bestStrength = strength
            bestLine = line
          }
        }
      }
    }
  }

  if (!bestLine || bestVotes < Math.max(3, Math.ceil(count * 0.5))) {
    return {
      error: t('coreComet.notFoundAuto')
    }
  }

  // Positions of the candidates in agreement with the line, at full resolution.
  const measurements: { t: number; x: number; y: number }[] = []
  for (let f = 0; f < count; f++) {
    const r = bestLine
    const px = r.x0 + r.vx * (times[f] - r.t0)
    const py = r.y0 + r.vy * (times[f] - r.t0)
    let neighbor: { x: number; y: number; strength: number } | null = null
    for (const c of candidates[f]) {
      if (Math.hypot(c.x - px, c.y - py) <= tolerance && (!neighbor || c.strength > neighbor.strength)) neighbor = c
    }
    if (neighbor) measurements.push({ t: times[f], x: (neighbor.x + 0.5) * b - 0.5, y: (neighbor.y + 0.5) * b - 0.5 })
  }
  const raw = fitMotion(measurements)
  if (!raw) return { error: t('coreComet.nucleusNotMeasured') }

  // Refinement at full resolution on all the frames: first with a radius
  // as wide as a few blocks, then narrower.
  const pass1 = refineMotion(frame, raw.motion, Math.max(5, 2.5 * b)) ?? raw
  const pass2 = refineMotion(frame, pass1.motion, Math.max(3, 1.5 * b)) ?? pass1
  return resultFromMotion(frame, pass2)
}

/**
 * Transformation that aligns on the comet: the one on the stars, plus the
 * shift that brings the nucleus of the frame to where it is in the reference.
 */
export function transformationOnComet(
  t: Transformation,
  frameNucleus: Point,
  referenceNucleus: Point
): Transformation {
  return {
    a: t.a,
    b: t.b,
    tx: t.tx + referenceNucleus.x - frameNucleus.x,
    ty: t.ty + referenceNucleus.y - frameNucleus.y
  }
}

/**
 * The comet alone, without sky background and without stars, cropped
 * around coma and tail. Coordinates: reference pixels, with the nucleus
 * where it is in the reference.
 */
export interface CometLayer {
  x0: number
  y0: number
  width: number
  height: number
  channels: 1 | 3
  /** Channel by channel, rows of `width` values. */
  data: Float32Array
  /** Fraction of the image covered by the mask (for the summary). */
  area: number
}

/**
 * Sky background of a channel: second-degree surface fitted to the medians
 * of square cells, discarding the cells that are too bright (the coma, the
 * bright stars). A light-pollution gradient is smooth and the surface
 * follows it; the comet does not.
 */
function channelBackground(img: ImageData32, c: number): (x: number, y: number) => number {
  const w = img.width
  const h = img.height
  const base = (img.channels === 3 ? c : 0) * w * h
  const side = Math.max(16, Math.round(Math.min(w, h) / 20))
  const cells: { x: number; y: number; v: number }[] = []
  for (let y0 = 0; y0 + side <= h; y0 += side) {
    for (let x0 = 0; x0 + side <= w; x0 += side) {
      const v: number[] = []
      const step = Math.max(1, Math.floor(side / 12))
      for (let y = y0; y < y0 + side; y += step) {
        for (let x = x0; x < x0 + side; x += step) {
          const q = img.data[base + y * w + x]
          // Zero pixels are edges without data, not sky.
          if (q > 0) v.push(q)
        }
      }
      if (v.length > 10) cells.push({ x: (x0 + side / 2) / w - 0.5, y: (y0 + side / 2) / h - 0.5, v: median(v) })
    }
  }
  const terms = (x: number, y: number): number[] => [1, x, y, x * x, x * y, y * y]
  let coeff = [median(cells.map((q) => q.v)), 0, 0, 0, 0, 0]
  let usedItems = cells
  for (let pass = 0; pass < 4 && usedItems.length >= 8; pass++) {
    // Least squares with 6×6 normal equations.
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0))
    const B = new Array(6).fill(0)
    for (const q of usedItems) {
      const t = terms(q.x, q.y)
      for (let i = 0; i < 6; i++) {
        B[i] += t[i] * q.v
        for (let j = 0; j < 6; j++) A[i][j] += t[i] * t[j]
      }
    }
    const sol = solve(A, B)
    if (!sol) break
    coeff = sol
    const residuals = cells.map((q) => q.v - terms(q.x, q.y).reduce((s, t, i) => s + t * coeff[i], 0))
    const sigma = 1.4826 * median(residuals.map(Math.abs)) || 1e-6
    // Mostly the cells that are too high are discarded: that is where the comet is.
    usedItems = cells.filter((_, i) => residuals[i] < 2 * sigma && residuals[i] > -4 * sigma)
  }
  // Called for every pixel: no arrays are created in here.
  const [k0, k1, k2, k3, k4, k5] = coeff
  return (x: number, y: number): number => {
    const u = x / w - 0.5
    const v = y / h - 0.5
    return k0 + k1 * u + k2 * v + k3 * u * u + k4 * u * v + k5 * v * v
  }
}

/** Gaussian elimination with partial pivoting. */
function solve(A: number[][], B: number[]): number[] | null {
  const n = B.length
  const M = A.map((row, i) => [...row, B[i]])
  for (let k = 0; k < n; k++) {
    let p = k
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i
    if (Math.abs(M[p][k]) < 1e-14) return null
    ;[M[k], M[p]] = [M[p], M[k]]
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k]
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j]
    }
  }
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n]
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]
    x[i] = s / M[i][i]
  }
  return x
}

/** Separable box blur, in place. */
function boxBlur(data: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let k = 0
      for (let d = -r; d <= r; d++) {
        const xx = x + d
        if (xx < 0 || xx >= w) continue
        s += data[y * w + xx]
        k++
      }
      tmp[y * w + x] = s / k
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let k = 0
      for (let d = -r; d <= r; d++) {
        const yy = y + d
        if (yy < 0 || yy >= h) continue
        s += tmp[yy * w + x]
        k++
      }
      data[y * w + x] = s / k
    }
  }
}

/**
 * Derives the comet layer from the sum aligned on the comet.
 *
 * In that sum the stars, which move, have already been rejected: what
 * remains is the sky background plus the comet. The background is removed,
 * a soft mask is built around coma and tail (the bright area connected to
 * the nucleus, widened and feathered at the edges so that the seam is not
 * visible) and only what lies inside is kept.
 *
 * When the comet moves little, however, the stars are not entirely
 * rejected: at every point of their short path they appear in many frames
 * and remain as dashes. If they ended up in the layer, subtracted from the
 * frames and then put back on top, they would leave a dark shadow and a
 * bright echo next to each star. For this reason their dashes are erased
 * and filled with the surrounding coma before forming the layer.
 *
 * Stars are searched for in the reference frame after removing the comet
 * from it (which there is exactly where it is in the sum): searched for in
 * the frame as it is, a bright star inside the coma would merge with it
 * into a single blob and escape detection.
 *
 * @param reference the reference frame, in the same geometry
 * @param pathLength displacement of the nucleus (relative to the reference)
 *                in the first and in the last frame
 */
export function extractCometLayer(
  comet: ImageData32,
  nucleus: Point,
  reference?: ImageData32,
  pathLength?: { from: Point; a: Point }
): CometLayer {
  const w = comet.width
  const h = comet.height
  const channels = comet.channels
  const N = w * h
  const backgrounds = Array.from({ length: channels }, (_, c) => channelBackground(comet, c))

  // Mask on a reduced grid (about 800 pixels per side).
  const b = Math.max(1, Math.round(Math.max(w, h) / 800))
  const wb = Math.floor(w / b)
  const hb = Math.floor(h / b)
  const nb = wb * hb
  const remainder = new Float32Array(nb)
  for (let Y = 0; Y < hb; Y++) {
    for (let X = 0; X < wb; X++) {
      let s = 0
      for (let dy = 0; dy < b; dy++) {
        for (let dx = 0; dx < b; dx++) {
          const x = X * b + dx
          const y = Y * b + dy
          for (let c = 0; c < channels; c++) s += comet.data[c * N + y * w + x] - backgrounds[c](x, y)
        }
      }
      remainder[Y * wb + X] = s / (b * b * channels)
    }
  }
  boxBlur(remainder, wb, hb, 2)
  const samples: number[] = []
  const step = Math.max(1, Math.floor(nb / 30000))
  for (let i = 0; i < nb; i += step) samples.push(remainder[i])
  const med = median(samples)
  const sigma = 1.4826 * median(samples.map((v) => Math.abs(v - med))) || 1e-6

  // Area connected to the nucleus, above twice the noise.
  const threshold = med + 2 * sigma
  let sx = Math.min(wb - 1, Math.max(0, Math.round((nucleus.x + 0.5) / b - 0.5)))
  let sy = Math.min(hb - 1, Math.max(0, Math.round((nucleus.y + 0.5) / b - 0.5)))
  // If the seed falls just outside (small nucleus), the brightest point
  // within a few blocks is searched for.
  let vMax = -Infinity
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = sx + dx
      const y = sy + dy
      if (x < 0 || y < 0 || x >= wb || y >= hb) continue
      if (remainder[y * wb + x] > vMax) {
        vMax = remainder[y * wb + x]
        sx = x
        sy = y
      }
    }
  }
  const inside = new Uint8Array(nb)
  if (vMax > threshold) {
    const tail = [sy * wb + sx]
    inside[tail[0]] = 1
    while (tail.length > 0) {
      const i = tail.pop() as number
      const x = i % wb
      const y = (i - x) / wb
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= wb || yy >= hb) continue
          const j = yy * wb + xx
          if (inside[j] || remainder[j] <= threshold) continue
          inside[j] = 1
          tail.push(j)
        }
      }
    }
  }

  // Soft mask: widened by a few blocks, with a ramp on the signal (full
  // above five times the noise) and feathered at the edges.
  const widen = 4
  const widened = new Float32Array(nb)
  for (let i = 0; i < nb; i++) widened[i] = inside[i]
  boxBlur(widened, wb, hb, widen)
  const mask = new Float32Array(nb)
  let x0 = wb
  let y0 = hb
  let x1 = -1
  let y1 = -1
  for (let i = 0; i < nb; i++) {
    if (widened[i] <= 0) continue
    const ramp = Math.min(1, Math.max(0, (remainder[i] - med - sigma) / (4 * sigma)))
    mask[i] = Math.max(ramp, inside[i] ? 1 : 0) * Math.min(1, widened[i] * 3)
  }
  boxBlur(mask, wb, hb, 2)
  let area = 0
  for (let i = 0; i < nb; i++) {
    if (mask[i] < 0.002) {
      mask[i] = 0
      continue
    }
    area++
    const x = i % wb
    const y = (i - x) / wb
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  if (x1 < 0) return { x0: 0, y0: 0, width: 0, height: 0, channels, data: new Float32Array(0), area: 0 }

  // Layer at full resolution in the box of the mask.
  const X0 = Math.max(0, x0 * b - b)
  const Y0 = Math.max(0, y0 * b - b)
  const X1 = Math.min(w - 1, (x1 + 1) * b + b)
  const Y1 = Math.min(h - 1, (y1 + 1) * b + b)
  const lw = X1 - X0 + 1
  const lh = Y1 - Y0 + 1
  const nl = lw * lh

  // Comet without background in the box, then without the star dashes.
  const cleaned = new Float32Array(nl * channels)
  for (let y = Y0; y <= Y1; y++) {
    for (let x = X0; x <= X1; x++) {
      for (let c = 0; c < channels; c++) {
        cleaned[c * nl + (y - Y0) * lw + (x - X0)] = comet.data[c * N + y * w + x] - backgrounds[c](x, y)
      }
    }
  }
  if (reference && pathLength && reference.width === w && reference.height === h) {
    const withoutComet = new Float32Array(nl * channels)
    const refChannels = reference.channels
    for (let c = 0; c < channels; c++) {
      const cr = refChannels === 3 ? c : 0
      for (let y = Y0; y <= Y1; y++) {
        for (let x = X0; x <= X1; x++) {
          const i = c * nl + (y - Y0) * lw + (x - X0)
          withoutComet[i] = reference.data[cr * N + y * w + x] - cleaned[i]
        }
      }
    }
    const stars = detectStars({ width: lw, height: lh, channels: channels, data: withoutComet }).map((s) => ({
      x: s.x + X0,
      y: s.y + Y0,
      radius: starRadius(s)
    }))
    const covered = starTrailMask(stars, pathLength, nucleus, X0, Y0, lw, lh)
    fillFromEdges(cleaned, covered, lw, lh, channels)
  }

  const data = new Float32Array(nl * channels)
  for (let y = Y0; y <= Y1; y++) {
    const gy = Math.min(hb - 1, Math.max(0, (y + 0.5) / b - 0.5))
    const ya = Math.floor(gy)
    const yb = Math.min(hb - 1, ya + 1)
    const fy = gy - ya
    for (let x = X0; x <= X1; x++) {
      const gx = Math.min(wb - 1, Math.max(0, (x + 0.5) / b - 0.5))
      const xa = Math.floor(gx)
      const xb = Math.min(wb - 1, xa + 1)
      const fx = gx - xa
      const m0 = mask[ya * wb + xa] + (mask[ya * wb + xb] - mask[ya * wb + xa]) * fx
      const m1 = mask[yb * wb + xa] + (mask[yb * wb + xb] - mask[yb * wb + xa]) * fx
      const m = m0 + (m1 - m0) * fy
      if (m <= 0) continue
      for (let c = 0; c < channels; c++) {
        const i = c * nl + (y - Y0) * lw + (x - X0)
        const v = cleaned[i]
        data[i] = v > 0 ? v * m : 0
      }
    }
  }
  return { x0: X0, y0: Y0, width: lw, height: lh, channels, data, area: area / nb }
}

/** A star of the reference to erase from the comet layer. */
export interface StarToRemove {
  x: number
  y: number
  /** Radius to cover around the centre, in pixels. */
  radius: number
}

/**
 * Radius to cover for a detected star: wider for bright stars, whose halo
 * extends beyond the half-light radius.
 */
export function starRadius(s: { hfr: number; pixel: number }): number {
  return 1.5 + Math.max(2.5 * s.hfr, 1.5 * Math.sqrt(s.pixel / Math.PI))
}

/**
 * Pixels of the box covered by the star dashes in the sum aligned on the
 * comet. There a star fixed in the sky appears shifted by minus the
 * displacement of the nucleus: in each frame it is found at s − d, and d
 * goes from the first to the last frame along a line, so the dash is a
 * segment thickened by the radius of the star.
 * Nothing is erased around the nucleus, so as not to touch it.
 */
function starTrailMask(
  stars: StarToRemove[],
  pathLength: { from: Point; a: Point },
  nucleus: Point,
  X0: number,
  Y0: number,
  lw: number,
  lh: number
): Uint8Array {
  const covered = new Uint8Array(lw * lh)
  const respect = 5
  const length = Math.hypot(pathLength.a.x - pathLength.from.x, pathLength.a.y - pathLength.from.y)
  for (const s of stars) {
    // The "stars" found on the nucleus itself are the comet.
    if (Math.hypot(s.x - nucleus.x, s.y - nucleus.y) < 8) continue
    // On a path several times the length of the star, each pixel sees it in
    // few frames and rejection has already removed it: erasing and
    // rebuilding the coma there would do more harm than good.
    if (length > 5 * s.radius) continue
    const ax = s.x - pathLength.from.x
    const ay = s.y - pathLength.from.y
    const bx = s.x - pathLength.a.x
    const by = s.y - pathLength.a.y
    const r = s.radius
    const xmin = Math.max(X0, Math.floor(Math.min(ax, bx) - r))
    const xmax = Math.min(X0 + lw - 1, Math.ceil(Math.max(ax, bx) + r))
    const ymin = Math.max(Y0, Math.floor(Math.min(ay, by) - r))
    const ymax = Math.min(Y0 + lh - 1, Math.ceil(Math.max(ay, by) + r))
    if (xmin > xmax || ymin > ymax) continue
    const dx = bx - ax
    const dy = by - ay
    const l2 = dx * dx + dy * dy
    for (let y = ymin; y <= ymax; y++) {
      for (let x = xmin; x <= xmax; x++) {
        const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy)
        if (d > r) continue
        if (Math.hypot(x - nucleus.x, y - nucleus.y) < respect) continue
        covered[(y - Y0) * lw + (x - X0)] = 1
      }
    }
  }
  return covered
}

/**
 * Fills the covered pixels with the mean of the first free pixels found in
 * the eight directions, weighted by the inverse of the squared distance:
 * the coma is smooth, and it is rebuilt well from outside.
 */
function fillFromEdges(data: Float32Array, covered: Uint8Array, lw: number, lh: number, channels: number): void {
  const nl = lw * lh
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1]
  ]
  const values = new Float32Array(channels)
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      if (!covered[y * lw + x]) continue
      values.fill(0)
      let weights = 0
      for (const [ddx, ddy] of directions) {
        for (let k = 1; k <= 60; k++) {
          const xx = x + ddx * k
          const yy = y + ddy * k
          if (xx < 0 || yy < 0 || xx >= lw || yy >= lh) break
          const j = yy * lw + xx
          if (covered[j]) continue
          const dist = k * Math.hypot(ddx, ddy)
          const p = 1 / (dist * dist)
          for (let c = 0; c < channels; c++) values[c] += p * data[c * nl + j]
          weights += p
          break
        }
      }
      // Already filled pixels stay covered for the neighbours: the
      // reconstruction always uses the original values, not the invented ones.
      for (let c = 0; c < channels; c++) data[c * nl + y * lw + x] = weights > 0 ? values[c] / weights : 0
    }
  }
}

/** Value of the layer at any point (zero outside), bilinear. */
function sampleLayer(s: CometLayer, c: number, x: number, y: number): number {
  const lx = x - s.x0
  const ly = y - s.y0
  if (lx < 0 || ly < 0 || lx > s.width - 1 || ly > s.height - 1) return 0
  const xa = Math.floor(lx)
  const ya = Math.floor(ly)
  const xb = Math.min(s.width - 1, xa + 1)
  const yb = Math.min(s.height - 1, ya + 1)
  const fx = lx - xa
  const fy = ly - ya
  const base = c * s.width * s.height
  const d = s.data
  const a0 = d[base + ya * s.width + xa] + (d[base + ya * s.width + xb] - d[base + ya * s.width + xa]) * fx
  const a1 = d[base + yb * s.width + xa] + (d[base + yb * s.width + xb] - d[base + yb * s.width + xa]) * fx
  return a0 + (a1 - a0) * fy
}

/**
 * Removes the comet from a frame, in place: the layer is brought to where
 * the comet was in that frame and subtracted. The frame is left with only
 * the stars and the sky background, and the sum on the stars no longer
 * sees the moving comet.
 *
 * @param transformation from the frame to the reference, on the stars
 * @param shift nucleus of the frame minus nucleus of the reference, in
 *                    reference pixels
 */
export function subtractLayerFromFrame(
  frame: ImageData32,
  transformation: Transformation,
  shift: Point,
  layer: CometLayer,
  nightScale = 1
): void {
  if (layer.width === 0) return
  // The layer is in the units of the sum, that is of the reference night:
  // in a frame of another night, which the sum will multiply by
  // `nightScale` (see nights.ts), it must be removed divided by that factor.
  const factor = 1 / nightScale
  const w = frame.width
  const h = frame.height
  const N = w * h
  const inv = invert(transformation)
  // Box of the shifted layer, brought into the frame.
  const angles = [
    [layer.x0, layer.y0],
    [layer.x0 + layer.width, layer.y0],
    [layer.x0, layer.y0 + layer.height],
    [layer.x0 + layer.width, layer.y0 + layer.height]
  ].map(([x, y]) => applyTransform(inv, x + shift.x, y + shift.y))
  const fx0 = Math.max(0, Math.floor(Math.min(...angles.map((p) => p.x))) - 1)
  const fy0 = Math.max(0, Math.floor(Math.min(...angles.map((p) => p.y))) - 1)
  const fx1 = Math.min(w - 1, Math.ceil(Math.max(...angles.map((p) => p.x))) + 1)
  const fy1 = Math.min(h - 1, Math.ceil(Math.max(...angles.map((p) => p.y))) + 1)
  const channels = Math.min(frame.channels, layer.channels)
  for (let y = fy0; y <= fy1; y++) {
    for (let x = fx0; x <= fx1; x++) {
      const q = applyTransform(transformation, x, y)
      const sx = q.x - shift.x
      const sy = q.y - shift.y
      for (let c = 0; c < channels; c++) {
        const v = sampleLayer(layer, c, sx, sy)
        if (v !== 0) frame.data[c * N + y * w + x] -= v * factor
      }
    }
  }
}

/** Puts the comet layer back onto the sum aligned on the stars, in place. */
export function addLayer(image: ImageData32, layer: CometLayer): void {
  const w = image.width
  const N = w * image.height
  const channels = Math.min(image.channels, layer.channels)
  for (let y = 0; y < layer.height; y++) {
    const Y = layer.y0 + y
    if (Y < 0 || Y >= image.height) continue
    for (let x = 0; x < layer.width; x++) {
      const X = layer.x0 + x
      if (X < 0 || X >= w) continue
      for (let c = 0; c < channels; c++) {
        const i = c * N + Y * w + X
        const v = image.data[i] + layer.data[c * layer.width * layer.height + y * layer.width + x]
        image.data[i] = v > 1 ? 1 : v
      }
    }
  }
}

/**
 * True if the name declared in the file looks like that of a comet: the
 * official designations (C/2023 A3, 12P/Pons-Brooks, 2P, P/2019 LD2) or
 * the word itself. Only used to suggest the right mode.
 */
export function cometName(name: string | null): boolean {
  if (!name) return false
  const n = name.trim()
  return (
    /\b(comet|cometa|kometa|komet)\b/i.test(n) ||
    /^\s*[CPDXI]\/\d{4}\s*[A-Z]/i.test(n) ||
    /^\s*\d{1,4}[PD](\/|\s|$)/i.test(n)
  )
}
