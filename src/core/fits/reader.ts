import type { FitsReadResult, FitsHeader, FitsValue, ImageFormat, FrameMetadata } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { readHeader, isFits, extractMetadata } from './header'
import { FitsError, InsufficientHead, detectScale, composeImage } from './common'
import { isCompressedImage, buildImageHeader, decompressImage } from '@core/formats/compressedFits'
import { isGzip, gunzip } from '@core/formats/inflate'
import { isXisf, readXisf, readXisfHeader } from '@core/formats/xisf'
import { isTiff, isBigTiff, readTiff, readTiffHeader } from '@core/formats/tiff'
import { isPng, readPng, readPngHeader } from '@core/formats/png'
import { detectRaw } from '@core/raw/rawFormats'
import { readRaw, readRawHeader } from '@core/raw/rawReader'

export { FitsError, InsufficientHead } from './common'

/**
 * Reader for incoming images.
 *
 * `readFits` is the single entry point: it recognizes the format from the
 * content (the signature in the first bytes), not from the extension, and
 * always returns the same result shape, with the header in FITS form.
 *
 * - FITS conforming to standard 4.0 for the amateur astrophotography cases:
 *   2- or 3-axis images, 8/16/32/64-bit integers and 32/64-bit floats,
 *   always big-endian;
 * - tile-compressed FITS (.fz: Rice, gzip), see formats/compressedFits;
 * - whole-file gzip-compressed FITS (.fits.gz);
 * - XISF, with the exposure metadata (formats/xisf);
 * - TIFF and PNG, which carry no exposure metadata: they enter as already
 *   stacked images, without coordinates (formats/tiff, formats/png).
 */

function cardNumber(header: FitsHeader, key: string, fallback: number): number {
  const v = header.cards[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Converts raw data to real values by applying the physical transform
 * declared in the header: value = BZERO + BSCALE * raw.
 */
function decodePixels(
  bytes: Uint8Array,
  dataOffset: number,
  count: number,
  bitpix: number,
  bzero: number,
  bscale: number,
  allocate: (length: number) => Float32Array
): Float32Array {
  const bytesPerPixel = Math.abs(bitpix) / 8
  const needed = count * bytesPerPixel

  // The check comes before the allocation: a file of a few KB with huge
  // declared dimensions must not request gigabytes of memory.
  if (dataOffset + needed > bytes.length) {
    throw new FitsError(t('coreReader.truncated', { needed, available: bytes.length - dataOffset }))
  }

  const out = allocate(count)
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, needed)

  switch (bitpix) {
    case 8:
      for (let i = 0; i < count; i++) out[i] = bzero + bscale * view.getUint8(i)
      break
    case 16:
      // Signed 16-bit integers: with BZERO 32768 they represent 0..65535.
      for (let i = 0; i < count; i++) out[i] = bzero + bscale * view.getInt16(i * 2, false)
      break
    case 32:
      for (let i = 0; i < count; i++) out[i] = bzero + bscale * view.getInt32(i * 4, false)
      break
    case 64:
      for (let i = 0; i < count; i++) {
        const big = view.getBigInt64(i * 8, false)
        out[i] = bzero + bscale * Number(big)
      }
      break
    case -32:
      for (let i = 0; i < count; i++) out[i] = bzero + bscale * view.getFloat32(i * 4, false)
      break
    case -64:
      for (let i = 0; i < count; i++) out[i] = bzero + bscale * view.getFloat64(i * 8, false)
      break
    default:
      throw new FitsError(t('coreReader.unsupportedBitpix', { bitpix }))
  }

  return out
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/** Format recognized from the file signature. */
export type FileSignature = 'fits' | 'gzip' | 'xisf' | 'tiff' | 'png'

/** Recognizes the format from the first bytes; null if unknown. */
export function detectFormat(b: Uint8Array): FileSignature | null {
  if (isFits(b)) return 'fits'
  if (isGzip(b)) return 'gzip'
  if (isXisf(b)) return 'xisf'
  if (isTiff(b) || isBigTiff(b)) return 'tiff'
  if (isPng(b)) return 'png'
  return null
}

/** Error for a file that is not in any known format. */
function unknownFormatError(b: Uint8Array, fileName: string): FitsError {
  const rawFormat = detectRaw(b, fileName)
  if (rawFormat !== null) {
    return new FitsError(t('coreReader.rawNotDecoded', { format: rawFormat }))
  }
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'bmp' || ext === 'gif') {
    return new FitsError(t('coreReader.lossyImage', { format: ext.toUpperCase() }))
  }
  return new FitsError(t('coreReader.unknownFormat'))
}

/** Whether the head that was read contains the END card, scanning from `start`. */
function hasEnd(b: Uint8Array, start: number): boolean {
  for (let p = start; p + 80 <= b.length; p += 80) {
    // "END" followed by spaces in the eight-character keyword field.
    if (b[p] !== 0x45 || b[p + 1] !== 0x4e || b[p + 2] !== 0x44) continue
    let spaces = true
    for (let k = 3; k < 8; k++) if (b[p + k] !== 0x20) spaces = false
    if (spaces) return true
  }
  return false
}

/** Adds the format to the metadata. */
function withFormat(m: FrameMetadata, format: ImageFormat): FrameMetadata {
  return { ...m, format }
}

/** Minimal header for images that have none (TIFF, PNG). */
function minimalHeader(width: number, height: number, channels: number, bitpix: number): FitsHeader {
  const cards: Record<string, FitsValue> = {
    SIMPLE: true,
    BITPIX: bitpix,
    NAXIS: channels >= 3 ? 3 : 2,
    NAXIS1: width,
    NAXIS2: height
  }
  if (channels >= 3) cards['NAXIS3'] = 3
  return { cards, comments: {}, order: Object.keys(cards) }
}

/**
 * Metadata of an image without exposure data. It is assumed to be already
 * stacked, the typical case of a TIFF or PNG exported by another program.
 * Only the file name can say that it is a dark, flat or bias.
 */
function metadataWithoutShot(header: FitsHeader, fileName: string, format: ImageFormat): FrameMetadata {
  const m = extractMetadata(header, fileName)
  const calibration = m.frameType === 'dark' || m.frameType === 'flat' || m.frameType === 'bias'
  return { ...m, frameType: calibration ? m.frameType : 'stacked', format }
}

/** Normalization scale for TIFF and PNG, which use unsigned integers. */
function scaleIntegers(raw: Float32Array, bitpix: number): number {
  if (bitpix === 8) return 255
  if (bitpix === 16) return 65535
  if (bitpix === 32) return 4294967295
  return detectScale(raw, bitpix)
}

// ---------------------------------------------------------------------------
// Full read
// ---------------------------------------------------------------------------

/** Allocates the pixel values: normally memory private to the reading thread. */
type Allocator = (length: number) => Float32Array
const ALLOCATE_NORMAL: Allocator = (l) => new Float32Array(l)

/** Reads a FITS (including tile-compressed). */
function parseFits(buffer: Uint8Array, fileName: string, allocate: Allocator = ALLOCATE_NORMAL): FitsReadResult {
  const primary = readHeader(buffer, 0)
  let { header, dataOffset } = primary
  let naxis = cardNumber(header, 'NAXIS', 0)

  // Some files have an empty primary HDU and the image in the next
  // extension: in that case reading continues with the first HDU that has
  // data. In .fz files the extension is a table holding the tile-compressed
  // image.
  if (naxis === 0 && dataOffset < buffer.length) {
    const next = readHeader(buffer, dataOffset)
    if (isCompressedImage(next.header)) {
      const img = decompressImage(buffer, next.header, next.dataOffset)
      const imageHeader = buildImageHeader(next.header, primary.header)
      const image = composeImage(img.raw, img.width, img.height, img.planes, detectScale(img.raw, img.bitpix))
      return {
        header: imageHeader,
        metadata: withFormat(extractMetadata(imageHeader, fileName), 'fits-compressed'),
        image,
        bitpix: img.bitpix,
        sizeBytes: buffer.length
      }
    }
    if (cardNumber(next.header, 'NAXIS', 0) > 0) {
      header = next.header
      dataOffset = next.dataOffset
      naxis = cardNumber(header, 'NAXIS', 0)
    }
  }

  if (naxis < 2) {
    throw new FitsError(t('coreReader.notTwoDimensional', { naxis }))
  }

  const width = cardNumber(header, 'NAXIS1', 0)
  const height = cardNumber(header, 'NAXIS2', 0)
  const planes = naxis >= 3 ? cardNumber(header, 'NAXIS3', 1) : 1

  if (width <= 0 || height <= 0) {
    throw new FitsError(t('coreReader.invalidDimensions', { width, height }))
  }

  const bitpix = cardNumber(header, 'BITPIX', 16)
  const bzero = cardNumber(header, 'BZERO', 0)
  const bscale = cardNumber(header, 'BSCALE', 1)

  // Planes beyond the third (for example an alpha channel) are not read.
  const pixelsPerPlane = width * height
  const usedPlanes = planes >= 3 ? 3 : 1
  const raw = decodePixels(buffer, dataOffset, pixelsPerPlane * usedPlanes, bitpix, bzero, bscale, allocate)
  const image = composeImage(raw, width, height, usedPlanes, detectScale(raw, bitpix))
  const metadata = withFormat(extractMetadata(header, fileName), 'fits')

  return { header, metadata, image, bitpix, sizeBytes: buffer.length }
}

/**
 * Reads a complete image file (FITS, compressed FITS, XISF, TIFF, PNG) and
 * returns the header, metadata and image with the planes normalized to
 * [0,1].
 *
 * @param allocate allocator for the pixels of uncompressed FITS files: the
 * analysis worker passes a shared-memory allocator so that an already
 * color FITS is born in shared memory and does not need to be copied.
 * Other formats ignore it.
 */
export function readFits(buffer: Uint8Array, fileName = '', allocate?: Allocator): FitsReadResult {
  // Camera RAW files (src/core/raw): checked first, because many are
  // TIFF-based. LibRaw must be prepared first in this thread (prepareRaw),
  // otherwise readRaw reports it.
  if (detectRaw(buffer, fileName) !== null) return readRaw(buffer, fileName)

  switch (detectFormat(buffer)) {
    case 'fits':
      return parseFits(buffer, fileName, allocate)

    case 'gzip': {
      const inner = gunzip(buffer)
      if (!isFits(inner)) {
        throw new FitsError(t('coreReader.gzipNoFits'))
      }
      const r = parseFits(inner, fileName)
      return { ...r, metadata: withFormat(r.metadata, 'fits-gzip'), sizeBytes: buffer.length }
    }

    case 'xisf': {
      const x = readXisf(buffer)
      // The pixels arrive already normalized.
      const image = composeImage(x.raw, x.width, x.height, x.channels, 1)
      return {
        header: x.header,
        metadata: withFormat(extractMetadata(x.header, fileName), 'xisf'),
        image,
        bitpix: x.bitpix,
        sizeBytes: buffer.length
      }
    }

    case 'tiff': {
      const rawFormat = detectRaw(buffer, fileName)
      if (rawFormat !== null) {
        throw new FitsError(t('coreReader.rawNotDecoded', { format: rawFormat }))
      }
      const tiff = readTiff(buffer)
      const header = minimalHeader(tiff.width, tiff.height, tiff.channels, tiff.bitpix)
      const image = composeImage(tiff.raw, tiff.width, tiff.height, tiff.channels, scaleIntegers(tiff.raw, tiff.bitpix))
      return {
        header,
        metadata: metadataWithoutShot(header, fileName, 'tiff'),
        image,
        bitpix: tiff.bitpix,
        sizeBytes: buffer.length
      }
    }

    case 'png': {
      const p = readPng(buffer)
      const header = minimalHeader(p.width, p.height, p.channels, p.bitpix)
      const image = composeImage(p.raw, p.width, p.height, p.channels, scaleIntegers(p.raw, p.bitpix))
      return {
        header,
        metadata: metadataWithoutShot(header, fileName, 'png'),
        image,
        bitpix: p.bitpix,
        sizeBytes: buffer.length
      }
    }

    default:
      throw unknownFormatError(buffer, fileName)
  }
}

// ---------------------------------------------------------------------------
// Header only
// ---------------------------------------------------------------------------

/** Header and dimensions read without decoding the pixels. */
export interface HeaderRead {
  header: FitsHeader
  metadata: FrameMetadata
  width: number
  height: number
  bitpix: number
}

/** Decompressed bytes that suffice for the header of a .fits.gz. */
const GZIP_HEAD = 2880 * 120

function fitsHead(buffer: Uint8Array, fileName: string, format: ImageFormat): HeaderRead {
  if (!hasEnd(buffer, 0)) throw new InsufficientHead(Math.max(buffer.length * 4, 2880 * 200))
  const primary = readHeader(buffer, 0)
  let header = primary.header
  if (cardNumber(header, 'NAXIS', 0) === 0 && primary.dataOffset < buffer.length) {
    if (!hasEnd(buffer, primary.dataOffset)) throw new InsufficientHead(primary.dataOffset + 2880 * 200)
    const next = readHeader(buffer, primary.dataOffset)
    if (isCompressedImage(next.header)) {
      header = buildImageHeader(next.header, primary.header)
      format = 'fits-compressed'
    } else if (cardNumber(next.header, 'NAXIS', 0) > 0) {
      header = next.header
    }
  }
  return {
    header,
    metadata: withFormat(extractMetadata(header, fileName), format),
    width: cardNumber(header, 'NAXIS1', 0),
    height: cardNumber(header, 'NAXIS2', 0),
    bitpix: cardNumber(header, 'BITPIX', 16)
  }
}

/**
 * Reads only the header and metadata without decoding the pixels: useful to
 * populate the library quickly when there are hundreds of frames.
 *
 * The head of the file (roughly the first 64 kB) is enough. If it is not,
 * for example an XISF with a very long XML header or a TIFF whose directory
 * is at the end of the file, `InsufficientHead` (exported here as
 * `InsufficientHead`) is thrown with the bytes needed: see `readHeaders`
 * in the renderer, which reads again.
 */
export function readFitsHeaderOnly(buffer: Uint8Array, fileName = '', fileSize?: number): HeaderRead {
  // Camera RAW files need the whole file: from the head alone LibRaw fails
  // or gets the dimensions wrong. With `fileSize` a full re-read is
  // requested; without it, the buffer is taken to be the complete file.
  if (detectRaw(buffer, fileName) !== null) {
    if (fileSize !== undefined && buffer.length < fileSize) throw new InsufficientHead(fileSize)
    return readRawHeader(buffer, fileName)
  }

  switch (detectFormat(buffer)) {
    case 'fits':
      return fitsHead(buffer, fileName, 'fits')

    case 'gzip': {
      const inner = gunzip(buffer, { limit: GZIP_HEAD, partial: true })
      if (!isFits(inner)) throw new FitsError(t('coreReader.gzipNoFits'))
      return fitsHead(inner, fileName, 'fits-gzip')
    }

    case 'xisf': {
      const x = readXisfHeader(buffer)
      return {
        header: x.header,
        metadata: withFormat(extractMetadata(x.header, fileName), 'xisf'),
        width: x.width,
        height: x.height,
        bitpix: x.bitpix
      }
    }

    case 'tiff': {
      const rawFormat = detectRaw(buffer, fileName)
      if (rawFormat !== null) {
        throw new FitsError(t('coreReader.rawNotDecoded', { format: rawFormat }))
      }
      const tiff = readTiffHeader(buffer)
      const header = minimalHeader(tiff.width, tiff.height, tiff.channels, tiff.bitpix)
      return { header, metadata: metadataWithoutShot(header, fileName, 'tiff'), width: tiff.width, height: tiff.height, bitpix: tiff.bitpix }
    }

    case 'png': {
      const p = readPngHeader(buffer)
      const header = minimalHeader(p.width, p.height, p.channels, p.bitpix)
      return { header, metadata: metadataWithoutShot(header, fileName, 'png'), width: p.width, height: p.height, bitpix: p.bitpix }
    }

    default:
      throw unknownFormatError(buffer, fileName)
  }
}
