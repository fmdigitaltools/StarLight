import { LibRaw, LibRawError } from '@colorhythm/libraw-wasm'
import type {
  BayerPattern,
  FitsHeader,
  FitsReadResult,
  FitsValue,
  FrameMetadata,
  ImageData32,
  RawInfo
} from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { extractMetadata } from '@core/fits/header'
import { FitsError } from '@core/fits/common'
import { detectRaw } from './rawFormats'
import { demosaicXtrans } from './xtrans'

/**
 * Reader for camera RAW files (Canon CR2/CR3, Nikon NEF, Sony ARW,
 * Fujifilm RAF, Olympus ORF, Panasonic RW2, Pentax PEF, DNG and others).
 *
 * Decoding is done by LibRaw (https://www.libraw.org), compiled to
 * WebAssembly by the @colorhythm/libraw-wasm package: it runs in any worker
 * without external programs.
 *
 * Astrophotography needs the sensor data as it is, not the developed
 * photo: here the non-interpolated color mosaic is taken, linear, with no
 * white balance and no gamma curve, only cropped to the visible area of
 * the sensor. The result has the same shape as `readFits` (one plane plus
 * a Bayer pattern in the metadata) and therefore follows the same path as
 * raw FITS files: calibration, analysis, alignment, stacking, Bayer
 * drizzle and `debayer`.
 *
 * Usage: call `prepareRaw()` once per worker (it is asynchronous: it loads
 * WebAssembly); then `readRaw` and `readRawHeader` are synchronous like the
 * FITS readers. `rawReady()` tells whether preparation has happened.
 *
 * Two design choices worth knowing:
 * - The black level stays in the data (as in the FITS files of astronomical
 *   cameras, which have an offset): clipping the noise below black to zero
 *   would raise the mean of bias and dark frames and distort calibration.
 *   It is only equalized across channels, which in some cameras have
 *   slightly different blacks, and the remaining value is written to
 *   `metadata.raw`. The dark (or bias) removes it during calibration.
 * - The orientation is that of the sensor: the rotation the camera records
 *   for portrait shots is not applied, so lights, darks and flats stay
 *   superimposable pixel by pixel.
 */

let preparation: Promise<void> | null = null
let decoder: LibRaw | null = null
/** The LibRaw WebAssembly module: gives direct access to its memory. */
let module: Awaited<ReturnType<typeof LibRaw.initialize>> | null = null

/** True once LibRaw is loaded in this worker. */
export function rawReady(): boolean {
  return decoder !== null
}

/**
 * Loads LibRaw in this worker. It must be called (and awaited) once before
 * `readRaw`; subsequent calls do nothing.
 *
 * `wasm` is the content of the libraw.wasm file: in the application the
 * renderer supplies it, while in command-line tests it can be omitted and
 * the package reads it from node_modules.
 */
export function prepareRaw(wasm?: ArrayBuffer | Uint8Array): Promise<void> {
  if (preparation === null) {
    preparation = (async (): Promise<void> => {
      const binary =
        wasm === undefined
          ? undefined
          : wasm instanceof Uint8Array
            ? (wasm.slice().buffer as ArrayBuffer)
            : wasm
      // Trial compilation: if WebAssembly is forbidden (for example by the
      // page's security policy) a clear error is raised here; inside the
      // package the same error would go unanswered and the wait would
      // never end.
      if (binary !== undefined) await WebAssembly.compile(binary)
      const m = await LibRaw.initialize(binary)
      const d = new LibRaw()
      await d.waitUntilReady()
      // The package completes creation a moment later: wait until the
      // decoder is really usable.
      for (let i = 0; i < 50 && d.status !== 'ready'; i++) {
        await new Promise((r) => setTimeout(r, 0))
      }
      if (d.status !== 'ready') throw new Error(t('coreRawReader.libRawNotStarted'))
      module = m
      decoder = d
    })().catch((e: unknown) => {
      preparation = null
      throw e
    })
  }
  return preparation
}

/** True if the content (with the name, for TIFF-based RAW files) is a RAW. */
export function isRaw(byte: Uint8Array, fileName = ''): boolean {
  return detectRaw(byte, fileName) !== null
}

function ready(): LibRaw {
  if (decoder === null) {
    throw new FitsError(t('coreRawReader.notReady'))
  }
  return decoder
}

/**
 * Memory LibRaw currently occupies in this worker, in bytes (zero if not
 * loaded). WebAssembly memory grows up to the largest file decoded and is
 * never returned: whoever manages the workers uses it to know which ones
 * are worth closing when idle.
 */
export function rawMemory(): number {
  return module === null ? 0 : module.HEAPU8.length
}

/** Number by which the package identifies the decoder inside LibRaw. */
function handle(d: LibRaw): never {
  return (d as unknown as { lr: number }).lr as never
}

/**
 * Sensor pixels read directly from LibRaw's memory, without copying them:
 * the package's `getRawImage` makes a copy first, which on a 61-megapixel
 * sensor means 122 MB written and immediately discarded. The values are
 * the same. The view is valid only until the next call into LibRaw: create
 * it and use it right away. `step` is the distance, in values, between the
 * start of one row and the start of the next.
 */
function rawView(d: LibRaw): { data: Uint16Array; step: number } | null {
  if (module === null) return null
  const address = module._libraw_get_raw_image(handle(d))
  if (!address) return null
  const width = d.getRawWidth()
  const rowBytes = d.getRawPitch()
  const step = rowBytes ? rowBytes / 2 : width
  if (!Number.isInteger(step) || step < width) {
    throw new FitsError(t('coreRawReader.invalidLayout', { bytes: rowBytes }))
  }
  return { data: new Uint16Array(module.HEAPU8.buffer, address, step * d.getRawHeight()), step }
}

/** Readable error for a LibRaw failure. */
function explainError(e: unknown, format: string): FitsError {
  const original = e instanceof Error ? e.message : String(e)
  if (e instanceof LibRawError && /unsupported|not raw/i.test(original)) {
    return new FitsError(t('coreRawReader.unreadable', { format, detail: original }))
  }
  if (/alloc|memory/i.test(original)) {
    return new FitsError(t('coreRawReader.outOfMemory', { format, detail: original }))
  }
  return new FitsError(t('coreRawReader.readFailed', { format, detail: original }))
}

/** Passes the file bytes to LibRaw without needless copies. */
function open(d: LibRaw, byte: Uint8Array): void {
  const whole = byte.byteOffset === 0 && byte.byteLength === byte.buffer.byteLength
  d.open(whole ? byte.buffer : byte.slice().buffer)
}

/** Local date and time "YYYY-MM-DDTHH:MM:SS" of an instant. */
function localTime(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return (
    d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
    'T' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds())
  )
}

/** Readable text, discarding strings that contain control bytes. */
function cleaned(s: string | undefined | null): string | null {
  if (!s) return null
  const t = s.replace(/\0.*$/s, '').trim()
  return t !== '' && /^[\x20-\x7e -ÿ]+$/.test(t) ? t : null
}

/** Color layout of the sensor according to LibRaw. */
interface Matrix {
  type: RawInfo['matrix']
  /** Side of the repeating cell: 2 for Bayer, 6 for X-Trans, 1 for mono or color. */
  period: number
  /** Color (LibRaw index) of each pixel in the cell, row by row. */
  cell: number[]
  bayer: BayerPattern
}

function readMatrix(d: LibRaw, withColor3: boolean): Matrix {
  const filters = d.getFilters() >>> 0
  if (withColor3) return { type: 'color', period: 1, cell: [0], bayer: 'NONE' }
  if (filters === 0) return { type: 'mono', period: 1, cell: [0], bayer: 'NONE' }

  if (filters === 9) {
    const cell: number[] = []
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) cell.push(d.color(y, x))
    return { type: 'xtrans', period: 6, cell, bayer: 'NONE' }
  }

  // Bayer: the 2x2 cell must repeat identically across the whole sensor
  // (some old cameras used longer patterns, which are not handled here).
  const cell = [d.color(0, 0), d.color(0, 1), d.color(1, 0), d.color(1, 1)]
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (d.color(y, x) !== cell[(y & 1) * 2 + (x & 1)]) {
        throw new FitsError(t('coreRawReader.notBayer'))
      }
    }
  }
  const names = d.getIParams().cdesc // for example "RGBG": index 3 = second green
  const schema = cell.map((c) => names[c] ?? '?').join('')
  if (schema !== 'RGGB' && schema !== 'BGGR' && schema !== 'GRBG' && schema !== 'GBRG') {
    throw new FitsError(t('coreRawReader.unusualFilters', { pattern: schema }))
  }
  return { type: 'bayer', period: 2, cell, bayer: schema }
}

/** LibRaw value meaning "not recorded" in the temperature fields. */
const NOT_ANNOTATED = -1000

/**
 * Sensor temperature (or, failing that, camera body temperature) from the
 * maker notes. The sensor comes first, then the camera.
 *
 * In version 1.1.1 of @colorhythm/libraw-wasm the description of the
 * `common` structure does not match LibRaw 0.22: the named fields read
 * zeros, and the real temperatures end up inside the `firmware` field,
 * from byte 33 onward, in LibRaw's order (camera, sensor, sensor 2, ...).
 * Verified on cameras from several makers. The named fields are used if the
 * package ever reads them correctly; otherwise that position is used, but
 * only if LibRaw's -1000 placeholder appears there, which confirms the
 * layout: if the package changes, no arbitrary number is returned.
 */
function readTemperature(commonItems: {
  CameraTemperature: number
  SensorTemperature: number
  SensorTemperature2: number
  firmware: readonly number[]
}): number | null {
  const isValid = (t: number): boolean => Number.isFinite(t) && t > -60 && t < 100
  const round = (t: number): number => Math.round(t * 10) / 10

  for (const t of [commonItems.SensorTemperature, commonItems.SensorTemperature2, commonItems.CameraTemperature]) {
    if (isValid(t) && t !== 0) return round(t)
  }

  const byte = Uint8Array.from(commonItems.firmware)
  if (byte.length < 33 + 4 * 7) return null
  const view = new DataView(byte.buffer)
  const values: number[] = []
  for (let k = 0; k < 7; k++) values.push(view.getFloat32(33 + 4 * k, true))
  if (!values.includes(NOT_ANNOTATED)) return null
  const [camera, sensor, sensor2] = values
  for (const t of [sensor, sensor2, camera]) {
    if (t !== NOT_ANNOTATED && isValid(t)) return round(t)
  }
  return null
}

/** Clean exposure time: LibRaw gives it as a floating-point number. */
function exposure(seconds: number): number | null {
  return seconds > 0 ? Number(seconds.toPrecision(5)) : null
}

/** Metadata and FITS-style header derived from the camera data. */
function describe(
  d: LibRaw,
  format: string,
  fileName: string,
  matrix: Matrix,
  black: number,
  white: number
): { header: FitsHeader; metadata: FrameMetadata } {
  const ip = d.getIParams()
  const others = d.getImgOther()
  const target = d.getLensInfo()
  const width = d.getActiveWidth()
  const height = d.getActiveHeight()

  const cards: Record<string, FitsValue> = {}
  const comments: Record<string, string> = {}
  const order: string[] = []
  const put = (key: string, value: FitsValue, comment?: string): void => {
    if (value === null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return
    if (!(key in cards)) order.push(key)
    cards[key] = value
    if (comment) comments[key] = comment
  }

  const colors = matrix.type === 'xtrans' || matrix.type === 'color'
  put('NAXIS', colors ? 3 : 2)
  put('NAXIS1', width)
  put('NAXIS2', height)
  if (colors) put('NAXIS3', 3)
  put('BITPIX', 16)

  const make = cleaned(ip.make) ?? ''
  const model = cleaned(ip.model) ?? ''
  const camera = model.toLowerCase().startsWith(make.toLowerCase()) ? model : (make + ' ' + model).trim()
  put('INSTRUME', camera, 'Camera')
  const lens = cleaned(target.Lens) ?? cleaned(target.makernotes.Lens)
  put('TELESCOP', lens, 'Lens reported by the camera')
  put('EXPTIME', exposure(others.shutter), '[s] Exposure time')
  put('ISOSPEED', others.iso_speed > 0 ? others.iso_speed : null, 'ISO speed')
  put('FOCALLEN', others.focal_len > 0 ? others.focal_len : null, '[mm] Focal length')
  put('APERTURE', others.aperture > 0 ? Math.round(others.aperture * 10) / 10 : null, 'Aperture f-number')

  // Camera clocks record local time, without a time zone: LibRaw converts
  // it to an instant using the computer's time zone, i.e. it assumes that
  // camera and computer share the same zone. DATE-OBS is in universal time
  // as the FITS standard requires; DATE-LOC is the time as read.
  const seconds = Number(others.timestamp)
  let cameraTime: string | null = null
  if (Number.isFinite(seconds) && seconds > 0) {
    const timestamp = new Date(seconds * 1000)
    cameraTime = localTime(timestamp)
    put('DATE-OBS', timestamp.toISOString().slice(0, 19), 'UTC, from the camera local time')
    put('DATE-LOC', cameraTime, 'Time recorded by the camera')
  }

  // Temperature: some models record the sensor temperature, many only the
  // camera body temperature, which tracks it closely.
  let temperature: number | null = null
  try {
    temperature = readTemperature(d.getMakernotes().common)
  } catch {
    // The maker notes are optional: carry on without them.
  }
  put('CCD-TEMP', temperature, '[C] Sensor or camera temperature')

  if (matrix.type === 'bayer') {
    put('BAYERPAT', matrix.bayer, 'Bayer pattern from the first visible pixel')
    put('ROWORDER', 'TOP-DOWN')
  }
  put('CFATYPE', matrix.type === 'xtrans' ? 'X-TRANS' : matrix.type.toUpperCase())

  // White balance chosen by the camera: only a suggestion. If the camera
  // does not record it (all multipliers equal, as on some models), the
  // model's "daylight" balance is used instead.
  let mul = [d.getCamMul(0), d.getCamMul(1), d.getCamMul(2)]
  if (mul[0] === mul[1] && mul[1] === mul[2]) mul = [d.getPreMul(0), d.getPreMul(1), d.getPreMul(2)]
  const balance: [number, number, number] | null =
    mul.every((m) => Number.isFinite(m) && m > 0)
      ? [mul[0] / mul[1], 1, mul[2] / mul[1]]
      : null
  if (balance) {
    put('WBRED', Math.round(balance[0] * 10000) / 10000, 'Camera white balance R/G (not applied)')
    put('WBBLUE', Math.round(balance[2] * 10000) / 10000, 'Camera white balance B/G (not applied)')
  }

  const pedestal = white > 0 ? black / white : 0
  put('BLKLEVEL', black, '[ADU] Black level, left in the data')
  put('WHTLEVEL', white, '[ADU] Saturation level, equal to 1')
  put('RAWFMT', format, 'Source RAW format')
  put('RAWLIB', 'LibRaw ' + LibRaw.version(), 'RAW decoder')

  const header: FitsHeader = { cards, comments, order }
  const metadata = extractMetadata(header, fileName)
  metadata.raw = {
    format,
    blackLevel: black,
    whiteLevel: white,
    pedestal,
    whiteBalance: balance,
    cameraTime,
    matrix: matrix.type
  }
  return { header, metadata }
}

/** Black levels (by LibRaw color index) and saturation level. */
function levels(d: LibRaw): { blacks: number[]; white: number } {
  const blacks = [0, 1, 2, 3].map((i) => {
    const v = d.getBlackLevel(i)
    return Number.isFinite(v) && v > 0 ? v : 0
  })
  const max = d.getColorMaximum()
  return { blacks, white: Number.isFinite(max) && max > 0 ? max : 65535 }
}

/**
 * Reads a complete RAW. Returns the same shape as `readFits`: one raw
 * plane (or three for X-Trans and already-color DNG files) in [0,1],
 * metadata with Bayer pattern, exposure, ISO as gain, date, camera, lens,
 * focal length and temperature if recorded.
 */
export function readRaw(byte: Uint8Array, fileName = ''): FitsReadResult {
  const d = ready()
  const format = detectRaw(byte, fileName) ?? 'RAW'
  try {
    open(d, byte)
    d.unpack()

    const withRaw = rawView(d) !== null
    const color3 = withRaw ? null : d.getColor3Image()
    const color4 = withRaw || color3 !== null ? null : d.getColor4Image()
    if (!withRaw && color3 === null && color4 === null) {
      throw new FitsError(t('coreRawReader.noSensorData', { format }))
    }

    const matrix = readMatrix(d, !withRaw)
    const w = d.getActiveWidth()
    const h = d.getActiveHeight()
    const sx = d.getLeftMargin()
    const sy = d.getTopMargin()
    const rawWidth = d.getRawWidth()
    if (w <= 0 || h <= 0 || sx + w > rawWidth || sy + h > d.getRawHeight()) {
      throw new FitsError(t('coreRawReader.invalidSensorSize', { width: w, height: h }))
    }

    const { blacks, white } = levels(d)
    // The lowest black among the channels stays as a common pedestal; from
    // the other channels only the difference is removed, so the colors
    // start level.
    const usedValues = matrix.type === 'bayer' || matrix.type === 'xtrans' ? matrix.cell : [0, 1, 2]
    const black = Math.min(...usedValues.map((c) => blacks[c]))
    const inv = 1 / white
    let image: ImageData32

    if (withRaw) {
      const p = matrix.period
      const remove = new Float32Array(p * p)
      for (let k = 0; k < p * p; k++) remove[k] = blacks[matrix.cell[k]] - black
      const data = new Float32Array(w * h)
      // The view is taken here, after the last allocation: the pixels stay
      // in LibRaw's memory and are converted without intermediate copies.
      const { data: raw, step } = rawView(d) as { data: Uint16Array; step: number }
      for (let y = 0; y < h; y++) {
        const row = (y + sy) * step + sx
        const base = (y % p) * p
        const o = y * w
        for (let x = 0; x < w; x++) {
          const v = (raw[row + x] - remove[base + (x % p)]) * inv
          data[o + x] = v < 0 ? 0 : v > 1 ? 1 : v
        }
      }
      image =
        matrix.type === 'xtrans'
          ? demosaicXtrans(data, w, h, (yy, xx) => matrix.cell[(yy % 6) * 6 + (xx % 6)])
          : { width: w, height: h, channels: 1, data: data }
    } else {
      // Linear DNG and similar: the colors are already reconstructed,
      // interleaved.
      const source = (color3 ?? color4) as Uint16Array
      const step = color3 !== null ? 3 : 4
      const n = w * h
      const data = new Float32Array(n * 3)
      for (let c = 0; c < 3; c++) {
        const remove = blacks[c] - black
        for (let y = 0; y < h; y++) {
          const row = ((y + sy) * rawWidth + sx) * step + c
          const o = c * n + y * w
          for (let x = 0; x < w; x++) {
            const v = (source[row + x * step] - remove) * inv
            data[o + x] = v < 0 ? 0 : v > 1 ? 1 : v
          }
        }
      }
      image = { width: w, height: h, channels: 3, data: data }
    }

    const { header, metadata } = describe(d, format, fileName, matrix, black, white)
    return { header, metadata, image: image, bitpix: 16, sizeBytes: byte.length }
  } catch (e) {
    if (e instanceof FitsError) throw e
    throw explainError(e, format)
  } finally {
    // Immediately release LibRaw's memory (file and sensor data).
    d.recycle()
  }
}

/**
 * Reads only the exposure metadata, without decoding the pixels: used to
 * populate the library. Unlike FITS, LibRaw needs the whole file (in many
 * formats the exposure metadata is not at the start), but reading it costs
 * only a few tens of milliseconds.
 */
export function readRawHeader(
  byte: Uint8Array,
  fileName = ''
): {
  header: FitsHeader
  metadata: FrameMetadata
  width: number
  height: number
  bitpix: number
  channels: 1 | 3
} {
  const d = ready()
  const format = detectRaw(byte, fileName) ?? 'RAW'
  try {
    open(d, byte)
    // Without decoding it is not yet known whether a DNG is already color:
    // the number of samples per pixel says so, which LibRaw reports as
    // "colors" with filters at zero; a monochrome sensor has a single color.
    const filters = d.getFilters() >>> 0
    const alreadyColor = filters === 0 && d.getColors() >= 3
    const matrix = readMatrix(d, alreadyColor)
    const { blacks, white } = levels(d)
    const usedValues = matrix.type === 'bayer' || matrix.type === 'xtrans' ? matrix.cell : [0, 1, 2]
    const black = Math.min(...usedValues.map((c) => blacks[c]))
    const { header, metadata } = describe(d, format, fileName, matrix, black, white)
    return {
      header,
      metadata,
      width: d.getActiveWidth(),
      height: d.getActiveHeight(),
      bitpix: 16,
      channels: matrix.type === 'xtrans' || matrix.type === 'color' ? 3 : 1
    }
  } catch (e) {
    if (e instanceof FitsError) throw e
    throw explainError(e, format)
  } finally {
    d.recycle()
  }
}

/** Preview that the camera embedded in the RAW. */
export interface RawPreview {
  /** 'jpeg': `byte` is a JPEG file; 'rgb': 8-bit pixels, `channels` per pixel, row by row. */
  type: 'jpeg' | 'rgb'
  width: number
  height: number
  /** Values per pixel in the 'rgb' data (3 for color, 1 for black and white). */
  channels: number
  byte: Uint8Array
  /**
   * Width divided by height of the visible area of the sensor. Many small
   * previews are 4:3 with black bars above and below a 3:2 image: this
   * ratio is used to crop out the useful part.
   */
  aspectRatios: number
}

/** Preview formats according to LibRaw (enum LibRaw_thumbnail_formats). */
const PREVIEW_JPEG = 1
const PREVIEW_BITMAP = 2

/**
 * Reads the smallest preview embedded in the RAW that has at least
 * `minSide` pixels per side in its useful part. Used for the library
 * thumbnails: fetching it costs a few milliseconds, whereas decoding the
 * sensor data costs from a tenth of a second to two seconds and a few
 * hundred megabytes of memory. Returns null if none is suitable (the RAW
 * is then decoded).
 *
 * The preview is the photo developed by the camera, not the sensor data:
 * good for recognizing the frame, not for measuring it.
 */
export function readRawPreview(byte: Uint8Array, fileName = '', minSide = 96): RawPreview | null {
  const d = ready()
  const format = detectRaw(byte, fileName) ?? 'RAW'
  const m = module
  if (m === null) return null
  try {
    open(d, byte)
    const aw = d.getActiveWidth()
    const ah = d.getActiveHeight()
    if (aw <= 0 || ah <= 0) return null
    const aspectRatios = aw / ah

    /** Description of the most recently extracted preview (libraw_thumbnail_t structure). */
    const description = (): { format: number; w: number; h: number; length: number; colors: number; address: number } => {
      const p = m._libraw_get_thumbnail(handle(d)) as number
      const v = new DataView(m.HEAPU8.buffer, p, 20)
      return {
        format: v.getInt32(0, true),
        w: v.getUint16(4, true),
        h: v.getUint16(6, true),
        length: v.getUint32(8, true),
        colors: v.getInt32(12, true),
        address: v.getUint32(16, true)
      }
    }

    let choice = -1
    let chosenArea = Infinity
    // LibRaw lists at most eight; when they run out it responds with an error.
    for (let i = 0; i < 8; i++) {
      try {
        d.unpackThumbEx(i)
      } catch {
        break
      }
      const t = description()
      if (t.w <= 0 || t.h <= 0 || t.address === 0) continue
      const fit =
        t.format === PREVIEW_JPEG ||
        (t.format === PREVIEW_BITMAP && (t.colors === 3 || t.colors === 1) && t.length >= t.w * t.h * t.colors)
      if (!fit) continue
      // A preview rotated relative to the sensor (portrait shots) is not
      // used: frames are shown in the sensor orientation.
      if (t.w >= t.h !== aw >= ah) continue
      const usableW = Math.min(t.w, t.h * aspectRatios)
      const usableH = Math.min(t.h, t.w / aspectRatios)
      if (Math.min(usableW, usableH) < minSide) continue
      if (t.w * t.h < chosenArea) {
        chosenArea = t.w * t.h
        choice = i
      }
    }
    if (choice < 0) return null

    d.unpackThumbEx(choice)
    const t = description()
    return {
      type: t.format === PREVIEW_JPEG ? 'jpeg' : 'rgb',
      width: t.w,
      height: t.h,
      channels: t.format === PREVIEW_JPEG ? 3 : t.colors,
      byte: m.HEAPU8.slice(t.address, t.address + t.length),
      aspectRatios
    }
  } catch (e) {
    if (e instanceof FitsError) throw e
    throw explainError(e, format)
  } finally {
    d.recycle()
  }
}
