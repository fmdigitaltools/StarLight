/*
 * "Stars for field solving" package: the stars of the UCAC4 catalog down
 * to magnitude 12, in a compact file that StarLight reads in pieces to
 * solve the field without internet.
 *
 * Used by tools/prepare-catalogs.mjs (entry "ucac4-stars").
 *
 * Source: UCAC4 (Zacharias et al. 2013, AJ 145, 44), by the U.S. Naval
 * Observatory, queried through the TAP service of the IRSA archive
 * (table ucac4_sources, DOI 10.26131/IRSA17) in declination bands, with a
 * pause between one request and the next. The raw responses are kept in
 * cache-catalogs/ucac4/, compressed with gzip.
 *
 * Magnitude: the catalog's own (momag, "fit model magnitude", band
 * 579-642 nm between V and R), measured homogeneously for nearly all the
 * stars and close to the response of color and luminance sensors.
 * The brightest stars that the USNO telescope did not observe (about
 * 69,000, added to the catalog from Hipparcos and Tycho-2) have no momag:
 * for them the aperture magnitude (apmag) is used or, failing that, the V
 * reported in the catalog. Also for observed stars brighter than
 * magnitude 9, where momag is distorted by saturation, V is used (see
 * `magnitude`). This way the package is complete at the top too: the
 * brightest stars of the field, which are the first the solver matches,
 * are all there and in the right order.
 *
 * Positions: UCAC4 gives them at epoch J2000 with proper motions; here
 * they are brought to epoch 2025.0 and the proper motions are not kept.
 * For a typical magnitude 12 star (10-20 milliarcseconds per year) the
 * error between 2015 and 2035 stays below 0.2″, far less than one pixel
 * of any amateur image, whereas keeping them would add two thirds to the
 * size.
 *
 * Format of the stars.bin file (little endian numbers), also described
 * in src/core/astrometry/localStars.ts, which reads it:
 *   0   "SLST"                          4 bytes
 *   4   format version (1)              uint16
 *   6   number of declination bands     uint16 (180: one degree each)
 *   8   number of stars                 uint32
 *   12  epoch of the positions          float32 (2025.0)
 *   16  number of cells                 uint32
 *   20  index: for each cell, the index of its first star, plus a final
 *       one with the total              (cells + 1) × uint32
 *   then the stars, 6 bytes each:
 *       RA        uint24  fraction of the full circle × 2^24 (0.077″ per unit)
 *       Dec       uint16  position in the band × 65535 (0.055″ per unit)
 *       magnitude uint8   (m + 2) × 16, from -2 to 13.9 in steps of 1/16
 * Each band is divided into right ascension cells about one degree wide
 * on the sky: max(1, ceil(360 · cos(edge closest to the equator))) cells.
 * The cells are in band order (south to north) and RA order; within a
 * cell the stars are in RA order.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const TAP_IRSA = 'https://irsa.ipac.caltech.edu/TAP/sync'
const USER_AGENT = 'StarLight-catalogs/1.0 (catalog package preparation)'

/** Limiting magnitude of the package. */
export const LIMIT_MAGNITUDE = 12
/** Epoch to which the positions are brought. */
export const EPOCH = 2025.0
/** Declination bands in the file (one degree each). */
const BANDS = 180
/** Height of the bands downloaded from IRSA, in degrees. */
const DOWNLOAD_STEP = 2

const COLUMNS = 'ra, dec, pmrac, pmdc, momag, apmag, vmag, tf'

async function queryIrsa(adql) {
  const body = new URLSearchParams({ LANG: 'ADQL', FORMAT: 'csv', MAXREC: '5000000', QUERY: adql })
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(TAP_IRSA, {
        method: 'POST',
        body: body,
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(900000)
      })
      const text = await r.text()
      if (!r.ok) throw new Error('response ' + r.status)
      if (text.trimStart().startsWith('<')) {
        const reason = text.match(/<INFO[^>]*QUERY_STATUS[^>]*>([\s\S]*?)<\/INFO>/i)?.[1]?.trim()
        throw new Error('request rejected: ' + (reason ?? text.slice(0, 200)))
      }
      if (!text.startsWith('ra,dec,')) throw new Error('response in an unexpected format')
      return text
    } catch (e) {
      if (attempt >= 4) throw e
      console.log('    new attempt in ' + 15 * attempt + ' s (' + e.message + ')')
      await new Promise((ok) => setTimeout(ok, 15000 * attempt))
    }
  }
}

/** One request with its compressed cache in cache-catalogs/ucac4/. */
async function withCache(folder, name, adql, refresh) {
  const file = join(folder, name + '.csv.gz')
  if (!refresh && existsSync(file)) return gunzipSync(readFileSync(file)).toString('utf-8')
  const start = Date.now()
  const text = await queryIrsa(adql)
  writeFileSync(file, gzipSync(text, { level: 9 }))
  const rows = text.split('\n').length - 2
  console.log('    ' + name + ': ' + rows + ' rows in ' + ((Date.now() - start) / 1000).toFixed(0) + ' s')
  // Courtesy pause toward the service.
  await new Promise((ok) => setTimeout(ok, 2000))
  return text
}

/** Downloads (or reads from the cache) all the useful rows. */
export async function downloadUcac4(cacheFolder, refresh = false) {
  const folder = join(cacheFolder, 'ucac4')
  mkdirSync(folder, { recursive: true })
  const texts = []
  // The stars observed by the USNO telescope, with their magnitude.
  for (let d = -90; d < 90; d += DOWNLOAD_STEP) {
    const upTo = d + DOWNLOAD_STEP
    const name = 'band' + (d < 0 ? 'S' : 'N') + String(Math.abs(d)).padStart(2, '0')
    const condition = upTo >= 90 ? 'dec >= ' + d : 'dec >= ' + d + ' AND dec < ' + upTo
    texts.push(
      await withCache(
        folder,
        name,
        'SELECT ' + COLUMNS + ' FROM ucac4_sources WHERE ' + condition + ' AND momag <= ' + LIMIT_MAGNITUDE,
        refresh
      )
    )
  }
  // The stars without momag: nearly all the bright ones added from Hipparcos and Tycho-2.
  texts.push(
    await withCache(folder, 'without-momag', 'SELECT ' + COLUMNS + ' FROM ucac4_sources WHERE momag IS NULL', refresh)
  )
  return texts
}

const n = (s) => (s === undefined || s === '' ? null : Number(s))

/** Below this momag the UCAC4 measurement is saturated: the catalog V is preferred. */
const SATURATED_MOMAG = 9

/**
 * Magnitude of the star: momag; without momag, apmag or the catalog V.
 * For stars brighter than magnitude 9 momag is distorted by the
 * saturation of the UCAC detectors (a star of V = 4.5 turns out with
 * momag 6 or more), whereas the V reported in the catalog, taken from
 * APASS or from Hipparcos and Tycho-2, is reliable: for them V is used,
 * if present. Null if no measurement is available.
 */
export function magnitude(momag, apmag, vmag) {
  const valid = (m) => m !== null && Number.isFinite(m) && m < 19.9
  if (valid(momag)) return momag < SATURATED_MOMAG && valid(vmag) ? vmag : momag
  for (const m of [apmag, vmag]) if (valid(m)) return m
  return null
}

/** Brings a J2000 position to the given epoch with proper motions (mas/year, RA already multiplied by cos δ). */
export function applyProperMotion(ra, dec, pmra, pmdc, epoch) {
  if (!pmra && !pmdc) return [ra, dec]
  const t = epoch - 2000
  const G = Math.PI / 180
  const a = ra * G
  const d = dec * G
  // Displacement along the east and north directions, in radians.
  const e = ((pmra ?? 0) * t) / 3.6e6 * G
  const nn = ((pmdc ?? 0) * t) / 3.6e6 * G
  const x = Math.cos(d) * Math.cos(a) - e * Math.sin(a) - nn * Math.sin(d) * Math.cos(a)
  const y = Math.cos(d) * Math.sin(a) + e * Math.cos(a) - nn * Math.sin(d) * Math.sin(a)
  const z = Math.sin(d) + nn * Math.cos(d)
  const r = Math.hypot(x, y, z)
  return [((Math.atan2(y, x) / G) % 360 + 360) % 360, Math.asin(z / r) / G]
}

/** Right ascension cells of band k (same formula as localStars.ts). */
export function bandCells(k) {
  const height = 180 / BANDS
  const south = -90 + k * height
  const north = south + height
  const nearest = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north))
  return Math.max(1, Math.ceil((360 * Math.cos((nearest * Math.PI) / 180)) / height - 1e-9))
}

/** Reads the CSV rows and returns the stars {ra, dec, mag} at the package epoch. */
export function readStars(texts) {
  const stars = []
  let discarded = 0
  for (const text of texts) {
    const rows = text.split('\n')
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r) continue
      const c = r.split(',')
      const ra = n(c[0])
      const dec = n(c[1])
      const mag = magnitude(n(c[4]), n(c[5]), n(c[6]))
      if (ra === null || dec === null || mag === null || mag > LIMIT_MAGNITUDE) {
        discarded++
        continue
      }
      const [a, d] = applyProperMotion(ra, dec, n(c[2]), n(c[3]), EPOCH)
      stars.push({ ra: a, dec: d, mag })
    }
  }
  return { stars, discarded }
}

/** Encodes the stars in the stars.bin format. */
export function encodeStars(stars) {
  const height = 180 / BANDS
  const firstCell = []
  let cells = 0
  for (let k = 0; k < BANDS; k++) {
    firstCell.push(cells)
    cells += bandCells(k)
  }
  const withCell = stars.map((s) => {
    const k = Math.min(BANDS - 1, Math.max(0, Math.floor((s.dec + 90) / height)))
    const nc = bandCells(k)
    const j = Math.min(nc - 1, Math.floor((s.ra / 360) * nc))
    return { ...s, k, cell: firstCell[k] + j }
  })
  withCell.sort((a, b) => a.cell - b.cell || a.ra - b.ra)
  const index = new Uint32Array(cells + 1)
  {
    let i = 0
    for (let c = 0; c <= cells; c++) {
      while (i < withCell.length && withCell[i].cell < c) i++
      index[c] = i
    }
  }
  const header = 20
  const starsStart = header + (cells + 1) * 4
  const buf = Buffer.alloc(starsStart + withCell.length * 6)
  buf.write('SLST', 0, 'ascii')
  buf.writeUInt16LE(1, 4)
  buf.writeUInt16LE(BANDS, 6)
  buf.writeUInt32LE(withCell.length, 8)
  buf.writeFloatLE(EPOCH, 12)
  buf.writeUInt32LE(cells, 16)
  for (let c = 0; c <= cells; c++) buf.writeUInt32LE(index[c], header + c * 4)
  let p = starsStart
  for (const s of withCell) {
    const a = Math.round((s.ra / 360) * 16777216) % 16777216
    const south = -90 + s.k * height
    const d = Math.min(65535, Math.max(0, Math.round(((s.dec - south) / height) * 65535)))
    const m = Math.min(255, Math.max(0, Math.round((s.mag + 2) * 16)))
    buf[p] = a & 0xff
    buf[p + 1] = (a >> 8) & 0xff
    buf[p + 2] = (a >> 16) & 0xff
    buf.writeUInt16LE(d, p + 3)
    buf[p + 5] = m
    p += 6
  }
  return buf
}

/** Downloads, reads and encodes: returns the file and the number of stars. */
export async function prepareUcac4Stars(cacheFolder, refresh = false) {
  const texts = await downloadUcac4(cacheFolder, refresh)
  const { stars, discarded } = readStars(texts)
  console.log('  ' + stars.length + ' stars down to magnitude ' + LIMIT_MAGNITUDE + ' (' + discarded + ' rows discarded)')
  return { data: encodeStars(stars), count: stars.length }
}

// Run on its own: it only downloads (useful to fill the cache).
if (process.argv[1] && process.argv[1].endsWith('prepare-stars.mjs')) {
  const { resolve, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  await downloadUcac4(join(root, 'cache-catalogs'), process.argv.includes('--refresh'))
  console.log('Done.')
}
