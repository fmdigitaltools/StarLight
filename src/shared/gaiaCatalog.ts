/**
 * Errors of the online Gaia catalog query (src/main/gaiaCatalog.ts), shared
 * by the main process and the renderer.
 *
 * The main process sends a code, not a sentence: the text is chosen where it
 * is shown, in the interface language and for the feature that asked (color
 * calibration or plate solving).
 */

import { t } from './i18n/i18n'

/** Why the catalog could not be queried. */
export type GaiaFailure =
  | { code: 'invalid-coordinates' }
  /** No service responded; `details` lists each service and its problem. */
  | { code: 'no-response'; details: string }

/** Reply of the main process to a catalog request. */
export type GaiaReply<Star> = { ok: true; stars: Star[] } | { ok: false; failure: GaiaFailure }

/** Feature that queried the catalog, which changes the explanation. */
export type GaiaUse = 'color-calibration' | 'plate-solving'

/** Text of a catalog failure, in the current language. */
export function gaiaFailureText(failure: GaiaFailure, use: GaiaUse = 'color-calibration'): string {
  switch (failure.code) {
    case 'invalid-coordinates':
      return t('mainGaiaCatalog.invalidCoordinates')
    case 'no-response':
      return use === 'plate-solving'
        ? t('mainGaiaCatalog.noResponseSolve', { details: failure.details })
        : t('mainGaiaCatalog.noResponse', { details: failure.details })
  }
}

/** Error carrying the failure code; its message is the color calibration text. */
export class GaiaCatalogError extends Error {
  readonly failure: GaiaFailure

  constructor(failure: GaiaFailure) {
    super(gaiaFailureText(failure))
    this.name = 'GaiaCatalogError'
    this.failure = failure
  }
}
