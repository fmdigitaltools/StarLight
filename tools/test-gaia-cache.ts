/**
 * Test of the shared memory of Gaia stars (plate solving and
 * photometry): when it reuses, when it downloads again, what it returns.
 * The catalog is fake and local: no connection.
 *
 *   $env:TEST_SCRIPT='tools/test-gaia-cache.ts'; node tools/run-test.mjs
 */
import { createGaiaCache, MAX_STARS, type GaiaStar } from '../src/core/astrometry/gaiaCache'

let errors = 0
function result(name: string, ok: boolean): void {
  console.log((ok ? 'ok   ' : 'NO   ') + name)
  if (!ok) errors++
}

// Fake sky: a grid of stars around (300°, +40°), magnitudes from 8 to 18.
const sky: GaiaStar[] = []
for (let i = 0; i < 60; i++) {
  for (let j = 0; j < 60; j++) {
    sky.push({ ra: 297 + i * 0.1, dec: 37 + j * 0.1, g: 8 + ((i * 7 + j * 13) % 100) / 10, bpRp: 0.8 })
  }
}
const RAD = Math.PI / 180
const dist = (ra1: number, d1: number, ra2: number, d2: number): number =>
  (2 * Math.asin(Math.sqrt(Math.sin(((d2 - d1) * RAD) / 2) ** 2 + Math.cos(d1 * RAD) * Math.cos(d2 * RAD) * Math.sin(((ra2 - ra1) * RAD) / 2) ** 2))) / RAD
// Like the real catalog: the brightest ones, at most MAX_STARS.
const download = async (ra: number, dec: number, r: number, mag: number): Promise<GaiaStar[]> =>
  sky
    .filter((s) => s.g < mag && dist(ra, dec, s.ra, s.dec) <= r)
    .sort((a, b) => a.g - b.g)
    .slice(0, MAX_STARS)

const key = (l: GaiaStar[]): string => l.map((s) => s.ra.toFixed(2) + ',' + s.dec.toFixed(2)).sort().join(';')

async function test(): Promise<void> {
  const cache = createGaiaCache(download)
  // 1. Plate solving: wide circle, magnitude 16 (does not hit the cap: small area).
  const solver = { ra: 300, dec: 40, radius: 0.6, magnitude: 16 }
  result('at the start a download is needed', !cache.alreadyAvailable('f1', solver))
  await cache.stars('f1', solver)
  result('first request: one download', cache.downloads() === 1)

  // 2. Photometry: smaller circle inside, magnitude 15.5 -> filters.
  const photo = { ra: 300.05, dec: 40.02, radius: 0.4, magnitude: 15.5 }
  result('photometry after the solver does not need internet', cache.alreadyAvailable('f1', photo))
  const fromMemory = await cache.stars('f1', photo)
  result('no new download', cache.downloads() === 1)
  result(
    'same stars the catalog would give (' + fromMemory.length + ')',
    key(fromMemory) === key(await download(photo.ra, photo.dec, photo.radius, photo.magnitude))
  )

  // 3. Higher magnitude than the one in memory: downloads again.
  const fainter = { ...photo, magnitude: 17 }
  result('higher magnitude: a download is needed', !cache.alreadyAvailable('f1', fainter))
  await cache.stars('f1', fainter)
  result('downloaded again', cache.downloads() === 2)
  // ... and now 16.5 on the same circle is also served from memory.
  result('afterwards, an intermediate magnitude is in memory', cache.alreadyAvailable('f1', { ...photo, magnitude: 16.5 }))

  // 4. Wider area: downloads again.
  result('wider area: a download is needed', !cache.alreadyAvailable('f1', { ...solver, radius: 0.9 }))

  // 5. Another frame does not see the first one's memory.
  result('another frame has its own memory', !cache.alreadyAvailable('f2', photo))

  // 6. List that hits the cap: beyond the faintest star, stars are missing.
  const full = createGaiaCache(download)
  const wide = { ra: 300, dec: 40, radius: 2.5, magnitude: 18 }
  const list = await full.stars('f1', wide)
  const faint = Math.max(...list.map((s) => s.g))
  result('the wide list hits the cap (' + list.length + ' stars, down to G ' + faint.toFixed(1) + ')', list.length === MAX_STARS)
  result('below the faintest it is reused', full.alreadyAvailable('f1', { ra: 300, dec: 40, radius: 0.5, magnitude: faint - 0.5 }))
  result('beyond the faintest it is downloaded again', !full.alreadyAvailable('f1', { ra: 300, dec: 40, radius: 0.5, magnitude: faint + 0.5 }))
}

await test()
console.log(errors === 0 ? '\nALL OK' : '\nERRORS: ' + errors)
if (errors > 0) process.exitCode = 1
