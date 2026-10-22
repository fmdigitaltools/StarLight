import { createGaiaCache, type GaiaCache } from '@core/astrometry/gaiaCache'
import { GaiaCatalogError } from '@shared/gaiaCatalog'

/**
 * The single cache of downloaded Gaia stars, shared by plate solving and
 * photometric calibration (the logic lives in `@core/astrometry/gaiaCache`).
 * Callers first check with `alreadyAvailable` whether internet access is
 * needed: if the answer is already cached, they proceed even when the
 * internet permission setting is off.
 *
 * A catalog failure arrives from the main process as a code and is rethrown
 * here as a GaiaCatalogError, whose text each caller can adapt.
 */
export const gaiaCache: GaiaCache = createGaiaCache(async (ra, dec, radius, magnitude) => {
  const reply = await window.starlight.gaiaStars(ra, dec, radius, magnitude)
  if (!reply.ok) throw new GaiaCatalogError(reply.failure)
  return reply.stars
})
