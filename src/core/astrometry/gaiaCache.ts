/**
 * Cache of the stars already downloaded from the Gaia catalog.
 *
 * A catalog query takes tens of seconds, and both plate solving and
 * photometric calibration issue one for the same frame: with a single
 * cache the second reuses what the first downloaded.
 *
 * A request is a circle of sky and a limiting magnitude. A downloaded list
 * is reused when its circle contains the requested one and its limiting
 * magnitude is at least the requested one: only the stars needed are kept
 * (inside the circle and bright enough). Requests for fainter stars or a
 * larger area download again.
 *
 * One exception: the catalog returns at most `MAX_STARS` stars, the
 * brightest. If a list hit that cap, it contains all stars only down to the
 * magnitude of its faintest star; beyond that, stars are missing and the
 * request must be repeated.
 *
 * The module is pure: the caller passes the function that actually
 * downloads.
 */

/** Star cap per request: the same as in the main process (main/gaiaCatalog.ts). */
export const MAX_STARS = 2000

/** A Gaia catalog star. */
export interface GaiaStar {
  ra: number
  dec: number
  /** G-band magnitude. */
  g: number
  /** BP-RP color index. */
  bpRp: number
}

/** Sky area and limiting magnitude of a request. */
export interface GaiaRequest {
  ra: number
  dec: number
  /** Radius in degrees. */
  radius: number
  /** Limiting G magnitude. */
  magnitude: number
}

interface Entry {
  request: GaiaRequest
  stars: GaiaStar[]
  /** True if the list hit the catalog cap. */
  full: boolean
  /** Magnitude of the faintest star in the list. */
  faintest: number
}

/** Lists kept per frame: beyond this the oldest is dropped. */
const ENTRIES_PER_FRAME = 4

const RAD = Math.PI / 180

function distanceDegrees(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a =
    Math.sin(((dec2 - dec1) * RAD) / 2) ** 2 +
    Math.cos(dec1 * RAD) * Math.cos(dec2 * RAD) * Math.sin(((ra2 - ra1) * RAD) / 2) ** 2
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / RAD
}

function covers(v: Entry, r: GaiaRequest): boolean {
  const d = distanceDegrees(v.request.ra, v.request.dec, r.ra, r.dec)
  // A tiny margin for request rounding.
  if (d + r.radius > v.request.radius + 1e-6) return false
  if (r.magnitude > v.request.magnitude) return false
  if (v.full && r.magnitude > v.faintest) return false
  return true
}

function cropRegion(v: Entry, r: GaiaRequest): GaiaStar[] {
  return v.stars.filter(
    (s) => s.g < r.magnitude && distanceDegrees(r.ra, r.dec, s.ra, s.dec) <= r.radius
  )
}

export interface GaiaCache {
  /** True if the request can be served without downloading (hence without internet). */
  alreadyAvailable: (frame: string, request: GaiaRequest) => boolean
  /** The requested stars: from the cache if present, otherwise downloaded. */
  stars: (frame: string, request: GaiaRequest) => Promise<GaiaStar[]>
  /** Number of actual downloads (for tests). */
  downloads: () => number
  /** Sky zones and stars currently held (for the Performance card). */
  count: () => { zones: number; stars: number }
  /**
   * Forgets everything: the next request downloads again. A request already
   * in progress completes normally and its list is kept.
   */
  clear: () => void
}

/** Creates a cache that downloads with the given function. */
export function createGaiaCache(
  download: (ra: number, dec: number, radius: number, magnitude: number) => Promise<GaiaStar[]>
): GaiaCache {
  const perFrame = new Map<string, Entry[]>()
  let counter = 0

  const find = (frame: string, r: GaiaRequest): Entry | undefined =>
    perFrame.get(frame)?.find((v) => covers(v, r))

  return {
    alreadyAvailable: (frame, r) => find(frame, r) !== undefined,
    stars: async (frame, r) => {
      const entry = find(frame, r)
      if (entry) return cropRegion(entry, r)
      counter++
      const stars = await download(r.ra, r.dec, r.radius, r.magnitude)
      const newValue: Entry = {
        // The same limits the main process applies to the request: the area
        // actually downloaded is recorded.
        request: {
          ra: r.ra,
          dec: r.dec,
          radius: Math.min(5, Math.max(0.01, r.radius)),
          magnitude: Math.min(21, Math.max(3, r.magnitude))
        },
        stars,
        full: stars.length >= MAX_STARS,
        faintest: stars.reduce((m, s) => Math.max(m, s.g), -Infinity)
      }
      const entries = [newValue, ...(perFrame.get(frame) ?? [])].slice(0, ENTRIES_PER_FRAME)
      perFrame.set(frame, entries)
      return stars
    },
    downloads: () => counter,
    count: () => {
      let zones = 0
      let stars = 0
      for (const entries of perFrame.values()) {
        zones += entries.length
        for (const v of entries) stars += v.stars.length
      }
      return { zones, stars }
    },
    clear: () => perFrame.clear()
  }
}
