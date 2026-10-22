/*
 * Orton effect. StarLight plugin. MIT license, FM Digital Tools.
 *
 * The photographer Michael Orton overlaid two slides of the same scene,
 * one sharp and one blurred and overexposed: the result was a soft, almost
 * painterly glow, with the outlines still readable. The same is done here:
 * a brightened copy is blurred and blended with the original in “screen”
 * mode, which brightens without ever darkening.
 *
 * The glow is computed on the image as it appears on screen (stretched as
 * the viewer stretches it) and then brought back to the linear data,
 * because that is where the eye judges its softness.
 */

function mtf(x, m) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

/**
 * Box blur along rows and columns, repeated three times: the result is
 * almost identical to a Gaussian blur and the cost does not depend on the
 * radius, so even a very wide glow stays fast.
 */
function blur(plane, w, h, radius) {
  // Three passes of radius r are equivalent to a Gaussian with sigma about r.
  const r = Math.max(1, Math.round(radius / 1.7))
  const a = Float32Array.from(plane)
  const t = new Float32Array(plane.length)
  for (let pass = 0; pass < 3; pass++) {
    boxFilter(a, t, w, h, r, w, 1) // along the rows
    boxFilter(t, a, h, w, r, 1, w) // along the columns
  }
  return a
}

/** Moving average along one direction: `step` between neighboring samples, `stride` between one line and the next. */
function boxFilter(from, to, length, lines, r, stride, step) {
  const windowSize = 2 * r + 1
  for (let l = 0; l < lines; l++) {
    const start = l * stride
    const v = (i) => from[start + Math.min(length - 1, Math.max(0, i)) * step]
    let sum = 0
    for (let i = -r; i <= r; i++) sum += v(i)
    for (let i = 0; i < length; i++) {
      to[start + i * step] = sum / windowSize
      sum += v(i + r + 1) - v(i - r)
    }
  }
}

export function processImage(image, params, context) {
  const { width, height, channels, data } = image
  const n = width * height
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  const strength = params.strength
  const radius = params.radius
  const brightening = params.brightening

  const output = new Float32Array(data.length)
  for (let c = 0; c < channels; c++) {
    const visible = new Float32Array(n)
    const bright = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const y = mtf(Math.min(1, Math.max(0, (data[c * n + i] - black) / range)), midtones)
      visible[i] = y
      // Overexposed copy: the “screen” blend with itself, dosed.
      bright[i] = y + (1 - (1 - y) * (1 - y) - y) * brightening
    }
    const glow = blur(bright, width, height, radius)
    for (let i = 0; i < n; i++) {
      const y = visible[i]
      const blended = 1 - (1 - y) * (1 - glow[i])
      const final = y + (blended - y) * strength
      output[c * n + i] = black + range * mtf(final, 1 - midtones)
    }
  }
  return { width, height, channels, data: output }
}
