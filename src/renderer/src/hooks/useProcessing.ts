import { useCallback } from 'react'
import type { ImageData32, RecognizedObject, Wcs } from '@shared/types'
import { useApp } from '../store/appStore'
import {
  narrowbandActive,
  applyPlaneAmount,
  neutralProcessing,
  internalNeutralProcessing,
  chainColorGains,
  type FirstStageMeasurements,
  type ProcessingParams
} from '@core/image/chain'
import type { ExtractedBands } from '@core/image/narrowband'
import { reducePlaneNlBayes, reduceNoiseNlBayesInPlace, sigmaNlBayes } from '../workers/nlbayesParallel'
import { parallelWorkBudget } from '@core/memory'
import { deconvolveParallel } from '../workers/deconvolveParallel'
import type { ChainRequest, ChainResponse } from '../workers/chain.worker'
import { pluginEnvironmentFromState, runActivePlugins, type PluginEnvironment } from '../plugin/execution'
import {
  GEOMETRY_UNCHANGED,
  composeGeometry,
  orientQuarters,
  type AppliedGeometry,
  type Orientation
} from '@core/image/geometry'
import { rotateFreely } from './straighten'
import { buildProtectedZones } from '@core/image/trails'
import { t } from '@shared/i18n/i18n'

/**
 * Runs the processing chain (Process step and Abracadabra).
 *
 * It always starts from the original image. The first and third stages each
 * run in their own worker; NL-Bayes, in between, is spread over all cores.
 * The progress bar follows the three stages.
 */

export interface ProcessingResult {
  image: ImageData32
  parameters: ProcessingParams
  measurements: FirstStageMeasurements | null
  /**
   * How the plugins moved the pixels relative to the source image: used to
   * move the astrometric solution (markers, FITS) along with them. The
   * built-in tools never move anything.
   */
  geometry: AppliedGeometry
}

/**
 * Request buffers that can be transferred to the worker instead of copied.
 * The second and third stages receive intermediate images that are no
 * longer needed here once sent: transferring them saves a full-frame copy
 * per stage. The first stage starts from the original image, which the
 * application keeps: it receives a copy made in `stage` and transferred,
 * because a copy made by the message itself passes through an intermediate
 * one, a full frame more for a moment. Shared memory is not transferred (and
 * does not need to be: the worker already sees it). Either way the image
 * the worker receives is its own, and it works on it in place.
 */
function toTransfer(request: ChainRequest): ArrayBuffer[] {
  const buffer = new Set<ArrayBuffer>()
  const test = (a: Float32Array | undefined): void => {
    if (a && a.buffer instanceof ArrayBuffer && a.byteOffset === 0 && a.byteLength === a.buffer.byteLength) {
      buffer.add(a.buffer)
    }
  }
  test(request.image.data)
  test(request.bands?.ha)
  test(request.bands?.oiii)
  return [...buffer]
}

function stage(request: ChainRequest): Promise<ChainResponse> {
  return new Promise((solve) => {
    const worker = new Worker(new URL('../workers/chain.worker.ts', import.meta.url), {
      type: 'module',
      name: 'chain-' + request.stage
    })
    worker.onmessage = (e: MessageEvent<ChainResponse>): void => {
      worker.terminate()
      solve(e.data)
    }
    worker.onerror = (e): void => {
      worker.terminate()
      solve({ result: 'error', message: e.message })
    }
    const sent: ChainRequest =
      request.stage === 1 ? { ...request, image: { ...request.image, data: request.image.data.slice() } } : request
    worker.postMessage(sent, toTransfer(sent))
  })
}

/**
 * Where the chain runs: the source image and where to report progress and
 * notices. For the viewer these come from the application state (see
 * `runProcessing`); batch processing passes its own, so it works on a file
 * read from disk without touching the open image, the status bar or the
 * history (which follows precisely `job` in the state).
 */
export interface ProcessingEnvironment {
  /** Image the chain starts from. */
  original: ImageData32
  /** Label and progress, from 0 to 1. */
  progress: (label: string, fraction: number) => void
  /** Called at the end, however it went. */
  finish: () => void
  /** False if the result is no longer needed (another frame opened, batch stopped). */
  stillValid: () => boolean
  /** For plugins: progress, notices and stretch to pass to them. */
  plugin: PluginEnvironment
  /**
   * Recognized objects and astrometric solution of the source image:
   * satellite trails are not searched for inside galaxies and nebulae.
   */
  sky: { objects: RecognizedObject[]; pixelScale: number | null; wcs: Wcs | null }
  /**
   * Mirror and rotations to apply at the end. When absent, those requested
   * with the toolbar buttons for the open image are used.
   */
  orientation?: Orientation
}

/** Free memory reported by the system, or undefined if it cannot be read. */
async function freeMemory(): Promise<number | undefined> {
  try {
    const free = Number((await window.starlight.systemInfo()).freeRam)
    return Number.isFinite(free) && free > 0 ? free : undefined
  } catch {
    return undefined
  }
}

/** Runs the chain; returns null if another frame was opened in the meantime. */
export async function runProcessing(
  parameters: ProcessingParams,
  automatic: boolean,
  label: string
): Promise<ProcessingResult | null> {
  const state = useApp.getState()
  const original = state.originalImage ?? state.image
  if (!original) return null
  return runProcessingOn(
    {
      original,
      progress: state.setJob,
      finish: state.finishJob,
      stillValid: () => {
        const s = useApp.getState()
        return (s.originalImage ?? s.image) === original
      },
      plugin: pluginEnvironmentFromState(),
      sky: (() => {
        const active = state.frame.find((f) => f.id === state.activeFrameId) ?? null
        return {
          objects: state.objects,
          pixelScale: active?.metadata.pixelScale ?? null,
          wcs: active?.metadata.wcs ?? null
        }
      })()
    },
    parameters,
    automatic,
    label
  )
}

/**
 * Mirror and rotations requested with the toolbar buttons, in canonical order
 * (mirror, quarter turns, free rotation: see Orientation in
 * @core/image/geometry), applied at the end of every processing run.
 */
function orientAtEnd(
  environment: ProcessingEnvironment,
  image: ImageData32,
  geometry: AppliedGeometry
): { image: ImageData32; geometry: AppliedGeometry } {
  const s = useApp.getState()
  const o = environment.orientation ?? { mirrored: s.mirrored, quarters: s.rotation, degrees: s.freeRotation }
  const rotated = orientQuarters(image, o.mirrored, o.quarters)
  return rotateFreely(rotated.image, composeGeometry(geometry, rotated.step), o.degrees)
}

/**
 * The chain itself, on a given image. Returns null if, partway through,
 * `stillValid` says the result is no longer needed.
 */
export async function runProcessingOn(
  environment: ProcessingEnvironment,
  parameters: ProcessingParams,
  automatic: boolean,
  label: string
): Promise<ProcessingResult | null> {
  const { original, stillValid } = environment
  const setJob = environment.progress
  const finishJob = environment.finish

  if (!automatic && neutralProcessing(parameters)) {
    // Even with no active tools, the mirror and rotation requested in the viewer are kept.
    const free = orientAtEnd(environment, original, GEOMETRY_UNCHANGED)
    return { image: free.image, parameters, measurements: null, geometry: free.geometry }
  }

  // Plugins only: the built-in tools are off, so the three stages would
  // change nothing and the plugins start directly from the original.
  if (!automatic && internalNeutralProcessing(parameters)) {
    try {
      const result = await runActivePlugins(original, parameters, label, 0.05, stillValid, environment.plugin)
      if (!result) return null
      const free = orientAtEnd(environment, result.image, result.geometry)
      return { image: free.image, parameters, measurements: null, geometry: free.geometry }
    } finally {
      finishJob()
    }
  }

  try {
    setJob(t('hooksUseProcessing.progress.firstStage', { label }), 0.05)
    // Galaxies and nebulae located by the astrometric solution: satellite
    // trails must not be searched for inside them (see trails.ts). The object
    // positions describe the source image, which is exactly `original`.
    const { sky } = environment
    const zones = buildProtectedZones(sky.objects, sky.pixelScale, sky.wcs, original.width, original.height)
    const first = await stage({ stage: 1, image: original, parameters, automatic, protectedZones: zones })
    if (first.result === 'error') throw new Error(first.message)
    if (!stillValid()) return null
    let image = first.image
    let usedValues = first.parameters

    // From here to the third stage the image belongs to this function alone
    // (the first stage sent back its own): deconvolution and NL-Bayes write
    // into it instead of making new copies, which on large images weigh
    // hundreds of megabytes each. Both need the brightness of the whole
    // image: one plane serves both.
    let brightness: Float32Array | undefined
    const brightnessPlane = (): Float32Array => (brightness ??= new Float32Array(image.width * image.height))
    if (usedValues.deconvolution.iterations > 0) {
      setJob(t('hooksUseProcessing.progress.deconvolution', { label }), 0.2)
      const budget = parallelWorkBudget(image.data.byteLength, await freeMemory())
      image = await deconvolveParallel(
        image,
        usedValues.deconvolution,
        (f) => setJob(t('hooksUseProcessing.progress.deconvolution', { label }), 0.2 + f * 0.15),
        budget,
        brightnessPlane()
      )
      if (!stillValid()) return null
    }

    // Narrowband: H-alpha and OIII are separated here and NL-Bayes cleans
    // each one with its own noise level (see chain.ts). Without NL-Bayes the
    // third stage does the separation directly.
    const isNarrowband = narrowbandActive(usedValues) && image.channels === 3
    const colorGains = isNarrowband && first.measurements ? chainColorGains(usedValues, first.measurements) : undefined
    let bands: ExtractedBands | undefined

    if (usedValues.nlBayes > 0 && isNarrowband) {
      setJob(t('hooksUseProcessing.progress.bandSeparation', { label }), 0.35)
      const separated = await stage({ stage: 2, image, parameters: usedValues, automatic, colorGains })
      if (separated.result === 'error') throw new Error(separated.message)
      if (!separated.bands) throw new Error(t('hooksUseProcessing.bandSeparationFailed'))
      if (!stillValid()) return null
      image = separated.image
      const b = separated.bands
      const cleanBand = async (plane: Float32Array, from: number): Promise<Float32Array> => {
        const reduced = await reducePlaneNlBayes(plane, b.width, b.height, sigmaNlBayes(plane), (f) =>
          setJob(t('hooksUseProcessing.progress.noiseReduction', { label }), from + f * 0.2)
        )
        return applyPlaneAmount(plane, reduced, usedValues.nlBayes)
      }
      const ha = await cleanBand(b.ha, 0.38)
      if (!stillValid()) return null
      const oiii = await cleanBand(b.oiii, 0.58)
      if (!stillValid()) return null
      bands = { ...b, ha, oiii }
    } else if (usedValues.nlBayes > 0) {
      setJob(t('hooksUseProcessing.progress.noiseReduction', { label }), 0.35)
      await reduceNoiseNlBayesInPlace(
        image,
        usedValues.nlBayes,
        (f) => setJob(t('hooksUseProcessing.progress.noiseReduction', { label }), 0.35 + f * 0.4),
        brightnessPlane()
      )
      if (!stillValid()) return null
    }

    brightness = undefined
    setJob(t('hooksUseProcessing.progress.thirdStage', { label }), 0.78)
    const third = await stage({ stage: 3, image, parameters: usedValues, automatic, bands, colorGains })
    if (third.result === 'error') throw new Error(third.message)
    if (!stillValid()) return null
    usedValues = third.parameters

    // Additional tools: the plugins run after everything else, each in its
    // own isolated worker. A plugin that fails is skipped with a notice.
    const final = await runActivePlugins(third.image, usedValues, label, 0.9, stillValid, environment.plugin)
    if (!final) return null
    // Mirror and rotations requested with the viewer buttons come last:
    // every processing run restarts from the source image and must reapply them.
    const free = orientAtEnd(environment, final.image, final.geometry)
    return {
      image: free.image,
      parameters: usedValues,
      measurements: first.measurements ?? null,
      geometry: free.geometry
    }
  } finally {
    finishJob()
  }
}

/** Satellite trail outcome for the message, if the tool was on. */
function trailsText(parameters: ProcessingParams, measurements: FirstStageMeasurements | null): string {
  if (!parameters.trails.active || !measurements) return ''
  if (measurements.trails === 0) return ' ' + t('hooksUseProcessing.trails.none')
  return (
    ' ' +
    (measurements.trails === 1
      ? t('hooksUseProcessing.trails.one')
      : t('hooksUseProcessing.trails.other', { count: measurements.trails }))
  )
}

/** Applies the Process step parameters to the displayed image. */
export function useProcessing(): { apply: () => Promise<void> } {
  const apply = useCallback(async (): Promise<void> => {
    const state = useApp.getState()
    if (state.job.active) return
    const parameters = state.processing
    try {
      const result = await runProcessing(parameters, false, t('hooksUseProcessing.label'))
      if (!result) return
      useApp.getState().setProcessedImage(result.image, parameters, result.geometry)
      useApp
        .getState()
        .notify(
          'ok',
          neutralProcessing(parameters)
            ? t('hooksUseProcessing.noToolsActive')
            : t('hooksUseProcessing.applied') + trailsText(parameters, result.measurements)
        )
    } catch (error) {
      useApp
        .getState()
        .notify('error', t('hooksUseProcessing.failed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }, [])
  return { apply }
}
