/**
 * Test of photometric color calibration on real files.
 *
 * Downloads (or rereads from the saved copy) the Gaia stars of the field,
 * matches them, computes the gains, applies them and saves stretched
 * before/after images. It also prints, by BP-RP color band, how closely the
 * color measured after the correction follows the expected one: if the
 * sensor band model were wrong, blue and red stars would deviate in
 * opposite directions.
 *
 * Usage: TEST_SCRIPT=tools/test-photometry.ts node tools/run-test.mjs [file.fit ...] [--folder path]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch } from '../src/core/image/stretch'
import { encodeBmp } from '../src/core/export/encoding'
import { readWcs } from '../src/core/astrometry/wcs'
import { gaiaStars, type GaiaCatalogStar } from '../src/main/gaiaCatalog'
import {
  matchStars,
  calibrateColor,
  applyGains,
  catalogField,
  expectedColor,
  temperatureFromBpRp,
  filterFromHeader,
  CATALOG_MAGNITUDE
} from '../src/core/image/photometry'
import { clean, FULL_CLEANUP } from '../src/core/image/cleanup'
import type { ImageData32 } from '../src/shared/types'
import { testFile } from './test-files.mjs'

const args = process.argv.slice(2)
const iFolder = args.indexOf('--folder')
const folder = iFolder >= 0 ? args[iFolder + 1] : join(tmpdir(), 'starlight-photometry')
const file = args.filter((a, i) => !a.startsWith('--') && i !== iFolder + 1)
if (file.length === 0) file.push(testFile('m27'), testFile('m33'))
mkdirSync(folder, { recursive: true })

console.log('Expected color (relative to the Sun) for some classes:')
for (const c of [-0.2, 0, 0.4, 0.82, 1.2, 1.8, 2.5]) {
  const a = expectedColor(c)
  const l = expectedColor(c, 'dual-band')
  console.log('  BP-RP ' + c.toFixed(2).padStart(5) + '  T ' + temperatureFromBpRp(c).toFixed(0).padStart(5) +
    ' K  R/G ' + a.rg.toFixed(3) + '  B/G ' + a.bg.toFixed(3) + '   dual band R/G ' + l.rg.toFixed(3) + '  B/G ' + l.bg.toFixed(3))
}

function save(name: string, img: ImageData32): void {
  writeFileSync(join(folder, name), Buffer.from(encodeBmp(img)))
}

function cropRegion(img: ImageData32, x0: number, y0: number, lw: number, lh: number): ImageData32 {
  const n = img.width * img.height
  const out = new Float32Array(lw * lh * 3)
  for (let k = 0; k < 3; k++)
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++)
        out[k * lw * lh + y * lw + x] = img.data[k * n + (y0 + y) * img.width + x0 + x]
  return { width: lw, height: lh, channels: 3, data: out }
}

/** Downsamples by an integer factor to get a light overview. */
function reduce(img: ImageData32, f: number): ImageData32 {
  const lw = Math.floor(img.width / f)
  const lh = Math.floor(img.height / f)
  const n = img.width * img.height
  const out = new Float32Array(lw * lh * 3)
  for (let k = 0; k < 3; k++)
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        let s = 0
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += img.data[k * n + (y * f + dy) * img.width + x * f + dx]
        out[k * lw * lh + y * lw + x] = s / (f * f)
      }
  return { width: lw, height: lh, channels: 3, data: out }
}

for (const path of file) {
  const name = basename(path).replace(/\.fit.*$/i, '')
  console.log('\n=== ' + name + ' ===')
  const readResult = readFits(new Uint8Array(readFileSync(path)), path)
  const img = debayer(readResult.image, readResult.metadata.bayer)
  const wcs = readWcs(readResult.header)
  console.log('filter: ' + readResult.header.cards['FILTER'] + ', ' + img.width + ' x ' + img.height)
  if (!wcs) { console.log('No WCS.'); continue }

  const field = catalogField(wcs)
  console.log('field: ra ' + field.ra.toFixed(4) + ' dec ' + field.dec.toFixed(4) + ' radius ' + field.radius.toFixed(3) + '°')
  const cache = join(folder, 'gaia-' + name + '.json')
  let catalog: GaiaCatalogStar[]
  if (existsSync(cache)) {
    catalog = JSON.parse(readFileSync(cache, 'utf8'))
    console.log('catalog from the saved copy: ' + catalog.length + ' stars')
  } else {
    const t = performance.now()
    catalog = await gaiaStars(field.ra, field.dec, field.radius, CATALOG_MAGNITUDE)
    console.log('catalog downloaded: ' + catalog.length + ' stars in ' + ((performance.now() - t) / 1000).toFixed(1) + ' s' +
      ', G from ' + catalog[0]?.g.toFixed(1) + ' to ' + catalog[catalog.length - 1]?.g.toFixed(1))
    writeFileSync(cache, JSON.stringify(catalog))
  }

  let t0 = performance.now()
  const matched = matchStars(img, wcs, catalog)
  const tMatch = performance.now() - t0
  t0 = performance.now()
  const filter = filterFromHeader(readResult.header.cards['FILTER'])
  const result = calibrateColor(img, matched, filter)
  const tCalibrate = performance.now() - t0
  t0 = performance.now()
  const corrected = applyGains(img, result.gains)
  const tApply = performance.now() - t0
  console.log('matched ' + matched.length + ', used ' + result.usedStars + ', deviation ' + (result.deviation * 100).toFixed(1) + '%, slope ' + result.slope.toFixed(2))
  console.log('gains R G B: ' + result.gains.map((g) => g.toFixed(3)).join(' '))
  console.log('timings: matching ' + tMatch.toFixed(0) + ' ms, calibration ' + tCalibrate.toFixed(0) +
    ' ms, application ' + tApply.toFixed(0) + ' ms')

  // For comparison: the "white stars" balance of the cleanup.
  const pul = clean(img, { ...FULL_CLEANUP, colorNoise: 0, lightNoise: 0, sharpness: 0, hotPixels: false, background: false })
  console.log('comparison, "white stars" gains of cleanup.ts: ' + pul.starGains.map((g) => g.toFixed(3)).join(' '))

  // Consistency by color band, after the correction.
  const recheck = calibrateColor(corrected, matched, filter)
  console.log('recalibrating the corrected image: ' + recheck.gains.map((g) => g.toFixed(3)).join(' ') + ' (expected ~1 1 1)')
  const strips = [[-1, 0.5], [0.5, 0.8], [0.8, 1.1], [1.1, 1.5], [1.5, 5]]
  for (const [a, b] of strips) {
    const below = matched.filter((s) => s.bpRp >= a && s.bpRp < b)
    const e = calibrateColor(corrected, below, filter)
    if (e.usedStars < 8) { console.log('  BP-RP ' + a + '..' + b + ': few stars (' + e.usedStars + ')'); continue }
    // Residual gain that this band alone would need: R/G and B/G.
    const rg = e.gains[0] / e.gains[1]
    const bg = e.gains[2] / e.gains[1]
    console.log('  BP-RP ' + String(a).padStart(4) + '..' + String(b).padEnd(4) + ' stars ' + String(e.usedStars).padStart(4) +
      '  residual R/G ' + rg.toFixed(3) + '  B/G ' + bg.toFixed(3))
  }

  // Color of the background in a corner and of the object at the center, linear.
  const n = img.width * img.height
  const regionMedian = (im: ImageData32, x0: number, y0: number, l: number): number[] =>
    [0, 1, 2].map((k) => {
      const v: number[] = []
      for (let y = y0; y < y0 + l; y++) for (let x = x0; x < x0 + l; x++) v.push(im.data[k * n + y * im.width + x])
      v.sort((a, b) => a - b)
      return v[v.length >> 1]
    })
  const describe = (m: number[]): string =>
    m.map((v) => v.toFixed(5)).join(' ') + ' (R/G ' + (m[0] / m[1]).toFixed(3) + ', B/G ' + (m[2] / m[1]).toFixed(3) + ')'
  console.log('corner background  before: ' + describe(regionMedian(img, 200, 300, 300)))
  console.log('corner background  after:  ' + describe(regionMedian(corrected, 200, 300, 300)))
  const objectColor = (im: ImageData32): string => {
    const f = regionMedian(im, 200, 300, 300)
    const c = regionMedian(im, Math.floor(im.width / 2) - 40, Math.floor(im.height / 2) - 40, 80)
    const m = c.map((v, k) => v - f[k])
    return 'R/G ' + (m[0] / m[1]).toFixed(3) + ', B/G ' + (m[2] / m[1]).toFixed(3)
  }
  console.log('object at center minus background, before: ' + objectColor(img) + '  after: ' + objectColor(corrected))

  // Images: the same stretch for before and after, computed on the before.
  const p = autoStretch(img)
  const before = applyStretch(img, p)
  const after = applyStretch(corrected, autoStretch(corrected))
  save(name + '-before.bmp', reduce(before, 3))
  save(name + '-after.bmp', reduce(after, 3))
  const cx = Math.floor(img.width / 2) - 400
  const cy = Math.floor(img.height / 2) - 400
  save(name + '-before-center.bmp', cropRegion(before, cx, cy, 800, 800))
  save(name + '-after-center.bmp', cropRegion(after, cx, cy, 800, 800))
  save(name + '-after-corner.bmp', cropRegion(after, 200, 300, 600, 600))
}
