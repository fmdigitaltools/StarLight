/*
 * Black and white by channel. StarLight plugin. MIT license,
 * FM Digital Tools.
 *
 * Turns the image into black and white by deciding how much each color
 * counts, like the colored filters in front of the lens in film
 * photography: more weight on red brightens emission nebulae (hydrogen
 * glows red) and darkens the sky; more weight on blue brings out
 * reflection nebulae and young stars.
 *
 * The computation is a weighted sum of the three channels on the linear
 * data, so it matches what a real filter on the sensor would do. The
 * result stays an image with three equal channels, so all the other tools
 * keep working.
 */

export function processImage(image, params) {
  const { width, height, channels, data } = image
  if (channels !== 3) return image
  const n = width * height

  let wr = params.red
  let wg = params.green
  let wb = params.blue
  const sum = wr + wg + wb
  if (sum <= 1e-6) {
    // All weights at zero: a black image is of no use to anyone, so fall
    // back to equal weights.
    wr = wg = wb = 1 / 3
  } else if (params.normalize) {
    // Weights scaled to sum to one: the overall brightness does not change
    // when the sliders move, only the contribution of the colors does.
    wr /= sum
    wg /= sum
    wb /= sum
  }

  const output = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, wr * data[i] + wg * data[n + i] + wb * data[2 * n + i])
    output[i] = v
    output[n + i] = v
    output[2 * n + i] = v
  }
  return { width, height, channels: 3, data: output }
}
