/**
 * Reference stars from the Gaia DR3 catalog, for photometric color
 * calibration.
 *
 * Gaia measured the position, brightness (G band) and color (BP-RP index) of
 * almost two billion stars with a precision no amateur photograph can
 * approach: knowing the true color of the stars in the field, the color of
 * the image can be corrected.
 *
 * The catalog cannot be downloaded in full, so it is queried online with an
 * ADQL request (an SQL dialect for the sky) to a TAP service. VizieR
 * (Strasbourg) is tried first, as it is usually fast; if it does not respond
 * the ESA archive is used, slower (up to 30-40 seconds, because it queues
 * requests) but very reliable.
 *
 * Runs in the Electron main process, which has network access.
 */

import { t } from '../shared/i18n/i18n'
import { GaiaCatalogError } from '../shared/gaiaCatalog'

export interface GaiaCatalogStar {
  /** Right ascension in degrees (ICRS, epoch 2016). */
  ra: number
  /** Declination in degrees. */
  dec: number
  /** Magnitude in the Gaia G band. */
  g: number
  /** BP-RP color index: negative for blue stars, above 2 for red ones. */
  bpRp: number
}

/** Beyond this count, additional stars do not improve the calibration. */
const MAX_STARS = 2000

const VIZIER = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync'
const ESA = 'https://gea.esac.esa.int/tap-server/tap/sync'

/** Maximum waits: the ESA archive queues requests and needs a longer wait. */
const VIZIER_WAIT_MS = 30_000
const ESA_WAIT_MS = 90_000

interface Service {
  /** Language key of the service name shown in the error details. */
  nameKey: string
  url: string
  waitMs: number
  query: (ra: number, dec: number, radius: number, mag: number) => string
}

const SERVICES: Service[] = [
  {
    nameKey: 'mainGaiaCatalog.services.vizier',
    url: VIZIER,
    waitMs: VIZIER_WAIT_MS,
    query: (ra, dec, radius, mag) =>
      `SELECT TOP ${MAX_STARS} RA_ICRS, DE_ICRS, Gmag, "BP-RP" FROM "I/355/gaiadr3" ` +
      `WHERE 1=CONTAINS(POINT('ICRS', RA_ICRS, DE_ICRS), CIRCLE('ICRS', ${ra}, ${dec}, ${radius})) ` +
      `AND Gmag < ${mag} AND "BP-RP" IS NOT NULL ORDER BY Gmag`
  },
  {
    nameKey: 'mainGaiaCatalog.services.esa',
    url: ESA,
    waitMs: ESA_WAIT_MS,
    // The "lite" version of the table has only the main columns and is
    // noticeably faster to query.
    query: (ra, dec, radius, mag) =>
      `SELECT TOP ${MAX_STARS} ra, dec, phot_g_mean_mag, bp_rp FROM gaiadr3.gaia_source_lite ` +
      `WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra}, ${dec}, ${radius})) ` +
      `AND phot_g_mean_mag < ${mag} AND bp_rp IS NOT NULL ORDER BY phot_g_mean_mag`
  }
]

/**
 * The stars brighter than maxMagnitude within radiusDegrees of the center,
 * sorted from the brightest, at most 2000. Throws a GaiaCatalogError (code
 * and readable message)
 * if no service responds.
 */
export async function gaiaStars(
  ra: number,
  dec: number,
  radiusDegrees: number,
  maxMagnitude: number
): Promise<GaiaCatalogStar[]> {
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(radiusDegrees) || !Number.isFinite(maxMagnitude)) {
    throw new GaiaCatalogError({ code: 'invalid-coordinates' })
  }
  // Rounded values: the query stays readable and nothing changes in practice.
  const r = Math.min(5, Math.max(0.01, radiusDegrees)).toFixed(4)
  const a = (((ra % 360) + 360) % 360).toFixed(6)
  const d = Math.min(90, Math.max(-90, dec)).toFixed(6)
  const m = Math.min(21, Math.max(3, maxMagnitude)).toFixed(2)

  const problems: string[] = []
  for (const s of SERVICES) {
    try {
      const text = await query(s.url, s.query(+a, +d, +r, +m), s.waitMs)
      return readCsv(text)
    } catch (e) {
      problems.push(t(s.nameKey) + ': ' + (e instanceof Error ? e.message : String(e)))
    }
  }
  throw new GaiaCatalogError({ code: 'no-response', details: problems.join(' — ') })
}

async function query(url: string, adql: string, waitMs: number): Promise<string> {
  const body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql })
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      body: body,
      signal: AbortSignal.timeout(waitMs)
    })
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(t('mainGaiaCatalog.timeout', { seconds: Math.round(waitMs / 1000) }))
    }
    throw new Error(t('mainGaiaCatalog.connectionFailed'))
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? t('mainGaiaCatalog.httpErrorUnavailable', { status: response.status })
        : t('mainGaiaCatalog.httpError', { status: response.status })
    )
  }
  // TAP services report query errors with a VOTable document even when CSV
  // is requested.
  if (text.trimStart().startsWith('<')) {
    const reason = text.match(/<INFO[^>]*name="QUERY_STATUS"[^>]*>([\s\S]*?)<\/INFO>/i)?.[1]?.trim()
    throw new Error(
      reason ? t('mainGaiaCatalog.rejectedWithReason', { reason: reason.slice(0, 200) }) : t('mainGaiaCatalog.rejected')
    )
  }
  return text
}

/**
 * Reads the returned CSV: four numeric columns in the order of the query
 * (ra, dec, G, BP-RP), with one header row.
 */
function readCsv(text: string): GaiaCatalogStar[] {
  const lines = text.split(/\r?\n/)
  const stars: GaiaCatalogStar[] = []
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',')
    if (fields.length < 4) continue
    const ra = parseFloat(fields[0])
    const dec = parseFloat(fields[1])
    const g = parseFloat(fields[2])
    const bpRp = parseFloat(fields[3])
    if ([ra, dec, g, bpRp].every(Number.isFinite)) stars.push({ ra, dec, g, bpRp })
  }
  if (stars.length === 0 && lines.filter((r) => r.trim()).length > 1) {
    throw new Error(t('mainGaiaCatalog.unknownFormat'))
  }
  return stars
}
