import { FitsError } from '@core/fits/common'
import { t } from '@shared/i18n/i18n'

/**
 * Deflate decompressor (RFC 1951) with the zlib (RFC 1950) and gzip
 * (RFC 1952) wrappers, written here to avoid adding dependencies.
 *
 * It serves five formats: whole .fits.gz files, GZIP tiles of compressed
 * FITS (.fz), XISF with zlib compression, Deflate TIFF and PNG. The browser
 * has `DecompressionStream`, but it is asynchronous and the readers are
 * synchronous (they run in workers and in Node-based test tools): a
 * synchronous decompressor keeps everything else simple.
 *
 * Decoding uses lookup tables: for each Huffman tree a table indexed by the
 * next bits of the stream gives the symbol and the code length in one step,
 * instead of reading one bit at a time.
 */

/** Decompression options. */
export interface InflateOptions {
  /** Expected output size, if known: avoids growing the buffer. */
  size?: number
  /** Stop as soon as the output reaches this many bytes (reading the head only). */
  limit?: number
  /** If true, a truncated stream returns whatever was decompressed so far. */
  partial?: boolean
}

// Standard tables: base values and extra bits for lengths and distances.
const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
])
const EXTRA_LENGTH = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
])
const DISTANCE_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
  6145, 8193, 12289, 16385, 24577
])
const EXTRA_DISTANCE = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
])
/** Order in which the code lengths of the code-length tree arrive. */
const CODE_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])

/** Lookup table: entry = symbol << 4 | code length. */
interface Tree {
  table: Int32Array
  bit: number
}

/** Builds the table of a canonical Huffman tree from the code lengths. */
function buildTree(lengths: Uint8Array, n: number): Tree {
  let max = 0
  const counts = new Uint16Array(16)
  for (let i = 0; i < n; i++) {
    counts[lengths[i]]++
    if (lengths[i] > max) max = lengths[i]
  }
  counts[0] = 0
  const bit = Math.max(1, max)
  const table = new Int32Array(1 << bit).fill(-1)
  const next = new Uint16Array(16)
  let code = 0
  for (let l = 1; l <= 15; l++) {
    code = (code + counts[l - 1]) << 1
    next[l] = code
  }
  for (let s = 0; s < n; s++) {
    const l = lengths[s]
    if (l === 0) continue
    // Codes are defined from the most significant bit, but the stream is
    // read from the least significant one: the index is the reversed code.
    let c = next[l]++
    let reverse = 0
    for (let k = 0; k < l; k++) {
      reverse = (reverse << 1) | (c & 1)
      c >>= 1
    }
    const entry = (s << 4) | l
    for (let j = reverse; j < table.length; j += 1 << l) table[j] = entry
  }
  return { table, bit }
}

let fixedTrees: { lit: Tree; dist: Tree } | null = null

function fixedDeflateTrees(): { lit: Tree; dist: Tree } {
  if (fixedTrees) return fixedTrees
  const l = new Uint8Array(288)
  for (let i = 0; i < 144; i++) l[i] = 8
  for (let i = 144; i < 256; i++) l[i] = 9
  for (let i = 256; i < 280; i++) l[i] = 7
  for (let i = 280; i < 288; i++) l[i] = 8
  const d = new Uint8Array(30).fill(5)
  fixedTrees = { lit: buildTree(l, 288), dist: buildTree(d, 30) }
  return fixedTrees
}

/** Internal error: the compressed data ended prematurely. */
class StreamEnded extends Error {}

/**
 * Decompresses a raw Deflate stream starting at `start`.
 * Returns the output and the position of the first byte after the stream.
 */
export function inflateRaw(
  data: Uint8Array,
  start = 0,
  options: InflateOptions = {}
): { output: Uint8Array; end: number } {
  const limit = options.limit ?? Infinity
  let output = new Uint8Array(Math.max(1024, options.size ?? data.length * 4))
  let op = 0
  let ip = start
  let accumulator = 0
  let nbit = 0
  // Imaginary bytes read past the end: they are needed to fill the last
  // table lookup, but must not actually be consumed.
  let beyond = 0

  const fill = (n: number): void => {
    while (nbit < n) {
      let b = 0
      if (ip < data.length) b = data[ip]
      else beyond++
      ip++
      accumulator |= b << nbit
      nbit += 8
    }
  }
  const read = (n: number): number => {
    if (n === 0) return 0
    fill(n)
    const v = accumulator & ((1 << n) - 1)
    accumulator >>>= n
    nbit -= n
    if (beyond > 0 && (beyond * 8 > nbit)) throw new StreamEnded()
    return v
  }
  const decode = (a: Tree): number => {
    fill(a.bit)
    const entry = a.table[accumulator & ((1 << a.bit) - 1)]
    if (entry < 0) throw new FitsError(t('coreInflate.unknownHuffmanCode'))
    const l = entry & 15
    accumulator >>>= l
    nbit -= l
    if (beyond > 0 && beyond * 8 > nbit) throw new StreamEnded()
    return entry >> 4
  }
  const space = (n: number): void => {
    if (op + n <= output.length) return
    let newValue = output.length * 2
    while (newValue < op + n) newValue *= 2
    const u = new Uint8Array(newValue)
    u.set(output.subarray(0, op))
    output = u
  }

  try {
    let last = 0
    while (!last && op < limit) {
      last = read(1)
      const type = read(2)
      if (type === 0) {
        // Stored block: restart from the byte boundary.
        accumulator = 0
        ip -= nbit >> 3
        nbit = 0
        beyond = 0
        if (ip + 4 > data.length) throw new StreamEnded()
        const len = data[ip] | (data[ip + 1] << 8)
        ip += 4
        const availableItems = Math.min(len, data.length - ip)
        space(len)
        output.set(data.subarray(ip, ip + availableItems), op)
        op += availableItems
        ip += availableItems
        if (availableItems < len) throw new StreamEnded()
        continue
      }
      let lit: Tree
      let dist: Tree
      if (type === 1) {
        ;({ lit, dist } = fixedDeflateTrees())
      } else if (type === 2) {
        const hlit = read(5) + 257
        const hdist = read(5) + 1
        const hclen = read(4) + 4
        const lc = new Uint8Array(19)
        for (let i = 0; i < hclen; i++) lc[CODE_ORDER[i]] = read(3)
        const codeTree = buildTree(lc, 19)
        const lengths = new Uint8Array(hlit + hdist)
        let i = 0
        while (i < hlit + hdist) {
          const s = decode(codeTree)
          if (s < 16) {
            lengths[i++] = s
          } else {
            let repeat: number
            let value = 0
            if (s === 16) {
              if (i === 0) throw new FitsError(t('coreInflate.invalidData'))
              value = lengths[i - 1]
              repeat = 3 + read(2)
            } else if (s === 17) {
              repeat = 3 + read(3)
            } else {
              repeat = 11 + read(7)
            }
            if (i + repeat > hlit + hdist) throw new FitsError(t('coreInflate.invalidData'))
            while (repeat--) lengths[i++] = value
          }
        }
        lit = buildTree(lengths.subarray(0, hlit), hlit)
        dist = buildTree(lengths.subarray(hlit), hdist)
      } else {
        throw new FitsError(t('coreInflate.unknownBlockType'))
      }

      for (;;) {
        const s = decode(lit)
        if (s < 256) {
          if (op >= output.length) space(1)
          output[op++] = s
        } else if (s === 256) {
          break
        } else {
          const k = s - 257
          if (k >= 29) throw new FitsError(t('coreInflate.invalidData'))
          const length = LENGTH_BASE[k] + read(EXTRA_LENGTH[k])
          const ds = decode(dist)
          if (ds >= 30) throw new FitsError(t('coreInflate.invalidData'))
          const distance = DISTANCE_BASE[ds] + read(EXTRA_DISTANCE[ds])
          if (distance > op) throw new FitsError(t('coreInflate.distanceBeforeStart'))
          space(length)
          let from = op - distance
          // Copy byte by byte: sequences may overlap themselves.
          for (let j = 0; j < length; j++) output[op++] = output[from++]
          if (op >= limit) break
        }
      }
    }
  } catch (e) {
    if (!(e instanceof StreamEnded)) throw e
    if (!options.partial) {
      throw new FitsError(t('coreInflate.truncated'))
    }
    return { output: output.subarray(0, op), end: data.length }
  }

  // Bytes loaded into the accumulator but not used must be given back.
  const end = ip - (nbit >> 3)
  return { output: output.subarray(0, op), end }
}

/** Decompresses a zlib stream (two header bytes, Deflate, Adler-32 checksum). */
export function inflateZlib(data: Uint8Array, options: InflateOptions = {}): Uint8Array {
  if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) {
    // Some writers (old-style TIFF "Deflate") store bare Deflate.
    return inflateRaw(data, 0, options).output
  }
  const withDictionary = (data[1] & 0x20) !== 0
  if (withDictionary) throw new FitsError(t('coreInflate.zlibDictionary'))
  return inflateRaw(data, 2, options).output
}

/** Whether the bytes start with the gzip signature. */
export function isGzip(data: Uint8Array): boolean {
  return data.length >= 3 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 8
}

/**
 * Decompresses a gzip file, including one made of several concatenated
 * members (as produced by `cat a.gz b.gz`): their contents are joined.
 */
export function gunzip(data: Uint8Array, options: InflateOptions = {}): Uint8Array {
  const parts: Uint8Array[] = []
  let total = 0
  let p = 0
  const limit = options.limit ?? Infinity
  while (p + 10 <= data.length && data[p] === 0x1f && data[p + 1] === 0x8b && total < limit) {
    if (data[p + 2] !== 8) throw new FitsError(t('coreInflate.gzipUnknownMethod'))
    const flag = data[p + 3]
    let q = p + 10
    if (flag & 4) q += 2 + (data[q] | (data[q + 1] << 8)) // extra field
    if (flag & 8) while (q < data.length && data[q++] !== 0); // file name
    if (flag & 16) while (q < data.length && data[q++] !== 0); // comment
    if (flag & 2) q += 2 // header check
    // The original size (modulo 4 GB) is in the last four bytes, and is
    // exact for the common case of a single member.
    let size: number | undefined
    if (p === 0 && data.length >= 18) {
      const n = data.length
      size = (data[n - 4] | (data[n - 3] << 8) | (data[n - 2] << 16) | (data[n - 1] << 24)) >>> 0
      if (size < data.length) size = undefined
    }
    const { output, end } = inflateRaw(data, q, {
      size: options.limit !== undefined ? undefined : size,
      limit: limit - total,
      partial: options.partial
    })
    parts.push(output)
    total += output.length
    p = end + 8 // CRC-32 checksum and size
  }
  if (parts.length === 0) throw new FitsError(t('coreInflate.notGzip'))
  if (parts.length === 1) return parts[0]
  const everything = new Uint8Array(total)
  let o = 0
  for (const part of parts) {
    everything.set(part, o)
    o += part.length
  }
  return everything
}
