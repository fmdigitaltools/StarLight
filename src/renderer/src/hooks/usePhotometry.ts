import { useCallback, useState } from 'react'
import { useApp } from '../store/appStore'
import {
  matchStars,
  calibrateColor,
  catalogField,
  filterFromHeader
} from '@core/image/photometry'
import { noInternetNotice, internetAllowed, readSettings } from '../settings'
import { gaiaCache } from '../gaiaStars'
import { formatDecimal, t } from '@shared/i18n/i18n'

/**
 * Photometric color calibration: downloads the field stars from the Gaia
 * catalog, matches them to the stars in the image using the astrometric
 * solution in the header, and computes the gains of the three channels that
 * give each star its true color. The gains are stored in the Process step
 * parameters.
 */
export function usePhotometry(): { compute: () => Promise<void>; inProgress: boolean } {
  const [inProgress, setInProgress] = useState(false)

  const compute = useCallback(async (): Promise<void> => {
    const state = useApp.getState()
    const image = state.originalImage ?? state.image
    const frame = state.frame.find((f) => f.id === state.activeFrameId)
    if (!image || !frame) return
    const wcs = frame.metadata.wcs
    if (!wcs) {
      state.notify('warning', t('hooksUsePhotometry.noWcs'))
      return
    }
    // Gaia stars live in the cache shared with plate solving: if plate
    // solving already downloaded them (down to at least the magnitude in the
    // settings) they are not requested again. Raising the magnitude in the
    // settings downloads them again.
    const request = { ...catalogField(wcs), magnitude: readSettings().gaiaMagnitude }
    const alreadyInMemory = gaiaCache.alreadyAvailable(frame.id, request)
    if (!alreadyInMemory && !internetAllowed()) {
      state.notify('warning', noInternetNotice(t('hooksUsePhotometry.internetFeature')))
      return
    }
    setInProgress(true)
    state.setJob(
      alreadyInMemory ? t('hooksUsePhotometry.progress.cached') : t('hooksUsePhotometry.progress.requesting'),
      0.2
    )
    try {
      const catalog = await gaiaCache.stars(frame.id, request)
      state.setJob(t('hooksUsePhotometry.progress.measuring'), 0.8)
      const filter = filterFromHeader(frame.metadata.filter)
      const stars = matchStars(image, wcs, catalog)
      const result = calibrateColor(image, stars, filter)
      if (result.usedStars < 8) {
        useApp.getState().notify('warning', t('hooksUsePhotometry.tooFewStars'))
        return
      }
      useApp.getState().setProcessing({ photometricGains: result.gains })
      useApp.getState().notify(
        'ok',
        t('hooksUsePhotometry.done', {
          count: result.usedStars,
          deviation: formatDecimal(result.deviation * 100, 0)
        })
      )
    } catch (error) {
      useApp
        .getState()
        .notify('error', error instanceof Error ? error.message : String(error))
    } finally {
      useApp.getState().finishJob()
      setInProgress(false)
    }
  }, [])

  return { compute, inProgress }
}
