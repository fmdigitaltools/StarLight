import type { FitsHeader, FitsValue } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { FitsError } from '@core/fits/common'
import { gunzip } from './inflate'
import { decompressHcompress } from './hcompress'

/**
 * Tile-compressed FITS (the "tiled image compression" convention of the
 * FITS 4.0 standard, used by .fz files produced by fpack and by many
 * professional archives).
 *
 * The image is divided into tiles (usually one row each); each tile is
 * compressed separately and stored in a row of a binary table (BINTABLE).
 * The keywords of the original image are the same, with a Z in front of
 * the structural ones: ZBITPIX, ZNAXIS1...
 *
 * Supported algorithms: RICE_1 (the most common, the fpack default),
 * GZIP_1, GZIP_2, HCOMPRESS_1 (hcompress.ts, including lossy mode with
 * smoothing), PLIO_1 (masks of non-negative integers) and uncompressed
 * tiles.
 *
 * Floating-point images are usually "quantized": each tile is converted to
 * integers with its own scale (ZSCALE) and zero point (ZZERO), with a known
 * pseudo-random noise added (dithering), which is subtracted here, exactly
 * as the reference library cfitsio does.
 */

/** Whether a header belongs to a tile-compressed image. */
export function isCompressedImage(h: FitsHeader): boolean {
  return h.cards['ZIMAGE'] === true && String(h.cards['XTENSION'] ?? '').trim() === 'BINTABLE'
}

function number(h: FitsHeader, key: string, defaultValue: number): number {
  const v = h.cards[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : defaultValue
}

function text(h: FitsHeader, key: string): string {
  const v = h.cards[key]
  return typeof v === 'string' ? v.trim().toUpperCase() : ''
}

/** Keywords that describe the table, not the image. */
const TABLE_STRUCTURE = /^(XTENSION|BITPIX|NAXIS\d*|PCOUNT|GCOUNT|TFIELDS|TTYPE\d+|TFORM\d+|TUNIT\d+|TSCAL\d+|TZERO\d+|TNULL\d+|TDIM\d+|TDISP\d+|THEAP|CHECKSUM|DATASUM|EXTNAME|EXTEND|SIMPLE)$/
/** Compression keywords, which disappear once the image is decompressed. */
const COMPRESSION_KEYS = /^(ZIMAGE|ZSIMPLE|ZTENSION|ZEXTEND|ZBITPIX|ZNAXIS\d*|ZTILE\d+|ZCMPTYPE|ZNAME\d+|ZVAL\d+|ZMASKCMP|ZQUANTIZ|ZDITHER0|ZSCALE|ZZERO|ZBLANK|ZHECKSUM|ZDATASUM|ZPCOUNT|ZGCOUNT|ZBLOCKED)$/

/**
 * Rebuilds the image header as if the file were not compressed: the real
 * SIMPLE, BITPIX and NAXIS, then all the descriptive keywords (object,
 * exposure, coordinates...). Those of the primary section, if present, apply
 * when the table does not repeat them.
 */
export function buildImageHeader(table: FitsHeader, primary: FitsHeader | null): FitsHeader {
  const cards: Record<string, FitsValue> = {}
  const comments: Record<string, string> = {}
  const order: string[] = []
  const put = (k: string, v: FitsValue, c?: string): void => {
    if (!(k in cards)) order.push(k)
    cards[k] = v
    if (c) comments[k] = c
  }

  put('SIMPLE', true)
  put('BITPIX', number(table, 'ZBITPIX', 16))
  const axes = number(table, 'ZNAXIS', 2)
  put('NAXIS', axes)
  for (let a = 1; a <= axes; a++) put('NAXIS' + a, number(table, 'ZNAXIS' + a, 0))

  const copy = (h: FitsHeader): void => {
    for (const k of h.order) {
      if (k in cards) continue
      if (TABLE_STRUCTURE.test(k) || COMPRESSION_KEYS.test(k)) continue
      put(k, h.cards[k], h.comments[k])
    }
  }
  copy(table)
  if (primary) copy(primary)
  return { cards, comments, order }
}

/** Description of a column of the binary table. */
interface Column {
  name: string
  /** Position of the field from the start of the row, in bytes. */
  position: number
  /** Type code (B, I, J, K, E, D...); P or Q for variable-length arrays. */
  type: string
  /** Type of the elements of a variable-length array. */
  itemType: string
}

const TYPE_BYTE: Record<string, number> = { L: 1, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 }

function readColumns(h: FitsHeader): Column[] {
  const n = number(h, 'TFIELDS', 0)
  const columns: Column[] = []
  let position = 0
  for (let i = 1; i <= n; i++) {
    const shape = text(h, 'TFORM' + i)
    const m = /^(\d*)([A-Z])([A-Z])?/.exec(shape)
    if (!m) throw new FitsError(t('coreCompressedFits.invalidTable', { index: i, shape }))
    const repetitions = m[1] === '' ? 1 : Number(m[1])
    const type = m[2]
    let byte: number
    if (type === 'X') byte = Math.ceil(repetitions / 8)
    else byte = (TYPE_BYTE[type] ?? 0) * repetitions
    columns.push({ name: text(h, 'TTYPE' + i), position, type, itemType: m[3] ?? '' })
    position += byte
  }
  return columns
}

/** Reads a big-endian number of a FITS type. */
function readValue(v: DataView, p: number, type: string): number {
  switch (type) {
    case 'B':
      return v.getUint8(p)
    case 'I':
      return v.getInt16(p, false)
    case 'J':
      return v.getInt32(p, false)
    case 'K':
      return Number(v.getBigInt64(p, false))
    case 'E':
      return v.getFloat32(p, false)
    case 'D':
      return v.getFloat64(p, false)
    default:
      throw new FitsError(t('coreCompressedFits.unexpectedColumnType', { type }))
  }
}

// ---------------------------------------------------------------------------
// Rice
// ---------------------------------------------------------------------------

/**
 * Rice decompression, a transcription of the cfitsio algorithm
 * (fits_rdecomp): each block of `block` pixels encodes the differences
 * between successive pixels with its own Rice parameter. `bytepix` is the
 * width of the original integers (1, 2 or 4 bytes).
 */
export function decompressRice(c: Uint8Array, n: number, block: number, bytepix: number): Int32Array {
  const output = new Int32Array(n)
  let fsbits: number, fsmax: number, bbits: number
  if (bytepix === 1) {
    fsbits = 3
    fsmax = 6
    bbits = 8
  } else if (bytepix === 2) {
    fsbits = 4
    fsmax = 14
    bbits = 16
  } else if (bytepix === 4) {
    fsbits = 5
    fsmax = 25
    bbits = 32
  } else {
    throw new FitsError(t('coreCompressedFits.riceBytesPerPixel', { bytes: bytepix }))
  }
  const mask = bbits === 32 ? 0xffffffff : (1 << bbits) - 1
  const end = c.length
  let ip = 0
  const byte = (): number => (ip < end ? c[ip++] : (ip++, 0))

  // The first pixel is written in full.
  let last = 0
  for (let k = 0; k < bytepix; k++) last = ((last << 8) | byte()) >>> 0
  let b = byte()
  let nbits = 8

  for (let i = 0; i < n; ) {
    nbits -= fsbits
    while (nbits < 0) {
      b = (b << 8) | byte()
      nbits += 8
    }
    const fs = (b >>> nbits) - 1
    b &= (1 << nbits) - 1
    let imax = i + block
    if (imax > n) imax = n

    if (fs < 0) {
      // Block with zero differences: all pixels equal to the previous one.
      for (; i < imax; i++) output[i] = last
    } else if (fs === fsmax) {
      // High-entropy block: differences written in full.
      for (; i < imax; i++) {
        let k = bbits - nbits
        let diff = nbits === 0 ? 0 : (b << k) >>> 0
        for (k -= 8; k >= 0; k -= 8) {
          b = byte()
          diff = (diff | (b << k)) >>> 0
        }
        if (nbits > 0) {
          b = byte()
          diff = (diff | (b >>> -k)) >>> 0
          b &= (1 << nbits) - 1
        } else {
          b = 0
        }
        const d = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1)
        last = ((d + last) & mask) >>> 0
        output[i] = last
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) {
          nbits += 8
          b = byte()
        }
        const nzero = nbits - (32 - Math.clz32(b))
        nbits -= nzero + 1
        b ^= 1 << nbits
        nbits -= fs
        while (nbits < 0) {
          b = (b << 8) | byte()
          nbits += 8
        }
        const diff = ((nzero << fs) | (b >>> nbits)) >>> 0
        b &= (1 << nbits) - 1
        const d = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1)
        last = ((d + last) & mask) >>> 0
        output[i] = last
      }
    }
  }

  // Signed integers of the original width (8-bit values are unsigned).
  if (bytepix === 2) for (let i = 0; i < n; i++) output[i] = (output[i] << 16) >> 16
  else if (bytepix === 4) for (let i = 0; i < n; i++) output[i] = output[i] | 0
  return output
}

// ---------------------------------------------------------------------------
// PLIO
// ---------------------------------------------------------------------------

/**
 * PLIO_1 decompression, the "line list" of IRAF masks (D. Tody, NOAO): a
 * series of 16-bit big-endian words, each with a code in the top 3 bits
 * and a datum in the low 12. After a header of 3 or 5 words, the codes
 * mean:
 * 0 as many zeros as the datum; 1 new current value (datum and following
 * word as the high 12 bits); 2 and 3 current value plus or minus the
 * datum; 4 as many pixels of the current value as the datum; 5 zeros and
 * then one pixel of the current value, "datum" pixels in all; 6 and 7
 * current value plus or minus the datum, written to a single pixel.
 * The format is that of pl_l2pi in IRAF (permissive license), rewritten
 * here.
 */
export function decompressPlio(c: Uint8Array, n: number): Int32Array {
  const output = new Int32Array(n)
  const words = c.length >> 1
  const v = new DataView(c.buffer, c.byteOffset, c.byteLength)
  // 1-based indices, as in the original format.
  const word = (i: number): number => (i >= 1 && i <= words ? v.getInt16((i - 1) * 2, false) : 0)
  if (words < 3) throw new FitsError(t('coreCompressedFits.plioTruncated'))
  let length: number
  let before: number
  if (word(3) > 0) {
    length = word(3)
    before = 4
  } else {
    length = (word(5) << 15) + word(4)
    before = word(2) + 1
  }
  if (length > words) throw new FitsError(t('coreCompressedFits.plioTruncated'))
  let o = 0
  let x = 0
  let value = 1
  for (let ip = before; ip <= length && x < n; ip++) {
    const w = word(ip)
    const code = w >> 12
    const datum = w & 4095
    switch (code) {
      case 0:
      case 4:
      case 5: {
        // A run of "datum" pixels.
        const end = Math.min(x + datum, n)
        const fill = code === 4 ? value : 0
        for (; o < end; o++) output[o] = fill
        if (code === 5 && x + datum <= n && datum > 0) output[end - 1] = value
        x += datum
        break
      }
      case 1:
        value = (word(ip + 1) << 12) + datum
        ip++
        break
      case 2:
        value += datum
        break
      case 3:
        value -= datum
        break
      case 6:
      case 7:
        value += code === 6 ? datum : -datum
        if (o < n) output[o++] = value
        x++
        break
    }
  }
  // The remainder, if the list ends early, is zero (already so).
  return output
}

// ---------------------------------------------------------------------------
// cfitsio dithering
// ---------------------------------------------------------------------------

const RANDOM_COUNT = 10000
let randomValues: Float32Array | null = null

/** The cfitsio pseudo-random sequence (fits_init_randoms), as 32-bit floats. */
function randomNumbers(): Float32Array {
  if (randomValues) return randomValues
  const v = new Float32Array(RANDOM_COUNT)
  const a = 16807
  const m = 2147483647
  let seed = 1
  for (let i = 0; i < RANDOM_COUNT; i++) {
    const t = a * seed
    seed = t - m * Math.trunc(t / m)
    v[i] = seed / m
  }
  randomValues = v
  return v
}

/** Value that SUBTRACTIVE_DITHER_2 uses for exact zeros. */
const ZERO_VALUE = -2147483646

// ---------------------------------------------------------------------------
// Image decompression
// ---------------------------------------------------------------------------

export interface DecompressedImage {
  raw: Float32Array
  width: number
  height: number
  planes: number
  bitpix: number
}

/** Restores the byte order of GZIP_2, which groups bytes by significance. */
function reorderBytes(d: Uint8Array, width: number): Uint8Array {
  if (width <= 1) return d
  const n = Math.floor(d.length / width)
  const u = new Uint8Array(d.length)
  for (let k = 0; k < width; k++) {
    const base = k * n
    for (let i = 0; i < n; i++) u[i * width + k] = d[base + i]
  }
  return u
}

/** Interprets big-endian bytes as numbers of the given width. */
function bigEndianNumbers(d: Uint8Array, n: number, width: number, real: boolean): Float64Array {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const u = new Float64Array(n)
  if (width * n > d.length) throw new FitsError(t('coreCompressedFits.tileTruncated'))
  if (real) {
    if (width === 4) for (let i = 0; i < n; i++) u[i] = v.getFloat32(i * 4, false)
    else for (let i = 0; i < n; i++) u[i] = v.getFloat64(i * 8, false)
  } else if (width === 1) {
    for (let i = 0; i < n; i++) u[i] = d[i]
  } else if (width === 2) {
    for (let i = 0; i < n; i++) u[i] = v.getInt16(i * 2, false)
  } else if (width === 4) {
    for (let i = 0; i < n; i++) u[i] = v.getInt32(i * 4, false)
  } else {
    for (let i = 0; i < n; i++) u[i] = Number(v.getBigInt64(i * 8, false))
  }
  return u
}

/**
 * Decompresses the image of a compressed table. `dataStart` is the position
 * of the table data in the file.
 */
export function decompressImage(buffer: Uint8Array, h: FitsHeader, dataStart: number): DecompressedImage {
  const bitpix = number(h, 'ZBITPIX', 0)
  const axes = number(h, 'ZNAXIS', 0)
  if (axes < 2) throw new FitsError(t('coreCompressedFits.notTwoDimensional'))
  const dim = [number(h, 'ZNAXIS1', 0), number(h, 'ZNAXIS2', 0), axes >= 3 ? number(h, 'ZNAXIS3', 1) : 1]
  const tile = [
    number(h, 'ZTILE1', dim[0]),
    number(h, 'ZTILE2', 1),
    axes >= 3 ? number(h, 'ZTILE3', 1) : 1
  ]
  if (dim[0] <= 0 || dim[1] <= 0) throw new FitsError(t('coreCompressedFits.invalidDimensions'))

  const algorithm = text(h, 'ZCMPTYPE')
  if (!['RICE_1', 'RICE_ONE', 'GZIP_1', 'GZIP_2', 'HCOMPRESS_1', 'PLIO_1', 'NOCOMPRESS'].includes(algorithm)) {
    throw new FitsError(
      algorithm
        ? t('coreCompressedFits.unknownMethod', { method: algorithm })
        : t('coreCompressedFits.undeclaredMethod')
    )
  }

  // Algorithm parameters (ZNAMEi / ZVALi).
  let block = 32
  let bytepix = 4
  let shouldSmooth = false
  for (let i = 1; i <= 9; i++) {
    const name = text(h, 'ZNAME' + i)
    if (name === 'BLOCKSIZE') block = number(h, 'ZVAL' + i, 32)
    else if (name === 'BYTEPIX') bytepix = number(h, 'ZVAL' + i, 4)
    else if (name === 'SMOOTH') shouldSmooth = number(h, 'ZVAL' + i, 0) !== 0
  }

  const columns = readColumns(h)
  const col = (name: string): Column | undefined => columns.find((c) => c.name === name)
  const compressedCols = col('COMPRESSED_DATA')
  const colGzip = col('GZIP_COMPRESSED_DATA')
  const uncompressedCols = col('UNCOMPRESSED_DATA')
  const colScale = col('ZSCALE')
  const colZero = col('ZZERO')
  const colBlank = col('ZBLANK')
  if (!compressedCols) throw new FitsError(t('coreCompressedFits.missingDataColumn'))

  const rowWidth = number(h, 'NAXIS1', 0)
  const rows = number(h, 'NAXIS2', 0)
  const heapStart = dataStart + number(h, 'THEAP', rowWidth * rows)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  // Floating-point images with ZSCALE are quantized to integers.
  const quantized = bitpix < 0 && (colScale !== undefined || 'ZSCALE' in h.cards)
  const method = text(h, 'ZQUANTIZ')
  const dither = quantized && (method === 'SUBTRACTIVE_DITHER_1' || method === 'SUBTRACTIVE_DITHER_2')
  const dither2 = method === 'SUBTRACTIVE_DITHER_2'
  const seed = number(h, 'ZDITHER0', 1)
  const bzero = number(h, 'BZERO', 0)
  const bscale = number(h, 'BSCALE', 1)
  const blankHeader = h.cards['ZBLANK']

  const nt = [Math.ceil(dim[0] / tile[0]), Math.ceil(dim[1] / tile[1]), Math.ceil(dim[2] / tile[2])]
  if (nt[0] * nt[1] * nt[2] > rows) throw new FitsError(t('coreCompressedFits.incomplete'))

  const total = dim[0] * dim[1] * dim[2]
  const raw = new Float32Array(total)
  const randomVals = dither ? randomNumbers() : null

  /** Descriptor of a variable-length array: how many elements and where in the heap area. */
  const descriptor = (c: Column, row: number): { n: number; position: number } => {
    const p = dataStart + row * rowWidth + c.position
    if (p + 16 > buffer.length && c.type === 'Q') throw new FitsError(t('coreCompressedFits.truncated'))
    if (p + 8 > buffer.length) throw new FitsError(t('coreCompressedFits.truncated'))
    if (c.type === 'Q') {
      return { n: Number(view.getBigInt64(p, false)), position: Number(view.getBigInt64(p + 8, false)) }
    }
    return { n: view.getInt32(p, false), position: view.getInt32(p + 4, false) }
  }
  const bytesOf = (c: Column, row: number): Uint8Array => {
    const d = descriptor(c, row)
    const width = TYPE_BYTE[c.itemType] ?? 1
    const start = heapStart + d.position
    const end = start + d.n * width
    if (end > buffer.length) throw new FitsError(t('coreCompressedFits.truncatedMissingData'))
    return buffer.subarray(start, end)
  }
  const fixed = (c: Column, row: number): number =>
    readValue(view, dataStart + row * rowWidth + c.position, c.type)

  for (let row = 0; row < nt[0] * nt[1] * nt[2]; row++) {
    const tx = row % nt[0]
    const ty = Math.floor(row / nt[0]) % nt[1]
    const tz = Math.floor(row / (nt[0] * nt[1]))
    const x0 = tx * tile[0]
    const y0 = ty * tile[1]
    const z0 = tz * tile[2]
    const w = Math.min(tile[0], dim[0] - x0)
    const hh = Math.min(tile[1], dim[1] - y0)
    const dd = Math.min(tile[2], dim[2] - z0)
    const n = w * hh * dd

    // Tile values: integers to dequantize, or already physical values.
    let values: Float64Array | Int32Array
    let integers = true
    const compressedItems = bytesOf(compressedCols, row)
    if (compressedItems.length > 0) {
      if (algorithm === 'RICE_1' || algorithm === 'RICE_ONE') {
        values = decompressRice(compressedItems, n, block, bytepix)
      } else if (algorithm === 'HCOMPRESS_1') {
        const hcompressed = decompressHcompress(compressedItems, shouldSmooth)
        if (hcompressed.rows * hcompressed.columns !== n) throw new FitsError(t('coreCompressedFits.hcompressUnexpectedSize'))
        values = hcompressed.values
      } else if (algorithm === 'PLIO_1') {
        values = decompressPlio(compressedItems, n)
      } else {
        let d = algorithm === 'NOCOMPRESS' ? compressedItems : gunzip(compressedItems, { size: n * 8 })
        const width = Math.floor(d.length / n)
        if (width < 1) throw new FitsError(t('coreCompressedFits.tileTruncated'))
        if (algorithm === 'GZIP_2') d = reorderBytes(d, width)
        const realValues = bitpix < 0 && !quantized
        values = bigEndianNumbers(d, n, width, realValues)
        integers = !realValues
      }
    } else if (colGzip && descriptor(colGzip, row).n > 0) {
      // Tile that could not be quantized: real values compressed with gzip.
      const d = gunzip(bytesOf(colGzip, row))
      values = bigEndianNumbers(d, n, Math.floor(d.length / n), true)
      integers = false
    } else if (uncompressedCols && descriptor(uncompressedCols, row).n > 0) {
      const d = bytesOf(uncompressedCols, row)
      const type = uncompressedCols.itemType
      const width = TYPE_BYTE[type] ?? 4
      values = bigEndianNumbers(d, n, width, type === 'E' || type === 'D')
      integers = !(type === 'E' || type === 'D')
    } else {
      // Empty tile: all values missing.
      values = new Float64Array(n).fill(NaN)
      integers = false
    }

    // From integers to physical values.
    let physical: Float64Array
    if (integers && quantized) {
      const scale = colScale ? fixed(colScale, row) : number(h, 'ZSCALE', 1)
      const zero = colZero ? fixed(colZero, row) : number(h, 'ZZERO', 0)
      const blank = colBlank ? fixed(colBlank, row) : typeof blankHeader === 'number' ? blankHeader : null
      physical = new Float64Array(n)
      if (randomVals) {
        let seedIndex = (row + seed - 1) % RANDOM_COUNT
        let next = Math.floor(Math.fround(randomVals[seedIndex] * 500))
        for (let i = 0; i < n; i++) {
          const v = values[i]
          if (blank !== null && v === blank) physical[i] = NaN
          else if (dither2 && v === ZERO_VALUE) physical[i] = 0
          else physical[i] = (v - randomVals[next] + 0.5) * scale + zero
          if (++next === RANDOM_COUNT) {
            if (++seedIndex === RANDOM_COUNT) seedIndex = 0
            next = Math.floor(Math.fround(randomVals[seedIndex] * 500))
          }
        }
      } else {
        for (let i = 0; i < n; i++) {
          const v = values[i]
          physical[i] = blank !== null && v === blank ? NaN : v * scale + zero
        }
      }
    } else if (integers) {
      physical = new Float64Array(n)
      for (let i = 0; i < n; i++) physical[i] = bzero + bscale * values[i]
    } else {
      physical = values instanceof Float64Array ? values : Float64Array.from(values)
      if (bzero !== 0 || bscale !== 1) for (let i = 0; i < n; i++) physical[i] = bzero + bscale * physical[i]
    }

    // Place the tile at its position in the image.
    let k = 0
    for (let z = 0; z < dd; z++) {
      for (let y = 0; y < hh; y++) {
        const base = (z0 + z) * dim[0] * dim[1] + (y0 + y) * dim[0] + x0
        for (let x = 0; x < w; x++) raw[base + x] = physical[k++]
      }
    }
  }

  return { raw, width: dim[0], height: dim[1], planes: dim[2], bitpix }
}
