import type { FileHandleInfo, FrameMetadata, ImageData32, RecognizedObject } from '@shared/types'
import { readFits } from '@core/fits/reader'
import { debayer } from '@core/image/debayer'
import { abracadabraProcessing } from '@core/image/chain'
import { abracadabraFinish, edgeTrimming, knownLinear, openingStretch } from '@core/image/abracadabraFinish'
import { cropDimensions, type Crop } from '@core/export/crop'
import { FORMATS } from '@core/export/encoding'
import { recognizeObjects } from '@core/catalog/recognition'
import { hasRawExtension } from '@core/raw/rawFormats'
import { finalMeasurements, outputName, cropPerFile, type Recipe } from '@core/recipe'
import { displayedAstrometry } from '../hooks/displayedAstrometry'
import { completeHeader, withObjectFromName } from '../hooks/fileHeader'
import { runProcessingOn } from '../hooks/useProcessing'
import { produceExport } from '../export/exportImage'
import { prepareRawInBrowser } from '../workers/libraw'
import { analysisWorkerPool } from '../workers/pool'
import type { Adjustments } from '../store/appStore'
import { captionChoice, readSettings } from '../settings'
import { collectCaptionData } from '@core/export/caption'
import { loadLogo } from '../export/starLightLogo'
import { t } from '@shared/i18n/i18n'

/**
 * Batch processing: the same recipe applied to several files, one after the
 * other, with one exported file for each.
 *
 * Every file goes through the same path as in the app: reading as on opening
 * (`readFits` and debayering, or LibRaw for RAW files), the Process step
 * chain (`runProcessingOn`), the Abracadabra finish if requested, then export
 * (`produceExport`). The result is therefore identical to what you would get
 * by opening the file, applying the recipe by hand and exporting.
 *
 * The image open in the app is not touched: the batch writes nothing into
 * the app state (neither the image, nor the adjustments, nor the job bar),
 * so it creates no history steps and does not mark the project as modified.
 * Only one file at a time is held in memory.
 */

export interface BatchProgress {
  /** Position of the file being processed, from 0. */
  index: number
  total: number
  fileName: string
  /** What is being done to the file. */
  phase: string
  /** How much of the file is done, from 0 to 1. */
  fileFraction: number
  /** Seconds left until the end of the batch, null until known. */
  secondsRemaining: number | null
}

export interface BatchFileResult {
  fileName: string
  sourcePath: string
  result: 'succeeded' | 'failed'
  /** Path of the written file. */
  path?: string
  /** Plain-language reason for the failure. */
  reason?: string
  /** Non-blocking notices (for example a skipped plugin). */
  notices: string[]
}

export interface BatchResult {
  file: BatchFileResult[]
  /** True if it was stopped before the end. */
  interrupted: boolean
  /** Files not yet started when it was stopped. */
  skipped: number
  seconds: number
}

/** Stop request: the batch finishes the current phase and stops. */
export interface BatchControl {
  interrupted: boolean
}

/** Image read from disk, as when opened in the app. */
interface LoadedFile {
  image: ImageData32
  metadata: FrameMetadata
  header: Record<string, string | number | boolean | null>
  /** Bits per value in the file (see `openingStretch`). */
  bitpix: number
}

class Interruption extends Error {}

/** Reads and decodes a file, along the same path as opening it in the app. */
export async function readBatchFile(f: FileHandleInfo): Promise<LoadedFile> {
  const buffer = await window.starlight.readFile(f.path)
  if (hasRawExtension(f.fileName)) {
    // Exposure data first: the worker then takes ownership of the buffer.
    await prepareRawInBrowser()
    const info = await completeHeader(new Uint8Array(buffer), f.path, f.fileName, f.sizeBytes)
    const r = await analysisWorkerPool().analyze({
      id: 'serie-' + f.path,
      path: f.path,
      buffer,
      withStars: false,
      fileName: f.fileName
    })
    if (r.result === 'error' || !r.data) throw new Error(r.message ?? t('batchRunBatch.rawReadFailed'))
    return {
      image: {
        width: r.width as number,
        height: r.height as number,
        channels: r.channels as 1 | 3,
        data: new Float32Array(r.data)
      },
      metadata: info.metadata,
      header: info.header.cards as Record<string, string | number | boolean | null>,
      bitpix: 16
    }
  }
  const readResult = readFits(new Uint8Array(buffer), f.fileName)
  const info = withObjectFromName(
    { header: readResult.header, metadata: readResult.metadata, width: readResult.image.width, height: readResult.image.height, bitpix: readResult.bitpix },
    f.fileName
  )
  return {
    image: debayer(readResult.image, readResult.metadata.bayer),
    metadata: info.metadata,
    header: info.header.cards as Record<string, string | number | boolean | null>,
    bitpix: readResult.bitpix
  }
}

/** A prepared file: the recipe's processing, adjustments and framing. */
export interface PreparedFile {
  /** Image after the Process step, ready for export. */
  image: ImageData32
  adjustments: Adjustments
  crop: Crop
  /** Objects and astrometric solution of the processed image (for markers and FITS). */
  objects: RecognizedObject[]
  wcs: FrameMetadata['wcs']
  pixelScale: number | null
}

/**
 * Applies the recipe to a file already read: Process chain (or Abracadabra),
 * adjustments and framing. Returns null if the batch was stopped midway.
 */
export async function prepareBatchFile(
  readResult: LoadedFile,
  recipe: Recipe<Adjustments>,
  control: BatchControl,
  progress: (phase: string, fraction: number) => void,
  notices: string[]
): Promise<PreparedFile | null> {
  const { image: original, metadata } = readResult
  // As when opening in the app: automatic stretch and objects recognised from
  // the exposure data.
  const openStretch = openingStretch(original, metadata, readResult.bitpix)
  const openedObjects = recognizeObjects(metadata)
  let adjustments: Adjustments = {
    ...recipe.adjustments,
    stretch: recipe.abracadabra || recipe.stretchPerFile ? openStretch : recipe.adjustments.stretch
  }

  const result = await runProcessingOn(
    {
      original,
      progress: (label, f) => progress(label.replace(/^[^:]*:\s*/, ''), f),
      finish: () => {},
      stillValid: () => !control.interrupted,
      plugin: {
        progress: (label, f) => progress(label.replace(/^[^:]*:\s*/, ''), f),
        notify: (_type, text) => notices.push(text),
        stretch: () => adjustments.stretch
      },
      sky: { objects: openedObjects, pixelScale: metadata.pixelScale, wcs: metadata.wcs },
      // Mirror and rotations from the bar apply to the open image, not to the batch.
      orientation: { mirrored: false, quarters: 0, degrees: 0 }
    },
    recipe.abracadabra ? abracadabraProcessing(readSettings().abracadabraStrength) : recipe.processing,
    recipe.abracadabra,
    recipe.abracadabra ? 'Abracadabra' : t('batchRunBatch.processing')
  )
  if (!result) return null

  let edges: Crop | null = null
  if (recipe.abracadabra) {
    const finish = abracadabraFinish(
      result.image,
      result.measurements,
      knownLinear(metadata),
      readResult.bitpix,
      readSettings().abracadabraStrength
    )
    adjustments = { ...adjustments, ...finish.adjustments }
    edges = finish.crop
  } else if (result.measurements) {
    // The edge measurements are always made by the first stage; they are
    // needed only if the recipe framing trims the noisy edges.
    edges = edgeTrimming(result.measurements)
  }

  // If a plugin rotated or mirrored the pixels, the solution and the objects
  // move with them, as in the viewer.
  const astro = displayedAstrometry(metadata.wcs, metadata.pixelScale, openedObjects, result.geometry)
  return {
    image: result.image,
    adjustments,
    crop: cropPerFile(recipe.framing, result.image.width, result.image.height, edges),
    objects: astro.objects,
    wcs: astro.wcs,
    pixelScale: astro.pixelScale
  }
}

/** Bytes of the exported file for a prepared file. */
export async function exportPreparedFile(
  p: PreparedFile,
  readResult: LoadedFile,
  recipe: Recipe<Adjustments>,
  progress: (phase: string, fraction: number) => void
): Promise<ArrayBuffer> {
  const e = recipe.exportSettings
  const portion = cropDimensions(p.crop, p.image.width, p.image.height)
  const measurements = finalMeasurements(portion.width, portion.height, e.width)
  // The caption chosen in the Export step, with this file's data.
  const caption = captionChoice()
  const logo = caption ? await loadLogo() : null
  return produceExport(
    p.image,
    p.adjustments,
    recipe.curves,
    {
      format: e.format,
      quality: e.quality,
      bit: e.bit,
      crop: p.crop,
      width: measurements.width,
      height: measurements.height,
      upscalingMethod: e.upscalingMethod,
      header: e.keepMetadata ? readResult.header : {},
      wcs: p.wcs,
      markers: e.withMarkers ? { objects: p.objects, pixelScale: p.pixelScale } : null,
      caption: caption
        ? {
            choice: caption,
            logo,
            data: collectCaptionData({
              metadata: readResult.metadata,
              header: readResult.header,
              objects: p.objects,
              crop: p.crop,
              integration: null,
              result: false,
              author: caption.author,
              place: caption.place
            })
          }
        : null
    },
    progress
  )
}

/** Readable reason for an error. */
function reasonFor(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.trim() !== '' ? text : t('batchRunBatch.unknownError')
}

/**
 * Runs the batch. `update` receives the progress; `control.interrupted` stops
 * the batch as soon as the current phase ends (the half-done file is not
 * written).
 */
export async function runBatch(
  file: FileHandleInfo[],
  recipe: Recipe<Adjustments>,
  destination: { folder: string; model: string },
  update: (a: BatchProgress) => void,
  control: BatchControl
): Promise<BatchResult> {
  const start = performance.now()
  const results: BatchFileResult[] = []
  // Duration of the finished files, to estimate the remaining time.
  let secondsDone = 0
  let finishedItems = 0
  const extension = FORMATS[recipe.exportSettings.format].extension

  for (let i = 0; i < file.length; i++) {
    if (control.interrupted) break
    const f = file[i]
    const fileStart = performance.now()
    const notices: string[] = []
    const estimate = (fraction: number): number | null => {
      const here = (performance.now() - fileStart) / 1000
      const perFile =
        finishedItems > 0 ? secondsDone / finishedItems : fraction > 0.15 ? here / fraction : null
      if (perFile === null) return null
      return Math.max(0, perFile * (file.length - i) - here)
    }
    // Never throws: it is also called from the compute workers. The chain
    // notices the stop request through stillValid.
    const phase = (text: string, fraction: number): void => {
      update({
        index: i,
        total: file.length,
        fileName: f.fileName,
        phase: text,
        fileFraction: fraction,
        secondsRemaining: estimate(fraction)
      })
    }

    try {
      phase(t('batchRunBatch.readingFile'), 0.01)
      const readResult = await readBatchFile(f)
      // The chain takes the middle part of the file's progress, the export
      // the last part.
      const prepared = await prepareBatchFile(
        readResult,
        recipe,
        control,
        (text, x) => phase(text, 0.05 + x * 0.75),
        notices
      )
      if (!prepared) throw new Interruption()
      const data = await exportPreparedFile(prepared, readResult, recipe, (text, x) =>
        phase(text.charAt(0).toLowerCase() + text.slice(1), 0.8 + x * 0.2)
      )
      if (control.interrupted) throw new Interruption()
      const name = outputName(destination.model, f.fileName, readResult.metadata.object, i + 1) + '.' + extension
      const path = await window.starlight.writeBatchFile(destination.folder, name, data)
      results.push({ fileName: f.fileName, sourcePath: f.path, result: 'succeeded', path, notices })
    } catch (e) {
      if (e instanceof Interruption || control.interrupted) {
        control.interrupted = true
        break
      }
      results.push({ fileName: f.fileName, sourcePath: f.path, result: 'failed', reason: reasonFor(e), notices })
    }
    secondsDone += (performance.now() - fileStart) / 1000
    finishedItems++
    // Let the interface breathe between one file and the next.
    await new Promise((r) => setTimeout(r, 0))
  }

  return {
    file: results,
    interrupted: control.interrupted,
    skipped: file.length - results.length,
    seconds: (performance.now() - start) / 1000
  }
}
