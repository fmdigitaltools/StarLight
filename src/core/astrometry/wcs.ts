import type { FitsHeader, Wcs } from '@shared/types'

/**
 * Astrometric solution (WCS) read from a FITS header.
 *
 * Many smart telescopes and most astrophotography software write the
 * pixel-to-sky mapping into the stacked image: a gnomonic (TAN) projection
 * with a small polynomial correction for optical distortion (SIP
 * convention). With it, the position of a catalog object in the image is
 * computed rather than estimated.
 *
 * This module reads the coefficients and offers both transformations,
 * sky -> pixel (to place an object) and pixel -> sky (for verification).
 * Pixels follow the FITS convention: 1 is the first, and row 1 is the
 * first one stored in the file, i.e. the one StarLight shows at the top.
 */

const DEG_TO_RAD = Math.PI / 180

export type { Wcs }

/** SIP polynomial coefficients, keyed by degree i,j. */
type Poly = Map<string, number>

function num(header: FitsHeader, key: string): number | null {
  const v = header.cards[key]
  return typeof v === 'number' ? v : null
}

/** Collects the coefficients of a SIP family (e.g. A_i_j). */
function readPoly(header: FitsHeader, prefix: string): Poly {
  const poly: Poly = new Map()
  // Double backslashes: inside a string '\d' would become 'd' and the SIP
  // coefficients would never be recognized.
  const re = new RegExp('^' + prefix + '_(\\d+)_(\\d+)$')
  for (const key of header.order) {
    const m = key.match(re)
    if (m) {
      const v = header.cards[key]
      if (typeof v === 'number' && v !== 0) poly.set(m[1] + '_' + m[2], v)
    }
  }
  return poly
}

/** Sums the SIP polynomial terms at point (u, v). */
function evaluatePoly(poly: Poly, u: number, v: number): number {
  let sum = 0
  for (const [degree, coeff] of poly) {
    const [i, j] = degree.split('_').map(Number)
    sum += coeff * u ** i * v ** j
  }
  return sum
}

/**
 * Reads the solution from the header. Returns null if it is missing or if
 * the projection is not the gnomonic one supported here.
 */
export function readWcs(header: FitsHeader): Wcs | null {
  const ctype1 = header.cards['CTYPE1']
  if (typeof ctype1 !== 'string' || !ctype1.includes('TAN')) return null

  const crval1 = num(header, 'CRVAL1')
  const crval2 = num(header, 'CRVAL2')
  const crpix1 = num(header, 'CRPIX1')
  const crpix2 = num(header, 'CRPIX2')
  const cd11 = num(header, 'CD1_1')
  const cd12 = num(header, 'CD1_2')
  const cd21 = num(header, 'CD2_1')
  const cd22 = num(header, 'CD2_2')
  if (
    crval1 === null || crval2 === null || crpix1 === null || crpix2 === null ||
    cd11 === null || cd12 === null || cd21 === null || cd22 === null
  ) {
    return null
  }

  const det = cd11 * cd22 - cd12 * cd21
  if (Math.abs(det) < 1e-30) return null
  const cdInverse: [[number, number], [number, number]] = [
    [cd22 / det, -cd12 / det],
    [-cd21 / det, cd11 / det]
  ]

  return {
    crval: [crval1, crval2],
    crpix: [crpix1, crpix2],
    cd: [[cd11, cd12], [cd21, cd22]],
    cdInverse,
    a: readPoly(header, 'A'),
    b: readPoly(header, 'B'),
    ap: readPoly(header, 'AP'),
    bp: readPoly(header, 'BP'),
    naxis1: num(header, 'NAXIS1') ?? 0,
    naxis2: num(header, 'NAXIS2') ?? 0
  }
}

/** Image scale in arcseconds per pixel, from the CD coefficients. */
export function scaleArcsec(wcs: Wcs): number {
  return Math.hypot(wcs.cd[0][0], wcs.cd[1][0]) * 3600
}

/**
 * Pixel -> sky (gnomonic projection with forward SIP distortion). Mainly
 * used for verification: transforming a known pixel checks that the
 * coordinates match.
 */
export function pixelToSky(wcs: Wcs, x: number, y: number): { ra: number; dec: number } {
  const u = x - wcs.crpix[0]
  const v = y - wcs.crpix[1]
  const uu = u + evaluatePoly(wcs.a, u, v)
  const vv = v + evaluatePoly(wcs.b, u, v)

  // Intermediate coordinates on the tangent plane, in radians.
  const xi = (wcs.cd[0][0] * uu + wcs.cd[0][1] * vv) * DEG_TO_RAD
  const age = (wcs.cd[1][0] * uu + wcs.cd[1][1] * vv) * DEG_TO_RAD

  const ra0 = wcs.crval[0] * DEG_TO_RAD
  const dec0 = wcs.crval[1] * DEG_TO_RAD
  const r = Math.hypot(xi, age)
  const c = Math.atan(r)
  const dec =
    r === 0
      ? dec0
      : Math.asin(Math.cos(c) * Math.sin(dec0) + (age * Math.sin(c) * Math.cos(dec0)) / r)
  const ra =
    ra0 +
    Math.atan2(
      xi * Math.sin(c),
      r * Math.cos(dec0) * Math.cos(c) - age * Math.sin(dec0) * Math.sin(c)
    )

  return { ra: ((ra / DEG_TO_RAD) % 360 + 360) % 360, dec: dec / DEG_TO_RAD }
}

/**
 * Sky -> pixel (1 = first pixel). Returns null if the point falls behind
 * the projection plane, i.e. beyond the gnomonic horizon.
 */
export function skyToPixel(wcs: Wcs, ra: number, dec: number): { x: number; y: number } | null {
  const ra0 = wcs.crval[0] * DEG_TO_RAD
  const dec0 = wcs.crval[1] * DEG_TO_RAD
  const raR = ra * DEG_TO_RAD
  const decR = dec * DEG_TO_RAD

  // Forward gnomonic projection: sky -> tangent plane (degrees).
  const cosc = Math.sin(dec0) * Math.sin(decR) + Math.cos(dec0) * Math.cos(decR) * Math.cos(raR - ra0)
  if (cosc <= 0) return null
  const xi = (Math.cos(decR) * Math.sin(raR - ra0)) / cosc / DEG_TO_RAD
  const age =
    (Math.cos(dec0) * Math.sin(decR) - Math.sin(dec0) * Math.cos(decR) * Math.cos(raR - ra0)) /
    cosc /
    DEG_TO_RAD

  // Tangent plane -> undistorted pixels, through the inverse of CD.
  const up = wcs.cdInverse[0][0] * xi + wcs.cdInverse[0][1] * age
  const vp = wcs.cdInverse[1][0] * xi + wcs.cdInverse[1][1] * age

  // Inverse distortion (AP/BP). When absent, the polynomials are empty and
  // change nothing.
  const u = up + evaluatePoly(wcs.ap, up, vp)
  const v = vp + evaluatePoly(wcs.bp, up, vp)

  return { x: u + wcs.crpix[0], y: v + wcs.crpix[1] }
}

/**
 * Position of an object in the image, in coordinates normalized from 0 to
 * 1 with the origin at the top left: the same system StarLight draws the
 * image in. Null if it falls too far outside the field.
 */
export function normalizedPosition(
  wcs: Wcs,
  ra: number,
  dec: number,
  margin = 0.1
): { x: number; y: number } | null {
  if (wcs.naxis1 <= 0 || wcs.naxis2 <= 0) return null
  const pixel = skyToPixel(wcs, ra, dec)
  if (pixel === null) return null
  const nx = (pixel.x - 0.5) / wcs.naxis1
  const ny = (pixel.y - 0.5) / wcs.naxis2
  if (nx < -margin || nx > 1 + margin || ny < -margin || ny > 1 + margin) return null
  return { x: nx, y: ny }
}

/**
 * Builds a solution from its numbers, computing the inverse of CD. Used by
 * code that produces a new image (mosaic, drizzle) and must give it its
 * own mapping to the sky. Null if the matrix is not invertible.
 */
export function buildWcs(p: {
  crval: [number, number]
  crpix: [number, number]
  cd: [[number, number], [number, number]]
  naxis1: number
  naxis2: number
  a?: Map<string, number>
  b?: Map<string, number>
  ap?: Map<string, number>
  bp?: Map<string, number>
}): Wcs | null {
  const [[c11, c12], [c21, c22]] = p.cd
  const det = c11 * c22 - c12 * c21
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null
  return {
    crval: [p.crval[0], p.crval[1]],
    crpix: [p.crpix[0], p.crpix[1]],
    cd: [[c11, c12], [c21, c22]],
    cdInverse: [
      [c22 / det, -c12 / det],
      [-c21 / det, c11 / det]
    ],
    a: new Map(p.a ?? []),
    b: new Map(p.b ?? []),
    ap: new Map(p.ap ?? []),
    bp: new Map(p.bp ?? []),
    naxis1: p.naxis1,
    naxis2: p.naxis2
  }
}

/**
 * The solution of an image enlarged `factor` times along both axes, like
 * the drizzle output: same sky, smaller pixels.
 *
 * The left edge of the first pixel (0.5 in FITS convention) stays in
 * place, so CRPIX' = (CRPIX - 0.5) × factor + 0.5. The CD matrix is
 * divided by the factor. SIP polynomials work in pixels: a term of degree
 * i + j, measured on the fine grid, is factor^(1 - i - j) times the
 * original (the output offset is multiplied by the factor, the input
 * coordinates are divided).
 */
export function wcsScale(wcs: Wcs, factor: number): Wcs {
  const polyScale = (poly: Poly): Poly => {
    const newValue: Poly = new Map()
    for (const [degree, coeff] of poly) {
      const [i, j] = degree.split('_').map(Number)
      newValue.set(degree, coeff * factor ** (1 - i - j))
    }
    return newValue
  }
  const k = 1 / factor
  return {
    crval: [wcs.crval[0], wcs.crval[1]],
    crpix: [(wcs.crpix[0] - 0.5) * factor + 0.5, (wcs.crpix[1] - 0.5) * factor + 0.5],
    cd: [
      [wcs.cd[0][0] * k, wcs.cd[0][1] * k],
      [wcs.cd[1][0] * k, wcs.cd[1][1] * k]
    ],
    cdInverse: [
      [wcs.cdInverse[0][0] * factor, wcs.cdInverse[0][1] * factor],
      [wcs.cdInverse[1][0] * factor, wcs.cdInverse[1][1] * factor]
    ],
    a: polyScale(wcs.a),
    b: polyScale(wcs.b),
    ap: polyScale(wcs.ap),
    bp: polyScale(wcs.bp),
    naxis1: Math.round(wcs.naxis1 * factor),
    naxis2: Math.round(wcs.naxis2 * factor)
  }
}

/** Header keywords that describe the astrometric solution. */
const WCS_KEYS = /^(CTYPE[12]|CUNIT[12]|CRVAL[12]|CRPIX[12]|CD[12]_[12]|PC[12]_[12]|CDELT[12]|CROTA[12]|LONPOLE|LATPOLE|A_ORDER|B_ORDER|AP_ORDER|BP_ORDER|A_\d+_\d+|B_\d+_\d+|AP_\d+_\d+|BP_\d+_\d+)$/

/**
 * Copy of the header with the solution replaced by `wcs` and updated
 * dimensions. A new image (mosaic, drizzle) exported as FITS thus carries
 * its own solution, not that of the file it came from.
 */
export function wcsInHeader(header: FitsHeader, wcs: Wcs): FitsHeader {
  const cards: FitsHeader['cards'] = {}
  const comments: FitsHeader['comments'] = {}
  const order: string[] = []
  for (const key of header.order) {
    if (WCS_KEYS.test(key)) continue
    cards[key] = header.cards[key]
    if (header.comments[key] !== undefined) comments[key] = header.comments[key]
    order.push(key)
  }
  const put = (key: string, value: number | string, comment?: string): void => {
    if (!(key in cards)) order.push(key)
    cards[key] = value
    if (comment !== undefined) comments[key] = comment
  }
  put('NAXIS1', wcs.naxis1)
  put('NAXIS2', wcs.naxis2)
  const withSip = wcs.a.size + wcs.b.size + wcs.ap.size + wcs.bp.size > 0
  put('CTYPE1', withSip ? 'RA---TAN-SIP' : 'RA---TAN', 'gnomonic projection')
  put('CTYPE2', withSip ? 'DEC--TAN-SIP' : 'DEC--TAN', 'gnomonic projection')
  put('CRVAL1', wcs.crval[0], 'right ascension of the reference point')
  put('CRVAL2', wcs.crval[1], 'declination of the reference point')
  put('CRPIX1', wcs.crpix[0], 'column of the reference point')
  put('CRPIX2', wcs.crpix[1], 'row of the reference point')
  put('CD1_1', wcs.cd[0][0])
  put('CD1_2', wcs.cd[0][1])
  put('CD2_1', wcs.cd[1][0])
  put('CD2_2', wcs.cd[1][1])
  const writePoly = (prefix: string, poly: Poly): void => {
    if (poly.size === 0) return
    let polyOrder = 0
    for (const degree of poly.keys()) {
      const [i, j] = degree.split('_').map(Number)
      polyOrder = Math.max(polyOrder, i + j)
    }
    put(prefix + '_ORDER', polyOrder)
    for (const [degree, coeff] of poly) put(prefix + '_' + degree, coeff)
  }
  writePoly('A', wcs.a)
  writePoly('B', wcs.b)
  writePoly('AP', wcs.ap)
  writePoly('BP', wcs.bp)
  return { cards, comments, order }
}

/**
 * The solution of a region of the image: the rectangle starting at pixel
 * (x0, y0), counted from 0 at the top left, with the given width and
 * height. The sky does not change; only the position of the reference
 * point relative to the new corner does.
 */
export function cropWcs(wcs: Wcs, x0: number, y0: number, width: number, height: number): Wcs {
  return {
    ...wcs,
    crval: [wcs.crval[0], wcs.crval[1]],
    crpix: [wcs.crpix[0] - x0, wcs.crpix[1] - y0],
    naxis1: width,
    naxis2: height
  }
}

/**
 * The solution of an image resized to `width` × `height` pixels, possibly
 * with different horizontal and vertical factors (a preset rounds each
 * dimension independently).
 *
 * The export resampling aligns the outer edges of the two images, like
 * `wcsScale`: one new pixel equals kx old pixels horizontally and ky
 * vertically. The CD columns are multiplied by kx and ky; a SIP term A_i_j
 * becomes A_i_j · kx^(i-1) · ky^j (and B_i_j · kx^i · ky^(j-1)), because
 * the input coordinates are in new pixels and the output offset must be
 * expressed in new pixels of the same axis.
 */
export function resizeWcs(wcs: Wcs, width: number, height: number): Wcs {
  if (wcs.naxis1 <= 0 || wcs.naxis2 <= 0) return wcs
  const kx = wcs.naxis1 / width
  const ky = wcs.naxis2 / height
  const polyScale = (poly: Poly, xAxis: boolean): Poly => {
    const newValue: Poly = new Map()
    for (const [degree, coeff] of poly) {
      const [i, j] = degree.split('_').map(Number)
      newValue.set(degree, coeff * kx ** i * ky ** j / (xAxis ? kx : ky))
    }
    return newValue
  }
  return {
    crval: [wcs.crval[0], wcs.crval[1]],
    crpix: [(wcs.crpix[0] - 0.5) / kx + 0.5, (wcs.crpix[1] - 0.5) / ky + 0.5],
    cd: [
      [wcs.cd[0][0] * kx, wcs.cd[0][1] * ky],
      [wcs.cd[1][0] * kx, wcs.cd[1][1] * ky]
    ],
    cdInverse: [
      [wcs.cdInverse[0][0] / kx, wcs.cdInverse[0][1] / kx],
      [wcs.cdInverse[1][0] / ky, wcs.cdInverse[1][1] / ky]
    ],
    a: polyScale(wcs.a, true),
    b: polyScale(wcs.b, false),
    ap: polyScale(wcs.ap, true),
    bp: polyScale(wcs.bp, false),
    naxis1: width,
    naxis2: height
  }
}

/** Binomial coefficient, to expand the powers in SIP polynomials. */
function binomial(n: number, k: number): number {
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return r
}

/**
 * Rewrites a SIP polynomial P(u, v) in the new coordinates (u', v'),
 * given u = n00·u' + n01·v' and v = n10·u' + n11·v'. Each term u^i·v^j is
 * expanded with the binomial theorem: the degree stays the same, so the
 * result is still an exact SIP polynomial of the same order.
 */
function replacePoly(poly: Poly, n00: number, n01: number, n10: number, n11: number): Poly {
  const newValue: Poly = new Map()
  for (const [degree, coeff] of poly) {
    const [i, j] = degree.split('_').map(Number)
    for (let k = 0; k <= i; k++) {
      const fu = binomial(i, k) * n00 ** k * n01 ** (i - k)
      if (fu === 0) continue
      for (let l = 0; l <= j; l++) {
        const fv = binomial(j, l) * n10 ** l * n11 ** (j - l)
        if (fv === 0) continue
        const key = k + l + '_' + (i + j - k - l)
        newValue.set(key, (newValue.get(key) ?? 0) + coeff * fu * fv)
      }
    }
  }
  return newValue
}

/** a·P + b·Q, keeping only the non-vanishing terms. */
function combinePoly(a: number, p: Poly, b: number, q: Poly): Poly {
  const sum: Poly = new Map()
  for (const [g, c] of p) sum.set(g, (sum.get(g) ?? 0) + a * c)
  for (const [g, c] of q) sum.set(g, (sum.get(g) ?? 0) + b * c)
  for (const [g, c] of sum) if (c === 0 || !Number.isFinite(c)) sum.delete(g)
  return sum
}

/**
 * The solution of an image whose pixels were moved by an affine
 * transformation (a plugin that rotates, mirrors, straightens).
 *
 * `matrix` maps the 0-based pixel-center coordinates from the old image to
 * the new one (see core/image/geometry.ts): p' = M·p + t. The sky does not
 * change, only how it is read:
 *
 * - CRPIX, 1-based in FITS, moves like any point:
 *   CRPIX' = M·(CRPIX − 1) + t + 1;
 * - CD, which maps pixel offsets to the sky, becomes CD·M⁻¹ (and its
 *   inverse M·CD⁻¹), because the new offsets are M times the old ones;
 * - SIP polynomials correct offsets in the pixel frame: the new ones are
 *   M·(A, B)(M⁻¹·u'). The expansion does not change the degree of the
 *   terms, so it is exact for any affine transformation, not only for
 *   quarter turns and mirrors (where the coefficients merely swap and
 *   change sign). It holds for both directions, forward (A, B) and inverse
 *   (AP, BP).
 */
export function transformWcs(
  wcs: Wcs,
  matrix: [[number, number, number], [number, number, number]],
  width: number,
  height: number
): Wcs | null {
  const [[m00, m01, tx], [m10, m11, ty]] = matrix
  const det = m00 * m11 - m01 * m10
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  // Inverse of the linear part.
  const n00 = m11 / det
  const n01 = -m01 / det
  const n10 = -m10 / det
  const n11 = m00 / det

  const px = wcs.crpix[0] - 1
  const py = wcs.crpix[1] - 1
  const crpix: [number, number] = [m00 * px + m01 * py + tx + 1, m10 * px + m11 * py + ty + 1]

  const [[c11, c12], [c21, c22]] = wcs.cd
  const cd: [[number, number], [number, number]] = [
    [c11 * n00 + c12 * n10, c11 * n01 + c12 * n11],
    [c21 * n00 + c22 * n10, c21 * n01 + c22 * n11]
  ]
  const [[i11, i12], [i21, i22]] = wcs.cdInverse
  const cdInverse: [[number, number], [number, number]] = [
    [m00 * i11 + m01 * i21, m00 * i12 + m01 * i22],
    [m10 * i11 + m11 * i21, m10 * i12 + m11 * i22]
  ]

  const pair = (p: Poly, q: Poly): [Poly, Poly] => {
    const ps = replacePoly(p, n00, n01, n10, n11)
    const qs = replacePoly(q, n00, n01, n10, n11)
    return [combinePoly(m00, ps, m01, qs), combinePoly(m10, ps, m11, qs)]
  }
  const [a, b] = pair(wcs.a, wcs.b)
  const [ap, bp] = pair(wcs.ap, wcs.bp)

  return {
    crval: [wcs.crval[0], wcs.crval[1]],
    crpix,
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
