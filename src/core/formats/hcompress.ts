import { FitsError } from '@core/fits/common'
import { t } from '@shared/i18n/i18n'

/**
 * HCOMPRESS_1 decompression of the tiles of compressed FITS files (.fz).
 *
 * The algorithm is the one described by R. L. White, "High-performance
 * compression of astronomical images", Proceedings of the NASA Space and
 * Earth Science Data Compression Workshop (1992), 70-79:
 * - the image goes through the H transform, a two-dimensional Haar
 *   transform: each group of 2 × 2 pixels becomes a sum (h0), two
 *   differences (hx, hy) and a curvature (hc), and the process repeats on
 *   the sums down to a single coefficient;
 * - the coefficients are divided by a scale factor (lossy compression if
 *   the scale is greater than 1) and rounded;
 * - the absolute values are written one bit plane at a time, most
 *   significant first, each encoded with a four-branch tree (quadtree) and
 *   a small fixed Huffman code for the 2 × 2 bit groups; the signs follow
 *   separately, one for each non-zero coefficient.
 *
 * Decoding follows the inverse path: it reads the bit planes into the four
 * quadrants of the transform, restores the signs, multiplies by the scale
 * and inverts the transform. With a scale greater than 1 the reconstruction
 * can be "smoothed" (SMOOTH parameter): at each level the differences hx,
 * hy and hc are adjusted, within half the scale (the maximum error that
 * rounding can have introduced), toward the values that would make the
 * surface continuous with the neighboring blocks, without creating new
 * maxima or minima.
 *
 * The exact bit layout follows White's reference code distributed with
 * cfitsio (fits_hdecompress.c, © AURA/NASA, permissive license compatible
 * with the GPL), used here as documentation of the format: the code is
 * rewritten, not translated line by line.
 *
 * Calculations use 64-bit floating-point numbers, exact up to 2^53: they
 * also suffice for 32-bit images, where the coefficients exceed the range
 * of 32-bit integers.
 */

const MAGIC_0 = 0xdd
const MAGIC_1 = 0x99

/** Bit reader, most significant bit first, as the compressor writes them. */
class BitReader {
  p: number
  private buffer = 0
  private remaining = 0
  constructor(
    private readonly d: Uint8Array,
    start: number
  ) {
    this.p = start
  }
  private byte(): number {
    if (this.p >= this.d.length) throw new FitsError(t('coreHcompress.truncated'))
    return this.d[this.p++]
  }
  /** Restarts from the next byte boundary. */
  align(): void {
    this.remaining = 0
  }
  bit(): number {
    if (this.remaining === 0) {
      this.buffer = this.byte()
      this.remaining = 8
    }
    this.remaining--
    return (this.buffer >> this.remaining) & 1
  }
  bits(n: number): number {
    if (this.remaining < n) {
      this.buffer = ((this.buffer << 8) | this.byte()) & 0xffff
      this.remaining += 8
    }
    this.remaining -= n
    return (this.buffer >> this.remaining) & ((1 << n) - 1)
  }
  nybble(): number {
    return this.bits(4)
  }
}

/**
 * Fixed Huffman code for the 2 × 2 bit groups of the quadtree. The most
 * frequent values (a single bit set) have the shortest codes.
 */
function huffman(r: BitReader): number {
  let c = r.bits(3)
  if (c < 4) return 1 << c
  c = (c << 1) | r.bit()
  switch (c) {
    case 8:
      return 3
    case 9:
      return 5
    case 10:
      return 10
    case 11:
      return 12
    case 12:
      return 15
  }
  c = (c << 1) | r.bit()
  switch (c) {
    case 26:
      return 6
    case 27:
      return 7
    case 28:
      return 9
    case 29:
      return 11
    case 30:
      return 13
  }
  c = (c << 1) | r.bit()
  return c === 62 ? 0 : 14
}

/** Base-2 logarithm rounded up (0 for n ≤ 1). */
function log2Excess(n: number): number {
  let l = 0
  while (1 << l < n) l++
  return l
}

/**
 * Copies the 4-bit codes of `a` (size ⌈nx/2⌉ × ⌈ny/2⌉) into `b`
 * (nx × ny, rows of length `n`), expanding each code into a 2 × 2 block of
 * bits: 8 → (0,0), 4 → (0,1), 2 → (1,0), 1 → (1,1). `a` and `b` may be the
 * same array: copying starts from the end.
 */
function copyQuadtree(a: Uint8Array, nx: number, ny: number, b: Uint8Array, n: number): void {
  const nx2 = (nx + 1) >> 1
  const ny2 = (ny + 1) >> 1
  let k = ny2 * nx2 - 1
  for (let i = nx2 - 1; i >= 0; i--) {
    for (let j = ny2 - 1; j >= 0; j--) b[2 * (n * i + j)] = a[k--]
  }
  for (let i = 0; i < nx; i += 2) {
    const s00 = n * i
    const s10 = s00 + n
    for (let j = 0; j < ny; j += 2) {
      const v = b[s00 + j]
      const lastRow = i + 1 >= nx
      const lastColumn = j + 1 >= ny
      if (!lastRow) {
        if (!lastColumn) b[s10 + j + 1] = v & 1
        b[s10 + j] = (v >> 1) & 1
      }
      if (!lastColumn) b[s00 + j + 1] = (v >> 2) & 1
      b[s00 + j] = (v >> 3) & 1
    }
  }
}

/** Inserts the 4-bit codes of `a` into bit plane `weight` of `b`, as copyQuadtree does. */
function insertPlane(
  a: Uint8Array,
  nx: number,
  ny: number,
  b: Float64Array,
  start: number,
  n: number,
  weight: number
): void {
  let k = 0
  for (let i = 0; i < nx; i += 2) {
    const s00 = start + n * i
    const s10 = s00 + n
    const lastRow = i + 1 >= nx
    for (let j = 0; j < ny; j += 2) {
      const v = a[k++]
      if (v === 0) continue
      const lastColumn = j + 1 >= ny
      if (v & 8) b[s00 + j] += weight
      if (v & 4 && !lastColumn) b[s00 + j + 1] += weight
      if (!lastRow) {
        if (v & 2) b[s10 + j] += weight
        if (v & 1 && !lastColumn) b[s10 + j + 1] += weight
      }
    }
  }
}

/** Decodes the bit planes of a quadrant (nqx × nqy, rows of length n). */
function decodeQuadrant(
  r: BitReader,
  a: Float64Array,
  start: number,
  n: number,
  nqx: number,
  nqy: number,
  planes: number
): void {
  if (nqx <= 0 || nqy <= 0) {
    // Empty quadrant: the compressor still writes one code per plane.
    for (let bit = planes - 1; bit >= 0; bit--) r.nybble()
    return
  }
  const log2n = log2Excess(Math.max(nqx, nqy))
  const nqx2 = (nqx + 1) >> 1
  const nqy2 = (nqy + 1) >> 1
  const job = new Uint8Array(Math.max(1, nqx * nqy))
  for (let bit = planes - 1; bit >= 0; bit--) {
    const mode = r.nybble()
    const weight = 2 ** bit
    if (mode === 0) {
      // Plane written directly, four bits per 2 × 2 group.
      const m = nqx2 * nqy2
      for (let i = 0; i < m; i++) job[i] = r.nybble()
    } else if (mode === 0xf) {
      // Plane encoded with the quadtree: start from a single code and expand
      // log2n - 1 times, reading a new code for each set branch.
      job[0] = huffman(r)
      let nx = 1
      let ny = 1
      let nfx = nqx
      let nfy = nqy
      let c = 1 << log2n
      for (let k = 1; k < log2n; k++) {
        c >>= 1
        nx <<= 1
        ny <<= 1
        if (nfx <= c) nx -= 1
        else nfx -= c
        if (nfy <= c) ny -= 1
        else nfy -= c
        copyQuadtree(job, nx, ny, job, ny)
        for (let i = nx * ny - 1; i >= 0; i--) if (job[i]) job[i] = huffman(r)
      }
    } else {
      throw new FitsError(t('coreHcompress.unknownBitPlaneCode'))
    }
    insertPlane(job, nqx, nqy, a, start, n, weight)
  }
}

/** Decoding result: coefficients, dimensions and scale. */
interface Coefficients {
  a: Float64Array
  /** Rows (slow axis). */
  nx: number
  /** Columns (fast axis). */
  ny: number
  scale: number
}

function decode(d: Uint8Array): Coefficients {
  if (d.length < 25 || d[0] !== MAGIC_0 || d[1] !== MAGIC_1) {
    throw new FitsError(t('coreHcompress.missingSignature'))
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const nx = v.getInt32(2, false)
  const ny = v.getInt32(6, false)
  const scale = v.getInt32(10, false)
  const sum = v.getInt32(14, false) * 4294967296 + v.getUint32(18, false)
  const planes = [d[22], d[23], d[24]]
  if (nx <= 0 || ny <= 0 || nx * ny > 1 << 28) throw new FitsError(t('coreHcompress.invalidDimensions'))
  if (planes.some((p) => p > 64)) throw new FitsError(t('coreHcompress.invalidBitPlanes'))

  const a = new Float64Array(nx * ny)
  const nx2 = (nx + 1) >> 1
  const ny2 = (ny + 1) >> 1
  const r = new BitReader(d, 25)
  // The four quadrants of the transform: sums, differences in y, in x, curvatures.
  decodeQuadrant(r, a, 0, ny, nx2, ny2, planes[0])
  decodeQuadrant(r, a, ny2, ny, nx2, ny >> 1, planes[1])
  decodeQuadrant(r, a, ny * nx2, ny, nx >> 1, ny2, planes[1])
  decodeQuadrant(r, a, ny * nx2 + ny2, ny, nx >> 1, ny >> 1, planes[2])
  if (r.nybble() !== 0) throw new FitsError(t('coreHcompress.invalidEnd'))
  // The signs, from the next byte boundary.
  r.align()
  for (let i = 0; i < a.length; i++) if (a[i] !== 0 && r.bit()) a[i] = -a[i]
  // The first coefficient is the sum of all pixels, written separately.
  a[0] = sum
  return { a, nx, ny, scale }
}

/**
 * Reorders n elements (at stride `step` from `start`): the first half goes
 * to the even positions, the second half to the odd ones.
 */
function unshuffle(a: Float64Array, start: number, n: number, step: number, tmp: Float64Array): void {
  const meta = (n + 1) >> 1
  for (let i = meta, t = 0; i < n; i++) tmp[t++] = a[start + i * step]
  for (let i = meta - 1; i >= 0; i--) a[start + 2 * i * step] = a[start + i * step]
  for (let i = 1, t = 0; i < n; i += 2) a[start + i * step] = tmp[t++]
}

/** Integer division truncated toward zero. */
const truncate = Math.trunc

/**
 * Smoothing of the coefficients of one level (White 1992): hx, hy and hc of
 * each block are moved toward the slope and curvature suggested by the sums
 * of the neighboring blocks, with monotonicity constraints and a correction
 * never beyond half the scale. Blocks on the edge are left as they are.
 */
function smooth(a: Float64Array, nxtop: number, nytop: number, ny: number, scale: number): void {
  const smax = scale >> 1
  if (smax <= 0) return
  const ny2 = 2 * ny
  // Differences in x (hx).
  for (let i = 2; i < nxtop - 2; i += 2) {
    let s00 = ny * i
    let s10 = s00 + ny
    for (let j = 0; j < nytop; j += 2) {
      const hm = a[s00 - ny2]
      const h0 = a[s00]
      const hp = a[s00 + ny2]
      let diff = hp - hm
      const dmax = Math.max(Math.min(hp - h0, h0 - hm), 0) * 4
      const dmin = Math.min(Math.max(hp - h0, h0 - hm), 0) * 4
      if (dmin < dmax) {
        diff = Math.max(Math.min(diff, dmax), dmin)
        let s = truncate((diff - a[s10] * 8) / 8)
        s = Math.max(Math.min(s, smax), -smax)
        a[s10] += s
      }
      s00 += 2
      s10 += 2
    }
  }
  // Differences in y (hy).
  for (let i = 0; i < nxtop; i += 2) {
    let s00 = ny * i + 2
    for (let j = 2; j < nytop - 2; j += 2) {
      const hm = a[s00 - 2]
      const h0 = a[s00]
      const hp = a[s00 + 2]
      let diff = hp - hm
      const dmax = Math.max(Math.min(hp - h0, h0 - hm), 0) * 4
      const dmin = Math.min(Math.max(hp - h0, h0 - hm), 0) * 4
      if (dmin < dmax) {
        diff = Math.max(Math.min(diff, dmax), dmin)
        let s = truncate((diff - a[s00 + 1] * 8) / 8)
        s = Math.max(Math.min(s, smax), -smax)
        a[s00 + 1] += s
      }
      s00 += 2
    }
  }
  // Curvature (hc).
  for (let i = 2; i < nxtop - 2; i += 2) {
    let s00 = ny * i + 2
    let s10 = s00 + ny
    for (let j = 2; j < nytop - 2; j += 2) {
      const hmm = a[s00 - ny2 - 2]
      const hpm = a[s00 + ny2 - 2]
      const hmp = a[s00 - ny2 + 2]
      const hpp = a[s00 + ny2 + 2]
      const h0 = a[s00]
      let diff = hpp + hmm - hmp - hpm
      const hx2 = a[s10] * 2
      const hy2 = a[s00 + 1] * 2
      let m1 = Math.min(Math.max(hpp - h0, 0) - hx2 - hy2, Math.max(h0 - hpm, 0) + hx2 - hy2)
      let m2 = Math.min(Math.max(h0 - hmp, 0) - hx2 + hy2, Math.max(hmm - h0, 0) + hx2 + hy2)
      const dmax = Math.min(m1, m2) * 16
      m1 = Math.max(Math.min(hpp - h0, 0) - hx2 - hy2, Math.min(h0 - hpm, 0) + hx2 - hy2)
      m2 = Math.max(Math.min(h0 - hmp, 0) - hx2 + hy2, Math.min(hmm - h0, 0) + hx2 + hy2)
      const dmin = Math.max(m1, m2) * 16
      if (dmin < dmax) {
        diff = Math.max(Math.min(diff, dmax), dmin)
        let s = truncate((diff - a[s10 + 1] * 64) / 64)
        s = Math.max(Math.min(s, smax), -smax)
        a[s10 + 1] += s
      }
      s00 += 2
      s10 += 2
    }
  }
}

/** Rounds x to a multiple of `step` (a power of two), with the given offsets for positive and negative values. */
function round(x: number, more: number, minus: number, step: number): number {
  return Math.floor((x + (x >= 0 ? more : minus)) / step) * step
}

/** Bit of weight `step` of x (in two's complement for negative values too). */
function bitsOf(x: number, step: number): number {
  return Math.floor(x / step) & 1
}

/** Inverse H transform, level by level starting from the coarsest. */
function inverseTransform(a: Float64Array, nx: number, ny: number, shouldSmooth: boolean, scale: number): void {
  const nmax = Math.max(nx, ny)
  const log2n = log2Excess(nmax)
  if (log2n === 0) return
  const tmp = new Float64Array((nmax + 1) >> 1)
  let bit0 = 2 ** (log2n - 1)
  let bit1 = bit0 * 2
  let prnd0 = Math.floor(bit0 / 2)
  let prnd1 = bit1 / 2
  const prnd2 = bit1
  let nrnd0 = prnd0 - 1
  let nrnd1 = prnd1 - 1
  const nrnd2 = prnd2 - 1
  let divisor = 2
  // The sum becomes a multiple of 4 × bit0.
  a[0] = round(a[0], prnd2, nrnd2, bit1 * 2)

  let nxtop = 1
  let nytop = 1
  let nxf = nx
  let nyf = ny
  let c = 1 << log2n
  for (let k = log2n - 1; k >= 0; k--) {
    c >>= 1
    nxtop <<= 1
    nytop <<= 1
    if (nxf <= c) nxtop -= 1
    else nxf -= c
    if (nyf <= c) nytop -= 1
    else nyf -= c
    // At the last step the division is by 4 and negative values are not rounded.
    if (k === 0) {
      nrnd0 = 0
      divisor = 4
    }
    for (let i = 0; i < nxtop; i++) unshuffle(a, ny * i, nytop, 1, tmp)
    for (let j = 0; j < nytop; j++) unshuffle(a, j, nxtop, ny, tmp)
    if (shouldSmooth) smooth(a, nxtop, nytop, ny, scale)

    const oddX = nxtop % 2
    const oddY = nytop % 2
    let i = 0
    for (; i < nxtop - oddX; i += 2) {
      let s00 = ny * i
      let s10 = s00 + ny
      for (let j = 0; j < nytop - oddY; j += 2) {
        let h0 = a[s00]
        let hx = round(a[s10], prnd1, nrnd1, bit1)
        let hy = round(a[s00 + 1], prnd1, nrnd1, bit1)
        const hc = round(a[s10 + 1], prnd0, nrnd0, bit0)
        // The low bit of hc moves to hx and hy, the low bits of all of them
        // to h0: this keeps the inversion exact even with negative values.
        const low0 = bitsOf(hc, bit0) * bit0
        hx = hx >= 0 ? hx - low0 : hx + low0
        hy = hy >= 0 ? hy - low0 : hy + low0
        const low1 = (bitsOf(hc, bit1) ^ bitsOf(hx, bit1) ^ bitsOf(hy, bit1)) * bit1
        h0 = h0 >= 0 ? h0 + low0 - low1 : h0 + (low0 === 0 ? low1 : low0 - low1)
        a[s10 + 1] = Math.floor((h0 + hx + hy + hc) / divisor)
        a[s10] = Math.floor((h0 + hx - hy - hc) / divisor)
        a[s00 + 1] = Math.floor((h0 - hx + hy - hc) / divisor)
        a[s00] = Math.floor((h0 - hx - hy + hc) / divisor)
        s00 += 2
        s10 += 2
      }
      if (oddY) {
        // Last element of a row of odd length.
        let h0 = a[s00]
        const hx = round(a[s10], prnd1, nrnd1, bit1)
        const low1 = bitsOf(hx, bit1) * bit1
        h0 = h0 >= 0 ? h0 - low1 : h0 + low1
        a[s10] = Math.floor((h0 + hx) / divisor)
        a[s00] = Math.floor((h0 - hx) / divisor)
      }
    }
    if (oddX) {
      // Last row, if the number of rows is odd.
      let s00 = ny * i
      let j = 0
      for (; j < nytop - oddY; j += 2) {
        let h0 = a[s00]
        const hy = round(a[s00 + 1], prnd1, nrnd1, bit1)
        const low1 = bitsOf(hy, bit1) * bit1
        h0 = h0 >= 0 ? h0 - low1 : h0 + low1
        a[s00 + 1] = Math.floor((h0 + hy) / divisor)
        a[s00] = Math.floor((h0 - hy) / divisor)
        s00 += 2
      }
      if (oddY) a[s00] = Math.floor(a[s00] / divisor)
    }
    // At the next level the steps are halved.
    bit1 = bit0
    bit0 /= 2
    prnd1 = prnd0
    prnd0 = Math.floor(prnd0 / 2)
    nrnd1 = nrnd0
    nrnd0 = prnd0 - 1
  }
}

/**
 * Decompresses an HCOMPRESS_1 tile. Returns the integer values (before
 * BSCALE/BZERO or dequantization), in FITS order, and the dimensions read
 * from the tile.
 */
export function decompressHcompress(
  data: Uint8Array,
  shouldSmooth: boolean
): { values: Float64Array; rows: number; columns: number } {
  const { a, nx, ny, scale } = decode(data)
  if (scale > 1) for (let i = 0; i < a.length; i++) a[i] *= scale
  inverseTransform(a, nx, ny, shouldSmooth, scale)
  return { values: a, rows: nx, columns: ny }
}
