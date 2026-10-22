import type { RecognizedObject, Wcs } from '@shared/types'
import type { Crop } from '@core/export/crop'
import { markerPreferences } from '../settings'
import {
  filterMarkerTypes,
  chooseMarkers,
  circleRadius,
  objectEllipsePixels,
  markerEllipse,
  type MarkerCandidate,
  type DrawingEllipse
} from '@core/catalog/crowding'

/**
 * Draws the object markers on the exported image at full resolution, with
 * the same look as the viewer: thin white circle (or oriented ellipse, for
 * elongated galaxies), short vertical tick and name. Sizes grow with the
 * final resolution, so they stay visible even on a large export.
 *
 * Positions are normalised to the original image: they are mapped through
 * the crop (in fractions) and the final size. Objects outside the crop, or
 * whose name would cross the edge, are not drawn.
 */
export function drawMarkers(
  ctx: OffscreenCanvasRenderingContext2D,
  finalWidth: number,
  finalHeight: number,
  objects: RecognizedObject[],
  crop: Crop,
  pixelScaleArcsec: number | null,
  originalWidth: number,
  /** Astrometric solution of the original image: orients the ellipses. */
  wcs: Wcs | null = null
): void {
  const k = finalWidth / 1000
  const fontPx = Math.max(11, Math.round(13 * k))
  const thickness = Math.max(1, 1.2 * k)
  const white = 'rgba(255,255,255,0.9)'
  const halo = 'rgba(5,8,15,0.85)'

  ctx.font = fontPx + 'px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'

  // Final image pixels per original pixel.
  const effExport = finalWidth / (crop.width * originalWidth)

  const marks: (MarkerCandidate & { ellipseShape: DrawingEllipse; yOuter: number; yInner: number })[] = []
  for (const o of objects) {
    if (!o.position) continue
    const relX = (o.position.x - crop.x) / crop.width
    const relY = (o.position.y - crop.y) / crop.height
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) continue

    const cx = relX * finalWidth
    const cy = relY * finalHeight
    // Oriented ellipse for elongated galaxies, circle for everything else.
    const ellipseShape = markerEllipse(
      objectEllipsePixels(o.object, pixelScaleArcsec, wcs),
      effExport,
      6 * k,
      16 * k,
      finalWidth * 0.3,
      16 * k
    )
    const radius = ellipseShape.rx

    // The tick starts at the ellipse edge and rises past its highest point,
    // as in the viewer.
    const dash = 15 * k
    const top = ellipseShape.halfHeight
    const above = cy - top - dash - fontPx > 0
    const yOuter = above ? cy - top - dash : cy + top + dash
    const yInner = above ? cy - ellipseShape.chord : cy + ellipseShape.chord
    const yText = above ? yOuter - 4 * k : yOuter + fontPx

    // The name must not cross the image edges.
    const halfNameWidth = ctx.measureText(o.object.id).width / 2 + 3
    const nameInside =
      cx - halfNameWidth >= 0 &&
      cx + halfNameWidth <= finalWidth &&
      yText - fontPx >= 0 &&
      yText <= finalHeight
    marks.push({ object: o, cx, cy, radius, ellipseShape, yText, yOuter, yInner, nameInside })
  }

  // Anti-crowding filter at the final size: the same rule as the viewer (see
  // crowding.ts), with the hidden types and density chosen in the Objects
  // panel.
  const preferences = markerPreferences()
  const allowed = new Set(filterMarkerTypes(objects, preferences.hidden))
  const choice = chooseMarkers(
    marks.filter((s) => allowed.has(s.object)),
    finalWidth,
    finalHeight,
    {
      limits: { x0: 0, y0: 0, x1: finalWidth, y1: finalHeight },
      textBody: fontPx,
      textMeasurer: (t) => ctx.measureText(t).width,
      density: preferences.density
    }
  )

  // Isolated excluded objects: a small circle without a name.
  ctx.lineWidth = thickness
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  for (const c of choice.unnamed) {
    ctx.beginPath()
    ctx.arc(c.cx, c.cy, circleRadius(c.radius, fontPx), 0, Math.PI * 2)
    ctx.stroke()
  }

  for (const m of choice.withName) {
    const { cx, cy, ellipseShape, yText, yOuter, yInner } = m.candidate
    ctx.lineWidth = thickness
    ctx.strokeStyle = white
    ctx.beginPath()
    ctx.ellipse(cx, cy, ellipseShape.rx, ellipseShape.ry, ellipseShape.angle, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx, yOuter)
    ctx.lineTo(cx, yInner)
    ctx.stroke()

    // Name with a dark halo for readability.
    ctx.lineWidth = Math.max(2, 3 * k)
    ctx.strokeStyle = halo
    ctx.strokeText(m.text, cx, yText)
    ctx.fillStyle = '#fff'
    ctx.fillText(m.text, cx, yText)
  }
}
