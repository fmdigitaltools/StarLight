import {
  solveField,
  type SolutionResult,
  type ImageStar,
  type CatalogStar,
  type FieldEstimate
} from './solver'
import { expectedStarsInField } from './localStars'
import { t } from '@shared/i18n/i18n'

/**
 * Choice of the reference stars for plate solving.
 *
 * If the local star package is installed (UCAC4 catalog down to magnitude
 * 12), it is tried first: it needs no internet and is much faster than a
 * Gaia catalog query. If the local stars are not enough, the online Gaia
 * catalog is used, but only if internet access is allowed or the stars of
 * that area are already cached: with internet off no connection is made,
 * and the caller explains why the local catalog was not enough.
 *
 * The local stars are not enough in two cases:
 *   - narrow field: the image contains few stars down to magnitude 12
 *     (fewer than MIN_LOCAL_STARS), too few to recognize their pattern; the
 *     attempt is skipped right away;
 *   - matching finds no correspondence, for example because nearly all the
 *     stars visible in the image are fainter.
 *
 * The module is pure: the caller passes the functions that read the stars
 * (from the main process in the app, from files or fakes in tests).
 */

/** Expected local catalog stars inside the image below which no attempt is made. */
export const MIN_LOCAL_STARS = 20

export type StarSource = 'local' | 'gaia'

/** Why the local stars were not used. */
export type LocalReason =
  /** Package not installed or disabled. */
  | 'missing'
  /** Too few local stars inside the framed field. */
  | 'narrow-field'
  /** Matching against the local stars found no correspondence. */
  | 'unrecognized'
  /** The star file could not be read. */
  | 'error'

export interface StarSources {
  /** Local stars in the requested circle; null if the package is not installed or enabled. */
  locals: (
    ra: number,
    dec: number,
    radius: number,
    magnitude: number
  ) => Promise<{ stars: CatalogStar[]; limitMagnitude: number } | null>
  /** True if the Gaia stars of that area are already cached (no internet needed). */
  gaiaInMemory: () => boolean
  /** Gaia stars in the estimated area (from the cache or the network). */
  gaia: () => Promise<CatalogStar[]>
  /** True if the user allows internet connections. */
  internetAllowed: () => boolean
  /** Called at each step, to show progress. */
  advance?: (step: SolveStep) => Promise<void> | void
}

export type SolveStep =
  | { phase: 'matching'; source: StarSource }
  | { phase: 'gaia-request' }

export type SolveResult =
  | {
      ok: true
      result: SolutionResult
      source: StarSource
      /** When Gaia was reached, why the local stars were not enough. */
      localReason: LocalReason | null
    }
  | {
      ok: false
      /**
       * 'offline': the local stars were not enough (or are missing) and
       * internet is off; 'unrecognized': no source gave a convincing
       * solution.
       */
      reason: 'offline' | 'unrecognized'
      localReason: LocalReason
      /** Expected local stars inside the image, if computed. */
      localStarsInField: number | null
      /** Last source matched against, null if none. */
      triedSource: StarSource | null
    }

/**
 * Solves the field, choosing the source. `estimate` is the starting point
 * derived from the header (fieldEstimate); width and height are the
 * image's. Gaia network errors propagate to the caller.
 */
export async function solveWithSources(
  stars: ImageStar[],
  estimate: FieldEstimate,
  width: number,
  height: number,
  sources: StarSources
): Promise<SolveResult> {
  const parameters = { width, height, ra: estimate.ra, dec: estimate.dec, scale: estimate.scale }
  let localReason: LocalReason = 'missing'
  let expected: number | null = null
  let triedSource: StarSource | null = null

  // --- Local stars ---
  let locals: { stars: CatalogStar[]; limitMagnitude: number } | null = null
  try {
    locals = await sources.locals(estimate.ra, estimate.dec, estimate.radius, estimate.magnitude)
  } catch {
    localReason = 'error'
  }
  if (locals) {
    if (estimate.scale !== null) {
      expected = expectedStarsInField(locals.stars, estimate.ra, estimate.dec, width, height, estimate.scale)
    }
    if (expected !== null && expected < MIN_LOCAL_STARS) {
      localReason = 'narrow-field'
    } else {
      await sources.advance?.({ phase: 'matching', source: 'local' })
      triedSource = 'local'
      const result = solveField(stars, locals.stars, parameters)
      if (result) return { ok: true, result, source: 'local', localReason: null }
      localReason = 'unrecognized'
    }
  }

  // --- Online Gaia catalog ---
  if (!sources.gaiaInMemory() && !sources.internetAllowed()) {
    return { ok: false, reason: 'offline', localReason, localStarsInField: expected, triedSource }
  }
  if (!sources.gaiaInMemory()) await sources.advance?.({ phase: 'gaia-request' })
  const catalog = await sources.gaia()
  await sources.advance?.({ phase: 'matching', source: 'gaia' })
  const result = solveField(stars, catalog, parameters)
  if (result) return { ok: true, result, source: 'gaia', localReason }
  return { ok: false, reason: 'unrecognized', localReason, localStarsInField: expected, triedSource: 'gaia' }
}

/**
 * Why the local stars were not enough, as a sentence to show; null if the
 * package is not installed.
 */
export function explainLocalReason(reason: LocalReason, starsInField: number | null): string | null {
  switch (reason) {
    case 'missing':
      return null
    case 'narrow-field':
      return starsInField !== null
        ? t('coreSolveSources.narrowFieldCount', { count: Math.round(starsInField) })
        : t('coreSolveSources.narrowFieldFew')
    case 'unrecognized':
      return t('coreSolveSources.unrecognized')
    case 'error':
      return t('coreSolveSources.error')
  }
}
