import type { ImageData32, Wcs } from '@shared/types'
import { computeStats, MAD_TO_SIGMA } from './stats'
import { detectStars, type Star } from '../stars/detection'
import { skyToPixel, pixelToSky, scaleArcsec } from '../astrometry/wcs'

/**
 * Photometric color calibration.
 *
 * "By eye" white balancing makes the field's stars white on average, but
 * stars are not white: some are orange, others blue, and the average depends
 * on which stars happen to be in the photo. Here the true color of each star,
 * measured by the Gaia satellite, is used instead: how red or blue each one
 * should be is known, how much it is in the photo is measured, and the three
 * gains that make the two as equal as possible are chosen: a simplified
 * photometric color calibration.
 *
 * The reference "white" is a Sun-like star (type G2V): a star of that color
 * comes out neutral, hotter ones bluish, cooler ones orange.
 *
 * Steps:
 * 1. matchStars: the catalog stars are projected onto the image with the
 *    astrometric solution and matched with those detected within a few
 *    pixels;
 * 2. calibrateColor: aperture photometry (light in a circle minus the local
 *    background measured in a ring) on unsaturated stars, and robust fitting
 *    of the gains;
 * 3. applyGains: the gains are applied around the sky background, which
 *    stays neutral and at the same brightness.
 */

/** Catalog star: it only needs these fields (see gaiaCatalog.ts). */
export interface ReferenceStar {
  ra: number
  dec: number
  /** Gaia G magnitude. */
  g: number
  /** Gaia BP-RP color index. */
  bpRp: number
}

export interface MeasuredStar {
  /** Center of the detected star, in image pixels (0 = first, row 0 at the top). */
  x: number
  y: number
  bpRp: number
  g: number
  /** Half-flux radius of the detected star, in pixels, if known. */
  hfr?: number
}

export interface CalibrationResult {
  /** R, G, B gains, normalized to mean 1 (brightness does not change). */
  gains: [number, number, number]
  /** Stars that contributed after rejecting the outliers. */
  usedStars: number
  /**
   * Spread of the stars around the calibration, as a fraction (0.05 = 5%):
   * how far the measured color of a typical star is from the expected one
   * after the correction.
   */
  deviation: number
  /**
   * How closely the measured color of the stars follows the expected one:
   * slope of the line between the two (on a logarithmic scale). With a
   * broadband filter it is about 1; near 0 it means the stars in the photo
   * all have almost the same color, as happens with narrowband or dual-band
   * filters, and the calibration makes no sense.
   */
  slope: number
}

// ---------------------------------------------------------------------------
// Expected color of a star
// ---------------------------------------------------------------------------

/**
 * Relation between BP-RP index and temperature for main-sequence stars,
 * from the Pecaut and Mamajek table (2013, updated version), which covers
 * blue B-type stars down to red dwarfs. Between points, interpolation is on
 * the logarithm of the temperature.
 */
const BPRP_TABLE: [number, number][] = [
  [-0.35, 34000], // O9
  [-0.3, 30000], // B0
  [-0.2, 17000], // B4
  [-0.12, 13000], // B7
  [-0.05, 11000], // B9
  [0.0, 9700], // A0
  [0.1, 8800], // A3
  [0.2, 8100], // A6
  [0.38, 7200], // F0
  [0.5, 6750], // F3
  [0.59, 6510], // F5
  [0.7, 6150], // F8
  [0.76, 5920], // G0
  [0.82, 5770], // G2: the Sun
  [0.87, 5660], // G5
  [0.98, 5280], // K0
  [1.1, 5000], // K2
  [1.32, 4600], // K4
  [1.55, 4300], // K6
  [1.84, 3900], // M0
  [2.1, 3650], // M1
  [2.5, 3450], // M3
  [3.0, 3200], // M4
  [3.6, 3000], // M5
  [4.2, 2800] // M6
]

/** BP-RP of the Sun, that is, of the reference white. */
const BPRP_SUN = 0.82

/** Temperature (kelvin) of a star given its BP-RP index. */
export function temperatureFromBpRp(bpRp: number): number {
  const t = BPRP_TABLE
  if (bpRp <= t[0][0]) return t[0][1]
  if (bpRp >= t[t.length - 1][0]) return t[t.length - 1][1]
  for (let i = 1; i < t.length; i++) {
    if (bpRp <= t[i][0]) {
      const [c0, t0] = t[i - 1]
      const [c1, t1] = t[i]
      const f = (bpRp - c0) / (c1 - c0)
      return Math.exp(Math.log(t0) + f * (Math.log(t1) - Math.log(t0)))
    }
  }
  return t[t.length - 1][1]
}

/**
 * Spectral response of the sensor.
 *
 * Numeric curves for the sensor are not published; from datasheet plots the
 * peaks lie around 460 nm (blue), 535 nm (green) and 605 nm (red), with
 * bands 70-90 nm wide. Here they are APPROXIMATED with Gaussians of those
 * centers and widths, multiplied by the infrared-blocking filter mounted in
 * front of the sensor (cutoff near 690 nm) and by the natural drop below
 * 400 nm. Amplitudes do not matter: everything is referred to the color of
 * the Sun, and a constant factor cancels out. The red channel also has a
 * second lobe in the near infrared, which the IR filter removes. The Bayer
 * matrix dyes let a little light through outside their band (a few
 * percent), and the `leakage` field models it; on real files the stars
 * followed the model without leakage better, so it is zero. It can be
 * adjusted if the true sensor curves become available.
 */
const BANDS: { center: number; sigma: number; leakage: number }[] = [
  { center: 605, sigma: 35, leakage: 0 }, // red
  { center: 535, sigma: 38, leakage: 0 }, // green
  { center: 462, sigma: 32, leakage: 0 } // blue
]

/**
 * Filter mounted in front of the sensor.
 * - 'broadband': the infrared-blocking filter (for example FILTER = IRCUT
 *   in the header), which lets all the visible light through;
 * - 'dual-band': the dual-band light-pollution filter (for example
 *   FILTER = LP), which lets through only two narrow windows around the
 *   oxygen (OIII, 501 nm, about 30 nm) and hydrogen (H-alpha, 656 nm, about
 *   20 nm) lines. Stars are seen only through these windows, so their colors
 *   behave differently.
 */
export type OpticalFilter = 'broadband' | 'dual-band'

/** Filter transmission at wavelength lambda (nm). */
function transmission(filter: OpticalFilter, lambda: number): number {
  const irCut = 1 / (1 + Math.exp((lambda - 690) / 8))
  const uvCut = 1 / (1 + Math.exp((400 - lambda) / 8))
  if (filter === 'broadband') return irCut * uvCut
  // Windows with steep sides (fourth-degree Gaussians) of the given full width at half maximum.
  const window = (center: number, width: number): number =>
    Math.exp(-Math.LN2 * ((2 * (lambda - center)) / width) ** 4)
  return window(501, 30) + window(656, 20)
}

/** Integration wavelengths, in nanometers. */
const LAMBDA: number[] = []
for (let l = 370; l <= 760; l += 2) LAMBDA.push(l)

/** Weights of the three bands along LAMBDA for a filter. */
function bandWeights(filter: OpticalFilter): Float64Array[] {
  return BANDS.map(({ center, sigma, leakage }) => {
    const p = new Float64Array(LAMBDA.length)
    for (let i = 0; i < LAMBDA.length; i++) {
      const l = LAMBDA[i]
      const sensor = leakage + (1 - leakage) * Math.exp(-0.5 * ((l - center) / sigma) ** 2)
      p[i] = sensor * transmission(filter, l)
    }
    return p
  })
}

/**
 * Signal that a star of temperature t produces in the three bands. The
 * sensor counts photons, so the blackbody energy (Planck's law) is
 * multiplied by the wavelength.
 */
function blackbodySignal(t: number, weights: Float64Array[]): [number, number, number] {
  // hc/k in nanometer-kelvin.
  const c2 = 1.4387769e7
  const s: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < LAMBDA.length; i++) {
    const l = LAMBDA[i]
    const planck = 1 / (l ** 5 * (Math.exp(c2 / (l * t)) - 1))
    const photons = planck * l
    for (let k = 0; k < 3; k++) s[k] += photons * weights[k][i]
  }
  return s
}

/** Weights and Sun color for each filter, computed on first request. */
const MODELS = new Map<OpticalFilter, { weights: Float64Array[]; sun: [number, number, number] }>()
function model(filter: OpticalFilter): { weights: Float64Array[]; sun: [number, number, number] } {
  let m = MODELS.get(filter)
  if (!m) {
    const weights = bandWeights(filter)
    m = { weights, sun: blackbodySignal(temperatureFromBpRp(BPRP_SUN), weights) }
    MODELS.set(filter, m)
  }
  return m
}

/**
 * Filter inferred from the FILTER header keyword: 'LP' indicates the
 * dual-band light-pollution filter, 'IRCUT' (or nothing) the normal one.
 */
export function filterFromHeader(value: unknown): OpticalFilter {
  return typeof value === 'string' && /^\s*(LP|DUO|DUAL)/i.test(value) ? 'dual-band' : 'broadband'
}

/**
 * Expected color in the photo of a star of a given BP-RP, as R/G and B/G
 * ratios relative to the Sun: for a G2V star both are 1.
 */
export function expectedColor(bpRp: number, filter: OpticalFilter = 'broadband'): { rg: number; bg: number } {
  const { weights, sun } = model(filter)
  const s = blackbodySignal(temperatureFromBpRp(bpRp), weights)
  return { rg: s[0] / s[1] / (sun[0] / sun[1]), bg: s[2] / s[1] / (sun[2] / sun[1]) }
}

// ---------------------------------------------------------------------------
// Field to query
// ---------------------------------------------------------------------------

/**
 * Center and radius of the circle that contains the whole image, to ask the
 * catalog only for the stars in the field.
 */
export function catalogField(wcs: Wcs): { ra: number; dec: number; radius: number } {
  const w = wcs.naxis1
  const h = wcs.naxis2
  const center = pixelToSky(wcs, (w + 1) / 2, (h + 1) / 2)
  const radius = (Math.hypot(w, h) / 2) * (scaleArcsec(wcs) / 3600) * 1.02
  return { ra: center.ra, dec: center.dec, radius }
}

/**
 * Suggested limiting magnitude for the catalog request: fainter stars are
 * too noisy to measure their color, and with at most 2000 stars it is better
 * to fill the list with the useful ones.
 */
export const CATALOG_MAGNITUDE = 15.5

// ---------------------------------------------------------------------------
// Matching detected stars to the catalog
// ---------------------------------------------------------------------------

/**
 * Matches the catalog stars to those detected in the image.
 *
 * Each catalog star is placed with the astrometric solution, and the nearest
 * detected star is sought. A first wide pass (large tolerance) measures any
 * systematic offset of the solution, a second narrow pass (tolerance in
 * pixels) makes the real matches. Ambiguous pairs (two nearby candidates) and
 * catalog stars with a bright neighbor that would contaminate their aperture
 * are discarded.
 *
 * tolerance: maximum distance in pixels after the correction, 1-5,
 * default 2.5.
 */
export function matchStars(
  img: ImageData32,
  wcs: Wcs,
  catalog: ReferenceStar[],
  tolerance = 2.5,
  detectedStars?: Star[]
): MeasuredStar[] {
  const w = img.width
  const h = img.height
  const detected = detectedStars ?? detectStars(img, { max: 4000, threshold: 5 })
  if (detected.length === 0 || catalog.length === 0) return []

  // Grid of cells to find neighbors without comparing every pair.
  const cell = 16
  const columns = Math.ceil(w / cell)
  const rows = Math.ceil(h / cell)
  const grid: number[][] = Array.from({ length: columns * rows }, () => [])
  detected.forEach((s, i) => {
    const cx = Math.min(columns - 1, Math.max(0, Math.floor(s.x / cell)))
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(s.y / cell)))
    grid[cy * columns + cx].push(i)
  })
  const nearby = (x: number, y: number, radius: number): { i: number; d: number }[] => {
    const out: { i: number; d: number }[] = []
    const x0 = Math.max(0, Math.floor((x - radius) / cell))
    const x1 = Math.min(columns - 1, Math.floor((x + radius) / cell))
    const y0 = Math.max(0, Math.floor((y - radius) / cell))
    const y1 = Math.min(rows - 1, Math.floor((y + radius) / cell))
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (const i of grid[cy * columns + cx]) {
          const d = Math.hypot(detected[i].x - x, detected[i].y - y)
          if (d <= radius) out.push({ i, d })
        }
      }
    }
    return out.sort((a, b) => a.d - b.d)
  }

  // Predicted positions: WCS counts pixels from 1, the image from 0.
  const expectedItems: { x: number; y: number; s: ReferenceStar }[] = []
  for (const s of catalog) {
    const p = skyToPixel(wcs, s.ra, s.dec)
    if (!p) continue
    const x = p.x - 1
    const y = p.y - 1
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue
    expectedItems.push({ x, y, s })
  }

  // First pass: systematic offset, from the median of the pairs.
  const dxs: number[] = []
  const dys: number[] = []
  for (const p of expectedItems) {
    const c = nearby(p.x, p.y, 10)
    if (c.length === 0) continue
    dxs.push(detected[c[0].i].x - p.x)
    dys.push(detected[c[0].i].y - p.y)
  }
  const median = (v: number[]): number => (v.length ? v.slice().sort((a, b) => a - b)[v.length >> 1] : 0)
  const ox = dxs.length >= 10 ? median(dxs) : 0
  const oy = dys.length >= 10 ? median(dys) : 0

  // Bright catalog stars: to discard those with cumbersome neighbors.
  const usedItems = new Set<number>()
  const result: MeasuredStar[] = []
  for (const p of expectedItems) {
    const x = p.x + ox
    const y = p.y + oy
    // A catalog star no more than 2 magnitudes fainter within 12 pixels
    // would end up in the aperture or the background ring.
    let disturbed = false
    for (const q of expectedItems) {
      if (q === p) continue
      if (Math.abs(q.x - p.x) < 12 && Math.abs(q.y - p.y) < 12 && q.s.g < p.s.g + 2) {
        disturbed = true
        break
      }
    }
    if (disturbed) continue
    const c = nearby(x, y, tolerance * 2)
    if (c.length === 0 || c[0].d > tolerance) continue
    // Ambiguity: a second candidate at almost the same distance.
    if (c.length > 1 && c[1].d < tolerance * 1.5) continue
    if (usedItems.has(c[0].i)) continue
    usedItems.add(c[0].i)
    const r = detected[c[0].i]
    result.push({ x: r.x, y: r.y, bpRp: p.s.bpRp, g: p.s.g, hfr: r.hfr })
  }
  return result
}

// ---------------------------------------------------------------------------
// Photometry and gain fitting
// ---------------------------------------------------------------------------

/** Median of an array (reorders it). */
function medianInPlace(v: number[]): number {
  if (v.length === 0) return 0
  v.sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * Level above which a pixel is considered saturated, per channel: slightly
 * below the image maximum, because in stacks full white is not always 1.
 */
function saturationLevels(img: ImageData32): number[] {
  const n = img.width * img.height
  const levels: number[] = []
  for (let k = 0; k < 3; k++) {
    let max = 0
    for (let i = k * n; i < (k + 1) * n; i++) if (img.data[i] > max) max = img.data[i]
    levels.push(max * 0.9)
  }
  return levels
}

interface Measurement {
  rg: number
  bg: number
  expectedRg: number
  expectedBg: number
  snr: number
}

/**
 * Measures the fluxes in the three channels with a circular aperture and the
 * local background from a ring around it. Discards saturated, edge, faint or
 * irregular-background stars (for example over a nebula).
 */
function measureStars(img: ImageData32, stars: MeasuredStar[], filter: OpticalFilter): Measurement[] {
  const w = img.width
  const h = img.height
  const n = w * h
  const d = img.data
  const saturation = saturationLevels(img)

  // Common aperture radius: 3 times the typical half-flux radius encloses
  // almost all the light of a well-focused star.
  const knownHfr = stars.map((s) => s.hfr ?? 0).filter((v) => v > 0)
  const hfr = knownHfr.length ? medianInPlace(knownHfr) : 2
  const rAp = Math.min(12, Math.max(3, hfr * 3))
  const rIn = rAp + 3
  const rOut = rAp + 8
  const margin = Math.ceil(rOut) + 1

  const measurements: Measurement[] = []
  const ring: number[][] = [[], [], []]
  for (const s of stars) {
    const cx = Math.round(s.x)
    const cy = Math.round(s.y)
    if (cx < margin || cy < margin || cx >= w - margin || cy >= h - margin) continue

    for (const a of ring) a.length = 0
    const sums = [0, 0, 0]
    let area = 0
    let saturate = false
    for (let dy = -margin; dy <= margin; dy++) {
      for (let dx = -margin; dx <= margin; dx++) {
        // Distance from the true center, not from the rounded one.
        const r = Math.hypot(cx + dx - s.x, cy + dy - s.y)
        const i = (cy + dy) * w + cx + dx
        if (r <= rAp) {
          area++
          for (let k = 0; k < 3; k++) {
            const v = d[k * n + i]
            if (v >= saturation[k]) saturate = true
            sums[k] += v
          }
        } else if (r >= rIn && r <= rOut) {
          for (let k = 0; k < 3; k++) ring[k].push(d[k * n + i])
        }
      }
    }
    if (saturate || area === 0) continue

    const backgrounds = ring.map((a) => medianInPlace(a))
    // Background noise from the green channel (spread of the ring).
    const rejections = ring[1].map((v) => Math.abs(v - backgrounds[1]))
    const sigma = Math.max(1e-7, medianInPlace(rejections) * MAD_TO_SIGMA)
    const fluxes = sums.map((sm, k) => sm - backgrounds[k] * area)
    if (fluxes[0] <= 0 || fluxes[1] <= 0 || fluxes[2] <= 0) continue
    // Approximate signal-to-noise ratio, dominated by the background.
    const snr = fluxes[1] / (sigma * Math.sqrt(area))
    if (snr < 30) continue

    const expected = expectedColor(s.bpRp, filter)
    measurements.push({
      rg: fluxes[0] / fluxes[1],
      bg: fluxes[2] / fluxes[1],
      expectedRg: expected.rg,
      expectedBg: expected.bg,
      snr
    })
  }
  return measurements
}

/**
 * Robust mean: weighted least squares with iterative rejection of values
 * beyond 2.5 deviations (estimated with the MAD). Also returns which values
 * were kept.
 */
function robustMean(values: number[], weights: number[]): { mean: number; kept: boolean[]; sigma: number } {
  let kept = values.map(() => true)
  let mean = medianInPlace(values.slice())
  let sigma = 0
  for (let pass = 0; pass < 6; pass++) {
    const residuals = values.filter((_, i) => kept[i]).map((v) => Math.abs(v - mean))
    sigma = Math.max(1e-4, medianInPlace(residuals) * MAD_TO_SIGMA)
    const newOnes = values.map((v) => Math.abs(v - mean) <= 2.5 * sigma)
    let sp = 0
    let spv = 0
    for (let i = 0; i < values.length; i++) {
      if (!newOnes[i]) continue
      sp += weights[i]
      spv += weights[i] * values[i]
    }
    if (sp > 0) mean = spv / sp
    const changedItems = newOnes.some((t, i) => t !== kept[i])
    kept = newOnes
    if (!changedItems) break
  }
  return { mean, kept, sigma }
}

/**
 * Computes the gains that bring the measured color of the stars to the one
 * expected from the catalog. If there are fewer than 8 usable stars it
 * returns neutral gains [1, 1, 1] with `usedStars` equal to the number found:
 * the caller must check it.
 */
export function calibrateColor(
  img: ImageData32,
  stars: MeasuredStar[],
  filter: OpticalFilter = 'broadband'
): CalibrationResult {
  if (img.channels !== 3) return { gains: [1, 1, 1], usedStars: 0, deviation: 0, slope: 0 }
  const measurements = measureStars(img, stars, filter)
  if (measurements.length < 8) return { gains: [1, 1, 1], usedStars: measurements.length, deviation: 0, slope: 0 }

  // In the logarithm the gain becomes a sum: log g = log expected - log measured.
  // Weight: brighter stars are more reliable, but without letting a few
  // dominate everything (capped weight).
  const weights = measurements.map((m) => Math.min(m.snr, 300))
  const lr = measurements.map((m) => Math.log(m.expectedRg / m.rg))
  const lb = measurements.map((m) => Math.log(m.expectedBg / m.bg))
  const r = robustMean(lr, weights)
  const b = robustMean(lb, weights)

  let usedItems = 0
  let sum2 = 0
  for (let i = 0; i < measurements.length; i++) {
    if (!r.kept[i] || !b.kept[i]) continue
    usedItems++
    sum2 += (lr[i] - r.mean) ** 2 + (lb[i] - b.mean) ** 2
  }
  const deviation = usedItems > 0 ? Math.sqrt(sum2 / (2 * usedItems)) : 0

  // Slope: regression of the measured color on the expected one, using the
  // log(R/B) index, the most sensitive to temperature. The gains do not
  // change it: it only measures whether the camera "sees" stellar colors.
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < measurements.length; i++) {
    if (!r.kept[i] || !b.kept[i]) continue
    const x = Math.log(measurements[i].expectedRg / measurements[i].expectedBg)
    const y = Math.log(measurements[i].rg / measurements[i].bg)
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const variance = usedItems > 1 ? sxx - (sx * sx) / usedItems : 0
  const slope = variance > 1e-9 ? (sxy - (sx * sy) / usedItems) / variance : 0

  // Green = 1, then all divided by the mean so brightness stays the same.
  const gr = Math.exp(r.mean)
  const gb = Math.exp(b.mean)
  const mean = (gr + 1 + gb) / 3
  return { gains: [gr / mean, 1 / mean, gb / mean], usedStars: usedItems, deviation, slope }
}

/**
 * Applies the gains around the sky background: each channel's background
 * stays fixed (or, with `neutralize`, is brought to the common level, so the
 * sky comes out neutral gray) and only the signal above it is multiplied.
 * Otherwise the gains would also tint the sky.
 */
export function applyGains(
  img: ImageData32,
  g: [number, number, number],
  neutralize = true
): ImageData32 {
  if (img.channels !== 3) return { ...img, data: img.data.slice() }
  const n = img.width * img.height
  const backgrounds = [0, 1, 2].map((k) => computeStats(img.data.subarray(k * n, (k + 1) * n)).median)
  const common = (backgrounds[0] + backgrounds[1] + backgrounds[2]) / 3
  const out = new Float32Array(img.data.length)
  for (let k = 0; k < 3; k++) {
    const f = backgrounds[k]
    const destination = neutralize ? common : f
    const gk = g[k]
    const o = k * n
    for (let i = 0; i < n; i++) {
      const v = destination + (img.data[o + i] - f) * gk
      out[o + i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  return { ...img, data: out }
}

/**
 * Complete chain for the Abracadabra button: matches, calibrates and
 * applies. If the stars are too few (empty catalog, wrong astrometric
 * solution, inconsistent stellar colors) it returns the image unchanged
 * with applied = false. The filter is obtained from the header with
 * filterFromHeader(header.cards['FILTER']).
 */
export function calibrateColorAutomatically(
  img: ImageData32,
  wcs: Wcs,
  catalog: ReferenceStar[],
  filter: OpticalFilter = 'broadband'
): CalibrationResult & { image: ImageData32; matchedStars: number; applied: boolean } {
  const matched = matchStars(img, wcs, catalog)
  const result = calibrateColor(img, matched, filter)
  // Enough stars are needed, a contained spread and stellar colors that vary
  // as expected (otherwise narrowband filter or wrong matching): in those
  // cases it is better not to touch the image.
  const applied =
    result.usedStars >= 8 && result.deviation < 0.15 && result.slope > 0.6 && result.slope < 1.6
  return {
    ...result,
    image: applied ? applyGains(img, result.gains) : img,
    matchedStars: matched.length,
    applied
  }
}
