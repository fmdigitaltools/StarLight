/**
 * Test of rare compressions: tiled FITS with HCOMPRESS_1 and PLIO_1,
 * XISF with Zstandard (also "zstd+sh" and with sub-blocks) and the
 * Zstandard decompressor on its own.
 *
 * The sample files are written by tools independent of StarLight:
 * - the FITS files by astropy (which uses cfitsio), with the pixel reference
 *   read by astropy itself: HCOMPRESS with and without loss (scale,
 *   smoothing), 8, 16 and 32-bit integers, floats quantized with
 *   SUBTRACTIVE_DITHER_1 and _2, PLIO masks;
 * - the XISF files from the Python package "xisf" (zlib, LZ4, LZ4-HC,
 *   Zstandard, with and without byte shuffling; mono and RGB, 16-bit and
 *   float) and by hand following the XISF 1.0 specification (sub-blocks,
 *   interleaved pixels, bounds other than 0:1);
 * - the Zstandard streams from the "zstandard" library (levels -7 to 22,
 *   raw and RLE blocks, XXH64 check, multiple and skippable frames);
 * - a small real XISF written by a third-party application, taken from the
 *   tests of the xisf-rs project (MIT license, text in
 *   the LICENSE text file next to it).
 * Each file has in expected.json the name of its reference (ref-*.bin), which
 * is the expected result: the pixels read by astropy for the FITS files,
 * the original pixels for the XISF files, the original bytes for the
 * Zstandard streams. The comparison is exact (zero tolerance): even with
 * lossy HCOMPRESS the result must match that of the reference library; the
 * deviation from the original image, which measures the intended loss, is
 * reported separately.
 *
 * Usage:
 *   esbuild tools/test-rare-formats.ts --bundle --platform=node --format=esm
 *     --alias:@shared=./src/shared --alias:@core=./src/core
 *     --outfile=<your file>.mjs
 *   node <your file>.mjs <folder with expected.json>
 *
 * The samples are among the test files, role "rare-formats" (synthetic
 * images, no license issues) and are regenerated with
 * tools/generate-rare-samples.py, which requires Python with astropy, xisf
 * and zstandard (to be installed outside the project, in a virtual
 * environment).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readHeader } from '../src/core/fits/header'
import { readFits } from '../src/core/fits/reader'
import { decompressImage } from '../src/core/formats/compressedFits'
import { readXisf } from '../src/core/formats/xisf'
import { decompressZstd } from '../src/core/formats/zstd'
import { xxh64Low } from '../src/core/formats/xxh64'

const folder = process.argv[2]
/** The description of the samples. */
const expectationsFile = folder ? join(folder, 'expected.json') : undefined
if (!folder || !expectationsFile || !existsSync(expectationsFile)) {
  console.log('Usage: node test-rare-formats.mjs <folder with expected.json and the sample files>')
  process.exit(77)
}

interface Expected {
  type: 'fits' | 'xisf' | 'zstd'
  description: string
  reference: string
  width?: number
  height?: number
  channels?: number
  dtype?: string
  maxErrorFromOriginal?: number
  rmsErrorFromOriginal?: number
  /** Object name written in the header (FITS samples and those built by hand). */
  object?: string
}
const expectations: Record<string, Expected> = JSON.parse(readFileSync(expectationsFile, 'utf8'))
/** Samples built by hand. */
const byHand = (name: string): boolean => name.startsWith('hand-')

let errors = 0
let checks = 0
function check(condition: boolean, description: string): void {
  checks++
  if (!condition) {
    errors++
    console.log('   ERROR: ' + description)
  }
}

function byte(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(folder, name)))
}
function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}

/** First differing pixel and maximum deviation between two series. */
function compare(a: Float32Array, b: Float32Array): { different: number; max: number } {
  let different = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) {
      different++
      const d = Math.abs(a[i] - b[i])
      if (!(d <= max)) max = d
    }
  }
  return { different, max }
}

console.log('Rare compression test, ' + Object.keys(expectations).length + ' files\n')

for (const [name, a] of Object.entries(expectations)) {
  const data = byte(name)
  const ref = byte(a.reference)
  let row = ''
  const t0 = performance.now()
  try {
    if (a.type === 'zstd') {
      const u = decompressZstd(data)
      const ms = performance.now() - t0
      let equal = u.length === ref.length
      for (let i = 0; equal && i < u.length; i++) if (u[i] !== ref[i]) equal = false
      check(equal, name + ': bytes differ from the original (' + u.length + ' instead of ' + ref.length + ')')
      row = (ref.length + ' byte').padStart(13) + (ms.toFixed(1) + ' ms').padStart(10) + '  identical'
    } else if (a.type === 'fits') {
      const primary = readHeader(data, 0)
      const table = readHeader(data, primary.dataOffset)
      const img = decompressImage(data, table.header, table.dataOffset)
      const ms = performance.now() - t0
      const expected = new Float32Array(ref.buffer, ref.byteOffset, ref.byteLength / 4)
      check(img.width === a.width && img.height === a.height, name + ': dimensions ' + img.width + 'x' + img.height)
      check(img.raw.length === expected.length, name + ': different pixel count')
      const c = compare(img.raw, expected)
      check(c.different === 0, name + ': ' + c.different + ' pixels differ from astropy, maximum deviation ' + c.max)
      // Full read as on import: header and normalized image.
      const r = readFits(data, name)
      check(r.image.width === a.width && r.metadata.object === a.object, name + ': full read')
      check(r.metadata.format === 'fits-compressed', name + ': format ' + r.metadata.format)
      const loss =
        a.maxErrorFromOriginal! > 0
          ? '  intended loss: max ' + a.maxErrorFromOriginal!.toPrecision(3) + ', rms ' + a.rmsErrorFromOriginal!.toPrecision(3)
          : '  lossless'
      row =
        (img.width + 'x' + img.height + ' ' + img.bitpix).padStart(13) +
        (ms.toFixed(1) + ' ms').padStart(10) +
        '  identical to astropy' +
        (c.different ? ' NO' : '') +
        loss
    } else {
      const x = readXisf(data)
      const ms = performance.now() - t0
      const n = a.width! * a.height! * a.channels!
      check(x.width === a.width && x.height === a.height && x.channels === a.channels, name + ': geometry')
      // Expected values with the same normalization as the reader.
      const v = view(ref)
      const expected = new Float32Array(n)
      if (a.dtype === 'u2') for (let i = 0; i < n; i++) expected[i] = v.getUint16(i * 2, true) * (1 / 65535)
      else if (a.dtype === 'u1') for (let i = 0; i < n; i++) expected[i] = ref[i] * (1 / 255)
      else if (a.dtype === 'f4') for (let i = 0; i < n; i++) expected[i] = v.getFloat32(i * 4, true)
      else if (a.dtype === 'f4b') {
        // Declared bounds -1000:130070 (hand-built file).
        for (let i = 0; i < n; i++) expected[i] = (v.getFloat32(i * 4, true) + 1000) * (1 / 131070)
      }
      const c = compare(x.raw, expected)
      check(x.raw.length === n && c.different === 0, name + ': ' + c.different + ' pixels differ, maximum deviation ' + c.max)
      const r = readFits(data, name)
      check(r.metadata.format === 'xisf' && r.image.channels === a.channels, name + ': full read')
      if (byHand(name)) {
        check(r.metadata.object === a.object && r.metadata.exposure === 30, name + ': capture data ' + r.metadata.object + ' ' + r.metadata.exposure)
      }
      row =
        (x.width + 'x' + x.height + 'x' + x.channels).padStart(13) +
        (ms.toFixed(1) + ' ms').padStart(10) +
        '  identical to the original' +
        (c.different ? ' NO' : '')
    }
  } catch (e) {
    check(false, name + ': read failed: ' + (e instanceof Error ? e.message : String(e)))
    continue
  }
  console.log('ok? ' + name.padEnd(36) + row + '  (' + a.description + ')')
}

// --- Damaged files: an understandable error, never a hang ------------------
console.log('\nDamaged files')
for (const name of Object.keys(expectations).filter((n) => /^(hc-i16-s4-smooth|plio-i16)\.fz$|^hand-rgb16-zstd\.xisf$|^text-l22\.zst$/.test(n))) {
  const data = byte(name)
  for (const [asValue, corrupted] of [
    ['truncated', data.subarray(0, Math.floor(data.length * 0.7))],
    ['altered bytes', (() => {
      const c = data.slice()
      for (let i = Math.floor(c.length * 0.5); i < c.length * 0.5 + 64 && i < c.length; i++) c[i] ^= 0x5a
      return c
    })()]
  ] as [string, Uint8Array][]) {
    let message = ''
    try {
      if (name.endsWith('.zst')) decompressZstd(corrupted)
      else readFits(corrupted, name)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    // A FITS with altered bytes may even be readable (wrong pixels): all that matters is that it does not hang.
    const acceptable = message === '' ? asValue === 'altered bytes' && !name.endsWith('.zst') : !/undefined|NaN|of null|is not/.test(message)
    check(acceptable, name + ' ' + asValue + ': «' + message + '»')
    console.log('   ' + (name + ' ' + asValue).padEnd(42) + (message ? '«' + message + '»' : 'read without errors'))
  }
}

// --- Zstandard integrity check (XXH64) --------------------------------------
console.log('\nIntegrity check')
{
  const text = (s: string): Uint8Array => new TextEncoder().encode(s)
  for (const [s, expected] of [
    ['', 0x51d8e999],
    ['abc', 0xad770999],
    ['Nobody inspects the spammish repetition', 0x8a378bf1]
  ] as [string, number][]) {
    check(xxh64Low(text(s)) === expected, 'XXH64 of "' + s + '" equals the reference value')
  }
  // The checksum.zst frame carries the checksum in its last four bytes:
  // altering one of them, the read must stop with a clear error.
  const checksumFile = 'checksum.zst'
  const data = byte(checksumFile).slice()
  data[data.length - 1] ^= 0x01
  let message = ''
  try {
    decompressZstd(data)
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  check(/integrità/.test(message), 'altered checksum recognized: «' + message + '»')
  console.log('   ' + (checksumFile + ' with altered checksum').padEnd(45) + '«' + message + '»')
}

console.log('\n' + checks + ' checks, ' + errors + ' errors')
process.exit(errors > 0 ? 1 : 0)
