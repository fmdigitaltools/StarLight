import type { ImageData32 } from '@shared/types'
import { MAD_TO_SIGMA } from './stats'

/**
 * Sky background extraction with radial basis functions (RBF).
 *
 * The sky is measured on a grid of samples: from each box a level that
 * stars do not shift is taken. Samples that fall on the object (a galaxy,
 * a nebula) must be rejected, otherwise the model chases them and the
 * subtraction eats the very thing that was meant to be photographed. The
 * rejection is iterative: a stiff surface is fitted to the accepted
 * samples, the amount by which each sample lies above the surface is
 * measured and those that are too bright are removed, until the set no
 * longer changes.
 *
 * A smoothing thin-plate spline is fitted to the remaining samples:
 * unlike a polynomial, it follows gradients of any shape (the Moon on one
 * side, the city on the other), and the smoothing keeps it from chasing
 * the noise of individual samples. The surface is computed on a reduced
 * grid and interpolated to full size: the background varies slowly and
 * the result does not change, but it costs a hundred times less.
 *
 * For each channel the model is subtracted and replaced by a single level,
 * equal for the three channels: the background becomes uniform and neutral.
 */

export interface RbfBackgroundParams {
  /** Samples along the long side, from 8 to 40; the short side in proportion. */
  samplesPerSide: number
  /** From 0 (the surface passes through the samples) to 1 (almost a tilted plane). */
  smoothness: number
  /** From 1 to 5 deviations: a sample brighter than the model beyond this threshold is object. */
  tolerance: number
}

export const DEFAULT_RBF_BACKGROUND: RbfBackgroundParams = {
  samplesPerSide: 20,
  smoothness: 0.5,
  tolerance: 2.5
}

/** A sky sample: normalized position and level of each channel. */
interface Sample {
  x: number
  y: number
  /** Sky level per channel. */
  v: number[]
  /** Pixel noise of the box per channel (robust deviation). */
  s: number[]
}

/** Thin-plate surface: kernel weights and affine part. */
interface Spline {
  cx: Float64Array
  cy: Float64Array
  weights: Float64Array
  /** a + b x + c y */
  affine: [number, number, number]
}

export function extractRbfBackground(
  img: ImageData32,
  p: RbfBackgroundParams,
  /**
   * If true, the result is written into the pixels of `img` instead of a new
   * image: the processing chain uses it on images that belong to it alone.
   * The result is the same.
   */
  inPlace = false
): { image: ImageData32; unevenness: number } {
  const w = img.width
  const h = img.height
  const n = w * h
  const c = img.channels
  const planes: Float32Array[] = []
  for (let k = 0; k < c; k++) planes.push(img.data.subarray(k * n, (k + 1) * n))

  const par = normalize(p)
  const samples = sample(planes, w, h, par.samplesPerSide)
  const copy = (): { image: ImageData32; unevenness: number } => ({
    image: { width: w, height: h, channels: c, data: inPlace ? img.data : img.data.slice() },
    unevenness: 0
  })
  if (samples.length < 12) return copy()

  const accepted = discardObject(samples, c, par)
  const sky = samples.filter((_, i) => accepted[i])
  if (sky.length < 8) return copy()

  const lambda = lambdaFrom(par.smoothness, sky.length)
  const models = fitSpline(sky, c, lambda)

  // Evaluation on a reduced grid, then bilinear interpolation.
  const side = Math.max(w, h)
  const step = Math.max(4, Math.round(side / 256))
  const nx = Math.ceil((w - 1) / step) + 1
  const ny = Math.ceil((h - 1) / step) + 1
  const grids = evaluateGrid(models, nx, ny, step, side)

  // Common level: the mean of the channel models over the whole field.
  const means = grids.map((g) => {
    let s = 0
    for (let i = 0; i < g.length; i++) s += g[i]
    return s / g.length
  })
  const common = means.reduce((a, b) => a + b, 0) / means.length

  let unevenness = 0
  for (const g of grids) {
    let minimum = Infinity
    let max = -Infinity
    for (let i = 0; i < g.length; i++) {
      if (g[i] < minimum) minimum = g[i]
      if (g[i] > max) max = g[i]
    }
    unevenness = Math.max(unevenness, ((max - minimum) / Math.max(common, 1e-9)) * 100)
  }

  // Each value depends only on the pixel at the same position: in place it
  // is read before being overwritten.
  const data = inPlace ? img.data : new Float32Array(n * c)
  for (let k = 0; k < c; k++) {
    const g = grids[k]
    const source = planes[k]
    const o = k * n
    for (let y = 0; y < h; y++) {
      const fy = y / step
      const gy = Math.min(ny - 2, Math.floor(fy))
      const ty = fy - gy
      const r0 = gy * nx
      const r1 = r0 + nx
      for (let x = 0; x < w; x++) {
        const fx = x / step
        const gx = Math.min(nx - 2, Math.floor(fx))
        const tx = fx - gx
        const a = g[r0 + gx] + (g[r0 + gx + 1] - g[r0 + gx]) * tx
        const b = g[r1 + gx] + (g[r1 + gx + 1] - g[r1 + gx]) * tx
        const f = a + (b - a) * ty
        const v = source[y * w + x] - f + common
        data[o + y * w + x] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
  }
  return { image: { width: w, height: h, channels: c, data }, unevenness }
}

/**
 * Chooses the parameters by measuring the image. The rejection is run with
 * the default values and the fraction of the field occupied by the object
 * is checked: if it is large (a galaxy filling the field, a diffuse
 * nebula) the sky samples are few and scattered, and the surface must be
 * stiffer so it does not swell in the gaps left by the object. Small
 * images need fewer samples: each box must contain enough pixels for a
 * reliable median. The tolerance stays at the default: the threshold is
 * already relative to the measured dispersion, and lowering it would
 * reject good sky.
 */
export function autoRbfBackground(img: ImageData32): RbfBackgroundParams {
  const w = img.width
  const h = img.height
  const n = w * h
  const planes: Float32Array[] = []
  for (let k = 0; k < img.channels; k++) planes.push(img.data.subarray(k * n, (k + 1) * n))
  const side = Math.max(w, h)
  const base: RbfBackgroundParams = {
    ...DEFAULT_RBF_BACKGROUND,
    samplesPerSide: side < 1200 ? 12 : side < 2400 ? 16 : DEFAULT_RBF_BACKGROUND.samplesPerSide
  }
  const samples = sample(planes, w, h, base.samplesPerSide)
  if (samples.length < 12) return { ...base }
  const accepted = discardObject(samples, img.channels, base)
  let count = 0
  for (const a of accepted) if (a) count++
  const busy = 1 - count / samples.length
  // Up to a quarter of the field occupied: default values; beyond that, stiffer.
  const t = Math.min(1, Math.max(0, (busy - 0.25) / 0.35))
  return {
    samplesPerSide: base.samplesPerSide,
    smoothness: Math.round((0.5 + 0.2 * t) * 100) / 100,
    tolerance: base.tolerance
  }
}

/**
 * Test helper: position of the samples (in pixels) and whether they were
 * accepted as sky or rejected as object.
 */
export function rbfBackgroundSamples(
  img: ImageData32,
  p: RbfBackgroundParams
): { x: number; y: number; sky: boolean }[] {
  const n = img.width * img.height
  const planes: Float32Array[] = []
  for (let k = 0; k < img.channels; k++) planes.push(img.data.subarray(k * n, (k + 1) * n))
  const par = normalize(p)
  const samples = sample(planes, img.width, img.height, par.samplesPerSide)
  if (samples.length < 12) return []
  const accepted = discardObject(samples, img.channels, par)
  const side = Math.max(img.width, img.height)
  return samples.map((s, i) => ({ x: s.x * side, y: s.y * side, sky: accepted[i] }))
}

function normalize(p: RbfBackgroundParams): RbfBackgroundParams {
  return {
    samplesPerSide: Math.round(Math.min(40, Math.max(8, p.samplesPerSide))),
    smoothness: Math.min(1, Math.max(0, p.smoothness)),
    tolerance: Math.min(5, Math.max(1, p.tolerance))
  }
}

/**
 * Weight of the smoothing in the spline. It grows exponentially with the
 * slider: at 0 the surface passes through the samples, at 1 the kernel
 * weights are almost zero and only the affine part remains, i.e. a tilted
 * plane. It is multiplied by the number of samples so that the perceived
 * stiffness does not change when the grid gets denser.
 */
function lambdaFrom(smoothness: number, samples: number): number {
  if (smoothness <= 0) return 0
  return samples * 1e-7 * Math.pow(10, 6 * smoothness)
}

/**
 * Grid sampling. Each box has a side equal to the distance between
 * samples; the level is a median with iterative rejection of high values,
 * which removes the stars, computed on a regular subsample of the pixels.
 * Boxes with many null pixels (the edges not covered by the stack) give no
 * samples.
 */
function sample(planes: Float32Array[], w: number, h: number, perSide: number): Sample[] {
  const side = Math.max(w, h)
  const columns = w >= h ? perSide : Math.max(4, Math.round((perSide * w) / h))
  const rows = h > w ? perSide : Math.max(4, Math.round((perSide * h) / w))
  const cw = w / columns
  const ch = h / rows
  // Box slightly smaller than the mesh: the samples stay distinct.
  const halfX = Math.max(2, Math.floor(cw * 0.4))
  const halfY = Math.max(2, Math.floor(ch * 0.4))
  const area = 4 * halfX * halfY
  const stepPx = Math.max(1, Math.floor(Math.sqrt(area / 1500)))
  const out: Sample[] = []
  const values = new Float32Array(Math.ceil((2 * halfX + 1) / stepPx + 1) * Math.ceil((2 * halfY + 1) / stepPx + 1))

  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < columns; q++) {
      const x0 = Math.round((q + 0.5) * cw)
      const y0 = Math.round((r + 0.5) * ch)
      const v: number[] = []
      const s: number[] = []
      let valid = true
      for (const p of planes) {
        let m = 0
        let nullValues = 0
        for (let yy = Math.max(0, y0 - halfY); yy < Math.min(h, y0 + halfY); yy += stepPx) {
          for (let xx = Math.max(0, x0 - halfX); xx < Math.min(w, x0 + halfX); xx += stepPx) {
            const val = p[yy * w + xx]
            if (val <= 0) nullValues++
            else values[m++] = val
          }
        }
        if (m < 20 || nullValues > 0.2 * (m + nullValues)) {
          valid = false
          break
        }
        const estimate = robustMedian(values, m)
        v.push(estimate.level)
        s.push(estimate.noise)
      }
      if (valid) out.push({ x: x0 / side, y: y0 / side, v, s })
    }
  }
  return out
}

/**
 * Median with rejection: repeated, removing the values beyond 2.5
 * deviations above and 4 below. The stars are all on the high side and the
 * median, recomputed without them, drops to the sky level. It also returns
 * the pixel noise of the box, which serves as the unit of measurement.
 */
function robustMedian(values: Float32Array, m: number): { level: number; noise: number } {
  let data = values.slice(0, m).sort()
  let median = data[data.length >> 1]
  let sigma = 0
  for (let pass = 0; pass < 4; pass++) {
    const rejections = new Float32Array(data.length)
    for (let i = 0; i < data.length; i++) rejections[i] = Math.abs(data[i] - median)
    rejections.sort()
    sigma = rejections[rejections.length >> 1] * MAD_TO_SIGMA
    if (sigma <= 0) break
    const bottom = median - 4 * sigma
    const top = median + 2.5 * sigma
    let i0 = 0
    while (i0 < data.length && data[i0] < bottom) i0++
    let i1 = data.length
    while (i1 > i0 && data[i1 - 1] > top) i1--
    if (i1 - i0 < 10 || (i0 === 0 && i1 === data.length)) break
    data = data.slice(i0, i1)
    median = data[data.length >> 1]
  }
  return { level: median, noise: sigma }
}

/**
 * Rejection of the samples that fall on the object.
 *
 * It starts from all the samples and fits a stiff surface (the same
 * spline, heavily smoothed): stiff so that it cannot bend onto a galaxy,
 * but able to follow a gradient. For each channel the deviation of every
 * sample from the surface is measured, in units of the robust dispersion
 * of the negative deviations (below the surface there is only sky); a
 * sample is object if in at least one channel it lies above by more than
 * the tolerance (hydrogen nebulae show up almost only in the red), or
 * far below (defects, edges). It is repeated until the set stabilizes.
 * The deviations are computed on all samples, so a sample removed by
 * mistake in the first round can come back in.
 *
 * So as not to leave the surface where the object pulls it up, in the
 * first round only the darker half of the samples relative to a plane
 * fitted to all of them is accepted: the linear gradient is not confused
 * with the object, and the following iterations recover the rest of the
 * sky.
 */
function discardObject(samples: Sample[], channels: number, p: RbfBackgroundParams): boolean[] {
  const nC = samples.length
  let accepted = new Array<boolean>(nC).fill(true)

  // First round: plane on all samples, keep the darker part.
  {
    const planes = Array.from({ length: channels }, (_, k) =>
      fitPlane(samples, samples.map((s) => s.v[k]))
    )
    // Deviations from the plane in units of their dispersion, channel by channel.
    const residuals = planes.map(([a, b, c], k) => samples.map((s) => s.v[k] - (a + b * s.x + c * s.y)))
    const scale = residuals.map((r) => {
      const center = median(r)
      return Math.max(1e-12, median(r.map((q) => Math.abs(q - center))))
    })
    const score = samples.map((_, i) => {
      let worst = -Infinity
      for (let k = 0; k < channels; k++) worst = Math.max(worst, residuals[k][i] / scale[k])
      return worst
    })
    const sortedItems = score.slice().sort((a, b) => a - b)
    const threshold = sortedItems[Math.floor(nC * 0.5)]
    accepted = score.map((v) => v <= threshold)
  }

  // Stiffness of the rejection surface: first very stiff, to separate the
  // object without bending onto it; then, with the object already removed,
  // softer (never less than the chosen one), to follow a curved gradient
  // such as one falling toward a corner. Few soft rounds: more would let
  // the faint halo of the object creep back in little by little.
  const hardPasses = 8
  const softPasses = 3
  let settled = false
  for (let pass = 0; pass < hardPasses + softPasses; pass++) {
    if (settled && pass < hardPasses) pass = hardPasses
    const sky = samples.filter((_, i) => accepted[i])
    if (sky.length < 8) break
    const stiffness = Math.max(
      p.smoothness,
      pass < hardPasses ? REJECTION_STIFFNESS : SOFT_REJECTION_STIFFNESS
    )
    const models = fitSpline(sky, channels, lambdaFrom(stiffness, sky.length))
    const newOnes = new Array<boolean>(nC).fill(true)
    for (let k = 0; k < channels; k++) {
      const s = models[k]
      const residuals = samples.map((q) => q.v[k] - evaluateSpline(s, q.x, q.y))
      // Dispersion measured only on the negative deviations: the object is
      // always above the sky, so below the surface there is only sky.
      // Measuring it on the accepted samples instead would make it shrink
      // at every round (the highest are removed, the dispersion drops, more
      // are removed) until good sky is rejected.
      const negatives = residuals.filter((r) => r < 0).map((r) => -r)
      const disp = median(negatives) * MAD_TO_SIGMA
      // On real images the dispersion of the sky around the model is a few
      // hundredths of the pixel noise, while a faint nebula lies a few
      // tenths above: the threshold separates them well. A minimum tied to
      // the pixel noise prevents the dispersion from going to zero on a
      // perfect sky, which would make every sample look like object.
      const pixelNoise = median(samples.map((q) => q.s[k]))
      const sigma = Math.max(disp, 0.01 * pixelNoise, 1e-9)
      for (let i = 0; i < nC; i++) {
        const z = residuals[i] / sigma
        // Below the surface only a conspicuous anomaly is rejected (a
        // stacking edge, a defect): the darker sky must be followed.
        if (z > p.tolerance || z < -8) newOnes[i] = false
      }
    }
    let changedItems = 0
    for (let i = 0; i < nC; i++) if (newOnes[i] !== accepted[i]) changedItems++
    accepted = newOnes
    if (changedItems === 0) {
      if (pass >= hardPasses) break
      settled = true
    }
  }
  return accepted
}

const REJECTION_STIFFNESS = 0.75
const SOFT_REJECTION_STIFFNESS = 0.5

function median(v: number[]): number {
  if (v.length === 0) return 0
  const o = v.slice().sort((a, b) => a - b)
  return o[o.length >> 1]
}

/** Least-squares plane a + b x + c y. */
function fitPlane(samples: Sample[], v: number[]): [number, number, number] {
  const a = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]
  for (let i = 0; i < samples.length; i++) {
    const t = [1, samples[i].x, samples[i].y]
    for (let r = 0; r < 3; r++) {
      for (let q = 0; q < 3; q++) a[r][q] += t[r] * t[q]
      a[r][3] += t[r] * v[i]
    }
  }
  const m = new Float64Array(12)
  for (let r = 0; r < 3; r++) for (let q = 0; q < 4; q++) m[r * 4 + q] = a[r][q]
  const solution = solve(m, 3, 1)
  if (!solution) return [v.reduce((s, q) => s + q, 0) / Math.max(1, v.length), 0, 0]
  const x = solution[0]
  return [x[0], x[1], x[2]]
}

/** Thin-plate kernel as a function of the squared distance: r² ln r. */
function nucleus(d2: number): number {
  return d2 > 1e-20 ? 0.5 * d2 * Math.log(d2) : 0
}

/**
 * Smoothing thin-plate spline: solves
 *   (K + λ I) w + P a = v,   Pᵀ w = 0
 * where K holds the kernels between the samples and P the affine part.
 * The system is small (at most a few hundred unknowns) and is solved by
 * elimination with partial pivoting. The matrix is the same for all the
 * channels, which differ only in the right-hand sides: a single
 * elimination solves them together.
 */
function fitSpline(samples: Sample[], channels: number, lambda: number): Spline[] {
  const m = samples.length
  const dim = m + 3
  const col = dim + channels
  const a = new Float64Array(dim * col)
  for (let i = 0; i < m; i++) {
    const xi = samples[i].x
    const yi = samples[i].y
    for (let j = 0; j < i; j++) {
      const dx = xi - samples[j].x
      const dy = yi - samples[j].y
      const k = nucleus(dx * dx + dy * dy)
      a[i * col + j] = k
      a[j * col + i] = k
    }
    a[i * col + i] = lambda
    a[i * col + m] = 1
    a[i * col + m + 1] = xi
    a[i * col + m + 2] = yi
    a[m * col + i] = 1
    a[(m + 1) * col + i] = xi
    a[(m + 2) * col + i] = yi
    for (let k = 0; k < channels; k++) a[i * col + dim + k] = samples[i].v[k]
  }
  const cx = new Float64Array(m)
  const cy = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    cx[i] = samples[i].x
    cy[i] = samples[i].y
  }
  const x = solve(a, dim, channels)
  const models: Spline[] = []
  for (let k = 0; k < channels; k++) {
    if (!x) {
      const plane = fitPlane(samples, samples.map((s) => s.v[k]))
      models.push({ cx, cy, weights: new Float64Array(m), affine: plane })
    } else {
      const s = x[k]
      models.push({ cx, cy, weights: s.subarray(0, m), affine: [s[m], s[m + 1], s[m + 2]] })
    }
  }
  return models
}

/**
 * Gaussian elimination with partial pivoting on an augmented matrix
 * dim × (dim + right-hand sides); returns one solution per right-hand side.
 */
function solve(a: Float64Array, dim: number, known: number): Float64Array[] | null {
  const col = dim + known
  for (let i = 0; i < dim; i++) {
    let anchor = i
    let max = Math.abs(a[i * col + i])
    for (let r = i + 1; r < dim; r++) {
      const v = Math.abs(a[r * col + i])
      if (v > max) {
        max = v
        anchor = r
      }
    }
    if (max < 1e-14) return null
    if (anchor !== i) {
      for (let q = i; q < col; q++) {
        const t = a[i * col + q]
        a[i * col + q] = a[anchor * col + q]
        a[anchor * col + q] = t
      }
    }
    const d = a[i * col + i]
    const oi = i * col
    for (let r = i + 1; r < dim; r++) {
      const or = r * col
      const f = a[or + i] / d
      if (f === 0) continue
      for (let q = i; q < col; q++) a[or + q] -= f * a[oi + q]
    }
  }
  const solutions: Float64Array[] = []
  for (let k = 0; k < known; k++) {
    const x = new Float64Array(dim)
    for (let i = dim - 1; i >= 0; i--) {
      let s = a[i * col + dim + k]
      for (let q = i + 1; q < dim; q++) s -= a[i * col + q] * x[q]
      x[i] = s / a[i * col + i]
    }
    solutions.push(x)
  }
  return solutions
}


function evaluateSpline(s: Spline, x: number, y: number): number {
  let v = s.affine[0] + s.affine[1] * x + s.affine[2] * y
  for (let j = 0; j < s.weights.length; j++) {
    const dx = x - s.cx[j]
    const dy = y - s.cy[j]
    v += s.weights[j] * nucleus(dx * dx + dy * dy)
  }
  return v
}

/**
 * Evaluates the channel models at the nodes of the reduced grid. The
 * samples are the same for all channels, so each kernel is computed once
 * and serves all of them.
 */
function evaluateGrid(
  models: Spline[],
  nx: number,
  ny: number,
  step: number,
  side: number
): Float32Array[] {
  const c = models.length
  const grids = models.map(() => new Float32Array(nx * ny))
  const base = models[0]
  const m = base.weights.length
  const sums = new Float64Array(c)
  for (let gy = 0; gy < ny; gy++) {
    // The last node may fall just outside the frame: the spline continues
    // smoothly and the mesh stays uniform for the interpolation.
    const y = (gy * step) / side
    for (let gx = 0; gx < nx; gx++) {
      const x = (gx * step) / side
      for (let k = 0; k < c; k++) {
        const a = models[k].affine
        sums[k] = a[0] + a[1] * x + a[2] * y
      }
      for (let j = 0; j < m; j++) {
        const dx = x - base.cx[j]
        const dy = y - base.cy[j]
        const f = nucleus(dx * dx + dy * dy)
        for (let k = 0; k < c; k++) sums[k] += models[k].weights[j] * f
      }
      for (let k = 0; k < c; k++) grids[k][gy * nx + gx] = sums[k]
    }
  }
  return grids
}
