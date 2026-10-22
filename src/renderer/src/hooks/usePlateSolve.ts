import { useCallback, useState } from 'react'
import type { FrameMetadata, LoadedFrame } from '@shared/types'
import { useApp } from '../store/appStore'
import { detectStars } from '@core/stars/detection'
import { searchByName, recognizeObjects } from '@core/catalog/recognition'
import { fieldEstimate, SOLVER_DETECTION } from '@core/astrometry/solver'
import { solveWithSources, explainLocalReason, type SolveStep } from '@core/astrometry/solveSources'
import { noInternetNotice, internetAllowed, writeSettings } from '../settings'
import { gaiaCache } from '../gaiaStars'
import { excludedStars } from '@shared/protectionTexts'
import { updateInstalled } from '../catalogs/registry'
import { t, formatDecimal } from '@shared/i18n/i18n'
import { GaiaCatalogError, gaiaFailureText } from '@shared/gaiaCatalog'

/**
 * Local stars from the main process. If the package cannot be read, the main
 * process excludes it for the session and sends its name and the problem
 * (marker "[stars-excluded]"): here the user is notified, the gallery is
 * refreshed and the error is rethrown, so plate solving continues with Gaia.
 */
async function protectedLocalStars(
  ra: number,
  dec: number,
  radius: number,
  magnitude: number
): ReturnType<typeof window.starlight.localStars> {
  try {
    return await window.starlight.localStars(ra, dec, radius, magnitude)
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    const i = text.indexOf('[stars-excluded]')
    if (i >= 0) {
      try {
        const { name, problem } = JSON.parse(text.slice(i + '[stars-excluded]'.length)) as { name: string; problem: string }
        useApp.getState().notify('warning', excludedStars(name, problem))
      } catch {
        // Unparseable text: the generic plate solving explanation remains.
      }
      void updateInstalled()
    }
    throw e
  }
}

/**
 * Plate solving from the stars, for files whose header carries no
 * astrometric solution.
 *
 * It starts from where the file says the telescope was pointing and looks
 * for a match between the image stars and those of a catalog around that
 * point. If the local star package is installed (catalog gallery) it is tried
 * first, offline; if that is not enough, stars are requested from the online
 * Gaia catalog, but only if internet access is allowed (the decision is in
 * solveSources.ts). With internet off no connection is made: a notice
 * explains why the local catalog was not enough and offers a button to
 * re-enable internet and retry.
 *
 * The solution found goes into the frame metadata, as if it had been written
 * in the header: from then on markers and color calibration use it.
 */

/** Gives the viewer time to show progress before a heavy computation. */
const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

/**
 * Why the frame cannot be plate solved, in plain words; null if solving can
 * be attempted.
 */
export function unsolvableReason(frame: LoadedFrame | null): string | null {
  if (!frame) return t('hooksUsePlateSolve.openFrame')
  if (fieldEstimate(frame.metadata, frame.width, frame.height, searchByName) === null) {
    return t('hooksUsePlateSolve.noStartingPoint')
  }
  return null
}

/** Progress label and fraction of the running job for each step. */
function label(step: SolveStep): [string, number] {
  switch (step.phase) {
    case 'gaia-request':
      return [t('hooksUsePlateSolve.job.gaiaRequest'), 0.3]
    case 'matching':
      return step.source === 'local'
        ? [t('hooksUsePlateSolve.job.matchingLocal'), 0.25]
        : [t('hooksUsePlateSolve.job.matchingGaia'), 0.85]
  }
}

/**
 * Plate solves the active frame. `withInProgress` signals start and end to
 * the panel; the same function is rerun by the re-enable internet button.
 */
async function solveActiveFrame(withInProgress: (v: boolean) => void): Promise<void> {
  const state = useApp.getState()
  const image = state.originalImage ?? state.image
  const frame = state.frame.find((f) => f.id === state.activeFrameId)
  if (!image || !frame) return
  const W = image.width
  const H = image.height
  const equinox = frame.header.cards['EQUINOX']
  const estimate = fieldEstimate(
    frame.metadata,
    W,
    H,
    searchByName,
    typeof equinox === 'number' ? equinox : null
  )
  if (!estimate) {
    state.notify('warning', unsolvableReason(frame) ?? t('hooksUsePlateSolve.cannotSolve'))
    return
  }
  // If another frame is opened in the meantime, the result is no longer needed.
  const stillValid = (): boolean => {
    const s = useApp.getState()
    return s.activeFrameId === frame.id && (s.originalImage ?? s.image) === image
  }
  // Notice button: turns internet on only when clicked, then retries on the same frame.
  const reenableInternet = {
    label: t('hooksUsePlateSolve.reenableInternet'),
    run: (): void => {
      void writeSettings({ internet: true }).then(() => {
        const s = useApp.getState()
        if (s.activeFrameId === frame.id) void solveActiveFrame(withInProgress)
        else s.notify('info', t('hooksUsePlateSolve.internetReenabled'))
      })
    }
  }

  // Gaia stars are kept in the cache shared with photometry.
  const request = { ra: estimate.ra, dec: estimate.dec, radius: estimate.radius, magnitude: estimate.magnitude }

  withInProgress(true)
  try {
    state.setJob(t('hooksUsePlateSolve.job.detectingStars'), 0.05)
    await yieldToUi()
    const stars = detectStars(image, SOLVER_DETECTION)
    if (stars.length < 15) {
      useApp
        .getState()
        .notify('warning', t('hooksUsePlateSolve.tooFewStars', { count: stars.length }))
      return
    }

    const solveResult = await solveWithSources(stars, estimate, W, H, {
      locals: (ra, dec, radius, magnitude) => protectedLocalStars(ra, dec, radius, magnitude),
      gaiaInMemory: () => gaiaCache.alreadyAvailable(frame.id, request),
      gaia: () => gaiaCache.stars(frame.id, request),
      internetAllowed,
      advance: async (step) => {
        const [text, share] = label(step)
        useApp.getState().setJob(text, share)
        await yieldToUi()
      }
    })
    if (!stillValid()) return

    if (!solveResult.ok) {
      const explanation = explainLocalReason(solveResult.localReason, solveResult.localStarsInField)
      if (solveResult.reason === 'offline') {
        useApp
          .getState()
          .notify(
            'warning',
            explanation === null
              ? t('hooksUsePlateSolve.offlineNoLocal', {
                  notice: noInternetNotice(t('hooksUsePlateSolve.gaiaFeature'))
                })
              : t('hooksUsePlateSolve.offlineWithExplanation', { explanation }),
            reenableInternet
          )
        return
      }
      useApp
        .getState()
        .notify(
          'warning',
          explanation !== null && solveResult.localReason !== 'unrecognized'
            ? t('hooksUsePlateSolve.noMatchWithExplanation', { explanation })
            : t('hooksUsePlateSolve.noMatch')
        )
      return
    }

    const result = solveResult.result
    // The solution goes into the frame metadata, as if it were in the header,
    // together with the true scale (the header scale is doubled on some
    // stacked files).
    const metadata: FrameMetadata = { ...frame.metadata, wcs: result.wcs, pixelScale: result.scale }
    useApp.setState((s) => ({
      frame: s.frame.map((f) => (f.id === frame.id ? { ...f, metadata } : f))
    }))
    useApp.getState().setObjects(recognizeObjects(metadata))
    useApp
      .getState()
      .notify('ok', solvedMessage(solveResult.source === 'local', result))
  } catch (error) {
    // A Gaia catalog failure gets the explanation for plate solving; other
    // errors passing through the main process lose their technical prefix.
    const text =
      error instanceof GaiaCatalogError
        ? gaiaFailureText(error.failure, 'plate-solving')
        : (error instanceof Error ? error.message : String(error)).replace(
            /^Error invoking remote method '[^']*': (Error: )?/,
            ''
          )
    useApp.getState().notify('error', text)
  } finally {
    useApp.getState().finishJob()
    withInProgress(false)
  }
}

/** Success message for a solved field. */
function solvedMessage(
  local: boolean,
  result: { matchedStars: number; residualArcsec: number; scale: number; rotation: number; mirrored: boolean }
): string {
  const params = {
    stars: result.matchedStars,
    residual: formatDecimal(result.residualArcsec, 1),
    scale: formatDecimal(result.scale, 2),
    rotation: formatDecimal(result.rotation, 0)
  }
  if (local) {
    return result.mirrored
      ? t('hooksUsePlateSolve.solvedLocalMirrored', params)
      : t('hooksUsePlateSolve.solvedLocal', params)
  }
  return result.mirrored
    ? t('hooksUsePlateSolve.solvedGaiaMirrored', params)
    : t('hooksUsePlateSolve.solvedGaia', params)
}

export function usePlateSolve(): { solve: () => Promise<void>; inProgress: boolean } {
  const [inProgress, setInProgress] = useState(false)
  const solve = useCallback((): Promise<void> => solveActiveFrame(setInProgress), [])
  return { solve, inProgress }
}
