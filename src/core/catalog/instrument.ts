import type { FitsHeader, FrameMetadata } from '@shared/types'
import { formatDecimal, t } from '@shared/i18n/i18n'

/**
 * Reads the instrument data written in the FITS header.
 *
 * Many telescopes, especially those that run the capture on their own, add
 * information to the header beyond the standard keywords: total exposure,
 * firmware version, focuser position, observing site, camera used. This
 * module collects it for any instrument, without assuming a brand.
 *
 * The model is recognized only as one piece of data among others: if the
 * reported name contains a known model code, the code is shown next to the
 * file name. This makes it easy to notice files from two different
 * instruments in the same session.
 *
 * Important: focal length and pixel size are always read from the file
 * header, never from an internal table, so the field scale computations
 * stay correct with any instrument.
 */

export interface InstrumentInfo {
  /** Model code recognized in the reported name, or null. */
  model: string | null
  /** Full name reported by the device. */
  reportedName: string
  /** Identifier of the individual unit, if present in TELESCOP. */
  deviceId: string | null
  /** Firmware version (PROGRAM or SWCREATE keyword). */
  firmware: string | null
  /** True if the frame comes from an auxiliary wide-angle camera (WIDECAM). */
  wideCamera: boolean
  /** Total integrated exposure in seconds (TOTALEXP). */
  totalExposure: number | null
  /** Focuser position (FOCUSPOS). */
  focusPosition: number | null
  /** Reported bias level. */
  bias: number | null
  /** Latitude of the observing site in degrees. */
  siteLatitude: number | null
  /** Longitude of the observing site in degrees. */
  siteLongitude: number | null
}

function card(header: FitsHeader, key: string): string | number | boolean | null {
  const v = header.cards[key]
  return v === undefined ? null : v
}

function cardNum(header: FitsHeader, key: string, ...alternatives: string[]): number | null {
  for (const k of [key, ...alternatives]) {
    const v = header.cards[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

function cardStr(header: FitsHeader, key: string): string | null {
  const v = header.cards[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/**
 * Looks for a known model code in any string, also with a suffix (Pro, a
 * serial number after an underscore) or preceded by the manufacturer name.
 * Returns null if nothing is found.
 */
export function recognizeModel(text: string): string | null {
  const upper = text.toUpperCase()
  const match = /\bS\s*(30|50)\s*[-_ ]?\s*(PRO)?/.exec(upper)
  if (!match) return null
  return 'S' + match[1] + (match[2] !== undefined ? ' Pro' : '')
}

/**
 * Extracts the instrument data, or null if the header contains none beyond
 * the standard keywords.
 */
export function extractInstrumentInfo(header: FitsHeader): InstrumentInfo | null {
  const creator = cardStr(header, 'CREATOR') ?? ''
  const instrument = cardStr(header, 'INSTRUME') ?? ''
  const telescope = cardStr(header, 'TELESCOP') ?? ''
  const producer = cardStr(header, 'PRODUCER') ?? ''

  // The model is looked up first in the descriptive fields, then in
  // TELESCOP. A short code could appear by chance in the name of another
  // instrument: it is accepted only if the reported name belongs to a
  // family that uses these codes (manufacturer keywords).
  const descriptive = [creator, instrument, producer, telescope].join(' ')
  const knownFamily =
    /SEESTAR/i.test(descriptive) || (/\bS(30|50)\b/i.test(descriptive) && /ZWO/i.test(descriptive))
  let model: string | null = null
  if (knownFamily) {
    model = recognizeModel(creator + ' ' + instrument) ?? recognizeModel(telescope)
  }

  // TELESCOP can have the form "S50_xxxxxxxx": the part after the
  // underscore identifies the individual unit.
  const idMatch = /_([0-9a-f]{4,})/i.exec(telescope)

  const reportedName =
    creator !== '' ? creator : instrument !== '' ? instrument : telescope

  const wideRaw = card(header, 'WIDECAM')
  const wideCamera = wideRaw === true || wideRaw === 1

  const info: InstrumentInfo = {
    model,
    reportedName,
    deviceId: idMatch ? idMatch[1] : null,
    firmware: cardStr(header, 'PROGRAM') ?? cardStr(header, 'SWCREATE'),
    wideCamera,
    totalExposure: cardNum(header, 'TOTALEXP'),
    focusPosition: cardNum(header, 'FOCUSPOS', 'FOCPOS'),
    bias: cardNum(header, 'BIAS'),
    siteLatitude: cardNum(header, 'SITELAT', 'OBSGEO-B', 'LAT-OBS'),
    siteLongitude: cardNum(header, 'SITELONG', 'OBSGEO-L', 'LONG-OBS')
  }

  // Without any data beyond the standard keywords there is nothing to show.
  const hasData =
    info.model !== null ||
    info.firmware !== null ||
    info.wideCamera ||
    info.totalExposure !== null ||
    info.focusPosition !== null ||
    info.siteLatitude !== null ||
    info.siteLongitude !== null
  return hasData ? info : null
}

/** Short description of the instrument, ready for the user interface. */
export function describeInstrument(metadata: FrameMetadata): string {
  const info = metadata.instrumentInfo
  const name =
    info?.model ?? metadata.instrument ?? metadata.telescope ?? (info?.reportedName || null)
  if (!info) return name ?? t('coreInstrument.notReported')

  const parts: string[] = [name ?? t('coreInstrument.notReported')]
  if (info.wideCamera) parts.push(t('coreInstrument.wideCamera'))
  if (metadata.focalLength !== null) parts.push(metadata.focalLength + ' mm')
  if (info.firmware !== null) parts.push(t('coreInstrument.firmware', { version: info.firmware }))
  return parts.join(' - ')
}

/** Focuser position ready for the user interface, or null. */
export function describeFocuser(metadata: FrameMetadata): string | null {
  const pos = metadata.instrumentInfo?.focusPosition ?? null
  return pos === null ? null : String(Math.round(pos))
}

/**
 * Observing site in degrees with the hemisphere, for example
 * "45.4642° N - 9.1900° E", or null if the file does not report it.
 */
export function describeLocation(metadata: FrameMetadata): string | null {
  const lat = metadata.instrumentInfo?.siteLatitude ?? null
  const lon = metadata.instrumentInfo?.siteLongitude ?? null
  if (lat === null || lon === null) return null
  const f = (v: number): string => formatDecimal(Math.abs(v), 4)
  return f(lat) + '° ' + (lat >= 0 ? 'N' : 'S') + ' - ' + f(lon) + '° ' + (lon >= 0 ? 'E' : t('coreInstrument.west'))
}
