/*
 * Star color. StarLight plugin. MIT license, FM Digital Tools.
 *
 * The stretch that makes the faint parts visible pushes the center of the
 * stars to white: all three channels exceed the white point there, and the
 * difference between them, that is the color, can no longer be seen. The
 * color is still in the data, though, in the corona of the star, where the
 * light falls off and the channels stay below white.
 *
 * For each star found:
 *   1. the local background of each channel (nebula included) is the median
 *      of a ring around the star;
 *   2. the color of the star is measured in the corona: the pixels where the
 *      light of the star, as it appears on screen, is between 10% and 75% of
 *      the maximum, no channel is saturated in the data and none is white on
 *      screen; pixels closer to another star than to this one are excluded,
 *      because a neighbor of a different color would bias the measurement.
 *      The color is the ratio between the channels of the star's light
 *      minus the background, on the linear data: it is the physical color
 *      of the star, the one a stretch that preserves the ratios between the
 *      channels would show (R. Lupton et al., “Preparing red-green-blue
 *      images from CCD data”, PASP 116, 2004). The measured color is then
 *      brought back onto the band of black-body colors, from light blue to
 *      orange: a magenta or green component belongs to no star and is
 *      removed. In faint stars, where the light of the corona is small
 *      compared with the noise, the color fades towards white in proportion
 *      to the reliability of the measurement;
 *   3. the color is brought, on screen, into the central part of the star:
 *      the brightest channel stays as it is and the others drop in the
 *      measured proportion. The effect is full where the star is brightest
 *      and fades out gradually towards the corona, which already has its
 *      color; a channel is never raised, and a pixel already more colored
 *      than measured stays as it is;
 *   4. the pixels saturated in the data, where the color was never recorded,
 *      can be protected: with the protection at maximum they stay white and
 *      the star keeps a light center, natural in appearance.
 * The result, computed on screen, is brought back to the linear data with
 * the inverse function of the stretch. Stars that are too small, where the
 * corona has few pixels and the measurement would be dominated by noise,
 * are not touched; the nebula and the background are never modified,
 * because the plugin acts only inside the stars.
 */

/* ------------------------------------------------------------------ *
 * Star search (part shared by the star plugins)
 *
 * 1. Sky background and noise: the image is divided into blocks of 64
 *    pixels; in each one 256 samples of the luminance are taken and their
 *    median (the background) and median absolute deviation (the spread)
 *    are computed. The noise of the image is the median of the spreads of
 *    the blocks: the stars and the nebula, which occupy few blocks, do not
 *    shift it.
 * 2. Candidates: the local maxima (over 3×3 pixels) that exceed the
 *    background of their block by a certain number of times the noise. In
 *    saturated cores, where many pixels have the same value, only the first
 *    one in reading order counts, so each star gives a single maximum.
 * 3. Confirmation: the candidate must stand out by the same amount from the
 *    mean of a ring of radius 3 (widened up to 6 pixels for wide stars, and
 *    beyond only for the saturated cores of large stars). A ripple of the
 *    nebula or a noise peak on the halo of a bright star does not pass.
 * 4. Measurements: from the maximum, eight directions are followed down to
 *    half the height above the background. The mean of the eight distances
 *    is the radius at half height (half the FWHM); opposite distances give
 *    the center even when the maximum is on the edge of a saturated core.
 * 5. Stars are examined from the brightest: around each one an occupied
 *    disk is marked, and secondary maxima that fall inside a star already
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
function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Background per block and noise of the image (step 1). */
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

/** Background at point (x, y), interpolated between the centers of the blocks. */
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
 * Finds the stars (steps 2-5). `nSigma` is the threshold in multiples of
 * the noise, `maxStars` the maximum number of stars returned. Each star is
 * { x, y, peak, background, radius }: center, maximum luminance, local
 * background and radius at half height in pixels.
 */
function findStars(data, w, h, channels, g, nSigma, maxStars) {
  const n = w * h
  const L = (i) => luminance(data, n, channels, i)
  const thresholds = new Float32Array(g.gw * g.gh)
  for (let b = 0; b < thresholds.length; b++) thresholds[b] = g.background[b] + nSigma * g.sigma

  // 2. Local maxima above the threshold of their block.
  let indices = new Int32Array(4096)
  let values = new Float32Array(4096)
  let count = 0
  for (let y = 1; y < h - 1; y++) {
    const blockRow = Math.floor(y / BLOCK_SIZE) * g.gw
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = L(i)
      if (v < thresholds[blockRow + Math.floor(x / BLOCK_SIZE)]) continue
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
  // Distance, along a direction, at which the luminance drops below the level.
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
  for (let k = 0; k < count && stars.length < maxStars; k++) {
    const i = indices[order[k]]
    if (occupied[i]) continue
    const x = i % w
    const y = (i - x) / w
    const peak = values[order[k]]
    const background = backgroundAt(g, x, y)
    const amplitude = peak - background
    if (amplitude < nSigma * g.sigma) continue
    // 3. Confirmation against a ring around it.
    // Beyond 6 pixels the ring widens only for saturated cores: a wide,
    // unsaturated bump is a structure of the nebula.
    const saturated = peak >= 0.98 * values[order[0]]
    let r = 3
    let ring = ringMean(x, y, r)
    while (ring > background + 0.8 * amplitude && r < (saturated ? 128 : 6)) {
      r *= 2
      ring = ringMean(x, y, r)
    }
    if (peak - ring < nSigma * g.sigma) continue
    // 4. Centre and radius at half height.
    const half = background + 0.5 * amplitude
    let d = measure(x, y, half)
    const cx = Math.min(w - 1, Math.max(0, Math.round(x + (d[0] - d[4]) / 2)))
    const cy = Math.min(h - 1, Math.max(0, Math.round(y + (d[2] - d[6]) / 2)))
    if (cx !== x || cy !== y) d = measure(cx, cy, Math.min(half, L(cy * w + cx)))
    let radius = 0
    for (const v of d) radius += v
    radius = Math.max(0.5, radius / 8)
    stars.push({ x: cx, y: cy, peak, background, radius })
    // 5. Occupied disk.
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
function findSaturationLevels(data, n, channels) {
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

/** Gives color back to a star, modifying `data` in place. */
function colorizeStar(data, w, h, s, neighbors, options) {
  const n = w * h
  const { strength, coreProtection, saturationLevels, black, midtones, range } = options
  const toScreen = (v) => mtf(Math.min(1, Math.max(0, (v - black) / range)), midtones)
  const toLinear = (v) => black + range * mtf(v, 1 - midtones)
  const rc = s.radius
  const R = Math.min(200, Math.ceil(3 * rc + 4))
  // Neighbouring stars: their pixels do not belong to this star, neither to
  // measure the color nor to receive it. A pixel belongs to another star
  // if, in proportion to the radius, it is closer to its center than to
  // this one.
  const others = neighbors(s, R)
  const belongsToOther = (xx, yy) => {
    const here = Math.hypot(xx - s.x, yy - s.y) / s.radius
    for (const o of others) if (Math.hypot(xx - o.x, yy - o.y) / o.radius < here) return true
    return false
  }
  const x0 = Math.max(0, s.x - R)
  const x1 = Math.min(w - 1, s.x + R)
  const y0 = Math.max(0, s.y - R)
  const y1 = Math.min(h - 1, s.y + R)
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  const m = bw * bh

  // 1. Background: median of the ring between R-2 and R.
  const ringValues = new Float32Array(m)
  const background = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    let k = 0
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx - s.x, yy - s.y)
        if (d > R - 2 && d <= R) ringValues[k++] = data[c * n + yy * w + xx]
      }
    }
    if (k < 8) return
    background[c] = median(ringValues, k)
  }
  const screenBackground = toScreen(0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2])
  const screenPeak = toScreen(s.peak)
  const amplitude = screenPeak - screenBackground
  // A star that does not get close to white on screen already has its color.
  if (amplitude <= 0.05 || screenPeak < 0.6) return

  // 2. Color in the corona.
  const sum = [0, 0, 0]
  let count = 0
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      if (Math.hypot(xx - s.x, yy - s.y) > R - 2 || belongsToOther(xx, yy)) continue
      const i = yy * w + xx
      const r = data[i]
      const g = data[n + i]
      const b = data[2 * n + i]
      if (r >= saturationLevels[0] || g >= saturationLevels[1] || b >= saturationLevels[2]) continue
      const sr = toScreen(r)
      const sg = toScreen(g)
      const sb = toScreen(b)
      if (sr > 0.97 || sg > 0.97 || sb > 0.97) continue
      const f = (0.2126 * sr + 0.7152 * sg + 0.0722 * sb - screenBackground) / amplitude
      if (f < 0.1 || f > 0.75) continue
      sum[0] += r - background[0]
      sum[1] += g - background[1]
      sum[2] += b - background[2]
      count++
    }
  }
  if (count < 6) return
  // Reliability of the measurement: in faint stars the light of the corona
  // is small compared with the noise, and the measured color is biased by it
  // (usually towards a stronger tint than the true one). The color fades
  // towards white in proportion: full when the light of the corona exceeds
  // its noise many times over, almost zero when it is comparable.
  const signal = Math.max(0, 0.2126 * sum[0] + 0.7152 * sum[1] + 0.0722 * sum[2])
  const sumNoise = 5 * options.sigma * Math.sqrt(count)
  const reliability = (signal * signal) / (signal * signal + sumNoise * sumNoise)
  // A nearly absent channel (a very red star without blue, or the opposite)
  // stays small but positive, so that the ratios are defined.
  const strongest = Math.max(sum[0], sum[1], sum[2])
  if (!(strongest > 0)) return
  for (let c = 0; c < 3; c++) sum[c] = Math.max(sum[c], 0.02 * strongest)
  // Stars have, to a good approximation, the colors of a black body, from
  // light blue to orange. In the plane of the logarithms of the ratios
  // x = ln(red/green), y = ln(blue/green) these colors lie close to a line
  // through white, y = −1.483·x (derived from Planck's law at wavelengths
  // of 610, 540 and 460 nm, between 3000 and 30000 K). A color off the line
  // has a magenta or green component, which belongs to no star and comes
  // from a disturbed corona (a chromatic aberration fringe, an uneven
  // background). Beyond a tolerance band around the line (0.1 in logarithm,
  // about 10%) the color is brought back to the edge of the band by
  // changing only one of the two ratios, the one that leaves the color
  // farther from white: a red star with a touch of magenta loses the excess
  // blue and stays red, instead of turning pink; a light blue one loses the
  // excess red.
  // The color is never washed out.
  {
    const x = Math.log(sum[0] / sum[1])
    const y = Math.log(sum[2] / sum[1])
    const slope = 1.483
    const norm = Math.sqrt(1 + slope * slope)
    const distance = (y + slope * x) / norm
    const band = 0.1
    if (Math.abs(distance) > band) {
      const edge = Math.sign(distance) * band * norm
      const xa = x
      const ya = edge - slope * x
      const xb = (edge - y) / slope
      const yb = y
      const useA = xa * xa + ya * ya >= xb * xb + yb * yb
      sum[0] = sum[1] * Math.exp(useA ? xa : xb)
      sum[2] = sum[1] * Math.exp(useA ? ya : yb)
    }
  }
  const maxChannel = Math.max(sum[0], sum[1], sum[2])
  if (!(maxChannel > 0)) return
  // Color as a fraction of the strongest channel, reinforced or attenuated
  // by the strength (at 100% it is the measured one).
  const target = []
  for (let c = 0; c < 3; c++) {
    const t = Math.max(0, sum[c]) / maxChannel
    target.push(Math.min(1, Math.max(0.05, 1 - strength * reliability * (1 - t))))
  }
  if (target[0] > 0.98 && target[1] > 0.98 && target[2] > 0.98) return

  // 3. Saturated zone: the radius within which the pixels saturated in the
  // data fall. The protection applies to the whole saturated disk and fades
  // in a ring around it, so the light center stays round and soft even when
  // the saturated pixels are few and scattered.
  let saturatedRadius = -1
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const d = Math.hypot(xx - s.x, yy - s.y)
      if (d > 2 * rc + 2) continue
      const i = yy * w + xx
      if (data[i] >= saturationLevels[0] || data[n + i] >= saturationLevels[1] || data[2 * n + i] >= saturationLevels[2]) saturatedRadius = Math.max(saturatedRadius, d)
    }
  }
  const protectionAt = (d) => (saturatedRadius < 0 ? 0 : 1 - smoothstep(saturatedRadius + 0.5, saturatedRadius + 2 + 0.5 * saturatedRadius, d))

  // 4. The color in the central part, on screen.
  const sc = [0, 0, 0]
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      if (Math.hypot(xx - s.x, yy - s.y) > R - 2 || belongsToOther(xx, yy)) continue
      const i = yy * w + xx
      for (let c = 0; c < 3; c++) {
        const v = data[c * n + i]
        sc[c] = toScreen(v)
      }
      const f = (0.2126 * sc[0] + 0.7152 * sc[1] + 0.0722 * sc[2] - screenBackground) / amplitude
      const weight = smoothstep(0.15, 0.6, f) * (1 - coreProtection * protectionAt(Math.hypot(xx - s.x, yy - s.y)))
      if (weight <= 0) continue
      const M = Math.max(sc[0], sc[1], sc[2])
      if (M <= 0) continue
      const updated = [0, 0, 0]
      for (let c = 0; c < 3; c++) {
        const q = sc[c] / M
        updated[c] = M * (q + weight * (Math.min(q, target[c]) - q))
      }
      // A pixel that already has a color of its own, stronger or of a
      // different hue, must not fade: if the saturation would drop, the
      // pixel stays as it is.
      const saturationBefore = (M - Math.min(sc[0], sc[1], sc[2])) / M
      const Mn = Math.max(updated[0], updated[1], updated[2])
      if (!(Mn > 0) || (Mn - Math.min(updated[0], updated[1], updated[2])) / Mn < saturationBefore) continue
      for (let c = 0; c < 3; c++) if (updated[c] < sc[c] - 1e-4) data[c * n + i] = toLinear(updated[c])
    }
  }
}

export function processImage(image, params, context) {
  const { width: w, height: h, channels, data } = image
  if (channels !== 3 || params.strength <= 0) return image
  const n = w * h
  const { black, midtones, white } = context.stretch
  const g = blockBackground(data, w, h, channels)
  const minimumRadius = Math.max(0.5, params.minimumSize)
  const allStars = findStars(data, w, h, channels, g, 8, 200000)
  // Grid of the stars, to quickly find the neighbors of each one.
  const CELL = 64
  const gw = Math.ceil(w / CELL)
  const grid = new Map()
  for (const s of allStars) {
    const key = Math.floor(s.y / CELL) * gw + Math.floor(s.x / CELL)
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key).push(s)
  }
  const neighbors = (s, R) => {
    const list = []
    const m = Math.ceil((R + 64) / CELL)
    const cx = Math.floor(s.x / CELL)
    const cy = Math.floor(s.y / CELL)
    for (let gy = cy - m; gy <= cy + m; gy++) {
      for (let gx = cx - m; gx <= cx + m; gx++) {
        if (gx < 0 || gx >= gw) continue
        for (const o of grid.get(gy * gw + gx) ?? []) {
          if (o !== s && Math.hypot(o.x - s.x, o.y - s.y) < R + 4 * o.radius + 4) list.push(o)
        }
      }
    }
    return list
  }
  const stars = allStars.filter((s) => s.radius >= minimumRadius)
  const options = {
    strength: params.strength,
    coreProtection: params.coreProtection,
    saturationLevels: findSaturationLevels(data, n, channels),
    black,
    midtones,
    range: Math.max(1e-6, white - black),
    sigma: g.sigma
  }
  for (const s of stars) colorizeStar(data, w, h, s, neighbors, options)
  return { width: w, height: h, channels, data }
}
