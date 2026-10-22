import type { FitsHeader, FitsValue } from '@shared/types'
import { FitsError, InsufficientHead } from '@core/fits/common'
import { parseValue } from '@core/fits/header'
import { t } from '@shared/i18n/i18n'
import { inflateZlib } from './inflate'
import { decompressZstd } from './zstd'

/**
 * XISF reader (Extensible Image Serialization Format), the native format
 * of PixInsight.
 *
 * The file begins with the "XISF0100" signature, the header length and an
 * XML header describing the images; the pixels come after, in blocks
 * indicated by the XML (position and length), or inside the XML itself in
 * base64. The first image in the file is read.
 *
 * Exposure metadata comes from two sources: the FITS keywords copied into
 * the XML (FITSKeyword elements) and the XISF properties
 * (Observation:Object:Name, Instrument:ExposureTime...). The FITS keywords
 * take precedence, as they are the ones written by the instrument; the
 * properties fill the gaps. The result is an equivalent FITS header, so the
 * rest of the program treats the file as a FITS.
 *
 * Compression: zlib, LZ4 and Zstandard (zstd.ts), also with byte
 * shuffling ("+sh").
 */

const SIGNATURE = 'XISF0100'

export function isXisf(b: Uint8Array): boolean {
  if (b.length < 16) return false
  for (let i = 0; i < 8; i++) if (b[i] !== SIGNATURE.charCodeAt(i)) return false
  return true
}

// ---------------------------------------------------------------------------
// Minimal XML
// ---------------------------------------------------------------------------

/** XML element: name, attributes, children and contained text. */
interface XmlNode {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

function decodeEntity(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_t, e: string) => {
    if (e === 'amp') return '&'
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16))
    return String.fromCodePoint(parseInt(e.slice(1), 10))
  })
}

/**
 * XML parser reduced to the essentials: elements, attributes and text.
 * The XISF header is simple, well-formed XML; `DOMParser` does not exist in
 * the program's workers, and a dedicated library would be overkill.
 */
function parseXml(s: string): XmlNode {
  const root: XmlNode = { name: '#root', attributes: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let p = 0
  const reAttribute = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  while (p < s.length) {
    const lt = s.indexOf('<', p)
    if (lt < 0) break
    if (lt > p) stack[stack.length - 1].text += decodeEntity(s.slice(p, lt))
    if (s.startsWith('<!--', lt)) {
      const f = s.indexOf('-->', lt)
      p = f < 0 ? s.length : f + 3
      continue
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const f = s.indexOf(']]>', lt)
      stack[stack.length - 1].text += s.slice(lt + 9, f < 0 ? s.length : f)
      p = f < 0 ? s.length : f + 3
      continue
    }
    if (s[lt + 1] === '?' || s[lt + 1] === '!') {
      const f = s.indexOf('>', lt)
      p = f < 0 ? s.length : f + 1
      continue
    }
    const gt = s.indexOf('>', lt)
    if (gt < 0) break
    const body = s.slice(lt + 1, gt)
    p = gt + 1
    if (body.startsWith('/')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const closedValue = body.endsWith('/')
    const m = /^([^\s/>]+)/.exec(body)
    if (!m) continue
    const node: XmlNode = { name: m[1].replace(/^.*:/, ''), attributes: {}, children: [], text: '' }
    reAttribute.lastIndex = m[1].length
    let a: RegExpExecArray | null
    while ((a = reAttribute.exec(body)) !== null) {
      node.attributes[a[1]] = decodeEntity(a[3] ?? a[4] ?? '')
    }
    stack[stack.length - 1].children.push(node)
    if (!closedValue) stack.push(node)
  }
  return root
}

function find(n: XmlNode, name: string): XmlNode | null {
  for (const f of n.children) {
    if (f.name === name) return f
    const g = find(f, name)
    if (g) return g
  }
  return null
}

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

/** LZ4 block decompression (the same format for LZ4 and LZ4-HC). */
export function decompressLz4(src: Uint8Array, size: number): Uint8Array {
  const dst = new Uint8Array(size)
  let ip = 0
  let op = 0
  while (ip < src.length) {
    const token = src[ip++]
    let lit = token >> 4
    if (lit === 15) {
      let b: number
      do {
        b = src[ip++]
        lit += b
      } while (b === 255 && ip < src.length)
    }
    if (op + lit > size || ip + lit > src.length) throw new FitsError(t('coreXisf.invalidLz4'))
    dst.set(src.subarray(ip, ip + lit), op)
    ip += lit
    op += lit
    if (ip >= src.length) break
    const distance = src[ip] | (src[ip + 1] << 8)
    ip += 2
    let matchLength = token & 15
    if (matchLength === 15) {
      let b: number
      do {
        b = src[ip++]
        matchLength += b
      } while (b === 255 && ip < src.length)
    }
    matchLength += 4
    if (distance === 0 || distance > op || op + matchLength > size) throw new FitsError(t('coreXisf.invalidLz4'))
    let from = op - distance
    for (let j = 0; j < matchLength; j++) dst[op++] = dst[from++]
  }
  if (op !== size) throw new FitsError(t('coreXisf.incompleteLz4'))
  return dst
}

/** Restores the order of bytes shuffled by significance (the XISF "+sh" option). */
function reorder(d: Uint8Array, bytesPerSample: number): Uint8Array {
  if (bytesPerSample <= 1) return d
  const n = Math.floor(d.length / bytesPerSample)
  const u = new Uint8Array(d.length)
  for (let k = 0; k < bytesPerSample; k++) {
    const base = k * n
    for (let i = 0; i < n; i++) u[i * bytesPerSample + k] = d[base + i]
  }
  // Leftover bytes stay at the end as they are.
  u.set(d.subarray(n * bytesPerSample), n * bytesPerSample)
  return u
}

function decompress(data: Uint8Array, compression: string, subBlocks: string | undefined): Uint8Array {
  const parts = compression.split(':')
  const codec = parts[0].toLowerCase()
  const size = Number(parts[1])
  const bytesPerSample = Number(parts[2] ?? 1)
  const [method, reordered] = codec.endsWith('+sh') ? [codec.slice(0, -3), true] : [codec, false]

  if (method !== 'zlib' && method !== 'lz4' && method !== 'lz4hc' && method !== 'zstd') {
    throw new FitsError(t('coreXisf.unknownCompression', { codec }))
  }

  // Large blocks may be split into sub-blocks compressed separately.
  const blocks: { c: number; u: number }[] = []
  if (subBlocks) {
    for (const pair of subBlocks.split(':')) {
      const [c, u] = pair.split(',').map(Number)
      blocks.push({ c, u })
    }
  } else {
    blocks.push({ c: data.length, u: size })
  }
  const output = new Uint8Array(size)
  let ip = 0
  let op = 0
  for (const b of blocks) {
    const part = data.subarray(ip, ip + b.c)
    const d =
      method === 'zlib'
        ? inflateZlib(part, { size: b.u })
        : method === 'zstd'
          ? decompressZstd(part, { size: b.u })
          : decompressLz4(part, b.u)
    output.set(d.subarray(0, Math.min(d.length, size - op)), op)
    ip += b.c
    op += b.u
  }
  return reordered ? reorder(output, bytesPerSample) : output
}

function base64(text: string): Uint8Array {
  const cleaned = text.replace(/\s+/g, '')
  const s = atob(cleaned)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u
}

function hexadecimal(text: string): Uint8Array {
  const cleaned = text.replace(/\s+/g, '')
  const u = new Uint8Array(cleaned.length >> 1)
  for (let i = 0; i < u.length; i++) u[i] = parseInt(cleaned.substr(i * 2, 2), 16)
  return u
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface XisfDescription {
  image: XmlNode
  width: number
  height: number
  channels: number
  format: string
  bitpix: number
  header: FitsHeader
}

/** Structural keywords that described other data in the source FITS. */
const STRUCTURE = /^(SIMPLE|BITPIX|NAXIS\d*|EXTEND|BZERO|BSCALE|END)$/

/**
 * XISF properties that have a corresponding FITS keyword, with the factor
 * to convert to the unit that FITS uses.
 */
const PROPERTIES: [string, string, number][] = [
  ['Observation:Object:Name', 'OBJECT', 1],
  ['Observation:Center:RA', 'RA', 1],
  ['Observation:Center:Dec', 'DEC', 1],
  ['Observation:Time:Start', 'DATE-OBS', 1],
  ['Observation:Location:Latitude', 'SITELAT', 1],
  ['Observation:Location:Longitude', 'SITELONG', 1],
  ['Instrument:ExposureTime', 'EXPTIME', 1],
  ['Instrument:Filter:Name', 'FILTER', 1],
  ['Instrument:Camera:Name', 'INSTRUME', 1],
  ['Instrument:Camera:XBinning', 'XBINNING', 1],
  ['Instrument:Telescope:Name', 'TELESCOP', 1],
  // XISF gives the focal length in meters, FITS in millimeters.
  ['Instrument:Telescope:FocalLength', 'FOCALLEN', 1000],
  ['Instrument:Sensor:XPixelSize', 'XPIXSZ', 1],
  ['Instrument:Sensor:Temperature', 'CCD-TEMP', 1]
]

const BITPIX_FORMAT: Record<string, number> = {
  UInt8: 8,
  UInt16: 16,
  UInt32: 32,
  UInt64: 64,
  Float32: -32,
  Float64: -64
}

function describe(buffer: Uint8Array): XisfDescription {
  if (!isXisf(buffer)) throw new FitsError(t('coreXisf.notValid'))
  const length = buffer[8] | (buffer[9] << 8) | (buffer[10] << 16) | (buffer[11] << 24)
  if (16 + length > buffer.length) throw new InsufficientHead(16 + length)
  const xml = new TextDecoder('utf-8').decode(buffer.subarray(16, 16 + length))
  const root = parseXml(xml)
  const image = find(root, 'Image')
  if (!image) throw new FitsError(t('coreXisf.noImages'))

  const geometry = (image.attributes['geometry'] ?? '').split(':').map(Number)
  if (geometry.length < 2 || geometry.some((g) => !Number.isFinite(g) || g <= 0)) {
    throw new FitsError(t('coreXisf.invalidSize'))
  }
  if (geometry.length > 3) throw new FitsError(t('coreXisf.tooManyDimensions'))
  const [width, height] = geometry
  const channels = geometry[2] ?? 1
  const format = image.attributes['sampleFormat'] ?? ''
  const bitpix = BITPIX_FORMAT[format]
  if (bitpix === undefined) {
    throw new FitsError(
      format ? t('coreXisf.unsupportedPixelFormat', { format }) : t('coreXisf.undeclaredPixelFormat')
    )
  }

  // Equivalent FITS header.
  const cards: Record<string, FitsValue> = {}
  const comments: Record<string, string> = {}
  const order: string[] = []
  const put = (k: string, v: FitsValue, c?: string): void => {
    if (!(k in cards)) order.push(k)
    cards[k] = v
    if (c) comments[k] = c
  }
  put('SIMPLE', true)
  put('BITPIX', bitpix === 64 ? 32 : bitpix)
  put('NAXIS', channels >= 3 ? 3 : 2)
  put('NAXIS1', width)
  put('NAXIS2', height)
  if (channels >= 3) put('NAXIS3', 3)

  let free = 0
  for (const f of image.children) {
    if (f.name !== 'FITSKeyword') continue
    const name = (f.attributes['name'] ?? '').trim().toUpperCase()
    if (name === '' || STRUCTURE.test(name)) continue
    if (name === 'HISTORY' || name === 'COMMENT') {
      const k = name + '_' + free++
      put(k, (f.attributes['comment'] ?? f.attributes['value'] ?? '').trim())
      continue
    }
    if (name in cards) continue
    put(name, parseValue(f.attributes['value'] ?? ''), f.attributes['comment'] || undefined)
  }

  for (const f of image.children) {
    if (f.name !== 'Property') continue
    const entry = PROPERTIES.find((p) => p[0] === f.attributes['id'])
    if (!entry || entry[1] in cards) continue
    const raw = f.attributes['value'] ?? f.text.trim()
    const type = f.attributes['type'] ?? ''
    if (type === 'String' || type === 'TimePoint') {
      if (raw !== '') put(entry[1], raw)
    } else {
      const n = Number(raw)
      if (Number.isFinite(n)) put(entry[1], n * entry[2])
    }
  }

  const imageType = image.attributes['imageType']
  if (imageType && !('IMAGETYP' in cards)) put('IMAGETYP', imageType)

  // Bayer matrix declared with the dedicated element.
  const cfa = image.children.find((f) => f.name === 'ColorFilterArray')
  if (cfa && !('BAYERPAT' in cards)) {
    const schema = (cfa.attributes['pattern'] ?? '').toUpperCase()
    if (/^[RGB]{4}$/.test(schema) && cfa.attributes['width'] === '2' && cfa.attributes['height'] === '2') {
      put('BAYERPAT', schema)
    }
  }

  return { image, width, height, channels, format, bitpix, header: { cards, comments, order } }
}

/** Reads dimensions and header without touching the pixels. */
export function readXisfHeader(buffer: Uint8Array): {
  header: FitsHeader
  width: number
  height: number
  bitpix: number
} {
  const d = describe(buffer)
  return { header: d.header, width: d.width, height: d.height, bitpix: d.bitpix === 64 ? 32 : d.bitpix }
}

/** Reads the image: values normalized to [0,1], in planes. */
export function readXisf(buffer: Uint8Array): {
  header: FitsHeader
  raw: Float32Array
  width: number
  height: number
  channels: number
  bitpix: number
} {
  const d = describe(buffer)
  const { image, width, height, channels, format } = d
  const n = width * height * channels
  const bytesPerSample = Math.abs(d.bitpix) / 8

  // Where the pixels are.
  const position = (image.attributes['location'] ?? '').split(':')
  let block: Uint8Array
  if (position[0] === 'attachment') {
    const start = Number(position[1])
    const byteCount = Number(position[2])
    if (start + byteCount > buffer.length) throw new FitsError(t('coreXisf.truncatedImage'))
    block = buffer.subarray(start, start + byteCount)
  } else if (position[0] === 'inline') {
    block = position[1] === 'hex' ? hexadecimal(image.text) : base64(image.text)
  } else if (position[0] === 'embedded') {
    const data = image.children.find((f) => f.name === 'Data')
    if (!data) throw new FitsError(t('coreXisf.missingEmbeddedData'))
    block = data.attributes['encoding'] === 'hex' ? hexadecimal(data.text) : base64(data.text)
  } else {
    throw new FitsError(t('coreXisf.unsupportedLocation', { location: position[0] }))
  }

  const compression = image.attributes['compression']
  if (compression) block = decompress(block, compression, image.attributes['subblocks'])
  if (block.length < n * bytesPerSample) throw new FitsError(t('coreXisf.truncatedPixels'))

  const little = (image.attributes['byteOrder'] ?? 'little') !== 'big'
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
  const values = new Float32Array(n)

  // Floating-point values are brought to [0,1] using the declared range
  // (usually already 0:1); integers using the format maximum.
  let minimum = 0
  let scale = 1
  if (format === 'Float32' || format === 'Float64') {
    const limits = (image.attributes['bounds'] ?? '0:1').split(':').map(Number)
    if (limits.length === 2 && Number.isFinite(limits[0]) && limits[1] > limits[0]) {
      minimum = limits[0]
      scale = 1 / (limits[1] - limits[0])
    }
  } else {
    scale = 1 / (Math.pow(2, 8 * bytesPerSample) - 1)
  }

  // "Planar" (the default): one channel after another; "Normal": the
  // channels of each pixel side by side.
  const interlaced = image.attributes['pixelStorage'] === 'Normal'
  const pixel = width * height
  const read: (p: number) => number =
    format === 'UInt8'
      ? (p) => block[p]
      : format === 'UInt16'
        ? (p) => view.getUint16(p, little)
        : format === 'UInt32'
          ? (p) => view.getUint32(p, little)
          : format === 'UInt64'
            ? (p) => Number(view.getBigUint64(p, little))
            : format === 'Float32'
              ? (p) => view.getFloat32(p, little)
              : (p) => view.getFloat64(p, little)
  if (interlaced && channels > 1) {
    for (let i = 0; i < n; i++) {
      values[(i % channels) * pixel + Math.floor(i / channels)] = (read(i * bytesPerSample) - minimum) * scale
    }
  } else {
    for (let i = 0; i < n; i++) values[i] = (read(i * bytesPerSample) - minimum) * scale
  }

  return { header: d.header, raw: values, width, height, channels, bitpix: d.bitpix === 64 ? 32 : d.bitpix }
}
