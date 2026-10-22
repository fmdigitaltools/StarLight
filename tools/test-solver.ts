/**
 * Check of guided plate solving (src/core/astrometry/solver.ts).
 *
 * On files that already have the solution in the header, that solution is
 * ignored, the field is solved from the stars and the two are compared:
 * position at the center and at the corners, scale, rotation. On files
 * without a solution it only solves, checking internal consistency.
 *
 * The Gaia catalog is re-read from the saved copies if present, otherwise
 * it is downloaded (up to 40 seconds per field) and saved.
 *
 * Usage: TEST_SCRIPT=tools/test-solver.ts node tools/run-test.mjs [file.fit ...] [--folder path]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { detectStars } from '../src/core/stars/detection'
import { readWcs, pixelToSky, scaleArcsec } from '../src/core/astrometry/wcs'
import { angularDistance, searchByName } from '../src/core/catalog/recognition'
import { gaiaStars, type GaiaCatalogStar } from '../src/main/gaiaCatalog'
import {
  solveField,
  fieldEstimate,
  SOLVER_DETECTION
} from '../src/core/astrometry/solver'
import type { FitsHeader, Wcs } from '../src/shared/types'
import { testFile } from './test-files.mjs'

const args = process.argv.slice(2)
const iFolder = args.indexOf('--folder')
const SCRATCH = join(tmpdir(), 'starlight-test')
const folder = iFolder >= 0 ? args[iFolder + 1] : SCRATCH + '/solver'
const file = args.filter((a, i) => !a.startsWith('--') && (iFolder < 0 || i !== iFolder + 1))
if (file.length === 0) file.push(testFile('m27'), testFile('m33'))
mkdirSync(folder, { recursive: true })
// Robustness tests: catalog downloaded as the app does, unknown scale,
// declared center deliberately shifted, declared scale different.
const network = args.includes('--network')
const withoutScale = args.includes('--no-scale')
const shift = Number(args.find((a) => a.startsWith('--shift='))?.slice(8) ?? 0)
const forcedScale = Number(args.find((a) => a.startsWith('--scale='))?.slice(8) ?? 0)

/** SIP coefficients read with a correct expression (in wcs.ts the backslash of '\d' inside a string gets lost). */
function withSip(wcs: Wcs, header: FitsHeader): Wcs {
  const read = (prefix: string): Map<string, number> => {
    const m = new Map<string, number>()
    const re = new RegExp('^' + prefix + '_(\\d+)_(\\d+)$')
    for (const k of header.order) {
      const r = k.match(re)
      const v = header.cards[k]
      if (r && typeof v === 'number' && v !== 0) m.set(r[1] + '_' + r[2], v)
    }
    return m
  }
  return { ...wcs, a: read('A'), b: read('B'), ap: read('AP'), bp: read('BP') }
}

function angles(wcs: Wcs): { rot: number; det: number } {
  const det = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0]
  // North direction in pixels: inverse of CD applied to (0, 1).
  const nx = -wcs.cd[0][1] / det
  const ny = wcs.cd[0][0] / det
  return { rot: ((Math.atan2(nx, -ny) * 180 / Math.PI) % 360 + 360) % 360, det }
}

for (const path of file) {
  const name = basename(path).replace(/\.fit.*$/i, '')
  console.log('\n=== ' + name + ' ===')
  const readResult = readFits(new Uint8Array(readFileSync(path)), path)
  const img = debayer(readResult.image, readResult.metadata.bayer)
  const W = img.width, H = img.height
  const t0 = performance.now()
  const stars = detectStars(img, SOLVER_DETECTION)
  const tDetect = performance.now() - t0
  console.log(W + ' x ' + H + ', stars detected ' + stars.length + ' in ' + tDetect.toFixed(0) + ' ms')

  const estimate = fieldEstimate(readResult.metadata, W, H, searchByName)
  if (!estimate) { console.log('No approximate position: cannot be solved.'); continue }
  console.log('estimate: ra ' + estimate.ra.toFixed(4) + ' dec ' + estimate.dec.toFixed(4) + ' (' + estimate.origin + '), scale ' +
    (estimate.scale?.toFixed(3) ?? '?') + ', catalog radius ' + estimate.radius.toFixed(2) + '°')

  // Catalog: photometry copy, solver copy, or network.
  const baseName = name.replace(/^Enhanced_Stacked_\d+_/, '').replace(/_\d+\.\d+s_.*$/, '')
  const own = join(folder, 'gaia-' + baseName + (network ? '-app' : '') + '.json')
  const copies = network ? [own] : [join(SCRATCH, 'fotometria', 'gaia-' + baseName + '.json'), own]
  let catalog: GaiaCatalogStar[]
  const foundMatch = copies.find((c) => existsSync(c))
  if (foundMatch) {
    catalog = JSON.parse(readFileSync(foundMatch, 'utf8'))
    console.log('catalog from ' + foundMatch.split(/[\\/]/).slice(-2).join('/') + ': ' + catalog.length + ' stars')
  } else {
    const t = performance.now()
    try {
      catalog = await gaiaStars(estimate.ra, estimate.dec, estimate.radius, estimate.magnitude)
    } catch (e) {
      console.log('catalog not available: ' + (e instanceof Error ? e.message : String(e)))
      // 77 = skipped (without a network it cannot be tested), if nothing else went wrong.
      if (!process.exitCode) process.exitCode = 77
      continue
    }
    console.log('catalog downloaded: ' + catalog.length + ' stars in ' + ((performance.now() - t) / 1000).toFixed(1) + ' s')
    writeFileSync(own, JSON.stringify(catalog))
  }

  const t1 = performance.now()
  const scale = withoutScale ? null : forcedScale > 0 ? forcedScale : estimate.scale
  const raTest = estimate.ra + shift / Math.cos((estimate.dec * Math.PI) / 180) * 0.6
  const decTest = estimate.dec + shift * 0.8
  if (shift || withoutScale || forcedScale) console.log('test with center shifted by ' + shift + '°, scale ' + (scale ?? 'unknown'))
  const result = solveField(stars, catalog, { width: W, height: H, ra: raTest, dec: decTest, scale })
  const tSolve = performance.now() - t1
  // Result for the aggregate runner (npm run test): exit code 1 if anything failed.
  if (!result) { console.log('NOT SOLVED (' + tSolve.toFixed(0) + ' ms)'); process.exitCode = 1; continue }
  console.log('solved in ' + tSolve.toFixed(0) + ' ms: ' + result.matchedStars + ' stars, residual ' + result.residualArcsec.toFixed(2) +
    '", scale ' + result.scale.toFixed(4) + '"/px, rotation ' + result.rotation.toFixed(2) + '°, mirrored ' + result.mirrored +
    ', distortion degree ' + result.distortionDegree)
  const c = pixelToSky(result.wcs, (W + 1) / 2, (H + 1) / 2)
  console.log('solved center: ra ' + c.ra.toFixed(5) + ' dec ' + c.dec.toFixed(5) +
    ', distance from the estimate ' + (angularDistance(c.ra, c.dec, estimate.ra, estimate.dec) * 60).toFixed(1) + "'")

  const ref0 = readWcs(readResult.header)
  if (!ref0) continue
  const ref = withSip(ref0, readResult.header)
  const points: [string, number, number][] = [
    ['center', (W + 1) / 2, (H + 1) / 2], ['top-left', 1, 1], ['top-right', W, 1], ['bottom-left', 1, H], ['bottom-right', W, H],
    ['left-edge', 1, (H + 1) / 2], ['top-edge', (W + 1) / 2, 1]
  ]
  let worst = 0
  for (const [n, x, y] of points) {
    const a = pixelToSky(result.wcs, x, y)
    const b = pixelToSky(ref, x, y)
    const bWithoutSip = pixelToSky(ref0, x, y)
    const e = angularDistance(a.ra, a.dec, b.ra, b.dec) * 3600
    worst = Math.max(worst, e)
    console.log('  ' + n.padEnd(11) + ' deviation ' + e.toFixed(2) + '"   (ref. without SIP: ' +
      (angularDistance(a.ra, a.dec, bWithoutSip.ra, bWithoutSip.dec) * 3600).toFixed(2) + '")')
  }
  // Which of the two is closer to Gaia? Mean deviation of the stars matched within 3".
  const gaiaDeviation = (w: Wcs, filter: (x: number, y: number) => boolean = () => true): string => {
    let sum = 0, n = 0
    for (const s of stars) {
      if (!filter(s.x, s.y)) continue
      const p = pixelToSky(w, s.x + 1, s.y + 1)
      let best = 3
      for (const g of catalog) {
        if (Math.abs(g.dec - p.dec) > 0.001) continue
        const d = angularDistance(p.ra, p.dec, g.ra, g.dec) * 3600
        if (d < best) best = d
      }
      if (best < 3) { sum += best * best; n++ }
    }
    return Math.sqrt(sum / Math.max(1, n)).toFixed(2) + '" over ' + n + ' stars'
  }
  console.log('  deviation from Gaia: header solution ' + gaiaDeviation(ref) + ', solution found ' + gaiaDeviation(result.wcs))
  // The same, only for the stars near each corner (a quarter of the side).
  const neighborA = (ax: number, ay: number) => (x: number, y: number): boolean =>
    Math.abs(x - ax * W) < W * 0.3 && Math.abs(y - ay * H) < H * 0.3
  for (const [n, ax, ay] of [['top-left', 0, 0], ['top-right', 1, 0], ['bottom-left', 0, 1], ['bottom-right', 1, 1]] as const) {
    console.log('    corner ' + n.padEnd(12) + ' header ' + gaiaDeviation(ref, neighborA(ax, ay)) + ', found ' + gaiaDeviation(result.wcs, neighborA(ax, ay)))
  }
  const ar = angles(ref), as = angles(result.wcs)
  console.log('  scale header ' + scaleArcsec(ref).toFixed(4) + ' vs ' + scaleArcsec(result.wcs).toFixed(4) +
    ', rotation header ' + ar.rot.toFixed(3) + '° vs ' + as.rot.toFixed(3) + '°, determinant sign ' + Math.sign(ar.det) + ' vs ' + Math.sign(as.det))
  if (!(worst < 2)) process.exitCode = 1
  console.log(worst < 2 ? 'RESULT: OK (maximum deviation ' + worst.toFixed(2) + '")' : 'RESULT: NEEDS CHECKING (maximum deviation ' + worst.toFixed(2) + '")')
}
