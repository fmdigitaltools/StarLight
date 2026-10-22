/*
 * Split toning of shadows and highlights. StarLight plugin. MIT license,
 * FM Digital Tools.
 *
 * In photographic printing, split toning gave one tint to the shadows and
 * another to the highlights, often cool for the former and warm for the
 * latter. The same is done here on the image as it appears on screen, with
 * two refinements designed for sky shots: the brightness does not change
 * and the sky background can stay untouched.
 *
 * The method:
 *   1. the image is stretched as the viewer stretches it and its luma y is
 *      computed (ITU-R BT.709 weights: 0.2126 R + 0.7152 G + 0.0722 B);
 *   2. the sky background b is estimated as the 20th percentile of the luma
 *      (on a sample of pixels);
 *   3. the position of a pixel between the background and white,
 *      u = (y − b)/(1 − b), decides how much of it is “highlight”: a soft
 *      transition centered on the point chosen with the balance. The rest
 *      is “shadow”;
 *   4. each tint T becomes a color direction with zero luma,
 *      D = T / Y(T) − (1, 1, 1): adding it to a pixel changes its color but
 *      not its brightness. The shift is proportional to y·(1 − y)^1.5: in
 *      proportion to the brightness the tint has the same strength in all
 *      the shadows, black pixels stay black and the tint fades out toward
 *      white, so saturated stars stay white. If a channel would leave the
 *      range, the shift is shortened just enough, always along the same
 *      direction, so the luma stays exact;
 *   5. background protection: on a slightly blurred copy of the luma (noise
 *      must not switch on single pixels) the background b' and its spread
 *      σ' are measured (from the 5th and the 20th percentile); the toning
 *      comes in gradually from b' + 3σ' to b' + 3σ' + max(0.015, 4σ').
 *      Below the first threshold the pixel stays identical to the original;
 *   6. the result is brought back to the linear data with the inverse
 *      stretch;
 *   7. stars do not receive the shadow tint: where the luma exceeds its
 *      blurred copy by at least 0.03-0.1 (a point source, smaller than the
 *      blur) the shadow tint fades until it disappears. The highlight tint
 *      stays, because bright stars are already protected by white.
 */

const WEIGHTS = [0.2126, 0.7152, 0.0722]

/** Midtones transfer function, the same as the viewer's. With m and 1 − m it is its own inverse. */
function mtf(x, m) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

/** Hue on the color wheel (degrees) to RGB at full saturation and full brightness. */
function fromHue(degrees) {
  const h = (((degrees % 360) + 360) % 360) / 60
  const x = 1 - Math.abs((h % 2) - 1)
  if (h < 1) return [1, x, 0]
  if (h < 2) return [x, 1, 0]
  if (h < 3) return [0, 1, x]
  if (h < 4) return [0, x, 1]
  if (h < 5) return [x, 0, 1]
  return [1, 0, x]
}

/** Color direction with zero luma for the tint (point 4). */
function direction(degrees) {
  const t = fromHue(degrees)
  const y = WEIGHTS[0] * t[0] + WEIGHTS[1] * t[1] + WEIGHTS[2] * t[2]
  return t.map((v) => v / y - 1)
}

/** Smooth transition from 0 to 1 between a and b. */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Moving average along one direction: `step` between neighboring samples, `stride` between one line and the next. */
function boxFilter(from, to, length, lines, r, stride, step) {
  const windowSize = 2 * r + 1
  const last = length - 1
  for (let l = 0; l < lines; l++) {
    const start = l * stride
    let sum = 0
    for (let i = -r; i <= r; i++) sum += from[start + Math.min(last, Math.max(0, i)) * step]
    for (let i = 0; i < length; i++) {
      to[start + i * step] = sum / windowSize
      const entering = Math.min(last, i + r + 1)
      const leaving = Math.max(0, i - r)
      sum += from[start + entering * step] - from[start + leaving * step]
    }
  }
}

/**
 * Background level and its spread, on a sample. The background is the 20th
 * percentile: even when a nebula fills half the field it is still a sky
 * value. The spread is derived from the distance between the 5th and the
 * 20th percentile, which for a normal distribution equals 0.807 σ: it
 * depends only on the darkest pixels, that is on the sky, and includes
 * both the noise and the slight variations of the background (gradients,
 * residuals), which must be protected as well.
 */
function backgroundAndNoise(plane) {
  const step = Math.max(1, Math.floor(plane.length / 300000))
  const values = []
  for (let i = 0; i < plane.length; i += step) values.push(plane[i])
  values.sort((a, b) => a - b)
  const p5 = values[Math.floor(0.05 * values.length)]
  const p20 = values[Math.floor(0.2 * values.length)]
  return { background: p20, sigma: (p20 - p5) / 0.807 }
}

export function processImage(image, params, context) {
  const { width, height, channels, data } = image
  const n = width * height
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  const inverseMidtones = 1 - midtones
  const stretch = (v) => mtf(Math.min(1, Math.max(0, (v - black) / range)), midtones)
  const unstretch = (y) => black + range * mtf(y, inverseMidtones)
  const channelStart = (c) => (channels === 3 ? c * n : 0)
  const r0 = channelStart(0)
  const g0 = channelStart(1)
  const b0 = channelStart(2)

  // 1. Luma as it appears on screen.
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    luma[i] = WEIGHTS[0] * stretch(data[r0 + i]) + WEIGHTS[1] * stretch(data[g0 + i]) + WEIGHTS[2] * stretch(data[b0 + i])
  }

  // 2. Sky background and noise.
  const { background } = backgroundAndNoise(luma)
  const scale = Math.max(1e-6, 1 - background)

  // 5. Blurred copy of the luma (three passes of a moving average of radius
  // 2, almost a Gaussian with σ ≈ 2.5 pixels): used for the background
  // protection and to recognize the stars (point 7).
  const blurred = Float32Array.from(luma)
  {
    const t = new Float32Array(n)
    for (let k = 0; k < 3; k++) {
      boxFilter(blurred, t, width, height, 2, width, 1)
      boxFilter(t, blurred, height, width, 2, 1, width)
    }
  }
  let mask = null
  let start = 0
  let end = 1
  if (params.protectBackground) {
    mask = blurred
    // Thresholds on the spread of the blurred copy, much smaller than that
    // of single pixels: this way the tint also reaches the faint parts.
    const estimate = backgroundAndNoise(mask)
    start = estimate.background + 3 * estimate.sigma
    end = start + Math.max(0.015, 4 * estimate.sigma)
  }

  // 3. Transition point: halfway between background and white, moved by the balance.
  const center = 0.5 + 0.35 * params.balance
  const dShadows = direction(params.shadowHue).map((v) => v * params.shadowSaturation)
  const dHighlights = direction(params.highlightHue).map((v) => v * params.highlightSaturation)

  const output = new Float32Array(3 * n)
  const rgb = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const protection = mask ? smoothstep(start, end, mask[i]) : 1
    if (protection === 0) {
      // Protected background: the pixel stays identical.
      output[i] = data[r0 + i]
      output[n + i] = data[g0 + i]
      output[2 * n + i] = data[b0 + i]
      continue
    }
    const y = luma[i]
    rgb[0] = stretch(data[r0 + i])
    rgb[1] = stretch(data[g0 + i])
    rgb[2] = stretch(data[b0 + i])
    const u = (y - background) / scale
    const highlight = smoothstep(center - 0.3, center + 0.3, u)
    // 7. Stars stand out sharply from the blurred copy: they do not receive
    // the shadow tint, which would make them look colored.
    const pointLike = smoothstep(0.03, 0.1, y - blurred[i])
    // 4. Shift with zero luma, null on black and on white.
    const strength = y * Math.pow(1 - y, 1.5) * protection
    let k = 1
    const shift = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      shift[c] = strength * ((1 - highlight) * (1 - pointLike) * dShadows[c] + highlight * dHighlights[c])
      // Shortens the shift if the channel would leave [0, 1].
      const v = rgb[c] + shift[c]
      if (v > 1) k = Math.min(k, (1 - rgb[c]) / shift[c])
      else if (v < 0) k = Math.min(k, -rgb[c] / shift[c])
    }
    for (let c = 0; c < 3; c++) output[c * n + i] = unstretch(rgb[c] + k * shift[c])
  }
  return { width, height, channels: 3, data: output }
}
