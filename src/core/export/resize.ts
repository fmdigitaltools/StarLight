import type { ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'

/**
 * Resizing with a Lanczos filter.
 *
 * Bringing a 1080x1920 frame to the resolution of a 4K screen requires
 * upscaling it about twice. Plain linear interpolation would give a soft
 * result; the Lanczos filter weights the pixels with a lobed function that
 * keeps edges and star profiles sharp, at the cost of some extra
 * computation.
 */

/** Filter width: three lobes is the usual compromise. */
const LOBES = 3

function lanczos(x: number): number {
  if (x === 0) return 1
  const ax = Math.abs(x)
  if (ax >= LOBES) return 0
  const pix = Math.PI * ax
  return (LOBES * Math.sin(pix) * Math.sin(pix / LOBES)) / (pix * pix)
}

/** Precomputed weights for one destination row or column. */
interface Contribution {
  start: number
  weights: Float32Array
}

/**
 * For each destination pixel, computes which source pixels contribute to
 * it and with what weight. The computation is separable: columns first,
 * then rows.
 */
function computeContributions(
  sourceSize: number,
  destinationSize: number,
  grid?: { factor: number; baseSize: number }
): Contribution[] {
  // With `grid`, the source is a `factor`-times enlargement of an image
  // `baseSize` pixels wide, with base pixel i at position factor·i:
  // positions are computed on the base, so the result stays centered as
  // with direct Lanczos.
  const factor = grid?.factor ?? 1
  const baseSize = grid?.baseSize ?? sourceSize
  const baseScale = destinationSize / baseSize
  const scale = baseScale / factor
  // When upscaling, the filter keeps its width; when downscaling, it widens
  // to average all the pixels that map onto the destination.
  const support = scale < 1 ? LOBES / scale : LOBES
  const contributions: Contribution[] = []

  for (let d = 0; d < destinationSize; d++) {
    // Center of the destination pixel mapped into source space.
    const center = factor * ((d + 0.5) / baseScale - 0.5)
    const first = Math.max(0, Math.ceil(center - support))
    const last = Math.min(sourceSize - 1, Math.floor(center + support))
    const quantity = last - first + 1

    const weights = new Float32Array(quantity)
    let sum = 0
    for (let i = 0; i < quantity; i++) {
      const distance = first + i - center
      const weight = lanczos(scale < 1 ? distance * scale : distance)
      weights[i] = weight
      sum += weight
    }

    // Normalization: the weights must sum to one, otherwise the image
    // brightness would change.
    if (sum !== 0) {
      for (let i = 0; i < quantity; i++) weights[i] /= sum
    }

    contributions.push({ start: first, weights })
  }

  return contributions
}

/**
 * Upscaling method: Lanczos spreads the pixels with fixed weights,
 * 'edge-directed' follows the direction of edges (see `upscaleOutlines`).
 * Downscaling always uses Lanczos.
 */
export type UpscalingMethod = 'lanczos' | 'edge-directed'

/**
 * Resizes a floating-point image. Returns the original image if the
 * requested dimensions are the same.
 */
export function resize(
  image: ImageData32,
  width: number,
  height: number,
  method: UpscalingMethod = 'lanczos'
): ImageData32 {
  if (width === image.width && height === image.height) return image
  if (method === 'edge-directed' && (width > image.width || height > image.height)) {
    return upscaleOutlines(image, width, height)
  }
  return resample(image, width, height)
}

/**
 * Separable Lanczos resampling. With `grid`, the source is an
 * integer-factor enlargement of an image of `baseWidth` × `baseHeight`, and
 * positions are computed on the latter.
 */
function resample(
  image: ImageData32,
  width: number,
  height: number,
  grid?: { factor: number; baseWidth: number; baseHeight: number }
): ImageData32 {
  const channels = image.channels
  const wOrig = image.width
  const hOrig = image.height
  const origSize = wOrig * hOrig
  const destSize = width * height

  const contributionsX = computeContributions(
    wOrig,
    width,
    grid ? { factor: grid.factor, baseSize: grid.baseWidth } : undefined
  )
  const contributionsY = computeContributions(
    hOrig,
    height,
    grid ? { factor: grid.factor, baseSize: grid.baseHeight } : undefined
  )

  const output = new Float32Array(destSize * channels)
  // Intermediate pass: final width, original height.
  const intermediate = new Float32Array(width * hOrig)

  for (let c = 0; c < channels; c++) {
    const origin = image.data.subarray(c * origSize, (c + 1) * origSize)

    // One function call per row: the JavaScript engine optimizes small
    // functions called many times much better than nested loops in a long
    // function executed once.
    // --- Horizontal ---
    for (let y = 0; y < hOrig; y++) {
      resampleRowHorizontally(origin, y * wOrig, intermediate, y * width, width, contributionsX)
    }

    // --- Vertical ---
    const destination = output.subarray(c * destSize, (c + 1) * destSize)
    for (let y = 0; y < height; y++) {
      resampleRowVertically(intermediate, destination, y * width, width, contributionsY[y])
    }
  }

  return { width: width, height: height, channels: channels, data: output }
}

function resampleRowHorizontally(
  origin: Float32Array,
  sourceRow: number,
  intermediate: Float32Array,
  destRow: number,
  width: number,
  contributionsX: Contribution[]
): void {
  for (let x = 0; x < width; x++) {
    const contribution = contributionsX[x]
    const weights = contribution.weights
    const base = sourceRow + contribution.start
    let sum = 0
    for (let i = 0; i < weights.length; i++) sum += origin[base + i] * weights[i]
    intermediate[destRow + x] = sum
  }
}

function resampleRowVertically(
  intermediate: Float32Array,
  destination: Float32Array,
  destRow: number,
  width: number,
  contribution: Contribution
): void {
  const weights = contribution.weights
  const base = contribution.start * width
  for (let x = 0; x < width; x++) {
    let sum = 0
    for (let i = 0; i < weights.length; i++) sum += intermediate[base + i * width + x] * weights[i]
    // The filter can overshoot the range on sharp edges.
    destination[destRow + x] = sum < 0 ? 0 : sum > 1 ? 1 : sum
  }
}

/*
 * Edge-directed upscaling.
 *
 * Lanczos always weights neighboring pixels the same way, horizontally and
 * vertically: on an oblique edge, such as the outline of a nebula or the
 * flank of a bright star, it mixes pixels from different sides of the edge
 * and leaves small steps. Here each new pixel is instead computed by first
 * finding the direction in which the image changes least, then
 * interpolating along it: along the edge, not across it.
 *
 * The method is directional cubic convolution interpolation (DCCI, Zhou et
 * al., 2012) and doubles the image in two passes. First the pixels at the
 * center of each square of four known pixels are computed, choosing between
 * the two diagonals; then the remaining ones, at the middle of each side,
 * choosing between horizontal and vertical. When no direction prevails the
 * two estimates are blended, so the sky background stays uniform.
 *
 * Each new value is finally clamped between the minimum and maximum of the
 * four nearest known pixels: no dark halos around stars, the most visible
 * flaw of lobed filters (anti-ringing).
 *
 * Other factors double as many times as needed and then downscale with
 * Lanczos to the exact size, again keeping the values within the
 * neighboring pixels.
 */

/** Above this gradient ratio, one direction clearly prevails. */
const DIRECTION_THRESHOLD = 1.15

/** Margin around the grid: the formulas read up to three positions away. */
const MARGIN = 3

/** Mirrors an index into [0, n), preserving parity, which matters here. */
function mirror(i: number, n: number): number {
  if (i < 0) i = -i
  if (i > n - 1) i = 2 * (n - 1) - i
  return i < 0 ? 0 : i > n - 1 ? n - 1 : i
}

/**
 * Fills the grid margin with the mirror image of the inner pixels. The
 * formulas can then always read at fixed offsets, without checking the
 * borders at every pixel: this is what makes the method fast enough for
 * images of tens of megapixels.
 */
function fillMargin(g: Float32Array, L: number, W: number, H: number): void {
  const m = MARGIN
  for (let Y = -m; Y < H + m; Y++) {
    const internal = Y >= 0 && Y < H
    const sy = mirror(Y, H)
    for (let X = -m; X < W + m; X++) {
      if (internal && X >= 0 && X < W) {
        X = W - 1
        continue
      }
      g[(Y + m) * L + X + m] = g[(sy + m) * L + mirror(X, W) + m]
    }
  }
}

/**
 * Gradients are measured on the scale of an 8-bit image, the one the
 * method's thresholds were tuned for: the data arrive here already
 * adjusted and within 0 to 1.
 */
const GRADIENT_SCALE = 255

/**
 * Weight of the estimate along direction 1 (0 to 1), given the gradient
 * strengths along the two directions. Interpolation follows the direction
 * where the image changes little, not where it changes a lot.
 */
function directionWeight(g1: number, g2: number): number {
  g1 *= GRADIENT_SCALE
  g2 *= GRADIENT_SCALE
  if ((1 + g2) / (1 + g1) > DIRECTION_THRESHOLD) return 1
  if ((1 + g1) / (1 + g2) > DIRECTION_THRESHOLD) return 0
  const q1 = g1 * g1
  const q2 = g2 * g2
  const w1 = 1 / (1 + q1 * q1 * g1)
  const w2 = 1 / (1 + q2 * q2 * g2)
  return w1 / (w1 + w2)
}

/*
 * The inner loops use Math.abs rather than a helper function: the engine
 * compiles it to a single instruction, while dozens of calls to our own
 * function would exhaust the engine's inlining budget.
 *
 * The direction is decided once, on the luminance, and applies to all
 * channels: it costs a third and, above all, the three colors follow the
 * same edge, with no color fringes where they would choose different paths.
 */

/** Pass 1, first half: diagonal weights for an odd row. */
function diagonalWeights(
  g: Float32Array,
  L: number,
  W: number,
  start: number,
  weights: Float32Array
): void {
  const L2 = 2 * L
  for (let X = 1; X < W; X += 2) {
    const p = start + X
    // Gradient along the "/" and "\" diagonals, over a window of nine
    // pairs of known pixels around the point.
    let gAscent = 0
    let gDescent = 0
    for (let j = -3; j <= 1; j += 2) {
      const r = p + j * L
      for (let i = -3; i <= 1; i += 2) {
        gAscent += Math.abs(g[r + i + 2] - g[r + L2 + i])
        gDescent += Math.abs(g[r + L2 + i + 2] - g[r + i])
      }
    }
    weights[X] = directionWeight(gAscent, gDescent)
  }
}

/** Pass 1, second half: the square centers of one row, with the given weights. */
function applyDiagonals(
  g: Float32Array,
  L: number,
  W: number,
  start: number,
  weights: Float32Array
): void {
  const L3 = 3 * L
  for (let X = 1; X < W; X += 2) {
    const p = start + X
    const a = weights[X]
    // Four-point cubic along each diagonal.
    const pUp = (-g[p + L3 - 3] + 9 * g[p + L - 1] + 9 * g[p - L + 1] - g[p - L3 + 3]) / 16
    const pDown = (-g[p - L3 - 3] + 9 * g[p - L - 1] + 9 * g[p + L + 1] - g[p + L3 + 3]) / 16
    g[p] = constrain(
      a * pUp + (1 - a) * pDown,
      g[p - L - 1],
      g[p - L + 1],
      g[p + L - 1],
      g[p + L + 1]
    )
  }
}

/** Pass 2, first half: horizontal and vertical weights for one row. */
function axisWeights(
  g: Float32Array,
  L: number,
  W: number,
  start: number,
  first: number,
  weights: Float32Array
): void {
  const L2 = 2 * L
  const L3 = 3 * L
  for (let X = first; X < W; X += 2) {
    const p = start + X
    const gHoriz =
      Math.abs(g[p - L2 + 1] - g[p - L2 - 1]) +
      Math.abs(g[p - L + 2] - g[p - L]) +
      Math.abs(g[p - L] - g[p - L - 2]) +
      Math.abs(g[p + 3] - g[p + 1]) +
      Math.abs(g[p + 1] - g[p - 1]) +
      Math.abs(g[p - 1] - g[p - 3]) +
      Math.abs(g[p + L + 2] - g[p + L]) +
      Math.abs(g[p + L] - g[p + L - 2]) +
      Math.abs(g[p + L2 + 1] - g[p + L2 - 1])
    const gVert =
      Math.abs(g[p + L - 2] - g[p - L - 2]) +
      Math.abs(g[p + L2 - 1] - g[p - 1]) +
      Math.abs(g[p - 1] - g[p - L2 - 1]) +
      Math.abs(g[p + L3] - g[p + L]) +
      Math.abs(g[p + L] - g[p - L]) +
      Math.abs(g[p - L] - g[p - L3]) +
      Math.abs(g[p + L2 + 1] - g[p + 1]) +
      Math.abs(g[p + 1] - g[p - L2 + 1]) +
      Math.abs(g[p + L + 2] - g[p - L + 2])
    weights[X] = directionWeight(gHoriz, gVert)
  }
}

/** Pass 2, second half: the side midpoints of one row, with the given weights. */
function applyAxes(
  g: Float32Array,
  L: number,
  W: number,
  start: number,
  first: number,
  weights: Float32Array
): void {
  const L3 = 3 * L
  for (let X = first; X < W; X += 2) {
    const p = start + X
    const a = weights[X]
    const pHoriz = (-g[p - 3] + 9 * g[p - 1] + 9 * g[p + 1] - g[p + 3]) / 16
    const pVert = (-g[p - L3] + 9 * g[p - L] + 9 * g[p + L] - g[p + L3]) / 16
    g[p] = constrain(a * pHoriz + (1 - a) * pVert, g[p - 1], g[p + 1], g[p - L], g[p + L])
  }
}

/**
 * Doubles all planes of an image together: from w × h to (2w − 1) × (2h − 1),
 * with source pixel (x, y) at position (2x, 2y).
 */
function doublePlanes(planes: Float32Array[], w: number, h: number): Float32Array[] {
  const W = 2 * w - 1
  const H = 2 * h - 1
  const m = MARGIN
  // Grids with margin, row stride L. With several channels, an extra grid
  // holds the luminance, which drives the choice of direction.
  const L = W + 2 * m
  const sources = planes.length === 1 ? planes : [...planes, brightness(planes)]
  const grids = sources.map((plane) => {
    const g = new Float32Array(L * (H + 2 * m))
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) g[(2 * y + m) * L + 2 * x + m] = plane[y * w + x]
    }
    return g
  })
  const guide = grids[grids.length - 1]
  const weights = new Float32Array(W)

  // --- Pass 1: square centers, between the two diagonals ---
  for (const g of grids) fillMargin(g, L, W, H)
  for (let Y = 1; Y < H; Y += 2) {
    const start = (Y + m) * L + m
    diagonalWeights(guide, L, W, start, weights)
    for (const g of grids) applyDiagonals(g, L, W, start, weights)
  }

  // --- Pass 2: side midpoints, between horizontal and vertical ---
  for (const g of grids) fillMargin(g, L, W, H)
  for (let Y = 0; Y < H; Y++) {
    const start = (Y + m) * L + m
    const first = (Y + 1) & 1
    axisWeights(guide, L, W, start, first, weights)
    for (const g of grids) applyAxes(g, L, W, start, first, weights)
  }

  // Strip the margin; the luminance grid is no longer needed.
  return grids.slice(0, planes.length).map((g) => {
    const output = new Float32Array(W * H)
    for (let Y = 0; Y < H; Y++) output.set(g.subarray((Y + m) * L + m, (Y + m) * L + m + W), Y * W)
    return output
  })
}

/** Channel mean, used as the guide for the directions. */
function brightness(planes: Float32Array[]): Float32Array {
  const n = planes[0].length
  const l = new Float32Array(n)
  for (const p of planes) for (let i = 0; i < n; i++) l[i] += p[i]
  for (let i = 0; i < n; i++) l[i] /= planes.length
  return l
}

/** Clamps the value between the minimum and maximum of the four neighbors. */
function constrain(v: number, a: number, b: number, c: number, d: number): number {
  let min = a < b ? a : b
  let max = a < b ? b : a
  if (c < min) min = c
  else if (c > max) max = c
  if (d < min) min = d
  else if (d > max) max = d
  return v < min ? min : v > max ? max : v
}

/**
 * Edge-directed upscaling: successive doublings, then Lanczos to the exact
 * size, clamped to the neighboring pixels.
 */
function upscaleOutlines(image: ImageData32, width: number, height: number): ImageData32 {
  const w = image.width
  const h = image.height
  const channels = image.channels
  if (w < 2 || h < 2) return resample(image, width, height)

  // Number of doublings: the first that reaches at least the requested size,
  // capped at eight times so as not to exhaust memory.
  let factor = 1
  let gw = w
  let gh = h
  const planes: Float32Array[] = []
  for (let c = 0; c < channels; c++) planes.push(image.data.slice(c * w * h, (c + 1) * w * h))
  while ((factor * w < width || factor * h < height) && factor < 8) {
    const doubled = doublePlanes(planes, gw, gh)
    for (let c = 0; c < channels; c++) planes[c] = doubled[c]
    gw = 2 * gw - 1
    gh = 2 * gh - 1
    factor *= 2
  }

  const ng = gw * gh
  const gridData = new Float32Array(ng * channels)
  for (let c = 0; c < channels; c++) gridData.set(planes[c], c * ng)
  const grid: ImageData32 = { width: gw, height: gh, channels: channels, data: gridData }

  const output = resample(grid, width, height, {
    factor,
    baseWidth: w,
    baseHeight: h
  })

  // Anti-ringing in the last pass too: each pixel stays within the four
  // grid pixels around it.
  const n = width * height
  const sx = w / width
  const sy = h / height
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.max(0, factor * ((y + 0.5) * sy - 0.5)))
    const y0 = Math.floor(gy)
    const y1 = Math.min(gh - 1, y0 + 1)
    for (let x = 0; x < width; x++) {
      const gx = Math.min(gw - 1, Math.max(0, factor * ((x + 0.5) * sx - 0.5)))
      const x0 = Math.floor(gx)
      const x1 = Math.min(gw - 1, x0 + 1)
      for (let c = 0; c < channels; c++) {
        const base = c * ng
        const k = c * n + y * width + x
        output.data[k] = constrain(
          output.data[k],
          gridData[base + y0 * gw + x0],
          gridData[base + y0 * gw + x1],
          gridData[base + y1 * gw + x0],
          gridData[base + y1 * gw + x1]
        )
      }
    }
  }
  return output
}

/** A preset resolution offered on export. */
export interface Resolution {
  /** Display name, in the current language. */
  readonly name: string
  width: number
  /** Short description, in the current language. */
  readonly description: string
}

/**
 * Builds a resolution whose name and description are read from the language
 * files on every access, so they follow a language change at run time.
 */
function resolution(id: string, width: number, fixedName: string | null = null): Resolution {
  return {
    get name() {
      return fixedName ?? t('coreResize.resolutions.' + id + '.name')
    },
    width,
    get description() {
      return t('coreResize.resolutions.' + id + '.description')
    }
  }
}

/** Preset resolutions offered on export. */
export const RESOLUTIONS: Resolution[] = [
  resolution('original', 0),
  resolution('hd', 1280, 'HD 1280'),
  resolution('fullHd', 1920, 'Full HD 1920'),
  resolution('qhd', 2560, 'QHD 2560'),
  resolution('uhd', 3840, '4K 3840')
]

/** Computes the height that preserves the aspect ratio. */
export function proportionalHeight(
  sourceWidth: number,
  sourceHeight: number,
  destinationWidth: number
): number {
  return Math.max(1, Math.round((sourceHeight * destinationWidth) / sourceWidth))
}
