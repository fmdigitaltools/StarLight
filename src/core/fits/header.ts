import type { FitsHeader, FitsValue, BayerPattern, FrameMetadata, FrameType } from '@shared/types'
import { extractInstrumentInfo } from '@core/catalog/instrument'
import { readWcs, scaleArcsec } from '@core/astrometry/wcs'

const CARD_SIZE = 80
const BLOCK_SIZE = 2880
const CARDS_PER_BLOCK = BLOCK_SIZE / CARD_SIZE

/** Converts an ASCII sequence taken from the buffer into a string. */
function ascii(bytes: Uint8Array, start: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[start + i])
  return s
}

/**
 * Interprets the value of a FITS card according to the standard:
 * strings between single quotes, logical T/F, integer or real numbers.
 */
export function parseValue(raw: string): FitsValue {
  const v = raw.trim()
  if (v === '') return null
  if (v.startsWith("'")) {
    // String: two consecutive quotes represent a single quote.
    const end = v.lastIndexOf("'")
    const body = end > 0 ? v.slice(1, end) : v.slice(1)
    return body.split("''").join("'").trim()
  }
  if (v === 'T') return true
  if (v === 'F') return false
  // Fortran notation: 1.0D5 is equivalent to 1.0E5.
  const parsed = Number(v.replace(/[dD]/, 'e'))
  if (!Number.isNaN(parsed)) return parsed
  return v
}

/**
 * Reads the header of an HDU starting at a byte offset.
 * Returns the header and the offset at which the data begins.
 */
export function readHeader(
  buffer: Uint8Array,
  offset = 0
): { header: FitsHeader; dataOffset: number } {
  const cards: Record<string, FitsValue> = {}
  const comments: Record<string, string> = {}
  const order: string[] = []
  let pos = offset
  let done = false
  let freeCount = 0

  while (!done && pos < buffer.length) {
    for (let c = 0; c < CARDS_PER_BLOCK; c++) {
      const cardStart = pos + c * CARD_SIZE
      if (cardStart + CARD_SIZE > buffer.length) {
        done = true
        break
      }
      const card = ascii(buffer, cardStart, CARD_SIZE)
      const keyword = card.slice(0, 8).trim()

      if (keyword === 'END') {
        done = true
        break
      }
      if (keyword === '') continue

      // HISTORY and COMMENT do not use the "=" separator and may repeat.
      if (keyword === 'HISTORY' || keyword === 'COMMENT') {
        const key = keyword + '_' + freeCount++
        cards[key] = card.slice(8).trim()
        order.push(key)
        continue
      }

      const rest = card.slice(8)
      if (rest[0] !== '=') continue

      let valuePart = rest.slice(1)
      let commentPart = ''

      // The "/" separator is ignored when it falls inside a quoted string.
      let inString = false
      for (let i = 0; i < valuePart.length; i++) {
        const ch = valuePart[i]
        if (ch === "'") {
          inString = !inString
        } else if (ch === '/' && !inString) {
          commentPart = valuePart.slice(i + 1).trim()
          valuePart = valuePart.slice(0, i)
          break
        }
      }

      if (!(keyword in cards)) order.push(keyword)
      cards[keyword] = parseValue(valuePart)
      if (commentPart) comments[keyword] = commentPart
    }
    pos += BLOCK_SIZE
  }

  return { header: { cards, comments, order }, dataOffset: pos }
}

/** Checks for the SIMPLE signature that opens every valid FITS file. */
export function isFits(buffer: Uint8Array): boolean {
  if (buffer.length < CARD_SIZE) return false
  return ascii(buffer, 0, 6) === 'SIMPLE'
}

function num(header: FitsHeader, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = header.cards[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

function str(header: FitsHeader, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = header.cards[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

/**
 * Converts a sexagesimal coordinate ("05 35 17.3", "+22:00:52") to decimal
 * degrees. Decimal values are accepted too.
 */
export function parseSexagesimal(value: string | number | null, isHours: boolean): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return isHours ? value * 15 : value

  const text = value.trim()
  if (text === '') return null

  const plain = Number(text)
  if (!Number.isNaN(plain)) return isHours ? plain * 15 : plain

  const parts = text.split(/[^0-9.]+/).filter((p) => p !== '')
  if (parts.length < 2) return null

  const sign = text.startsWith('-') ? -1 : 1
  const d = Number(parts[0])
  const m = Number(parts[1]) || 0
  const s = Number(parts[2]) || 0
  if (Number.isNaN(d)) return null

  const decimal = d + m / 60 + s / 3600
  return sign * (isHours ? decimal * 15 : decimal)
}

/** Swaps the two rows of the 2x2 cell: "RGGB" becomes "GBRG". */
function swapRows(p: string): string {
  return p.slice(2, 4) + p.slice(0, 2)
}

/** Swaps the two columns of the 2x2 cell: "RGGB" becomes "GRBG". */
function swapColumns(p: string): string {
  return p[1] + p[0] + p[3] + p[2]
}

/**
 * Normalizes the Bayer pattern declared in the header and refers it to the
 * first row of data in the file, which is where color interpolation starts
 * (`debayer` reads the pattern from pixel (0, 0) of the data as stored).
 *
 * Two keywords can shift the pattern:
 * - XBAYROFF / YBAYROFF (written by common capture software): the matrix
 *   starts one column or one row further along, for example after a crop;
 *   an odd offset swaps the columns or the rows of the cell.
 * - ROWORDER: with 'BOTTOM-UP' the first row of the file is the bottom one,
 *   while the pattern is declared reading the sensor from the top; with an
 *   even number of rows the first row of the file then falls on the second
 *   row of the cell, and the rows must be swapped. 'TOP-DOWN' or its
 *   absence leaves the pattern as it is.
 *
 * On raw frames without ROWORDER that declare BAYERPAT = BGGR, applying the
 * pattern to the first row of the file renders an emission nebula red, as
 * it should be; with RGGB it would come out blue.
 */
function parseBayer(header: FitsHeader): BayerPattern {
  const raw = str(header, 'BAYERPAT', 'COLORTYP')
  if (!raw) return 'NONE'
  let p = raw.toUpperCase().replace(/[^RGB]/g, '')
  if (p !== 'RGGB' && p !== 'BGGR' && p !== 'GRBG' && p !== 'GBRG') return 'NONE'

  const offX = num(header, 'XBAYROFF', 'BAYOFFX') ?? 0
  const offY = num(header, 'YBAYROFF', 'BAYOFFY') ?? 0
  if (Math.abs(Math.round(offX)) % 2 === 1) p = swapColumns(p)
  if (Math.abs(Math.round(offY)) % 2 === 1) p = swapRows(p)

  const order = (str(header, 'ROWORDER') ?? '').toUpperCase().replace(/[^A-Z]/g, '')
  const rows = num(header, 'NAXIS2') ?? 0
  if (order === 'BOTTOMUP' && rows % 2 === 0) p = swapRows(p)

  return p as BayerPattern
}

/**
 * Exposure time in seconds.
 *
 * EXPTIME is in seconds by convention; EXPOSURE usually is too, but some
 * instruments write it in milliseconds (for example
 * `EXPOSURE = 10000 / [ms] Total Exposure Time` for 10 seconds). The unit
 * is determined, in order, from:
 * 1. the EXPUNIT keyword, if present ('ms', 's', 'us'...);
 * 2. the card comment ("[ms]", "msec", "milliseconds"...);
 * 3. as a last resort, if only EXPOSURE is present and it exceeds one hour,
 *    the value is taken to be in milliseconds: no single amateur exposure
 *    lasts more than 3600 seconds, whereas 10000 ms is a perfectly normal
 *    exposure.
 */
function readExposure(header: FitsHeader): number | null {
  const keys = ['EXPTIME', 'EXPOSURE', 'ITIME']
  const key = keys.find((k) => {
    const v = header.cards[k]
    return typeof v === 'number' && Number.isFinite(v)
  })
  if (key === undefined) return null
  const value = header.cards[key] as number

  const factor = (text: string): number | null => {
    const t = text.toLowerCase()
    if (/(^|[^a-z])(us|usec|µs|microsec\w*)([^a-z]|$)/.test(t)) return 1e-6
    if (/(^|[^a-z])(ms|msec|millisec\w*)([^a-z]|$)/.test(t)) return 1e-3
    if (/(^|[^a-z])(s|sec|secs|second\w*|seconds?)([^a-z]|$)/.test(t)) return 1
    return null
  }

  const unit = str(header, 'EXPUNIT', 'EXPUNITS')
  const fromUnit = unit !== null ? factor(unit) : null
  if (fromUnit !== null) return value * fromUnit

  const comment = header.comments[key]
  const fromComment = comment ? factor(comment) : null
  if (fromComment !== null) return value * fromComment

  if (key === 'EXPOSURE' && value > 3600) return value / 1000
  return value
}

/**
 * Sensor temperature. TEMP is too generic (it may be the air or the tube)
 * and is used only if its comment mentions the sensor, for example
 * `TEMP = 31.7 / [C] Sensor temperature`.
 */
function readSensorTemperature(header: FitsHeader): number | null {
  const explicit = num(header, 'CCD-TEMP', 'CCDTEMP', 'SENSORTEMP', 'TEMPERAT')
  if (explicit !== null) return explicit
  const comment = (header.comments['TEMP'] ?? '').toLowerCase()
  if (/sensor|ccd|cmos|camera|chip/.test(comment)) return num(header, 'TEMP')
  return null
}

/**
 * Infers the frame type.
 *
 * The IMAGETYP keyword is the main source, but not all devices fill it in
 * consistently, so the file name is used as confirmation. Some smart
 * telescopes produce the master dark themselves; it must be recognized as
 * such and not mistaken for a light frame.
 */
function parseFrameType(
  header: FitsHeader,
  stackCount: number | null,
  fileName: string
): FrameType {
  const t = (str(header, 'IMAGETYP', 'FRAME', 'OBSTYPE') ?? '').toLowerCase()
  const n = fileName.toLowerCase()

  if (t.includes('dark') || /(^|[^a-z])dark/.test(n)) return 'dark'
  if (t.includes('flat') || /(^|[^a-z])flat/.test(n)) return 'flat'
  if (t.includes('bias') || t.includes('zero') || /(^|[^a-z])bias/.test(n)) return 'bias'
  if (stackCount !== null && stackCount > 1) return 'stacked'
  if (t.includes('light') || t.includes('object') || t.includes('science')) return 'light'
  return t === '' ? 'light' : 'unknown'
}

/**
 * Extracts the relevant exposure metadata, handling the keyword variants
 * used by smart telescopes and common capture software.
 */
export function extractMetadata(header: FitsHeader, fileName = ''): FrameMetadata {
  const focalLength = num(header, 'FOCALLEN', 'FOCAL', 'TELFOC')
  // PIXSZ is a variant used by some instruments.
  const pixelSize = num(header, 'XPIXSZ', 'PIXSIZE1', 'PIXSIZE', 'PIXSZ')
  const binning = num(header, 'XBINNING', 'BINNING') ?? 1

  // Field scale: 206.265 x pixel size (um) / focal length (mm).
  // If the header carries the astrometric solution, its scale wins, since
  // it describes the image as it really is: in the stacked output of smart
  // telescopes the image is upscaled twice (drizzle), so the optical scale
  // from the focal length would be double the real one.
  const wcs = readWcs(header)
  const opticalScale =
    focalLength !== null && pixelSize !== null && focalLength > 0
      ? (206.265 * pixelSize * binning) / focalLength
      : null
  const wcsScale = wcs !== null ? scaleArcsec(wcs) : null
  const pixelScale = wcsScale !== null && Number.isFinite(wcsScale) && wcsScale > 0 ? wcsScale : opticalScale

  const stackCount = num(header, 'STACKCNT', 'NCOMBINE', 'STACKED')

  // RA and CRVAL1 are expressed in degrees, OBJCTRA in sexagesimal hours.
  const raCard = header.cards['RA'] ?? header.cards['CRVAL1'] ?? null
  const raHours = header.cards['OBJCTRA'] ?? null
  const ra =
    raCard !== null
      ? parseSexagesimal(raCard as string | number, false)
      : parseSexagesimal(raHours as string | number, true)

  const decCard = header.cards['DEC'] ?? header.cards['CRVAL2'] ?? header.cards['OBJCTDEC'] ?? null

  return {
    object: str(header, 'OBJECT', 'OBJCTNAM', 'TARGET'),
    ra,
    dec: parseSexagesimal(decCard as string | number, false),
    exposure: readExposure(header),
    gain: num(header, 'GAIN', 'EGAIN', 'ISOSPEED'),
    sensorTemp: readSensorTemperature(header),
    dateObs: str(header, 'DATE-OBS', 'DATE_OBS', 'DATE'),
    instrument: str(header, 'INSTRUME', 'CAMERA', 'DETECTOR'),
    telescope: str(header, 'TELESCOP', 'TELESCOPE'),
    filter: str(header, 'FILTER', 'FILTER1', 'FWHEEL'),
    focalLength,
    pixelSize,
    bayer: parseBayer(header),
    pixelScale,
    frameType: parseFrameType(header, stackCount, fileName),
    stackCount,
    totalExposure: num(header, 'TOTALEXP', 'LIVETIME', 'EXPTOTAL'),
    instrumentInfo: extractInstrumentInfo(header),
    wcs
  }
}

/** Whether the header contains additional instrument data. */
export function hasInstrumentInfo(metadata: FrameMetadata): boolean {
  return metadata.instrumentInfo !== null
}
