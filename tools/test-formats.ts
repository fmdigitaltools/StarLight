/**
 * Check of the input formats: compressed FITS (.fz, .fits.gz), XISF,
 * TIFF and PNG (src/core/formats, all read by `readFits`).
 *
 * For each file in the test folder (described in expected.json, written by
 * the test file generator):
 * - reads the whole file and compares the pixels with those of the source
 *   FITS (identical, or within quantization for lossy-compressed floats and
 *   for 8-bit files), or with the reference computed by cfitsio (astropy)
 *   for floats quantized with dithering;
 * - checks size, channels and the shooting data (object, exposure,
 *   coordinates, date, filter, instrument, Bayer, WCS) where the format
 *   carries them;
 * - re-reads the header alone starting from the first 64800 bytes, as the
 *   import does, reading more when the reader asks for it;
 * - for the files the reader must reject, checks that the error message is
 *   the right one (HCOMPRESS, PLIO and Zstandard have a separate check:
 *   test-rare-formats.ts);
 * - tries truncated files: an understandable error, never a hang;
 * - for TIFF and PNG it walks the headerless flow: stacked, without
 *   coordinates, object from the file name, recognition and field estimate.
 *
 * Usage:
 *   esbuild tools/test-formats.ts --bundle --platform=node --format=esm
 *     --alias:@shared=./src/shared --alias:@core=./src/core
 *     --outfile=<your file>.mjs
 *   node <your file>.mjs <test file folder>
 *
 * The test files are not part of the project: they come from a test FITS
 * and from a raw frame whose license does not allow redistribution.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFits, readFitsHeaderOnly, InsufficientHead } from '../src/core/fits/reader'
import { recognizeObjects, searchByName } from '../src/core/catalog/recognition'
import { fieldEstimate } from '../src/core/astrometry/solver'
import { objectFromFileName } from '../src/core/formats/objectFromName'
import { gunzip } from '../src/core/formats/inflate'
import type { FitsReadResult, FrameMetadata } from '../src/shared/types'
import { testFile } from './test-files.mjs'

const folder = process.argv[2]
/** The description of the files. */
const expectationsFile = folder ? join(folder, 'expected.json') : undefined
if (!folder || !expectationsFile || !existsSync(expectationsFile)) {
  console.log('Usage: node test-formats.mjs <folder with expected.json and the test files>')
  process.exit(1)
}

const ORIGINS: Record<string, string> = {
  m27: testFile('m27'),
  m16: testFile('m16-raw')
}

interface Expected {
  origin: string
  tolerance?: number
  reference?: string
  error?: string
  metadata?: boolean
  eightBit?: boolean
  /** Small file with its own reference (not the whole source FITS). */
  small?: boolean
  channels?: number
}
const expectations: Record<string, Expected> = JSON.parse(readFileSync(expectationsFile, 'utf8'))

let errors = 0
let checks = 0
function check(condition: boolean, description: string): void {
  checks++
  if (!condition) {
    errors++
    console.log('   ERROR: ' + description)
  }
}

/** Reads a float32 little-endian .npy file (the cfitsio reference). */
function readNpy(path: string): Float32Array {
  const b = readFileSync(path)
  const headerLength = b.readUInt16LE(8)
  const head = b.toString('latin1', 10, 10 + headerLength)
  if (!head.includes("'<f4'")) throw new Error('.npy reference is not float32: ' + head)
  const start = 10 + headerLength
  const copy = new Uint8Array(b.length - start)
  copy.set(b.subarray(start))
  return new Float32Array(copy.buffer)
}

const originals = new Map<string, FitsReadResult>()
for (const [k, path] of Object.entries(ORIGINS)) {
  originals.set(k, readFits(new Uint8Array(readFileSync(path)), path.split('/').pop()))
}

/** Maximum difference between two series of pixels. */
function maxResidual(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m || Number.isNaN(d)) m = Number.isNaN(d) ? Infinity : d
  }
  return m
}

/** Comparison of the shooting data with those of the source FITS. */
function compareMetadata(m: FrameMetadata, o: FrameMetadata, name: string): void {
  const neighbor = (a: number | null, b: number | null, tol: number): boolean =>
    a !== null && b !== null && Math.abs(a - b) <= tol
  check((m.object ?? '').trim() === (o.object ?? '').trim(), name + ': object ' + m.object + ' instead of ' + o.object)
  check(neighbor(m.exposure, o.exposure, 1e-6), name + ': exposure ' + m.exposure + ' instead of ' + o.exposure)
  check(neighbor(m.ra, o.ra, 1e-5) || (m.ra === null && o.ra === null), name + ': RA ' + m.ra + ' instead of ' + o.ra)
  check(neighbor(m.dec, o.dec, 1e-5) || (m.dec === null && o.dec === null), name + ': Dec ' + m.dec + ' instead of ' + o.dec)
  check(
    (m.dateObs ?? '').slice(0, 19) === (o.dateObs ?? '').slice(0, 19),
    name + ': date ' + m.dateObs + ' instead of ' + o.dateObs
  )
  check((m.filter ?? '') === (o.filter ?? ''), name + ': filter ' + m.filter + ' instead of ' + o.filter)
  check((m.instrument ?? '') === (o.instrument ?? ''), name + ': instrument ' + m.instrument + ' instead of ' + o.instrument)
  // The variant with only XISF properties declares neither Bayer nor WCS: the
  // scale then comes from the focal length (206.265 × 2.9 µm / 250 mm).
  const onlyProperties = name.includes('proprieta')
  check(m.bayer === (onlyProperties ? 'NONE' : o.bayer), name + ': Bayer ' + m.bayer + ' instead of ' + o.bayer)
  check(neighbor(m.focalLength, o.focalLength, 1e-3), name + ': focal length ' + m.focalLength + ' instead of ' + o.focalLength)
  check(neighbor(m.pixelSize, o.pixelSize, 1e-4), name + ': pixel ' + m.pixelSize + ' instead of ' + o.pixelSize)
  const expectedScale = onlyProperties ? (206.265 * 2.9) / 250 : o.pixelScale
  check(neighbor(m.pixelScale, expectedScale, 1e-3) || (m.pixelScale === null && expectedScale === null), name + ': scale ' + m.pixelScale + ' instead of ' + expectedScale)
}

/** Reads the header from the head of the file, reading more if the reader asks for it (as the import does). */
function headerFromHeadBytes(everything: Uint8Array, name: string): { info: ReturnType<typeof readFitsHeaderOnly>; readCount: number } {
  let readCount = 64800
  for (let attempt = 0; ; attempt++) {
    try {
      return { info: readFitsHeaderOnly(everything.subarray(0, Math.min(readCount, everything.length)), name, everything.length), readCount }
    } catch (e) {
      if (!(e instanceof InsufficientHead) || attempt > 4 || readCount >= everything.length) throw e
      readCount = Number.isFinite(e.neededBytes) ? Math.ceil(e.neededBytes) : everything.length
    }
  }
}

console.log('Input format check, ' + Object.keys(expectations).length + ' files\n')

for (const [name, wait] of Object.entries(expectations)) {
  const path = join(folder, name)
  const everything = new Uint8Array(readFileSync(path))
  const origin = originals.get(wait.origin)!

  if (wait.error) {
    let message = ''
    try {
      readFits(everything, name)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    check(message.includes(wait.error), name + ': expected an error about ' + wait.error + ', got "' + message + '"')
    console.log('ok? ' + name.padEnd(36) + ' clear error: "' + message.slice(0, 110) + '…"')
    continue
  }

  const t0 = performance.now()
  let r: FitsReadResult
  try {
    r = readFits(everything, name)
  } catch (e) {
    check(false, name + ': read failed: ' + (e instanceof Error ? e.message : String(e)))
    continue
  }
  const ms = performance.now() - t0

  let reference: Float32Array
  let expectedChannels = origin.image.channels
  if (wait.reference) {
    reference = readNpy(join(folder, wait.reference))
    // The cfitsio reference is in physical values: normalize here as the reader does.
    reference = reference.map((v) => (v > 0 ? (v < 1 ? v : 1) : 0))
    if (wait.small) expectedChannels = (wait.channels ?? 1) as 1 | 3
  } else {
    reference = origin.image.data
  }
  check(r.image.channels === expectedChannels, name + ': channels ' + r.image.channels + ' instead of ' + expectedChannels)
  if (!wait.small) {
    check(
      r.image.width === origin.image.width && r.image.height === origin.image.height,
      name + ': size ' + r.image.width + 'x' + r.image.height
    )
  }
  check(r.image.data.length === reference.length, name + ': different number of pixels')
  const rejection = r.image.data.length === reference.length ? maxResidual(r.image.data, reference) : Infinity
  const tolerance = wait.tolerance ?? 0
  check(rejection <= tolerance, name + ': maximum difference ' + rejection + ' above ' + tolerance)

  // Shooting data.
  const m = r.metadata
  if (wait.metadata) compareMetadata(m, origin.metadata, name)
  if (name.endsWith('.fz') || name.endsWith('.fits.gz')) {
    compareMetadata(m, origin.metadata, name)
    check((m.wcs !== null) === (origin.metadata.wcs !== null), name + ': WCS lost')
    check(r.bitpix === (name.includes('float') ? -32 : origin.bitpix), name + ': bitpix ' + r.bitpix)
  }
  if (name.endsWith('.xisf') && wait.metadata && !name.includes('proprieta')) {
    check((m.wcs !== null) === (origin.metadata.wcs !== null), name + ': WCS lost')
  }
  const withoutShot = name.endsWith('.tif') || name.endsWith('.png')
  if (withoutShot) {
    check(m.frameType === 'stacked', name + ': type ' + m.frameType + ' instead of stacked')
    check(m.wcs === null && m.ra === null && m.exposure === null, name + ': invented shooting data')
    check(m.format === (name.endsWith('.png') ? 'png' : 'tiff'), name + ': format ' + m.format)
  }

  // Header alone from the head of the file, as at import.
  let text = ''
  try {
    const { info, readCount } = headerFromHeadBytes(everything, name)
    const headerChannels = info.header.cards['NAXIS3'] === 3 ? 3 : 1
    check(info.width === r.image.width && info.height === r.image.height, name + ': size from the head ' + info.width + 'x' + info.height)
    check(headerChannels === r.image.channels, name + ': channels from the head ' + headerChannels)
    check(info.bitpix === r.bitpix, name + ': bitpix from the head ' + info.bitpix + ' instead of ' + r.bitpix)
    check(info.metadata.format === m.format, name + ': format from the head ' + info.metadata.format)
    check((info.metadata.object ?? '') === (m.object ?? ''), name + ': object from the head ' + info.metadata.object)
    check(info.metadata.bayer === m.bayer, name + ': Bayer from the head ' + info.metadata.bayer)
    text = readCount > 64800 ? ' (head re-read: ' + Math.round(readCount / 1024) + ' kB)' : ''
  } catch (e) {
    check(false, name + ': header from the head: ' + (e instanceof Error ? e.message : String(e)))
  }

  // Truncated file: understandable error.
  if (!wait.small) {
    let message = ''
    try {
      readFits(everything.subarray(0, Math.floor(everything.length * 0.6)), name)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    check(message !== '' && !/undefined|NaN|of null|is not/.test(message), name + ': truncated, message "' + message + '"')
  }

  console.log(
    'ok? ' +
      name.padEnd(36) +
      (ms.toFixed(0) + ' ms').padStart(8) +
      '  difference ' +
      rejection.toExponential(1) +
      '  ' +
      (m.object ?? '-') +
      ' · ' +
      (m.exposure ?? '-') +
      ' s · ' +
      m.bayer +
      ' · ' +
      (m.wcs ? 'WCS' : 'no WCS') +
      text
  )
}

// --- Headerless flow (TIFF, PNG) --------------------------------------------
console.log('\nHeaderless flow')
{
  const tiff = Object.keys(expectations).find((n) => n.startsWith('m27') && n.endsWith('.tif'))!
  const r = readFits(new Uint8Array(readFileSync(join(folder, tiff))), tiff)
  const bare = recognizeObjects(r.metadata, r.image.width, r.image.height)
  check(Array.isArray(bare), 'recognition without a header')
  const estimate = fieldEstimate(r.metadata, r.image.width, r.image.height, searchByName)
  check(estimate === null, 'field estimate without an object: it must say it cannot be done')
  // With the object name in the file name ("M_27.tif") the object is found again.
  const object = objectFromFileName('M_27.tif', searchByName)
  check(object === 'M 27', 'object from the name "M_27.tif": ' + object)
  const withName = { ...r.metadata, object: object }
  const estimate2 = fieldEstimate(withName, r.image.width, r.image.height, searchByName)
  check(estimate2 !== null && estimate2.origin === 'name', 'field estimate from the file name')
  const foundItems = recognizeObjects(withName, r.image.width, r.image.height)
  check(foundItems.some((o) => /27/.test(o.object.id) || /27/.test(o.object.name)), 'M 27 recognized from the file name')
  console.log(
    '   without a name: ' + bare.length + ' objects, field estimate ' + (estimate === null ? 'impossible (correct)' : 'present') +
      '; with "M_27.tif": object ' + object + ', center ' + estimate2?.ra.toFixed(3) + ' ' + estimate2?.dec.toFixed(3) + ', radius ' + estimate2?.radius + '°'
  )
  for (const [n, expected] of [
    ['NGC7000-HOO-finale.png', 'NGC 7000'],
    ['IC_5146_stack.tiff', 'IC 5146'],
    ['Enhanced_Stacked_40_M_27_10.0s_LP_20250101-220000.tif', 'M 27'],
    ['IMG_0001.png', null],
    ['result.tif', null]
  ] as [string, string | null][]) {
    const o = objectFromFileName(n, searchByName)
    check(o === expected, 'object from the name "' + n + '": ' + o + ' instead of ' + expected)
  }
}

// --- Decompressor: multiple gzip members and partial head ------------------
{
  const gz = Object.keys(expectations).find((n) => n.endsWith('.fits.gz'))!
  const b = new Uint8Array(readFileSync(join(folder, gz)))
  const doubled = new Uint8Array(b.length * 2)
  doubled.set(b)
  doubled.set(b, b.length)
  const one = gunzip(b)
  const two = gunzip(doubled)
  check(two.length === one.length * 2, 'gzip with two members')
  const partial = gunzip(b.subarray(0, 64800), { limit: 2880 * 120, partial: true })
  check(partial.length > 2880 && partial[0] === 0x53, 'partial gzip for the head only')
}

console.log('\n' + checks + ' checks, ' + errors + ' errors')
process.exit(errors > 0 ? 1 : 0)
