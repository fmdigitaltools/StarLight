import { NEUTRAL_CURVES, type Curves } from '@core/image/curve'
import { NEUTRAL_PROCESSING, type ProcessingParams } from '@core/image/chain'
import { FORMATS } from '@core/export/encoding'
import { FULL_CROP, ASPECT_RATIOS, clampCrop, centeredCrop, fullCrop, type Crop } from '@core/export/crop'
import { proportionalHeight, type UpscalingMethod } from '@core/export/resize'
import {
  readCurves,
  readProcessing,
  cleanName,
  merge,
  reservedNameSuffix
} from '@core/project'
import { t } from '@shared/i18n/i18n'

/**
 * Batch processing recipes.
 *
 * A recipe is everything applied to an image to get to the exported file:
 * the Process step parameters (plugins included), the Correct and Filters
 * adjustments, the curves, the framing and the export choices. It is saved
 * as a `.recipe` file (JSON text) and reopened; missing or corrupt fields
 * take their neutral value, as in projects, so a recipe written by an
 * earlier version still opens.
 *
 * With "Abracadabra on every file" the Process parameters and the stretch
 * are not fixed: each image is measured as the Abracadabra button would do.
 * With files that differ from one another this is usually the best choice.
 *
 * This module holds only the pure part (from recipe to text and back, file
 * names, framing), so it can be tested without the user interface.
 */

export const RECIPE_SIGNATURE = 'StarLight recipe'
export const RECIPE_VERSION = 1
export const RECIPE_EXTENSION = 'recipe'

export type RecipeFormat = keyof typeof FORMATS

/**
 * Framing of the exported file:
 * - `full`: the whole image;
 * - `edges`: removes the noisy edges measured on each file;
 * - `aspect-ratio`: centered box with the chosen aspect ratio;
 * - `fixed`: the same crop, in fractions, for all files (meaningful only
 *   for files with the same framing).
 */
export type FramingMode = 'full' | 'edges' | 'aspect-ratio' | 'fixed'

export interface RecipeExport {
  format: RecipeFormat
  /** Quality of lossy formats, from 40 to 100. */
  quality: number
  /** Bits per channel: TIFF 8 or 16, FITS 16 or 32; other formats 8. */
  bit: 8 | 16 | 32
  /** File width in pixels; 0 keeps the image width. */
  width: number
  upscalingMethod: UpscalingMethod
  /** FITS: copies the keywords of the source file. */
  keepMetadata: boolean
  /** PNG, JPEG, WebP: draws the markers of the recognized objects. */
  withMarkers: boolean
}

export interface Recipe<R extends object> {
  name: string
  /** Measures each image as the Abracadabra button does. */
  abracadabra: boolean
  /** Process step parameters (ignored with Abracadabra). */
  processing: ProcessingParams
  adjustments: R
  /**
   * Fixed recipe: black point, midtones and white point recomputed on each
   * file with the automatic stretch, as when an image is opened. Keeping
   * them fixed makes sense only for very similar files.
   */
  stretchPerFile: boolean
  curves: Curves
  framing: { mode: FramingMode; aspectRatio: string; crop: Crop }
  exportSettings: RecipeExport
}

export const DEFAULT_EXPORT: RecipeExport = {
  format: 'png',
  quality: 92,
  bit: 8,
  width: 0,
  upscalingMethod: 'edge-directed',
  keepMetadata: true,
  withMarkers: false
}

/** New recipe: Abracadabra on every file, full-resolution PNG. */
export function defaultRecipe<R extends object>(neutralAdjustments: R): Recipe<R> {
  return {
    name: 'Abracadabra',
    abracadabra: true,
    processing: NEUTRAL_PROCESSING,
    adjustments: neutralAdjustments,
    stretchPerFile: true,
    curves: NEUTRAL_CURVES,
    framing: { mode: 'edges', aspectRatio: 'original', crop: FULL_CROP },
    exportSettings: DEFAULT_EXPORT
  }
}

/** Bit depths allowed for each format; the first is the default. */
export function allowedBits(format: RecipeFormat): (8 | 16 | 32)[] {
  if (format === 'tiff') return [16, 8]
  if (format === 'fits') return [16, 32]
  return [8]
}

/** Brings the bit depth back within those allowed by the format. */
export function validBits(format: RecipeFormat, bit: number): 8 | 16 | 32 {
  const allowed = allowedBits(format)
  return allowed.includes(bit as 8 | 16 | 32) ? (bit as 8 | 16 | 32) : allowed[0]
}

/** Turns the recipe into the text to write to the file. */
export function serializeRecipe<R extends object>(recipe: Recipe<R>, appVersion: string): string {
  return JSON.stringify(
    { format: RECIPE_SIGNATURE, version: RECIPE_VERSION, appVersion, ...recipe },
    null,
    2
  )
}

/** Read error with a message ready to show. */
export class RecipeError extends Error {}

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const MODES: FramingMode[] = ['full', 'edges', 'aspect-ratio', 'fixed']

/** Reads the text of a `.recipe` file. */
export function readRecipe<R extends object>(text: string, neutralAdjustments: R): Recipe<R> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RecipeError(t('coreRecipe.errors.corrupt'))
  }
  if (!object(raw) || raw['format'] !== RECIPE_SIGNATURE) {
    throw new RecipeError(t('coreRecipe.errors.notRecipe'))
  }
  const version = raw['version']
  if (typeof version !== 'number' || version > RECIPE_VERSION) {
    throw new RecipeError(t('coreRecipe.errors.newerVersion'))
  }

  const base = defaultRecipe(neutralAdjustments)
  const savedFraming = merge(base.framing, raw['framing'])
  const savedExport = merge(DEFAULT_EXPORT, raw['exportSettings'])
  const format: RecipeFormat = savedExport.format in FORMATS ? savedExport.format : 'png'
  return {
    name: typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : t('coreRecipe.defaultName'),
    abracadabra: raw['abracadabra'] !== false,
    processing: readProcessing(raw['processing']),
    adjustments: merge(neutralAdjustments, raw['adjustments']),
    stretchPerFile: raw['stretchPerFile'] !== false,
    curves: readCurves(raw['curves']),
    framing: {
      mode: MODES.includes(savedFraming.mode) ? savedFraming.mode : 'full',
      aspectRatio: ASPECT_RATIOS.some((p) => p.id === savedFraming.aspectRatio) ? savedFraming.aspectRatio : 'original',
      crop: clampCrop(savedFraming.crop)
    },
    exportSettings: {
      format,
      quality: Math.min(100, Math.max(40, Math.round(savedExport.quality))),
      bit: validBits(format, savedExport.bit),
      width: Math.max(0, Math.round(savedExport.width)),
      upscalingMethod: savedExport.upscalingMethod === 'lanczos' ? 'lanczos' : 'edge-directed',
      keepMetadata: savedExport.keepMetadata,
      withMarkers: savedExport.withMarkers
    }
  }
}

/**
 * Box to export for an image of the batch. `edges` are those measured by
 * the processing chain (null if there are no measurements: everything is
 * kept).
 */
export function cropPerFile(
  framing: Recipe<object>['framing'],
  width: number,
  height: number,
  edges: Crop | null
): Crop {
  switch (framing.mode) {
    case 'edges':
      return edges ?? FULL_CROP
    case 'aspect-ratio': {
      const p = ASPECT_RATIOS.find((x) => x.id === framing.aspectRatio)
      return p && p.ratio !== null ? centeredCrop(width, height, p.ratio) : FULL_CROP
    }
    case 'fixed':
      return fullCrop(framing.crop) ? FULL_CROP : framing.crop
    default:
      return FULL_CROP
  }
}

/** Dimensions of the final file: those of the cropped portion, or the chosen width. */
export function finalMeasurements(
  widthFraction: number,
  heightFraction: number,
  chosenWidth: number
): { width: number; height: number } {
  if (chosenWidth <= 0) return { width: widthFraction, height: heightFraction }
  return {
    width: chosenWidth,
    height: proportionalHeight(widthFraction, heightFraction, chosenWidth)
  }
}

/** Default template for the names of the produced files. */
export const MODEL_NAME = '{nome}_starlight'

/**
 * Name of the produced file, without extension. In the template `{nome}`
 * is the source file name without extension, `{oggetto}` the imaged object
 * (empty if unknown), `{n}` the sequence number in the batch. The result is
 * cleaned of characters that file systems do not accept.
 */
export function outputName(model: string, fileName: string, imagedObject: string | null, number: number): string {
  const name = fileName.replace(/\.(fz|gz)$/i, '').replace(/\.[^.]+$/, '')
  const text = (model.trim() === '' ? MODEL_NAME : model)
    .split('{nome}')
    .join(name)
    .split('{oggetto}')
    .join((imagedObject ?? '').replace(/\s+/g, ''))
    .split('{n}')
    .join(String(number).padStart(3, '0'))
  // cleanName is meant for project folders: the suffix it adds to names
  // reserved by Windows is not needed here.
  const cleanedName = cleanName(text)
  const suffix = reservedNameSuffix()
  const cleaned = cleanedName.endsWith(suffix) ? cleanedName.slice(0, -suffix.length) + '_' : cleanedName
  return cleaned !== '' ? cleaned : cleanName(name) || t('coreRecipe.defaultFileName')
}

/** Name of the default subfolder: "Batch 2026-10-17". */
export function batchSubfolder(now: Date = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return t('coreRecipe.batchSubfolder', {
    date: now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate())
  })
}

/** Remaining time in plain words. */
export function timeText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 50) return t('coreRecipe.time.underMinute')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return minutes === 1 ? t('coreRecipe.time.aboutOneMinute') : t('coreRecipe.time.aboutMinutes', { minutes })
  }
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (remainder === 0) {
    return hours === 1 ? t('coreRecipe.time.aboutOneHour') : t('coreRecipe.time.aboutHours', { hours })
  }
  return hours === 1
    ? t('coreRecipe.time.aboutOneHourMinutes', { minutes: remainder })
    : t('coreRecipe.time.aboutHoursMinutes', { hours, minutes: remainder })
}
