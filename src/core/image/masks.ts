import type { ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { detectStars, type Star } from '@core/stars/detection'
import type { AppliedGeometry, AffineMatrix } from '@core/image/geometry'

/**
 * Local adjustments: an adjustment that acts only on part of the image,
 * chosen by a mask.
 *
 * Each "layer" has a mask (where it acts) and a small set of adjustments
 * (what it does). Layers are applied after all the global adjustments, on
 * the image that is already stretched and colored: that is where you see
 * what you want to retouch.
 *
 * The same math lives in two places: in the viewer shader
 * (gpu/fragment.glsl) and here, for full-resolution export
 * (export/processing.ts). The two versions must be kept identical, line
 * by line, so the saved file matches what is displayed.
 *
 * The mask of a layer is the product of two parts:
 * - an automatic mask (light, color, stars, object, gradients), computed
 *   from the image or from a geometric shape;
 * - an optional mask painted by hand with brush and eraser.
 * Where both exist the adjustment acts only where both are non-zero.
 */

/** Maximum number of layers: beyond that, the viewer shader would become heavy. */
export const MAX_LAYERS = 4

/**
 * The painted mask is stored at a quarter of the resolution: brush strokes
 * are soft, and this way it weighs sixteen times less.
 */
export const PAINTED_REDUCTION = 4

export type MaskType = 'whole' | 'brightness' | 'color' | 'stars' | 'object' | 'linear' | 'radial'

/** Numeric code of the type, as the shader reads it. */
export const TYPE_CODE: Record<MaskType, number> = {
  whole: 0,
  brightness: 1,
  color: 2,
  stars: 3,
  linear: 4,
  // The object is a feathered ellipse like the radial gradient, only
  // positioned from the catalog.
  radial: 5,
  object: 5
}

/** Painted mask: one byte per pixel, 0 = outside, 255 = inside. */
export interface PaintedMask {
  width: number
  height: number
  data: Uint8Array
}

export interface Mask {
  type: MaskType
  /** Swaps inside and outside of the automatic mask (or of the painted one, if alone). */
  invert: boolean
  /** Softness of the edges, from 0 to 1. */
  feather: number
  /** How much the adjustment acts inside the mask, from 0 to 1. */
  intensity: number
  /** Light mask: brightness range, from 0 to 1. */
  lightFrom: number
  lightTo: number
  /** Color mask: central hue in degrees (0 red, 120 green, 240 blue) and width. */
  tint: number
  hueWidth: number
  /** Star mask: how much to widen the circle around each star. */
  starSize: number
  /**
   * Linear gradient: full at (ax, ay), null at (bx, by). In pixels of the
   * source image (see `mapToSource`).
   */
  ax: number
  ay: number
  bx: number
  by: number
  /**
   * Radial gradient and object: ellipse with center (cx, cy), semi-axes rx
   * and ry and tilt `angle` in radians, in pixels of the source image.
   */
  cx: number
  cy: number
  rx: number
  ry: number
  angle: number
  /** Mask painted by hand, or null if the brush has not been used yet. */
  painted: PaintedMask | null
}

/** What the layer does inside the mask. All neutral at zero. */
export interface LayerAdjustments {
  /** From -1 to 1: brightens or darkens without burning the whites or lifting the blacks. */
  brightness: number
  /** From -1 to 1, with a soft S curve. */
  contrast: number
  /** From -1 to 1. */
  saturation: number
  /** From -1 to 1: mainly saturates dull colors. */
  vibrance: number
  /** From -1 to 1: warmer (toward yellow) or cooler (toward blue). */
  temperature: number
  /** From -1 to 1: toward magenta or toward green. */
  tint: number
  /** From 0 to 1. */
  sharpness: number
  /** From 0 to 1. */
  noiseReduction: number
}

export interface LocalLayer {
  id: string
  name: string
  /** A disabled layer stays in the list but does not act. */
  active: boolean
  mask: Mask
  adjustments: LayerAdjustments
}

export const NEUTRAL_LAYER_ADJUSTMENTS: LayerAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  sharpness: 0,
  noiseReduction: 0
}

/** Default mask for a source image of width `l` and height `a`. */
export function defaultMask(l: number, a: number): Mask {
  const side = Math.min(l, a)
  return {
    type: 'brightness',
    invert: false,
    feather: 0.4,
    intensity: 1,
    lightFrom: 0,
    lightTo: 0.35,
    tint: 0,
    hueWidth: 25,
    starSize: 1,
    ax: l / 2,
    ay: 0,
    bx: l / 2,
    by: a / 2,
    cx: (l - 1) / 2,
    cy: (a - 1) / 2,
    rx: side * 0.3,
    ry: side * 0.3,
    angle: 0,
    painted: null
  }
}

/** A new layer, with a light mask on the faint parts. */
export function newLayer(id: string, name: string, l: number, a: number): LocalLayer {
  return {
    id,
    name,
    active: true,
    mask: defaultMask(l, a),
    adjustments: NEUTRAL_LAYER_ADJUSTMENTS
  }
}

/** True if the layer changes anything: all neutral or zero intensity does not act. */
export function layerActs(l: LocalLayer): boolean {
  if (!l.active || l.mask.intensity <= 0) return false
  const r = l.adjustments
  return (Object.keys(r) as (keyof LayerAdjustments)[]).some((k) => Math.abs(r[k]) > 0.001)
}

/* ------------------------------------------------------------------ */
/* Geometry: from the displayed image to the source image              */
/* ------------------------------------------------------------------ */

/**
 * The geometric masks and the painted one are anchored to the source image,
 * not to the displayed one: if a plugin rotates or mirrors the pixels, the
 * mask follows them without having to be redrawn, and Undo restores
 * everything as it was. These are the dimensions of the source image.
 */
export function startDimensions(
  geometry: AppliedGeometry,
  image: { width: number; height: number }
): { width: number; height: number } {
  if (geometry.type === 'transformed') return { ...geometry.input }
  return { width: image.width, height: image.height }
}

/** Inverse of an affine transform; the identity if it is not invertible. */
export function invertAffine(m: AffineMatrix): AffineMatrix {
  const [[a, b, c], [d, e, f]] = m
  const det = a * e - b * d
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [[1, 0, 0], [0, 1, 0]]
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
 * Transform from the pixels of the displayed image to those of the source
 * image. If a plugin moved the pixels without saying how, it cannot be
 * known: the mask is kept where it is on screen.
 */
export function mapToSource(geometry: AppliedGeometry): AffineMatrix {
  if (geometry.type === 'transformed') return invertAffine(geometry.matrix)
  return [
    [1, 0, 0],
    [0, 1, 0]
  ]
}

/* ------------------------------------------------------------------ */
/* Stars                                                               */
/* ------------------------------------------------------------------ */

const foundStars = new WeakMap<ImageData32, Star[]>()

/** Stars already searched for in this image, or null if the search has not been done. */
export function starsInMemory(image: ImageData32): Star[] | null {
  return foundStars.get(image) ?? null
}

/**
 * Stars of the image, searched for only once. Large groups are accepted as
 * well (bright stars are the ones the mask needs most), but not whole
 * nebulae.
 */
export function imageStars(image: ImageData32): Star[] {
  const already = foundStars.get(image)
  if (already) return already
  const stars = detectStars(residualWithoutBackground(image), { max: 6000, maxPixels: 4000 })
  foundStars.set(image, stars)
  return stars
}

/**
 * Luminance minus the extended structures (background and nebulae).
 * Searching for stars directly on the image, a bright nebula exceeds the
 * threshold and breaks into many "groups" that look like stars; by first
 * removing whatever is wider than a few tens of pixels, the stars are
 * left, which are small.
 *
 * The background is estimated with the medians of 8×8 pixel blocks,
 * cleaned by a second median over neighboring blocks (a block occupied by
 * a large star must not count), and brought back to full resolution with
 * bilinear interpolation.
 */
function residualWithoutBackground(image: ImageData32): ImageData32 {
  const w = image.width
  const h = image.height
  const n = w * h
  const d = image.data
  const lum = new Float32Array(n)
  if (image.channels === 3) {
    for (let i = 0; i < n; i++) lum[i] = 0.2126 * d[i] + 0.7152 * d[n + i] + 0.0722 * d[2 * n + i]
  } else lum.set(d.subarray(0, n))

  const f = 8
  const bw = Math.ceil(w / f)
  const bh = Math.ceil(h / f)
  const blocks = new Float32Array(bw * bh)
  const values = new Float32Array(f * f)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let k = 0
      for (let y = by * f; y < Math.min(h, (by + 1) * f); y++) {
        for (let x = bx * f; x < Math.min(w, (bx + 1) * f); x++) values[k++] = lum[y * w + x]
      }
      const part = values.subarray(0, k).sort()
      blocks[by * bw + bx] = part[k >> 1]
    }
  }
  // Second median, 5×5 blocks.
  const background = new Float32Array(bw * bh)
  const neighbors = new Float32Array(25)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let k = 0
      for (let dy = -2; dy <= 2; dy++) {
        const yy = by + dy
        if (yy < 0 || yy >= bh) continue
        for (let dx = -2; dx <= 2; dx++) {
          const xx = bx + dx
          if (xx < 0 || xx >= bw) continue
          neighbors[k++] = blocks[yy * bw + xx]
        }
      }
      const part = neighbors.subarray(0, k).sort()
      background[by * bw + bx] = part[k >> 1]
    }
  }
  const residual = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    const qy = Math.min(bh - 1, Math.max(0, (y + 0.5) / f - 0.5))
    const y0 = Math.floor(qy)
    const y1 = Math.min(bh - 1, y0 + 1)
    const fy = qy - y0
    for (let x = 0; x < w; x++) {
      const qx = Math.min(bw - 1, Math.max(0, (x + 0.5) / f - 0.5))
      const x0 = Math.floor(qx)
      const x1 = Math.min(bw - 1, x0 + 1)
      const fx = qx - x0
      const a = background[y0 * bw + x0] + (background[y0 * bw + x1] - background[y0 * bw + x0]) * fx
      const b = background[y1 * bw + x0] + (background[y1 * bw + x1] - background[y1 * bw + x0]) * fx
      residual[y * w + x] = lum[y * w + x] - (a + (b - a) * fy)
    }
  }
  return { width: w, height: h, channels: 1, data: residual }
}

/** Reduction of the star mask: full resolution up to 16 million pixels. */
export function scaleStarMask(l: number, a: number): number {
  return Math.max(1, Math.ceil(Math.sqrt((l * a) / 16e6)))
}

/** Gradual transition, like the shader smoothstep. */
export function smoothStep(from: number, a: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (a - from)))
  return t * t * (3 - 2 * t)
}

/**
 * Draws the star mask of a layer into channel `channel` of a four-channel
 * image (RGBA). The radius of each star grows with the area the star
 * occupies above the background: bright stars, which after the stretch
 * have a wider halo, receive a larger circle.
 */
export function drawStars(
  stars: Star[],
  dest: Uint8Array,
  width: number,
  height: number,
  scale: number,
  channel: number,
  size: number,
  feather: number
): void {
  const s = 0.15 + 0.6 * feather
  for (const st of stars) {
    const r = size * (1.2 * Math.sqrt(st.pixel / Math.PI) + 1.5)
    const inside = r * (1 - s)
    const outside = r * (1 + s)
    // Center in the pixels of the reduced mask.
    const qx = (st.x + 0.5) / scale - 0.5
    const qy = (st.y + 0.5) / scale - 0.5
    const radius = outside / scale
    const x0 = Math.max(0, Math.floor(qx - radius))
    const x1 = Math.min(width - 1, Math.ceil(qx + radius))
    const y0 = Math.max(0, Math.floor(qy - radius))
    const y1 = Math.min(height - 1, Math.ceil(qy + radius))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - qx, y - qy) * scale
        if (d >= outside) continue
        const v = Math.round((1 - smoothStep(inside, outside, d)) * 255)
        const k = (y * width + x) * 4 + channel
        if (v > dest[k]) dest[k] = v
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Data ready for the shader and for export                            */
/* ------------------------------------------------------------------ */

/** Four-channel image, one per layer, with values from 0 to 255. */
export interface Layer4 {
  width: number
  height: number
  data: Uint8Array
}

/** Everything needed to apply the local adjustments to an image. */
export interface ReadyLocalAdjustments {
  /** Layers that act, at most MAX_LAYERS. */
  layers: LocalLayer[]
  /** From the pixels of the displayed image to those of the source image. */
  map: AffineMatrix
  start: { width: number; height: number }
  /** Painted masks of the layers, channel i = layer i; null if none uses them. */
  paintedItems: Layer4 | null
  /** Star masks, channel i = layer i; null if none uses them. */
  stars: (Layer4 & { scale: number }) | null
}

/** Dimensions of the painted mask for a source image. */
export function paintedMeasurements(start: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(1, Math.ceil(start.width / PAINTED_REDUCTION)),
    height: Math.max(1, Math.ceil(start.height / PAINTED_REDUCTION))
  }
}

/** Packs the painted masks of the layers into a single four-channel image. */
export function packPainted(
  layers: LocalLayer[],
  start: { width: number; height: number }
): Layer4 | null {
  if (!layers.some((l) => l.mask.painted !== null)) return null
  const { width, height } = paintedMeasurements(start)
  const data = new Uint8Array(width * height * 4)
  layers.forEach((l, i) => {
    const d = l.mask.painted
    if (!d) return
    if (d.width === width && d.height === height) {
      for (let k = 0, n = width * height; k < n; k++) data[k * 4 + i] = d.data[k]
      return
    }
    // Different dimensions (source image changed): rescale.
    for (let y = 0; y < height; y++) {
      const sy = Math.min(d.height - 1, Math.floor(((y + 0.5) * d.height) / height))
      for (let x = 0; x < width; x++) {
        const sx = Math.min(d.width - 1, Math.floor(((x + 0.5) * d.width) / width))
        data[(y * width + x) * 4 + i] = d.data[sy * d.width + sx]
      }
    }
  })
  return { width, height, data }
}

/** Draws the star masks of the layers that use them; null if none does. */
export function packStars(
  layers: LocalLayer[],
  image: { width: number; height: number },
  stars: Star[] | null
): (Layer4 & { scale: number }) | null {
  if (stars === null || !layers.some((l) => l.mask.type === 'stars')) return null
  const scale = scaleStarMask(image.width, image.height)
  const width = Math.ceil(image.width / scale)
  const height = Math.ceil(image.height / scale)
  const data = new Uint8Array(width * height * 4)
  layers.forEach((l, i) => {
    if (l.mask.type !== 'stars') return
    drawStars(stars, data, width, height, scale, i, l.mask.starSize, l.mask.feather)
  })
  return { width, height, scale, data }
}

/** Layers that actually act, in order, at most four. */
export function effectiveLayers(layers: LocalLayer[]): LocalLayer[] {
  return layers.filter(layerActs).slice(0, MAX_LAYERS)
}

/**
 * Prepares the local adjustments for export. If a layer uses the stars and
 * they have not been searched for yet, they are searched for now. Null if
 * no layer acts.
 */
export function prepareLocals(
  layers: LocalLayer[],
  image: ImageData32,
  geometry: AppliedGeometry
): ReadyLocalAdjustments | null {
  const effective = effectiveLayers(layers)
  if (effective.length === 0) return null
  const start = startDimensions(geometry, image)
  const starsNeeded = effective.some((l) => l.mask.type === 'stars')
  return {
    layers: effective,
    map: mapToSource(geometry),
    start,
    paintedItems: packPainted(effective, start),
    stars: starsNeeded ? packStars(effective, image, imageStars(image)) : null
  }
}

/* ------------------------------------------------------------------ */
/* Per-pixel computation (twin of the shader)                          */
/* ------------------------------------------------------------------ */

/** Bilinear read of a channel of a four-channel image, as in the shader. */
export function bilinear4(s: Layer4, qx: number, qy: number, channel: number): number {
  const mx = s.width - 1
  const my = s.height - 1
  const x = qx < 0 ? 0 : qx > mx ? mx : qx
  const y = qy < 0 ? 0 : qy > my ? my : qy
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, mx)
  const y1 = Math.min(y0 + 1, my)
  const fx = x - x0
  const fy = y - y0
  const d = s.data
  const a = d[(y0 * s.width + x0) * 4 + channel] / 255
  const b = d[(y0 * s.width + x1) * 4 + channel] / 255
  const c = d[(y1 * s.width + x0) * 4 + channel] / 255
  const e = d[(y1 * s.width + x1) * 4 + channel] / 255
  const above = a + (b - a) * fx
  const below = c + (e - c) * fx
  return above + (below - above) * fy
}

/** Hue (degrees, from 0 to 360) of a color; 0 for grays. */
export function tintOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const c = mx - mn
  if (c < 1e-6) return 0
  if (mx === r) {
    const t = (g - b) / c
    return 60 * (t - 6 * Math.floor(t / 6))
  }
  if (mx === g) return 60 * ((b - r) / c + 2)
  return 60 * ((r - g) / c + 4)
}

/** Thresholds of vivid color, for the color mask (identical in the shader). */
export const CHROMA_THRESHOLD: [number, number] = [0.02, 0.07]
export const SAT_THRESHOLD: [number, number] = [0.06, 0.2]
/** How far a pixel must exceed the sky background light to have a color (color mask). */
export const ABOVE_BACKGROUND: [number, number] = [0.015, 0.06]

/** True if any layer uses a light or color mask, which looks at the "smooth" color. */
export function needsSmoothing(p: ReadyLocalAdjustments): boolean {
  return p.layers.some((l) => l.mask.type === 'brightness' || l.mask.type === 'color')
}

/**
 * Mean of the original data around a pixel, over nine points two pixels
 * apart (a 5×5 area): the light and color masks look at this "smooth"
 * color, passed through the chain, instead of the single pixel. On the
 * background the noise would give each pixel a random hue, and the mask
 * would become a rain of specks. Twin of `neighborMean` in the shader.
 */
export function neighborMean(planes: Float32Array[], w: number, h: number, x: number, y: number, result: number[]): void {
  let r = 0
  let g = 0
  let b = 0
  for (let dy = -2; dy <= 2; dy += 2) {
    const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy
    for (let dx = -2; dx <= 2; dx += 2) {
      const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx
      const k = yy * w + xx
      r += planes[0][k]
      g += planes[1][k]
      b += planes[2][k]
    }
  }
  result[0] = r / 9
  result[1] = g / 9
  result[2] = b / 9
}

/**
 * Value of the automatic mask (without the painted part) for a pixel,
 * from 0 to 1. `base` is the color after the global adjustments; (qx, qy)
 * is the position in the source image.
 */
function automatic(
  m: Mask,
  base: number[],
  qx: number,
  qy: number,
  stars: number,
  backgroundLight: number
): number {
  switch (m.type) {
    case 'brightness': {
      const f = 0.005 + 0.25 * m.feather
      const l = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2]
      const below = m.lightFrom <= 0.0005 ? 1 : smoothStep(m.lightFrom - f, m.lightFrom + f, l)
      const above = m.lightTo >= 0.9995 ? 1 : 1 - smoothStep(m.lightTo - f, m.lightTo + f, l)
      return below * above
    }
    case 'color': {
      const mx = Math.max(base[0], base[1], base[2])
      const mn = Math.min(base[0], base[1], base[2])
      const sat = mx > 1e-4 ? (mx - mn) / mx : 0
      const h = tintOf(base[0], base[1], base[2])
      let d = Math.abs(h - m.tint)
      d = Math.min(d, 360 - d)
      const fw = 4 + 60 * m.feather
      const mh = 1 - smoothStep(m.hueWidth, m.hueWidth + fw, d)
      // Grays have no real hue: it is weighted by how vivid the color is,
      // both in absolute terms and relative to its light.
      // The sky background stays out: its color is noise, blotchy even
      // after the neighbor mean.
      const l = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2]
      const aboveBackground = smoothStep(backgroundLight + ABOVE_BACKGROUND[0], backgroundLight + ABOVE_BACKGROUND[1], l)
      return (
        mh *
        smoothStep(CHROMA_THRESHOLD[0], CHROMA_THRESHOLD[1], mx - mn) *
        smoothStep(SAT_THRESHOLD[0], SAT_THRESHOLD[1], sat) *
        aboveBackground
      )
    }
    case 'stars':
      return stars
    case 'linear': {
      const abx = m.bx - m.ax
      const aby = m.by - m.ay
      const t0 = ((qx - m.ax) * abx + (qy - m.ay) * aby) / Math.max(abx * abx + aby * aby, 1e-6)
      const t = t0 < 0 ? 0 : t0 > 1 ? 1 : t0
      return 1 - t * t * (3 - 2 * t)
    }
    case 'radial':
    case 'object': {
      const dx = qx - m.cx
      const dy = qy - m.cy
      const ca = Math.cos(m.angle)
      const sa = Math.sin(m.angle)
      const u = (dx * ca + dy * sa) / Math.max(m.rx, 1e-3)
      const v = (-dx * sa + dy * ca) / Math.max(m.ry, 1e-3)
      const r = Math.sqrt(u * u + v * v)
      const f = 0.02 + 0.98 * m.feather
      return 1 - smoothStep(1 - f, 1, r)
    }
    default:
      return 1
  }
}

/**
 * Layer mask values for pixel (x, y) of the displayed image (pixel centers
 * counted from 0). `base` is the "smooth" color after the global
 * adjustments (see `neighborMean`): it is needed only by the light and
 * color masks. `backgroundLight` is the luminance of the sky background
 * (the median of the data) after the global adjustments: the color mask
 * stays out of it. Writes into `result` a value from 0 to 1 per layer.
 */
export function maskValues(
  p: ReadyLocalAdjustments,
  base: number[],
  x: number,
  y: number,
  result: number[],
  backgroundLight = 0
): void {
  // Access by index: destructuring [[a, b, c], ...] costs too much at every
  // pixel.
  const r0 = p.map[0]
  const r1 = p.map[1]
  const qx = r0[0] * x + r0[1] * y + r0[2]
  const qy = r1[0] * x + r1[1] * y + r1[2]
  const dip = p.paintedItems
  const st = p.stars
  // Positions in the reduced masks.
  const dx = dip ? ((qx + 0.5) * dip.width) / p.start.width - 0.5 : 0
  const dy = dip ? ((qy + 0.5) * dip.height) / p.start.height - 0.5 : 0
  const sx = st ? (x + 0.5) / st.scale - 0.5 : 0
  const sy = st ? (y + 0.5) / st.scale - 0.5 : 0
  for (let i = 0; i < p.layers.length; i++) {
    const m = p.layers[i].mask
    const starsValue = st && m.type === 'stars' ? bilinear4(st, sx, sy, i) : 0
    let A = automatic(m, base, qx, qy, starsValue, backgroundLight)
    let P = dip && m.painted ? bilinear4(dip, dx, dy, i) : 1
    if (m.invert) {
      if (m.type !== 'whole') A = 1 - A
      else P = 1 - P
    }
    const v = A * P
    result[i] = (v < 0 ? 0 : v > 1 ? 1 : v) * m.intensity
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** The shader S curve (sCurve), on a single value. */
function sCurve(x0: number, strength: number): number {
  const x = clamp(x0)
  const soft = x * x * (3 - 2 * x)
  const direction = strength > 0 ? soft : x + (x - soft)
  return x + (direction - x) * Math.abs(strength)
}

/** Applies the adjustments of a layer to an already corrected color (twin of applyLocal in the shader). */
export function adjustPixel(rgb: number[], r: LayerAdjustments): void {
  if (Math.abs(r.temperature) > 0.001 || Math.abs(r.tint) > 0.001) {
    rgb[0] *= 1 + r.temperature * 0.28
    rgb[2] *= 1 - r.temperature * 0.28
    rgb[1] *= 1 - r.tint * 0.18
    rgb[0] *= 1 + r.tint * 0.07
    rgb[2] *= 1 + r.tint * 0.07
    for (let c = 0; c < 3; c++) rgb[c] = clamp(rgb[c])
  }
  const l = r.brightness
  if (l > 0.001) for (let c = 0; c < 3; c++) rgb[c] = rgb[c] + (1 - rgb[c]) * l
  else if (l < -0.001) for (let c = 0; c < 3; c++) rgb[c] = rgb[c] * (1 + l)
  if (Math.abs(r.contrast) >= 0.001) for (let c = 0; c < 3; c++) rgb[c] = sCurve(rgb[c], r.contrast)
  if (Math.abs(r.saturation) > 0.001) {
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    for (let c = 0; c < 3; c++) rgb[c] = clamp(lum + (rgb[c] - lum) * (1 + r.saturation))
  }
  if (Math.abs(r.vibrance) > 0.001) {
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    const mx = Math.max(rgb[0], rgb[1], rgb[2])
    const mn = Math.min(rgb[0], rgb[1], rgb[2])
    const boost = r.vibrance * (1 - smoothStep(0, 0.6, mx - mn))
    for (let c = 0; c < 3; c++) rgb[c] = clamp(lum + (rgb[c] - lum) * (1 + boost))
  }
  for (let c = 0; c < 3; c++) rgb[c] = clamp(rgb[c])
}

/** Reads a pixel of a plane, replicating the edge. */
function sample(plane: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y
  return plane[cy * w + cx]
}

/** Gradual transition, like the shader smoothstep. */
function softCurve(from: number, a: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (a - from)))
  return t * t * (3 - 2 * t)
}

/**
 * How noise reduction acts at a given intensity (from 0 to 1).
 * - `mix`: how much of the filtered value replaces the original; it
 *   reaches the maximum already at mid slider.
 * - `ring2`, `ring3`: weight of the neighbors two and three pixels away,
 *   which come in as the slider rises (from 25% and 50%) and widen the
 *   area up to 7 × 7, so that even the grain clumps of stacked images
 *   dissolve.
 * The immediate neighbors always weigh 1. Calibrated on synthetic clumpy
 * grain: in the first half of the slider it removes twice as much noise
 * as the earlier version, at 100% 56% of the noise instead of 43%. The
 * shader (fragment.glsl, spatialFilter) does the same computation with
 * smoothstep.
 */
export function noiseParams(intensity: number): { mix: number; ring2: number; ring3: number } {
  return {
    mix: Math.min(1, 2 * intensity),
    ring2: softCurve(0.25, 0.7, intensity),
    ring3: softCurve(0.5, 1, intensity)
  }
}

/**
 * Noise reduction and sharpness on one pixel, read from the original
 * data: the same as the shader's `spatialFilter` function. Writes the
 * three filtered channels into `result`.
 */
export function pixelSpatialFilter(
  planes: Float32Array[],
  w: number,
  h: number,
  x: number,
  y: number,
  noise: number,
  sharpness: number,
  result: number[]
): void {
  const i = y * w + x
  const center = [planes[0][i], planes[1][i], planes[2][i]]
  for (let c = 0; c < 3; c++) result[c] = center[c]
  if (noise > 0.001) {
    const threshold = 0.055 + 0.16 * (1 - noise)
    const inv = 1 / (threshold * threshold)
    const sum = [center[0], center[1], center[2]]
    let weight = 1
    const { mix, ring2, ring3 } = noiseParams(noise)
    const radius = ring3 > 0.001 ? 3 : ring2 > 0.001 ? 2 : 1
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue
        const ring = Math.max(Math.abs(dx), Math.abs(dy))
        const ws = ring === 3 ? ring3 : ring === 2 ? ring2 : 1
        const v0 = sample(planes[0], w, h, x + dx, y + dy)
        const v1 = sample(planes[1], w, h, x + dx, y + dy)
        const v2 = sample(planes[2], w, h, x + dx, y + dy)
        const d0 = v0 - center[0]
        const d1 = v1 - center[1]
        const d2 = v2 - center[2]
        const wv = ws * Math.exp(-(d0 * d0 + d1 * d1 + d2 * d2) * inv)
        sum[0] += v0 * wv
        sum[1] += v1 * wv
        sum[2] += v2 * wv
        weight += wv
      }
    }
    for (let c = 0; c < 3; c++) result[c] = center[c] + (sum[c] / weight - center[c]) * mix
  }
  if (sharpness > 0.001) {
    for (let c = 0; c < 3; c++) {
      let blurredImage = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) blurredImage += sample(planes[c], w, h, x + dx, y + dy)
      }
      blurredImage /= 9
      result[c] = result[c] + (result[c] - blurredImage) * sharpness * 2.2
    }
  }
}

/* ------------------------------------------------------------------ */
/* Brush                                                               */
/* ------------------------------------------------------------------ */

export interface BrushStroke {
  /** Radius in pixels of the painted mask. */
  radius: number
  /** From 0 (very soft edge) to 1 (sharp edge). */
  hardness: number
  /** From 0 to 1. */
  opacity: number
}

/**
 * Adds a brush stamp to the coverage of the stroke in progress (values
 * from 0 to 1). Within the same stroke the stamps do not add up, the
 * maximum is taken: going over it again does not darken beyond the chosen
 * opacity, as in photo-editing programs. Returns the rectangle touched, or
 * null if the stamp falls outside.
 */
export function stamp(
  coverage: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  p: BrushStroke
): { x0: number; y0: number; x1: number; y1: number } | null {
  const r = Math.max(0.5, p.radius)
  const x0 = Math.max(0, Math.floor(x - r))
  const x1 = Math.min(width - 1, Math.ceil(x + r))
  const y0 = Math.max(0, Math.floor(y - r))
  const y1 = Math.min(height - 1, Math.ceil(y + r))
  if (x0 > x1 || y0 > y1) return null
  const inside = Math.min(0.98, Math.max(0, p.hardness))
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const t = Math.hypot(xx - x, yy - y) / r
      if (t >= 1) continue
      const v = (1 - smoothStep(inside, 1, t)) * p.opacity
      const k = yy * width + xx
      if (v > coverage[k]) coverage[k] = v
    }
  }
  return { x0, y0, x1, y1 }
}

/**
 * Applies the coverage of a stroke to the starting mask: the brush adds,
 * the eraser removes. Writes into `dest` only the indicated rectangle.
 */
export function composeBrushStroke(
  start: Uint8Array,
  coverage: Float32Array,
  dest: Uint8Array,
  width: number,
  eraser: boolean,
  r: { x0: number; y0: number; x1: number; y1: number }
): void {
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const k = y * width + x
      const v = start[k]
      const c = coverage[k]
      dest[k] = Math.round(eraser ? v * (1 - c) : v + (255 - v) * c)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Saving the painted mask                                             */
/* ------------------------------------------------------------------ */

/** Signature of the painted mask files. */
const MASK_SIGNATURE = [0x53, 0x4c, 0x4d, 0x4b] // "SLMK"

/**
 * Compresses a painted mask. A mask is made almost entirely of full or
 * empty areas, so run-length coding is enough (the PackBits scheme of
 * TIFF): an empty mask of two million pixels becomes a few tens of
 * kilobytes, and the coding is instantaneous.
 *
 * Format: "SLMK", version (1 byte), width and height (4 bytes each,
 * little endian), then the compressed data.
 */
export function compressMask(m: PaintedMask): Uint8Array {
  const d = m.data
  const n = d.length
  const output = new Uint8Array(13 + n + Math.ceil(n / 128) + 16)
  output.set(MASK_SIGNATURE, 0)
  output[4] = 1
  const view = new DataView(output.buffer)
  view.setUint32(5, m.width, true)
  view.setUint32(9, m.height, true)
  let o = 13
  let i = 0
  while (i < n) {
    // Repetition of the same value?
    let j = i + 1
    while (j < n && j - i < 128 && d[j] === d[i]) j++
    if (j - i >= 3) {
      output[o++] = 257 - (j - i) // 129 to 254: repeat (257 - n) times
      output[o++] = d[i]
      i = j
      continue
    }
    // Run of different values, up to 128 or until the next repetition.
    j = i
    while (j < n && j - i < 128) {
      if (j + 2 < n && d[j] === d[j + 1] && d[j] === d[j + 2]) break
      j++
    }
    if (j === i) j = i + 1
    output[o++] = j - i - 1 // 0 to 127: copy n + 1 bytes
    output.set(d.subarray(i, j), o)
    o += j - i
    i = j
  }
  return output.slice(0, o)
}

/** The inverse of `compressMask`; null if the data is not a valid mask. */
export function decompressMask(b: Uint8Array): PaintedMask | null {
  if (b.length < 13) return null
  for (let k = 0; k < 4; k++) if (b[k] !== MASK_SIGNATURE[k]) return null
  if (b[4] !== 1) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const width = view.getUint32(5, true)
  const height = view.getUint32(9, true)
  if (width < 1 || height < 1 || width * height > 64e6) return null
  const n = width * height
  const data = new Uint8Array(n)
  let o = 0
  let i = 13
  while (i < b.length && o < n) {
    const c = b[i++]
    if (c < 128) {
      const count = c + 1
      if (i + count > b.length || o + count > n) return null
      data.set(b.subarray(i, i + count), o)
      i += count
      o += count
    } else if (c > 128) {
      const count = 257 - c
      if (i >= b.length || o + count > n) return null
      data.fill(b[i++], o, o + count)
      o += count
    }
  }
  if (o !== n) return null
  return { width, height, data }
}

/** From bytes to base64 text, for the recovery copy (which is text only). */
export function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(t: string): Uint8Array | null {
  try {
    const s = atob(t)
    const b = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
    return b
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Reading from the project                                            */
/* ------------------------------------------------------------------ */

/**
 * Painted mask as it appears in the project file: in the real project it
 * is a separate file (`file`), in the recovery copy it is inside the text
 * (`data`, in base64), because the recovery copy writes only text and
 * images.
 */
export interface SavedPainted {
  file?: string
  data?: string
}

export type SavedLayer = Omit<LocalLayer, 'mask'> & {
  mask: Omit<Mask, 'painted'> & { painted: SavedPainted | null }
}

/** Already compressed masks: a recovery save does not recompress them. */
const compressedOnes = new WeakMap<Uint8Array, Uint8Array>()

/** The compressed painted mask (remembering the results already computed). */
export function compressedMask(m: PaintedMask): Uint8Array {
  let c = compressedOnes.get(m.data)
  if (!c) {
    c = compressMask(m)
    compressedOnes.set(m.data, c)
  }
  return c
}

/**
 * The layers in the form to write into the project, with the painted
 * masks compressed inside the text. The real save then moves them to
 * separate files (see `useProject`); the recovery copy leaves them there.
 */
export function layersToSave(layers: LocalLayer[]): SavedLayer[] {
  return layers.map((l) => ({
    ...l,
    adjustments: { ...l.adjustments },
    mask: {
      ...l.mask,
      painted: l.mask.painted ? { data: toBase64(compressedMask(l.mask.painted)) } : null
    }
  }))
}

/** File name of the painted mask of the layer at position `i` (from 0). */
export function maskFileName(i: number): string {
  return 'mask-' + (i + 1) + '.slmask'
}

/** From a layer read from the project to the in-memory one, with the painted mask already loaded. */
export function layerFromSaved(l: SavedLayer, painted: PaintedMask | null): LocalLayer {
  return { ...l, mask: { ...l.mask, painted } }
}

const TYPES: MaskType[] =['whole', 'brightness', 'color', 'stars', 'object', 'linear', 'radial']


function maskType(v: unknown): MaskType {
  return TYPES.find((t) => t === v) ?? 'whole'
}

function number(v: unknown, defaultValue: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : defaultValue
}

/**
 * Reads the layers written in the project. Damaged entries are discarded,
 * missing fields take the neutral value. The painted mask stays a
 * reference: whoever opens the project loads it.
 */
export function readSavedLayers(v: unknown): SavedLayer[] {
  if (!Array.isArray(v)) return []
  const result: SavedLayer[] = []
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue
    const g = raw as Record<string, unknown>
    const m = (typeof g['mask'] === 'object' && g['mask'] !== null ? g['mask'] : {}) as Record<string, unknown>
    const r = (typeof g['adjustments'] === 'object' && g['adjustments'] !== null ? g['adjustments'] : {}) as Record<
      string,
      unknown
    >
    const neutral = defaultMask(1000, 1000)
    const type = maskType(m['type'])
    const dip = m['painted']
    let painted: SavedPainted | null = null
    if (typeof dip === 'object' && dip !== null) {
      const d = dip as Record<string, unknown>
      if (typeof d['file'] === 'string' && /^[\w.-]+$/.test(d['file'])) painted = { file: d['file'] }
      else if (typeof d['data'] === 'string') painted = { data: d['data'] }
    }
    const geo = (k: keyof Mask): number => number(m[k], neutral[k] as number, -1e7, 1e7)
    result.push({
      id: typeof g['id'] === 'string' && g['id'] !== '' ? g['id'] : 'layer-' + (result.length + 1),
      name:
        typeof g['name'] === 'string' && g['name'] !== ''
          ? g['name']
          : t('coreMasks.defaultLayerName', { number: result.length + 1 }),
      active: g['active'] !== false,
      mask: {
        type,
        invert: m['invert'] === true,
        feather: number(m['feather'], neutral.feather, 0, 1),
        intensity: number(m['intensity'], 1, 0, 1),
        lightFrom: number(m['lightFrom'], neutral.lightFrom, 0, 1),
        lightTo: number(m['lightTo'], neutral.lightTo, 0, 1),
        tint: number(m['tint'], 0, 0, 360),
        hueWidth: number(m['hueWidth'], neutral.hueWidth, 1, 180),
        starSize: number(m['starSize'], 1, 0.2, 5),
        ax: geo('ax'),
        ay: geo('ay'),
        bx: geo('bx'),
        by: geo('by'),
        cx: geo('cx'),
        cy: geo('cy'),
        rx: number(m['rx'], neutral.rx, 0.5, 1e7),
        ry: number(m['ry'], neutral.ry, 0.5, 1e7),
        angle: number(m['angle'], 0, -100, 100),
        painted
      },
      adjustments: {
        brightness: number(r['brightness'], 0, -1, 1),
        contrast: number(r['contrast'], 0, -1, 1),
        saturation: number(r['saturation'], 0, -1, 1),
        vibrance: number(r['vibrance'], 0, -1, 1),
        temperature: number(r['temperature'], 0, -1, 1),
        tint: number(r['tint'], 0, -1, 1),
        sharpness: number(r['sharpness'], 0, 0, 1),
        noiseReduction: number(r['noiseReduction'], 0, 0, 1)
      }
    })
    if (result.length >= MAX_LAYERS) break
  }
  return result
}
