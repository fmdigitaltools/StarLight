/*
 * Bright star halo reduction. StarLight plugin. MIT license, FM Digital Tools.
 *
 * Very bright stars are often surrounded by a broad, faint halo, much
 * larger than the star itself: light scattered by haze or thin clouds,
 * reflections between the surfaces of lenses and filters, scattering in
 * the optics. The halo covers the nearby nebula and, after the stretch,
 * makes the star look like a blurred blob.
 *
 * The halo is a circularly symmetric component around the star that varies
 * slowly with the radius: it is measured with the radial profile and
 * subtracted (the same idea as modeling and subtracting the radial profile
 * of bright star halos in astronomical images, for example in C. T. Slater,
 * P. Harding, J. C. Mihos, "Removing internal reflections from deep imaging
 * datasets", PASP 121, 2009). For each star above the threshold, from the
 * largest to the smallest:
 *   1. the surroundings are divided into concentric rings, one pixel wide
 *      near the star and wider and wider moving outwards, up to the chosen
 *      size;
 *   2. in each ring the median of each channel is taken: the other stars
 *      and the details of the nebula, which occupy a small part of the
 *      ring, do not shift it;
 *   3. the background is the median of the outermost ring; the halo, in
 *      each ring, is how much the median exceeds the background. Moving
 *      outwards the halo cannot grow: an increase comes from a structure
 *      of the nebula, not from the star, and is not removed;
 *   4. to separate the star from the halo, the star profile is extended
 *      beyond the edge of the disc (where the star, as it appears on
 *      screen, falls halfway between its maximum and the background) with
 *      the same slope it has there and an ever steeper descent; whatever
 *      the measured profile has in excess is halo, and is reduced by the
 *      chosen share. On the disc and on its edge the profile stays
 *      identical, slope included: the star does not change size, its
 *      central flux is preserved and the light falls continuously down to
 *      the background, without steps or corners, even around a wide
 *      saturated core;
 *   5. in each pixel the removed part of the profile is subtracted, in the
 *      hue of the halo: the stars and details lying on the halo stay
 *      whole.
 * Small and faint stars are not treated: in their area only the halo of
 * the nearby bright star is removed. The star reduction available in the
 * Process step, on the contrary, shrinks the disc of all the stars and
 * does not act on the halo.
 *
 * It works on the linear data, where the halo adds to the light of the
 * nebula and can therefore be subtracted; the brightness threshold is read
 * instead on the image as it appears on screen, with the current stretch.
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

/** Midtones transfer function, the same as the viewer's. */
function mtf(x, m) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

/**
 * Ring edges: one pixel wide up to 12 pixels from the center, then each
 * one 12% wider than the previous (a wide ring gathers enough pixels for
 * a reliable median even where the halo is faint).
 */
function ringEdges(radius) {
  const edges = [0]
  let r = 0
  while (r < radius) {
    r = r < 12 ? r + 1 : Math.min(radius, Math.max(r + 1, Math.round(r * 1.12)))
    edges.push(r)
  }
  return edges
}

/** Reduces the halo of one star, modifying `data` in place. */
function reduceHalo(data, w, h, channels, s, options) {
  const n = w * h
  const { strength, haloSize } = options
  const rc = Math.max(1, s.radius)
  // The halo is searched for up to the chosen size, but never less than
  // three times the star radius, otherwise the background ring would fall
  // inside the star itself.
  const R = Math.max(Math.ceil(3 * rc + 6), haloSize)
  // Precise center, to fractions of a pixel: centroid of the part of the
  // star above half maximum, repeated twice. A center off by even one
  // pixel would remove more halo on one side than on the other.
  let cx = s.x
  let cy = s.y
  {
    const half = s.background + 0.5 * (s.peak - s.background)
    const rb = Math.ceil(2 * rc + 2)
    for (let pass = 0; pass < 2; pass++) {
      let sx = 0
      let sy = 0
      let sp = 0
      const bx = Math.round(cx)
      const by = Math.round(cy)
      for (let yy = Math.max(0, by - rb); yy <= Math.min(h - 1, by + rb); yy++) {
        for (let xx = Math.max(0, bx - rb); xx <= Math.min(w - 1, bx + rb); xx++) {
          const i = yy * w + xx
          const v = luminance(data, n, channels, i) - half
          if (v <= 0) continue
          sx += v * xx
          sy += v * yy
          sp += v
        }
      }
      if (sp > 0) {
        cx = sx / sp
        cy = sy / sp
      }
    }
  }
  const x0 = Math.max(0, Math.floor(cx - R))
  const x1 = Math.min(w - 1, Math.ceil(cx + R))
  const y0 = Math.max(0, Math.floor(cy - R))
  const y1 = Math.min(h - 1, Math.ceil(cy + R))
  const edges = ringEdges(R)
  const rings = edges.length - 1
  // Ring index for each integer distance (rounded down).
  const ringOf = new Int32Array(R + 1)
  for (let k = 0, a = 0; k <= R; k++) {
    while (a < rings - 1 && k >= edges[a + 1]) a++
    ringOf[k] = a
  }

  // 1. and 2. Median of each ring, for each channel. Wide rings are
  // sampled at alternate pixels: the median does not change and the
  // computation is faster.
  const counts = new Int32Array(rings)
  const skip = (xx, yy, a) => edges[a] >= 24 && ((xx + yy) & 1) === 1
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const d = Math.hypot(xx - cx, yy - cy)
      if (d >= R) continue
      const a = ringOf[Math.floor(d)]
      if (!skip(xx, yy, a)) counts[a]++
    }
  }
  const start = new Int32Array(rings + 1)
  for (let a = 0; a < rings; a++) start[a + 1] = start[a] + counts[a]
  const values = new Float32Array(start[rings])
  const profile = []
  for (let c = 0; c < channels; c++) {
    const slot = Int32Array.from(start.subarray(0, rings))
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx - cx, yy - cy)
        if (d >= R) continue
        const a = ringOf[Math.floor(d)]
        if (!skip(xx, yy, a)) values[slot[a]++] = data[c * n + yy * w + xx]
      }
    }
    const p = new Float32Array(rings)
    for (let a = 0; a < rings; a++) p[a] = median(values.subarray(start[a], start[a + 1]), counts[a])
    profile.push(p)
  }

  // Ring centers, to interpolate the halo between one ring and the next.
  const centers = new Float32Array(rings)
  for (let a = 0; a < rings; a++) centers[a] = 0.5 * (edges[a] + edges[a + 1])

  // 3. Background from the outermost ring (or from the two outermost, if
  // the first is cut by the edge of the image) and non-increasing halo.
  let last = rings - 1
  while (last > 0 && counts[last] < 16) last--
  if (last < 3) return
  const halo = []
  let meanBackground = 0
  for (let c = 0; c < channels; c++) {
    const p = profile[c]
    const background = p[last]
    meanBackground += background / channels
    const a = new Float32Array(rings)
    let ceiling = Infinity
    for (let k = 0; k < rings; k++) {
      if (counts[k] === 0 || k > last) {
        a[k] = 0
        continue
      }
      const v = Math.max(0, p[k] - background)
      ceiling = Math.min(ceiling, v)
      a[k] = ceiling
    }
    halo.push(a)
  }

  // 4. Separation between star and halo. On the edge of the disc (r0,
  // defined below) the level P0 of the profile and its logarithmic slope
  // s0 are measured. The profile the star would have without the halo
  // continues from there with the same slope and an ever steeper descent,
  // like the tail of a Gaussian:
  //     ln C(r) = ln P0 + s0·(r − r0) − (r − r0)² / (2·L²),   L = r0 + 1.
  // Whatever the measured profile P has in excess is the halo, H = P − C
  // (with a smooth transition to zero where P falls below C). The new
  // profile, C + (1 − strength)·H, matches the original on the disc and on
  // its edge, where it also has the same slope: the halo starts from zero
  // without steps or corners, and the light falls continuously from the
  // core to the background even when the saturated core is wide.
  const lum = new Float32Array(rings)
  for (let a = 0; a < rings; a++) for (let c = 0; c < channels; c++) lum[a] += halo[c][a] / channels
  // The edge of the disc is where the star, as it appears on screen, falls
  // halfway between its maximum and the background (never closer than the
  // half-maximum radius of the data): after a strong stretch the visible
  // disc is much wider than the half maximum in the linear data, and must
  // be preserved entirely.
  const { screen } = options
  const screenBackground = screen(meanBackground)
  const screenPeak = screen(meanBackground + lum[0])
  let edgeRing = 0
  while (edgeRing < last && screen(meanBackground + lum[edgeRing]) > screenBackground + 0.5 * (screenPeak - screenBackground)) edgeRing++
  const a0 = Math.max(1, Math.min(last - 2, Math.max(edgeRing, ringOf[Math.min(R, Math.round(rc))])))
  if (!(lum[a0 - 1] > 0 && lum[a0 + 1] > 0 && lum[a0] > 0)) return
  const r0 = centers[a0]
  const p0 = lum[a0]
  const s0 = Math.min(0, Math.log(lum[a0 + 1] / lum[a0 - 1]) / (centers[a0 + 1] - centers[a0 - 1]))
  const length = r0 + 1
  const factor = new Float32Array(rings)
  for (let a = 0; a < rings; a++) {
    const p = lum[a]
    if (p <= 0 || a <= a0) {
      factor[a] = 1
      continue
    }
    const dr = centers[a] - r0
    const disc = p0 * Math.exp(s0 * dr - (dr * dr) / (2 * length * length))
    const dd = p - disc
    // Smooth transition, proportional to the local level of the profile.
    const soft = 0.05 * p
    const excess = Math.min(p, 0.5 * (dd + Math.sqrt(dd * dd + soft * soft)) - 0.5 * soft)
    // Share of the light that stays in this ring.
    factor[a] = 1 - (strength * Math.max(0, excess)) / p
  }

  // 5. Subtraction: in each pixel the part of the profile that the reduced
  // profile does not contain is removed, in the hue of the halo. The
  // profile is subtracted rather than the pixel scaled: the stars and the
  // details of the nebula lying on the halo stay whole.
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const d = Math.hypot(xx - cx, yy - cy)
      if (d >= R || d <= centers[a0]) continue
      let a = ringOf[Math.floor(d)]
      if (d < centers[a] && a > 0) a--
      const b = Math.min(rings - 1, a + 1)
      const t = b === a ? 0 : Math.min(1, Math.max(0, (d - centers[a]) / (centers[b] - centers[a])))
      const i = yy * w + xx
      for (let c = 0; c < channels; c++) {
        const removed = halo[c][a] * (1 - factor[a]) * (1 - t) + halo[c][b] * (1 - factor[b]) * t
        if (removed > 0) data[c * n + i] = Math.max(0, data[c * n + i] - removed)
      }
    }
  }
}

export function processImage(image, params, context) {
  const { width: w, height: h, channels, data } = image
  if (params.strength <= 0) return image
  const n = w * h
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  const screen = (v) => mtf(Math.min(1, Math.max(0, (v - black) / range)), midtones)
  const g = blockBackground(data, w, h, channels)
  const stars = findStars(data, w, h, channels, g, 10, 100000)
  // The stars treated: brighter on screen than the threshold and not
  // point-like. At most the 400 largest, from the largest, so that the
  // halo of a huge star does not distort the measurement of nearby ones.
  const selected = stars
    .filter((s) => screen(s.peak) >= params.threshold && s.radius >= 1.2)
    .sort((a, b) => b.radius - a.radius)
    .slice(0, 400)
  const options = { strength: params.strength, haloSize: Math.max(8, Math.round(params.haloSize)), screen }
  for (const s of selected) reduceHalo(data, w, h, channels, s, options)
  return { width: w, height: h, channels, data }
}
