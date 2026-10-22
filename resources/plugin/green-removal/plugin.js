/*
 * Green removal (SCNR, Subtractive Chromatic Noise Reduction).
 * StarLight plugin. MIT license, FM Digital Tools.
 *
 * In astrophotography almost no deep-sky object is really green: a green
 * cast comes from the sensor (which has twice as many green pixels), from
 * the light pollution filter or from an imperfect calibration. SCNR lowers
 * green where it exceeds a reference derived from red and blue, and leaves
 * everything else alone.
 *
 * - “Neutral average”: the reference is the average of red and blue. It is
 *   the gentlest method and the one usually recommended.
 * - “Neutral maximum”: the reference is the higher of red and blue. It
 *   removes less green, useful when the cast is mild.
 *
 * Works on the linear data: the result does not depend on the stretch.
 */

export function processImage(image, params) {
  const { width, height, channels, data } = image
  // A black and white image has no green to remove.
  if (channels !== 3) return image

  const n = width * height
  const amount = params.amount
  const maximum = params.method === 'maximum'
  const preserveLuminance = params.preserveLuminance === true

  const output = new Float32Array(data)
  for (let i = 0; i < n; i++) {
    const r = data[i]
    const g = data[n + i]
    const b = data[2 * n + i]
    const reference = maximum ? Math.max(r, b) : (r + b) / 2
    if (g <= reference) continue
    const newGreen = g + (reference - g) * amount
    output[n + i] = newGreen
    if (preserveLuminance) {
      // Gives back to the pixel the brightness lost by removing green,
      // spreading it proportionally over all three channels.
      const before = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const after = 0.2126 * r + 0.7152 * newGreen + 0.0722 * b
      if (after > 1e-9) {
        const k = Math.min(4, before / after)
        output[i] = r * k
        output[n + i] = newGreen * k
        output[2 * n + i] = b * k
      }
    }
  }
  return { width, height, channels, data: output }
}
