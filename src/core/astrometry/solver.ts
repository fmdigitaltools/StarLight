import type { Wcs } from '@shared/types'

/**
 * Guided plate solving.
 *
 * Used for files whose header lacks the pixel-to-sky mapping: images
 * processed by the telescope, single frames, files from other instruments.
 * The header almost always says where the telescope was pointed (or the
 * object name) and at what scale, i.e. how many arcseconds a pixel covers.
 * With these two hints there is no need to search the whole sky: it is
 * enough to compare the image stars with those of a catalog around the
 * declared point (the local stars of the UCAC4 package or the online Gaia
 * catalog: the choice is made in solveSources.ts).
 *
 * Matching uses triangles formed by neighboring stars. The shape of a
 * triangle, described by the ratios of its sides, does not change if the
 * image is rotated, scaled or mirrored: two triangles with the same shape,
 * one in the image and one in the catalog, propose a match. Many proposals
 * are random; the right one is the only one that, applied to all stars,
 * makes many of them coincide with the catalog (RANSAC). Once the rough
 * match is found, hundreds of stars are paired and the final solution is
 * computed by least squares, including a small correction of the optical
 * distortion in the SIP convention, the same one telescopes write.
 *
 * The result is a `Wcs` identical to the one `readWcs` reads from the
 * header: markers and photometry use it without distinction.
 *
 * Conventions: detected stars have 0-based coordinates (the center of the
 * first pixel is 0,0), as returned by `detectStars`; the Wcs uses the FITS
 * convention, in which the first pixel is 1.
 */

const DEG_TO_RAD = Math.PI / 180

/** Catalog star: position in degrees and magnitude (lower = brighter). */
export interface CatalogStar {
  ra: number
  dec: number
  g: number
}

/** Star detected in the image, 0-based pixel coordinates. */
export interface ImageStar {
  x: number
  y: number
  flux: number
}

export interface SolveParams {
  /** Image dimensions in pixels. */
  width: number
  height: number
  /** Approximate position of the field center, in degrees (J2000). */
  ra: number
  dec: number
  /**
   * Estimated scale in arcseconds per pixel. Null if unknown: a wide range
   * is then tried, from `minScale` to `maxScale`.
   */
  scale: number | null
  /**
   * How far the true scale may deviate from the estimate, as a factor: 2.5
   * means from 1/2.5 to 2.5 times. Needed because the scale computed from
   * focal length and pixel size ignores any image upscaling (drizzle) or
   * pixel binning.
   */
  scaleFactor?: number
  /** Scale range tried when the scale is unknown. */
  minScale?: number
  maxScale?: number
  /** Maximum distance between the true and the declared center, in degrees. */
  positionUncertainty?: number
  /** Called at each attempt, to show progress (0 to 1). */
  progress?: (fraction: number) => void
}

export interface SolutionResult {
  wcs: Wcs
  /** Image stars matched to the catalog in the final solution. */
  matchedStars: number
  /** RMS residual between stars and catalog, in arcseconds. */
  residualArcsec: number
  /** Scale found, in arcseconds per pixel. */
  scale: number
  /** Position angle of north relative to the top of the image, in degrees. */
  rotation: number
  /** True if the image is mirrored relative to the sky as seen from Earth. */
  mirrored: boolean
  /** Degree of the distortion correction used (1 = none). */
  distortionDegree: number
}

// ---------------------------------------------------------------------------
// Gnomonic projection onto the tangent plane
// ---------------------------------------------------------------------------

/**
 * Sky -> plane tangent at (ra0, dec0), in arcseconds: xi grows toward
 * east, eta toward north. Null for points behind the plane.
 */
export function project(
  ra: number,
  dec: number,
  ra0: number,
  dec0: number
): [number, number] | null {
  const a = ra * DEG_TO_RAD
  const d = dec * DEG_TO_RAD
  const a0 = ra0 * DEG_TO_RAD
  const d0 = dec0 * DEG_TO_RAD
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0)
  if (cosc <= 0.1) return null
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc
  const age = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc
  return [(xi / DEG_TO_RAD) * 3600, (age / DEG_TO_RAD) * 3600]
}

/** Tangent plane (arcseconds) -> sky, inverse of `project`. */
export function deproject(
  xi: number,
  age: number,
  ra0: number,
  dec0: number
): { ra: number; dec: number } {
  const x = (xi / 3600) * DEG_TO_RAD
  const y = (age / 3600) * DEG_TO_RAD
  const a0 = ra0 * DEG_TO_RAD
  const d0 = dec0 * DEG_TO_RAD
  const r = Math.hypot(x, y)
  if (r === 0) return { ra: ra0, dec: dec0 }
  const c = Math.atan(r)
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (y * Math.sin(c) * Math.cos(d0)) / r)
  const ra =
    a0 + Math.atan2(x * Math.sin(c), r * Math.cos(d0) * Math.cos(c) - y * Math.sin(d0) * Math.sin(c))
  return { ra: (((ra / DEG_TO_RAD) % 360) + 360) % 360, dec: dec / DEG_TO_RAD }
}

// ---------------------------------------------------------------------------
// Precession: coordinates "of date" -> J2000
// ---------------------------------------------------------------------------

/**
 * Converts coordinates referred to the equinox of a date to the J2000
 * equinox (IAU 1976 model). Many smart telescopes write the position "of
 * date" in the header, which in 2026 differs from the catalog position by
 * about a third of a degree: not enough to prevent the solution, but
 * correcting it narrows the search.
 */
export function precessToJ2000(ra: number, dec: number, isoDate: string): { ra: number; dec: number } {
  const ms = Date.parse(isoDate.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(isoDate) ? isoDate : isoDate + 'Z')
  if (!Number.isFinite(ms)) return { ra, dec }
  // Julian centuries since J2000 (1 January 2000, 12:00 TT).
  const t = (ms - Date.UTC(2000, 0, 1, 12)) / (86400000 * 36525)
  const s = DEG_TO_RAD / 3600
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) * s
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) * s
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) * s
  const a = ra * DEG_TO_RAD - z
  const d = dec * DEG_TO_RAD
  const A = Math.cos(d) * Math.sin(a)
  const B = Math.cos(theta) * Math.cos(d) * Math.cos(a) + Math.sin(theta) * Math.sin(d)
  const C = -Math.sin(theta) * Math.cos(d) * Math.cos(a) + Math.cos(theta) * Math.sin(d)
  const ra0 = Math.atan2(A, B) - zeta
  return { ra: (((ra0 / DEG_TO_RAD) % 360) + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, C))) / DEG_TO_RAD }
}

// ---------------------------------------------------------------------------
// Geometric tools
// ---------------------------------------------------------------------------

/** Affine transformation image plane -> tangent plane: p' = M p + t. */
interface Affine {
  m: [number, number, number, number]
  t: [number, number]
}

function apply(T: Affine, x: number, y: number): [number, number] {
  return [T.m[0] * x + T.m[1] * y + T.t[0], T.m[2] * x + T.m[3] * y + T.t[1]]
}

/**
 * Least-squares similarity (rotation, scale, translation, optionally a
 * mirror) between point pairs. Also returns the maximum residual, to
 * discard inconsistent proposals immediately.
 */
function similarity(
  from: [number, number][],
  a: [number, number][],
  mirrored: boolean
): { T: Affine; maxResidual: number } {
  const n = from.length
  let mx = 0, my = 0, mX = 0, mY = 0
  for (let i = 0; i < n; i++) {
    mx += from[i][0]; my += mirrored ? -from[i][1] : from[i][1]
    mX += a[i][0]; mY += a[i][1]
  }
  mx /= n; my /= n; mX /= n; mY /= n
  let sxx = 0, sa = 0, sb = 0
  for (let i = 0; i < n; i++) {
    const x = from[i][0] - mx
    const y = (mirrored ? -from[i][1] : from[i][1]) - my
    const X = a[i][0] - mX
    const Y = a[i][1] - mY
    sxx += x * x + y * y
    sa += x * X + y * Y
    sb += x * Y - y * X
  }
  const p = sxx > 0 ? sa / sxx : 0
  const q = sxx > 0 ? sb / sxx : 0
  // With the mirror, y enters with its sign flipped.
  const m: [number, number, number, number] = mirrored ? [p, q, q, -p] : [p, -q, q, p]
  const tx = mX - (m[0] * mx + m[1] * (mirrored ? -my : my))
  const ty = mY - (m[2] * mx + m[3] * (mirrored ? -my : my))
  const T: Affine = { m, t: [tx, ty] }
  let maxResidual = 0
  for (let i = 0; i < n; i++) {
    const [X, Y] = apply(T, from[i][0], from[i][1])
    maxResidual = Math.max(maxResidual, Math.hypot(X - a[i][0], Y - a[i][1]))
  }
  return { T, maxResidual }
}

/** Grid for fast neighbor lookup over a set of points in the plane. */
class Grid {
  private cells = new Map<number, number[]>()
  constructor(
    private points: [number, number][],
    private side: number
  ) {
    points.forEach((p, i) => {
      const k = this.key(Math.floor(p[0] / side), Math.floor(p[1] / side))
      const c = this.cells.get(k)
      if (c) c.push(i)
      else this.cells.set(k, [i])
    })
  }
  private key(cx: number, cy: number): number {
    return (cx + 50000) * 100000 + (cy + 50000)
  }
  /** Index of the nearest point within the radius (at most the cell side), or -1. */
  neighbor(x: number, y: number, radius: number): { index: number; distance: number } {
    const cx = Math.floor(x / this.side)
    const cy = Math.floor(y / this.side)
    let best = -1
    let dMin = radius
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = this.cells.get(this.key(cx + dx, cy + dy))
        if (!c) continue
        for (const i of c) {
          const d = Math.hypot(this.points[i][0] - x, this.points[i][1] - y)
          if (d < dMin) {
            dMin = d
            best = i
          }
        }
      }
    }
    return { index: best, distance: dMin }
  }
}

// ---------------------------------------------------------------------------
// Triangles of neighboring stars
// ---------------------------------------------------------------------------

interface Triangle {
  /** Vertices, sorted by increasing length of the opposite side. */
  v: [number, number, number]
  /** Shape: short side / long side and middle side / long side. */
  r1: number
  r2: number
  /** Long side, for the scale check. */
  long: number
}

/** Number of neighboring stars combined around each star. */
const NEIGHBORS = 5

/**
 * Triangles formed by each star with its nearest neighbors. Using the
 * neighbors, rather than every combination, keeps the count small and the
 * triangles small, hence little affected by distortion.
 */
function triangles(points: [number, number][]): Triangle[] {
  const n = points.length
  const seenItems = new Set<string>()
  const result: Triangle[] = []
  for (let i = 0; i < n; i++) {
    const nearby = points
      .map((p, j) => ({ j, d: Math.hypot(p[0] - points[i][0], p[1] - points[i][1]) }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, NEIGHBORS)
      .map((o) => o.j)
    const group = [i, ...nearby]
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        for (let c = b + 1; c < group.length; c++) {
          const three = [group[a], group[b], group[c]].sort((p, q) => p - q)
          const key = three.join(',')
          if (seenItems.has(key)) continue
          seenItems.add(key)
          const t = describeTriangle(points, three[0], three[1], three[2])
          if (t) result.push(t)
        }
      }
    }
  }
  return result
}

function describeTriangle(points: [number, number][], i: number, j: number, k: number): Triangle | null {
  const d = (p: number, q: number): number =>
    Math.hypot(points[p][0] - points[q][0], points[p][1] - points[q][1])
  // Each side is associated with the opposite vertex.
  const sides = [
    { side: d(j, k), opposing: i },
    { side: d(i, k), opposing: j },
    { side: d(i, j), opposing: k }
  ].sort((a, b) => a.side - b.side)
  const long = sides[2].side
  if (long <= 0) return null
  const r1 = sides[0].side / long
  const r2 = sides[1].side / long
  // Nearly flat triangles: the shape is unreliable.
  if (r1 + r2 < 1.05 || r1 < 0.1) return null
  return { v: [sides[0].opposing, sides[1].opposing, sides[2].opposing], r1, r2, long }
}

// ---------------------------------------------------------------------------
// Polynomial least squares (fine solution and distortion)
// ---------------------------------------------------------------------------

/** Solves the linear system A x = b (A square) by Gaussian elimination. */
function solveSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-14) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((r, i) => r[n] / M[i][i])
}

/** Exponents (i, j) of the terms u^i v^j with minDegree <= i+j <= maxDegree. */
function terms(minDegree: number, maxDegree: number): [number, number][] {
  const t: [number, number][] = []
  for (let g = minDegree; g <= maxDegree; g++) for (let i = g; i >= 0; i--) t.push([i, g - i])
  return t
}

/** Scale of pixel coordinates in the polynomials: avoids huge numbers in the powers. */
const NORM = 1000

/**
 * Least-squares fit of z ~ sum c_ij u^i v^j. Returns the coefficients
 * already converted back to unnormalized coordinates.
 */
function fitPolynomial(
  u: number[],
  v: number[],
  z: number[],
  exponents: [number, number][]
): number[] | null {
  const m = exponents.length
  const A = Array.from({ length: m }, () => new Array<number>(m).fill(0))
  const b = new Array<number>(m).fill(0)
  const row = new Array<number>(m)
  for (let k = 0; k < u.length; k++) {
    const one = u[k] / NORM
    const vn = v[k] / NORM
    for (let p = 0; p < m; p++) row[p] = one ** exponents[p][0] * vn ** exponents[p][1]
    for (let p = 0; p < m; p++) {
      b[p] += row[p] * z[k]
      for (let q = 0; q < m; q++) A[p][q] += row[p] * row[q]
    }
  }
  const c = solveSystem(A, b)
  if (!c) return null
  return c.map((x, p) => x / NORM ** (exponents[p][0] + exponents[p][1]))
}

function evaluate(coeff: number[], exponents: [number, number][], u: number, v: number): number {
  let s = 0
  for (let p = 0; p < coeff.length; p++) s += coeff[p] * u ** exponents[p][0] * v ** exponents[p][1]
  return s
}

// ---------------------------------------------------------------------------
// Rough match search
// ---------------------------------------------------------------------------

/** Image stars used for the triangles: the brightest ones. */
const IMAGE_STARS = 45
/** Minimum number of image stars for the triangles, even with a sparse catalog. */
const MIN_IMAGE_STARS = 15
/** Tolerance on triangle shape (difference of side ratios). */
const SHAPE_TOLERANCE = 0.012
/** Minimum matches for a proposal to be credible. */
const MIN_MATCHED = 10

interface Proposal {
  T: Affine
  matched: number
}

/**
 * Searches for the pixel -> tangent plane similarity that matches the most
 * stars, with a scale (arcseconds per pixel) between scaleMin and scaleMax.
 */
function findMatch(
  image: [number, number][],
  catalogPlane: [number, number][],
  scaleMin: number,
  scaleMax: number
): Proposal | null {
  const imgTri = triangles(image)
  const catTri = triangles(catalogPlane)
  if (imgTri.length === 0 || catTri.length === 0) return null

  // Grid over the shape of the catalog triangles.
  const side = SHAPE_TOLERANCE
  const cells = new Map<number, Triangle[]>()
  const key = (a: number, b: number): number => a * 10000 + b
  for (const t of catTri) {
    const k = key(Math.floor(t.r1 / side), Math.floor(t.r2 / side))
    const c = cells.get(k)
    if (c) c.push(t)
    else cells.set(k, [t])
  }

  const grid = new Grid(catalogPlane, Math.max(4, scaleMax * 4))
  // The explicit type with `as` prevents TypeScript, which does not see the
  // assignment inside the loops, from narrowing it to null.
  let best = null as Proposal | null

  for (const ti of imgTri) {
    const ci = Math.floor(ti.r1 / side)
    const cj = Math.floor(ti.r2 / side)
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = cells.get(key(ci + di, cj + dj))
        if (!list) continue
        for (const tc of list) {
          if (Math.abs(tc.r1 - ti.r1) > side || Math.abs(tc.r2 - ti.r2) > side) continue
          const s = tc.long / ti.long
          if (s < scaleMin || s > scaleMax) continue
          const from = ti.v.map((i) => image[i])
          const a = tc.v.map((i) => catalogPlane[i])
          for (const mirrored of [false, true]) {
            const { T, maxResidual } = similarity(from, a, mirrored)
            // Matching tolerance in the plane: three pixels, at least 3".
            const tolerance = Math.max(3, s * 3)
            if (maxResidual > tolerance) continue
            let matched = 0
            for (const p of image) {
              const [X, Y] = apply(T, p[0], p[1])
              if (grid.neighbor(X, Y, tolerance).index >= 0) matched++
            }
            if (!best || matched > best.matched) best = { T, matched }
          }
        }
      }
    }
    // A proposal matching more than half of the stars is certainly the
    // right one: no point in searching further.
    if (best && best.matched >= image.length * 0.6) break
  }
  return best && best.matched >= MIN_MATCHED ? best : null
}

// ---------------------------------------------------------------------------
// Fine solution
// ---------------------------------------------------------------------------

interface Pair {
  /** FITS pixel relative to the reference point. */
  u: number
  v: number
  ra: number
  dec: number
}

/**
 * Matches each image star to the nearest catalog star according to the
 * current transformation, keeping only the closest match for each catalog
 * star.
 */
function match(
  image: ImageStar[],
  catalogPlane: [number, number][],
  prediction: (x: number, y: number) => [number, number],
  tolerance: number
): { i: number; c: number; d: number }[] {
  const grid = new Grid(catalogPlane, Math.max(tolerance, 1))
  const perCatalog = new Map<number, { i: number; c: number; d: number }>()
  image.forEach((s, i) => {
    const [X, Y] = prediction(s.x, s.y)
    const { index, distance } = grid.neighbor(X, Y, tolerance)
    if (index < 0) return
    const already = perCatalog.get(index)
    if (!already || distance < already.d) perCatalog.set(index, { i, c: index, d: distance })
  })
  return [...perCatalog.values()]
}

interface Model {
  crval: [number, number]
  crpix: [number, number]
  /** Coefficients of the polynomials xi(u,v), eta(u,v) in arcseconds, terms of degree 1..degree. */
  cx: number[]
  cy: number[]
  exponents: [number, number][]
  degree: number
  rejection: number
  usedItems: number
}

/** Model prediction: FITS pixel -> plane tangent at its crval (arcsec). */
function predict(m: Model, xFits: number, yFits: number): [number, number] {
  const u = xFits - m.crpix[0]
  const v = yFits - m.crpix[1]
  return [evaluate(m.cx, m.exponents, u, v), evaluate(m.cy, m.exponents, u, v)]
}

/**
 * Fits the model to the pairs: a polynomial of the requested degree, with
 * the reference point (crval) moved until it falls exactly on the image
 * center (crpix). Three iterations are enough: the shift shrinks by several
 * orders of magnitude each time. Pairs with a residual above three times
 * the RMS are rejected.
 */
function fitModel(
  pairs: Pair[],
  crval: [number, number],
  crpix: [number, number],
  degree: number
): Model | null {
  const exponents = terms(1, degree)
  const exponentsWithConstant = terms(0, degree)
  let active = pairs
  let center = crval
  let model: Model | null = null
  for (let pass = 0; pass < 4; pass++) {
    const u: number[] = []
    const v: number[] = []
    const X: number[] = []
    const Y: number[] = []
    for (const c of active) {
      const p = project(c.ra, c.dec, center[0], center[1])
      if (!p) continue
      u.push(c.u)
      v.push(c.v)
      X.push(p[0])
      Y.push(p[1])
    }
    if (u.length < exponentsWithConstant.length * 3) return null
    const last = pass === 3
    const es = last ? exponents : exponentsWithConstant
    const cx = fitPolynomial(u, v, X, es)
    const cy = fitPolynomial(u, v, Y, es)
    if (!cx || !cy) return null
    if (!last) {
      // The constant term tells where the center falls: the reference goes there.
      center = (({ ra, dec }) => [ra, dec] as [number, number])(deproject(cx[0], cy[0], center[0], center[1]))
      // Rejection of outlier pairs, with this iteration's model.
      const residuals = u.map((_, k) =>
        Math.hypot(evaluate(cx, es, u[k], v[k]) - X[k], evaluate(cy, es, u[k], v[k]) - Y[k])
      )
      const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length)
      if (u.length === active.length) active = active.filter((_, k) => residuals[k] <= Math.max(3 * rms, 0.3))
      continue
    }
    let sum = 0
    for (let k = 0; k < u.length; k++) {
      sum += (evaluate(cx, es, u[k], v[k]) - X[k]) ** 2 + (evaluate(cy, es, u[k], v[k]) - Y[k]) ** 2
    }
    model = {
      crval: center,
      crpix,
      cx,
      cy,
      exponents,
      degree,
      // Per-coordinate residual corrected for the model's degrees of freedom.
      rejection: Math.sqrt(sum / Math.max(1, u.length - es.length)),
      usedItems: u.length
    }
  }
  return model
}

/**
 * Converts the polynomial model to the WCS format: CD matrix (the linear
 * part) and SIP coefficients A, B (the rest, converted to pixels). The
 * inverse polynomial AP, BP, used to place objects quickly, is obtained by
 * fitting it on a grid of image points.
 */
function modelToWcs(m: Model, width: number, height: number): Wcs {
  const il = m.exponents.findIndex(([i, j]) => i === 1 && j === 0)
  const jl = m.exponents.findIndex(([i, j]) => i === 0 && j === 1)
  const cd: [[number, number], [number, number]] = [
    [m.cx[il] / 3600, m.cx[jl] / 3600],
    [m.cy[il] / 3600, m.cy[jl] / 3600]
  ]
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]
  const cdInverse: [[number, number], [number, number]] = [
    [cd[1][1] / det, -cd[0][1] / det],
    [-cd[1][0] / det, cd[0][0] / det]
  ]
  const a = new Map<string, number>()
  const b = new Map<string, number>()
  const ap = new Map<string, number>()
  const bp = new Map<string, number>()

  if (m.degree >= 2) {
    // Nonlinear terms, converted to pixels through the inverse of CD.
    m.exponents.forEach(([i, j], p) => {
      if (i + j < 2) return
      const xi = m.cx[p] / 3600
      const age = m.cy[p] / 3600
      a.set(i + '_' + j, cdInverse[0][0] * xi + cdInverse[0][1] * age)
      b.set(i + '_' + j, cdInverse[1][0] * xi + cdInverse[1][1] * age)
    })
    // Inverse polynomial on a grid extending slightly beyond the image.
    const esInv = terms(1, Math.min(4, m.degree + 1))
    const U: number[] = []
    const V: number[] = []
    const du: number[] = []
    const dv: number[] = []
    const steps = 24
    for (let gx = 0; gx <= steps; gx++) {
      for (let gy = 0; gy <= steps; gy++) {
        const u = (-0.1 + (1.2 * gx) / steps) * width + 1 - m.crpix[0]
        const v = (-0.1 + (1.2 * gy) / steps) * height + 1 - m.crpix[1]
        let su = 0
        let sv = 0
        for (const [k, c] of a) {
          const [i, j] = k.split('_').map(Number)
          su += c * u ** i * v ** j
        }
        for (const [k, c] of b) {
          const [i, j] = k.split('_').map(Number)
          sv += c * u ** i * v ** j
        }
        U.push(u + su)
        V.push(v + sv)
        du.push(-su)
        dv.push(-sv)
      }
    }
    const cu = fitPolynomial(U, V, du, esInv)
    const cv = fitPolynomial(U, V, dv, esInv)
    if (cu && cv) {
      esInv.forEach(([i, j], p) => {
        ap.set(i + '_' + j, cu[p])
        bp.set(i + '_' + j, cv[p])
      })
    }
  }

  return {
    crval: [m.crval[0], m.crval[1]],
    crpix: [m.crpix[0], m.crpix[1]],
    cd,
    cdInverse,
    a,
    b,
    ap,
    bp,
    naxis1: width,
    naxis2: height
  }
}

// ---------------------------------------------------------------------------
// Hints from the header
// ---------------------------------------------------------------------------

/**
 * `detectStars` parameters suited to solving: large and saturated stars
 * are accepted too, since in upscaled (drizzle) images they easily exceed
 * 600 pixels and are precisely the brightest ones in the catalog.
 */
export const SOLVER_DETECTION = { max: 500, threshold: 5, maxPixels: 4000 }

/** Limiting magnitude of the Gaia query: with the 2000-star cap it matters little. */
export const SOLVER_MAGNITUDE = 16

export interface FieldEstimate {
  /** Approximate center (J2000), in degrees. */
  ra: number
  dec: number
  /** Source of the position: header coordinates or object name. */
  origin: 'coordinates' | 'name'
  /** Estimated scale in arcseconds per pixel, null if unknown. */
  scale: number | null
  /** Radius to query from the catalog, in degrees. */
  radius: number
  magnitude: number
}

/**
 * Derives the starting point of the solution from the metadata: where the
 * telescope was pointed and at what scale. Null if the header gives
 * neither coordinates nor a known object: the field is then not solved
 * (a blind all-sky search is a different problem).
 *
 * Header coordinates are treated as "of date" and precessed to J2000 when
 * the file declares no equinox: that is what smart telescopes write, and
 * even if the file were already in J2000 the error (a third of a degree)
 * stays within the allowed uncertainty.
 */
export function fieldEstimate(
  metadata: {
    ra: number | null
    dec: number | null
    object: string | null
    pixelScale: number | null
    dateObs: string | null
  },
  width: number,
  height: number,
  findObject: (name: string) => { ra: number; dec: number } | null = () => null,
  equinox: number | null = null
): FieldEstimate | null {
  let ra: number | null = null
  let dec: number | null = null
  let origin: FieldEstimate['origin'] = 'coordinates'
  if (metadata.ra !== null && metadata.dec !== null && Number.isFinite(metadata.ra) && Number.isFinite(metadata.dec)) {
    ra = metadata.ra
    dec = metadata.dec
    if (equinox === null && metadata.dateObs) {
      ;({ ra, dec } = precessToJ2000(ra, dec, metadata.dateObs))
    } else if (equinox !== null && Math.abs(equinox - 2000) > 0.5) {
      const year = Math.floor(equinox)
      ;({ ra, dec } = precessToJ2000(ra, dec, new Date(Date.UTC(year, 0, 1) + (equinox - year) * 3.15576e10).toISOString()))
    }
  } else if (metadata.object) {
    const o = findObject(metadata.object)
    if (o) {
      ra = o.ra
      dec = o.dec
      origin = 'name'
    }
  }
  if (ra === null || dec === null) return null
  const scale = metadata.pixelScale !== null && metadata.pixelScale > 0 ? metadata.pixelScale : null
  // Without a scale, a field with a two-degree radius is requested: it
  // covers telephoto lenses and the most common telescopes.
  const radius = scale !== null ? searchRadius(width, height, scale) : 2
  return { ra, dec, origin, scale, radius: Math.min(5, radius), magnitude: SOLVER_MAGNITUDE }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Catalog radius to request around the estimated center, in degrees: half
 * the field diagonal plus the pointing uncertainty.
 */
export function searchRadius(
  width: number,
  height: number,
  scale: number,
  positionUncertainty = DEFAULT_UNCERTAINTY
): number {
  return (Math.hypot(width, height) / 2) * (scale / 3600) + positionUncertainty
}

/** Default uncertainty of the declared position, in degrees. */
export const DEFAULT_UNCERTAINTY = 0.5

/**
 * Solves the field. `stars` are those detected in the image (brightest
 * first, as returned by `detectStars`), `catalog` the catalog stars around
 * the estimated center. Returns null if no match is convincing enough: no
 * solution is better than a wrong one.
 */
export function solveField(
  stars: ImageStar[],
  catalog: CatalogStar[],
  p: SolveParams
): SolutionResult | null {
  const W = p.width
  const H = p.height
  const uncertainty = p.positionUncertainty ?? DEFAULT_UNCERTAINTY
  if (stars.length < MIN_MATCHED || catalog.length < MIN_MATCHED) return null

  // Scales to try: the estimated one first, then progressively farther ones.
  const factor = p.scaleFactor ?? 2.5
  const scaleMin = p.scale !== null ? p.scale / factor : (p.minScale ?? 0.3)
  const scaleMax = p.scale !== null ? p.scale * factor : (p.maxScale ?? 30)
  const central = p.scale ?? Math.sqrt(scaleMin * scaleMax)
  const attempts: number[] = [central]
  for (let k = 1; k < 12; k++) {
    for (const s of [central * 1.6 ** k, central / 1.6 ** k]) {
      if (s >= scaleMin / 1.25 && s <= scaleMax * 1.25) attempts.push(s)
    }
  }

  // Catalog on the plane tangent at the estimated center, brightest first.
  const sortedValue = [...catalog].sort((a, b) => a.g - b.g)
  const plane: { s: CatalogStar; p: [number, number] }[] = []
  for (const s of sortedValue) {
    const q = project(s.ra, s.dec, p.ra, p.dec)
    if (q) plane.push({ s, p: q })
  }

  const image = stars.slice(0, IMAGE_STARS).map((s) => [s.x, s.y] as [number, number])

  let proposal: Proposal | null = null
  for (let k = 0; k < attempts.length && !proposal; k++) {
    p.progress?.(k / attempts.length)
    const s = attempts[k]
    // Number of catalog stars proportional to the area: the density must
    // resemble that of the stars taken from the image, or the neighbor
    // triangles would not correspond.
    const radius = searchRadius(W, H, s, uncertainty) * 3600
    const circleArea = Math.PI * radius * radius
    const imageArea = W * H * s * s
    const count = Math.round(
      Math.min(700, Math.max(image.length, (image.length * circleArea) / imageArea))
    )
    const choices = plane.filter((o) => Math.hypot(o.p[0], o.p[1]) <= radius).slice(0, count)
    if (choices.length < MIN_MATCHED) continue
    // A magnitude-limited catalog (the local stars reach magnitude 12) may
    // have fewer stars in the field than those taken from the image: then
    // only the brightest image stars are used, as many as the catalog has
    // in the same area, so that neighbor triangles correspond. With a deep
    // enough catalog (complete selection) nothing changes.
    const imageStars =
      choices.length < count
        ? image.slice(
            0,
            Math.max(MIN_IMAGE_STARS, Math.min(image.length, Math.round((choices.length * imageArea) / circleArea)))
          )
        : image
    proposal = findMatch(
      imageStars,
      choices.map((o) => o.p),
      s / 1.3,
      s * 1.3
    )
  }
  p.progress?.(1)
  if (!proposal) return null

  // --- Fine solution ---
  // Start from the similarity found: loose matches first, then tighter
  // ones as the model improves.
  const pointsPlane = plane.map((o) => o.p)
  const starsPlane = plane.map((o) => o.s)
  const crpix: [number, number] = [(W + 1) / 2, (H + 1) / 2]
  const T = proposal.T
  const roughScale = Math.sqrt(Math.abs(T.m[0] * T.m[3] - T.m[1] * T.m[2]))
  let prediction = (x: number, y: number): [number, number] => apply(T, x, y)
  let model: Model | null = null
  const tolerances = [5, 3, 2, 2]
  for (const tolerancePx of tolerances) {
    const matches = match(stars, pointsPlane, prediction, tolerancePx * roughScale)
    const pairs: Pair[] = matches.map(({ i, c }) => ({
      u: stars[i].x + 1 - crpix[0],
      v: stars[i].y + 1 - crpix[1],
      ra: starsPlane[c].ra,
      dec: starsPlane[c].dec
    }))
    // Choose the distortion degree that actually reduces the residual.
    let chosen: Model | null = null
    for (const degree of [1, 2, 3]) {
      if (pairs.length < (degree === 1 ? 6 : degree === 2 ? 30 : 80)) break
      const m = fitModel(pairs, [p.ra, p.dec], crpix, degree)
      if (!m) continue
      if (!chosen || m.rejection < chosen.rejection * 0.9) chosen = m
    }
    if (!chosen) return null
    model = chosen
    const mFixed = chosen
    // The model works on the plane tangent at its own center: to compare it
    // with the catalog (projected on the estimated center) the mapping
    // goes through the sky.
    prediction = (x: number, y: number): [number, number] => {
      const [xi, age] = predict(mFixed, x + 1, y + 1)
      const sky = deproject(xi, age, mFixed.crval[0], mFixed.crval[1])
      return project(sky.ra, sky.dec, p.ra, p.dec) ?? [1e9, 1e9]
    }
  }
  if (!model || model.usedItems < MIN_MATCHED) return null

  const wcs = modelToWcs(model, W, H)
  const scale = Math.sqrt(Math.abs(wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0])) * 3600
  // A residual above one and a half pixels indicates a wrong solution.
  if (model.rejection > Math.max(1.5 * scale, 2)) return null

  const det = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0]
  // Direction of north in the image (increasing rows = downward).
  const northX = wcs.cdInverse[0][1]
  const northY = wcs.cdInverse[1][1]
  const rotation = (((Math.atan2(northX, -northY) / DEG_TO_RAD) % 360) + 360) % 360

  return {
    wcs,
    matchedStars: model.usedItems,
    residualArcsec: model.rejection,
    scale,
    rotation,
    // With rows running top to bottom, the "upright" sky (north up, east
    // left) has a positive determinant.
    mirrored: det < 0,
    distortionDegree: model.degree
  }
}
