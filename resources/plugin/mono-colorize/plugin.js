/*
 * Colorize monochrome images. StarLight plugin. MIT license,
 * FM Digital Tools.
 *
 * A shot taken with a narrowband filter, or with a monochrome camera,
 * contains only brightness. This plugin gives it a tint without changing
 * how light or dark each pixel looks.
 *
 * The method:
 *   1. the work is done on the image as it appears on screen (stretched as
 *      the viewer stretches it), because that is where brightness is judged;
 *   2. the brightness of a pixel is its luma Y = 0.2126 R + 0.7152 G +
 *      0.0722 B (weights of recommendation ITU-R BT.709, the same as the
 *      sRGB standard); a color image is reduced to this value;
 *   3. the tint T = (Tr, Tg, Tb) has its own luma Y(T). The vector
 *      D = T / Y(T) − (1, 1, 1) has zero luma: adding any amount s·y·D to a
 *      gray y changes the color but not the luma. The pixel therefore
 *      becomes y·(1 + s·D), with s the chosen saturation;
 *   4. in the bright areas the pure tint cannot always reach the required
 *      brightness (a pure blue cannot be as light as a white): one channel
 *      would exceed the maximum. For this reason s is reduced, pixel by
 *      pixel, with a soft minimum between s and the limit beyond which a
 *      channel would exceed the maximum, s·l / √(s² + l²): far from the
 *      limit the tint stays full, closer to it the saturation drops
 *      gradually and the dominant channel does not flatten at the maximum.
 *      Bright areas and stars fade toward pink and white and the luma stays
 *      exact;
 *   5. the result is brought back to the linear data with the inverse
 *      stretch, so the viewer shows exactly the computed colors.
 *
 * The tints of the emission lines are derived as follows: the CIE 1931
 * color coordinates of the line's wavelength (matching functions in the
 * analytic approximation by C. Wyman, P.-P. Sloan, P. Shirley, “Simple
 * Analytic Approximations to the CIE XYZ Color Matching Functions”,
 * JCGT 2(2), 2013) are converted to linear sRGB. A spectral color is purer
 * than any color a screen can show and has some negative component: it is
 * set to zero, which gives the most saturated color the screen can show on
 * the same side of the gamut. The three channels are scaled to a maximum
 * of 1 and the sRGB encoding is applied, because the work is done on the
 * image as it appears on screen. The red lines of sulfur (SII, 672 nm) and
 * nitrogen (NII, 658 nm) give the same red as H-alpha: the same tint
 * applies to those shots.
 */

/** Tints of the emission lines (encoded sRGB, maximum 1), computed as explained above. */
const LINES = {
  hAlpha: [1, 0, 0], // hydrogen, 656.3 nm (also SII and NII)
  hBeta: [0, 0.758, 1], // hydrogen, 486.1 nm
  oIII: [0, 1, 0.604] // doubly ionized oxygen, 500.7 nm
}

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

export function processImage(image, params, context) {
  const { width, height, channels, data } = image
  const n = width * height
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  const inverseMidtones = 1 - midtones
  const stretch = (v) => mtf(Math.min(1, Math.max(0, (v - black) / range)), midtones)
  const unstretch = (y) => black + range * mtf(y, inverseMidtones)

  const tint = params.tint === 'custom' ? fromHue(params.customHue) : LINES[params.tint] || LINES.hAlpha
  const tintLuma = WEIGHTS[0] * tint[0] + WEIGHTS[1] * tint[1] + WEIGHTS[2] * tint[2]
  // Color direction with zero luma (point 3).
  const d = tint.map((t) => t / tintLuma - 1)
  const s = params.saturation
  // For point 4 only the channels that the tint pushes above gray matter.
  const dMax = Math.max(d[0], d[1], d[2])

  const output = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    let y
    if (channels === 3) {
      y = WEIGHTS[0] * stretch(data[i]) + WEIGHTS[1] * stretch(data[n + i]) + WEIGHTS[2] * stretch(data[2 * n + i])
    } else {
      y = stretch(data[i])
    }
    let sp = s
    if (dMax > 0 && y > 0) {
      // y·(1 + sp·dMax) ≤ 1  ⇒  sp ≤ (1 − y) / (y·dMax). The limit is
      // approached with a soft minimum, not a cut: the dominant channel
      // keeps growing with brightness and the structures of the bright
      // areas stay readable.
      const limit = (1 - y) / (y * dMax)
      sp = (s * limit) / Math.sqrt(s * s + limit * limit)
    }
    for (let c = 0; c < 3; c++) {
      const v = y * (1 + sp * d[c])
      output[c * n + i] = unstretch(v < 0 ? 0 : v > 1 ? 1 : v)
    }
  }
  return { width, height, channels: 3, data: output }
}
