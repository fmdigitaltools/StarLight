import type { ImageData32, Wcs } from '@shared/types'
import { wcsInHeader } from '@core/astrometry/wcs'
import { t } from '@shared/i18n/i18n'

/**
 * Encoding of the image into file formats.
 *
 * PNG, JPEG and WebP are produced by the graphics engine's encoder, which
 * is native code and therefore very fast. TIFF, BMP and FITS are written
 * directly, because the graphics engine does not support them and because
 * only this way can 16 bits per channel be preserved.
 */

/** Converts the floating-point planes into an 8-bit RGBA buffer. */
export function toRgba8(image: ImageData32): Uint8ClampedArray {
  const n = image.width * image.height
  const output = new Uint8ClampedArray(n * 4)
  const three = image.channels === 3

  for (let i = 0; i < n; i++) {
    const r = image.data[i]
    const g = three ? image.data[n + i] : r
    const b = three ? image.data[2 * n + i] : r
    output[i * 4] = r * 255
    output[i * 4 + 1] = g * 255
    output[i * 4 + 2] = b * 255
    output[i * 4 + 3] = 255
  }

  return output
}

/** Encodes to PNG, JPEG or WebP using the system graphics engine. */
export async function encodeWithCanvas(
  image: ImageData32,
  mimeType: string,
  quality: number,
  drawExtra?: (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number
  ) => void
): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(t('coreEncoding.canvasUnavailable'))

  // The constructor requires a non-shared buffer: the explicit cast satisfies
  // the type checker without copying the data.
  const pixel = toRgba8(image) as Uint8ClampedArray<ArrayBuffer>
  const data = new ImageData(pixel, image.width, image.height)
  ctx.putImageData(data, 0, 0)

  // Elements drawn over the image (e.g. object markers).
  if (drawExtra) drawExtra(ctx, image.width, image.height)

  const blob = await canvas.convertToBlob({ type: mimeType, quality: quality / 100 })
  return blob.arrayBuffer()
}

/**
 * Encodes an uncompressed TIFF, 8 or 16 bits per channel.
 * The format is described by a table of fields sorted by tag number.
 */
export function encodeTiff(image: ImageData32, bit: 8 | 16): ArrayBuffer {
  const w = image.width
  const h = image.height
  const n = w * h
  const samples = 3
  const sampleByte = bit / 8
  const dataBytes = n * samples * sampleByte

  const fieldCount = 11
  const ifdStart = 8
  // IFD layout: the entry count, the entries, the pointer to the next IFD,
  // then the values that do not fit in four bytes.
  const ifdSize = 2 + fieldCount * 12 + 4
  const valuesStart = ifdStart + ifdSize
  // BitsPerSample needs three two-byte values.
  const valuesSize = 6
  const dataStart = valuesStart + valuesSize

  const buffer = new ArrayBuffer(dataStart + dataBytes)
  const view = new DataView(buffer)

  // Header: byte order, signature, offset of the first IFD.
  view.setUint8(0, 0x49)
  view.setUint8(1, 0x49)
  view.setUint16(2, 42, true)
  view.setUint32(4, ifdStart, true)

  view.setUint16(ifdStart, fieldCount, true)

  let position = ifdStart + 2

  /** Writes one IFD entry. Type 3 = SHORT, 4 = LONG. */
  function field(number: number, type: number, quantity: number, value: number): void {
    view.setUint16(position, number, true)
    view.setUint16(position + 2, type, true)
    view.setUint32(position + 4, quantity, true)
    if (type === 3 && quantity === 1) {
      // A single SHORT value is left-justified in the value field.
      view.setUint16(position + 8, value, true)
      view.setUint16(position + 10, 0, true)
    } else {
      view.setUint32(position + 8, value, true)
    }
    position += 12
  }

  field(256, 3, 1, w) // ImageWidth
  field(257, 3, 1, h) // ImageLength
  field(258, 3, 3, valuesStart) // BitsPerSample
  field(259, 3, 1, 1) // Compression: none
  field(262, 3, 1, 2) // PhotometricInterpretation: RGB
  field(273, 4, 1, dataStart) // StripOffsets
  field(277, 3, 1, samples) // SamplesPerPixel
  field(278, 3, 1, h) // RowsPerStrip
  field(279, 4, 1, dataBytes) // StripByteCounts
  field(284, 3, 1, 1) // PlanarConfiguration: chunky
  field(339, 3, 1, 1) // SampleFormat: unsigned integer

  view.setUint32(position, 0, true)

  for (let i = 0; i < 3; i++) view.setUint16(valuesStart + i * 2, bit, true)

  const three = image.channels === 3
  const max = bit === 16 ? 65535 : 255

  for (let i = 0; i < n; i++) {
    const r = image.data[i]
    const g = three ? image.data[n + i] : r
    const b = three ? image.data[2 * n + i] : r
    const base = dataStart + i * samples * sampleByte
    const values = [r, g, b]
    for (let c = 0; c < 3; c++) {
      const v = Math.round(Math.min(1, Math.max(0, values[c])) * max)
      if (bit === 16) view.setUint16(base + c * 2, v, true)
      else view.setUint8(base + c, v)
    }
  }

  return buffer
}

/** Encodes an uncompressed 24-bit BMP. */
export function encodeBmp(image: ImageData32): ArrayBuffer {
  const w = image.width
  const h = image.height
  const n = w * h
  // Each row is padded to a multiple of four bytes.
  const rowBytes = Math.ceil((w * 3) / 4) * 4
  const dataBytes = rowBytes * h
  const dataStart = 54

  const buffer = new ArrayBuffer(dataStart + dataBytes)
  const view = new DataView(buffer)

  view.setUint8(0, 0x42)
  view.setUint8(1, 0x4d)
  view.setUint32(2, dataStart + dataBytes, true)
  view.setUint32(10, dataStart, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, w, true)
  view.setInt32(22, h, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, dataBytes, true)

  const three = image.channels === 3

  // The format stores rows bottom-up, in BGR order.
  for (let y = 0; y < h; y++) {
    const sourceRow = (h - 1 - y) * w
    const destinationRow = dataStart + y * rowBytes
    for (let x = 0; x < w; x++) {
      const i = sourceRow + x
      const r = image.data[i]
      const g = three ? image.data[n + i] : r
      const b = three ? image.data[2 * n + i] : r
      const p = destinationRow + x * 3
      view.setUint8(p, Math.round(Math.min(1, Math.max(0, b)) * 255))
      view.setUint8(p + 1, Math.round(Math.min(1, Math.max(0, g)) * 255))
      view.setUint8(p + 2, Math.round(Math.min(1, Math.max(0, r)) * 255))
    }
  }

  return buffer
}

/**
 * The FITS standard allows only printable ASCII characters in the header:
 * accented letters become plain ones, anything else a question mark.
 */
function asciiOnly(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?')
}

/** Builds an 80-character FITS header card. */
function card(key: string, value: string | number | boolean, comment?: string): string {
  let text: string
  if (typeof value === 'string') {
    // A quote inside the text is doubled, as the standard requires.
    text = ("'" + asciiOnly(value).split("'").join("''") + "'").padEnd(20, ' ')
  } else if (typeof value === 'boolean') {
    text = (value ? 'T' : 'F').padStart(20, ' ')
  } else {
    // All the digits needed to read back the same number (distortion
    // coefficients are tiny), with an uppercase exponent E as in the standard.
    text = (Number.isFinite(value) ? String(value).toUpperCase() : '0').padStart(20, ' ')
  }
  let row = key.padEnd(8, ' ') + '= ' + text
  // No quotes in the comment: header readers look for the last quote to
  // find where a string value ends.
  if (comment !== undefined) row += ' / ' + asciiOnly(comment).replace(/'/g, ' ')
  return row.slice(0, 80).padEnd(80, ' ')
}

/** Acquisition keywords carried over from the source file. */
const KEYS_TO_KEEP = [
  // Object and pointing coordinates.
  'OBJECT', 'RA', 'DEC', 'OBJCTRA', 'OBJCTDEC', 'EQUINOX', 'RADESYS',
  // Date and duration.
  'DATE-OBS', 'DATE-END', 'DATE-EXP', 'DATE-LOC', 'DATE-AVG', 'MJD-OBS', 'JD',
  'EXPTIME', 'EXPOSURE', 'STACKCNT', 'NCOMBINE', 'TOTALEXP', 'LIVETIME',
  // Instrument, sensor and filter.
  'INSTRUME', 'TELESCOP', 'OBSERVER', 'FILTER', 'FOCALLEN', 'APERTURE', 'APTDIA',
  'XPIXSZ', 'YPIXSZ', 'XBINNING', 'YBINNING', 'GAIN', 'EGAIN', 'OFFSET', 'ISOSPEED',
  'CCD-TEMP', 'SET-TEMP', 'IMAGETYP',
  // Site.
  'SITELAT', 'SITELONG', 'SITEELEV'
]

/** Additional options of the FITS encoder. */
export interface FitsOptions {
  /**
   * Astrometric solution of the image as written (already adapted to crop
   * and resize): stored in the header as a TAN projection, with SIP
   * distortion when present.
   */
  wcs?: Wcs | null
  /**
   * New pixels per source pixel, horizontally and vertically, when the
   * image was resized: the declared pixel size (XPIXSZ, YPIXSZ) is
   * corrected accordingly, so that software deriving the scale from focal
   * length and pixel size still gets it right.
   */
  upscaling?: [number, number]
}

/**
 * Encodes a 16-bit FITS. Keeping the astronomical format lets the work
 * continue in other software without losing bit depth or acquisition data.
 *
 * With `bit` set to 32 the values are written as floating point, unrounded:
 * projects need this, since on reopening they must find the image exactly
 * as it was.
 */
export function encodeFits(
  image: ImageData32,
  originalMetadata: Record<string, string | number | boolean | null> = {},
  bit: 16 | 32 = 16,
  options: FitsOptions = {}
): ArrayBuffer {
  const real = bit === 32
  const w = image.width
  const h = image.height
  const n = w * h
  const planes = image.channels === 3 ? 3 : 1

  const cards: string[] = [
    card('SIMPLE', true, 'file conforms to the FITS standard'),
    real
      ? card('BITPIX', -32, '32-bit floating point')
      : card('BITPIX', 16, '16-bit signed integers'),
    card('NAXIS', planes === 3 ? 3 : 2, 'number of axes'),
    card('NAXIS1', w, 'width in pixels'),
    card('NAXIS2', h, 'height in pixels')
  ]
  if (planes === 3) cards.push(card('NAXIS3', 3, 'color channels'))
  if (!real) {
    cards.push(card('BZERO', 32768, 'offset for unsigned values'))
    cards.push(card('BSCALE', 1, 'scale factor'))
  }
  cards.push(card('CREATOR', 'StarLight', 'processing software'))

  // The useful keywords of the source file are preserved.
  const [inX, inY] = options.upscaling ?? [1, 1]
  for (const key of KEYS_TO_KEEP) {
    let value = originalMetadata[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'number' && key === 'XPIXSZ') value = value / inX
    if (typeof value === 'number' && key === 'YPIXSZ') value = value / inY
    cards.push(card(key, value))
  }

  // The astrometric solution, with this image's dimensions: if they do not
  // match, the solution belongs to a different geometry and is omitted.
  const wcs = options.wcs ?? null
  if (wcs !== null && (wcs.naxis1 <= 0 || (wcs.naxis1 === w && wcs.naxis2 === h))) {
    const header = wcsInHeader({ cards: {}, comments: {}, order: [] }, { ...wcs, naxis1: w, naxis2: h })
    if (originalMetadata['EQUINOX'] == null) cards.push(card('EQUINOX', 2000, 'equinox of the coordinates'))
    if (originalMetadata['RADESYS'] == null) cards.push(card('RADESYS', 'ICRS', 'reference frame'))
    for (const key of header.order) {
      if (key === 'NAXIS1' || key === 'NAXIS2') continue
      const value = header.cards[key]
      if (value === null || value === undefined) continue
      cards.push(card(key, value, header.comments[key]))
    }
  }

  cards.push('END'.padEnd(80, ' '))

  let headerText = cards.join('')
  const blocks = Math.ceil(headerText.length / 2880)
  headerText = headerText.padEnd(blocks * 2880, ' ')

  const dataBytes = Math.ceil((n * planes * (real ? 4 : 2)) / 2880) * 2880
  const buffer = new ArrayBuffer(headerText.length + dataBytes)
  const byte = new Uint8Array(buffer)

  for (let i = 0; i < headerText.length; i++) byte[i] = headerText.charCodeAt(i)

  const view = new DataView(buffer, headerText.length)

  // Data are big-endian, one plane after another.
  for (let c = 0; c < planes; c++) {
    const source = image.data.subarray(c * n, (c + 1) * n)
    if (real) {
      for (let i = 0; i < n; i++) {
        const v = source[i]
        // A single non-numeric value would make the image unreadable.
        view.setFloat32((c * n + i) * 4, Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0, false)
      }
      continue
    }
    for (let i = 0; i < n; i++) {
      const v = Math.round(Math.min(1, Math.max(0, source[i])) * 65535) - 32768
      view.setInt16((c * n + i) * 2, v, false)
    }
  }

  return buffer
}

/** MIME type and extension of each offered format. */
export const FORMATS = {
  png: { mime: 'image/png', extension: 'png', name: 'PNG', loss: false, bit: 8 },
  jpeg: { mime: 'image/jpeg', extension: 'jpg', name: 'JPEG', loss: true, bit: 8 },
  webp: { mime: 'image/webp', extension: 'webp', name: 'WebP', loss: true, bit: 8 },
  tiff: { mime: 'image/tiff', extension: 'tif', name: 'TIFF', loss: false, bit: 16 },
  bmp: { mime: 'image/bmp', extension: 'bmp', name: 'BMP', loss: false, bit: 8 },
  fits: { mime: 'application/fits', extension: 'fit', name: 'FITS', loss: false, bit: 16 }
} as const
