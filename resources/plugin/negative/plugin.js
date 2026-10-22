/*
 * Negative. StarLight plugin. MIT license, FM Digital Tools.
 *
 * Inverts the light of the image: the black sky becomes light and the
 * stars become dark dots. Many observers look for the faintest details of
 * a nebula this way, because the eye distinguishes dark shades on a light
 * background better.
 *
 * The inversion is done on the image as it appears on screen: the data are
 * stretched as the viewer stretches them, inverted, and brought back to
 * linear form with the inverse stretch. So, as long as the stretch in the
 * Correct step is not changed, the viewer shows the exact negative of what
 * was visible before.
 */

/** Midtones transfer function, the same as the viewer's. With m and 1 - m it is its own inverse. */
function mtf(x, m) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

export function processImage(image, params, context) {
  const { width, height, channels, data } = image
  const n = width * height
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  const stretch = (v) => mtf(Math.min(1, Math.max(0, (v - black) / range)), midtones)
  const unstretch = (y) => black + range * mtf(y, 1 - midtones)
  const luminanceOnly = params.mode === 'luminance' && channels === 3

  const output = new Float32Array(data.length)
  if (!luminanceOnly) {
    // Each channel on its own: the colors become their complements.
    for (let i = 0; i < data.length; i++) output[i] = unstretch(1 - stretch(data[i]))
    return { width, height, channels, data: output }
  }

  // Light only: the brightness is inverted and the hue is kept, so a red
  // nebula stays red on a light background.
  for (let i = 0; i < n; i++) {
    const r = stretch(data[i])
    const g = stretch(data[n + i])
    const b = stretch(data[2 * n + i])
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const inverted = 1 - luma
    if (luma < 1e-6) {
      output[i] = output[n + i] = output[2 * n + i] = unstretch(inverted)
      continue
    }
    // The light is shifted by adding the same amount to the three channels:
    // with a ratio, the black background, almost without light, would give
    // huge values.
    const d = inverted - luma
    output[i] = unstretch(Math.min(1, Math.max(0, r + d)))
    output[n + i] = unstretch(Math.min(1, Math.max(0, g + d)))
    output[2 * n + i] = unstretch(Math.min(1, Math.max(0, b + d)))
  }
  return { width, height, channels, data: output }
}
