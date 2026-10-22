/*
 * Diffraction spikes. StarLight plugin. MIT license,
 * FM Digital Tools.
 *
 * In a reflecting telescope the secondary mirror is held by thin supports
 * (the “spider”). The light that grazes them is diffracted perpendicular
 * to each support: around bright stars, luminous spikes appear, two per
 * straight support. This plugin draws them. It is an aesthetic effect: the
 * spikes do not come from the data.
 *
 * The method:
 *   1. Star search. On the image as it appears on screen (stretched as the
 *      viewer stretches it) the luma is computed; the local background is
 *      the median of tiles of about 1/24 of the short side, interpolated.
 *      Candidates are the pixels above the chosen threshold that exceed the
 *      local background by at least 0.2; neighboring candidates are joined
 *      into regions.
 *   2. Compact, round regions are kept, small enough to be stars and not
 *      the core of a galaxy or a bright nebula: besides a limit on area and
 *      elongation, at three radii from the center (and at least six pixels
 *      beyond the edge of the core, because a star just above the threshold
 *      has a small core compared with its image blurred by the seeing) the
 *      light above the background must have dropped below 12% of that of
 *      the core. In a star, even an overexposed one, at that distance
 *      almost only the background remains (usually less than 7%); in the
 *      core of a small elliptical galaxy the light falls off more slowly
 *      (over 15%).
 *   3. For each star the center (centroid of the light), the total light F
 *      above the background, within the same distance, and the color, in
 *      the halo around the core, where the channels are not saturated, are
 *      measured. The stars with the largest F are kept, up to the chosen
 *      number.
 *   4. Length. The intensity of a diffraction spike falls along the spike
 *      roughly as the inverse square of the distance, so the distance at
 *      which it drops below a fixed level grows as the square root of the
 *      light of the star. The length is L = k·√F, with k chosen by the
 *      slider: √F is measured in pixels, so the spikes scale with the image
 *      and a reduced crop shows them in proportion. The stretch compresses
 *      the differences in light between saturated stars, and with the
 *      square root alone all the spikes would look equally long: for this
 *      reason L is further multiplied by (F / F of the brightest)^0.5,
 *      which leaves the brightest star unchanged and quickly shortens the
 *      others: the long spikes stay on the few brightest stars.
 *   5. Profile. Along the spike, at distance d and with x = d/L, the
 *      intensity is A·(1 − x)²·(0.4 + 0.6·e^(−d/(1.5r))), with r the radius
 *      of the core: a quick drop just outside the star and then a tail that
 *      fades out smoothly at the tip, without sharp cuts. Across, the spike
 *      has a Gaussian profile plus a wide, faint wing (three times wider, a
 *      quarter of the intensity), like a real spike seen through the
 *      seeing. The width at the base grows with the star (0.12·√F, at least
 *      0.6 pixels) and shrinks to 40% towards the tip: the spike is fuller
 *      near the star and tapers.
 *   6. Color dispersion. The diffraction angle is proportional to the
 *      wavelength: red reaches farther than green, and blue less far.
 *      With dispersion on, each channel has its own length (red 1.12,
 *      green 1, blue 0.86 times L, roughly the ratio of 620, 550 and
 *      470 nm), and towards the tip mostly red remains.
 *   7. The spikes blend with the image in “screen” mode,
 *      1 − (1 − a)(1 − b), which brightens without ever exceeding white,
 *      and the result is brought back to the linear data with the inverse
 *      stretch. Pixels far from the spikes stay identical.
 */

const WEIGHTS = [0.2126, 0.7152, 0.0722]
/** Relative length of the spike in the three channels, with dispersion (step 6). */
const DISPERSION = [1.12, 1, 0.86]

/** Midtones function, the same as the viewer's. With m and 1 − m it is its own inverse. */
function mtf(x, m) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

/** Median of a plane by tiles, then read with bilinear interpolation (local background). */
function localBackground(plane, w, h) {
  const tile = Math.max(16, Math.round(Math.min(w, h) / 24))
  const nx = Math.ceil(w / tile)
  const ny = Math.ceil(h / tile)
  const grid = new Float32Array(nx * ny)
  // At most about 1000 samples per tile.
  const step = Math.max(1, Math.floor(tile / 32))
  const sample = []
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      sample.length = 0
      const x1 = Math.min(w, (tx + 1) * tile)
      const y1 = Math.min(h, (ty + 1) * tile)
      for (let y = ty * tile; y < y1; y += step) for (let x = tx * tile; x < x1; x += step) sample.push(plane[y * w + x])
      sample.sort((a, b) => a - b)
      grid[ty * nx + tx] = sample[sample.length >> 1]
    }
  }
  return (x, y) => {
    const gx = Math.min(nx - 1, Math.max(0, x / tile - 0.5))
    const gy = Math.min(ny - 1, Math.max(0, y / tile - 0.5))
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const x1 = Math.min(nx - 1, x0 + 1)
    const y1 = Math.min(ny - 1, y0 + 1)
    const fx = gx - x0
    const fy = gy - y0
    const a = grid[y0 * nx + x0] * (1 - fx) + grid[y0 * nx + x1] * fx
    const b = grid[y1 * nx + x0] * (1 - fx) + grid[y1 * nx + x1] * fx
    return a * (1 - fy) + b * fy
  }
}

/** Steps 1, 2 and 3: the bright stars, sorted from the brightest. */
function findStars(luma, rgb, w, h, threshold, maxStars) {
  const n = w * h
  const background = localBackground(luma, w, h)
  const seen = new Uint8Array(n)
  const maxRadius = Math.max(4, 0.015 * Math.min(w, h))
  const maxArea = Math.PI * maxRadius * maxRadius
  const stack = []
  const stars = []
  for (let start = 0; start < n; start++) {
    if (seen[start] || luma[start] < threshold) continue
    const x0 = start % w
    const y0 = (start - x0) / w
    const f0 = background(x0, y0)
    if (luma[start] - f0 < 0.2) continue
    // Region fill: pixels above the threshold and above the background.
    let area = 0
    let sx = 0
    let sy = 0
    let sp = 0
    let minX = x0
    let maxX = x0
    let minY = y0
    let maxY = y0
    let peak = 0
    // Adds to the region a neighbor that exceeds threshold and background.
    const tryAdd = (j) => {
      if (seen[j] || luma[j] < threshold || luma[j] - f0 < 0.2) return
      seen[j] = 1
      stack.push(j)
    }
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const i = stack.pop()
      const x = i % w
      const y = (i - x) / w
      const p = luma[i] - f0
      area++
      sx += x * p
      sy += y * p
      sp += p
      if (p > peak) peak = p
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      // Four neighbors.
      if (x > 0) tryAdd(i - 1)
      if (x < w - 1) tryAdd(i + 1)
      if (y > 0) tryAdd(i - w)
      if (y < h - 1) tryAdd(i + w)
    }
    if (area < 3 || area > maxArea) continue
    const regionWidth = maxX - minX + 1
    const regionHeight = maxY - minY + 1
    if (Math.max(regionWidth, regionHeight) > 2 * Math.min(regionWidth, regionHeight)) continue
    const diameter = Math.max(regionWidth, regionHeight)
    if (area < 0.45 * (Math.PI / 4) * diameter * diameter) continue
    const cx = sx / sp
    const cy = sy / sp
    const r = Math.sqrt(area / Math.PI)

    // Total light within three radii, light on the ring at three radii, color of the halo.
    const R = Math.max(3 * r, r + 6)
    let light = 0
    let ring = 0
    let ringCount = 0
    const color = [0, 0, 0]
    let colorWeight = 0
    const xa = Math.max(0, Math.floor(cx - R))
    const xb = Math.min(w - 1, Math.ceil(cx + R))
    const ya = Math.max(0, Math.floor(cy - R))
    const yb = Math.min(h - 1, Math.ceil(cy + R))
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const d = Math.hypot(x - cx, y - cy)
        if (d > R) continue
        const i = y * w + x
        const p = luma[i] - background(x, y)
        if (p > 0) light += p
        if (d > R - 1) {
          ring += p
          ringCount++
        }
        if (rgb && d > r && d < 2.5 * r + 1 && p > 0.02) {
          const a = rgb[0][i]
          const b = rgb[1][i]
          const c = rgb[2][i]
          if (a < 0.98 && b < 0.98 && c < 0.98) {
            color[0] += a * p
            color[1] += b * p
            color[2] += c * p
            colorWeight += p
          }
        }
      }
    }
    // Extended structure: at three radii the light has not dropped enough.
    if (ringCount > 0 && ring / ringCount > 0.12 * peak) continue
    let tint = [1, 1, 1]
    if (colorWeight > 0) {
      const m = Math.max(color[0], color[1], color[2])
      if (m > 0) tint = color.map((v) => v / m)
    }
    stars.push({ cx, cy, r, light, tint })
  }
  stars.sort((a, b) => b.light - a.light)
  return stars.slice(0, maxStars)
}

export function processImage(image, params, context) {
  const { width: w, height: h, channels, data } = image
  const n = w * h
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  const mInverse = 1 - midtones
  const stretch = (v) => mtf(Math.min(1, Math.max(0, (v - black) / range)), midtones)
  const unstretch = (y) => black + range * mtf(y, mInverse)
  const isColor = channels === 3

  // Image as it appears on screen: luma and, if in color, the three channels.
  const luma = new Float32Array(n)
  let rgb = null
  if (isColor) {
    rgb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
    for (let i = 0; i < n; i++) {
      const r = stretch(data[i])
      const g = stretch(data[n + i])
      const b = stretch(data[2 * n + i])
      rgb[0][i] = r
      rgb[1][i] = g
      rgb[2][i] = b
      luma[i] = WEIGHTS[0] * r + WEIGHTS[1] * g + WEIGHTS[2] * b
    }
  } else {
    for (let i = 0; i < n; i++) luma[i] = stretch(data[i])
  }

  const stars = findStars(luma, rgb, w, h, params.threshold, Math.round(params.maxStars))
  const output = Float32Array.from(data)
  if (stars.length === 0) return { width: w, height: h, channels, data: output }

  const spikes = parseInt(params.spikes, 10) || 4
  const k = 3 + 27 * params.length
  const A = params.strength
  const dispersion = isColor && params.spectrum ? DISPERSION : [1, 1, 1]
  const maxLengthFactor = Math.max(...dispersion)
  // Directions of the spikes; the y axis of the image points down.
  const directions = []
  for (let j = 0; j < spikes; j++) {
    const a = ((params.angle + (j * 360) / spikes) * Math.PI) / 180
    directions.push([Math.cos(a), -Math.sin(a)])
  }
  const channelCount = isColor ? 3 : 1
  const limit = 0.3 * Math.max(w, h)

  const maxLight = stars[0].light
  for (const s of stars) {
    const L = Math.min(limit, k * Math.sqrt(s.light) * Math.pow(s.light / maxLight, 0.5))
    if (L < 2) continue
    // Width at the base; along the spike it narrows down to 40% (step 5).
    const sigma0 = params.thickness * Math.max(0.6, 0.12 * Math.sqrt(s.light))
    const halfWidth = 9 * sigma0
    const tint = isColor && params.starColor ? s.tint : [1, 1, 1]
    const H = Math.ceil(L * maxLengthFactor + halfWidth)
    const xa = Math.max(0, Math.floor(s.cx - H))
    const xb = Math.min(w - 1, Math.ceil(s.cx + H))
    const ya = Math.max(0, Math.floor(s.cy - H))
    const yb = Math.min(h - 1, Math.ceil(s.cy + H))
    const lengths = dispersion.map((f) => L * f)
    const sum = [0, 0, 0]
    for (let y = ya; y <= yb; y++) {
      const dy = y - s.cy
      for (let x = xa; x <= xb; x++) {
        const dx = x - s.cx
        const d = Math.hypot(dx, dy)
        if (d > H) continue
        sum[0] = sum[1] = sum[2] = 0
        let touched = false
        for (let j = 0; j < spikes; j++) {
          const c = directions[j][0]
          const sn = directions[j][1]
          const along = dx * c + dy * sn
          if (along <= 0) continue
          const across = -dx * sn + dy * c
          if (across > halfWidth || across < -halfWidth) continue
          // Cross profile (step 5).
          const q = across * across
          const sigma = sigma0 * (1 - 0.6 * Math.min(1, along / L))
          const wing = 3 * sigma
          const t = 0.75 * Math.exp(-q / (2 * sigma * sigma)) + 0.25 * Math.exp(-q / (2 * wing * wing))
          const near = 0.4 + 0.6 * Math.exp(-along / (1.5 * s.r))
          for (let ch = 0; ch < channelCount; ch++) {
            const xr = along / lengths[ch]
            if (xr >= 1) continue
            // “Screen” sum of the overlapping spikes.
            const v = A * (1 - xr) * (1 - xr) * near * t * tint[ch]
            sum[ch] = 1 - (1 - sum[ch]) * (1 - v)
            touched = true
          }
        }
        if (!touched) continue
        const i = y * w + x
        for (let ch = 0; ch < channelCount; ch++) {
          if (sum[ch] < 1e-5) continue
          const j = ch * n + i
          const a = stretch(output[j])
          output[j] = unstretch(1 - (1 - a) * (1 - sum[ch]))
        }
      }
    }
  }
  return { width: w, height: h, channels, data: output }
}
