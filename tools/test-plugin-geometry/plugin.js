/*
 * Test plugin for the checks (not bundled with the app). MIT license,
 * FM Digital Tools.
 *
 * It is the "Rotate and mirror" plugin, which is not part of the gallery
 * (rotation and mirror are buttons of the top bar). It stays here as an
 * example of a plugin that moves pixels and declares
 * "geometry": "transformed": the checks (test-geometry,
 * test-framing-geometry) use it to verify that the astrometric solution,
 * the markers and the crop follow the matrix returned by any plugin.
 *
 * It turns the image a quarter turn at a time and flips it. These are pixel
 * moves only: no value is recomputed, so the quality stays identical. The
 * mirror is applied first, then the rotation.
 *
 * Next to the image the plugin returns the exact transformation it applied,
 * so StarLight moves the astrometric solution in the same way and the
 * object markers stay in place.
 */

/*
 * 2x3 affine matrix [[a, b, c], [d, e, f]]: pixel (x, y) of the received
 * image ends up at (a·x + b·y + c, d·x + e·y + f) in the returned one.
 * Coordinates are those of the pixel centers, counted from 0 at the top
 * left (the same index y·width + x as the data).
 */
function compose(first, second) {
  const [[a, b, c], [d, e, f]] = second
  const [[p, q, r], [s, t, u]] = first
  return [
    [a * p + b * s, a * q + b * t, a * r + b * u + c],
    [d * p + e * s, d * q + e * t, d * r + e * u + f]
  ]
}

/** The transformation applied: first the mirror, then the rotation. */
function transformation(w, h, quarters, horizontal, vertical) {
  let m = [[1, 0, 0], [0, 1, 0]]
  if (horizontal) m = compose(m, [[-1, 0, w - 1], [0, 1, 0]])
  if (vertical) m = compose(m, [[1, 0, 0], [0, -1, h - 1]])
  const rotation = [
    [[1, 0, 0], [0, 1, 0]],
    [[0, -1, h - 1], [1, 0, 0]],
    [[-1, 0, w - 1], [0, -1, h - 1]],
    [[0, 1, 0], [-1, 0, w - 1]]
  ][quarters]
  return compose(m, rotation)
}

export function processImage(image, params) {
  const { width: w, height: h, channels, data } = image
  const quarters = { none: 0, clockwise: 1, half: 2, counterclockwise: 3 }[params.rotation] ?? 0
  const horizontal = params.mirrorHorizontal === true
  const vertical = params.mirrorVertical === true
  const matrix = transformation(w, h, quarters, horizontal, vertical)
  if (quarters === 0 && !horizontal && !vertical) return { ...image, transform: matrix }

  // With a quarter turn width and height are swapped.
  const outWidth = quarters % 2 === 1 ? h : w
  const outHeight = quarters % 2 === 1 ? w : h
  const n = w * h
  const output = new Float32Array(data.length)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Mirror on the source pixel.
      const sx = horizontal ? w - 1 - x : x
      const sy = vertical ? h - 1 - y : y
      // Rotation towards the destination.
      let dx
      let dy
      if (quarters === 0) {
        dx = x
        dy = y
      } else if (quarters === 1) {
        dx = h - 1 - y
        dy = x
      } else if (quarters === 2) {
        dx = w - 1 - x
        dy = h - 1 - y
      } else {
        dx = y
        dy = w - 1 - x
      }
      const from = sy * w + sx
      const to = dy * outWidth + dx
      for (let c = 0; c < channels; c++) output[c * n + to] = data[c * n + from]
    }
  }
  return { width: outWidth, height: outHeight, channels, data: output, transform: matrix }
}
