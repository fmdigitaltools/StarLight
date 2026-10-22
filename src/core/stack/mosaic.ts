import type { ImageData32, Wcs } from '@shared/types'
import { skyToPixel, buildWcs, pixelToSky, scaleArcsec } from '../astrometry/wcs'
import { formatNumber, t } from '@shared/i18n/i18n'

/**
 * Mosaic: several adjacent framings joined into a wider field.
 *
 * Each panel carries its own astrometric solution (WCS), that is it knows
 * which point of the sky each of its pixels corresponds to. The mosaic is
 * built as follows:
 *
 * 1. **Common projection.** A plane tangent to the sky is chosen, centred
 *    on the overall field (gnomonic projection, the same as the panels),
 *    with the scale of the finest panel and its same orientation: the
 *    final image "stands straight" like the panels.
 * 2. **Reprojection.** For each pixel of the mosaic we compute where it
 *    falls in each panel (going through the sky, optical distortion
 *    included) and read its value with the Lanczos filter, which
 *    preserves the sharpness of the stars. The exact computation is done
 *    on a grid of nodes every 16 pixels and interpolated between the
 *    nodes: the mapping between two projections is very smooth and the
 *    error stays below a thousandth of a pixel.
 * 3. **Photometric matching.** Panels captured on different nights or
 *    hours have different sky background and brightness. In the overlap
 *    areas the values of the two panels are compared, channel by channel,
 *    and the line that brings one onto the other (gain and background) is
 *    derived. Stars do not disturb: the work is done on averaged blocks
 *    of 8 × 8 pixels, which contain almost all the light of a star even
 *    if the sharpness of the panels differs; saturated blocks are removed
 *    and a robust estimate ignores those that do not follow the line.
 *    Then all the pairs are brought into agreement together (least
 *    squares), taking as reference the panel best connected to the others.
 * 4. **Feathered blending.** Each panel weighs less the closer one gets
 *    to its edge (or to an empty area, such as the black borders of
 *    rotated stacked images): in the overlaps the transition from one to
 *    the other is gradual and no seams remain.
 *
 * The module is pure: no interface, no files. It is run by a worker,
 * because on large panels the computation takes seconds.
 */

/** What needs to be known about a panel before reading its pixels. */
export interface PanelDescription {
  width: number
  height: number
  wcs: Wcs
}

/** Layout of the mosaic on the sky, computable without reading the pixels. */
export interface MosaicGeometry {
  /** Astrometric solution of the mosaic (TAN, without distortion). */
  wcs: Wcs
  width: number
  height: number
  /** Scale in arcseconds per pixel. */
  scale: number
  /** Panel whose scale and orientation are adopted. */
  reference: number
  /**
   * Outline of each panel in the mosaic, in pixels with the origin at the
   * top-left corner (pixel i covers the interval [i, i+1]).
   */
  outlines: { x: number; y: number }[][]
  /** Rectangle containing each panel, in whole pixels (end excluded). */
  boxes: Box[]
}

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface MosaicOptions {
  /** Matches the background and brightness of the panels. Default: yes. */
  blend?: boolean
  /**
   * Width of the feathering towards the edges, as a fraction of the
   * shorter side of the panel. Default 0.12.
   */
  feather?: number
}

/** Correction applied to a panel: value × gain + background. */
export interface PanelCorrection {
  gain: number[]
  background: number[]
}

/** How two panels were compared in their overlap. */
export interface Overlap {
  a: number
  b: number
  /** 8×8-pixel blocks used for the comparison. */
  blocks: number
  /** Per channel: true if the area had enough structure to measure the gain. */
  measuredGain: boolean[]
}

export interface MosaicResult {
  image: ImageData32
  wcs: Wcs
  scale: number
  /** For each pixel, how many panels cover it (0 = outside the panels). */
  coverage: Uint8Array
  /** Fraction of pixels covered by at least one panel. */
  coveredFraction: number
  /** Fraction of pixels covered by two or more panels. */
  overlapFraction: number
  corrections: PanelCorrection[]
  overlaps: Overlap[]
  /** Panels that do not overlap the main group. */
  isolated: number[]
  /** Value put in the areas outside the panels, per channel. */
  padding: number[]
}

/** Beyond this size the mosaic no longer fits comfortably in memory. */
export const MAX_MOSAIC_PIXELS = 300_000_000

/** Step of the grid on which the mapping between projections is computed exactly. */
const GRID_STEP = 16

/** Side of the blocks on which panels are compared. */
const BLOCK = 8

/** Points taken along each side of a panel to draw its outline. */
const POINTS_PER_SIDE = 24

const DEG_TO_RAD = Math.PI / 180

/* ------------------------------------------------------------------ */
/* Geometry                                                           */
/* ------------------------------------------------------------------ */

/** Centre of a panel on the sky. */
function panelCenter(p: PanelDescription): { ra: number; dec: number } {
  return pixelToSky(p.wcs, p.width / 2 + 0.5, p.height / 2 + 0.5)
}

/** Points of the edge of a panel, in FITS pixels (1 = first pixel). */
function panelEdge(p: PanelDescription): { x: number; y: number }[] {
  const w = p.width
  const h = p.height
  const points: { x: number; y: number }[] = []
  const n = POINTS_PER_SIDE
  for (let k = 0; k < n; k++) points.push({ x: 0.5 + (w * k) / n, y: 0.5 })
  for (let k = 0; k < n; k++) points.push({ x: w + 0.5, y: 0.5 + (h * k) / n })
  for (let k = 0; k < n; k++) points.push({ x: w + 0.5 - (w * k) / n, y: h + 0.5 })
  for (let k = 0; k < n; k++) points.push({ x: 0.5, y: h + 0.5 - (h * k) / n })
  return points
}

/**
 * Computes the layout of the mosaic: projection plane, size of the final
 * image and position of each panel. It is fast and is also used for the
 * preview in the interface.
 *
 * @throws Error with an explanation if the panels cannot be joined
 */
export function mosaicGeometry(panels: PanelDescription[]): MosaicGeometry {
  if (panels.length < 2) throw new Error(t('coreMosaic.needTwoPanels'))

  // Reference: the panel with the smallest pixels, so as not to lose
  // detail in any of them.
  let reference = 0
  for (let k = 1; k < panels.length; k++) {
    if (scaleArcsec(panels[k].wcs) < scaleArcsec(panels[reference].wcs) - 1e-9) reference = k
  }
  const ref = panels[reference].wcs
  const scale = scaleArcsec(ref)

  // Centre of the overall field: mean of the centres as vectors on the
  // sphere, which does not suffer from the right ascension jump at 0h/24h.
  let sx = 0
  let sy = 0
  let sz = 0
  for (const p of panels) {
    const c = panelCenter(p)
    const ra = c.ra * DEG_TO_RAD
    const dec = c.dec * DEG_TO_RAD
    sx += Math.cos(dec) * Math.cos(ra)
    sy += Math.cos(dec) * Math.sin(ra)
    sz += Math.sin(dec)
  }
  const norm = Math.hypot(sx, sy, sz)
  if (norm < 1e-9) throw new Error(t('coreMosaic.spreadAcrossSky'))
  const raC = ((Math.atan2(sy, sx) / DEG_TO_RAD) % 360 + 360) % 360
  const decC = Math.asin(sz / norm) / DEG_TO_RAD

  // Provisional plane with the reference at the origin, to measure the
  // footprint of all the panels.
  const temporary = buildWcs({ crval: [raC, decC], crpix: [0, 0], cd: ref.cd, naxis1: 0, naxis2: 0 })
  if (temporary === null) throw new Error(t('coreMosaic.invalidReferenceSolution'))

  const planeEdges: { x: number; y: number }[][] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of panels) {
    const points: { x: number; y: number }[] = []
    for (const b of panelEdge(p)) {
      const sky = pixelToSky(p.wcs, b.x, b.y)
      const q = skyToPixel(temporary, sky.ra, sky.dec)
      if (q === null || !Number.isFinite(q.x) || !Number.isFinite(q.y)) {
        throw new Error(t('coreMosaic.panelTooFar'))
      }
      points.push(q)
      if (q.x < minX) minX = q.x
      if (q.y < minY) minY = q.y
      if (q.x > maxX) maxX = q.x
      if (q.y > maxY) maxY = q.y
    }
    planeEdges.push(points)
  }

  const width = Math.max(1, Math.ceil(maxX - minX - 1e-6))
  const height = Math.max(1, Math.ceil(maxY - minY - 1e-6))
  if (width * height > MAX_MOSAIC_PIXELS) {
    throw new Error(
      t('coreMosaic.tooLarge', {
        width: formatNumber(width),
        height: formatNumber(height)
      })
    )
  }

  // The left edge (minX) falls on the edge of the first pixel, that is 0.5
  // in FITS convention.
  const wcs = buildWcs({
    crval: [raC, decC],
    crpix: [0.5 - minX, 0.5 - minY],
    cd: ref.cd,
    naxis1: width,
    naxis2: height
  }) as Wcs

  const outlines = planeEdges.map((points) => points.map((q) => ({ x: q.x - minX, y: q.y - minY })))
  const boxes = outlines.map((points) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const q of points) {
      if (q.x < x0) x0 = q.x
      if (q.y < y0) y0 = q.y
      if (q.x > x1) x1 = q.x
      if (q.y > y1) y1 = q.y
    }
    return {
      x0: Math.max(0, Math.floor(x0)),
      y0: Math.max(0, Math.floor(y0)),
      x1: Math.min(width, Math.ceil(x1)),
      y1: Math.min(height, Math.ceil(y1))
    }
  })

  return { wcs, width, height, scale, reference, outlines, boxes }
}

/**
 * Memory required by the computation, in bytes, beyond the interface: the
 * reprojected panels with their weights, one decoded panel at a time, the
 * final mosaic with weights and coverage, the files read.
 */
export function mosaicMemory(
  geometry: MosaicGeometry,
  panels: PanelDescription[],
  channels: number,
  fileBytes = 0
): number {
  let reprojected = 0
  let maxPanel = 0
  for (let k = 0; k < panels.length; k++) {
    const r = geometry.boxes[k]
    reprojected += (r.x1 - r.x0) * (r.y1 - r.y0) * (channels + 1) * 4
    maxPanel = Math.max(maxPanel, panels[k].width * panels[k].height * (channels + 1) * 4)
  }
  const final = geometry.width * geometry.height * (channels * 4 * 2 + 4 + 1)
  return reprojected + maxPanel + final + fileBytes
}

/* ------------------------------------------------------------------ */
/* Reprojection                                                       */
/* ------------------------------------------------------------------ */

/** Table of the three-lobe Lanczos kernel, to avoid computing sines at every pixel. */
const LANCZOS_RESOLUTION = 1024
const LANCZOS_TABLE = (() => {
  const t = new Float32Array(3 * LANCZOS_RESOLUTION + 2)
  for (let i = 0; i < t.length; i++) {
    const x = i / LANCZOS_RESOLUTION
    if (x === 0) t[i] = 1
    else if (x >= 3) t[i] = 0
    else t[i] = (3 * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / 3)) / (Math.PI * Math.PI * x * x)
  }
  return t
})()

function lanczos(x: number): number {
  const a = x < 0 ? -x : x
  return a >= 3 ? 0 : LANCZOS_TABLE[Math.round(a * LANCZOS_RESOLUTION)]
}

/** Smooth blend between 0 and 1. */
function soft(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

/**
 * Distance of each pixel from the nearest pixel without data or from the
 * edge, in pixels (two-pass "chamfer" approximation, excellent for
 * feathering weights). Without data: all channels at exactly zero, or
 * non-numeric values, such as the black borders left by alignment in
 * stacked images.
 */
function distanceFromEdges(img: ImageData32, limit: number): Float32Array {
  const w = img.width
  const h = img.height
  const n = w * h
  const c = img.channels
  const d = new Float32Array(n)
  const data = img.data
  for (let i = 0; i < n; i++) {
    let empty = true
    let valid = true
    for (let k = 0; k < c; k++) {
      const v = data[k * n + i]
      if (!Number.isFinite(v)) valid = false
      else if (v !== 0) empty = false
    }
    d[i] = valid && !empty ? limit : 0
  }
  const R2 = Math.SQRT2
  // Forward pass: from the top left.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      let v = d[i]
      if (v === 0) continue
      const s = x === 0 ? 1 : d[i - 1] + 1
      if (s < v) v = s
      const a = y === 0 ? 1 : d[i - w] + 1
      if (a < v) v = a
      if (y > 0) {
        if (x > 0 && d[i - w - 1] + R2 < v) v = d[i - w - 1] + R2
        if (x < w - 1 && d[i - w + 1] + R2 < v) v = d[i - w + 1] + R2
      }
      d[i] = v
    }
  }
  // Backward pass: from the bottom right.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      let v = d[i]
      if (v === 0) continue
      const s = x === w - 1 ? 1 : d[i + 1] + 1
      if (s < v) v = s
      const b = y === h - 1 ? 1 : d[i + w] + 1
      if (b < v) v = b
      if (y < h - 1) {
        if (x > 0 && d[i + w - 1] + R2 < v) v = d[i + w - 1] + R2
        if (x < w - 1 && d[i + w + 1] + R2 < v) v = d[i + w + 1] + R2
      }
      d[i] = v
    }
  }
  return d
}

/** A panel brought onto the grid of the mosaic, inside its box. */
interface Reprojected {
  r: Box
  /** Width and height of the box. */
  bw: number
  bh: number
  /** Values per channel (consecutive planes), in the scale of the panel. */
  values: Float32Array
  /** Feathering weight of each pixel: 0 where the panel does not reach. */
  weights: Float32Array
  /** Weight below which the pixel is too close to the edge for the comparison. */
  minWeight: number
}

/**
 * Reprojects a panel onto the grid of the mosaic.
 */
function reproject(
  img: ImageData32,
  wcsPanel: Wcs,
  geometry: MosaicGeometry,
  r: Box,
  channels: number,
  featherFraction: number
): Reprojected {
  const w = img.width
  const h = img.height
  const n = w * h
  const bw = Math.max(0, r.x1 - r.x0)
  const bh = Math.max(0, r.y1 - r.y0)
  const values = new Float32Array(bw * bh * channels)
  const weights = new Float32Array(bw * bh)
  const ramp = Math.max(4, Math.min(400, Math.round(Math.min(w, h) * featherFraction)))
  const distance = distanceFromEdges(img, ramp)
  const source = img.data
  const sourceChannels = img.channels

  // Grid nodes: exact position, in the panel, of the centre of a mosaic
  // pixel every GRID_STEP pixels.
  const nx = Math.ceil(bw / GRID_STEP) + 1
  const ny = Math.ceil(bh / GRID_STEP) + 1
  const nodeX = new Float64Array(nx * ny)
  const nodeY = new Float64Array(nx * ny)
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const i = r.x0 + gx * GRID_STEP
      const j = r.y0 + gy * GRID_STEP
      const sky = pixelToSky(geometry.wcs, i + 1, j + 1)
      const q = skyToPixel(wcsPanel, sky.ra, sky.dec)
      const k = gy * nx + gx
      nodeX[k] = q === null ? NaN : q.x - 1
      nodeY[k] = q === null ? NaN : q.y - 1
    }
  }

  const wx = new Float64Array(6)
  const wy = new Float64Array(6)

  for (let jj = 0; jj < bh; jj++) {
    const gy = Math.floor(jj / GRID_STEP)
    const ty = (jj - gy * GRID_STEP) / GRID_STEP
    for (let ii = 0; ii < bw; ii++) {
      const gx = Math.floor(ii / GRID_STEP)
      const tx = (ii - gx * GRID_STEP) / GRID_STEP
      const k00 = gy * nx + gx
      const k10 = k00 + 1
      const k01 = k00 + nx
      const k11 = k01 + 1
      let sx =
        (1 - ty) * ((1 - tx) * nodeX[k00] + tx * nodeX[k10]) + ty * ((1 - tx) * nodeX[k01] + tx * nodeX[k11])
      let sy =
        (1 - ty) * ((1 - tx) * nodeY[k00] + tx * nodeY[k10]) + ty * ((1 - tx) * nodeY[k01] + tx * nodeY[k11])
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
        // A node fell beyond the horizon: the pixel is computed on its own.
        const sky = pixelToSky(geometry.wcs, r.x0 + ii + 1, r.y0 + jj + 1)
        const q = skyToPixel(wcsPanel, sky.ra, sky.dec)
        if (q === null) continue
        sx = q.x - 1
        sy = q.y - 1
      }
      if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) continue

      let pi = Math.round(sx)
      let pj = Math.round(sy)
      if (pi > w - 1) pi = w - 1
      if (pj > h - 1) pj = h - 1
      const dist = distance[pj * w + pi]
      if (dist <= 0) continue

      const o = jj * bw + ii
      weights[o] = soft(dist / ramp) + 1e-4

      const ix = Math.floor(sx)
      const iy = Math.floor(sy)
      const fx = sx - ix
      const fy = sy - iy

      if (dist >= 3.5) {
        // Three-lobe Lanczos: 6 × 6 pixels around the point.
        let swx = 0
        let swy = 0
        for (let m = 0; m < 6; m++) {
          wx[m] = lanczos(fx - (m - 2))
          wy[m] = lanczos(fy - (m - 2))
          swx += wx[m]
          swy += wy[m]
        }
        for (let m = 0; m < 6; m++) {
          wx[m] /= swx
          wy[m] /= swy
        }
        const x0 = ix - 2
        const y0 = iy - 2
        // Extremes of the four neighbours, for the limit against halos.
        const xa = ix < 0 ? 0 : ix > w - 1 ? w - 1 : ix
        const xb = ix + 1 > w - 1 ? w - 1 : ix + 1 < 0 ? 0 : ix + 1
        const ya = iy < 0 ? 0 : iy > h - 1 ? h - 1 : iy
        const yb = iy + 1 > h - 1 ? h - 1 : iy + 1 < 0 ? 0 : iy + 1
        for (let c = 0; c < channels; c++) {
          const base = (sourceChannels === 3 ? c : 0) * n
          let sum = 0
          for (let my = 0; my < 6; my++) {
            let yy = y0 + my
            if (yy < 0) yy = 0
            else if (yy > h - 1) yy = h - 1
            const row = base + yy * w
            let partial = 0
            for (let mx = 0; mx < 6; mx++) {
              let xx = x0 + mx
              if (xx < 0) xx = 0
              else if (xx > w - 1) xx = w - 1
              partial += wx[mx] * source[row + xx]
            }
            sum += wy[my] * partial
          }
          // Against dark Lanczos halos around stars: the value stays
          // between the minimum and the maximum of the four neighbours.
          const v1 = source[base + ya * w + xa]
          const v2 = source[base + ya * w + xb]
          const v3 = source[base + yb * w + xa]
          const v4 = source[base + yb * w + xb]
          const lo = Math.min(v1, v2, v3, v4)
          const hi = Math.max(v1, v2, v3, v4)
          values[c * bw * bh + o] = sum < lo ? lo : sum > hi ? hi : sum
        }
      } else if (dist >= 1.5) {
        // Near an edge: bilinear interpolation, which does not read beyond.
        const xa = ix < 0 ? 0 : ix
        const xb = ix + 1 > w - 1 ? w - 1 : ix + 1
        const ya = iy < 0 ? 0 : iy
        const yb = iy + 1 > h - 1 ? h - 1 : iy + 1
        for (let c = 0; c < channels; c++) {
          const base = (sourceChannels === 3 ? c : 0) * n
          const v =
            (1 - fy) * ((1 - fx) * source[base + ya * w + xa] + fx * source[base + ya * w + xb]) +
            fy * ((1 - fx) * source[base + yb * w + xa] + fx * source[base + yb * w + xb])
          values[c * bw * bh + o] = v
        }
      } else {
        // On the edge: the nearest pixel.
        for (let c = 0; c < channels; c++) {
          const base = (sourceChannels === 3 ? c : 0) * n
          values[c * bw * bh + o] = source[base + pj * w + pi]
        }
      }
    }
  }

  return { r, bw, bh, values, weights, minWeight: soft(4 / ramp) }
}

/** Noise of each channel of the panel, from the differences between neighbouring pixels. */
function noisePerChannel(img: ImageData32, channels: number): number[] {
  const w = img.width
  const h = img.height
  const n = w * h
  const step = Math.max(1, Math.floor(Math.sqrt(n / 40000)))
  const result: number[] = []
  for (let c = 0; c < channels; c++) {
    const base = (img.channels === 3 ? c : 0) * n
    const diff: number[] = []
    for (let y = 1; y < h - 1; y += step) {
      for (let x = 1; x < w - 2; x += step) {
        const i = base + y * w + x
        const a = img.data[i]
        const b = img.data[i + 1]
        if (a === 0 || b === 0) continue
        diff.push(Math.abs(b - a))
      }
    }
    result.push(diff.length > 0 ? (median(diff) * 1.4826) / Math.SQRT2 : 0)
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Robust statistics                                                  */
/* ------------------------------------------------------------------ */

function median(values: number[] | Float64Array): number {
  if (values.length === 0) return 0
  const v = Float64Array.from(values).sort()
  const m = v.length >> 1
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2
}

function quantile(sortedItems: Float64Array, q: number): number {
  if (sortedItems.length === 0) return 0
  const pos = Math.min(sortedItems.length - 1, Math.max(0, q * (sortedItems.length - 1)))
  const i = Math.floor(pos)
  const f = pos - i
  return i + 1 < sortedItems.length ? sortedItems[i] * (1 - f) + sortedItems[i + 1] * f : sortedItems[i]
}

/** Deming slope from the weighted moments (null if undefined). */
function demingSlope(saa: number, sbb: number, sab: number, lambda: number): number | null {
  if (saa <= 0 || sbb <= 0 || sab <= 0) return null
  const diff = sbb - lambda * saa
  const g = (diff + Math.sqrt(diff * diff + 4 * lambda * sab * sab)) / (2 * sab)
  return Number.isFinite(g) && g > 0 ? g : null
}

/** Outcome of the line between two panels. */
interface Line {
  g: number
  o: number
  /** Relative uncertainty of the gain (0.02 = 2%). */
  uncertainty: number
}

/** Beyond this uncertainty the gain of a pair is not used. */
const MAX_UNCERTAINTY = 0.05

/**
 * Line b = g·a + o between the values of two panels, robust and free of
 * the bias of ordinary least squares when both measurements are noisy
 * (Deming regression, with the ratio between the noises known). Points
 * far from the line (moved stars, reflections) lose weight at each pass
 * (Tukey weights).
 *
 * The uncertainty of the gain is estimated by removing a band of blocks in
 * turn and redoing the computation ("jackknife"): if the area is only sky
 * background, the cloud of points is round and the gain varies a lot from
 * one band to another.
 *
 * @returns null if the gain cannot be measured
 */
function robustLine(a: Float64Array, b: Float64Array, lambda: number): Line | null {
  const n = a.length
  if (n < 50) return null
  const sa = Float64Array.from(a).sort()
  const sb = Float64Array.from(b).sort()
  const from = quantile(sa, 0.9) - quantile(sa, 0.5)
  const db = quantile(sb, 0.9) - quantile(sb, 0.5)
  let g = from > 0 && db > 0 ? db / from : 1
  let o = quantile(sb, 0.5) - g * quantile(sa, 0.5)
  const weights = new Float64Array(n).fill(1)
  const residuals = new Float64Array(n)
  const absolute = new Float64Array(n)
  let correlation = 0

  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < n; i++) residuals[i] = b[i] - g * a[i] - o
    const center = median(residuals)
    for (let i = 0; i < n; i++) absolute[i] = Math.abs(residuals[i] - center)
    const limit = 4.685 * Math.max(1e-12, 1.4826 * median(absolute))
    let sw = 0
    let ma = 0
    let mb = 0
    for (let i = 0; i < n; i++) {
      const u = (residuals[i] - center) / limit
      const p = Math.abs(u) >= 1 ? 0 : (1 - u * u) * (1 - u * u)
      weights[i] = p
      sw += p
      ma += p * a[i]
      mb += p * b[i]
    }
    if (sw < 20) return null
    ma /= sw
    mb /= sw
    let saa = 0
    let sbb = 0
    let sab = 0
    for (let i = 0; i < n; i++) {
      const p = weights[i]
      if (p === 0) continue
      const xa = a[i] - ma
      const xb = b[i] - mb
      saa += p * xa * xa
      sbb += p * xb * xb
      sab += p * xa * xb
    }
    const newValue = demingSlope(saa / sw, sbb / sw, sab / sw, lambda)
    if (newValue === null) return null
    correlation = sab / Math.sqrt(saa * sbb)
    g = newValue
    o = mb - g * ma
  }
  if (correlation < 0.3 || g < 0.2 || g > 5) return null

  // Jackknife over ten contiguous bands (blocks are collected row by
  // row, so a band is a strip of the overlap).
  const STRIPS = 10
  const sums = Array.from({ length: STRIPS }, () => new Float64Array(6))
  for (let i = 0; i < n; i++) {
    const p = weights[i]
    if (p === 0) continue
    const s = sums[Math.min(STRIPS - 1, Math.floor((i * STRIPS) / n))]
    s[0] += p
    s[1] += p * a[i]
    s[2] += p * b[i]
    s[3] += p * a[i] * a[i]
    s[4] += p * b[i] * b[i]
    s[5] += p * a[i] * b[i]
  }
  const total = new Float64Array(6)
  for (const s of sums) for (let k = 0; k < 6; k++) total[k] += s[k]
  const lnG: number[] = []
  for (const s of sums) {
    const w = total[0] - s[0]
    if (w <= 0) return null
    const ma = (total[1] - s[1]) / w
    const mb = (total[2] - s[2]) / w
    const saa = (total[3] - s[3]) / w - ma * ma
    const sbb = (total[4] - s[4]) / w - mb * mb
    const sab = (total[5] - s[5]) / w - ma * mb
    const gk = demingSlope(saa, sbb, sab, lambda)
    if (gk === null) return null
    lnG.push(Math.log(gk))
  }
  const mean = lnG.reduce((x, y) => x + y, 0) / STRIPS
  const variance = (lnG.reduce((x, y) => x + (y - mean) ** 2, 0) * (STRIPS - 1)) / STRIPS
  const uncertainty = Math.sqrt(variance)
  if (!(uncertainty < MAX_UNCERTAINTY)) return null
  return { g, o, uncertainty }
}

/** Pair of compared panels: averaged blocks in the overlap. */
interface Comparison {
  a: number
  b: number
  /** Per channel, the mean values of the blocks in the two panels. */
  va: Float64Array[]
  vb: Float64Array[]
  /** Per channel, the measured line (null if the gain is not measurable). */
  lines: (Line | null)[]
}

/** Value above which a pixel is considered saturated (scale from 0 to 1). */
const SATURATION = 0.95

/**
 * Collects the blocks of the overlap between two panels.
 *
 * Stars are kept: an 8 × 8-pixel block contains almost all the light of a
 * star even if the sharpness differs in the two panels, so their means
 * follow the same line as the background and even measure it better. Only
 * blocks with saturated pixels are removed, where the line breaks.
 * Removing the "brightest" blocks by looking at the values themselves
 * would instead distort the slope, because it would pick exactly those in
 * which noise has pushed one of the two panels upward.
 */
function compare(
  ia: number,
  ib: number,
  A: Reprojected,
  B: Reprojected,
  channels: number
): Comparison | null {
  const x0 = Math.max(A.r.x0, B.r.x0)
  const y0 = Math.max(A.r.y0, B.r.y0)
  const x1 = Math.min(A.r.x1, B.r.x1)
  const y1 = Math.min(A.r.y1, B.r.y1)
  if (x1 - x0 < BLOCK || y1 - y0 < BLOCK) return null

  const nbx = Math.floor((x1 - x0) / BLOCK)
  const nby = Math.floor((y1 - y0) / BLOCK)
  // At most about fifty thousand blocks: more than enough.
  const jump = Math.max(1, Math.floor(Math.sqrt((nbx * nby) / 50000)))
  const pa = A.bw * A.bh
  const pb = B.bw * B.bh
  const collectedA: number[][] = Array.from({ length: channels }, () => [])
  const collectedB: number[][] = Array.from({ length: channels }, () => [])
  const mean = new Float64Array(channels * 2)
  const k = BLOCK * BLOCK

  for (let by = 0; by < nby; by += jump) {
    for (let bx = 0; bx < nbx; bx += jump) {
      mean.fill(0)
      let good = true
      for (let dy = 0; dy < BLOCK && good; dy++) {
        const y = y0 + by * BLOCK + dy
        for (let dx = 0; dx < BLOCK; dx++) {
          const x = x0 + bx * BLOCK + dx
          const oa = (y - A.r.y0) * A.bw + (x - A.r.x0)
          const ob = (y - B.r.y0) * B.bw + (x - B.r.x0)
          if (A.weights[oa] < A.minWeight || B.weights[ob] < B.minWeight) {
            good = false
            break
          }
          for (let c = 0; c < channels; c++) {
            const va = A.values[c * pa + oa]
            const vb = B.values[c * pb + ob]
            if (va >= SATURATION || vb >= SATURATION) good = false
            mean[c] += va
            mean[channels + c] += vb
          }
          if (!good) break
        }
      }
      if (!good) continue
      for (let c = 0; c < channels; c++) {
        collectedA[c].push(mean[c] / k)
        collectedB[c].push(mean[channels + c] / k)
      }
    }
  }
  if (collectedA[0].length < 50) return null

  return {
    a: ia,
    b: ib,
    va: collectedA.map((v) => Float64Array.from(v)),
    vb: collectedB.map((v) => Float64Array.from(v)),
    lines: []
  }
}

/**
 * Solves a small linear system (Gaussian elimination with pivoting).
 */
function solve(m: Float64Array[], r: Float64Array): Float64Array {
  const n = r.length
  const A = m.map((row) => Float64Array.from(row))
  const b = Float64Array.from(r)
  for (let k = 0; k < n; k++) {
    let p = k
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > Math.abs(A[p][k])) p = i
    if (p !== k) {
      const t = A[k]
      A[k] = A[p]
      A[p] = t
      const tb = b[k]
      b[k] = b[p]
      b[p] = tb
    }
    const piv = A[k][k]
    if (Math.abs(piv) < 1e-300) continue
    for (let i = k + 1; i < n; i++) {
      const f = A[i][k] / piv
      if (f === 0) continue
      for (let j = k; j < n; j++) A[i][j] -= f * A[k][j]
      b[i] -= f * b[k]
    }
  }
  const x = new Float64Array(n)
  for (let k = n - 1; k >= 0; k--) {
    let s = b[k]
    for (let j = k + 1; j < n; j++) s -= A[k][j] * x[j]
    x[k] = Math.abs(A[k][k]) < 1e-300 ? 0 : s / A[k][k]
  }
  return x
}

/**
 * Least squares on the differences: x[a] - x[b] ≈ d, with x[ref] = 0.
 * Panels not connected to the reference stay close to zero.
 */
function leastSquaresDifferences(
  n: number,
  ref: number,
  equations: { a: number; b: number; d: number; weight: number }[]
): Float64Array {
  const M = Array.from({ length: n }, () => new Float64Array(n))
  const r = new Float64Array(n)
  for (const e of equations) {
    M[e.a][e.a] += e.weight
    M[e.b][e.b] += e.weight
    M[e.a][e.b] -= e.weight
    M[e.b][e.a] -= e.weight
    r[e.a] += e.weight * e.d
    r[e.b] -= e.weight * e.d
  }
  // A thread of regularisation holds the disconnected groups still, and a
  // huge weight pins the reference.
  let trace = 1
  for (let i = 0; i < n; i++) trace += M[i][i]
  for (let i = 0; i < n; i++) M[i][i] += trace * 1e-9
  M[ref][ref] += trace * 1e6
  return solve(M, r)
}

/* ------------------------------------------------------------------ */
/* Composition                                                        */
/* ------------------------------------------------------------------ */

/**
 * Composes the mosaic.
 *
 * @param panels description (size and astrometric solution) of each panel
 * @param read    returns the pixels of panel k; it is called once per
 *                 panel, so the caller can decode them one at a time and
 *                 keep only one in memory
 * @param advance   progress from 0 to 1, with a description of the phase
 */
export function composeMosaic(
  panels: PanelDescription[],
  read: (k: number) => ImageData32,
  options: MosaicOptions = {},
  advance?: (label: string, fraction: number) => void
): MosaicResult {
  const geometry = mosaicGeometry(panels)
  const n = panels.length
  const W = geometry.width
  const H = geometry.height
  const featherFraction = options.feather ?? 0.12

  // --- Reprojection, one panel at a time ---
  const reprojected: Reprojected[] = []
  const noises: number[][] = []
  let channels = 1 as 1 | 3
  for (let k = 0; k < n; k++) {
    advance?.(t('coreMosaic.progress.reprojecting', { current: k + 1, total: n }), (k / n) * 0.7)
    const img = read(k)
    if (img.width !== panels[k].width || img.height !== panels[k].height) {
      throw new Error(t('coreMosaic.panelSizeMismatch', { panel: k + 1 }))
    }
    // If even a single panel is colour, the mosaic is colour: the
    // black-and-white ones are repeated over the three channels.
    const channelsHere: 1 | 3 = img.channels === 3 || channels === 3 ? 3 : 1
    if (channelsHere === 3 && channels === 1 && k > 0) {
      // Previous black-and-white panels: their channel is repeated.
      for (const p of reprojected) {
        const area = p.bw * p.bh
        const three = new Float32Array(area * 3)
        three.set(p.values, 0)
        three.set(p.values, area)
        three.set(p.values, area * 2)
        p.values = three
      }
      for (const r of noises) r.push(r[0], r[0])
    }
    channels = channelsHere
    reprojected.push(reproject(img, panels[k].wcs, geometry, geometry.boxes[k], channels, featherFraction))
    noises.push(noisePerChannel(img, channels))
  }

  // --- Photometric matching ---
  const gains = Array.from({ length: n }, () => new Array<number>(channels).fill(1))
  const backgrounds = Array.from({ length: n }, () => new Array<number>(channels).fill(0))
  const comparisons: Comparison[] = []
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const c = compare(a, b, reprojected[a], reprojected[b], channels)
      if (c !== null) comparisons.push(c)
    }
  }
  advance?.(t('coreMosaic.progress.matching'), 0.75)

  // Connected panels: one that overlaps none stays as it is.
  const neighbors = Array.from({ length: n }, () => [] as number[])
  const blocksPer = new Array<number>(n).fill(0)
  for (const c of comparisons) {
    neighbors[c.a].push(c.b)
    neighbors[c.b].push(c.a)
    blocksPer[c.a] += c.va[0].length
    blocksPer[c.b] += c.va[0].length
  }
  // Photometric reference: the panel with the most overlap.
  let refPhoto = 0
  for (let k = 1; k < n; k++) if (blocksPer[k] > blocksPer[refPhoto]) refPhoto = k
  const reached = new Set<number>([refPhoto])
  const tail = [refPhoto]
  while (tail.length > 0) {
    const k = tail.shift() as number
    for (const v of neighbors[k]) {
      if (!reached.has(v)) {
        reached.add(v)
        tail.push(v)
      }
    }
  }
  const isolated: number[] = []
  for (let k = 0; k < n; k++) if (!reached.has(k)) isolated.push(k)

  if (options.blend !== false && comparisons.length > 0) {
    for (let c = 0; c < channels; c++) {
      // Gains: ln G_a - ln G_b = ln g, from the pairs where it is measured.
      const eqG: { a: number; b: number; d: number; weight: number }[] = []
      for (const cf of comparisons) {
        const lambda =
          noises[cf.a][c] > 0 && noises[cf.b][c] > 0 ? (noises[cf.b][c] / noises[cf.a][c]) ** 2 : 1
        const line = robustLine(cf.va[c], cf.vb[c], lambda)
        cf.lines[c] = line
        // Each pair weighs according to the precision of its measurement.
        if (line !== null) eqG.push({ a: cf.a, b: cf.b, d: Math.log(line.g), weight: 1 / (line.uncertainty * line.uncertainty + 1e-6) })
      }
      const lnG = leastSquaresDifferences(n, refPhoto, eqG)
      for (let k = 0; k < n; k++) gains[k][c] = Math.exp(lnG[k])

      // Backgrounds: with the gains now known, the background difference of
      // each pair is the median of b - g·a, which stars do not shift.
      const eqO: { a: number; b: number; d: number; weight: number }[] = []
      for (const cf of comparisons) {
        const g = gains[cf.a][c] / gains[cf.b][c]
        const rejections = new Float64Array(cf.va[c].length)
        for (let i = 0; i < rejections.length; i++) rejections[i] = cf.vb[c][i] - g * cf.va[c][i]
        const o = median(rejections)
        eqO.push({ a: cf.a, b: cf.b, d: gains[cf.b][c] * o, weight: rejections.length })
      }
      const O = leastSquaresDifferences(n, refPhoto, eqO)
      for (let k = 0; k < n; k++) backgrounds[k][c] = O[k]
    }
    // An isolated panel has nothing to compare against.
    for (const k of isolated) {
      gains[k].fill(1)
      backgrounds[k].fill(0)
    }
  }

  // --- Blending ---
  advance?.(t('coreMosaic.progress.merging'), 0.8)
  const N = W * H
  const sums = new Float32Array(N * channels)
  const totalWeights = new Float32Array(N)
  const coverage = new Uint8Array(N)
  // In the shared areas the cleanest panel counts more: weight inversely
  // proportional to the noise variance, after matching.
  const variances = gains.map((g, k) => {
    let v = 0
    for (let c = 0; c < channels; c++) v += (g[c] * noises[k][c]) ** 2
    return v / channels
  })
  const minimum = Math.min(...variances.filter((v) => v > 0))
  const noiseWeight = variances.map((v) => (v > 0 && Number.isFinite(minimum) ? minimum / v : 1))
  for (let k = 0; k < n; k++) {
    const p = reprojected[k]
    const area = p.bw * p.bh
    const factor = noiseWeight[k]
    for (let jj = 0; jj < p.bh; jj++) {
      const y = p.r.y0 + jj
      for (let ii = 0; ii < p.bw; ii++) {
        const o = jj * p.bw + ii
        const weight = p.weights[o] * factor
        if (weight <= 0) continue
        const i = y * W + p.r.x0 + ii
        totalWeights[i] += weight
        if (coverage[i] < 255) coverage[i]++
        for (let c = 0; c < channels; c++) {
          sums[c * N + i] += weight * (gains[k][c] * p.values[c * area + o] + backgrounds[k][c])
        }
      }
    }
    // The reprojected panel is no longer needed.
    reprojected[k] = { ...p, values: new Float32Array(0), weights: new Float32Array(0) }
    advance?.(t('coreMosaic.progress.merging'), 0.8 + ((k + 1) / n) * 0.15)
  }

  let covered = 0
  let overlapping = 0
  let max = 0
  for (let i = 0; i < N; i++) {
    if (totalWeights[i] > 0) {
      covered++
      if (coverage[i] > 1) overlapping++
      const inv = 1 / totalWeights[i]
      for (let c = 0; c < channels; c++) {
        let v = sums[c * N + i] * inv
        if (v < 0) v = 0
        sums[c * N + i] = v
        if (v > max) max = v
      }
    }
  }

  // Values on the 0-to-1 scale like the rest of the program: if matching
  // has raised some panel beyond it, everything is lowered together.
  if (max > 1) {
    const k = 1 / max
    for (let i = 0; i < sums.length; i++) sums[i] *= k
    for (const g of gains) for (let c = 0; c < channels; c++) g[c] *= k
    for (const f of backgrounds) for (let c = 0; c < channels; c++) f[c] *= k
  }

  // Outside the panels: the typical sky background, not black, so that
  // automatic stretching and filters are not fooled by the empty area.
  const padding: number[] = []
  const step = Math.max(1, Math.floor(N / 200000))
  for (let c = 0; c < channels; c++) {
    const samples: number[] = []
    for (let i = 0; i < N; i += step) if (totalWeights[i] > 0) samples.push(sums[c * N + i])
    const background = samples.length > 0 ? quantile(Float64Array.from(samples).sort(), 0.25) : 0
    padding.push(background)
    for (let i = 0; i < N; i++) if (totalWeights[i] === 0) sums[c * N + i] = background
  }

  advance?.(t('coreMosaic.progress.ready'), 1)

  return {
    image: { width: W, height: H, channels: channels, data: sums },
    wcs: geometry.wcs,
    scale: geometry.scale,
    coverage,
    coveredFraction: covered / N,
    overlapFraction: overlapping / N,
    corrections: gains.map((g, k) => ({ gain: g, background: backgrounds[k] })),
    overlaps: comparisons.map((cf) => ({
      a: cf.a,
      b: cf.b,
      blocks: cf.va[0].length,
      measuredGain: Array.from({ length: channels }, (_, c) => (cf.lines[c] ?? null) !== null)
    })),
    isolated,
    padding
  }
}

/**
 * Thumbnail of the coverage map, to show it in the interface: each cell
 * reports how many panels cover the corresponding pixel.
 */
export function coverageThumbnail(
  coverage: Uint8Array,
  width: number,
  height: number,
  maxSide = 240
): { data: Uint8Array; width: number; height: number } {
  const f = Math.min(1, maxSide / Math.max(width, height))
  const w = Math.max(1, Math.round(width * f))
  const h = Math.max(1, Math.round(height * f))
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) / h) * height))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) / w) * width))
      data[y * w + x] = coverage[sy * width + sx]
    }
  }
  return { data, width: w, height: h }
}
