/*
 * Purple and blue fringe removal. StarLight plugin. MIT license, FM Digital Tools.
 *
 * A lens does not bring all colors to the same focus (chromatic
 * aberration). In two-lens refractors and camera lenses green is in focus,
 * while blue and violet, and to a lesser extent deep red, form a wider
 * disc around the star: this is the purple or blue halo (longitudinal
 * aberration). Towards the edges of the field the colors can also shift
 * sideways, and the star gets a red fringe on one side and a green or
 * blue one on the other (lateral aberration).
 *
 * The principle of the correction: the light of a star has a single color,
 * and in optics without aberration its image has the same shape in all
 * channels. The ratio between the channels (net of the background) must
 * therefore stay the same from the center to the edge of the star; where
 * the edge has more blue, or more red, than the star's color predicts, the
 * excess is fringe. The idea of limiting the color difference in the
 * transition zone to the value measured inside comes from S.-W. Chung,
 * B.-K. Kim, W.-J. Song, "Removing chromatic aberration by digital image
 * processing", Optical Engineering 49(6), 2010, applied here radially
 * around each star.
 *
 * For each star found:
 *   1. the local background of each channel (nebula included) is the
 *      median of a ring just outside the halo; from here on the work is
 *      done on the star's light alone, that is on the difference from the
 *      background. The surrounding nebula does not enter the computation
 *      and is not touched;
 *   2. the star's color is measured in its bright inner part, where the
 *      fringe weighs little, excluding saturated pixels (which have no
 *      color): these are the red/green and blue/green ratios;
 *   3. in the outer zone, within the chosen size, the star's light in each
 *      channel is estimated with a mean over 5×5 pixels (so as not to
 *      mistake noise for fringe) and the "poorest" channel relative to the
 *      star's color is found: the other channels, to the extent they
 *      exceed it, contain fringe;
 *   4. the excess is subtracted, dosed by the strength, only where the
 *      star's light is clearly above the noise. With the "purple and blue"
 *      hue only the excesses dominated by blue are corrected (blue, violet
 *      and magenta halos); with "all" also the red, green and cyan fringes.
 * The correction removes excess light and adds none: it does not increase
 * the noise and does not change the color of the star's center. Truly
 * blue or red stars keep their hue, because the fringe is measured
 * relative to the color of each one.
 *
 * It works on the linear data, where the ratio between the channels has a
 * physical meaning, and does not depend on the stretch.
 */

/* ------------------------------------------------------------------ *
 * Star detection (shared by the star plugins)
 *
 * 1. Sky background and noise: the image is divided into blocks of 64
 *    pixels; in each one 256 samples of the luminance are taken and their
 *    median (the background) and median absolute deviation (the spread)
 *    are computed. The image noise is the median of the spreads of the
 *    blocks: the stars and the nebula, which occupy few blocks, do not
 *    shift it.
 * 2. Candidates: the local maxima (over 3×3 pixels) that exceed the
 *    background of their block by a given multiple of the noise. In
 *    saturated cores, where many pixels have the same value, only the first
 *    in reading order counts, so each star gives a single maximum.
 * 3. Confirmation: the candidate must stand out by the same amount from the
 *    mean of a ring of radius 3 (widened up to 6 pixels for wide stars,
 *    and beyond only for the saturated cores of large stars). A ripple of
 *    the nebula or a noise peak on the halo of a bright star does not
 *    pass it.
 * 4. Measurements: from the maximum, eight directions are followed down to
 *    half the height above the background. The mean of the eight distances
 *    is the half-maximum radius (half the FWHM); opposite distances give
 *    the center even when the maximum is on the edge of a saturated core.
 * 5. Stars are examined from the brightest: around each one an occupied
 *    disc is marked, and secondary maxima falling inside a star already
 *    found do not become separate stars.
 * ------------------------------------------------------------------ */

const BLOCK_SIZE = 64

/** Luminance (Rec. 709 weights) of pixel i; in monochrome images it is the value itself. */
function luminance(data, n, channels, i) {
  return channels === 3 ? 0.2126 * data[i] + 0.7152 * data[n + i] + 0.0722 * data[2 * n + i] : data[i]
}

/** Median of the first `count` values of a Float32Array (which gets reordered). */
function median(v, count) {
  if (count <= 0) return 0
  const a = v.subarray(0, count).sort()
  return count % 2 ? a[(count - 1) >> 1] : 0.5 * (a[count / 2 - 1] + a[count / 2])
}

/** Smooth transition from 0 to 1 between a and b. */
function smoothStep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Block background and image noise (point 1). */
function blockBackground(data, w, h, channels) {
  const n = w * h
  const gw = Math.ceil(w / BLOCK_SIZE)
  const gh = Math.ceil(h / BLOCK_SIZE)
  const background = new Float32Array(gw * gh)
  const spread = new Float32Array(gw * gh)
  const samples = new Float32Array(256)
  const deviations = new Float32Array(256)
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      const xa = bx * BLOCK_SIZE
      const ya = by * BLOCK_SIZE
      const xb = Math.min(w, xa + BLOCK_SIZE)
      const yb = Math.min(h, ya + BLOCK_SIZE)
      let k = 0
      for (let y = ya + (yb - ya > 2 ? 2 : 0); y < yb && k < 256; y += 4) {
        for (let x = xa + (xb - xa > 2 ? 2 : 0); x < xb && k < 256; x += 4) samples[k++] = luminance(data, n, channels, y * w + x)
      }
      const med = median(samples, k)
      for (let j = 0; j < k; j++) deviations[j] = Math.abs(samples[j] - med)
      background[by * gw + bx] = med
      spread[by * gw + bx] = 1.4826 * median(deviations, k)
    }
  }
  const sigma = Math.max(1e-6, median(Float32Array.from(spread), spread.length))
  return { gw, gh, background, sigma }
}

/** Background at point (x, y), interpolated between the block centers. */
function backgroundAt(g, x, y) {
  const fx = Math.min(g.gw - 1, Math.max(0, (x + 0.5) / BLOCK_SIZE - 0.5))
  const fy = Math.min(g.gh - 1, Math.max(0, (y + 0.5) / BLOCK_SIZE - 0.5))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(g.gw - 1, x0 + 1)
  const y1 = Math.min(g.gh - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const f = g.background
  return (
    (f[y0 * g.gw + x0] * (1 - tx) + f[y0 * g.gw + x1] * tx) * (1 - ty) +
    (f[y1 * g.gw + x0] * (1 - tx) + f[y1 * g.gw + x1] * tx) * ty
  )
}

const DIRECTIONS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]
]

/**
 * Finds the stars (points 2-5). `times` is the threshold in multiples of
 * the noise, `maximum` the maximum number of stars returned. Each star is
 * { x, y, peak, background, radius }: center, maximum luminance, local
 * background and half-maximum radius in pixels.
 */
function findStars(data, w, h, channels, g, times, maximum) {
  const n = w * h
  const L = (i) => luminance(data, n, channels, i)
  const thresholds = new Float32Array(g.gw * g.gh)
  for (let b = 0; b < thresholds.length; b++) thresholds[b] = g.background[b] + times * g.sigma

  // 2. Local maxima above the threshold of their block.
  let indices = new Int32Array(4096)
  let values = new Float32Array(4096)
  let count = 0
  for (let y = 1; y < h - 1; y++) {
    const row = Math.floor(y / BLOCK_SIZE) * g.gw
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = L(i)
      if (v < thresholds[row + Math.floor(x / BLOCK_SIZE)]) continue
      if (!(v > L(i - 1) && v > L(i - w - 1) && v > L(i - w) && v > L(i - w + 1))) continue
      if (!(v >= L(i + 1) && v >= L(i + w - 1) && v >= L(i + w) && v >= L(i + w + 1))) continue
      if (count === indices.length) {
        const ni = new Int32Array(count * 2)
        ni.set(indices)
        indices = ni
        const nv = new Float32Array(count * 2)
        nv.set(values)
        values = nv
      }
      indices[count] = i
      values[count] = v
      count++
    }
  }
  const order = new Uint32Array(count)
  for (let k = 0; k < count; k++) order[k] = k
  order.sort((a, b) => values[b] - values[a])

  const occupied = new Uint8Array(n)
  const cosines = []
  const sines = []
  for (let k = 0; k < 16; k++) {
    cosines.push(Math.cos((k * Math.PI) / 8))
    sines.push(Math.sin((k * Math.PI) / 8))
  }
  const ringMean = (x, y, r) => {
    let s = 0
    for (let k = 0; k < 16; k++) {
      const px = Math.min(w - 1, Math.max(0, Math.round(x + r * cosines[k])))
      const py = Math.min(h - 1, Math.max(0, Math.round(y + r * sines[k])))
      s += L(py * w + px)
    }
    return s / 16
  }
  // Distance, along a direction, at which the luminance falls below the level.
  const maxRadius = Math.max(8, Math.min(400, Math.floor(Math.min(w, h) / 4)))
  const distance = (x, y, dx, dy, level) => {
    const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
    let previous = L(y * w + x)
    for (let t = 1; t <= maxRadius; t++) {
      const px = x + dx * t
      const py = y + dy * t
      if (px < 0 || py < 0 || px >= w || py >= h) return (t - 1) * step
      const v = L(py * w + px)
      if (v <= level) return (t - 1 + (previous - level) / Math.max(1e-12, previous - v)) * step
      previous = v
    }
    return maxRadius * step
  }
  const measure = (x, y, level) => {
    const d = []
    for (const [dx, dy] of DIRECTIONS) d.push(distance(x, y, dx, dy, level))
    return d
  }

  const stars = []
  for (let k = 0; k < count && stars.length < maximum; k++) {
    const i = indices[order[k]]
    if (occupied[i]) continue
    const x = i % w
    const y = (i - x) / w
    const peak = values[order[k]]
    const background = backgroundAt(g, x, y)
    const height = peak - background
    if (height < times * g.sigma) continue
    // 3. Confirmation against a surrounding ring.
    // Beyond 6 pixels the ring widens only for saturated cores: a broad,
    // unsaturated bump is a structure of the nebula.
    const saturated = peak >= 0.98 * values[order[0]]
    let r = 3
    let ring = ringMean(x, y, r)
    while (ring > background + 0.8 * height && r < (saturated ? 128 : 6)) {
      r *= 2
      ring = ringMean(x, y, r)
    }
    if (peak - ring < times * g.sigma) continue
    // 4. Center and half-maximum radius.
    const half = background + 0.5 * height
    let d = measure(x, y, half)
    const cx = Math.min(w - 1, Math.max(0, Math.round(x + (d[0] - d[4]) / 2)))
    const cy = Math.min(h - 1, Math.max(0, Math.round(y + (d[2] - d[6]) / 2)))
    if (cx !== x || cy !== y) d = measure(cx, cy, Math.min(half, L(cy * w + cx)))
    let radius = 0
    for (const v of d) radius += v
    radius = Math.max(0.5, radius / 8)
    stars.push({ x: cx, y: cy, peak, background, radius })
    // 5. Occupied disc.
    const ro = Math.ceil(1.5 * radius + 1)
    const ro2 = ro * ro
    for (let yy = Math.max(0, cy - ro); yy <= Math.min(h - 1, cy + ro); yy++) {
      for (let xx = Math.max(0, cx - ro); xx <= Math.min(w - 1, cx + ro); xx++) {
        if ((xx - cx) * (xx - cx) + (yy - cy) * (yy - cy) <= ro2) occupied[yy * w + xx] = 1
      }
    }
  }
  return stars
}

/** Maximum value of each channel: pixels at 98% of this value are considered saturated. */
function saturationLevels(data, n, channels) {
  const levels = []
  for (let c = 0; c < channels; c++) {
    let m = 0
    for (let i = c * n; i < (c + 1) * n; i++) if (data[i] > m) m = data[i]
    levels.push(m > 0 ? 0.98 * m : Infinity)
  }
  return levels
}

/** Mean over a square of side 2r+1 of a small plane (bw × bh), with the edges repeated. */
function localMean(plane, bw, bh, r) {
  const t = new Float32Array(plane.length)
  const a = new Float32Array(plane.length)
  box(plane, t, bw, bh, r, bw, 1)
  box(t, a, bh, bw, r, 1, bw)
  return a
}

/** Moving average along one direction: `step` between neighboring samples, `stride` between one line and the next. */
function box(src, dst, length, lines, r, stride, step) {
  const windowSize = 2 * r + 1
  for (let l = 0; l < lines; l++) {
    const base = l * stride
    const v = (i) => src[base + Math.min(length - 1, Math.max(0, i)) * step]
    let sum = 0
    for (let i = -r; i <= r; i++) sum += v(i)
    for (let i = 0; i < length; i++) {
      dst[base + i * step] = sum / windowSize
      sum += v(i + r + 1) - v(i - r)
    }
  }
}

/** Corrects the fringe of one star, modifying `data` in place. */
function correctStar(data, w, h, s, options) {
  const n = w * h
  const { strength, haloSize, allHues, saturation, sigma } = options
  const rc = s.radius
  const R = Math.min(300, Math.ceil(1.5 * rc + haloSize))
  const M = R + 3
  const x0 = Math.max(0, s.x - M)
  const x1 = Math.min(w - 1, s.x + M)
  const y0 = Math.max(0, s.y - M)
  const y1 = Math.min(h - 1, s.y + M)
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  const m = bw * bh
  if (bw < 5 || bh < 5) return

  // Local copy of the three channels and distances from the center.
  const loc = new Float32Array(3 * m)
  const dist = new Float32Array(m)
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      const j = yy * bw + xx
      const i = (y0 + yy) * w + x0 + xx
      loc[j] = data[i]
      loc[m + j] = data[n + i]
      loc[2 * m + j] = data[2 * n + i]
      dist[j] = Math.hypot(x0 + xx - s.x, y0 + yy - s.y)
    }
  }

  // 1. Background of each channel: median of the ring between R and R+3.
  const background = [0, 0, 0]
  const ring = new Float32Array(m)
  for (let c = 0; c < 3; c++) {
    let k = 0
    for (let j = 0; j < m; j++) if (dist[j] > R && dist[j] <= M) ring[k++] = loc[c * m + j]
    if (k < 8) return
    background[c] = median(ring, k)
  }
  const backgroundL = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2]
  const height = s.peak - backgroundL
  if (height <= 0) return

  // 2. Star color in the bright inner part, without saturated pixels.
  // If the center is saturated the color is read in the band just outside
  // (above half the height); otherwise in the whole part above a quarter
  // of the height, where the fringe, wider than the star, weighs little.
  let saturatedCount = 0
  for (let j = 0; j < m; j++) {
    if (dist[j] <= 1.5 && (loc[j] >= saturation[0] || loc[m + j] >= saturation[1] || loc[2 * m + j] >= saturation[2])) saturatedCount++
  }
  const innerThreshold = saturatedCount > 0 ? 0.5 : 0.25
  let sr = 0
  let sg = 0
  let sb = 0
  let samples = 0
  const innerRadius = 2 * rc + 2
  for (let j = 0; j < m; j++) {
    if (dist[j] > innerRadius) continue
    const r = loc[j]
    const g = loc[m + j]
    const b = loc[2 * m + j]
    if (r >= saturation[0] || g >= saturation[1] || b >= saturation[2]) continue
    if (0.2126 * r + 0.7152 * g + 0.0722 * b - backgroundL < innerThreshold * height) continue
    sr += r - background[0]
    sg += g - background[1]
    sb += b - background[2]
    samples++
  }
  if (samples < 3 || sg <= 0) return
  const rho = [sr / sg, 1, sb / sg]
  // An out-of-range ratio indicates a disturbed measurement (a double
  // star, an extended object): better not to touch anything.
  if (!(rho[0] > 0.15 && rho[0] < 6 && rho[2] > 0.15 && rho[2] < 6)) return

  // 3. Star light in each channel, averaged over 5×5 pixels.
  const smooth = []
  for (let c = 0; c < 3; c++) {
    const p = new Float32Array(m)
    for (let j = 0; j < m; j++) p[j] = loc[c * m + j] - background[c]
    smooth.push(localMean(p, bw, bh, 2))
  }
  // Noise of the 25-pixel mean of one channel: that of the luminance, a
  // little higher in a single channel, divided by the square root of 25
  // and increased because the noise of stacked images is not independent
  // from pixel to pixel.
  const smoothSigma = 0.5 * sigma
  const e = [0, 0, 0]

  // 4. Subtraction of the excess in the outer zone.
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      const j = yy * bw + xx
      const r = dist[j]
      if (r > R) continue
      const i = (y0 + yy) * w + x0 + xx
      if (loc[j] >= saturation[0] || loc[m + j] >= saturation[1] || loc[2 * m + j] >= saturation[2]) continue
      const lr = smooth[0][j]
      const lg = smooth[1][j]
      const lb = smooth[2][j]
      // Only outside the bright part, where the color was measured.
      const fraction = (0.2126 * lr + 0.7152 * lg + 0.0722 * lb) / height
      const outer = 1 - smoothStep(0.6 * innerThreshold, 1.2 * innerThreshold, fraction)
      if (outer <= 0) continue
      const signal = Math.max(lr, lg, lb)
      const weight = strength * outer * (1 - smoothStep(R - 2, R, r)) * smoothStep(2 * smoothSigma, 5 * smoothSigma, signal)
      if (weight <= 0) continue
      // The common level: the poorest channel relative to the star's color.
      const base = Math.max(0, Math.min(lr / rho[0], lg, lb / rho[2]))
      e[0] = Math.max(0, lr - 1.05 * base * rho[0] - 0.5 * smoothSigma)
      e[1] = Math.max(0, lg - 1.05 * base - 0.5 * smoothSigma)
      e[2] = Math.max(0, lb - 1.05 * base * rho[2] - 0.5 * smoothSigma)
      let dose = weight
      if (!allHues) {
        // Only the fringes dominated by blue: blue, violet, magenta.
        if (e[2] <= 0) continue
        dose *= Math.min(1, Math.max(0, (3 * (e[2] - e[1])) / e[2]))
        if (dose <= 0) continue
      }
      for (let c = 0; c < 3; c++) {
        if (e[c] > 0) data[c * n + i] = loc[c * m + j] - dose * e[c]
      }
    }
  }
}

export function processImage(image, params) {
  const { width: w, height: h, channels, data } = image
  // A color fringe exists only in color images.
  if (channels !== 3 || params.strength <= 0) return image
  const n = w * h
  const g = blockBackground(data, w, h, channels)
  // Only stars well above the noise: in fainter ones a fringe is not
  // visible and cannot be measured.
  const stars = findStars(data, w, h, channels, g, 8, 200000)
  const options = {
    strength: params.strength,
    haloSize: Math.max(1, Math.round(params.haloSize)),
    allHues: params.hue === 'all',
    saturation: saturationLevels(data, n, channels),
    sigma: g.sigma
  }
  for (const s of stars) correctStar(data, w, h, s, options)
  return { width: w, height: h, channels, data }
}
