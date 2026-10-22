import type { BayerPattern, ImageData32 } from '@shared/types'
import { isShared, sharedImage, sharedMemoryAvailable, sharedUint16 } from '@shared/sharedMemory'
import { colorAt } from '../image/debayer'
import { RING, calibrate, checkMasterSizes, defectMap, median8, flatMeans } from './calibration'

/**
 * Frames kept in compact form until the sum.
 *
 * Between analysis and sum every frame stays in memory. Reconstructed and
 * in floating point, a colour frame takes 12 bytes per pixel; the file it
 * comes from, if it is 16-bit or less, had only 2 (the sensor mosaic) or 6
 * (three planes). So the integer values read from the file are kept, and
 * colour reconstruction and calibration are redone only where and when
 * they are needed: the sum asks for them in tiles, a few hundred pixels
 * per side at a time (`rebuildRegion`).
 *
 * The result is bit-for-bit identical to that of a frame kept whole: the
 * value of each code is the one the reader would have written
 * (`valueTable`), colour reconstruction repeats the operations of
 * `debayer` and calibration those of `calibrate`, in the same order and
 * with the same 32-bit rounding. A file that cannot be reduced this way
 * (floating-point values, stacked frames, unusual scales) stays whole,
 * reconstructed and in 32 bits.
 *
 * The masters of the calibration library also stay compact: on disk they
 * are 16-bit codes in the sensor format (`quantize` and `unmosaic` in
 * calibrationLibrary.ts), and the master used by calibration is their
 * colour reconstruction (`usableMaster`). The codes are kept (2 bytes per
 * pixel instead of 12 for a colour sensor) and calibration reconstructs,
 * with the same operations, only the piece of master it needs.
 */

/**
 * A calibration master: whole, or compact with the codes of the library
 * (`compactMaster`).
 */
export type KeptMaster = ImageData32 | CompactImage

/** Calibration to apply to a compact frame every time it is reconstructed. */
export interface DeferredCalibration {
  dark: KeptMaster | null
  flat: KeptMaster | null
  bias: KeptMaster | null
  /** Mean of the flat per channel, as computed by `calibrate`. */
  flatMean: number[]
  /** Defective pixels of the dark, one bit per channel (`defectMap`); null if they are not corrected. */
  defects: Uint8Array | null
  threshold: number
}

export interface CompactImage {
  compact: true
  width: number
  height: number
  /** Channels after colour reconstruction. */
  channels: 1 | 3
  /** Integer codes of the pixels read, by plane: one (mono or mosaic) or three. */
  codes: Uint16Array
  planes: 1 | 3
  /** Full scale of the file: the normalised value is code / scale. */
  fullScale: number
  /**
   * Present for library masters: the codes cover the range
   * [minimum, max] and are interpreted as in `dequantize`; the scale does not matter.
   */
  interval?: { minimum: number; max: number }
  /** Mosaic pattern; 'NONE' if the planes are already the channels. */
  bayer: BayerPattern
  calibration?: DeferredCalibration
}

/** A frame held in memory for the sum: whole or compact. */
export type HeldImage = ImageData32 | CompactImage

export function isCompact(image: HeldImage): image is CompactImage {
  return (image as CompactImage).compact === true
}

/** Bytes taken by the pixels of a held frame. */
export function keptBytes(image: HeldImage): number {
  return isCompact(image) ? image.codes.byteLength : image.data.byteLength
}

/* ---- Codes and values ---- */

const tables = new Map<number, Float32Array>()

/**
 * Normalised value of each code from 0 to `fullScale`, computed the way the
 * FITS, TIFF, PNG and RAW readers compute it: the code times the inverse of
 * the scale, clamped between 0 and 1, rounded to 32 bits.
 */
export function valueTable(fullScale: number): Float32Array {
  const note = tables.get(fullScale)
  if (note) return note
  const table = new Float32Array(fullScale + 1)
  const inv = 1 / fullScale
  for (let k = 0; k <= fullScale; k++) {
    const v = k * inv
    table[k] = v > 0 ? (v < 1 ? v : 1) : 0
  }
  tables.set(fullScale, table)
  return table
}

const masterTables = new Map<string, Float32Array>()

/**
 * Value of each 16-bit code of a library master, computed as in
 * `dequantize`: the minimum plus the fraction of the range, rounded to 32
 * bits.
 */
export function quantizedTable(minimum: number, max: number): Float32Array {
  const key = minimum + ' ' + max
  const note = masterTables.get(key)
  if (note) return note
  const amplitude = max - minimum || 1
  const table = new Float32Array(65536)
  for (let k = 0; k < 65536; k++) table[k] = minimum + (k / 65535) * amplitude
  // A few tables are enough: one per master in use.
  if (masterTables.size >= 16) masterTables.delete(masterTables.keys().next().value as string)
  masterTables.set(key, table)
  return table
}

function tableOf(image: CompactImage): Float32Array {
  const q = image.interval
  return q ? quantizedTable(q.minimum, q.max) : valueTable(image.fullScale)
}

/**
 * A library master kept compact: the stored codes (one or three planes,
 * `planes` of the entry) with their range. Reconstructed, it gives, bit
 * for bit, `usableMaster` of the values of `dequantize`.
 */
export function compactMaster(
  kept: { width: number; height: number; planes: 1 | 3; codes: Uint16Array },
  bayer: BayerPattern,
  minimum: number,
  max: number
): CompactImage {
  const mosaic = kept.planes === 1 && bayer !== 'NONE'
  return {
    compact: true,
    width: kept.width,
    height: kept.height,
    channels: mosaic ? 3 : kept.planes,
    codes: kept.codes,
    planes: kept.planes,
    fullScale: 65535,
    interval: { minimum, max },
    bayer: mosaic ? bayer : 'NONE'
  }
}

/** Codes of `data` with this scale, or null if some value has no exact code. */
function encode(data: Float32Array, fullScale: number, allocate: (l: number) => Uint16Array): Uint16Array | null {
  const table = valueTable(fullScale)
  const encodeValue = (v: number): number => {
    const k = Math.round(v * fullScale)
    return k >= 0 && k <= fullScale && table[k] === v ? k : -1
  }
  // A check on the first values avoids allocating for floating-point
  // files, which fail almost immediately.
  for (let i = 0, test = Math.min(data.length, 4096); i < test; i++) if (encodeValue(data[i]) < 0) return null
  const codes = allocate(data.length)
  for (let i = 0; i < data.length; i++) {
    const k = encodeValue(data[i])
    if (k < 0) return null
    codes[i] = k
  }
  return codes
}

/**
 * Reduces to integer codes the pixels just read (before colour
 * reconstruction), trying the given scales in order. Returns null if no
 * scale represents all the values exactly: the frame is then kept whole.
 *
 * @param allocate who prepares the codes: the analysis worker wants them in
 * shared memory, so that the sum can read them from several workers without copies.
 */
export function compact(
  loaded: ImageData32,
  bayer: BayerPattern,
  scale: number[],
  allocate: (length: number) => Uint16Array = sharedUint16
): CompactImage | null {
  for (const fullScale of scale) {
    if (!Number.isInteger(fullScale) || fullScale < 1 || fullScale > 65535) continue
    const codes = encode(loaded.data, fullScale, allocate)
    if (!codes) continue
    const mosaic = loaded.channels === 1 && bayer !== 'NONE'
    return {
      compact: true,
      width: loaded.width,
      height: loaded.height,
      channels: mosaic ? 3 : loaded.channels,
      codes,
      planes: loaded.channels,
      fullScale,
      bayer: mosaic ? bayer : 'NONE'
    }
  }
  return null
}

/* ---- Reconstruction ---- */

let job = new Float32Array(0)
const neighbors = new Float32Array(8)

/**
 * Values of the frame in the rectangle [x0, x1) × [y0, y1), by planes of
 * (x1 − x0) × (y1 − y0) pixels at the start of `output`: the same, bit for
 * bit, as the frame reconstructed and calibrated as a whole.
 *
 * @param withCalibration false to get the frame as it was before
 * calibration (needed by the analysis, which measures stars on the frame as read)
 */
export function rebuildRegion(
  image: CompactImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  output: Float32Array,
  withCalibration = true
): void {
  const w = image.width
  const h = image.height
  const channels = image.channels
  const cal = withCalibration ? image.calibration : undefined
  // Defective pixels take the median of the neighbours two steps away,
  // already calibrated: the region is widened by two pixels to have them.
  const edge = cal && cal.defects ? 2 : 0
  const ex0 = Math.max(0, x0 - edge)
  const ey0 = Math.max(0, y0 - edge)
  const ex1 = Math.min(w, x1 + edge)
  const ey1 = Math.min(h, y1 + edge)
  const ew = ex1 - ex0
  const ne = ew * (ey1 - ey0)
  if (edge > 0 && job.length < ne * channels) job = new Float32Array(ne * channels)
  const values = edge > 0 ? job : output

  readValues(image, ex0, ey0, ex1, ey1, values)
  if (cal) calibrateValues(cal, w * h, channels, w, ex0, ey0, ex1, ey1, values)
  if (edge === 0) return

  const rw = x1 - x0
  const nr = rw * (y1 - y0)
  for (let c = 0; c < channels; c++) {
    for (let y = y0; y < y1; y++) {
      const from = c * ne + (y - ey0) * ew + (x0 - ex0)
      output.set(values.subarray(from, from + rw), c * nr + (y - y0) * rw)
    }
  }
  // As `replaceDefective`: medians are taken from the values before any
  // replacement, and only the defective channel is replaced.
  const defects = cal!.defects!
  const onePlane = cal!.dark !== null && cal!.dark.channels === 1
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const bit = defects[y * w + x]
      if (bit === 0) continue
      for (let c = 0; c < channels; c++) {
        if ((bit & (1 << (onePlane ? 0 : c))) === 0) continue
        for (let j = 0; j < 8; j++) {
          const [dx, dy] = RING[j]
          neighbors[j] = values[c * ne + (y + dy - ey0) * ew + (x + dx - ex0)]
        }
        output[c * nr + (y - y0) * rw + (x - x0)] = median8(neighbors)
      }
    }
  }
}

/** Values read (and colour reconstructed as in `debayer`) in the rectangle, without calibration. */
function readValues(
  image: CompactImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  output: Float32Array
): void {
  const w = image.width
  const h = image.height
  const n = w * h
  const codes = image.codes
  const t = tableOf(image)
  const ew = x1 - x0
  const ne = ew * (y1 - y0)

  if (image.bayer === 'NONE') {
    for (let c = 0; c < image.planes; c++) {
      for (let y = y0; y < y1; y++) {
        const from = c * n + y * w
        const a = c * ne + (y - y0) * ew - x0
        for (let x = x0; x < x1; x++) output[a + x] = t[codes[from + x]]
      }
    }
    return
  }

  // Bilinear, with the same operations as `debayer` and the edge replicated
  // (rows and columns outside the image become the edge ones).
  const schema = image.bayer
  for (let y = y0; y < y1; y++) {
    const here = y * w
    const above = (y > 0 ? y - 1 : 0) * w
    const below = (y < h - 1 ? y + 1 : h - 1) * w
    // Colour depends only on the parity of the column.
    const cEven = colorAt(schema, 0, y)
    const cOdd = colorAt(schema, 1, y)
    for (let x = x0; x < x1; x++) {
      const k = (y - y0) * ew + (x - x0)
      const even = (x & 1) === 0
      const c = even ? cEven : cOdd
      const xs = x > 0 ? x - 1 : 0
      const xd = x < w - 1 ? x + 1 : w - 1
      const value = t[codes[here + x]]
      let r: number
      let g: number
      let b: number
      if (c === 1) {
        g = value
        const horizontal = (t[codes[here + xs]] + t[codes[here + xd]]) * 0.5
        const vertical = (t[codes[above + x]] + t[codes[below + x]]) * 0.5
        // Red is on the horizontal if the pixel to the right is.
        if ((even ? cOdd : cEven) === 0) {
          r = horizontal
          b = vertical
        } else {
          b = horizontal
          r = vertical
        }
      } else {
        g = (t[codes[here + xs]] + t[codes[here + xd]] + t[codes[above + x]] + t[codes[below + x]]) * 0.25
        const opposing =
          (t[codes[above + xs]] + t[codes[above + xd]] + t[codes[below + xs]] + t[codes[below + xd]]) * 0.25
        if (c === 0) {
          r = value
          b = opposing
        } else {
          b = value
          r = opposing
        }
      }
      output[k] = r
      output[ne + k] = g
      output[2 * ne + k] = b
    }
  }
}

/** In-place calibration of the values of the rectangle, with the operations of `calibrate`. */
function calibrateValues(
  cal: DeferredCalibration,
  n: number,
  channels: number,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  values: Float32Array
): void {
  const { dark, flat, bias } = cal
  const ew = x1 - x0
  const ne = ew * (y1 - y0)
  // The bias is subtracted only without a dark, as in `calibrate`.
  const toSubtract = dark ?? bias
  const s = toSubtract ? masterAccess(toSubtract, 0, n, w, x0, y0, x1, y1, MASTER_CHUNK_MARGIN) : null
  const f = flat ? masterAccess(flat, 1, n, w, x0, y0, x1, y1, MASTER_CHUNK_MARGIN) : null
  for (let c = 0; c < channels; c++) {
    const inverse = 1 / cal.flatMean[c]
    for (let y = y0; y < y1; y++) {
      const a = c * ne + (y - y0) * ew - x0
      const is = s ? c * s.plane + y * s.rowStride + s.offset : 0
      const iF = f ? c * f.plane + y * f.rowStride + f.offset : 0
      for (let x = x0; x < x1; x++) {
        let value = values[a + x]
        if (s) value -= s.data[is + x]
        if (f) {
          const correction = f.data[iF + x] * inverse
          value = correction > 0.02 ? value / correction : value
        }
        values[a + x] = value < 0 ? 0 : value > 1 ? 1 : value
      }
    }
  }
}

/**
 * Where to read the values of a master in the rectangle [x0, x1) × [y0, y1):
 * channel c of pixel (x, y) is at `data[c * plane + y * rowStride + x + offset]`.
 */
export interface MasterAccess {
  data: Float32Array
  plane: number
  rowStride: number
  offset: number
}

/**
 * Reconstructed pieces of master, one per slot (0 dark or bias, 1 flat),
 * with the rectangle they contain: they are reused.
 */
const masterPieces = [new Float32Array(0), new Float32Array(0)]
// The master is remembered without being retained: once the work is done, the memory is freed.
const masterRectangles: ({ m: WeakRef<KeptMaster>; x0: number; y0: number; x1: number; y1: number } | null)[] = [null, null]

/**
 * Pixels added around the piece of master needed by the sum: the frames of
 * the same tile, shifted slightly from one another, thus read the same
 * piece, reconstructed only once.
 */
export const MASTER_CHUNK_MARGIN = 32

/**
 * The values of a master in the rectangle. A whole master is read where it
 * is; for a compact one the rectangle is reconstructed, with the operations
 * of the colour reconstruction of frames (`readValues`), into a piece
 * reused with the same `slot`. The value of a pixel does not depend on the
 * piece in which it is reconstructed: if the piece already built contains
 * the rectangle it is read again, otherwise a piece widened by `margin` is
 * reconstructed.
 */
export function masterAccess(
  m: KeptMaster,
  slot: 0 | 1,
  n: number,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  margin = 0
): MasterAccess {
  if (!isCompact(m)) return { data: m.data, plane: n, rowStride: w, offset: 0 }
  let r = masterRectangles[slot]
  if (!r || r.m.deref() !== m || x0 < r.x0 || y0 < r.y0 || x1 > r.x1 || y1 > r.y1) {
    r = {
      m: new WeakRef(m),
      x0: Math.max(0, x0 - margin),
      y0: Math.max(0, y0 - margin),
      x1: Math.min(m.width, x1 + margin),
      y1: Math.min(m.height, y1 + margin)
    }
    const l = (r.x1 - r.x0) * (r.y1 - r.y0) * m.channels
    if (masterPieces[slot].length < l) masterPieces[slot] = new Float32Array(l)
    readValues(m, r.x0, r.y0, r.x1, r.y1, masterPieces[slot])
    masterRectangles[slot] = r
  }
  const ew = r.x1 - r.x0
  return { data: masterPieces[slot], plane: ew * (r.y1 - r.y0), rowStride: ew, offset: -r.y0 * ew - r.x0 }
}

/**
 * The whole frame, reconstructed and calibrated. For a frame that is
 * already whole it returns the same object.
 */
export function expand(
  image: HeldImage,
  allocate: (length: number) => Float32Array = (l) => new Float32Array(l)
): ImageData32 {
  if (!isCompact(image)) return image
  const { width: w, height: h, channels } = image
  const data = allocate(w * h * channels)
  rebuildRegion(image, 0, 0, w, h, data, false)
  const whole: ImageData32 = { width: w, height: h, channels, data }
  const cal = image.calibration
  if (!cal) return whole
  return calibrate(whole, {
    dark: cal.dark,
    flat: cal.flat,
    bias: cal.bias,
    correctDefectivePixels: cal.defects !== null,
    defectivePixelThreshold: cal.threshold,
    inPlace: true
  })
}

/* ---- Deferred calibration and shared memory ---- */

const sharedMasters = new WeakMap<KeptMaster, KeptMaster>()
const sharedDefects = new WeakMap<Uint8Array, Uint8Array>()
const computedMeans = new WeakMap<KeptMaster, { channels: number; means: number[] }>()

/**
 * The master in shared memory, copied only once: it travels with every
 * frame to the sum workers, and otherwise each would receive a copy.
 */
function sharedMaster(m: KeptMaster | null): KeptMaster | null {
  if (!m || !sharedMemoryAvailable) return m
  if (isShared(isCompact(m) ? m.codes : m.data)) return m
  let c = sharedMasters.get(m)
  if (!c) {
    if (isCompact(m)) {
      const codes = sharedUint16(m.codes.length)
      codes.set(m.codes)
      c = { ...m, codes }
    } else {
      c = sharedImage(m)
    }
    sharedMasters.set(m, c)
  }
  return c
}

/** The defective pixels of the dark, in shared memory (`defectMap` already prepares them that way). */
function defectPlanes(dark: KeptMaster, threshold: number): Uint8Array {
  const planes = defectMap(dark, threshold).planes
  if (isShared(planes) || !sharedMemoryAvailable) return planes
  let c = sharedDefects.get(planes)
  if (!c) {
    c = new Uint8Array(new SharedArrayBuffer(planes.length))
    c.set(planes)
    sharedDefects.set(planes, c)
  }
  return c
}

function meansOfFlat(flat: KeptMaster | null, channels: number, n: number): number[] {
  if (!flat) return flatMeans(null, channels, n)
  const note = computedMeans.get(flat)
  if (note && note.channels === channels) return note.means
  const means = flatMeans(flat, channels, n)
  computedMeans.set(flat, { channels, means })
  return means
}

/**
 * Attaches to the compact frame the calibration, which will be applied
 * every time it is reconstructed: the frame stays compact. Throws the same
 * error as `calibrate` if a master has different dimensions.
 */
export function deferredCalibration(
  image: CompactImage,
  options: { dark: KeptMaster | null; flat: KeptMaster | null; bias: KeptMaster | null; threshold?: number }
): CompactImage {
  checkMasterSizes(image.width, image.height, [options.dark, options.flat, options.bias])
  const dark = sharedMaster(options.dark)
  const flat = sharedMaster(options.flat)
  const bias = sharedMaster(options.bias)
  const threshold = options.threshold ?? 6
  return {
    ...image,
    calibration: {
      dark,
      flat,
      bias,
      flatMean: meansOfFlat(flat, image.channels, image.width * image.height),
      defects: dark ? defectPlanes(dark, threshold) : null,
      threshold
    }
  }
}

/**
 * The frame with all its data in shared memory, for the sum workers:
 * what already is shared is not copied.
 */
export function sharedHold(image: HeldImage): HeldImage {
  if (!isCompact(image)) return sharedImage(image)
  if (!sharedMemoryAvailable) return image
  let codes = image.codes
  if (!isShared(codes)) {
    codes = sharedUint16(image.codes.length)
    codes.set(image.codes)
  }
  const cal = image.calibration
  if (!cal) return codes === image.codes ? image : { ...image, codes }
  let defects = cal.defects
  if (defects && !isShared(defects)) {
    const copy = new Uint8Array(new SharedArrayBuffer(defects.length))
    copy.set(defects)
    defects = copy
  }
  return {
    ...image,
    codes,
    calibration: {
      ...cal,
      dark: sharedMaster(cal.dark),
      flat: sharedMaster(cal.flat),
      bias: sharedMaster(cal.bias),
      defects
    }
  }
}
