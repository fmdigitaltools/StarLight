import { FitsError, InsufficientHead } from '@core/fits/common'
import { t } from '@shared/i18n/i18n'
import { inflateZlib } from './inflate'

/**
 * PNG reader: grayscale and RGB at 8 and 16 bits (the useful case is
 * 16 bits, which preserves the gradations of a stacked image), with or
 * without an alpha channel (ignored), palette-based, and interlaced
 * (Adam7).
 *
 * Like TIFF, PNG carries no exposure metadata: only the pixels are read.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(b: Uint8Array): boolean {
  if (b.length < 8) return false
  for (let i = 0; i < 8; i++) if (b[i] !== SIGNATURE[i]) return false
  return true
}

interface PngHead {
  width: number
  height: number
  bit: number
  colorType: number
  interlaced: boolean
}

function u32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
}

function readHeader(b: Uint8Array): PngHead {
  if (!isPng(b)) throw new FitsError(t('corePng.notValid'))
  if (b.length < 33) throw new InsufficientHead(33)
  const type = String.fromCharCode(b[12], b[13], b[14], b[15])
  if (type !== 'IHDR') throw new FitsError(t('corePng.missingIhdr'))
  const head: PngHead = {
    width: u32(b, 16),
    height: u32(b, 20),
    bit: b[24],
    colorType: b[25],
    interlaced: b[28] === 1
  }
  if (head.width === 0 || head.height === 0) throw new FitsError(t('corePng.invalidSize'))
  if (![0, 2, 3, 4, 6].includes(head.colorType)) throw new FitsError(t('corePng.unknownColorType'))
  return head
}

/** Channels used by StarLight: 3 for color, 1 for grayscale. */
function channelsOf(head: PngHead): 1 | 3 {
  return head.colorType === 2 || head.colorType === 3 || head.colorType === 6 ? 3 : 1
}

export function readPngHeader(b: Uint8Array): { width: number; height: number; channels: number; bitpix: number } {
  const head = readHeader(b)
  return { width: head.width, height: head.height, channels: channelsOf(head), bitpix: head.bit === 16 ? 16 : 8 }
}

/** Samples per pixel for each color type (alpha included). */
const SAMPLES: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Removes the filter of a row (PNG applies one filter per row). */
function unfilter(type: number, row: Uint8Array, above: Uint8Array | null, bpp: number): void {
  const n = row.length
  switch (type) {
    case 0:
      return
    case 1:
      for (let i = bpp; i < n; i++) row[i] = (row[i] + row[i - bpp]) & 0xff
      return
    case 2:
      if (above) for (let i = 0; i < n; i++) row[i] = (row[i] + above[i]) & 0xff
      return
    case 3:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp] : 0
        const b = above ? above[i] : 0
        row[i] = (row[i] + ((a + b) >> 1)) & 0xff
      }
      return
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp] : 0
        const b = above ? above[i] : 0
        const c = above && i >= bpp ? above[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        row[i] = (row[i] + pred) & 0xff
      }
      return
    default:
      throw new FitsError(t('corePng.unknownFilter', { type }))
  }
}

export function readPng(b: Uint8Array): { raw: Float32Array; width: number; height: number; channels: number; bitpix: number } {
  const head = readHeader(b)
  const { width, height, bit, colorType } = head

  // Collects the IDAT chunks (the compressed data) and the palette.
  const idat: Uint8Array[] = []
  let palette: Uint8Array | null = null
  let p = 8
  while (p + 8 <= b.length) {
    const chunkLength = u32(b, p)
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7])
    const data = b.subarray(p + 8, Math.min(b.length, p + 8 + chunkLength))
    if (type === 'IDAT') idat.push(data)
    else if (type === 'PLTE') palette = data
    else if (type === 'IEND') break
    p += 12 + chunkLength
  }
  if (idat.length === 0) throw new FitsError(t('corePng.noPixels'))
  let total = 0
  for (const d of idat) total += d.length
  const compressedItems = new Uint8Array(total)
  let o = 0
  for (const d of idat) {
    compressedItems.set(d, o)
    o += d.length
  }

  const samples = SAMPLES[colorType]
  const pixelBits = samples * bit
  const bpp = Math.max(1, pixelBits >> 3)
  const channels = channelsOf(head)
  const pixel = width * height
  const raw = new Float32Array(pixel * channels)
  const max = (1 << bit) - 1

  // The seven Adam7 passes, or a single pass.
  const passes = head.interlaced
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2]
      ]
    : [[0, 0, 1, 1]]
  let expected = 0
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx)
    const h = Math.ceil((height - y0) / dy)
    if (w > 0 && h > 0) expected += h * (1 + Math.ceil((w * pixelBits) / 8))
  }
  const data = inflateZlib(compressedItems, { size: expected })
  if (data.length < expected) throw new FitsError(t('corePng.truncated'))

  // Reads a sample from the row, at any bit depth.
  const sample = (row: Uint8Array, index: number): number => {
    if (bit === 8) return row[index]
    if (bit === 16) return (row[index * 2] << 8) | row[index * 2 + 1]
    const bitPos = index * bit
    const byte = row[bitPos >> 3]
    return (byte >> (8 - bit - (bitPos & 7))) & max
  }

  let ip = 0
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx)
    const h = Math.ceil((height - y0) / dy)
    if (w <= 0 || h <= 0) continue
    const rowBytes = Math.ceil((w * pixelBits) / 8)
    let above: Uint8Array | null = null
    for (let y = 0; y < h; y++) {
      const filter = data[ip]
      const row = data.subarray(ip + 1, ip + 1 + rowBytes)
      ip += 1 + rowBytes
      unfilter(filter, row, above, bpp)
      above = row
      const yy = y0 + y * dy
      for (let x = 0; x < w; x++) {
        const dest = yy * width + x0 + x * dx
        if (colorType === 3) {
          const k = sample(row, x)
          if (!palette || k * 3 + 2 >= palette.length) throw new FitsError(t('corePng.missingPalette'))
          raw[dest] = palette[k * 3]
          raw[pixel + dest] = palette[k * 3 + 1]
          raw[2 * pixel + dest] = palette[k * 3 + 2]
        } else if (channels === 3) {
          raw[dest] = sample(row, x * samples)
          raw[pixel + dest] = sample(row, x * samples + 1)
          raw[2 * pixel + dest] = sample(row, x * samples + 2)
        } else {
          raw[dest] = sample(row, x * samples)
        }
      }
    }
  }

  // Grayscale at 1, 2 or 4 bits: brought to the 8-bit scale.
  if (colorType !== 3 && bit < 8) {
    const f = 255 / max
    for (let i = 0; i < raw.length; i++) raw[i] *= f
  }
  return { raw, width, height, channels, bitpix: bit === 16 && colorType !== 3 ? 16 : 8 }
}
