/*
 * Star and nebula separation. StarLight plugin. MIT license, FM Digital Tools.
 *
 * Splits the image into two layers, the starless nebula and the stars
 * alone, adjusts them separately and recombines them. This way the nebula
 * can be given contrast and color without swelling the stars, and the
 * stars can be reduced without touching the nebula. The plugin can also
 * return only one of the two layers, for export.
 *
 * The method is classic and fully described here, without neural networks:
 *   1. Star detection. On the luminance, as it appears on screen, a
 *      morphological opening is computed (a local minimum followed by a
 *      local maximum, over a square slightly larger than the largest
 *      star): the opening removes small, bright structures and keeps the
 *      extended ones. The difference between the image and the opening
 *      (the "top hat" of mathematical morphology, J. Serra, 1982) contains
 *      the stars. The regions kept are those that exceed the noise by a
 *      number of times chosen with the sensitivity, and that are small
 *      enough and round enough: a filament of nebula, long and thin, is
 *      not taken for a star.
 *   2. Mask. Each star found is widened by the chosen margin plus half of
 *      its radius, to include the halo: large stars receive a wider
 *      margin, the small ones of a dense field stay narrow.
 *   3. Fill. The pixels under the mask are rebuilt from the surrounding
 *      pixels with a pyramid interpolation ("push-pull", S. Gortler et al.,
 *      "The Lumigraph", SIGGRAPH 1996): the image is halved several times
 *      keeping only the valid pixels, then the levels are climbed back up
 *      filling the gaps with the coarser levels. Noise with the same
 *      amplitude as the image's is added to the filled area, so that it
 *      does not look like a smooth patch.
 *   4. The stars are the difference between the image and the rebuilt
 *      nebula.
 *   5. Each layer is adjusted on its own, then the two layers are added.
 *      With neutral values the sum returns exactly the image.
 */

/** Midtones transfer function, the same as the viewer's. */
function mtf(x, m) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

/**
 * Minimum or maximum over a window of side 2r+1 along one direction, with
 * the van Herk and Gil-Werman algorithm: three comparisons per pixel,
 * whatever the radius.
 */
function extreme1D(src, dst, length, lines, stride, step, r, maximum) {
  const k = 2 * r + 1
  const left = new Float32Array(length + 2 * r)
  const right = new Float32Array(length + 2 * r)
  const row = new Float32Array(length + 2 * r)
  const pick = maximum ? (x, y) => (x > y ? x : y) : (x, y) => (x < y ? x : y)
  for (let l = 0; l < lines; l++) {
    const base = l * stride
    const m = length + 2 * r
    for (let i = 0; i < m; i++) {
      const j = Math.min(length - 1, Math.max(0, i - r))
      row[i] = src[base + j * step]
    }
    for (let i = 0; i < m; i++) left[i] = i % k === 0 ? row[i] : pick(left[i - 1], row[i])
    for (let i = m - 1; i >= 0; i--) right[i] = i % k === k - 1 || i === m - 1 ? row[i] : pick(right[i + 1], row[i])
    for (let i = 0; i < length; i++) dst[base + i * step] = pick(right[i], left[i + 2 * r])
  }
}

/** Minimum or maximum over a square of side 2r+1. */
function extreme(plane, w, h, r, maximum) {
  if (r <= 0) return Float32Array.from(plane)
  const t = new Float32Array(plane.length)
  const a = new Float32Array(plane.length)
  extreme1D(plane, t, w, h, w, 1, r, maximum)
  extreme1D(t, a, h, w, 1, w, r, maximum)
  return a
}

/** Widens a mask by r pixels. */
function dilate(mask, w, h, r) {
  if (r <= 0) return mask
  const f = new Float32Array(mask.length)
  for (let i = 0; i < f.length; i++) f[i] = mask[i]
  const g = extreme(f, w, h, r, true)
  const result = new Uint8Array(mask.length)
  for (let i = 0; i < g.length; i++) result[i] = g[i] > 0 ? 1 : 0
  return result
}

/**
 * Noise of a plane: median absolute deviation of the difference between
 * the plane and its mean over 7×7 pixels. The noise of stacked images has
 * a grain of a few pixels, which comparing neighboring pixels
 * underestimates.
 */
function noise(plane, w, h) {
  const smooth = squareMean(plane, w, h, 3)
  const deviations = new Float32Array(plane.length)
  for (let i = 0; i < plane.length; i++) deviations[i] = plane[i] - smooth[i]
  const center = percentile(deviations, 0.5)
  for (let i = 0; i < deviations.length; i++) deviations[i] = Math.abs(deviations[i] - center)
  return 1.4826 * percentile(deviations, 0.5)
}

/** Mean over a square of side 2r+1. */
function squareMean(plane, w, h, r) {
  const t = new Float32Array(plane.length)
  const a = new Float32Array(plane.length)
  box(plane, t, w, h, r, w, 1)
  box(t, a, h, w, r, 1, w)
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

/**
 * Synthetic noise with the grain of the image: white noise softened over
 * 3×3 pixels and brought back to the desired deviation. It is generated
 * only where needed (`where`, the mask widened by one pixel), which is a
 * small part of the image.
 */
function syntheticGrain(w, h, sigma, rnd, where) {
  const white = new Float32Array(w * h)
  for (let i = 0; i < white.length; i++) if (where[i]) white[i] = gaussian(rnd)
  const soft = squareMean(white, w, h, 1)
  // The mean of 9 independent values has a deviation of 1/3.
  for (let i = 0; i < soft.length; i++) soft[i] *= 3 * sigma
  return soft
}

/** Value below which the fraction `share` of the values lies (on a sample). */
function percentile(plane, share) {
  const step = Math.max(1, Math.floor(plane.length / 200000))
  const sample = []
  for (let i = 0; i < plane.length; i += step) sample.push(plane[i])
  sample.sort((a, b) => a - b)
  return sample[Math.min(sample.length - 1, Math.floor(share * sample.length))] ?? 0
}

/**
 * Fills the pixels with mask 1 from the others, with the "push-pull"
 * pyramid. Returns a new plane.
 */
function fill(plane, mask, w, h) {
  const levels = []
  let values = new Float32Array(plane.length)
  let weights = new Float32Array(plane.length)
  for (let i = 0; i < plane.length; i++) {
    weights[i] = mask[i] ? 0 : 1
    values[i] = mask[i] ? 0 : plane[i]
  }
  let lw = w
  let lh = h
  levels.push({ values, weights, w: lw, h: lh })
  // Descent: each level is the weighted mean of 2×2 squares of the previous one.
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, Math.ceil(lw / 2))
    const nh = Math.max(1, Math.ceil(lh / 2))
    const v = new Float32Array(nw * nh)
    const p = new Float32Array(nw * nh)
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sum = 0
        let weight = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = 2 * x + dx
            const sy = 2 * y + dy
            if (sx >= lw || sy >= lh) continue
            const j = sy * lw + sx
            sum += values[j] * weights[j]
            weight += weights[j]
          }
        }
        p[y * nw + x] = Math.min(1, weight)
        v[y * nw + x] = weight > 0 ? sum / weight : 0
      }
    }
    values = v
    weights = p
    lw = nw
    lh = nh
    levels.push({ values, weights, w: lw, h: lh })
  }
  // Ascent: where the fine level has no data, it takes it from the coarse level.
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l]
    const coarse = levels[l + 1]
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x
        const p = fine.weights[i]
        if (p >= 1) continue
        // Bilinear interpolation in the coarse level.
        const gx = Math.min(coarse.w - 1, Math.max(0, (x - 0.5) / 2))
        const gy = Math.min(coarse.h - 1, Math.max(0, (y - 0.5) / 2))
        const x0 = Math.floor(gx)
        const y0 = Math.floor(gy)
        const x1 = Math.min(coarse.w - 1, x0 + 1)
        const y1 = Math.min(coarse.h - 1, y0 + 1)
        const fx = gx - x0
        const fy = gy - y0
        const g = coarse.values
        const up =
          (g[y0 * coarse.w + x0] * (1 - fx) + g[y0 * coarse.w + x1] * fx) * (1 - fy) +
          (g[y1 * coarse.w + x0] * (1 - fx) + g[y1 * coarse.w + x1] * fx) * fy
        fine.values[i] = fine.values[i] * p + up * (1 - p)
        fine.weights[i] = 1
      }
    }
  }
  return levels[0].values
}

/** Pseudo-random generator with a fixed seed: the same result at every run. */
function random(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Normally distributed value (mean 0, deviation 1). */
function gaussian(rnd) {
  const u = Math.max(1e-12, rnd())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
}

export function processImage(image, params, context) {
  const { width: w, height: h, channels, data } = image
  const n = w * h
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  const radius = Math.max(1, Math.round(params.starRadius))
  const times = 3 + 7 * (1 - params.sensitivity)
  const margin = Math.max(0, Math.round(params.margin))

  // 1. Luminance as it appears on screen, and top hat.
  const screen = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let l = data[i]
    if (channels === 3) l = 0.2126 * data[i] + 0.7152 * data[n + i] + 0.0722 * data[2 * n + i]
    screen[i] = mtf(Math.min(1, Math.max(0, (l - black) / range)), midtones)
  }
  const opening = extreme(extreme(screen, w, h, radius + 1, false), w, h, radius + 1, true)
  const topHat = new Float32Array(n)
  for (let i = 0; i < n; i++) topHat[i] = screen[i] - opening[i]
  // The top hat of noise alone is not centered on zero: level and spread
  // are measured on it, with the median and the median absolute deviation,
  // which the stars (few pixels) do not shift.
  const center = percentile(topHat, 0.5)
  const deviations = new Float32Array(n)
  for (let i = 0; i < n; i++) deviations[i] = Math.abs(topHat[i] - center)
  const sigma = Math.max(1e-5, 1.4826 * percentile(deviations, 0.5))
  const highThreshold = center + times * sigma
  const lowThreshold = center + 0.5 * times * sigma

  // Connected regions that start from a pixel above the high threshold and
  // extend as long as they stay above the low one.
  const label = new Int32Array(n)
  const stars = new Uint8Array(n)
  const margins = new Uint8Array(n)
  const stack = new Int32Array(n)
  // Maximum side of a region: twice the disc, because the halo of bright
  // stars and close pairs go beyond the chosen radius.
  const side = 4 * radius + 3
  const maxArea = side * side
  let regionCount = 0
  // Start from the brightest pixels: each region is born from the peak of
  // its star and grows only as long as it stays above a fraction of that
  // peak. On a bright nebula the star thus does not spread into the
  // structure of the nebula, which also has some "top hat".
  const seeds = []
  for (let i = 0; i < n; i++) if (topHat[i] >= highThreshold) seeds.push(i)
  seeds.sort((a, b) => topHat[b] - topHat[a])
  for (const seedIndex of seeds) {
    if (label[seedIndex] !== 0) continue
    const regionThreshold = Math.max(lowThreshold, 0.2 * topHat[seedIndex])
    regionCount++
    let top = 0
    stack[top++] = seedIndex
    label[seedIndex] = regionCount
    const members = []
    let x0 = w
    let x1 = 0
    let y0 = h
    let y1 = 0
    let peak = 0
    let tooLarge = false
    while (top > 0) {
      const i = stack[--top]
      if (members.length <= maxArea) members.push(i)
      else tooLarge = true
      const x = i % w
      const y = (i - x) / w
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (topHat[i] > peak) peak = topHat[i]
      // The four neighbors, without building lists: this loop runs for every pixel of the stars.
      for (let v = 0; v < 4; v++) {
        let j = -1
        if (v === 0 && x > 0) j = i - 1
        else if (v === 1 && x < w - 1) j = i + 1
        else if (v === 2 && y > 0) j = i - w
        else if (v === 3 && y < h - 1) j = i + w
        if (j < 0 || label[j] !== 0 || topHat[j] < regionThreshold) continue
        label[j] = regionCount
        stack[top++] = j
      }
    }
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    // Small and compact: no wider than the maximum side, not too elongated
    // (two close stars, merged, are still accepted) and filling part of its
    // rectangle. The filaments of the nebula are longer than the maximum
    // side and are already excluded by the size.
    const round = Math.max(bw, bh) <= 3 * Math.min(bw, bh) && members.length >= 0.25 * bw * bh
    if (tooLarge || bw > side || bh > side || !round) continue
    // The halo grows with the star: an extra margin equal to half of its
    // radius, so that the small stars of a dense field do not cover everything.
    const extra = Math.min(6, Math.round(0.5 * Math.sqrt(members.length / Math.PI)))
    for (const i of members) {
      stars[i] = 1
      margins[i] = extra
    }
  }

  // 2. Mask: each star widened by the chosen margin plus its halo.
  const mask = new Uint8Array(n)
  for (let extra = 0; extra <= 6; extra++) {
    const group = new Uint8Array(n)
    let present = false
    for (let i = 0; i < n; i++) {
      if (stars[i] && margins[i] === extra) {
        group[i] = 1
        present = true
      }
    }
    if (!present) continue
    const widened = dilate(group, w, h, margin + extra)
    for (let i = 0; i < n; i++) if (widened[i]) mask[i] = 1
  }

  // 3. and 4. Rebuilt nebula and stars, for each channel.
  const rnd = random(20261018)
  const grainArea = dilate(mask, w, h, 1)
  const nebula = new Float32Array(data.length)
  const starsOnly = new Float32Array(data.length)
  for (let c = 0; c < channels; c++) {
    const plane = data.subarray(c * n, (c + 1) * n)
    const filled = fill(plane, mask, w, h)
    const grain = syntheticGrain(w, h, noise(plane, w, h), rnd, grainArea)
    for (let i = 0; i < n; i++) {
      const v = mask[i] ? filled[i] + grain[i] : plane[i]
      nebula[c * n + i] = v
      starsOnly[c * n + i] = plane[i] - v
    }
  }

  // 5. Separate adjustments.
  const lum = (arr, i) =>
    channels === 3 ? 0.2126 * arr[i] + 0.7152 * arr[n + i] + 0.0722 * arr[2 * n + i] : arr[i]
  // Nebula: brightness above the background, and saturation.
  const background = []
  for (let c = 0; c < channels; c++) background.push(percentile(nebula.subarray(c * n, (c + 1) * n), 0.25))
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const k = c * n + i
      nebula[k] = background[c] + (nebula[k] - background[c]) * params.nebulaBrightness
    }
    if (channels === 3) {
      const l = lum(nebula, i)
      for (let c = 0; c < 3; c++) nebula[c * n + i] = l + (nebula[c * n + i] - l) * params.nebulaSaturation
    }
  }
  // Stars: reduction (a local minimum of 1 or 2 pixels, dosed), brightness
  // and saturation.
  const reduction = params.starReduction
  if (reduction > 0) {
    for (let c = 0; c < channels; c++) {
      const plane = starsOnly.subarray(c * n, (c + 1) * n)
      const r1 = extreme(plane, w, h, 1, false)
      const r2 = reduction > 0.5 ? extreme(plane, w, h, 2, false) : r1
      for (let i = 0; i < n; i++) {
        const t = reduction <= 0.5 ? reduction * 2 : (reduction - 0.5) * 2
        const from = reduction <= 0.5 ? plane[i] : r1[i]
        const to = reduction <= 0.5 ? r1[i] : r2[i]
        plane[i] = from + (to - from) * t
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) starsOnly[c * n + i] *= params.starBrightness
    if (channels === 3) {
      const l = lum(starsOnly, i)
      for (let c = 0; c < 3; c++) starsOnly[c * n + i] = l + (starsOnly[c * n + i] - l) * params.starSaturation
    }
  }

  const output = new Float32Array(data.length)
  if (params.output === 'nebula') output.set(nebula)
  else if (params.output === 'stars') {
    // The stars above the level of the original sky background: the
    // stretch brings that level to black and the stars appear as in the
    // image.
    for (let c = 0; c < channels; c++) {
      const level = percentile(data.subarray(c * n, (c + 1) * n), 0.25)
      for (let i = 0; i < n; i++) output[c * n + i] = level + Math.max(0, starsOnly[c * n + i])
    }
  }
  else for (let k = 0; k < output.length; k++) output[k] = nebula[k] + starsOnly[k]
  return { width: w, height: h, channels, data: output }
}
