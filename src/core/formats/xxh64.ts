/**
 * XXH64 (Yann Collet, as described in the xxHash specification), the 64-bit
 * hash that Zstandard uses as an optional frame check: the frame keeps its
 * low 32 bits, computed over the decompressed content with seed 0.
 *
 * JavaScript has no fast 64-bit integers (BigInt would cost seconds on a
 * hundred-megabyte block): each value is held as two 32-bit halves, and
 * multiplication is broken into 16-bit pieces that fit exactly in a
 * floating-point number.
 */

// The five prime constants of the specification, split into high and low halves.
const P1H = 0x9e3779b1, P1L = 0x85ebca87
const P2H = 0xc2b2ae3d, P2L = 0x27d4eb4f
const P3H = 0x165667b1, P3L = 0x9e3779f9
const P4H = 0x85ebca77, P4L = 0xc2b2ae63
const P5H = 0x27d4eb2f, P5L = 0x165667c5

// Result of the last operation: avoids creating objects in the loop.
let rh = 0
let rl = 0

/** (ah,al) · (bh,bl), low 64 bits. */
function mul(ah: number, al: number, bh: number, bl: number): void {
  const a0 = al & 0xffff, a1 = al >>> 16
  const b0 = bl & 0xffff, b1 = bl >>> 16
  const p00 = a0 * b0
  const p01 = a0 * b1
  const p10 = a1 * b0
  const p11 = a1 * b1
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff)
  rl = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0
  const top = p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)
  rh = (top + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0
}

/** (ah,al) + (bh,bl). */
function add(ah: number, al: number, bh: number, bl: number): void {
  const l = al + bl
  rl = l >>> 0
  rh = (ah + bh + (l > 0xffffffff ? 1 : 0)) >>> 0
}

/** Left rotation by r bits (0 < r < 64, r ≠ 32). */
function rotl(h: number, l: number, r: number): void {
  if (r > 32) {
    const t = h
    h = l
    l = t
    r -= 32
  }
  rh = ((h << r) | (l >>> (32 - r))) >>> 0
  rl = ((l << r) | (h >>> (32 - r))) >>> 0
}

/** One accumulation round: acc = rotl(acc + data·P2, 31)·P1. */
function step(ah: number, al: number, dh: number, dl: number): void {
  mul(dh, dl, P2H, P2L)
  add(ah, al, rh, rl)
  rotl(rh, rl, 31)
  mul(rh, rl, P1H, P1L)
}

function read32(d: Uint8Array, i: number): number {
  return (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0
}

/** The low 32 bits of XXH64 with seed 0 (what Zstandard keeps in the frame). */
export function xxh64Low(d: Uint8Array, start = 0, end = d.length): number {
  const total = end - start
  let i = start
  let hh: number, hl: number

  if (total >= 32) {
    // Four initial accumulators: P1+P2, P2, 0, −P1.
    add(P1H, P1L, P2H, P2L)
    let v1h = rh, v1l = rl
    let v2h = P2H, v2l = P2L
    let v3h = 0, v3l = 0
    // −P1 in two's complement.
    let v4h = ~P1H >>> 0, v4l = (~P1L + 1) >>> 0
    if (v4l === 0) v4h = (v4h + 1) >>> 0
    const limit = end - 32
    while (i <= limit) {
      step(v1h, v1l, read32(d, i + 4), read32(d, i))
      v1h = rh; v1l = rl
      step(v2h, v2l, read32(d, i + 12), read32(d, i + 8))
      v2h = rh; v2l = rl
      step(v3h, v3l, read32(d, i + 20), read32(d, i + 16))
      v3h = rh; v3l = rl
      step(v4h, v4l, read32(d, i + 28), read32(d, i + 24))
      v4h = rh; v4l = rl
      i += 32
    }
    rotl(v1h, v1l, 1)
    let sh = rh, sl = rl
    rotl(v2h, v2l, 7)
    add(sh, sl, rh, rl); sh = rh; sl = rl
    rotl(v3h, v3l, 12)
    add(sh, sl, rh, rl); sh = rh; sl = rl
    rotl(v4h, v4l, 18)
    add(sh, sl, rh, rl); hh = rh; hl = rl
    // Merge of each accumulator: h = (h ^ step(0, v))·P1 + P4.
    for (const [vh, vl] of [[v1h, v1l], [v2h, v2l], [v3h, v3l], [v4h, v4l]]) {
      step(0, 0, vh, vl)
      hh = (hh ^ rh) >>> 0
      hl = (hl ^ rl) >>> 0
      mul(hh, hl, P1H, P1L)
      add(rh, rl, P4H, P4L)
      hh = rh; hl = rl
    }
  } else {
    hh = P5H
    hl = P5L
  }

  // h += length (at most 2^53, but real blocks fit in 32 bits).
  add(hh, hl, Math.floor(total / 0x100000000), total >>> 0)
  hh = rh; hl = rl

  while (i + 8 <= end) {
    step(0, 0, read32(d, i + 4), read32(d, i))
    hh = (hh ^ rh) >>> 0
    hl = (hl ^ rl) >>> 0
    rotl(hh, hl, 27)
    mul(rh, rl, P1H, P1L)
    add(rh, rl, P4H, P4L)
    hh = rh; hl = rl
    i += 8
  }
  if (i + 4 <= end) {
    mul(0, read32(d, i), P1H, P1L)
    hh = (hh ^ rh) >>> 0
    hl = (hl ^ rl) >>> 0
    rotl(hh, hl, 23)
    mul(rh, rl, P2H, P2L)
    add(rh, rl, P3H, P3L)
    hh = rh; hl = rl
    i += 4
  }
  while (i < end) {
    mul(0, d[i], P5H, P5L)
    hh = (hh ^ rh) >>> 0
    hl = (hl ^ rl) >>> 0
    rotl(hh, hl, 11)
    mul(rh, rl, P1H, P1L)
    hh = rh; hl = rl
    i++
  }

  // Final avalanche: h ^= h>>33; h *= P2; h ^= h>>29; h *= P3; h ^= h>>32.
  hl = (hl ^ (hh >>> 1)) >>> 0
  mul(hh, hl, P2H, P2L)
  hh = rh; hl = rl
  hl = (hl ^ ((hl >>> 29) | (hh << 3))) >>> 0
  hh = (hh ^ (hh >>> 29)) >>> 0
  mul(hh, hl, P3H, P3L)
  hh = rh; hl = rl
  hl = (hl ^ hh) >>> 0
  return hl
}

/** Full XXH64 with seed 0, as hexadecimal text (for tests). */
export function xxh64Hex(d: Uint8Array): string {
  // Recomputes while also keeping the high half: same function, last state.
  const bottom = xxh64Low(d)
  return (rh >>> 0).toString(16).padStart(8, '0') + bottom.toString(16).padStart(8, '0')
}
