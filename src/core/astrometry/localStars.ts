import type { CatalogStar } from './solver'
import { CATALOG, STARS } from '@shared/protectionTexts'
import { t as translate } from '@shared/i18n/i18n'

/**
 * Local stars for plate solving: the `stars.bin` file of the plate-solving
 * star package (UCAC4 catalog down to magnitude 12), installed from the
 * catalog gallery.
 *
 * The file is read in pieces: a header with the cell index, then the stars
 * grouped by sky zone. For a field only the cells touched by the requested
 * circle are read, a few tens of kilobytes, without ever loading the whole
 * catalog into memory.
 *
 * Format (little-endian numbers), written by tools/prepare-stars.mjs:
 *   0   "SLST"                              4 bytes
 *   4   format version (1)                  uint16
 *   6   number of declination strips        uint16 (180: one degree each)
 *   8   number of stars                     uint32
 *   12  epoch of the positions              float32 (e.g. 2025.0)
 *   16  number of cells                     uint32
 *   20  index: for each cell the index of its first star, plus a final
 *       entry with the total                (cells + 1) × uint32
 *   then the stars, 6 bytes each:
 *       RA           uint24  fraction of a full turn × 2^24
 *       Dec          uint16  position within the strip × 65535
 *       magnitude    uint8   (m + 2) × 16
 * Each strip is divided into right-ascension cells about as wide as the
 * strip is tall, measured on the sky: max(1, ceil(360 · cos δ / h)) cells,
 * with δ the strip edge closest to the equator. Cells are ordered by
 * strip, from south to north, then by right ascension.
 *
 * This module holds only the pure part: whoever reads the file passes the
 * function that reads a byte range from it (the main process, the tests).
 */

export const STARS_FILE = 'stars.bin'
export const STARS_SIGNATURE = 'SLST'
export const STAR_FORMAT_VERSION = 1
const HEAD = 20
const BYTES_PER_STAR = 6

/** Limiting magnitude of the package: fainter stars are not included. */
export const LOCAL_STARS_MAGNITUDE = 12

/** Header and cell index of a `stars.bin` file. */
export interface StarIndex {
  strips: number
  stars: number
  epoch: number
  /** Index of the first star of each cell, plus the total at the end. */
  cellStart: Uint32Array
  /** First cell of each strip. */
  firstCell: number[]
  /** Cells of each strip. */
  bandCells: number[]
}

/** Right-ascension cells of strip k, out of `strips` strips in total. */
export function cellsInBand(k: number, strips: number): number {
  const height = 180 / strips
  const south = -90 + k * height
  const north = south + height
  const neighbor = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north))
  return Math.max(1, Math.ceil((360 * Math.cos((neighbor * Math.PI) / 180)) / height - 1e-9))
}

/** Bytes to read at the start of the file before the number of cells is known. */
export const STARS_HEADER_BYTES = HEAD

/** Bytes of the full header (head plus index), given the number of cells. */
export function headerBytes(cells: number): number {
  return HEAD + (cells + 1) * 4
}

/**
 * Reads the head of the file (the first 20 bytes): returns the number of
 * cells, or throws if the file is not a star file.
 */
export function readStarsHeader(head: Uint8Array): { cells: number; stars: number; strips: number; epoch: number } {
  if (head.length < HEAD) throw new Error(STARS.shortValue)
  const signature = String.fromCharCode(head[0], head[1], head[2], head[3])
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  if (signature !== STARS_SIGNATURE) throw new Error(STARS.signature)
  const version = view.getUint16(4, true)
  if (version !== STAR_FORMAT_VERSION) {
    throw new Error(
      version > STAR_FORMAT_VERSION ? STARS.futureFormat : STARS.unrecognizedFormat
    )
  }
  const strips = view.getUint16(6, true)
  const stars = view.getUint32(8, true)
  const epoch = view.getFloat32(12, true)
  const cells = view.getUint32(16, true)
  if (strips < 1 || strips > 3600) throw new Error(STARS.corrupted(translate('coreLocalStars.parts.strips')))
  let expected = 0
  for (let k = 0; k < strips; k++) expected += cellsInBand(k, strips)
  if (cells !== expected) throw new Error(STARS.corrupted(translate('coreLocalStars.parts.cells')))
  return { cells, stars, strips, epoch }
}

/** Reads header and index (headerBytes(cells) bytes from the start of the file). */
export function readStarsIndex(header: Uint8Array, fileBytes?: number): StarIndex {
  const t = readStarsHeader(header)
  if (header.length < headerBytes(t.cells)) throw new Error(STARS.shortValue)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const cellStart = new Uint32Array(t.cells + 1)
  let before = 0
  for (let c = 0; c <= t.cells; c++) {
    const v = view.getUint32(HEAD + c * 4, true)
    if (v < before || v > t.stars) throw new Error(STARS.corrupted(translate('coreLocalStars.parts.index')))
    cellStart[c] = v
    before = v
  }
  if (cellStart[t.cells] !== t.stars) throw new Error(STARS.corrupted(translate('coreLocalStars.parts.total')))
  if (fileBytes !== undefined && fileBytes !== headerBytes(t.cells) + t.stars * BYTES_PER_STAR) {
    throw new Error(STARS.incomplete)
  }
  const firstCell: number[] = []
  const bandCells: number[] = []
  let c = 0
  for (let k = 0; k < t.strips; k++) {
    firstCell.push(c)
    const n = cellsInBand(k, t.strips)
    bandCells.push(n)
    c += n
  }
  return { strips: t.strips, stars: t.stars, epoch: t.epoch, cellStart, firstCell, bandCells }
}

/** Range of stars (indices) to read, with the strip it belongs to. */
export interface StarSegment {
  strip: number
  from: number
  a: number
}

const RAD = Math.PI / 180

/**
 * Star segments covering the circle of `radius` degrees around (ra, dec).
 * Adjacent cells of a strip form a single segment; around 0h the segment
 * is split in two.
 */
export function segmentsInCone(index: StarIndex, ra: number, dec: number, radius: number): StarSegment[] {
  const h = 180 / index.strips
  const south = Math.max(-90, dec - radius)
  const north = Math.min(90, dec + radius)
  const kDa = Math.max(0, Math.min(index.strips - 1, Math.floor((south + 90) / h)))
  const kA = Math.max(0, Math.min(index.strips - 1, Math.floor((north + 90) / h)))
  // Half-width of the circle in RA: the full turn if it touches a pole.
  const fullCircle = Math.abs(dec) + radius >= 89.999 || radius >= 90
  const seeds = fullCircle ? 180 : Math.asin(Math.min(1, Math.sin(radius * RAD) / Math.cos(dec * RAD))) / RAD
  const a0 = (((ra % 360) + 360) % 360)
  const segments: StarSegment[] = []
  for (let k = kDa; k <= kA; k++) {
    const n = index.bandCells[k]
    const base = index.firstCell[k]
    const add = (cDa: number, cA: number): void => {
      const from = index.cellStart[base + cDa]
      const a = index.cellStart[base + cA + 1]
      if (a > from) segments.push({ strip: k, from, a })
    }
    if (seeds >= 180 || n === 1) {
      add(0, n - 1)
      continue
    }
    const width = 360 / n
    const idFrom = Math.floor((a0 - seeds) / width)
    const iA = Math.floor((a0 + seeds) / width)
    if (iA - idFrom + 1 >= n) add(0, n - 1)
    else if (idFrom < 0) {
      add(idFrom + n, n - 1)
      add(0, iA)
    } else if (iA >= n) {
      add(idFrom, n - 1)
      add(0, iA - n)
    } else add(idFrom, iA)
  }
  return segments
}

/** Byte offset in the file of the star with index i. */
export function starPosition(index: StarIndex, i: number): number {
  return headerBytes(index.cellStart.length - 1) + i * BYTES_PER_STAR
}

/** Decodes the stars of a segment (the bytes read from starPosition(from) onward). */
export function decodeSegment(data: Uint8Array, strip: number, strips: number): CatalogStar[] {
  const h = 180 / strips
  const south = -90 + strip * h
  const n = Math.floor(data.length / BYTES_PER_STAR)
  const stars: CatalogStar[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * BYTES_PER_STAR
    const a = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)
    const d = data[p + 3] | (data[p + 4] << 8)
    stars[i] = {
      ra: (a / 16777216) * 360,
      dec: south + (d / 65535) * h,
      g: data[p + 5] / 16 - 2
    }
  }
  return stars
}

function distanceDegrees(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a =
    Math.sin(((dec2 - dec1) * RAD) / 2) ** 2 +
    Math.cos(dec1 * RAD) * Math.cos(dec2 * RAD) * Math.sin(((ra2 - ra1) * RAD) / 2) ** 2
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / RAD
}

/**
 * Full check of a whole `stars.bin` file, at installation: header and
 * index consistent with the length, star count equal to the manifest's, no
 * star fainter than the declared limiting magnitude, and every star in the
 * sky cell where the index puts it (otherwise the zone search would return
 * wrong stars and the solved field would be false). Returns the problems,
 * empty if the file is valid.
 */
export function checkStarFile(data: Uint8Array, declaredItems: number, limitMagnitude: number): string[] {
  let index: StarIndex
  try {
    index = readStarsIndex(data, data.length)
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)]
  }
  const problems: string[] = []
  if (index.stars !== declaredItems) problems.push(CATALOG.starsDifferentCount(index.stars, declaredItems))
  // Tolerance of one magnitude encoding step (1/16) and one RA step (360 / 2^24 degrees).
  const magTolerance = 1 / 16 + 1e-9
  const raTolerance = 1e-4
  let faintest = -Infinity
  let outsideCell = 0
  const base = headerBytes(index.cellStart.length - 1)
  for (let k = 0; k < index.strips; k++) {
    const n = index.bandCells[k]
    for (let c = 0; c < n; c++) {
      const cell = index.firstCell[k] + c
      const from = index.cellStart[cell]
      const a = index.cellStart[cell + 1]
      if (a === from) continue
      const stars = decodeSegment(data.subarray(base + from * BYTES_PER_STAR, base + a * BYTES_PER_STAR), k, index.strips)
      const left = (c * 360) / n
      const right = ((c + 1) * 360) / n
      for (const s of stars) {
        if (s.g > faintest) faintest = s.g
        if (n > 1 && (s.ra < left - raTolerance || s.ra > right + raTolerance)) outsideCell++
      }
    }
  }
  if (faintest > limitMagnitude + magTolerance) problems.push(CATALOG.fainterStars(faintest, limitMagnitude))
  if (outsideCell > 0) problems.push(CATALOG.starsOutsideCell(outsideCell))
  return problems
}

/** Cap on the returned stars, the same as for the Gaia query. */
export const MAX_LOCAL_STARS = 2000

/**
 * The file's stars within `radius` degrees of (ra, dec), brighter than
 * `magnitude`, sorted brightest first, at most `max`.
 * `read(position, length)` returns the requested bytes of the file.
 */
export async function starsInCone(
  index: StarIndex,
  read: (position: number, length: number) => Promise<Uint8Array>,
  ra: number,
  dec: number,
  radius: number,
  magnitude: number,
  max = MAX_LOCAL_STARS
): Promise<CatalogStar[]> {
  const choices: CatalogStar[] = []
  for (const t of segmentsInCone(index, ra, dec, radius)) {
    const data = await read(starPosition(index, t.from), (t.a - t.from) * BYTES_PER_STAR)
    for (const s of decodeSegment(data, t.strip, index.strips)) {
      if (s.g < magnitude && distanceDegrees(ra, dec, s.ra, s.dec) <= radius) choices.push(s)
    }
  }
  choices.sort((a, b) => a.g - b.g)
  return choices.slice(0, max)
}

/**
 * Catalog stars expected inside the image field: those within the circle
 * inscribed in the image, scaled to the area of the whole image. Used to
 * tell beforehand whether the local catalog is enough: on a narrow field
 * the stars down to magnitude 12 are too few to recognize the pattern.
 */
export function expectedStarsInField(
  catalog: CatalogStar[],
  ra: number,
  dec: number,
  width: number,
  height: number,
  scale: number
): number {
  const side = Math.min(width, height)
  const radius = ((side / 2) * scale) / 3600
  let inside = 0
  for (const s of catalog) if (distanceDegrees(ra, dec, s.ra, s.dec) <= radius) inside++
  return (inside * (width * height)) / (Math.PI * (side / 2) ** 2)
}
