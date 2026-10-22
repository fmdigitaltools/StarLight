import type { ImageData32, RecognizedObject, Wcs } from '@shared/types'
import type { Curves } from '@core/image/curve'
import { applyCorrections } from '@core/export/processing'
import { resize, type UpscalingMethod } from '@core/export/resize'
import { encodeWithCanvas, encodeTiff, encodeBmp, encodeFits, FORMATS } from '@core/export/encoding'
import { computeStats } from '@core/image/stats'
import { effectiveFilter } from '@core/image/photoFilters'
import { cropRegion, cropRectangle, fullCrop, exportedWcs, type Crop } from '@core/export/crop'
import type { Adjustments } from '../store/appStore'
import { prepareLocals, type LocalLayer } from '@core/image/masks'
import type { AppliedGeometry } from '@core/image/geometry'
import { drawMarkers } from './canvasMarkers'
import { drawCoordinates } from './canvasCoordinates'
import { toolsCorner, noCoordinates, type CoordinatesChoice } from '@core/astrometry/imageCoordinates'
import { applyCaption, type CaptionLogo } from './canvasCaption'
import { captionAllowed, type CaptionData, type CaptionChoice } from '@core/export/caption'
import { t } from '@shared/i18n/i18n'

/**
 * From the image (already through the Process step) to the file to write:
 * full-resolution corrections, crop, resize, encoding.
 *
 * It is the same path for the Export image button and for batch processing:
 * a batch file and the manual export of the same file with the same recipe
 * are identical byte for byte.
 */

export type ExportFormatOption = keyof typeof FORMATS

export interface ExportOptions {
  format: ExportFormatOption
  /** Quality of lossy formats, from 40 to 100. */
  quality: number
  /**
   * Bits per channel: TIFF 8 or 16, FITS 16 or 32 (floating point). If
   * missing, the value given in FORMATS applies.
   */
  bit?: 8 | 16 | 32
  /** Portion to export, in fractions of the image. */
  crop: Crop
  /** Dimensions of the final file. */
  width: number
  height: number
  upscalingMethod: UpscalingMethod
  /** Keywords of the source FITS file to keep (FITS only). */
  header: Record<string, string | number | boolean | null>
  /** Astrometric solution of the image (FITS and markers only). */
  wcs: Wcs | null
  /** Object markers to draw (PNG, JPEG, WebP), or null. */
  markers: { objects: RecognizedObject[]; pixelScale: number | null } | null
  /**
   * Grid, orientation and scale to draw (PNG, JPEG, WebP), or null. They
   * require the astrometric solution `wcs`.
   */
  coordinates?: CoordinatesChoice | null
  /**
   * Local adjustments of the image, with the geometry needed to locate the
   * masks; absent for batch processing, where every file is a different
   * image.
   */
  locals?: { levels: LocalLayer[]; geometry: AppliedGeometry } | null
  /**
   * Caption with the exposure data, or null. It applies only to display
   * formats (PNG, JPEG, WebP, TIFF, BMP): in FITS the image stays untouched
   * (see core/export/caption.ts).
   */
  caption?: { data: CaptionData; choice: CaptionChoice; logo: CaptionLogo } | null
}

/** Channel medians, used by sky background removal. */
export function skyBackground(image: ImageData32): [number, number, number] {
  const n = image.width * image.height
  if (image.channels === 1) {
    const m = computeStats(image.data.subarray(0, n)).median
    return [m, m, m]
  }
  return [
    computeStats(image.data.subarray(0, n)).median,
    computeStats(image.data.subarray(n, 2 * n)).median,
    computeStats(image.data.subarray(2 * n, 3 * n)).median
  ]
}

/** Lets the progress bar render before a long computation. */
function yieldToUi(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Produces the bytes of the exported file. */
export async function produceExport(
  image: ImageData32,
  adjustments: Adjustments,
  curves: Curves,
  options: ExportOptions,
  progress: (label: string, fraction: number) => void = () => {}
): Promise<ArrayBuffer> {
  const { format, crop } = options
  progress(t('exportExportImage.applyingCorrections'), 0.2)
  await yieldToUi(30)
  // The same masks as the viewer, at full resolution (stars, if needed and
  // not yet detected, are detected now).
  const locals = options.locals ? prepareLocals(options.locals.levels, image, options.locals.geometry) : null

  let result = applyCorrections(image, {
    stretch: adjustments.stretch,
    brightness: adjustments.brightness,
    contrast: adjustments.contrast,
    saturation: adjustments.saturation,
    redGain: adjustments.redGain,
    greenGain: adjustments.greenGain,
    blueGain: adjustments.blueGain,
    gamma: adjustments.gamma,
    noiseReduction: adjustments.noiseReduction,
    sharpness: adjustments.sharpness,
    backgroundNeutralization: adjustments.backgroundNeutralization,
    skyBackground: skyBackground(image),
    preserveColor: adjustments.preserveColor,
    ghs: adjustments.withGhs ? adjustments.ghs : undefined,
    // The tone curves, as in the viewer: without them the exported file
    // would be darker and flatter than what is shown.
    curves,
    // The same filter shown in the viewer is reapplied here on the
    // full-resolution data, with the manual vibrance and vignette.
    filter: effectiveFilter(
      adjustments.filter,
      adjustments.filterIntensity,
      adjustments.vibrance,
      adjustments.vignette
    ),
    // The vignette is centred on the exported box.
    vignetteBox: crop,
    locals
  })

  // Cropping comes before resizing: only what will actually be saved is
  // scaled.
  if (!fullCrop(crop)) {
    progress(t('exportExportImage.cropping'), 0.4)
    await yieldToUi(20)
    result = cropRegion(result, crop)
  }

  if (options.width !== result.width || options.height !== result.height) {
    progress(t('exportExportImage.resizing', { width: options.width }), 0.5)
    await yieldToUi(30)
    result = resize(result, options.width, options.height, options.upscalingMethod)
  }

  // The caption, only in display formats: it is blended into the photo,
  // inside its frame, and the file dimensions do not change. Its box is kept
  // free of coordinate labels.
  const reserved: { x0: number; y0: number; x1: number; y1: number }[] = []
  if (options.caption && captionAllowed(format)) {
    const { data, choice, logo } = options.caption
    const { area } = applyCaption(result, data, choice, logo)
    if (area.width > 0 && area.height > 0)
      reserved.push({ x0: area.x, y0: area.y, x1: area.x + area.width, y1: area.y + area.height })
  }

  progress(t('exportExportImage.writing', { format: FORMATS[format].name }), 0.8)
  await yieldToUi(30)

  if (format === 'tiff') return encodeTiff(result, options.bit === 8 ? 8 : 16)
  if (format === 'bmp') return encodeBmp(result)
  if (format === 'fits') {
    // The astrometric solution of the image (including that of a mosaic or
    // a drizzle), shifted by the crop and scaled by the resize: the file
    // stays measurable and objects are found in the right place. It reveals
    // nothing personal, so it is written even when metadata is not kept. If
    // a plugin rotated or mirrored the pixels, the caller passes it already
    // transformed; if it moved them without saying how, it is omitted
    // entirely (better no solution than a wrong one).
    const portion = cropRectangle(crop, image.width, image.height)
    return encodeFits(result, options.header, options.bit === 32 ? 32 : 16, {
      wcs: exportedWcs(options.wcs, image.width, image.height, crop, result.width, result.height),
      upscaling: [result.width / portion.width, result.height / portion.height]
    })
  }
  const markers = options.markers
  const withMarkers = markers !== null && markers.objects.length > 0
  const wcs = options.wcs
  const coordinates = options.coordinates && wcs !== null && !noCoordinates(options.coordinates) ? options.coordinates : null
  // Orientation and scale away from the caption, if present.
  const angle = toolsCorner(options.caption && captionAllowed(format) ? options.caption.choice : null)
  return encodeWithCanvas(
    result,
    FORMATS[format].mime,
    options.quality,
    withMarkers || coordinates !== null
      ? (ctx, w, h) => {
          // Coordinates first, then markers: object names stay above the lines.
          if (coordinates !== null && wcs !== null) drawCoordinates(ctx, w, h, wcs, crop, coordinates, angle, reserved)
          if (withMarkers && markers !== null)
            drawMarkers(ctx, w, h, markers.objects, crop, markers.pixelScale, image.width, wcs)
        }
      : undefined
  )
}
