/**
 * NL-Bayes noise reduction (Lebrun, Buades, Morel, "A Nonlocal Bayesian
 * Image Denoising Algorithm", SIAM J. Imaging Sciences 2013; IPOL 2013).
 *
 * For each small block (patch), the most similar patches are searched in
 * the neighborhood: in an astronomical image the sky, the arms of a
 * galaxy or the edge of a nebula repeat themselves, while the noise is
 * different every time. From the group, the mean patch and the way the
 * patches vary together (covariance) are estimated, and each patch is
 * rebuilt keeping the part of the variation that the group shares, i.e.
 * the structure, and discarding the part that the noise explains.
 *
 * There are two passes: the first produces a baseline estimate; the
 * second searches for similarities and measures the covariance on that
 * already cleaned estimate, but reconstructs from the original data.
 * Uniform areas (the sky) are recognized because the group varies less
 * than the noise, and there the mean is used directly.
 *
 * It works on a single plane (the brightness). To use several cores, the
 * image is split into horizontal strips with an overlap margin, each
 * processed by a worker.
 */

/** Patch side in pixels. */
const K = 5
const D = K * K
/** Radius of the area in which similar patches are searched. */
const SEARCH_RADIUS = 8
/** Distance between reference patches. */
const STEP = 3
/** Patches per group. */
const GROUP = 30
/** An area is uniform if the group varies less than this multiple of the noise. */
const GAMMA = 1.05

/** Overlap rows between strips: the search must not see the cut. */
export const STRIP_MARGIN = SEARCH_RADIUS + K + 3

/** Cleans a whole plane (or a strip) with the two passes. */
export function nlBayes(plane: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0 || w < K || h < K) return plane.slice()
  const base = runPass(plane, null, w, h, sigma)
  return runPass(plane, base, w, h, sigma)
}

/** In-place Cholesky factorization; false if the matrix is not positive definite. */
function cholesky(a: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let s = a[j * n + j]
    for (let k = 0; k < j; k++) s -= a[j * n + k] * a[j * n + k]
    if (s <= 1e-30) return false
    const l = Math.sqrt(s)
    a[j * n + j] = l
    for (let i = j + 1; i < n; i++) {
      let t = a[i * n + j]
      for (let k = 0; k < j; k++) t -= a[i * n + k] * a[j * n + k]
      a[i * n + j] = t / l
    }
  }
  return true
}

/** Solves L·Lᵀ·x = b, overwriting b with x. */
function solve(l: Float64Array, n: number, b: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= l[i * n + k] * b[k]
    b[i] = s / l[i * n + i]
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]
    for (let k = i + 1; k < n; k++) s -= l[k * n + i] * b[k]
    b[i] = s / l[i * n + i]
  }
}

/** Positions of the reference patches along one side, including the last one. */
function grid(length: number): number[] {
  const p: number[] = []
  for (let v = 0; v <= length - K; v += STEP) p.push(v)
  if (p[p.length - 1] !== length - K) p.push(length - K)
  return p
}

function runPass(
  noisyInput: Float32Array,
  base: Float32Array | null,
  w: number,
  h: number,
  sigma: number
): Float32Array {
  const guide = base ?? noisyInput
  const num = new Float64Array(w * h)
  const den = new Float64Array(w * h)
  const wasUsed = new Uint8Array(w * h)
  const s2 = sigma * sigma
  const side = 2 * SEARCH_RADIUS + 1
  const distances = new Float64Array(side * side)
  const indices = new Int32Array(side * side)
  const P = new Float64Array(GROUP * D)
  const B = new Float64Array(GROUP * D)
  const m = new Float64Array(D)
  const mb = new Float64Array(D)
  const C = new Float64Array(D * D)
  const Cb = new Float64Array(D * D)
  const v = new Float64Array(D)
  const positions = new Int32Array(GROUP)

  for (const py of grid(h)) {
    for (const px of grid(w)) {
      const pr = py * w + px
      // A patch already reconstructed in a previous group is not used as a reference.
      if (wasUsed[pr]) continue

      let count = 0
      const y0 = Math.max(0, py - SEARCH_RADIUS)
      const y1 = Math.min(h - K, py + SEARCH_RADIUS)
      const x0 = Math.max(0, px - SEARCH_RADIUS)
      const x1 = Math.min(w - K, px + SEARCH_RADIUS)
      for (let qy = y0; qy <= y1; qy++) {
        for (let qx = x0; qx <= x1; qx++) {
          const q = qy * w + qx
          let d = 0
          for (let a = 0; a < K; a++) {
            const o1 = pr + a * w
            const o2 = q + a * w
            for (let b = 0; b < K; b++) {
              const t = guide[o1 + b] - guide[o2 + b]
              d += t * t
            }
          }
          distances[count] = d
          indices[count] = q
          count++
        }
      }
      const n = Math.min(GROUP, count)
      nearest(distances, indices, count, n)

      m.fill(0)
      mb.fill(0)
      for (let i = 0; i < n; i++) {
        const q = indices[i]
        positions[i] = q
        for (let a = 0; a < K; a++) {
          for (let b = 0; b < K; b++) {
            const j = a * K + b
            const value = noisyInput[q + a * w + b]
            P[i * D + j] = value
            m[j] += value
            if (base) {
              const vb = base[q + a * w + b]
              B[i * D + j] = vb
              mb[j] += vb
            }
          }
        }
      }
      for (let j = 0; j < D; j++) {
        m[j] /= n
        mb[j] /= n
      }

      // Uniform area: the group varies less than the noise, so the mean is used.
      const source = base ? B : P
      let sum = 0
      let sum2 = 0
      for (let i = 0; i < n * D; i++) {
        sum += source[i]
        sum2 += source[i] * source[i]
      }
      const mean = sum / (n * D)
      const variance = sum2 / (n * D) - mean * mean
      if (variance < GAMMA * s2) {
        let mp = 0
        for (let i = 0; i < n * D; i++) mp += P[i]
        mp /= n * D
        for (let i = 0; i < n * D; i++) P[i] = mp
      } else {
        // Group covariance: on the data in the first pass, on the baseline in the second.
        const S = base ? B : P
        const ms = base ? mb : m
        C.fill(0)
        for (let i = 0; i < n; i++) {
          for (let a = 0; a < D; a++) {
            const from = S[i * D + a] - ms[a]
            for (let b = 0; b <= a; b++) C[a * D + b] += from * (S[i * D + b] - ms[b])
          }
        }
        const norm = Math.max(1, n - 1)
        for (let a = 0; a < D; a++) {
          for (let b = 0; b <= a; b++) {
            C[a * D + b] /= norm
            C[b * D + a] = C[a * D + b]
          }
        }
        if (!base) {
          // Baseline estimate: Q − σ²·C⁻¹·(Q − m).
          for (let a = 0; a < D; a++) C[a * D + a] += s2 * 1e-3
          if (cholesky(C, D)) {
            for (let i = 0; i < n; i++) {
              for (let j = 0; j < D; j++) v[j] = P[i * D + j] - m[j]
              solve(C, D, v)
              for (let j = 0; j < D; j++) P[i * D + j] -= s2 * v[j]
            }
          }
        } else {
          // Final estimate: m + Cb·(Cb + σ²I)⁻¹·(Q − m).
          Cb.set(C)
          for (let a = 0; a < D; a++) C[a * D + a] += s2
          if (cholesky(C, D)) {
            for (let i = 0; i < n; i++) {
              for (let j = 0; j < D; j++) v[j] = P[i * D + j] - m[j]
              solve(C, D, v)
              for (let a = 0; a < D; a++) {
                let s = 0
                for (let b = 0; b < D; b++) s += Cb[a * D + b] * v[b]
                P[i * D + a] = m[a] + s
              }
            }
          }
        }
      }

      // Each patch of the group contributes to the average of its pixels.
      for (let i = 0; i < n; i++) {
        const q = positions[i]
        wasUsed[q] = 1
        for (let a = 0; a < K; a++) {
          for (let b = 0; b < K; b++) {
            num[q + a * w + b] += P[i * D + a * K + b]
            den[q + a * w + b] += 1
          }
        }
      }
    }
  }

  const output = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) output[i] = den[i] > 0 ? num[i] / den[i] : noisyInput[i]
  return output
}

/**
 * Moves the n smallest distances (with their indices) to the front, in
 * any order: a partial selection is enough, a full sort is not needed.
 */
function nearest(d: Float64Array, idx: Int32Array, count: number, n: number): void {
  let left = 0
  let right = count - 1
  while (left < right) {
    const anchor = d[(left + right) >> 1]
    let i = left
    let j = right
    while (i <= j) {
      while (d[i] < anchor) i++
      while (d[j] > anchor) j--
      if (i <= j) {
        const td = d[i]
        d[i] = d[j]
        d[j] = td
        const ti = idx[i]
        idx[i] = idx[j]
        idx[j] = ti
        i++
        j--
      }
    }
    if (n - 1 <= j) right = j
    else if (n - 1 >= i) left = i
    else break
  }
}
