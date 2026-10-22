/**
 * Geometry of the processed image: how the pixels have been moved.
 *
 * Almost all tools change pixel values but leave the pixels in place. Some
 * plugins move them instead (rotate, mirror): the file's astrometric
 * solution then no longer describes the displayed image, and markers and
 * FITS export would be wrong. For this reason a plugin that moves pixels
 * declares the transformation it applied, and the chain keeps it aside and
 * composes it with those of the other plugins.
 *
 * The transformation is a 2x3 affine matrix in pixels, from the coordinates
 * of the image the plugin receives to those of the image it returns:
 *
 *   x' = m[0][0]·x + m[0][1]·y + m[0][2]
 *   y' = m[1][0]·x + m[1][1]·y + m[1][2]
 *
 * with (0, 0) at the center of the top-left pixel, x to the right and y
 * downward: the same way a plugin walks through the data
 * (index = y·width + x). For example a clockwise quarter turn of an image of
 * height h is [[0, -1, h - 1], [1, 0, 0]].
 */

export type AffineMatrix = [[number, number, number], [number, number, number]]

/**
 * Geometry accumulated from the starting image (the one processing starts
 * from) to the displayed image.
 *
 * - `unchanged`: no pixel has moved;
 * - `transformed`: the transformation and the sizes before and after are
 *   known exactly;
 * - `unknown`: some plugin moved the pixels without being able to say how;
 *   the astrometric solution is no longer valid and must be dropped.
 */
export type AppliedGeometry =
  | { type: 'unchanged' }
  | {
      type: 'transformed'
      matrix: AffineMatrix
      input: { width: number; height: number }
      output: { width: number; height: number }
    }
  | { type: 'unknown' }

export const GEOMETRY_UNCHANGED: AppliedGeometry = { type: 'unchanged' }
export const GEOMETRY_UNKNOWN: AppliedGeometry = { type: 'unknown' }

type Planes = { width: number; height: number; channels: 1 | 3; data: Float32Array }

/** Weight of the Keys cubic convolution (a = -0.5), the classic bicubic. */
function cubicWeight(t: number): number {
  const x = Math.abs(t)
  if (x <= 1) return 1.5 * x * x * x - 2.5 * x * x + 1
  if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2
  return 0
}

/**
 * Rotates an image by any angle, in degrees clockwise (negative:
 * counterclockwise), around its center. The canvas grows as needed to
 * contain the whole rotated image: no pixel is lost, and the uncovered
 * corners take the per-channel `fill` value (usually the sky background, so
 * no black triangles appear). Values are read with bicubic interpolation,
 * clamped between the four nearest pixels to avoid halos around stars.
 *
 * The geometry step is exact: markers, masks, crop and the astrometric
 * solution follow the rotation just as they follow quarter turns.
 */
export function rotateByAngle(
  image: Planes,
  degrees: number,
  padding: number[] = [0, 0, 0]
): { image: Planes; step: AppliedGeometry } {
  const a = Number.isFinite(degrees) ? degrees : 0
  if (Math.abs(a) < 1e-6) return { image, step: GEOMETRY_UNCHANGED }
  const { width: w, height: h, channels } = image
  const t = (a * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  const nw = Math.max(1, Math.ceil(Math.abs(w * c) + Math.abs(h * s) - 1e-6))
  const nh = Math.max(1, Math.ceil(Math.abs(w * s) + Math.abs(h * c) - 1e-6))
  // Pixel centers counted from 0: the image center is (w-1)/2.
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const ncx = (nw - 1) / 2
  const ncy = (nh - 1) / 2
  // With y downward, a clockwise rotation by t takes (dx, dy) to
  // (c·dx − s·dy, s·dx + c·dy).
  const matrix: AffineMatrix = [
    [c, -s, ncx - c * cx + s * cy],
    [s, c, ncy - s * cx - c * cy]
  ]
  const n = w * h
  const nn = nw * nh
  const data = new Float32Array(nn * channels)
  const weightsX = new Float64Array(4)
  const weightsY = new Float64Array(4)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // Inverse transformation: where it falls in the original.
      const dx = x - ncx
      const dy = y - ncy
      const sx = c * dx + s * dy + cx
      const sy = -s * dx + c * dy + cy
      const k = y * nw + x
      if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) {
        for (let ch = 0; ch < channels; ch++) data[ch * nn + k] = padding[ch] ?? 0
        continue
      }
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const fx = sx - x0
      const fy = sy - y0
      for (let i = 0; i < 4; i++) {
        weightsX[i] = cubicWeight(fx - (i - 1))
        weightsY[i] = cubicWeight(fy - (i - 1))
      }
      for (let ch = 0; ch < channels; ch++) {
        const base = ch * n
        let sum = 0
        let minimum = Infinity
        let max = -Infinity
        for (let j = 0; j < 4; j++) {
          const yy = Math.min(h - 1, Math.max(0, y0 - 1 + j))
          let row = 0
          for (let i = 0; i < 4; i++) {
            const xx = Math.min(w - 1, Math.max(0, x0 - 1 + i))
            const v = image.data[base + yy * w + xx]
            row += v * weightsX[i]
            // The four nearest pixels act as limits.
            if ((i === 1 || i === 2) && (j === 1 || j === 2)) {
              if (v < minimum) minimum = v
              if (v > max) max = v
            }
          }
          sum += row * weightsY[j]
        }
        data[ch * nn + k] = sum < minimum ? minimum : sum > max ? max : sum
      }
    }
  }
  return {
    image: { width: nw, height: nh, channels, data: data },
    step: { type: 'transformed', matrix, input: { width: w, height: h }, output: { width: nw, height: nh } }
  }
}

/**
 * The largest axis-aligned rectangle that fits entirely inside a w × h image
 * rotated by `degrees`: the one that removes the uncovered corners. In
 * fractions of the rotated canvas (like the crop).
 */
export function borderlessRectangle(
  w: number,
  h: number,
  degrees: number
): { x: number; y: number; width: number; height: number } {
  const t = Math.abs(((degrees % 180) + 180) % 180)
  const angle = ((t > 90 ? 180 - t : t) * Math.PI) / 180
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const nw = Math.abs(w * c) + Math.abs(h * s)
  const nh = Math.abs(w * s) + Math.abs(h * c)
  // Classic solution for the maximum-area rectangle inscribed in a rotated
  // rectangle (long side L, short side S).
  const long = Math.max(w, h)
  const shortValue = Math.min(w, h)
  let rw: number
  let rh: number
  if (shortValue <= 2 * s * c * long || Math.abs(s - c) < 1e-10) {
    const meta = 0.5 * shortValue
    const sides = [meta / s, meta / c]
    ;[rw, rh] = w >= h ? sides : [sides[1], sides[0]]
  } else {
    const cos2 = c * c - s * s
    rw = (w * c - h * s) / cos2
    rh = (h * c - w * s) / cos2
  }
  rw = Math.max(1, Math.min(nw, rw))
  rh = Math.max(1, Math.min(nh, rh))
  return { x: (nw - rw) / 2 / nw, y: (nh - rh) / 2 / nh, width: rw / nw, height: rh / nh }
}

/**
 * Rotates an image by `quarters` clockwise quarter turns (negative:
 * counterclockwise) and also returns the geometry step, so the astrometric
 * solution, markers, masks and crop follow it just as they follow plugins
 * that move pixels. A quarter-turn rotation moves pixels without
 * interpolating: no value changes.
 */
export function rotateQuarters(
  image: { width: number; height: number; channels: 1 | 3; data: Float32Array },
  quarters: number
): { image: { width: number; height: number; channels: 1 | 3; data: Float32Array }; step: AppliedGeometry } {
  // A missing or non-numeric value counts as no rotation.
  const q = Number.isFinite(quarters) ? ((Math.round(quarters) % 4) + 4) % 4 : 0
  if (q === 0) return { image, step: GEOMETRY_UNCHANGED }
  const { width: w, height: h, channels } = image
  const nw = q === 2 ? w : h
  const nh = q === 2 ? h : w
  // From (x, y) of the starting image to (x', y') of the rotated one.
  const matrix: AffineMatrix =
    q === 1
      ? [
          [0, -1, h - 1],
          [1, 0, 0]
        ]
      : q === 2
        ? [
            [-1, 0, w - 1],
            [0, -1, h - 1]
          ]
        : [
            [0, 1, 0],
            [-1, 0, w - 1]
          ]
  const n = w * h
  const data = new Float32Array(image.data.length)
  for (let c = 0; c < channels; c++) {
    const from = c * n
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2]
        const ny = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]
        data[from + ny * nw + nx] = image.data[from + y * w + x]
      }
    }
  }
  return {
    image: { width: nw, height: nh, channels, data: data },
    step: {
      type: 'transformed',
      matrix,
      input: { width: w, height: h },
      output: { width: nw, height: nh }
    }
  }
}

/**
 * Mirrors an image left to right (`horizontal`) or top to bottom
 * (`vertical`) and also returns the geometry step, like `rotateQuarters`.
 * It moves pixels without interpolating: no value changes. The matrix has
 * determinant -1: the astrometric solution that follows it changes parity,
 * that is, north and east no longer turn in the same direction.
 */
export function mirror(
  image: { width: number; height: number; channels: 1 | 3; data: Float32Array },
  direction: 'horizontal' | 'vertical'
): { image: { width: number; height: number; channels: 1 | 3; data: Float32Array }; step: AppliedGeometry } {
  const { width: w, height: h, channels } = image
  const horizontal = direction === 'horizontal'
  const matrix: AffineMatrix = horizontal
    ? [
        [-1, 0, w - 1],
        [0, 1, 0]
      ]
    : [
        [1, 0, 0],
        [0, -1, h - 1]
      ]
  const n = w * h
  const data = new Float32Array(image.data.length)
  for (let c = 0; c < channels; c++) {
    const base = c * n
    for (let y = 0; y < h; y++) {
      const from = base + y * w
      if (horizontal) {
        for (let x = 0; x < w; x++) data[from + w - 1 - x] = image.data[from + x]
      } else {
        data.set(image.data.subarray(from, from + w), base + (h - 1 - y) * w)
      }
    }
  }
  return {
    image: { width: w, height: h, channels, data: data },
    step: { type: 'transformed', matrix, input: { width: w, height: h }, output: { width: w, height: h } }
  }
}

/*
 * Orientation requested with the toolbar buttons (Mirror, rotate left/right,
 * Straighten). Every processing run restarts from the starting image and
 * reapplies it at the end, after the plugins, always in this canonical order:
 *
 *   1. left-to-right mirror, if `mirrored`;
 *   2. `quarters` clockwise quarter turns;
 *   3. free rotation by `degrees` clockwise (Straighten).
 *
 * The top-to-bottom mirror has no field of its own: it is the left-to-right
 * mirror followed by a half turn. Every combination of mirrors and quarter
 * turns therefore has a single representation (eight in all).
 *
 * The buttons act on the image as it is seen, that is, after all three
 * steps: `mirrorOrientation` says how the three values change so that the
 * canonical order gives the same result as a mirror done last. A mirror
 * reverses the direction of the rotations that precede it: if S is the
 * horizontal mirror and R(a) a rotation, S·R(a) = R(-a)·S, and the vertical
 * mirror is R(180°)·S.
 */
export interface Orientation {
  mirrored: boolean
  /** From 0 to 3. */
  quarters: number
  degrees: number
}

/** The orientation after a mirror applied to the image as it is seen. */
export function mirrorOrientation(o: Orientation, direction: 'horizontal' | 'vertical'): Orientation {
  const q = Number.isFinite(o.quarters) ? Math.round(o.quarters) : 0
  const quarters = direction === 'horizontal' ? -q : 2 - q
  const degrees = Number.isFinite(o.degrees) && Math.abs(o.degrees) >= 1e-6 ? -o.degrees : 0
  return { mirrored: !o.mirrored, quarters: ((quarters % 4) + 4) % 4, degrees }
}

/**
 * Applies the first two steps of the canonical order (mirror, then quarter
 * turns), without interpolating. The third, the free rotation, lives in
 * hooks/straighten.ts because it looks up the sky background for the
 * uncovered corners.
 */
export function orientQuarters(
  image: { width: number; height: number; channels: 1 | 3; data: Float32Array },
  mirrored: boolean,
  quarters: number
): { image: { width: number; height: number; channels: 1 | 3; data: Float32Array }; step: AppliedGeometry } {
  const s = mirrored ? mirror(image, 'horizontal') : { image, step: GEOMETRY_UNCHANGED }
  const r = rotateQuarters(s.image, quarters)
  return { image: r.image, step: composeGeometry(s.step, r.step) }
}

export const IDENTITY_MATRIX: AffineMatrix = [
  [1, 0, 0],
  [0, 1, 0]
]

/** Maps a point (pixel-center coordinates, from 0) into the transformed image. */
export function applyAffine(m: AffineMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0][0] * x + m[0][1] * y + m[0][2], y: m[1][0] * x + m[1][1] * y + m[1][2] }
}

/** First `before`, then `after`: the transformation that performs both in sequence. */
export function composeAffines(before: AffineMatrix, after: AffineMatrix): AffineMatrix {
  const [[a, b, c], [d, e, f]] = after
  const [[p, q, r], [s, t, u]] = before
  return [
    [a * p + b * s, a * q + b * t, a * r + b * u + c],
    [d * p + e * s, d * q + e * t, d * r + e * u + f]
  ]
}

/** Determinant of the linear part: zero means the image has been flattened. */
export function affineDeterminant(m: AffineMatrix): number {
  return m[0][0] * m[1][1] - m[0][1] * m[1][0]
}

/**
 * The inverse transformation: from the transformed image back to the
 * starting one. Must be called only on invertible matrices (such as those
 * `readAffineMatrix` accepts).
 */
export function invertAffine(m: AffineMatrix): AffineMatrix {
  const [[a, b, c], [d, e, f]] = m
  const det = a * e - b * d
  const ia = e / det
  const ib = -b / det
  const id = -d / det
  const ie = a / det
  return [
    [ia, ib, -(ia * c + ib * f)],
    [id, ie, -(id * c + ie * f)]
  ]
}

/**
 * True if the two geometries say the same thing, even if they are different
 * objects (the same rotation recomputed yields a new object).
 */
export function sameGeometry(a: AppliedGeometry, b: AppliedGeometry): boolean {
  if (a === b) return true
  if (a.type !== b.type) return false
  if (a.type !== 'transformed' || b.type !== 'transformed') return true
  return (
    a.input.width === b.input.width &&
    a.input.height === b.input.height &&
    a.output.width === b.output.width &&
    a.output.height === b.output.height &&
    a.matrix.every((row, i) => row.every((v, j) => Math.abs(v - b.matrix[i][j]) < 1e-9))
  )
}

/**
 * Reads a matrix returned by a plugin (untrusted data). Null if it is not a
 * 2x3 of finite numbers with an invertible linear part.
 */
export function readAffineMatrix(v: unknown): AffineMatrix | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const rows: number[][] = []
  for (const row of v) {
    if (!Array.isArray(row) || row.length !== 3) return null
    if (!row.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
    rows.push(row as number[])
  }
  const m: AffineMatrix = [
    [rows[0][0], rows[0][1], rows[0][2]],
    [rows[1][0], rows[1][1], rows[1][2]]
  ]
  const det = affineDeterminant(m)
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null
  return m
}

/**
 * Adds a plugin's step to the accumulated geometry. If either one is
 * unknown, so is the result.
 */
export function composeGeometry(soFar: AppliedGeometry, step: AppliedGeometry): AppliedGeometry {
  if (soFar.type === 'unknown' || step.type === 'unknown') return GEOMETRY_UNKNOWN
  if (step.type === 'unchanged') return soFar
  if (soFar.type === 'unchanged') return step
  return {
    type: 'transformed',
    matrix: composeAffines(soFar.matrix, step.matrix),
    input: { ...soFar.input },
    output: { ...step.output }
  }
}

/**
 * Moves a normalized position (0 to 1, origin at top left, like
 * `RecognizedObject.position`) from the starting image to the transformed
 * one. A normalized position n corresponds to pixel n·width - 0.5
 * (pixel centers counted from 0).
 */
export function transformNormalizedPosition(
  g: Extract<AppliedGeometry, { type: 'transformed' }>,
  p: { x: number; y: number }
): { x: number; y: number } {
  const q = applyAffine(g.matrix, p.x * g.input.width - 0.5, p.y * g.input.height - 0.5)
  return { x: (q.x + 0.5) / g.output.width, y: (q.y + 0.5) / g.output.height }
}

/** Reads the geometry saved in a project; a missing or corrupted one is unchanged. */
export function readAppliedGeometry(v: unknown): AppliedGeometry {
  if (typeof v !== 'object' || v === null) return GEOMETRY_UNCHANGED
  const g = v as Record<string, unknown>
  if (g['type'] === 'unknown') return GEOMETRY_UNKNOWN
  if (g['type'] !== 'transformed') return GEOMETRY_UNCHANGED
  const m = readAffineMatrix(g['matrix'])
  const dim = (x: unknown): { width: number; height: number } | null => {
    if (typeof x !== 'object' || x === null) return null
    const { width, height } = x as Record<string, unknown>
    return Number.isInteger(width) && Number.isInteger(height) && (width as number) > 0 && (height as number) > 0
      ? { width: width as number, height: height as number }
      : null
  }
  const input = dim(g['input'])
  const output = dim(g['output'])
  // A transformation that cannot be read back must not be ignored: the saved
  // image is turned anyway, so the solution has to be dropped.
  if (m === null || input === null || output === null) return GEOMETRY_UNKNOWN
  return { type: 'transformed', matrix: m, input, output }
}
