/*
 * HDR, recovery of the bright areas. StarLight plugin. MIT license,
 * FM Digital Tools.
 *
 * In images with a very wide brightness range, the stretch that makes the
 * faint parts visible pushes the brightest parts to white: the detail is
 * in the data, but it is lost on screen. This plugin compresses the range
 * only in the bright areas and restores the fine detail, leaving the faint
 * parts unchanged.
 *
 * The method is the classic separation between “base” and “detail” of
 * dynamic range compression (local tone mapping), on the logarithm of the
 * luminance, where detail counts in proportion and not in absolute value:
 *   1. the logarithm of the linear luminance is computed;
 *   2. the base, that is the large-scale trend of the brightness, is
 *      obtained with a guided filter (He, Sun, Tang, “Guided Image
 *      Filtering”, ECCV 2010), which smooths without crossing sharp edges:
 *      this way no dark halos form around the compressed areas;
 *   3. the detail is the difference between the logarithm and the base;
 *   4. the base is compressed above the threshold, so that the brightest
 *      structures end up just below the white of the stretch; the detail is
 *      kept or strengthened, and the two parts are recombined;
 *   5. the ratio between the new and the original luminance is applied to
 *      the linear data of the three channels: colors keep their
 *      proportions.
 * Below the threshold the data stay identical.
 *
 * The plugin cannot recreate information that is not there: if an area is
 * saturated in every frame, where all values are at the maximum it stays a
 * uniform area. In that case a series of short exposures must be merged.
 */

/** Midtones transfer function, the same as the viewer's. */
function mtf(x, m) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

/**
 * Mean over a square window of side 2r+1, along rows and columns: the
 * cost does not depend on the radius.
 */
function boxMean(plane, w, h, r) {
  const t = new Float32Array(plane.length)
  const a = new Float32Array(plane.length)
  boxFilter(plane, t, w, h, r, w, 1)
  boxFilter(t, a, h, w, r, 1, w)
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

/**
 * Guided filter with the image itself as the guide. Where the local
 * variance is small compared with `eps` (uniform areas) the result is the
 * mean; where it is large (a sharp edge, a star) it follows the image.
 * This is what avoids halos around the compressed areas.
 */
function guidedFilter(p, w, h, r, eps) {
  const n = p.length
  const squares = new Float32Array(n)
  for (let i = 0; i < n; i++) squares[i] = p[i] * p[i]
  const meanP = boxMean(p, w, h, r)
  const meanSq = boxMean(squares, w, h, r)
  const a = new Float32Array(n)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const variance = Math.max(0, meanSq[i] - meanP[i] * meanP[i])
    a[i] = variance / (variance + eps)
    b[i] = meanP[i] - a[i] * meanP[i]
  }
  const meanA = boxMean(a, w, h, r)
  const meanB = boxMean(b, w, h, r)
  const q = new Float32Array(n)
  for (let i = 0; i < n; i++) q[i] = meanA[i] * p[i] + meanB[i]
  return q
}

/** Smooth transition from 0 to 1 between a and b. */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Value below which the fraction `fraction` of the values lies (estimated on a sample). */
function percentile(values, fraction) {
  if (values.length === 0) return 0
  const step = Math.max(1, Math.floor(values.length / 200000))
  const sample = []
  for (let i = 0; i < values.length; i += step) sample.push(values[i])
  sample.sort((a, b) => a - b)
  return sample[Math.min(sample.length - 1, Math.floor(fraction * sample.length))]
}

export function processImage(image, params, context) {
  const { width, height, channels, data } = image
  const n = width * height
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  // From screen to linear data: the inverse midtones function.
  const linearOf = (screen) => black + range * mtf(screen, 1 - midtones)
  const minimum = black + 1e-3 * range
  const boost = 1 + 2 * params.detail
  const radius = Math.max(2, Math.round(params.structureSize))

  // 1. Linear luminance and its logarithm.
  const linear = new Float32Array(n)
  const logarithm = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let l = data[i]
    if (channels === 3) l = 0.2126 * data[i] + 0.7152 * data[n + i] + 0.0722 * data[2 * n + i]
    linear[i] = l
    logarithm[i] = Math.log(Math.max(minimum, l))
  }

  // 2. and 3. Large-scale base; the detail is the difference.
  // Tolerance of the order of a factor of one and a half in brightness:
  // smaller jumps are detail to keep, larger ones (the edge of a bright
  // core) belong to the base and are compressed.
  const base = guidedFilter(logarithm, width, height, radius, 0.2)

  // 4. How much to compress: the threshold and the ceiling as they appear
  //    on screen, taken to logarithmic scale. The brightest structures are
  //    always brought below white; the strength decides how much lower,
  //    where the stretch is less steep and the detail is easier to see. The
  //    reference point is a high percentile of the base, so that a few
  //    bright stars do not decide on their own the compression of the whole
  //    area.
  const threshold = Math.log(Math.max(minimum, linearOf(params.threshold)))
  const ceilingScreen = Math.max(params.threshold + 0.03, 0.95 - 0.6 * params.strength)
  const ceiling = Math.log(Math.max(minimum, linearOf(ceilingScreen)))
  const above = []
  for (let i = 0; i < n; i++) if (base[i] > threshold) above.push(base[i])
  const maximum = percentile(above, 0.995)
  const factor = maximum > ceiling && maximum > threshold ? (ceiling - threshold) / (maximum - threshold) : 1

  const output = new Float32Array(data.length)
  for (let i = 0; i < n; i++) {
    const b = base[i]
    const weight = smoothstep(threshold - 0.15, threshold + 0.15, b)
    if (weight === 0) {
      for (let c = 0; c < channels; c++) output[c * n + i] = data[c * n + i]
      continue
    }
    const newBase = b > threshold ? threshold + (b - threshold) * factor : b
    const detail = (logarithm[i] - b) * (1 + (boost - 1) * weight)
    // In the bright areas the result never exceeds the original: the
    // detail boost must not burn out what is being recovered.
    const newLinear = Math.exp(Math.min(logarithm[i], newBase + detail))
    // 5. The ratio on the three channels, full above the threshold and gradual around it.
    const ratio = 1 + (newLinear / Math.max(minimum, linear[i]) - 1) * weight
    for (let c = 0; c < channels; c++) output[c * n + i] = data[c * n + i] * ratio
  }
  return { width, height, channels, data: output }
}
