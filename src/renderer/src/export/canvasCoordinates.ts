import type { Wcs } from '@shared/types'
import type { Crop } from '@core/export/crop'
import type { CaptionCorner } from '@core/export/caption'
import { coordinatesScene, type CoordinatesChoice } from '@core/astrometry/imageCoordinates'

/** Colours shared by canvas and SVG (CoordinatesLayer): faint grid, solid orientation and scale. */
export const COORDINATES_COLORS = {
  line: 'rgba(160, 225, 255, 0.38)',
  label: 'rgba(205, 240, 255, 0.92)',
  filled: 'rgba(255, 255, 255, 0.95)',
  halo: 'rgba(5, 8, 15, 0.85)'
}

/**
 * Draws the coordinates (grid, orientation, scale) on the exported image at
 * full resolution: the same scene as the viewer, with sizes that grow with
 * the file like those of the object markers.
 *
 * The solution refers to the whole image: the crop says which part ends up
 * in the file.
 */
export function drawCoordinates(
  ctx: OffscreenCanvasRenderingContext2D,
  finalWidth: number,
  finalHeight: number,
  wcs: Wcs,
  crop: Crop,
  choice: CoordinatesChoice,
  angle: CaptionCorner,
  /** File areas to keep free of labels (the caption). */
  reserved: { x0: number; y0: number; x1: number; y1: number }[] = []
): void {
  const k = finalWidth / 1000
  const body = Math.max(11, Math.round(13 * k))
  const thickness = Math.max(1, 1.2 * k)
  // The whole image in file pixels: the crop shows a part of it.
  const width = finalWidth / crop.width
  const height = finalHeight / crop.height
  const marks = coordinatesScene(
    wcs,
    {
      ox: -crop.x * width,
      oy: -crop.y * height,
      width,
      height,
      region: { x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height },
      body,
      angle,
      reserved
    },
    choice
  )

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, finalWidth, finalHeight)
  ctx.clip()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of marks) {
    if (s.type === 'segment') {
      const trace = (): void => {
        ctx.beginPath()
        s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.stroke()
      }
      if (!s.faint) {
        ctx.strokeStyle = COORDINATES_COLORS.halo
        ctx.lineWidth = thickness * 3
        trace()
      }
      ctx.strokeStyle = s.faint ? COORDINATES_COLORS.line : COORDINATES_COLORS.filled
      ctx.lineWidth = thickness
      trace()
    } else {
      const size = s.faint ? Math.round(body * 0.9) : body
      ctx.font = (s.faint ? '' : '600 ') + size + 'px sans-serif'
      ctx.textAlign = s.align === 'start' ? 'left' : s.align === 'end' ? 'right' : 'center'
      ctx.textBaseline = s.base
      ctx.lineWidth = Math.max(2, body * 0.22)
      ctx.strokeStyle = COORDINATES_COLORS.halo
      ctx.strokeText(s.text, s.x, s.y)
      ctx.fillStyle = s.faint ? COORDINATES_COLORS.label : COORDINATES_COLORS.filled
      ctx.fillText(s.text, s.x, s.y)
    }
  }
  ctx.restore()
}
