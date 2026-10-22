import { FitsError, InsufficientHead } from '@core/fits/common'
import { t } from '@shared/i18n/i18n'
import { inflateZlib } from './inflate'

/**
 * TIFF reader for already processed astronomical images (stacks exported
 * by other programs): 8, 16 and 32-bit integers, 32 and 64-bit floating
 * point, one or three channels, stripped or tiled, uncompressed or with
 * LZW, Deflate or PackBits compression, with or without a predictor.
 *
 * TIFF carries no exposure metadata or coordinates: callers receive only
 * the pixels and the dimensions. The first image in the file is read.
 */

export function isTiff(b: Uint8Array): boolean {
  if (b.length < 8) return false
  return (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42)
  )
}

/** BigTIFF (files over 4 GB): same signature with 43 instead of 42. */
export function isBigTiff(b: Uint8Array): boolean {
  if (b.length < 8) return false
  return (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 43 && b[3] === 0) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 43)
  )
}

/** Bytes occupied by one value of each TIFF type. */
const TYPE_BYTE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]

interface Labels {
  [tag: number]: number[]
}

/** Reads the first directory (IFD) and returns the tags with their values. */
function readDirectory(b: Uint8Array): { little: boolean; labels: Labels } {
  const little = b[0] === 0x49
  const outside = (p: number, n: number): void => {
    // Beyond the head that was read: more bytes (or the whole file) must be read.
    if (p + n > b.length) throw new InsufficientHead(Math.max(p + n + 65536, b.length * 2))
  }
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const u16 = (p: number): number => (outside(p, 2), v.getUint16(p, little))
  const u32 = (p: number): number => (outside(p, 4), v.getUint32(p, little))
  const ifd = u32(4)
  const n = u16(ifd)
  const labels: Labels = {}
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    const tag = u16(e)
    const type = u16(e + 2)
    const tally = u32(e + 4)
    const width = TYPE_BYTE[type] ?? 0
    if (width === 0 || tally === 0) continue
    // Values up to 4 bytes sit in the entry itself, the others elsewhere.
    const where = width * tally <= 4 ? e + 8 : u32(e + 8)
    // Strings (type 2) and opaque blocks are not needed.
    if (type === 2 || type === 7) continue
    outside(where, width * tally)
    const values: number[] = new Array(tally)
    for (let k = 0; k < tally; k++) {
      const p = where + k * width
      switch (type) {
        case 1:
          values[k] = v.getUint8(p)
          break
        case 6:
          values[k] = v.getInt8(p)
          break
        case 3:
          values[k] = v.getUint16(p, little)
          break
        case 8:
          values[k] = v.getInt16(p, little)
          break
        case 4:
          values[k] = v.getUint32(p, little)
          break
        case 9:
          values[k] = v.getInt32(p, little)
          break
        case 5:
          values[k] = v.getUint32(p, little) / (v.getUint32(p + 4, little) || 1)
          break
        case 10:
          values[k] = v.getInt32(p, little) / (v.getInt32(p + 4, little) || 1)
          break
        case 11:
          values[k] = v.getFloat32(p, little)
          break
        case 12:
          values[k] = v.getFloat64(p, little)
          break
      }
    }
    labels[tag] = values
  }
  return { little, labels }
}

interface Structure {
  little: boolean
  labels: Labels
  width: number
  height: number
  samples: number
  bit: number
  format: number
  compression: number
  photometry: number
  planar: boolean
  predictor: number
  bitpix: number
}

function structure(b: Uint8Array): Structure {
  if (isBigTiff(b)) {
    throw new FitsError(t('coreTiff.bigTiff'))
  }
  if (!isTiff(b)) throw new FitsError(t('coreTiff.notValid'))
  const { little, labels } = readDirectory(b)
  const oneItem = (tag: number, defaultValue: number): number => labels[tag]?.[0] ?? defaultValue
  const width = oneItem(256, 0)
  const height = oneItem(257, 0)
  const samples = oneItem(277, 1)
  const bit = oneItem(258, 1)
  const format = oneItem(339, 1) // 1 unsigned integer, 2 signed integer, 3 floating point
  const compression = oneItem(259, 1)
  const photometry = oneItem(262, samples >= 3 ? 2 : 1)
  const planar = oneItem(284, 1) === 2
  const predictor = oneItem(317, 1)
  if (width <= 0 || height <= 0) throw new FitsError(t('coreTiff.invalidSize'))
  const allBits = labels[258] ?? [bit]
  if (allBits.some((x) => x !== bit)) throw new FitsError(t('coreTiff.mixedDepths'))
  if (format === 3 ? bit !== 32 && bit !== 64 : bit !== 8 && bit !== 16 && bit !== 32) {
    throw new FitsError(t(format === 3 ? 'coreTiff.unsupportedFloatDepth' : 'coreTiff.unsupportedDepth', { bit }))
  }
  if (photometry === 3 && bit !== 8 && bit !== 16) throw new FitsError(t('coreTiff.paletteDepth'))
  if (![0, 1, 2, 3, 32803].includes(photometry)) {
    throw new FitsError(t('coreTiff.colorSpace', { photometry }))
  }
  if (![1, 5, 8, 32946, 32773].includes(compression)) {
    const names: Record<number, string> = { 6: 'JPEG', 7: 'JPEG', 34712: 'JPEG 2000', 50000: 'Zstandard', 34925: 'LZMA' }
    const method = names[compression]
    throw new FitsError(
      method !== undefined
        ? t('coreTiff.compressionNamed', { method })
        : t('coreTiff.compressionUnknown', { code: compression })
    )
  }
  const bitpix = format === 3 ? -bit : bit
  return { little, labels, width, height, samples, bit, format, compression, photometry, planar, predictor, bitpix }
}

/** Reads only the dimensions (for the library). */
export function readTiffHeader(b: Uint8Array): { width: number; height: number; channels: number; bitpix: number } {
  const s = structure(b)
  const channels = s.photometry === 2 || s.photometry === 3 ? 3 : 1
  return { width: s.width, height: s.height, channels, bitpix: s.bitpix }
}

// ---------------------------------------------------------------------------
// Decompressors
// ---------------------------------------------------------------------------

/** TIFF LZW: codes of 9 to 12 bits, read most significant bit first. */
function decompressLzw(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let op = 0
  // Dictionary: for each code, the previous code and the last byte.
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  const length = new Uint16Array(4096)
  const first = new Uint8Array(4096)
  for (let i = 0; i < 256; i++) {
    suffix[i] = i
    length[i] = 1
    first[i] = i
    prefix[i] = -1
  }
  let next = 258
  let amplitude = 9
  let previous = -1
  let accumulator = 0
  let nbit = 0
  let ip = 0
  const write = (code: number): void => {
    const l = length[code]
    let end = op + l
    if (end > expected) {
      // Data beyond what is expected: discarded without overrunning.
      let c = code
      for (let k = l - 1; k >= 0; k--) {
        if (op + k < expected) out[op + k] = suffix[c]
        c = prefix[c]
      }
      op = expected
      return
    }
    let c = code
    while (end > op) {
      out[--end] = suffix[c]
      c = prefix[c]
    }
    op += l
  }
  for (;;) {
    while (nbit < amplitude) {
      if (ip >= src.length) return out
      accumulator = ((accumulator << 8) | src[ip++]) >>> 0
      nbit += 8
    }
    const code = (accumulator >>> (nbit - amplitude)) & ((1 << amplitude) - 1)
    nbit -= amplitude
    if (code === 257) break // end of data
    if (code === 256) {
      next = 258
      amplitude = 9
      previous = -1
      continue
    }
    if (previous < 0) {
      if (code >= 256) throw new FitsError(t('coreTiff.invalidLzw'))
      write(code)
      previous = code
      continue
    }
    // New dictionary entry: the previous sequence plus the first byte of the
    // current one. If the code is exactly the one about to be created (the
    // "KwKwK" case) the first byte is that of the previous sequence.
    const newFirst = code < next ? first[code] : first[previous]
    if (code > next) throw new FitsError(t('coreTiff.invalidLzw'))
    if (next < 4096) {
      prefix[next] = previous
      suffix[next] = newFirst
      length[next] = length[previous] + 1
      first[next] = first[previous]
      next++
    }
    write(code)
    previous = code
    // TIFF widens the codes one step early ("early change").
    if (next + 1 >= 1 << amplitude && amplitude < 12) amplitude++
    if (op >= expected) break
  }
  return out
}

/** PackBits: runs of repeated bytes or bytes copied as they are. */
function decompressPackBits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let ip = 0
  let op = 0
  while (ip < src.length && op < expected) {
    const n = (src[ip++] << 24) >> 24
    if (n >= 0) {
      const l = Math.min(n + 1, expected - op, src.length - ip)
      out.set(src.subarray(ip, ip + l), op)
      ip += n + 1
      op += l
    } else if (n !== -128) {
      const l = Math.min(1 - n, expected - op)
      out.fill(src[ip++], op, op + l)
      op += l
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function readTiff(b: Uint8Array): { raw: Float32Array; width: number; height: number; channels: number; bitpix: number } {
  const s = structure(b)
  const { little, labels, width, height, bit, format, planar } = s
  const samples = s.samples
  const sampleByte = bit / 8
  const tiles = labels[322] !== undefined

  // Each "piece" is a strip or a tile: where it is and how big it is.
  const offsets = tiles ? labels[324] : labels[273]
  const counts = tiles ? labels[325] : labels[279]
  if (!offsets || offsets.length === 0) throw new FitsError(t('coreTiff.noPixelLocation'))
  const chunkWidth = tiles ? labels[322][0] : width
  const pieceHeight = tiles ? (labels[323]?.[0] ?? height) : Math.min(labels[278]?.[0] ?? height, height)
  const piecesX = Math.ceil(width / chunkWidth)
  const piecesY = Math.ceil(height / pieceHeight)
  const planePieces = piecesX * piecesY
  const pieceSamples = planar ? 1 : samples

  // Channels used: the first for gray, three for RGB; the others (alpha) are not.
  const palette = s.photometry === 3
  const channels = s.photometry === 2 || palette ? 3 : 1
  const usedValues = palette ? 1 : Math.min(channels, samples)
  if (s.photometry === 2 && samples < 3) throw new FitsError(t('coreTiff.rgbFewChannels'))

  const pixel = width * height
  const raw = new Float32Array(pixel * (palette ? 1 : channels))

  for (let plane = 0; plane < (planar ? samples : 1); plane++) {
    if (planar && plane >= usedValues) break
    for (let py = 0; py < piecesY; py++) {
      for (let px = 0; px < piecesX; px++) {
        const index = plane * planePieces + py * piecesX + px
        if (index >= offsets.length) throw new FitsError(t('coreTiff.incomplete'))
        const rows = tiles ? pieceHeight : Math.min(pieceHeight, height - py * pieceHeight)
        const rowBytes = chunkWidth * pieceSamples * sampleByte
        const expected = rowBytes * rows
        const start = offsets[index]
        const byteCount = counts?.[index] ?? expected
        if (start + byteCount > b.length) throw new FitsError(t('coreTiff.truncated'))
        const compressedItems = b.subarray(start, start + byteCount)
        let d: Uint8Array
        switch (s.compression) {
          case 1:
            d = compressedItems
            break
          case 5:
            d = decompressLzw(compressedItems, expected)
            break
          case 8:
          case 32946:
            d = inflateZlib(compressedItems, { size: expected })
            break
          default:
            d = decompressPackBits(compressedItems, expected)
        }
        if (d.length < expected) {
          const filled = new Uint8Array(expected)
          filled.set(d)
          d = filled
        } else if (d.buffer === b.buffer || d.byteOffset % 8 !== 0) {
          d = d.slice(0, expected)
        }

        // Predictors: horizontal differencing (2) or byte reordering of floating-point values (3).
        let bigEndian = !little
        if (s.predictor === 2) {
          undoHorizontalDifferencing(d, rows, chunkWidth, pieceSamples, sampleByte, little)
        } else if (s.predictor === 3) {
          undoFloatPredictor(d, rows, chunkWidth, pieceSamples, sampleByte)
          bigEndian = true
        }

        const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
        const le = !bigEndian
        const read: (p: number) => number =
          format === 3
            ? bit === 32
              ? (p) => view.getFloat32(p, le)
              : (p) => view.getFloat64(p, le)
            : format === 2
              ? bit === 8
                ? (p) => view.getInt8(p)
                : bit === 16
                  ? (p) => view.getInt16(p, le)
                  : (p) => view.getInt32(p, le)
              : bit === 8
                ? (p) => d[p]
                : bit === 16
                  ? (p) => view.getUint16(p, le)
                  : (p) => view.getUint32(p, le)

        const x0 = px * chunkWidth
        const y0 = py * pieceHeight
        const w = Math.min(chunkWidth, width - x0)
        const h = Math.min(rows, height - y0)
        for (let y = 0; y < h; y++) {
          const destRow = (y0 + y) * width + x0
          const srcRow = y * rowBytes
          for (let x = 0; x < w; x++) {
            if (planar) {
              raw[plane * pixel + destRow + x] = read(srcRow + x * sampleByte)
            } else {
              const base = srcRow + x * pieceSamples * sampleByte
              for (let c = 0; c < usedValues; c++) raw[c * pixel + destRow + x] = read(base + c * sampleByte)
            }
          }
        }
      }
    }
  }

  // Signed integer values shifted above zero, as FITS does with BZERO.
  if (format === 2 && bit === 16) for (let i = 0; i < raw.length; i++) raw[i] += 32768
  if (format === 2 && bit === 8) for (let i = 0; i < raw.length; i++) raw[i] += 128
  if (format === 2 && bit === 32) for (let i = 0; i < raw.length; i++) raw[i] += 2147483648

  // White = 0 (old scanners): invert.
  if (s.photometry === 0) {
    const max = format === 3 ? 1 : Math.pow(2, bit) - 1
    for (let i = 0; i < raw.length; i++) raw[i] = max - raw[i]
  }

  // Palette: each index becomes the color from the table (16-bit).
  if (palette) {
    const map = labels[320]
    const entries = 1 << bit
    if (!map || map.length < entries * 3) throw new FitsError(t('coreTiff.missingColorMap'))
    const rgb = new Float32Array(pixel * 3)
    for (let i = 0; i < pixel; i++) {
      const k = raw[i]
      rgb[i] = map[k]
      rgb[pixel + i] = map[entries + k]
      rgb[2 * pixel + i] = map[2 * entries + k]
    }
    return { raw: rgb, width, height, channels: 3, bitpix: 16 }
  }

  return { raw, width, height, channels, bitpix: s.bitpix }
}

/** Predictor 2: each sample is the difference from the previous one of the same channel. */
function undoHorizontalDifferencing(
  d: Uint8Array,
  rows: number,
  width: number,
  samples: number,
  sampleByte: number,
  little: boolean
): void {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const rowBytes = width * samples * sampleByte
  for (let y = 0; y < rows; y++) {
    const r = y * rowBytes
    if (sampleByte === 1) {
      for (let i = samples; i < width * samples; i++) d[r + i] = (d[r + i] + d[r + i - samples]) & 0xff
    } else if (sampleByte === 2) {
      for (let i = samples; i < width * samples; i++) {
        const p = r + i * 2
        v.setUint16(p, (v.getUint16(p, little) + v.getUint16(p - samples * 2, little)) & 0xffff, little)
      }
    } else if (sampleByte === 4) {
      for (let i = samples; i < width * samples; i++) {
        const p = r + i * 4
        v.setUint32(p, (v.getUint32(p, little) + v.getUint32(p - samples * 4, little)) >>> 0, little)
      }
    }
  }
}

/**
 * Predictor 3 (floating point): the bytes of each row are grouped by
 * significance (all the most significant ones first) and then differenced.
 * After this function the values are in big-endian order, whatever the
 * file's byte order.
 */
function undoFloatPredictor(
  d: Uint8Array,
  rows: number,
  width: number,
  samples: number,
  sampleByte: number
): void {
  const n = width * samples
  const rowBytes = n * sampleByte
  const tmp = new Uint8Array(rowBytes)
  for (let y = 0; y < rows; y++) {
    const r = y * rowBytes
    for (let i = samples; i < rowBytes; i++) d[r + i] = (d[r + i] + d[r + i - samples]) & 0xff
    tmp.set(d.subarray(r, r + rowBytes))
    for (let k = 0; k < n; k++) {
      for (let bb = 0; bb < sampleByte; bb++) d[r + k * sampleByte + bb] = tmp[bb * n + k]
    }
  }
}
