import type { ImageData32, Wcs } from '@shared/types'
import { resizeWcs, cropWcs } from '@core/astrometry/wcs'
import {
  applyAffine,
  composeAffines,
  invertAffine,
  IDENTITY_MATRIX,
  type AppliedGeometry,
  type AffineMatrix
} from '@core/image/geometry'
import { t } from '@shared/i18n/i18n'

/**
 * Crop and aspect ratios.
 *
 * The crop is expressed as fractions of the original image, from 0 to 1,
 * not in pixels: it stays valid when the output resolution changes, and a
 * crop chosen on a small preview applies identically to the full-resolution
 * data.
 */

export interface Crop {
  /** Top-left corner, as fractions of width and height. */
  x: number
  y: number
  /** Size, as fractions of the original. */
  width: number
  height: number
}

/** Crop covering the whole image. */
export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 }

export interface AspectRatio {
  id: string
  /** Display name, in the current language. */
  readonly name: string
  /** Width/height ratio; null means the original's. */
  ratio: number | null
  /** Short description, in the current language. */
  readonly description: string
}

/**
 * Adds `name` and `description` getters that read the language files on
 * every access (`<prefix>.name` and `<prefix>.description`), so option
 * tables defined at module level follow a language change at run time.
 * With `fixedName`, the name is not translated (e.g. "16:9", brand names).
 */
function withTexts<T extends object>(
  fields: T,
  prefix: string,
  fixedName: string | null = null
): T & { readonly name: string; readonly description: string } {
  return Object.defineProperties(fields, {
    name: { get: () => fixedName ?? t(prefix + '.name'), enumerable: true },
    description: { get: () => t(prefix + '.description'), enumerable: true }
  }) as T & { readonly name: string; readonly description: string }
}

/** Aspect ratio whose texts are under `coreCrop.aspectRatios.<key>`. */
function aspectRatio(id: string, key: string, ratio: number | null, translatedName = false): AspectRatio {
  return withTexts({ id, ratio }, 'coreCrop.aspectRatios.' + key, translatedName ? null : id.replace('-', ':'))
}

/*
 * Every aspect ratio has its rotated twin (4:5 and 5:4, 2:3 and 3:2…): a
 * plugin that rotates the image by a quarter turn moves the crop from one
 * to the other (see `fitFraming`). In the panel they sit on two rows,
 * portrait above and landscape below, each above its twin.
 */
export const ASPECT_RATIOS: AspectRatio[] = [
  aspectRatio('original', 'original', null, true),
  aspectRatio('4-5', 'r4x5', 4 / 5),
  aspectRatio('3-4', 'r3x4', 3 / 4),
  aspectRatio('2-3', 'r2x3', 2 / 3),
  aspectRatio('9-16', 'r9x16', 9 / 16),
  aspectRatio('9-21', 'r9x21', 9 / 21),
  aspectRatio('1-1', 'r1x1', 1),
  aspectRatio('5-4', 'r5x4', 5 / 4),
  aspectRatio('4-3', 'r4x3', 4 / 3),
  aspectRatio('3-2', 'r3x2', 3 / 2),
  aspectRatio('16-9', 'r16x9', 16 / 9),
  aspectRatio('21-9', 'r21x9', 21 / 9)
]

export interface Preset {
  id: string
  /** Display name, in the current language. */
  readonly name: string
  /** Where it is used. */
  group: 'Social' | 'Screens' | 'Print'
  width: number
  height: number
  /** Short description, in the current language. */
  readonly description: string
}

/** Preset whose texts are under `coreCrop.presets.<key>`. */
function preset(id: string, key: string, group: Preset['group'], width: number, height: number): Preset {
  return withTexts({ id, group, width, height }, 'coreCrop.presets.' + key)
}

/**
 * Sizes recommended by the various platforms: the formats in which the
 * image is shown without recompression or automatic cropping.
 */
export const PRESETS: Preset[] = [
  preset('ig-square', 'instagramSquare', 'Social', 1080, 1080),
  preset('ig-portrait', 'instagramPortrait', 'Social', 1080, 1350),
  preset('ig-stories', 'instagramStories', 'Social', 1080, 1920),
  preset('fb-post', 'facebookPost', 'Social', 1200, 630),
  preset('fb-cover', 'facebookCover', 'Social', 1640, 624),
  preset('x-post', 'xPost', 'Social', 1600, 900),
  preset('x-header', 'xHeader', 'Social', 1500, 500),
  preset('bluesky-post', 'blueskyPost', 'Social', 1200, 675),
  preset('bluesky-header', 'blueskyHeader', 'Social', 1500, 500),
  preset('threads', 'threads', 'Social', 1080, 1350),
  preset('mastodon', 'mastodon', 'Social', 1280, 720),
  preset('telegram', 'telegram', 'Social', 1280, 1280),
  preset('whatsapp-status', 'whatsappStatus', 'Social', 1080, 1920),
  preset('linkedin', 'linkedin', 'Social', 1200, 627),
  preset('pinterest', 'pinterest', 'Social', 1000, 1500),
  preset('youtube-thumbnail', 'youtubeThumbnail', 'Social', 1280, 720),

  preset('screen-1080', 'wallpaperFullHd', 'Screens', 1920, 1080),
  preset('screen-1440', 'wallpaperQhd', 'Screens', 2560, 1440),
  preset('screen-4k', 'wallpaper4k', 'Screens', 3840, 2160),
  preset('phone', 'wallpaperPhone', 'Screens', 1179, 2556),
  preset('tablet', 'wallpaperTablet', 'Screens', 2048, 2732),

  preset('print-10x15', 'print10x15', 'Print', 1772, 1181),
  preset('print-20x30', 'print20x30', 'Print', 3543, 2362),
  preset('print-30x40', 'print30x40', 'Print', 4724, 3543),
  preset('print-square', 'print30x30', 'Print', 3543, 3543)
]

/**
 * Largest box with the requested ratio, centered on the image. It is the
 * starting point when an aspect ratio is chosen: from there the framing
 * can be moved and shrunk.
 */
export function centeredCrop(
  imageWidth: number,
  imageHeight: number,
  ratio: number | null
): Crop {
  if (ratio === null) return { ...FULL_CROP }

  const imageRatio = imageWidth / imageHeight
  let width = 1
  let height = 1

  if (ratio > imageRatio) {
    // The box is wider than the image: fit to the width.
    height = imageRatio / ratio
  } else {
    width = ratio / imageRatio
  }

  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

/**
 * Brings a crop back within the image borders while keeping its shape:
 * used while dragging, so it never leaves the frame.
 */
export function clampCrop(r: Crop): Crop {
  const width = Math.min(1, Math.max(0.05, r.width))
  const height = Math.min(1, Math.max(0.05, r.height))
  return {
    width,
    height,
    x: Math.min(1 - width, Math.max(0, r.x)),
    y: Math.min(1 - height, Math.max(0, r.y))
  }
}

/**
 * Shrinks or enlarges the crop around its center, keeping the aspect
 * ratio. Factor 1 is the starting box.
 */
export function cropScale(r: Crop, factor: number, ratio: number | null): Crop {
  const max = ratio === null ? 1 : Math.max(r.width, r.height)
  const scale = Math.min(1 / max, Math.max(0.1, factor))

  const width = r.width * scale
  const height = r.height * scale
  const centerX = r.x + r.width / 2
  const centerY = r.y + r.height / 2

  return clampCrop({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height
  })
}

/** Whether the crop covers the whole image. */
export function fullCrop(r: Crop): boolean {
  return r.x <= 0.0001 && r.y <= 0.0001 && r.width >= 0.9999 && r.height >= 0.9999
}

/**
 * Extracts the given region. The bounds are rounded to the nearest pixel,
 * because the cropped image must have integer dimensions.
 */
export function cropRegion(image: ImageData32, r: Crop): ImageData32 {
  if (fullCrop(r)) return image

  const { x0, y0, width, height } = cropRectangle(r, image.width, image.height)

  const channels = image.channels
  const originSize = image.width * image.height
  const outputSize = width * height
  const output = new Float32Array(outputSize * channels)

  for (let c = 0; c < channels; c++) {
    const sourceBase = c * originSize
    const outputBase = c * outputSize
    for (let y = 0; y < height; y++) {
      const sourceRow = sourceBase + (y0 + y) * image.width + x0
      const outputRow = outputBase + y * width
      for (let x = 0; x < width; x++) {
        output[outputRow + x] = image.data[sourceRow + x]
      }
    }
  }

  return { width: width, height: height, channels: channels, data: output }
}

/**
 * The pixel rectangle that `cropRegion` extracts, with the same rounding:
 * also used to shift the astrometric solution.
 */
export function cropRectangle(
  r: Crop,
  imageWidth: number,
  imageHeight: number
): { x0: number; y0: number; width: number; height: number } {
  if (fullCrop(r)) return { x0: 0, y0: 0, width: imageWidth, height: imageHeight }
  const x0 = Math.max(0, Math.round(r.x * imageWidth))
  const y0 = Math.max(0, Math.round(r.y * imageHeight))
  const width = Math.max(1, Math.min(imageWidth - x0, Math.round(r.width * imageWidth)))
  const height = Math.max(1, Math.min(imageHeight - y0, Math.round(r.height * imageHeight)))
  return { x0, y0, width, height }
}

/**
 * The astrometric solution of the exported image: that of the displayed
 * image, shifted by the crop and scaled by the resize, in the same order
 * the export applies them. Null if missing, or if it describes an image
 * with different dimensions from the one being exported (no solution is
 * better than a wrong one).
 */
export function exportedWcs(
  wcs: Wcs | null,
  imageWidth: number,
  imageHeight: number,
  r: Crop,
  outputWidth: number,
  outputHeight: number
): Wcs | null {
  if (wcs === null) return null
  if (wcs.naxis1 > 0 && wcs.naxis2 > 0 && (wcs.naxis1 !== imageWidth || wcs.naxis2 !== imageHeight)) {
    return null
  }
  const full = { ...wcs, naxis1: imageWidth, naxis2: imageHeight }
  const q = cropRectangle(r, imageWidth, imageHeight)
  const cropped = cropWcs(full, q.x0, q.y0, q.width, q.height)
  return resizeWcs(cropped, outputWidth, outputHeight)
}

/** Pixel dimensions of the crop on the original image. */
export function cropDimensions(
  r: Crop,
  imageWidth: number,
  imageHeight: number
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(r.width * imageWidth)),
    height: Math.max(1, Math.round(r.height * imageHeight))
  }
}

/* ---- Framing and plugins that move pixels ---- */

/** The three choices of the Export panel that together define what is exported. */
export interface Framing {
  crop: Crop
  aspectRatio: string
  preset: string | null
}

/** Width/height ratio imposed by the framing; null if free. */
export function framingRatio(framing: Framing): number | null {
  if (framing.preset !== null) {
    const f = PRESETS.find((x) => x.id === framing.preset)
    if (f) return f.width / f.height
  }
  return ASPECT_RATIOS.find((p) => p.id === framing.aspectRatio)?.ratio ?? null
}

/**
 * The twin aspect ratio rotated by a quarter turn: 3:2 becomes 2:3. A
 * ratio without a twin in the list becomes 'custom' (custom): the box
 * stays correct, only the button is no longer highlighted.
 */
function rotatedAspectRatio(id: string): string {
  if (id === 'original' || id === 'custom') return id
  const parts = id.split('-')
  if (parts.length !== 2) return 'custom'
  const flipped = parts[1] + '-' + parts[0]
  return ASPECT_RATIOS.some((p) => p.id === flipped) ? flipped : 'custom'
}

/**
 * Box with the given ratio and the same pixel area as the starting box,
 * around its center, shrunk as needed to fit in the image. Used when the
 * shape must be kept but the image has changed (a preset after a quarter
 * turn, transformations that cannot be tracked).
 */
function boxWithRatio(r: Crop, imageWidth: number, imageHeight: number, ratio: number): Crop {
  const area = r.width * imageWidth * r.height * imageHeight
  let width = Math.sqrt(area * ratio)
  let height = Math.sqrt(area / ratio)
  const excess = Math.max(1, width / imageWidth, height / imageHeight)
  width /= excess
  height /= excess
  const fl = width / imageWidth
  const fa = height / imageHeight
  return clampCrop({
    x: r.x + r.width / 2 - fl / 2,
    y: r.y + r.height / 2 - fa / 2,
    width: fl,
    height: fa
  })
}

/**
 * The framing after the displayed image has changed geometry (a plugin
 * rotated or mirrored it, or was removed).
 *
 * The crop is in fractions of the displayed image: if the image rotates
 * and the crop does not, the export takes a different region, with the
 * wrong shape and, after a quarter turn, possibly partly outside the
 * borders. Here the box follows the pixels: the mapping from the old image
 * to the new one is computed (the inverse of the old geometry, then the
 * new one) and the box corners are moved there. After a quarter turn the
 * aspect ratio becomes its twin (3:2 → 2:3); a preset instead has fixed
 * sizes set by the platform, so it stays, and the box regains its shape
 * around the same center.
 *
 * If the geometry is unknown, or the transformation is not made of quarter
 * turns and mirrors, there is no way to know where the pixels went: with
 * the same dimensions the crop stays as it is, otherwise it is recentered
 * with the same shape. If nothing changes the same object is returned, so
 * the history does not see a new crop.
 */
export function fitFraming(
  framing: Framing,
  before: AppliedGeometry,
  after: AppliedGeometry,
  measurementsBefore: { width: number; height: number },
  measurementsAfter: { width: number; height: number }
): Framing {
  if (before === after) return framing
  const sameMeasures = measurementsBefore.width === measurementsAfter.width && measurementsBefore.height === measurementsAfter.height

  const recenter = (): Framing => {
    if (sameMeasures) return framing
    const ratio = framingRatio(framing)
    if (fullCrop(framing.crop) && ratio === null) return framing
    return {
      ...framing,
      crop:
        ratio === null
          ? centeredCrop(measurementsAfter.width, measurementsAfter.height, null)
          : boxWithRatio(framing.crop, measurementsAfter.width, measurementsAfter.height, ratio)
    }
  }

  if (before.type === 'unknown' || after.type === 'unknown') return recenter()

  const matrixBefore: AffineMatrix = before.type === 'transformed' ? before.matrix : IDENTITY_MATRIX
  const matrixAfter: AffineMatrix = after.type === 'transformed' ? after.matrix : IDENTITY_MATRIX
  // From the old displayed image to the new one.
  const m = composeAffines(invertAffine(matrixBefore), matrixAfter)
  const [[a, b, c], [d, e, f]] = m
  const zero = (v: number): boolean => Math.abs(v) < 1e-9
  const upright = zero(b) && zero(d) && !zero(a) && !zero(e)
  const flipped = zero(a) && zero(e) && !zero(b) && !zero(d)
  if (!upright && !flipped) return recenter()
  if (upright && sameMeasures && zero(a - 1) && zero(e - 1) && zero(c) && zero(f)) return framing
  if (fullCrop(framing.crop) && framing.preset === null) {
    // The whole image stays the whole image; after a quarter turn only the
    // aspect ratio name changes.
    const aspectRatio = flipped ? rotatedAspectRatio(framing.aspectRatio) : framing.aspectRatio
    return aspectRatio === framing.aspectRatio ? framing : { ...framing, aspectRatio }
  }

  // The box corners are pixel edges; the matrix works on pixel centers,
  // half a pixel further in.
  const r = framing.crop
  const angle = (fx: number, fy: number): { x: number; y: number } => {
    const q = applyAffine(m, fx * measurementsBefore.width - 0.5, fy * measurementsBefore.height - 0.5)
    return { x: (q.x + 0.5) / measurementsAfter.width, y: (q.y + 0.5) / measurementsAfter.height }
  }
  const p1 = angle(r.x, r.y)
  const p2 = angle(r.x + r.width, r.y + r.height)
  let crop = clampCrop({
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    width: Math.abs(p2.x - p1.x),
    height: Math.abs(p2.y - p1.y)
  })

  if (!flipped) return { ...framing, crop }

  // Quarter turn: width and height have been swapped.
  if (framing.preset !== null) {
    const ratio = framingRatio(framing)
    if (ratio !== null) {
      crop = boxWithRatio(crop, measurementsAfter.width, measurementsAfter.height, ratio)
    }
    return { ...framing, crop }
  }
  return { ...framing, crop, aspectRatio: rotatedAspectRatio(framing.aspectRatio) }
}

/* ---- Box dragged in the viewer ---- */

/**
 * The part of the box grabbed with the mouse: the inside (to move it) or
 * one of the eight handles, named by compass points (n = top side,
 * s = bottom, e = right, w = left; 'ne' is the top-right corner, and so on).
 */
export type CropGrip = 'inside' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Shortest accepted side, the same as in `clampCrop`. */
const MIN_SIDE = 0.05

function between(v: number, minimum: number, max: number): number {
  return Math.min(max, Math.max(minimum, v))
}

/**
 * The box after a drag, starting from its state when the button was
 * pressed. `dx` and `dy` are the pointer displacement in fractions of the
 * image; `ratio` is the shape to keep (width/height in pixels, from the
 * aspect ratio or the preset) or null if the box is free.
 *
 * - From the inside, the box just moves, without changing size.
 * - With a free shape, each handle moves only the sides it touches; the
 *   opposite side stays put.
 * - With a fixed shape, a corner enlarges or shrinks the box keeping the
 *   opposite corner fixed; a side does the same keeping the opposite side
 *   and the center of the other direction fixed. The dimension that wins is
 *   the one the pointer pushed most, so the box follows the hand in any
 *   direction.
 *
 * The result always lies inside the image (`clampCrop`).
 */
export function dragCrop(
  start: Crop,
  grip: CropGrip,
  dx: number,
  dy: number,
  ratio: number | null,
  imageWidth: number,
  imageHeight: number
): Crop {
  if (grip === 'inside') {
    // Moving must never change the size, not even of a box created smaller
    // than the minimum.
    const width = Math.min(1, start.width)
    const height = Math.min(1, start.height)
    return {
      x: between(start.x + dx, 0, 1 - width),
      y: between(start.y + dy, 0, 1 - height),
      width,
      height
    }
  }

  const west = grip.includes('w')
  const east = grip.includes('e')
  const north = grip.includes('n')
  const south = grip.includes('s')

  // First the freely moved sides, each between the image border and the
  // opposite side.
  const px0 = start.x
  const py0 = start.y
  const px1 = start.x + start.width
  const py1 = start.y + start.height
  const x0 = west ? between(px0 + dx, 0, px1 - MIN_SIDE) : px0
  const x1 = east ? between(px1 + dx, px0 + MIN_SIDE, 1) : px1
  const y0 = north ? between(py0 + dy, 0, py1 - MIN_SIDE) : py0
  const y1 = south ? between(py1 + dy, py0 + MIN_SIDE, 1) : py1
  if (ratio === null || !(ratio > 0) || imageWidth <= 0 || imageHeight <= 0) {
    return clampCrop({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
  }

  // The shape in fractions: width = height × k.
  const k = (ratio * imageHeight) / imageWidth
  const horizontal = west || east
  const vertical = north || south
  let width = x1 - x0
  let height = y1 - y0

  // Space available on the growing side.
  let maxWidth: number
  let maxHeight: number
  if (horizontal && vertical) {
    maxWidth = west ? px1 : 1 - px0
    maxHeight = north ? py1 : 1 - py0
    if (width / height > k) height = width / k
    else width = height * k
  } else if (horizontal) {
    maxWidth = west ? px1 : 1 - px0
    maxHeight = 1
    height = width / k
  } else {
    maxWidth = 1
    maxHeight = north ? py1 : 1 - py0
    width = height * k
  }

  // Inside the image, then no smaller than the minimum if there is room.
  const reduce = Math.min(1, maxWidth / width, maxHeight / height)
  width *= reduce
  height *= reduce
  const grow = Math.max(1, MIN_SIDE / width, MIN_SIDE / height)
  if (width * grow <= maxWidth + 1e-12 && height * grow <= maxHeight + 1e-12) {
    width *= grow
    height *= grow
  }

  const centerX = px0 + start.width / 2
  const centerY = py0 + start.height / 2
  const x = horizontal ? (west ? px1 - width : px0) : centerX - width / 2
  const y = vertical ? (north ? py1 - height : py0) : centerY - height / 2
  return clampCrop({ x, y, width, height })
}
