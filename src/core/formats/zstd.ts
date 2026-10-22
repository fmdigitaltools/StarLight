import { FitsError } from '@core/fits/common'
import { xxh64Low } from './xxh64'
import { t } from '@shared/i18n/i18n'

/**
 * Zstandard decompressor (RFC 8878), written here to avoid adding
 * dependencies, like those for Deflate (inflate.ts) and LZ4 (xisf.ts).
 *
 * It serves XISF files compressed with the "zstd" codec, also with byte
 * shuffling ("zstd+sh").
 *
 * A stream is made of frames; each frame of blocks, which can be copied as
 * they are (raw), a repeated byte (RLE) or compressed. A compressed block
 * has two parts:
 * - the literals, the bytes that do not repeat, written in full or with a
 *   Huffman code (one or four streams);
 * - the sequences, triples (literals to copy, distance, match length)
 *   encoded with three FSE ("Finite State Entropy", a form of stateful
 *   arithmetic coding) tables: the predefined ones from the standard, a
 *   single repeated entry, one described in the block, or the one from the
 *   previous block.
 * Distances remember the last three used ("repeated offsets").
 *
 * The optional frame check (the low 32 bits of XXH64 over the content) is
 * verified when present: a damaged file gives an error instead of wrong
 * pixels. It costs about one second per hundred megabytes.
 * External dictionaries are not supported: XISF does not use them.
 *
 * The sequence stream and the Huffman streams are read "backward": the
 * last byte contains a marker bit, and bits are consumed from the highest
 * to the lowest. Here the position is counted in bits from the start of
 * the stream and decreases; bits before the start are zero, as the
 * standard requires.
 */

const MAGIC = 0xfd2fb528
/** Maximum size of a block (and therefore of its literals). */
const MAX_LITERALS_PER_BLOCK = 128 * 1024

// ---------------------------------------------------------------------------
// Tables from the standard
// ---------------------------------------------------------------------------

/** Literal lengths: base value and extra bits of each code. */
const BASE_LL = new Int32Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024,
  2048, 4096, 8192, 16384, 32768, 65536
])
const BIT_LL = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
])
/** Match lengths. */
const BASE_ML = new Int32Array(53)
const BIT_ML = new Uint8Array(53)
{
  for (let i = 0; i < 32; i++) BASE_ML[i] = i + 3
  const bases = [35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539]
  const bit = [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
  for (let i = 0; i < 21; i++) {
    BASE_ML[32 + i] = bases[i]
    BIT_ML[32 + i] = bit[i]
  }
}

/** Predefined distributions (probabilities; -1 means "less than one"). */
const DEFAULT_LL = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1
]
const DEFAULT_ML = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1
]
const DEFAULT_OF = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1]

function error(detail: string): FitsError {
  return new FitsError(t('coreZstd.invalidData', { detail: t('coreZstd.detail.' + detail) }))
}

/** Position of the highest set bit (x > 0). */
function highBit(x: number): number {
  return 31 - Math.clz32(x)
}

// ---------------------------------------------------------------------------
// Bit reading
// ---------------------------------------------------------------------------

/**
 * The n bits (1 to 24) of the stream that starts at byte `base` and ends
 * at bit `end`; those below the start of the stream are zero. A small,
 * stateless function that the compiler inlines in the hottest loops.
 */
function readBitsBackward(d: Uint8Array, base: number, end: number, n: number): number {
  const start = end - n
  if (start < 0) return end <= 0 ? 0 : readBitsBackward(d, base, end, end) << -start
  const p = base + (start >> 3)
  // Bytes beyond the end of the array read as zero (and fall outside the mask anyway).
  const v = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)
  return (v >>> (start & 7)) & ((1 << n) - 1)
}

/** Copy of the sequence stream with eight bytes of margin, read in 32-bit words. */
let copySequences = new Uint8Array(MAX_LITERALS_PER_BLOCK + 8)
let sequencesView = new DataView(copySequences.buffer)

/** Like readBitsBackward, on the copy with margin (stream start at byte 0). */
function sequenceBits(end: number, n: number): number {
  const start = end - n
  if (start < 0) return end <= 0 ? 0 : sequenceBits(end, end) << -start
  return (sequencesView.getUint32(start >> 3, true) >>> (start & 7)) & ((1 << n) - 1)
}

/**
 * Backward reader: `pos` is the number of bits not yet read, counted from
 * the start of the stream (`base`). Reading n bits returns those between
 * pos - n and pos; those below zero are zero.
 */
class BackwardReader {
  pos: number
  constructor(
    private readonly d: Uint8Array,
    private readonly base: number,
    end: number
  ) {
    if (end <= base) throw error('emptyStream')
    const last = d[end - 1]
    if (last === 0) throw error('missingMarkerBit')
    this.pos = (end - base - 1) * 8 + highBit(last)
  }

  /** The byte at which the stream starts. */
  get start(): number {
    return this.base
  }

  read(n: number): number {
    if (n === 0) return 0
    if (n > 24) {
      const top = this.read(n - 16)
      return top * 65536 + this.read(16)
    }
    const v = readBitsBackward(this.d, this.base, this.pos, n)
    this.pos -= n
    return v
  }

  /** True if reading went past the start of the stream. */
  get beyond(): boolean {
    return this.pos < 0
  }
}

// ---------------------------------------------------------------------------
// FSE
// ---------------------------------------------------------------------------

/** FSE decoding table: for each state, the symbol, the bits to read and the base of the next state. */
interface FseTable {
  log: number
  symbols: Uint8Array
  bit: Uint8Array
  base: Int32Array
}

/** Builds the decoding table from the normalized probabilities. */
function buildFse(probability: ArrayLike<number>, n: number, log: number): FseTable {
  const dim = 1 << log
  const symbols = new Uint8Array(dim)
  const bit = new Uint8Array(dim)
  const base = new Int32Array(dim)
  const next = new Int32Array(n)
  // "Less than one" symbols take one cell each, at the end of the table.
  let threshold = dim
  for (let s = 0; s < n; s++) {
    if (probability[s] === -1) {
      symbols[--threshold] = s
      next[s] = 1
    }
  }
  // The others are spread with the standard's step.
  const step = (dim >> 1) + (dim >> 3) + 3
  const mask = dim - 1
  let p = 0
  for (let s = 0; s < n; s++) {
    const f = probability[s]
    if (f <= 0) continue
    next[s] = f
    for (let i = 0; i < f; i++) {
      symbols[p] = s
      do p = (p + step) & mask
      while (p >= threshold)
    }
  }
  if (p !== 0) throw error('inconsistentFseDistribution')
  for (let i = 0; i < dim; i++) {
    const s = symbols[i]
    const state = next[s]++
    const nb = log - highBit(state)
    bit[i] = nb
    base[i] = (state << nb) - dim
  }
  return { log, symbols, bit, base }
}

/** Single-symbol table (RLE mode of the sequences). */
function fseConstant(symbol: number): FseTable {
  return { log: 0, symbols: new Uint8Array([symbol]), bit: new Uint8Array(1), base: new Int32Array(1) }
}

/**
 * Reads the description of an FSE table (forward stream, least significant
 * bit first). Returns the table and the first byte after the description.
 */
function readFseDescription(
  d: Uint8Array,
  start: number,
  end: number,
  maxLog: number,
  maxSymbols: number
): { table: FseTable; end: number } {
  let p = start
  let accumulator = 0
  let nbit = 0
  const read = (n: number): number => {
    while (nbit < n) {
      accumulator |= (p < end ? d[p] : 0) << nbit
      p++
      nbit += 8
    }
    const v = accumulator & ((1 << n) - 1)
    accumulator >>>= n
    nbit -= n
    return v
  }
  const log = read(4) + 5
  if (log > maxLog) throw error('excessiveFsePrecision')
  const probability = new Int32Array(256)
  let remaining = 1 << log
  let s = 0
  while (remaining > 0 && s < maxSymbols) {
    const nb = highBit(remaining + 1) + 1
    const lowMask = (1 << (nb - 1)) - 1
    const threshold = (1 << nb) - 1 - (remaining + 1)
    // nb - 1 bits are examined; if the value is small they are enough.
    let v = read(nb - 1)
    if (v >= threshold) {
      v |= read(1) << (nb - 1)
      if (v > lowMask) v -= threshold
    }
    const prob = v - 1
    remaining -= prob < 0 ? -prob : prob
    probability[s++] = prob
    if (prob === 0) {
      // After a zero, groups of two bits say how many more zeros follow.
      for (;;) {
        const repeat = read(2)
        s += repeat
        if (repeat !== 3) break
      }
    }
  }
  if (remaining !== 0 || s > maxSymbols) throw error('inconsistentFseDescription')
  // Return to the byte boundary.
  const usedValues = p - (nbit >> 3)
  if (usedValues > end) throw error('truncatedFseDescription')
  return { table: buildFse(probability, s, log), end: usedValues }
}

let defaults: { ll: FseTable; ml: FseTable; of: FseTable } | null = null
function defaultTables(): { ll: FseTable; ml: FseTable; of: FseTable } {
  if (!defaults) {
    defaults = {
      ll: buildFse(DEFAULT_LL, DEFAULT_LL.length, 6),
      ml: buildFse(DEFAULT_ML, DEFAULT_ML.length, 6),
      of: buildFse(DEFAULT_OF, DEFAULT_OF.length, 5)
    }
  }
  return defaults
}

// ---------------------------------------------------------------------------
// Huffman for literals
// ---------------------------------------------------------------------------

/** Lookup table: entry = symbol << 4 | code length. */
interface HuffmanTable {
  bit: number
  entries: Uint16Array
}

/**
 * Reads the description of the Huffman tree (weights written directly or
 * compressed with FSE) and builds the lookup table.
 */
function readHuffman(d: Uint8Array, start: number, end: number): { table: HuffmanTable; end: number } {
  if (start >= end) throw error('missingHuffmanTree')
  const head = d[start]
  const weights = new Uint8Array(256)
  let n: number
  let after: number
  if (head >= 128) {
    // Direct weights, four bits each.
    n = head - 127
    after = start + 1 + ((n + 1) >> 1)
    if (after > end) throw error('truncatedHuffmanTree')
    for (let i = 0; i < n; i++) {
      const b = d[start + 1 + (i >> 1)]
      weights[i] = i & 1 ? b & 15 : b >> 4
    }
  } else {
    // Weights compressed with FSE: two interleaved states on the same stream.
    after = start + 1 + head
    if (after > end) throw error('truncatedHuffmanTree')
    const { table, end: f } = readFseDescription(d, start + 1, after, 6, 256)
    const r = new BackwardReader(d, f, after)
    let s1 = r.read(table.log)
    let s2 = r.read(table.log)
    n = 0
    for (;;) {
      if (n >= 255) throw error('tooManyHuffmanWeights')
      weights[n++] = table.symbols[s1]
      s1 = table.base[s1] + r.read(table.bit[s1])
      if (r.beyond) {
        weights[n++] = table.symbols[s2]
        break
      }
      if (n >= 255) throw error('tooManyHuffmanWeights')
      weights[n++] = table.symbols[s2]
      s2 = table.base[s2] + r.read(table.bit[s2])
      if (r.beyond) {
        weights[n++] = table.symbols[s1]
        break
      }
    }
  }
  // The last weight is implicit: it completes the sum to the next power of two.
  let total = 0
  for (let i = 0; i < n; i++) {
    if (weights[i] > 12) throw error('huffmanWeightOutOfRange')
    if (weights[i] > 0) total += 1 << (weights[i] - 1)
  }
  if (total === 0) throw error('emptyHuffmanTree')
  const maxBits = highBit(total) + 1
  if (maxBits > 11) throw error('huffmanCodesTooLong')
  const remainder = (1 << maxBits) - total
  if ((remainder & (remainder - 1)) !== 0) throw error('inconsistentHuffmanWeights')
  weights[n++] = highBit(remainder) + 1

  // Canonical codes: longest first (weight 1), in symbol order for equal weights.
  const entries = new Uint16Array(1 << maxBits)
  let p = 0
  for (let w = 1; w <= maxBits; w++) {
    const codeLength = maxBits + 1 - w
    const count = 1 << (w - 1)
    for (let s = 0; s < n; s++) {
      if (weights[s] !== w) continue
      const entry = (s << 4) | codeLength
      for (let k = 0; k < count; k++) entries[p++] = entry
    }
  }
  return { table: { bit: maxBits, entries }, end: after }
}

/** Decodes a Huffman stream (backward) of `n` literals into `output` starting at `o`. */
function decodeHuffmanStream(
  d: Uint8Array,
  start: number,
  end: number,
  t: HuffmanTable,
  output: Uint8Array,
  o: number,
  n: number
): void {
  if (end <= start) throw error('emptyHuffmanStream')
  const last = d[end - 1]
  if (last === 0) throw error('missingMarkerBit')
  let pos = (end - start - 1) * 8 + highBit(last)
  const bm = t.bit
  const mask = (1 << bm) - 1
  const entries = t.entries
  const term = o + n
  // As long as at least bm bits remain, read three bytes at a time.
  while (o < term && pos >= bm) {
    const a = pos - bm
    const q = start + (a >> 3)
    const v = ((d[q] | (d[q + 1] << 8) | (d[q + 2] << 16)) >>> (a & 7)) & mask
    const entry = entries[v]
    output[o++] = entry >> 4
    pos -= entry & 15
  }
  while (o < term) {
    // Tail: missing bits below the start are zero.
    let v = 0
    if (pos > 0) v = ((d[start] | (d[start + 1] << 8)) & ((1 << pos) - 1)) << (bm - pos)
    const entry = entries[v]
    output[o++] = entry >> 4
    pos -= entry & 15
  }
  if (pos !== 0) throw error('wrongHuffmanStreamLength')
}

// ---------------------------------------------------------------------------
// Frames and blocks
// ---------------------------------------------------------------------------

/** State carried from one block to the next within the same frame. */
interface FrameState {
  huffman: HuffmanTable | null
  ll: FseTable | null
  of: FseTable | null
  ml: FseTable | null
  repeated: number[]
}

/** Output that grows as needed. */
class Output {
  b: Uint8Array
  n = 0
  constructor(size: number) {
    this.b = new Uint8Array(Math.max(1024, size))
  }
  space(k: number): void {
    if (this.n + k <= this.b.length) return
    let newValue = this.b.length * 2
    while (newValue < this.n + k) newValue *= 2
    const u = new Uint8Array(newValue)
    u.set(this.b.subarray(0, this.n))
    this.b = u
  }
}

/** Literals of the current block. */
const literalBuffer = new Uint8Array(MAX_LITERALS_PER_BLOCK + 32)

/** Decompresses a compressed block that occupies d[start..end). */
function compressedBlock(d: Uint8Array, start: number, end: number, u: Output, st: FrameState): void {
  // --- Literals ---
  let p = start
  const b0 = d[p]
  const type = b0 & 3
  const format = (b0 >> 2) & 3
  let regenerated: number
  let compressedItems = 0
  let four = false
  if (type < 2) {
    if (format === 0 || format === 2) {
      regenerated = b0 >> 3
      p += 1
    } else if (format === 1) {
      regenerated = (b0 >> 4) + (d[p + 1] << 4)
      p += 2
    } else {
      regenerated = (b0 >> 4) + (d[p + 1] << 4) + (d[p + 2] << 12)
      p += 3
    }
  } else {
    const h = (b0 | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0
    if (format < 2) {
      four = format === 1
      regenerated = (h >>> 4) & 0x3ff
      compressedItems = (h >>> 14) & 0x3ff
      p += 3
    } else if (format === 2) {
      four = true
      regenerated = (h >>> 4) & 0x3fff
      compressedItems = h >>> 18
      p += 4
    } else {
      four = true
      regenerated = (h >>> 4) & 0x3ffff
      compressedItems = (h >>> 22) + (d[p + 4] << 10)
      p += 5
    }
  }
  if (regenerated > MAX_LITERALS_PER_BLOCK) throw error('tooManyLiterals')
  const literals = literalBuffer
  if (type === 0) {
    if (p + regenerated > end) throw error('truncatedLiterals')
    literals.set(d.subarray(p, p + regenerated))
    p += regenerated
  } else if (type === 1) {
    if (p >= end) throw error('truncatedLiterals')
    literals.fill(d[p], 0, regenerated)
    p += 1
  } else {
    const readEnd = p + compressedItems
    if (readEnd > end) throw error('truncatedLiterals')
    let q = p
    if (type === 2) {
      const h = readHuffman(d, p, readEnd)
      st.huffman = h.table
      q = h.end
    } else if (!st.huffman) {
      throw error('missingRepeatedHuffmanTree')
    }
    const t = st.huffman!
    if (!four) {
      decodeHuffmanStream(d, q, readEnd, t, literals, 0, regenerated)
    } else {
      if (q + 6 > readEnd) throw error('truncatedStreamTable')
      const l1 = d[q] | (d[q + 1] << 8)
      const l2 = d[q + 2] | (d[q + 3] << 8)
      const l3 = d[q + 4] | (d[q + 5] << 8)
      const s1 = q + 6
      const s2 = s1 + l1
      const s3 = s2 + l2
      const s4 = s3 + l3
      if (s4 > readEnd) throw error('truncatedHuffmanStreams')
      const part = (regenerated + 3) >> 2
      if (part * 3 > regenerated) throw error('tooFewLiterals')
      decodeHuffmanStream(d, s1, s2, t, literals, 0, part)
      decodeHuffmanStream(d, s2, s3, t, literals, part, part)
      decodeHuffmanStream(d, s3, s4, t, literals, 2 * part, part)
      decodeHuffmanStream(d, s4, readEnd, t, literals, 3 * part, regenerated - 3 * part)
    }
    p = readEnd
  }

  // --- Sequences ---
  if (p >= end) throw error('missingSequencesSection')
  let nseq = d[p++]
  if (nseq >= 128) {
    if (nseq === 255) {
      nseq = d[p] + (d[p + 1] << 8) + 0x7f00
      p += 2
    } else {
      nseq = ((nseq - 128) << 8) + d[p]
      p += 1
    }
  }
  if (nseq === 0) {
    // Literals only.
    if (p !== end) throw error('trailingBytes')
    u.space(regenerated)
    u.b.set(literals.subarray(0, regenerated), u.n)
    u.n += regenerated
    return
  }
  const modes = d[p++]
  if (modes & 3) throw error('reservedBitsSet')
  const pre = defaultTables()
  const table = (mode: number, defaultTable: FseTable, previous: FseTable | null, log: number, symbols: number): FseTable => {
    if (mode === 0) return defaultTable
    if (mode === 1) {
      if (p >= end) throw error('truncatedSequences')
      const s = d[p++]
      if (s >= symbols) throw error('rleSymbolOutOfRange')
      return fseConstant(s)
    }
    if (mode === 2) {
      const r = readFseDescription(d, p, end, log, symbols)
      p = r.end
      return r.table
    }
    if (!previous) throw error('missingRepeatedTable')
    return previous
  }
  const tLL = (st.ll = table((modes >> 6) & 3, pre.ll, st.ll, 9, 36))
  const tOF = (st.of = table((modes >> 4) & 3, pre.of, st.of, 8, 32))
  const tML = (st.ml = table((modes >> 2) & 3, pre.ml, st.ml, 9, 53))

  const r = new BackwardReader(d, p, end)
  let sLL = r.read(tLL.log)
  let sOF = r.read(tOF.log)
  let sML = r.read(tML.log)
  const recent = st.repeated
  let r1 = recent[0]
  let r2 = recent[1]
  let r3 = recent[2]
  let pl = 0
  // Space for the block's worst case: re-checked only when needed.
  u.space(regenerated + 1024)
  let out = u.b
  let o = u.n

  // The hottest loop: the reader is kept in local variables.
  let pos = r.pos
  const seqLength = end - r.start
  if (seqLength + 8 > copySequences.length) {
    copySequences = new Uint8Array(seqLength + 8)
    sequencesView = new DataView(copySequences.buffer)
  }
  copySequences.set(d.subarray(r.start, end))
  copySequences.fill(0, seqLength, seqLength + 8)
  const llSymbols = tLL.symbols
  const llBit = tLL.bit
  const llBase = tLL.base
  const mlSymbols = tML.symbols
  const mlBit = tML.bit
  const mlBase = tML.base
  const ofSymbols = tOF.symbols
  const ofBit = tOF.bit
  const ofBase = tOF.base

  for (let i = 0; i < nseq; i++) {
    const cOF = ofSymbols[sOF]
    const cML = mlSymbols[sML]
    const cLL = llSymbols[sLL]
    if (cOF > 31 || cML > 52 || cLL > 35) throw error('sequenceCodeOutOfRange')
    // Extra bits: first the distance, then the match, then the literals.
    let ofValue: number
    if (cOF === 0) ofValue = 1
    else if (cOF <= 24) {
      ofValue = (1 << cOF) + sequenceBits(pos, cOF)
      pos -= cOF
    } else {
      const top = sequenceBits(pos, cOF - 16)
      pos -= cOF - 16
      ofValue = 2 ** cOF + top * 65536 + sequenceBits(pos, 16)
      pos -= 16
    }
    let ml = BASE_ML[cML]
    let nb = BIT_ML[cML]
    if (nb > 0) {
      ml += sequenceBits(pos, nb)
      pos -= nb
    }
    let ll = BASE_LL[cLL]
    nb = BIT_LL[cLL]
    if (nb > 0) {
      ll += sequenceBits(pos, nb)
      pos -= nb
    }
    if (i < nseq - 1) {
      nb = llBit[sLL]
      sLL = llBase[sLL] + (nb > 0 ? sequenceBits(pos, nb) : 0)
      pos -= nb
      nb = mlBit[sML]
      sML = mlBase[sML] + (nb > 0 ? sequenceBits(pos, nb) : 0)
      pos -= nb
      nb = ofBit[sOF]
      sOF = ofBase[sOF] + (nb > 0 ? sequenceBits(pos, nb) : 0)
      pos -= nb
    }

    let distance: number
    if (ofValue > 3) {
      distance = ofValue - 3
      r3 = r2
      r2 = r1
      r1 = distance
    } else {
      const k = ofValue - 1 + (ll === 0 ? 1 : 0)
      if (k === 0) {
        distance = r1
      } else if (k === 1) {
        distance = r2
        r2 = r1
        r1 = distance
      } else if (k === 2) {
        distance = r3
        r3 = r2
        r2 = r1
        r1 = distance
      } else {
        distance = r1 - 1
        r3 = r2
        r2 = r1
        r1 = distance
      }
    }

    if (pl + ll > regenerated) throw error('literalsExhausted')
    if (o + ll + ml > out.length) {
      u.n = o
      u.space(ll + ml + regenerated)
      out = u.b
    }
    // Copy of the literals.
    if (ll < 16) {
      for (let k = 0; k < ll; k++) out[o + k] = literals[pl + k]
    } else {
      out.set(literals.subarray(pl, pl + ll), o)
    }
    o += ll
    pl += ll
    // Copy of the match, which may overlap itself.
    if (distance > o || distance <= 0) throw error('distanceBeforeStart')
    let from = o - distance
    if (distance >= ml && ml > 32) {
      out.copyWithin(o, from, from + ml)
      o += ml
    } else {
      const f = o + ml
      while (o < f) out[o++] = out[from++]
    }
  }
  if (pos !== 0) throw error('wrongSequenceStreamLength')
  recent[0] = r1
  recent[1] = r2
  recent[2] = r3
  // Literals left after the last sequence.
  const remainder = regenerated - pl
  if (o + remainder > out.length) {
    u.n = o
    u.space(remainder)
    out = u.b
  }
  out.set(literals.subarray(pl, regenerated), o)
  u.n = o + remainder
}

/** Decompression options. */
export interface ZstdOptions {
  /** Expected output size, if known: avoids growing the buffer. */
  size?: number
}

/** Whether the bytes start with the signature of a Zstandard frame. */
export function isZstd(d: Uint8Array): boolean {
  return d.length >= 4 && (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0 === MAGIC
}

/**
 * Decompresses a Zstandard stream: one or more concatenated frames
 * (skippable frames carrying user data are ignored).
 */
export function decompressZstd(data: Uint8Array, options: ZstdOptions = {}): Uint8Array {
  const u = new Output(options.size ?? data.length * 4)
  let p = 0
  let frame = 0
  while (p + 4 <= data.length) {
    const magic = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0
    p += 4
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      // Skippable frame: four length bytes followed by the content.
      if (p + 4 > data.length) throw new FitsError(t('coreZstd.truncated'))
      const skipLength = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0
      p += 4 + skipLength
      continue
    }
    if (magic !== MAGIC) {
      if (frame > 0) break
      throw new FitsError(t('coreZstd.notZstd'))
    }
    frame++
    if (p >= data.length) throw new FitsError(t('coreZstd.truncated'))
    const descriptor = data[p++]
    const bitFcs = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const withCheck = (descriptor >> 2) & 1
    const dictionaryBits = descriptor & 3
    if (descriptor & 8) throw error('reservedFrameBitSet')
    if (!singleSegment) p++ // window descriptor: here the whole output is held in memory
    const dictionaryLength = [0, 1, 2, 4][dictionaryBits]
    let dictionary = 0
    for (let k = 0; k < dictionaryLength; k++) dictionary += data[p + k] * 2 ** (8 * k)
    p += dictionaryLength
    if (dictionary !== 0) throw new FitsError(t('coreZstd.externalDictionary'))
    const fcsLength = bitFcs === 0 ? singleSegment : 1 << bitFcs
    let content = -1
    if (fcsLength > 0) {
      content = 0
      for (let k = 0; k < fcsLength; k++) content += data[p + k] * 2 ** (8 * k)
      if (fcsLength === 2) content += 256
      p += fcsLength
    }
    if (content >= 0) u.space(content)
    const frameStart = u.n

    const st: FrameState = { huffman: null, ll: null, of: null, ml: null, repeated: [1, 4, 8] }
    for (let last = 0; !last; ) {
      if (p + 3 > data.length) throw new FitsError(t('coreZstd.truncated'))
      const head = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)
      p += 3
      last = head & 1
      const type = (head >> 1) & 3
      const dim = head >> 3
      if (type === 0) {
        if (p + dim > data.length) throw new FitsError(t('coreZstd.truncated'))
        u.space(dim)
        u.b.set(data.subarray(p, p + dim), u.n)
        u.n += dim
        p += dim
      } else if (type === 1) {
        if (p >= data.length) throw new FitsError(t('coreZstd.truncated'))
        u.space(dim)
        u.b.fill(data[p], u.n, u.n + dim)
        u.n += dim
        p += 1
      } else if (type === 2) {
        if (p + dim > data.length) throw new FitsError(t('coreZstd.truncated'))
        if (dim > MAX_LITERALS_PER_BLOCK) throw error('blockTooLarge')
        compressedBlock(data, p, p + dim, u, st)
        p += dim
      } else {
        throw error('reservedBlockType')
      }
    }
    if (withCheck) {
      if (p + 4 > data.length) throw new FitsError(t('coreZstd.truncated'))
      const expected = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0
      if (xxh64Low(u.b, frameStart, u.n) !== expected) {
        throw new FitsError(t('coreZstd.corrupted'))
      }
      p += 4
    }
    if (content >= 0 && u.n - frameStart !== content) {
      throw error('frameSizeMismatch')
    }
  }
  if (frame === 0) throw new FitsError(t('coreZstd.notZstd'))
  return u.b.length === u.n ? u.b : u.b.subarray(0, u.n)
}
