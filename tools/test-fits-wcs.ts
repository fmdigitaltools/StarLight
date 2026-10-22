/**
 * Test of the FITS export with the astrometric solution.
 *
 * The M 27 sample file is exported with a crop and a resize (also with
 * different horizontal and vertical factors, like a preset), the file is
 * reread with `readFits` + `readWcs` and the test checks that:
 * - M 27 falls where the crop and the resize moved its pixels, and that
 *   the nebula is really there;
 * - the whole field comes back, not just the center (that is, the SIP
 *   distortion was adapted correctly too);
 * - the capture data (object, date, exposure, instrument, filter,
 *   coordinates) are in the file.
 *
 * Usage (with its own output file, see tools/run-test.mjs):
 *   esbuild tools/test-fits-wcs.ts --bundle --platform=node --format=esm
 *     --alias:@shared=./src/shared --alias:@core=./src/core --outfile=<yours>.mjs
 *   node <yours>.mjs [file.fit]
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { encodeFits } from '../src/core/export/encoding'
import { cropRegion, cropRectangle, exportedWcs, type Crop } from '../src/core/export/crop'
import { resize } from '../src/core/export/resize'
import { readWcs, skyToPixel, pixelToSky, scaleArcsec, wcsScale, resizeWcs } from '../src/core/astrometry/wcs'
import type { ImageData32, Wcs } from '../src/shared/types'
import { testFile } from './test-files.mjs'

let problems = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  OK   ' : '  ERROR ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) problems++
}

const source = process.argv[2] ?? testFile('m27')
const readResult = readFits(new Uint8Array(readFileSync(source)), source)
const image = debayer(readResult.image, readResult.metadata.bayer)
const wcs = readWcs(readResult.header)
if (wcs === null) {
  console.log('The sample file has no astrometric solution.')
  process.exit(1)
}
const cards = readResult.header.cards as Record<string, string | number | boolean | null>
console.log('source: ' + image.width + ' x ' + image.height + ', ' + scaleArcsec(wcs).toFixed(3) + '″/px')

// M 27 from the StarLight catalog.
const M27 = { ra: 299.902, dec: 22.721 }
const p0Found = skyToPixel(wcs, M27.ra, M27.dec)
if (p0Found === null) process.exit(1)
const p0 = p0Found
console.log('M 27 in the original: x ' + p0.x.toFixed(1) + ', y ' + p0.y.toFixed(1))

/** Mean brightness (first channel) in a square around a FITS pixel. */
function mean(img: ImageData32, x: number, y: number, r: number): number {
  let s = 0
  let n = 0
  for (let yy = Math.round(y - 1 - r); yy <= Math.round(y - 1 + r); yy++) {
    for (let xx = Math.round(x - 1 - r); xx <= Math.round(x - 1 + r); xx++) {
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue
      s += img.data[yy * img.width + xx]
      n++
    }
  }
  return n > 0 ? s / n : NaN
}

/** Exports as the Export panel does and rereads. */
function test(name: string, r: Crop, width: number, height: number): void {
  console.log('--- ' + name + ' ---')
  const q = cropRectangle(r, image.width, image.height)
  let output = cropRegion(image, r)
  if (output.width !== width || output.height !== height) output = resize(output, width, height)
  const kx = width / q.width
  const ky = height / q.height
  const w = exportedWcs(wcs, image.width, image.height, r, output.width, output.height)
  const data = encodeFits(output, cards, 16, { wcs: w, upscaling: [kx, ky] })
  const reread = readFits(new Uint8Array(data))
  const w2 = readWcs(reread.header)
  result('the reread file has the solution', w2 !== null, reread.header.cards['CTYPE1'] as string)
  if (w2 === null || wcs === null) return
  result('dimensions', reread.image.width === width && reread.image.height === height, width + ' x ' + height)

  // Where a pixel of the original must land after crop and scale: the outer
  // edges coincide (as in resize).
  const expected = (x: number, y: number): { x: number; y: number } => ({
    x: (x - 0.5 - q.x0) * kx + 0.5,
    y: (y - 0.5 - q.y0) * ky + 0.5
  })

  const p1 = skyToPixel(w2, M27.ra, M27.dec)
  const a1 = expected(p0.x, p0.y)
  const rejection = p1 ? Math.hypot(p1.x - a1.x, p1.y - a1.y) : Infinity
  result(
    'M 27 at the right point',
    rejection < 0.05,
    p1 ? 'x ' + p1.x.toFixed(2) + ', y ' + p1.y.toFixed(2) + ' (deviation ' + rejection.toFixed(4) + ' px)' : 'outside'
  )

  // The nebula is really there: brighter than the background (slightly so in
  // linear data) and with the same brightness it has in the original.
  if (p1) {
    const radius = 6
    const center = mean(reread.image, p1.x, p1.y, radius * Math.min(kx, ky))
    const background = mean(reread.image, p1.x + 150 * kx, p1.y + 150 * ky, radius * Math.min(kx, ky))
    const center0 = mean(image, p0.x, p0.y, radius)
    result(
      'the nebula is at that point',
      center > background * 1.05 && Math.abs(center - center0) < 0.02 * center0,
      'center ' + center.toFixed(4) + ' (original ' + center0.toFixed(4) + '), background ' + background.toFixed(4)
    )
  }

  // The whole cropped field: sky from the original, pixels from the new file.
  let worst = 0
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      const x = q.x0 + 0.5 + (q.width * i) / 6
      const y = q.y0 + 0.5 + (q.height * j) / 6
      const sky = pixelToSky(wcs, x, y)
      const p = skyToPixel(w2, sky.ra, sky.dec)
      const a = expected(x, y)
      worst = Math.max(worst, p ? Math.hypot(p.x - a.x, p.y - a.y) : Infinity)
      // And backward, with the forward distortion (A, B).
      const c2 = pixelToSky(w2, a.x, a.y)
      const d = Math.hypot((c2.ra - sky.ra) * Math.cos((sky.dec * Math.PI) / 180), c2.dec - sky.dec) * 3600
      worst = Math.max(worst, d / scaleArcsec(w2))
    }
  }
  result('the whole field comes back, distortion included', worst < 0.05, 'maximum deviation ' + worst.toFixed(4) + ' px')

  const c = reread.header.cards
  const presentItems = ['OBJECT', 'DATE-OBS', 'EXPTIME', 'INSTRUME', 'FILTER', 'RA', 'DEC', 'TELESCOP', 'FOCALLEN']
  const missing = presentItems.filter((k) => c[k] === undefined || c[k] === null)
  result('capture data in the file', missing.length === 0, missing.length ? 'missing ' + missing.join(', ') : String(c['OBJECT']) + ', ' + String(c['DATE-OBS']))
  result('object and coordinates reread', reread.metadata.object === readResult.metadata.object && reread.metadata.ra === readResult.metadata.ra)
  // The scale detected by the reader follows the resize (it is the
  // horizontal one: with a preset the two axes may differ).
  const expectedScale = scaleArcsec(wcs) / kx
  result(
    'scale reread',
    reread.metadata.pixelScale !== null && Math.abs(reread.metadata.pixelScale - expectedScale) / expectedScale < 0.01,
    String(reread.metadata.pixelScale?.toFixed(3)) + ' versus ' + expectedScale.toFixed(3)
  )
  const px = c['XPIXSZ']
  result('pixel size correct', typeof px === 'number' && Math.abs(px - 2.9 / kx) < 1e-3, String(px))
}

// Crop around M 27 and proportional reduction.
const fx = p0.x / image.width
const fy = p0.y / image.height
test('crop and reduction', { x: fx - 0.25, y: fy - 0.15, width: 0.5, height: 0.35 }, 640, Math.round((640 * 0.35 * image.height) / (0.5 * image.width)))
// Preset: different factors on the two axes, and upscaling.
test('crop and preset (1080 x 1350)', { x: fx - 0.2, y: fy - 0.1, width: 0.4, height: 0.22 }, 1080, 1350)
test('whole image, no resize', { x: 0, y: 0, width: 1, height: 1 }, image.width, image.height)

console.log('--- CONSISTENCY WITH wcsScale ---')
const a = wcsScale(wcs, 2)
const b = resizeWcs(wcs, wcs.naxis1 * 2, wcs.naxis2 * 2)
const diff = (x: Wcs, y: Wcs): number => {
  let m = Math.abs(x.crpix[0] - y.crpix[0]) + Math.abs(x.crpix[1] - y.crpix[1])
  for (const [k, v] of x.a) m = Math.max(m, Math.abs(v - (y.a.get(k) ?? 0)) / Math.abs(v))
  for (const [k, v] of x.bp) m = Math.max(m, Math.abs(v - (y.bp.get(k) ?? 0)) / Math.abs(v))
  return m
}
result('resizeWcs matches wcsScale at a uniform factor', diff(a, b) < 1e-9)

console.log('--- WITHOUT A SOLUTION OR WITH A DIFFERENT GEOMETRY ---')
const without = readFits(new Uint8Array(encodeFits(image, cards, 16)))
result('without a solution nothing astrometric is written', readWcs(without.header) === null)
const wrongValue = readFits(new Uint8Array(encodeFits(image, cards, 16, { wcs: { ...wcs, naxis1: 100, naxis2: 100 } })))
result('a solution of another geometry is discarded', readWcs(wrongValue.header) === null)
const strange = readFits(new Uint8Array(encodeFits({ width: 4, height: 4, channels: 1, data: new Float32Array(16) }, { OBJECT: "Nebulosa dell'Anello è", FILTER: 'L' })))
result('apostrophes and accents in the text', strange.header.cards['OBJECT'] === "Nebulosa dell'Anello e", String(strange.header.cards['OBJECT']))

console.log(problems === 0 ? '\nAll checks passed.' : '\n' + problems + ' problems.')
process.exit(problems === 0 ? 0 : 1)
