/**
 * Test of the local stars for plate solving (package "Stars for plate
 * solving", UCAC4 catalog down to magnitude 12).
 *
 *  1. Package: hash and size equal to those in the list, valid manifest
 *     (type "stars"), intact stars.bin file; object-catalog manifests are
 *     told apart by their type.
 *  2. Cone search: the stars read cell by cell are exactly those found by
 *     scanning the whole file, also at the poles and across 0h; time of one
 *     request.
 *  3. Real fields with a solution in the header: solved with the local stars
 *     only (the Gaia catalog must not be called) and compared with the
 *     header WCS: deviation at the center and corners, scale. On files
 *     without a solution it only checks that the field solves.
 *  4. Narrow field (a small crop of the image): the local stars are too
 *     few, so it falls back to Gaia if internet is allowed.
 *  5. Internet off (simulated): no Gaia call, "offline" outcome with the
 *     local catalog reason.
 *  6. With --rete (or if the network answers): time of the same solve with
 *     the online Gaia catalog, for comparison, and solution of the narrow
 *     field.
 *
 * Usage (usually from tools/run-tests.mjs):
 *   node test-local-stars.mjs [archive.zip] [--offline]
 * Without an archive it uses dist-catalogs/ucac4-stars-*.zip (npm run
 * prepare-catalogs -- --only ucac4-stars). The sample files (see
 * test-files.mjs) are not distributed: tests on those files are skipped
 * when they are missing.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readZip } from '../src/main/zip'
import {
  readCatalogsIndex,
  checkCatalogManifest,
  CATALOG_MANIFEST_FILE,
  STAR_GROUP
} from '../src/core/catalog/package'
import {
  STARS_FILE,
  readStarsIndex,
  starsInCone,
  decodeSegment,
  starPosition,
  type StarIndex
} from '../src/core/astrometry/localStars'
import { solveWithSources, explainLocalReason, type StarSources } from '../src/core/astrometry/solveSources'
import { fieldEstimate, SOLVER_DETECTION, type CatalogStar } from '../src/core/astrometry/solver'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { detectStars } from '../src/core/stars/detection'
import { readWcs, pixelToSky, scaleArcsec, cropWcs } from '../src/core/astrometry/wcs'
import { angularDistance, searchByName } from '../src/core/catalog/recognition'
import { gaiaStars } from '../src/main/gaiaCatalog'
import type { ImageData32, Wcs } from '../src/shared/types'
import { testFile } from './test-files.mjs'

const args = process.argv.slice(2)
const withoutNetwork = args.includes('--offline')
let failedItems = 0
const check = (ok: boolean, what: string): void => {
  console.log((ok ? '  ok      ' : '  FAIL    ') + what)
  if (!ok) failedItems++
}

/* ---- 1. Package ---- */

function findArchive(): string | null {
  const indicated = args.find((a) => a.endsWith('.zip'))
  if (indicated) return indicated
  if (!existsSync('dist-catalogs')) return null
  const zip = readdirSync('dist-catalogs').filter((f) => /^ucac4-stars-.*\.zip$/.test(f)).sort()
  return zip.length ? join('dist-catalogs', zip[zip.length - 1]) : null
}

const path = findArchive()
if (!path) {
  console.log('Star package missing: prepare it with "npm run prepare-catalogs -- --only ucac4-stars".')
  process.exit(77)
}
console.log('Package: ' + path)
const archive = readFileSync(path)
const entries = new Map(readZip(archive, { file: 20, total: 1600 * 1024 * 1024, what: 'a catalog' }).map((v) => [v.name, v.data]))
const manifest = checkCatalogManifest(JSON.parse(entries.get(CATALOG_MANIFEST_FILE)!.toString('utf-8')))
check(manifest.ok && manifest.manifest.type === 'stars' && manifest.manifest.group === STAR_GROUP, 'valid manifest, type "stars"')
if (!manifest.ok) process.exit(1)
const bin = entries.get(STARS_FILE)
check(bin !== undefined, 'the package contains ' + STARS_FILE)
check(entries.has('LICENSE.txt') && entries.has('ATTRIBUTION.md'), 'license and attribution present')
const license = entries.get('LICENSE.txt')?.toString('utf-8') ?? ''
check(/10\.26131\/IRSA17/.test(license) && /AJ|Astronomical Journal/.test(license) && /17 U\.S\.C\. § 105/.test(license), 'the license cites the article, the IRSA DOI and the US government work status')
const index = readStarsIndex(bin!, bin!.length)
check(index.stars === manifest.manifest.objects, 'stars in the file = stars in the manifest (' + index.stars.toLocaleString('it-IT') + ')')
console.log(
  '  size: archive ' + (archive.length / 1048576).toFixed(1) + ' MB, ' + STARS_FILE + ' ' + (bin!.length / 1048576).toFixed(1) +
    ' MB, ' + (index.cellStart.length - 1) + ' cells, epoch ' + index.epoch
)
const list = join(path, '..', 'catalogs.json')
if (existsSync(list)) {
  const raw = JSON.parse(readFileSync(list, 'utf-8'))
  const entry = readCatalogsIndex(raw).catalogs.find((c) => c.file === path.split(/[\\/]/).pop())
  check(entry !== undefined && entry.type === 'stars', 'the package is in the catalogs.json list')
  if (entry) {
    check(entry.byte === archive.length, 'size equal to the one in the list')
    check(entry.sha256 === createHash('sha256').update(archive).digest('hex'), 'SHA-256 hash equal to the one in the list')
  }
}
// An object catalog declares type "deep-sky"; a manifest without a type, or with a wrong group, is rejected.
const objectCatalog = {
  format: 2, id: 'test', type: 'deep-sky', name: 'Test', version: '1.0.0', group: 'galaxies', description: 'x', authors: 'x',
  reference: 'x', source: 'x', license: 'CC0-1.0', licenseLink: 'x', objects: 3, example: 'P 1'
}
const deepSky = checkCatalogManifest(objectCatalog)
check(deepSky.ok && deepSky.manifest.type === 'deep-sky', 'a manifest with type "deep-sky" is an object catalog')
check(!checkCatalogManifest({ ...objectCatalog, type: undefined }).ok, 'a manifest without a type is rejected')
check(
  checkCatalogManifest({ ...manifest.manifest }).ok &&
    !checkCatalogManifest({ ...manifest.manifest, group: 'galaxies' }).ok &&
    !checkCatalogManifest({ ...manifest.manifest, type: 'planets' }).ok,
  'inconsistent type or group are rejected'
)

/* ---- 2. Cone search ---- */

const read = async (position: number, length: number): Promise<Uint8Array> =>
  bin!.subarray(position, position + length)

function allInCone(ix: StarIndex, ra: number, dec: number, r: number): number {
  const G = Math.PI / 180
  let n = 0
  for (let k = 0; k < ix.strips; k++) {
    const from = ix.cellStart[ix.firstCell[k]]
    const a = ix.cellStart[ix.firstCell[k] + ix.bandCells[k]]
    const p = starPosition(ix, from)
    for (const s of decodeSegment(bin!.subarray(p, p + (a - from) * 6), k, ix.strips)) {
      const c = Math.sin(dec * G) * Math.sin(s.dec * G) + Math.cos(dec * G) * Math.cos(s.dec * G) * Math.cos((s.ra - ra) * G)
      if (Math.acos(Math.min(1, c)) / G <= r) n++
    }
  }
  return n
}

console.log('\nCone search')
const cones: [number, number, number][] = [
  [0.2, 10, 1.2], [359.8, -5, 2], [180, 89.5, 1.5], [45, -89.2, 1], [339.2, 34.4, 1.3], [300.1, 22.7, 1.2], [83.8, -5.4, 3], [10, 60, 0.6]
]
for (const [ra, dec, r] of cones) {
  const locals = await starsInCone(index, read, ra, dec, r, 99, 1e9)
  const expected = allInCone(index, ra, dec, r)
  check(locals.length === expected, 'cone ' + ra + ', ' + dec + ', r ' + r + '°: ' + locals.length + ' stars (scanning everything: ' + expected + ')')
}
{
  const t = performance.now()
  for (let i = 0; i < 20; i++) await starsInCone(index, read, 339.2, 34.4, 1.3, 16)
  console.log('  mean time of one request (radius 1.3°): ' + ((performance.now() - t) / 20).toFixed(1) + ' ms')
}

/* ---- 3-6. Real fields ---- */

const M27 = testFile('m27')
const NGC7331 = testFile('ngc7331')
const STACKED_M27 = testFile('m27-stacked')
const NGC7331_WCS = testFile('ngc7331-wcs')
const M16 = testFile('m16-raw')

/** Sources with the local stars from the package and a simulated or real Gaia; counts the Gaia calls. */
function sources(opt: { internet: boolean; gaia?: () => Promise<CatalogStar[]>; withoutLocal?: boolean }): StarSources & { gaiaCalls: () => number } {
  let calls = 0
  return {
    locals: async (ra, dec, radius, mag) =>
      opt.withoutLocal ? null : { stars: await starsInCone(index, read, ra, dec, radius, mag), limitMagnitude: 12 },
    gaiaInMemory: () => false,
    gaia: async () => {
      calls++
      if (!opt.gaia) throw new Error('the Gaia catalog should not have been called')
      return opt.gaia()
    },
    internetAllowed: () => opt.internet,
    gaiaCalls: () => calls
  }
}

function cropRegion(img: ImageData32, x0: number, y0: number, w: number, h: number): ImageData32 {
  const out = new Float32Array(w * h * img.channels)
  for (let c = 0; c < img.channels; c++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) out[c * w * h + y * w + x] = img.data[c * img.width * img.height + (y0 + y) * img.width + x0 + x]
  return { width: w, height: h, channels: img.channels, data: out }
}

/** Maximum deviation (arcseconds) between two solutions at the center, corners and edges; and the deviation at the center. */
function compare(a: Wcs, b: Wcs, W: number, H: number): { center: number; worst: number; scale: number } {
  const points: [number, number][] = [[(W + 1) / 2, (H + 1) / 2], [1, 1], [W, 1], [1, H], [W, H], [1, (H + 1) / 2], [(W + 1) / 2, 1]]
  const e = points.map(([x, y]) => {
    const p = pixelToSky(a, x, y)
    const q = pixelToSky(b, x, y)
    return angularDistance(p.ra, p.dec, q.ra, q.dec) * 3600
  })
  return { center: e[0], worst: Math.max(...e), scale: (scaleArcsec(a) / scaleArcsec(b) - 1) * 100 }
}

let networkTested = withoutNetwork ? false : null as boolean | null
const localTimes: number[] = []

async function solveFile(filePath: string, opt: { object?: string; crop?: boolean; gaiaTime?: boolean } = {}): Promise<void> {
  if (!existsSync(filePath)) {
    console.log('\n' + filePath + ': missing, skipped')
    return
  }
  console.log('\n=== ' + filePath.split('/').pop() + ' ===')
  const readResult = readFits(new Uint8Array(readFileSync(filePath)), filePath)
  const img = debayer(readResult.image, readResult.metadata.bayer)
  const meta = opt.object ? { ...readResult.metadata, object: opt.object } : readResult.metadata
  const W = img.width
  const H = img.height
  const t0 = performance.now()
  const stars = detectStars(img, SOLVER_DETECTION)
  const tDetect = performance.now() - t0
  const estimate = fieldEstimate(meta, W, H, searchByName)
  if (!estimate) {
    check(false, 'field estimate from the header')
    return
  }
  console.log('  ' + W + '×' + H + ', ' + stars.length + ' stars detected in ' + tDetect.toFixed(0) + ' ms; declared scale ' + (estimate.scale?.toFixed(2) ?? '?') + '″, radius ' + estimate.radius.toFixed(2) + '°')
  const header = readWcs(readResult.header)

  // Full field, local stars, internet allowed: Gaia is not needed.
  const f = sources({ internet: true })
  const t1 = performance.now()
  const r = await solveWithSources(stars, estimate, W, H, f)
  const tLoc = performance.now() - t1
  localTimes.push(tLoc)
  check(r.ok && r.source === 'local' && f.gaiaCalls() === 0, 'solved with the local stars in ' + tLoc.toFixed(0) + ' ms, without calling Gaia')
  if (r.ok) {
    console.log('    ' + r.result.matchedStars + ' stars matched, mean residual ' + r.result.residualArcsec.toFixed(2) + '″, scale ' + r.result.scale.toFixed(4) + '″/px, rotation ' + r.result.rotation.toFixed(2) + '°')
    if (header) {
      const c = compare(r.result.wcs, header, W, H)
      console.log('    versus the header WCS: center ' + c.center.toFixed(2) + '″, worst (corners and edges) ' + c.worst.toFixed(2) + '″, scale ' + (c.scale >= 0 ? '+' : '') + c.scale.toFixed(3) + '%')
      // The WCS written by the telescope can be off by a few arcseconds at the corners (so is
      // the Gaia solution): here the center and the scale are checked; the full comparison is against Gaia.
      check(c.center < 2 && Math.abs(c.scale) < 0.1, 'center within 2″ and scale within 0.1% of the header solution')
    }
  }

  // Internet off with the full field: it still solves.
  {
    const g = sources({ internet: false })
    const q = await solveWithSources(stars, estimate, W, H, g)
    check(q.ok && q.source === 'local' && g.gaiaCalls() === 0, 'with internet off the full field solves with the local stars')
  }

  // Timing comparison with the online Gaia catalog.
  if (opt.gaiaTime && networkTested !== false) {
    try {
      const t = performance.now()
      const catalog = await gaiaStars(estimate.ra, estimate.dec, estimate.radius, estimate.magnitude)
      const tNetwork = performance.now() - t
      const g = sources({ internet: true, gaia: async () => catalog, withoutLocal: true })
      const t2 = performance.now()
      const q = await solveWithSources(stars, estimate, W, H, g)
      const tSolve = performance.now() - t2
      networkTested = true
      console.log('    online Gaia catalog: ' + catalog.length + ' stars downloaded in ' + (tNetwork / 1000).toFixed(1) + ' s, comparison ' + tSolve.toFixed(0) + ' ms')
      // Accuracy of the local positions: distance from the same star in Gaia (epoch 2016).
      const locals = await starsInCone(index, read, estimate.ra, estimate.dec, estimate.radius, 12, 1e9)
      const faintest = catalog.reduce((m, s) => Math.max(m, s.g), 0)
      const distances: number[] = []
      for (const s of locals) {
        if (s.g > faintest - 1) continue
        let best = 3
        for (const g of catalog) {
          if (Math.abs(g.dec - s.dec) > 0.001 || Math.abs(g.g - s.g) > 1.5) continue
          best = Math.min(best, angularDistance(s.ra, s.dec, g.ra, g.dec) * 3600)
        }
        if (best < 3) distances.push(best)
      }
      distances.sort((a, b) => a - b)
      const median = distances[Math.floor(distances.length / 2)] ?? NaN
      console.log('    local positions versus Gaia: ' + distances.length + ' common stars, median ' + median.toFixed(3) + '″, 90% within ' + (distances[Math.floor(distances.length * 0.9)] ?? NaN).toFixed(3) + '″')
      check(distances.length > 50 && median < 0.3, 'local star positions within 0.3″ (median) of Gaia')
      if (q.ok && r.ok) {
        const c = compare(q.result.wcs, r.result.wcs, W, H)
        console.log('    Gaia solution versus local solution: center ' + c.center.toFixed(2) + '″, worst ' + c.worst.toFixed(2) + '″, scale ' + c.scale.toFixed(3) + '%')
        check(c.worst < 2 && Math.abs(c.scale) < 0.1, 'the local solution matches the one obtained with Gaia (within 2″ everywhere and 0.1% in scale)')
        if (header) {
          const h = compare(q.result.wcs, header, W, H)
          console.log('    Gaia solution versus header: center ' + h.center.toFixed(2) + '″, worst ' + h.worst.toFixed(2) + '″, scale ' + h.scale.toFixed(3) + '%')
        }
      }
    } catch (e) {
      networkTested = false
      console.log('    online Gaia catalog unreachable (' + (e instanceof Error ? e.message.slice(0, 120) : String(e)) + '): timing comparison skipped')
    }
  }

  if (!opt.crop) return

  // --- Narrow field: a crop at the center of one third of the short side ---
  const side = Math.round(Math.min(W, H) / 3)
  const x0 = Math.round((W - side) / 2)
  const y0 = Math.round((H - side) / 2)
  const piece = cropRegion(img, x0, y0, side, side)
  const chunkStars = detectStars(piece, SOLVER_DETECTION)
  const chunkEstimate = fieldEstimate(meta, side, side, searchByName)!
  console.log('  crop ' + side + '×' + side + ' px (' + ((side * (estimate.scale ?? 1)) / 60).toFixed(1) + '′ per side), ' + chunkStars.length + ' stars detected')

  // Internet allowed: the local stars are not enough, so it falls back to Gaia.
  let catalogPiece: CatalogStar[] | null = null
  if (networkTested !== false) {
    try {
      catalogPiece = await gaiaStars(chunkEstimate.ra, chunkEstimate.dec, chunkEstimate.radius, chunkEstimate.magnitude)
      networkTested = true
    } catch {
      networkTested = false
    }
  }
  const withNetwork = sources({ internet: true, gaia: async () => catalogPiece ?? [] })
  const q = await solveWithSources(chunkStars, chunkEstimate, side, side, withNetwork)
  const reason = q.ok ? q.localReason : q.localReason
  const expected = q.ok ? null : q.localStarsInField
  check(reason === 'narrow-field' && withNetwork.gaiaCalls() === 1, 'narrow field recognized, falling back to the Gaia catalog (' + (expected !== null ? 'expected local stars ' + expected.toFixed(1) + ', ' : '') + 'Gaia calls: ' + withNetwork.gaiaCalls() + ')')
  if (catalogPiece) {
    check(q.ok && q.source === 'gaia', 'with online Gaia the crop solves')
    if (q.ok && header) {
      const c = compare(q.result.wcs, cropWcs(header, x0, y0, side, side), side, side)
      console.log('    versus the cropped header WCS: center ' + c.center.toFixed(2) + '″, worst ' + c.worst.toFixed(2) + '″, scale ' + c.scale.toFixed(3) + '%')
    }
  } else {
    console.log('    (network unavailable: simulated Gaia empty, only the fallback is checked)')
  }

  // Internet off (simulated): no connection, notice with the reason.
  const off = sources({ internet: false })
  const s = await solveWithSources(chunkStars, chunkEstimate, side, side, off)
  check(
    !s.ok && s.reason === 'offline' && s.localReason === 'narrow-field' && off.gaiaCalls() === 0,
    'internet off: no Gaia call, "offline" outcome for a narrow field'
  )
  if (!s.ok) console.log('    notice: ' + explainLocalReason(s.localReason, s.localStarsInField))

  // Package missing and internet off: reason "missing".
  const nothing = sources({ internet: false, withoutLocal: true })
  const n = await solveWithSources(stars, estimate, W, H, nothing)
  check(!n.ok && n.reason === 'offline' && n.localReason === 'missing' && nothing.gaiaCalls() === 0, 'without package and without internet: no call, reason "missing"')
}

await solveFile(NGC7331_WCS, { crop: true, gaiaTime: true })
await solveFile(M27)
await solveFile(NGC7331)
await solveFile(STACKED_M27)
// The single M 16 frame does not say where it was pointed: the object is given, as the file name would.
await solveFile(M16, { object: 'M 16' })

if (localTimes.length) console.log('\nMean time with the local stars (read and compare): ' + (localTimes.reduce((a, b) => a + b, 0) / localTimes.length).toFixed(0) + ' ms')
console.log(failedItems === 0 ? '\nRESULT: OK' : '\nRESULT: ' + failedItems + ' checks failed')
process.exitCode = failedItems === 0 ? 0 : 1
