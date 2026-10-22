import type { ImageData32 } from '@shared/types'
import { MAD_TO_SIGMA } from './stats'
import { blurInPlace } from './cleanup'
import { takeShared, returnShared } from './parallel'
import { toLuminance } from './debayer'
import { detectStars } from '../stars/detection'
import { kth, medianAndMad } from './selection'

/**
 * Star reduction, without neural networks.
 *
 * In a star-rich field the stars catch the eye and the nebula or galaxy
 * fades into the background. Shrinking them and lowering their light a
 * little gives the object its prominence back.
 *
 * The method does not erase and redraw the star, which would leave a smooth
 * disk or a dark hole: it warps the image around each star, like a lens that
 * shrinks, so the center shows the star itself, smaller, and the surrounding
 * corona is filled with the sky (and nebula) that was just outside. The
 * warp fades smoothly to zero at a certain distance, so there is no edge.
 *
 * A warp magnifies the sky slightly in the corona, and interpolation smooths
 * the noise grain: a smoother patch would appear around every star. To avoid
 * this the image is split into a soft part, which is warped, and a fine part
 * (grain and single-pixel detail). The fine part stays in place where there
 * was no star; where there was a star and there is now sky, the grain is
 * taken from a nearby sky pixel, without interpolating it; where a star
 * remains after the reduction, it follows the star.
 *
 * Everything works on the difference from each star's local background,
 * measured channel by channel on a ring around it, which includes the
 * underlying nebula: the attenuation lowers only the star's light, in the
 * same proportion on the three channels, so the color stays that of the
 * star and the background is not darkened.
 */

export interface StarReductionParams {
  /** From 0 to 1: 0 no effect, 1 maximum reduction (diameter roughly halved). */
  quantity: number
  /** From 0 to 1: how much to also lower the stars' brightness. */
  attenuation: number
}

export const NEUTRAL_STAR_REDUCTION: StarReductionParams = {
  quantity: 0,
  attenuation: 0
}

/** Side of the blocks on which the large-scale background is measured. */
const BLOCK = 32
/** Factor left to the stars' light at maximum attenuation. */
const RESIDUAL_LIGHT = 0.35
/**
 * Radius of the blur that separates the soft (warped) part from the grain.
 * It must be wide enough to leave almost only structure in the soft part:
 * warped grain would stretch into rays around large stars.
 */
const SOFT_RADIUS = 2
/**
 * How far the fine part of a star extends beyond its visible radius: the
 * blur that separates the two parts widens the soft part, and the fine part
 * becomes negative in a ring around it.
 */
const FINE_MARGIN = 5
/**
 * Beyond how many times the grain a detail of the fine part is structure,
 * to be warped together with the soft part (see `reduceStars`).
 */
const STRUCTURE_THRESHOLD = 3
/** Maximum radius considered for a star, halos included. */
const MAX_RADIUS = 160
/** Samples taken by `medianAndMad` with its default limit. */
const MEDIAN_SAMPLES = 200000

/** A measured star, ready for warping. */
interface MeasuredStar {
  x: number
  y: number
  /** Radius beyond which the star's light merges with the background. */
  radius: number
  /** Radius of the warped zone. */
  zoneRadius: number
  /** Local background per channel and for the luminance. */
  background: number[]
  lumBackground: number
  /** Radius at which the light falls to half of the center. */
  halfSize: number
  /** Highest value of the central pixels, used to recognize saturated stars. */
  rawMax: number
  /**
   * From 0 to 1, how much the star stands out from the structures around it.
   * A faint dot among the arms of a galaxy may be a cluster or a hydrogen
   * region: it is barely touched.
   */
  certainty: number
}

/**
 * Measurements shared by the reduction and the automatic choice. They are
 * the longest step of the tool: Abracadabra computes them once and passes
 * them to both (see `analyzeStars`). They are not modified. The smoothed
 * luminance is a temporary plane from the pool of parallel.ts: whoever is
 * done with the measurements gives it back with `releaseStarAnalysis`.
 */
export interface StarAnalysis {
  stars: MeasuredStar[]
  /** Lightly smoothed luminance and its noise. */
  softLuminance: Float32Array
  softNoise: number
}

/**
 * Distance from the origin. `Math.hypot` guards against huge values that do
 * not occur here and is several times slower: in loops over the pixels around
 * tens of thousands of stars the difference is noticeable.
 */
const distance = (x: number, y: number): number => Math.sqrt(x * x + y * y)

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Large-scale background: median of each block, then interpolated. Stars
 * occupy few pixels of a block and do not shift the median; extended
 * nebulosity does, and that is exactly what must be removed in order to find
 * stars on top of it too.
 */
function backgroundInBlocks(
  lum: Float32Array,
  w: number,
  h: number,
  background: Float32Array = new Float32Array(w * h)
): Float32Array {
  const bx = Math.max(1, Math.ceil(w / BLOCK))
  const by = Math.max(1, Math.ceil(h / BLOCK))
  const medians = new Float32Array(bx * by)
  const tmp = new Float32Array(BLOCK * BLOCK)
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      let k = 0
      const y1 = Math.min(h, (j + 1) * BLOCK)
      const x1 = Math.min(w, (i + 1) * BLOCK)
      for (let y = j * BLOCK; y < y1; y++) {
        for (let x = i * BLOCK; x < x1; x++) tmp[k++] = lum[y * w + x]
      }
      medians[j * bx + i] = kth(tmp, k >> 1, k)
    }
  }
  // Positions and weights along the row, the same for all rows: computed once.
  const column0 = new Int32Array(w)
  const column1 = new Int32Array(w)
  const weightX = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    const fx = Math.min(bx - 1, Math.max(0, (x + 0.5) / BLOCK - 0.5))
    column0[x] = Math.floor(fx)
    column1[x] = Math.min(bx - 1, column0[x] + 1)
    weightX[x] = fx - column0[x]
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(by - 1, Math.max(0, (y + 0.5) / BLOCK - 0.5))
    const j0 = Math.floor(fy)
    const j1 = Math.min(by - 1, j0 + 1)
    const ty = fy - j0
    for (let x = 0; x < w; x++) {
      const i0 = column0[x]
      const i1 = column1[x]
      const tx = weightX[x]
      const a = medians[j0 * bx + i0] * (1 - tx) + medians[j0 * bx + i1] * tx
      const b = medians[j1 * bx + i0] * (1 - tx) + medians[j1 * bx + i1] * tx
      background[y * w + x] = a * (1 - ty) + b * ty
    }
  }
  return background
}

/** Median of a portion of an array (reordered in place). */
function median(v: Float32Array): number {
  if (v.length === 0) return 0
  return kth(v, v.length >> 1)
}

/**
 * Detects the stars and measures their radius and local background.
 *
 * Detection works on the luminance with the large-scale background removed,
 * so it also finds stars on top of the nebula. For each star a radial
 * profile is built (median of rings one pixel wide, which ignores
 * neighboring stars) and the point where it falls to the background level is
 * sought: that is the visible radius, halo included.
 */
export function analyzeStars(img: ImageData32): StarAnalysis {
  const w = img.width
  const h = img.height
  const n = w * h
  // The luminance and the residual are temporary planes from the pool of
  // parallel.ts, given back at the end. The background is computed into the
  // array that then becomes the residual, and the residual of the smoothed
  // luminance only at the pixels that `medianAndMad` samples: on large
  // images two full planes fewer.
  const lum = img.channels === 1 ? img.data : toLuminance(img, takeShared(n))
  const residual = backgroundInBlocks(lum, w, h, takeShared(n))

  // Lightly smoothed luminance: tells pixel by pixel how much star light
  // there is, with less noise than the raw luminance.
  const softLuminance = takeShared(n)
  softLuminance.set(lum)
  blurInPlace(softLuminance, w, h, 1)
  const step = Math.max(1, Math.floor(n / MEDIAN_SAMPLES))
  const softResidual = new Float32Array(Math.floor(n / step))
  for (let k = 0; k < softResidual.length; k++) softResidual[k] = softLuminance[k * step] - residual[k * step]
  const stM = medianAndMad(softResidual, Infinity)
  const softNoise = Math.max(1e-7, stM.mad * MAD_TO_SIGMA)

  for (let i = 0; i < n; i++) residual[i] = lum[i] - residual[i]
  const st = medianAndMad(residual)
  const sigma = Math.max(1e-6, st.mad * MAD_TO_SIGMA)

  const foundAll = detectStars(
    { width: w, height: h, channels: 1, data: residual },
    { threshold: 5, minPixels: 3, maxPixels: 40000, max: 100000 }
  )

  const stars: MeasuredStar[] = []
  // Containers reused for the rings.
  const counts = new Int32Array(MAX_RADIUS + 2)
  const starts = new Int32Array(MAX_RADIUS + 3)
  let values = new Float32Array(4096)
  const ring = new Float32Array(4 * (MAX_RADIUS + 8) * 8 * 3 + 64)

  for (const s of foundAll) {
    const rc = Math.sqrt(s.pixel / Math.PI)
    const rMax = Math.round(Math.min(MAX_RADIUS, Math.max(10, 4 * rc + 6, 5 * s.hfr + 6)))
    const cx = s.x
    const cy = s.y
    const x0 = Math.max(0, Math.floor(cx - rMax))
    const x1 = Math.min(w - 1, Math.ceil(cx + rMax))
    const y0 = Math.max(0, Math.floor(cy - rMax))
    const y1 = Math.min(h - 1, Math.ceil(cy + rMax))

    // Radial profile in two passes: counting and filling.
    counts.fill(0, 0, rMax + 1)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const r = Math.floor(distance(x - cx, y - cy))
        if (r <= rMax) counts[r]++
      }
    }
    starts[0] = 0
    for (let r = 0; r <= rMax; r++) starts[r + 1] = starts[r] + counts[r]
    const total = starts[rMax + 1]
    if (values.length < total) values = new Float32Array(total * 2)
    counts.fill(0, 0, rMax + 1)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const r = Math.floor(distance(x - cx, y - cy))
        if (r <= rMax) values[starts[r] + counts[r]++] = residual[y * w + x]
      }
    }
    const profile = new Float32Array(rMax + 1)
    for (let r = 0; r <= rMax; r++) profile[r] = median(values.subarray(starts[r], starts[r + 1]))

    // Distant background: the outer band of the box.
    const rEst = Math.floor(rMax * 0.7)
    const far = median(values.slice(starts[rEst], total))
    const peak = Math.max(profile[0], profile[1] ?? profile[0]) - far
    if (peak < 5 * sigma) continue

    // Visible radius: where the ring falls almost to the background.
    let radius = rEst
    for (let r = 1; r < rEst; r++) {
      const nr = Math.max(1, starts[r + 1] - starts[r])
      const threshold = 0.5 * sigma + (2.5 * sigma) / Math.sqrt(nr)
      if (profile[r] - far < threshold) {
        radius = r
        break
      }
    }
    radius = Math.max(1.5, radius)

    // Half-maximum radius: for a star it depends only on focus, for a
    // nebula knot it is much wider.
    let halfSize = rEst
    const center = profile[0] - far
    for (let r = 1; r < rEst; r++) {
      const v = profile[r] - far
      if (v < center * 0.5) {
        const before = profile[r - 1] - far
        halfSize = r - 1 + (before - center * 0.5) / Math.max(1e-9, before - v)
        break
      }
    }
    let rawMax = 0
    for (let y = Math.max(0, Math.round(cy) - 1); y <= Math.min(h - 1, Math.round(cy) + 1); y++) {
      for (let x = Math.max(0, Math.round(cx) - 1); x <= Math.min(w - 1, Math.round(cx) + 1); x++) {
        for (let c = 0; c < img.channels; c++)
          rawMax = Math.max(rawMax, img.data[c * n + y * w + x])
      }
    }

    // The profile of a star on top of a curved nebula may never fall to the
    // background: the radius is limited to what a star of that width and
    // that light can have (for a Gaussian it grows with the square root of
    // the logarithm of the contrast).
    const limit = 2 + 4 * halfSize * Math.sqrt(Math.log(Math.max(Math.E, peak / sigma)))
    radius = Math.min(radius, limit)

    // Local background per channel on a ring just outside the star.
    const rIn = radius + 1
    const rOut = radius + 4
    const channelBackgrounds: number[] = []
    let k = 0
    for (let c = 0; c <= img.channels; c++) {
      k = 0
      const plane = c < img.channels ? img.data.subarray(c * n, (c + 1) * n) : lum
      for (let y = Math.max(0, Math.floor(cy - rOut)); y <= Math.min(h - 1, Math.ceil(cy + rOut)); y++) {
        for (let x = Math.max(0, Math.floor(cx - rOut)); x <= Math.min(w - 1, Math.ceil(cx + rOut)); x++) {
          const d = distance(x - cx, y - cy)
          if (d >= rIn && d < rOut && k < ring.length) ring[k++] = plane[y * w + x]
        }
      }
      channelBackgrounds.push(k > 0 ? median(ring.subarray(0, k)) : 0)
    }
    const lumBackground = channelBackgrounds.pop() as number

    // Background agitation around: noise on empty sky, much more over the
    // structures of a galaxy or nebula.
    k = 0
    const rA = radius + 2
    const rB = radius + 8
    for (let y = Math.max(0, Math.floor(cy - rB)); y <= Math.min(h - 1, Math.ceil(cy + rB)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rB)); x <= Math.min(w - 1, Math.ceil(cx + rB)); x++) {
        const d = distance(x - cx, y - cy)
        if (d >= rA && d < rB && k < ring.length) ring[k++] = residual[y * w + x]
      }
    }
    let jitter = sigma
    if (k > 8) {
      const part = ring.subarray(0, k)
      const med = median(part)
      for (let q = 0; q < k; q++) part[q] = Math.abs(part[q] - med)
      jitter = Math.max(sigma, median(part) * MAD_TO_SIGMA)
    }
    const certainty = smooth(2, 6, peak / jitter)

    stars.push({
      x: cx,
      y: cy,
      radius,
      zoneRadius: 3 * radius + 3,
      background: channelBackgrounds,
      lumBackground,
      halfSize,
      rawMax,
      certainty
    })
  }

  /*
   * Rejection of what is not a star. All stars have roughly the same full
   * width at half maximum, set by the optics and the seeing; bright knots of
   * a nebula or the core of a galaxy are much wider. Saturated stars are an
   * exception, as their flat top widens the measurement.
   */
  const halfSizes = Float32Array.from(stars.map((s) => s.halfSize)).sort()
  const typicalHalfSize = halfSizes.length > 0 ? halfSizes[halfSizes.length >> 1] : 2
  let max = 0
  for (let i = 0; i < img.data.length; i++) if (img.data[i] > max) max = img.data[i]
  const real = stars.filter((s) => s.halfSize <= 2 * typicalHalfSize + 1 || s.rawMax >= 0.95 * max)

  if (lum !== img.data) returnShared(lum)
  returnShared(residual)
  return { stars: real, softLuminance, softNoise }
}

/**
 * Radial displacement divided by the distance, at relative distance u from
 * the center (u = 1 at the edge of the zone). Up to u0, where the edge of
 * the shrunken star arrives, the displacement grows in proportion (uniform
 * reduction by a factor 1 + a); beyond that, it falls smoothly to zero.
 * Letting it fall gradually, rather than multiplying the reduction by a
 * ramp, keeps the stretching of the outer corona low: what lies there
 * (nearby faint stars, nebula detail) stays almost undistorted.
 */
function shiftFactor(u: number, u0: number, a: number): number {
  if (u <= u0) return a
  return (a * u0 * (1 - smooth(u0, 1, u))) / u
}

/** Bilinear sampling with clamped borders. */
function bilinear(p: Float32Array, w: number, h: number, x: number, y: number): number {
  const xc = Math.min(w - 1.001, Math.max(0, x))
  const yc = Math.min(h - 1.001, Math.max(0, y))
  const x0 = Math.floor(xc)
  const y0 = Math.floor(yc)
  const tx = xc - x0
  const ty = yc - y0
  const i = y0 * w + x0
  const a = p[i] + (p[i + 1] - p[i]) * tx
  const b = p[i + w] + (p[i + w + 1] - p[i + w]) * tx
  return a + (b - a) * ty
}

/**
 * Reduces and attenuates the stars. Works on linear data and returns a new
 * image; the original is not touched, unless `inPlace` is true (see below).
 *
 * Memory. The fields that describe the warp (displacement, owner star,
 * weights, local backgrounds) are needed only at the pixel itself, so they
 * are computed one band of rows at a time instead of as full planes: on a
 * large image they would be more than a dozen planes, gigabytes. Each band
 * receives the contributions of the stars in the same order as a full plane
 * would, so every value is the same. The footprint of the stars is read at
 * displaced positions and stays a full plane. The rigidity step needs the
 * displacement at the center of each star, which is measured in a first
 * pass over the bands.
 *
 * With `inPlace` the result is written into the pixels of `img`, row by
 * row: the processing chain uses it on images that belong to it alone. The
 * warp reads the original values at displaced positions, also in rows
 * already written: the original rows are kept in a ring buffer as deep as
 * the farthest such read (the displacement, which is bounded, or the
 * donor patch), and read from there. The result is the same as with a copy.
 */
export function reduceStars(
  img: ImageData32,
  p: StarReductionParams,
  /** Measurements already taken on this same image, to avoid repeating them. */
  analysis?: StarAnalysis,
  inPlace = false
): ImageData32 {
  const quantity = Math.min(1, Math.max(0, p.quantity))
  const attenuation = Math.min(1, Math.max(0, p.attenuation))
  const w = img.width
  const h = img.height
  const n = w * h
  const c = img.channels
  if (quantity <= 0 && attenuation <= 0) return inPlace ? img : { ...img, data: img.data.slice() }

  // Soft part of each channel; the fine part is the difference from the
  // original and is computed on the fly, without keeping it in memory.
  // Like the footprint below, a temporary plane from the pool of
  // parallel.ts, given back at the end.
  const softValues: Float32Array[] = []
  for (let k = 0; k < c; k++) {
    const soft = takeShared(n)
    soft.set(img.data.subarray(k * n, (k + 1) * n))
    softValues.push(blurInPlace(soft, w, h, SOFT_RADIUS))
  }

  const own = analysis ? null : analyzeStars(img)
  const { stars, softLuminance, softNoise } = analysis ?? (own as StarAnalysis)

  /*
   * Displacement field: for each pixel, where to take the value from.
   * Around a star the pixel looks farther from the center, by a factor 1/k
   * up to the edge of the shrunken star (k is the diameter reduction factor,
   * from 1 to 0.5), then less and less until it no longer moves at the edge
   * of the zone. The contributions of nearby stars add up, so two adjacent
   * stars both stay in their place.
   */
  const k = 1 - 0.5 * quantity
  const count = stars.length
  // Zone of each star: its rows, to find the stars that touch a band.
  const zoneTop = new Int32Array(count)
  const zoneBottom = new Int32Array(count)
  for (let s = 0; s < count; s++) {
    const st = stars[s]
    zoneTop[s] = Math.max(0, Math.floor(st.y - st.zoneRadius))
    zoneBottom[s] = Math.min(h - 1, Math.ceil(st.y + st.zoneRadius))
  }

  // Footprint of the original stars: where their light (and their fine part,
  // which has a negative ring around the core) extends.
  const footprint = takeShared(n).fill(0)
  for (let s = 0; s < count; s++) {
    const st = stars[s]
    const Z = st.zoneRadius
    const x0 = Math.max(0, Math.floor(st.x - Z))
    const x1 = Math.min(w - 1, Math.ceil(st.x + Z))
    for (let y = zoneTop[s]; y <= zoneBottom[s]; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = distance(x - st.x, y - st.y)
        if (d >= Z) continue
        const i = y * w + x
        const f = 1 - smooth(st.radius + 2, st.radius + FINE_MARGIN, d)
        if (f > footprint[i]) footprint[i] = f
      }
    }
  }

  // Band fields (see the introduction), for the rows from `b0` on.
  const bandRows = Math.max(1, Math.min(h, Math.ceil(BAND_PIXELS / w)))
  const bandLength = (bandRows + 1) * w
  const spX = new Float32Array(bandLength)
  const spY = new Float32Array(bandLength)
  const owner = new Int32Array(bandLength)
  const propWeight = new Float32Array(bandLength)
  const attenuate = new Float32Array(bandLength)
  // Where to use the warped soft part: the footprint plus a short feathering.
  // Beyond that, the image stays the original, so the warp does not stretch
  // the details of the nebula or galaxy in the corona around the star.
  const warpedZone = new Float32Array(bandLength)
  // Local background as a weighted mean of the backgrounds of nearby stars:
  // it varies continuously from pixel to pixel, while taking that of a
  // single star would create steps where one gives way to another.
  const backgroundWeightSum = new Float32Array(bandLength)
  const backgroundSum: Float32Array[] = []
  for (let cc = 0; cc <= c; cc++) backgroundSum.push(new Float32Array(bandLength))

  /**
   * Computes the band fields for the rows from `b0` to `b1` (excluded): only
   * the displacement if `all` is false, everything otherwise.
   */
  const fillBand = (b0: number, b1: number, all: boolean): void => {
    const used = (b1 - b0) * w
    spX.fill(0, 0, used)
    spY.fill(0, 0, used)
    if (all) {
      owner.fill(-1, 0, used)
      propWeight.fill(0, 0, used)
      attenuate.fill(0, 0, used)
      warpedZone.fill(0, 0, used)
      backgroundWeightSum.fill(0, 0, used)
      for (const b of backgroundSum) b.fill(0, 0, used)
    }
    for (let s = 0; s < count; s++) {
      const ya = Math.max(zoneTop[s], b0)
      const yb = Math.min(zoneBottom[s], b1 - 1)
      if (ya > yb) continue
      const st = stars[s]
      const Z = st.zoneRadius
      const ks = 1 - (1 - k) * st.certainty
      const u0 = Math.min(0.6, (ks * st.radius) / Z)
      const x0 = Math.max(0, Math.floor(st.x - Z))
      const x1 = Math.min(w - 1, Math.ceil(st.x + Z))
      // The attenuation covers the shrunken star and a little beyond.
      const rAtt = Math.max(ks * st.radius, 1) * 1.5 + 1
      for (let y = ya; y <= yb; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - st.x
          const dy = y - st.y
          const d = distance(dx, dy)
          if (d >= Z) continue
          const i = (y - b0) * w + x
          const u = d / Z
          const f0 = shiftFactor(u, u0, 1 / ks - 1)
          spX[i] += dx * f0
          spY[i] += dy * f0
          if (!all) continue
          // The pixel belongs to the star in which it is relatively more
          // central: a small star on the halo of a large one uses its own
          // background, which includes the halo.
          const weight = 1 - u
          if (weight > propWeight[i]) {
            propWeight[i] = weight
            owner[i] = s
          }
          const pf = weight * weight
          backgroundWeightSum[i] += pf
          for (let cc = 0; cc < c; cc++) backgroundSum[cc][i] += pf * st.background[cc]
          backgroundSum[c][i] += pf * st.lumBackground
          const fz =
            1 - smooth(st.radius + FINE_MARGIN, st.radius + FINE_MARGIN + Math.max(4, 0.75 * st.radius), d)
          if (fz > warpedZone[i]) warpedZone[i] = fz
          const a = (1 - smooth(rAtt, rAtt + 2 + 0.5 * st.radius, d)) * st.certainty
          if (a > attenuate[i]) attenuate[i] = a
        }
      }
    }
  }

  /*
   * Rigidity. In the outer part of a star's zone the warp stretches in one
   * direction and compresses in the other: a small star located there would
   * be elongated into a dash. To avoid this, on each star's footprint the
   * displacement due to the others is replaced by the one measured at its
   * center, that is, a simple translation, and the full field is restored
   * gradually toward the edge of its zone. Where several stars compete for
   * a pixel the smallest prevails, as it is the one that would deform most.
   *
   * First pass: the displacement at the center of each star, read on the
   * band that contains the two rows of its bilinear sample (the band is
   * computed with one row more for this), and the largest vertical
   * displacement, which bounds how far the warp reads.
   */
  const shiftX = new Float32Array(count)
  const shiftY = new Float32Array(count)
  const sampleRow = new Int32Array(count)
  for (let s = 0; s < count; s++) sampleRow[s] = Math.floor(Math.min(h - 1.001, Math.max(0, stars[s].y)))
  let maxShift = 0
  for (let b0 = 0; b0 < h; b0 += bandRows) {
    const b1 = Math.min(h, b0 + bandRows)
    fillBand(b0, Math.min(h, b1 + 1), false)
    for (let i = 0; i < (b1 - b0) * w; i++) {
      const v = Math.abs(spY[i])
      if (v > maxShift) maxShift = v
    }
    for (let s = 0; s < count; s++) {
      if (sampleRow[s] < b0 || sampleRow[s] >= b1) continue
      shiftX[s] = bandBilinear(spX, b0, w, h, stars[s].x, stars[s].y)
      shiftY[s] = bandBilinear(spY, b0, w, h, stars[s].x, stars[s].y)
    }
  }
  const accX = new Float32Array(bandLength)
  const accY = new Float32Array(bandLength)
  const accWeight = new Float32Array(bandLength)
  const accShare = new Float32Array(bandLength)
  /** Applies the rigidity to the displacement of the band from `b0` to `b1`. */
  const rigidity = (b0: number, b1: number): void => {
    const used = (b1 - b0) * w
    accX.fill(0, 0, used)
    accY.fill(0, 0, used)
    accWeight.fill(0, 0, used)
    accShare.fill(0, 0, used)
    for (let s = 0; s < count; s++) {
      const ya = Math.max(zoneTop[s], b0)
      const yb = Math.min(zoneBottom[s], b1 - 1)
      if (ya > yb) continue
      const st = stars[s]
      const Z = st.zoneRadius
      const R = st.radius
      const ks = 1 - (1 - k) * st.certainty
      const u0 = Math.min(0.6, (ks * R) / Z)
      const end = Z
      const x0 = Math.max(0, Math.floor(st.x - end))
      const x1 = Math.min(w - 1, Math.ceil(st.x + end))
      for (let y = ya; y <= yb; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - st.x
          const dy = y - st.y
          const d = distance(dx, dy)
          const rigid = 1 - smooth(R, end, d)
          if (rigid <= 0) continue
          const i = (y - b0) * w + x
          const u = d / Z
          const own = shiftFactor(u, u0, 1 / ks - 1)
          const share = rigid / R
          accShare[i] += share
          accWeight[i] += rigid * share
          accX[i] += rigid * share * (shiftX[s] + dx * own)
          accY[i] += rigid * share * (shiftY[s] + dy * own)
        }
      }
    }
    for (let i = 0; i < used; i++) {
      const q = accShare[i]
      if (q <= 0) continue
      spX[i] += (accX[i] - accWeight[i] * spX[i]) / q
      spY[i] += (accY[i] - accWeight[i] * spY[i]) / q
    }
  }

  /*
   * For each star, the integer displacement toward a free patch of sky from
   * which to copy the grain: eight directions are tried and the one with the
   * least star light is chosen. Copying by translation, without
   * interpolating or stretching, leaves the grain identical to the real one.
   */
  const donorX = new Int32Array(count)
  const donorY = new Int32Array(count)
  for (let s = 0; s < count; s++) {
    const st = stars[s]
    const rd = st.radius + FINE_MARGIN
    const D = 2 * rd + 2
    let best = Infinity
    for (let dir = 0; dir < 8; dir++) {
      const ang = (dir * Math.PI) / 4
      const tx = Math.round(Math.cos(ang) * D)
      const ty = Math.round(Math.sin(ang) * D)
      let worse = 0
      for (let q = 0; q < 9; q++) {
        const rr = q === 0 ? 0 : rd * 0.8
        const aa = (q * Math.PI) / 4
        const px = Math.round(st.x + tx + Math.cos(aa) * rr)
        const py = Math.round(st.y + ty + Math.sin(aa) * rr)
        if (px < 0 || py < 0 || px >= w || py >= h) {
          worse = Infinity
          break
        }
        worse +=
          footprint[py * w + px] + (softLuminance[py * w + px] - st.lumBackground > 2.5 * softNoise ? 1 : 0)
      }
      if (worse < best) {
        best = worse
        donorX[s] = tx
        donorY[s] = ty
      }
    }
  }

  const lightFactor = 1 - attenuation * (1 - RESIDUAL_LIGHT)
  const data = img.data
  const sm = softNoise
  // Amplitude of the grain in the fine part of each channel (see below).
  const fineNoise: number[] = []
  {
    const step = Math.max(1, Math.floor(n / 200000))
    const sample = new Float32Array(Math.ceil(n / step))
    for (let cc = 0; cc < c; cc++) {
      let q = 0
      const o = cc * n
      for (let i = 0; i < n; i += step) sample[q++] = data[o + i] - softValues[cc][i]
      fineNoise.push(Math.max(1e-7, medianAndMad(sample.subarray(0, q)).mad * MAD_TO_SIGMA))
    }
  }

  // How far above its row the warp reads the original: the displacement
  // after the rigidity stays within the largest one before it plus the
  // largest own displacement of a star, (1 - ks) times its radius (see
  // `shiftFactor`), and the donor patch within its offset. A few rows of
  // margin cover the rounding.
  let ownShift = 0
  let donorReach = 0
  for (let s = 0; s < count; s++) {
    const ks = 1 - (1 - k) * stars[s].certainty
    ownShift = Math.max(ownShift, (1 - ks) * stars[s].radius)
    donorReach = Math.max(donorReach, -donorY[s])
  }
  const reach = Math.max(Math.ceil(maxShift + ownShift) + 3, donorReach + 1)
  // In place only if the ring stays small; otherwise, as without `inPlace`,
  // a copy receives the result.
  const ringRows = reach + 1
  const writeInPlace = inPlace && ringRows * w * c <= n * c * MAX_RING_SHARE
  const out = writeInPlace ? data : data.slice()
  const ring = new Float32Array(writeInPlace ? ringRows * c * w : 0)
  // Rows of `data` already holding the result: their original values are in the ring.
  let written = 0
  /** Original value of channel `cc` at row `r`, column `x`. */
  const original = (cc: number, r: number, x: number): number =>
    r < written ? ring[((r % ringRows) * c + cc) * w + x] : data[cc * n + r * w + x]
  /** Like `bilinear` on the original channel `cc`, with the same arithmetic. */
  const originalBilinear = (cc: number, x: number, y: number): number => {
    const xc = Math.min(w - 1.001, Math.max(0, x))
    const yc = Math.min(h - 1.001, Math.max(0, y))
    const x0 = Math.floor(xc)
    const y0 = Math.floor(yc)
    const tx = xc - x0
    const ty = yc - y0
    const p00 = original(cc, y0, x0)
    const p10 = original(cc, y0 + 1, x0)
    const a = p00 + (original(cc, y0, x0 + 1) - p00) * tx
    const b = p10 + (original(cc, y0 + 1, x0 + 1) - p10) * tx
    return a + (b - a) * ty
  }
  const row = new Float32Array(c * w)

  for (let b0 = 0; b0 < h; b0 += bandRows) {
    const b1 = Math.min(h, b0 + bandRows)
    fillBand(b0, b1, true)
    rigidity(b0, b1)
    for (let y = b0; y < b1; y++) {
      // The row is computed apart and written at the end: until then the
      // original values of this row are read in `data`.
      for (let cc = 0; cc < c; cc++) row.set(data.subarray(cc * n + y * w, cc * n + (y + 1) * w), cc * w)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const li = (y - b0) * w + x
        const s = owner[li]
        const mL = warpedZone[li]
        if (s < 0 || mL <= 0) continue
        const st = stars[s]
        const sx = x + spX[li]
        const sy = y + spY[li]

        // How much star there was here, and how much there is at the point
        // being sampled. This is decided on the footprint and not on the light
        // measured pixel by pixel: the fine part of a star includes a negative
        // ring around the core, where the light is already almost at the
        // background level; leaving it in place would draw a dark ring.
        const sOrig = footprint[i]
        const sSource = bilinear(footprint, w, h, sx, sy)
        const backgroundWeight = Math.max(1e-12, backgroundWeightSum[li])
        const lumBackground = backgroundSum[c][li] / backgroundWeight
        const eSource = (bilinear(softLuminance, w, h, sx, sy) - lumBackground) / sm
        const sourceLight = sSource * smooth(1, 4, eSource)

        // Sky pixel from which to take the grain, just outside the star.
        let donor = -1
        let donorRow = 0
        let donorColumn = 0
        if (sOrig > 0) {
          const nx = x + donorX[s]
          const ny = y + donorY[s]
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
            const j = ny * w + nx
            if (footprint[j] === 0 && (softLuminance[j] - lumBackground) / sm < 2.5) {
              donor = j
              donorRow = ny
              donorColumn = nx
            }
          }
        }

        // Star light after the warp, for the attenuation.
        const a = attenuate[li] * (1 - lightFactor)
        // Blend between local grain and copied grain that preserves the noise
        // amplitude: with linear weights, halfway between them two independent
        // grains would attenuate and form a smoother ring.
        // Without a donor the two ends are the same values (the fine part at
        // the source): weights summing to more than 1 would amplify it, and
        // where it is the negative ring of an unmeasured star shifted by the
        // warp, they drew a crescent darker than the sky (Rosette cluster).
        const cosine = Math.cos(sOrig * Math.PI * 0.5)
        const sine = Math.sin(sOrig * Math.PI * 0.5)
        const pHere = donor >= 0 ? cosine : cosine / (cosine + sine)
        const pDon = donor >= 0 ? sine : sine / (cosine + sine)

        // Grain or structure? Outside the footprint of the measured stars the
        // fine part stays in place because it is grain, which the warp would
        // smooth. Where it exceeds the grain by a wide margin, however, it is
        // structure: the edge of an unmeasured nearby star, or the halo of a star
        // in an already stretched image, where the profile is steep and wide and
        // the blur that separates the two parts leaves a deep negative ring in
        // the fine part, well beyond the expected margin. Held still while the
        // soft part moves, that ring would be left uncovered and draw dark
        // crescents next to the stars. Structure therefore follows the warp
        // together with the soft part.
        let structure = 0
        for (let cc = 0; cc < c; cc++) {
          const fq = Math.abs(data[cc * n + i] - softValues[cc][i])
          const fs = Math.abs(originalBilinear(cc, sx, sy) - bilinear(softValues[cc], w, h, sx, sy))
          const e = Math.max(fq, fs) / fineNoise[cc]
          if (e > structure) structure = e
        }
        structure = smooth(STRUCTURE_THRESHOLD, 2 * STRUCTURE_THRESHOLD, structure) * mL

        for (let cc = 0; cc < c; cc++) {
          const soft = softValues[cc]
          const mHere = soft[i]
          const mSource = bilinear(soft, w, h, sx, sy)
          const m = mHere + (mSource - mHere) * mL
          const sourceEnd = originalBilinear(cc, sx, sy) - mSource
          const fineInPlace = data[cc * n + i] - mHere
          const hereEnd = fineInPlace + (sourceEnd - fineInPlace) * structure
          const donorEnd = donor >= 0 ? original(cc, donorRow, donorColumn) - soft[donor] : sourceEnd
          const skyEnd = hereEnd * pHere + donorEnd * pDon
          let v = m + skyEnd + (sourceEnd - skyEnd) * sSource
          if (a > 0) {
            const excess = v - backgroundSum[cc][li] / backgroundWeight
            if (excess > 0) v -= excess * a * sourceLight
          }
          row[cc * w + x] = v < 0 ? 0 : v > 1 ? 1 : v
        }
      }
      if (writeInPlace) {
        const slot = (y % ringRows) * c * w
        for (let cc = 0; cc < c; cc++) ring.set(data.subarray(cc * n + y * w, cc * n + (y + 1) * w), slot + cc * w)
        written = y + 1
      }
      for (let cc = 0; cc < c; cc++) out.set(row.subarray(cc * w, (cc + 1) * w), cc * n + y * w)
    }
  }

  for (const soft of softValues) returnShared(soft)
  returnShared(footprint)
  if (own) releaseStarAnalysis(own)
  return { width: w, height: h, channels: c, data: out }
}

/** Gives back to the pool the smoothed luminance of `analyzeStars`: the measurements are no longer usable. */
export function releaseStarAnalysis(analysis: StarAnalysis): void {
  returnShared(analysis.softLuminance)
}

/** Like `bilinear`, on a band of rows starting at row `b0` (it must contain both rows read). */
function bandBilinear(p: Float32Array, b0: number, w: number, h: number, x: number, y: number): number {
  const xc = Math.min(w - 1.001, Math.max(0, x))
  const yc = Math.min(h - 1.001, Math.max(0, y))
  const x0 = Math.floor(xc)
  const y0 = Math.floor(yc)
  const tx = xc - x0
  const ty = yc - y0
  const i = (y0 - b0) * w + x0
  const a = p[i] + (p[i + 1] - p[i]) * tx
  const b = p[i + w] + (p[i + w + 1] - p[i + w]) * tx
  return a + (b - a) * ty
}

/** Pixels of a band of the warp fields (see `reduceStars`). */
const BAND_PIXELS = 1 << 20
/** Largest ring buffer for working in place, as a share of the image. */
const MAX_RING_SHARE = 0.25

/**
 * Parameters for Abracadabra: a moderate reduction, stronger when stars
 * cover a large part of the image (where they are what hides the object).
 */
export function automaticStarReduction(img: ImageData32, analysis?: StarAnalysis): StarReductionParams {
  const n = img.width * img.height
  const own = analysis ? null : analyzeStars(img)
  const { stars } = analysis ?? (own as StarAnalysis)
  if (own) releaseStarAnalysis(own)
  // Fraction of the image occupied by the star disks.
  let area = 0
  for (const st of stars) area += Math.PI * st.radius * st.radius * st.certainty
  const coverage = area / n
  // A normal field has one or two percent; the dense Milky Way reaches ten.
  const t = smooth(0.015, 0.08, coverage)
  return {
    quantity: Math.round((0.45 + 0.3 * t) * 100) / 100,
    attenuation: Math.round((0.2 + 0.2 * t) * 100) / 100
  }
}
