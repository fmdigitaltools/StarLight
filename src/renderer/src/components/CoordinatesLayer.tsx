import { useMemo, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { useViewerCrop } from '../hooks/viewerCrop'
import { useViewerCaption } from '../hooks/viewerCaption'
import { layoutPerFile } from '../export/canvasCaption'
import type { ImageData32, Wcs } from '@shared/types'
import type { ViewerGL } from '../gpu/viewerGL'
import {
  toolsCorner,
  noCoordinates,
  coordinatesScene,
  type CoordinateMark
} from '@core/astrometry/imageCoordinates'
import { coordinatesChoice, captionChoice, useSettings } from '../settings'
import { COORDINATES_COLORS } from '../export/canvasCoordinates'

/**
 * Coordinates over the image (grid, orientation, scale bar), drawn as SVG.
 * The scene comes from core/astrometry/imageCoordinates.ts, the same one
 * that export/canvasCoordinates.ts draws into the exported file.
 */

const BASE_SVG = { top: 'hanging', middle: 'central', bottom: 'auto' } as const

/** Renders the scene as SVG, with font size and stroke width in viewBox units. */
export function CoordinateMarks({
  marks,
  body,
  thickness
}: {
  marks: CoordinateMark[]
  body: number
  thickness: number
}): JSX.Element {
  return (
    <g className="sl-coordinates">
      {marks.map((s, i) =>
        s.type === 'segment' ? (
          <g key={i}>
            {/* Orientation and scale bar get a dark halo so they stay legible over bright nebulae. */}
            {s.faint ? null : (
              <polyline
                points={s.points.map((p) => p.x + ',' + p.y).join(' ')}
                fill="none"
                stroke={COORDINATES_COLORS.halo}
                strokeWidth={thickness * 3}
                strokeLinecap="round"
              />
            )}
            <polyline
              points={s.points.map((p) => p.x + ',' + p.y).join(' ')}
              fill="none"
              stroke={s.faint ? COORDINATES_COLORS.line : COORDINATES_COLORS.filled}
              strokeWidth={thickness}
              strokeLinecap="round"
            />
          </g>
        ) : (
          <text
            key={i}
            x={s.x}
            y={s.y}
            fill={s.faint ? COORDINATES_COLORS.label : COORDINATES_COLORS.filled}
            fontSize={s.faint ? body * 0.9 : body}
            fontWeight={s.faint ? 400 : 600}
            textAnchor={s.align}
            dominantBaseline={BASE_SVG[s.base]}
            style={{ paintOrder: 'stroke', stroke: COORDINATES_COLORS.halo, strokeWidth: body * 0.22 }}
          >
            {s.text}
          </text>
        )
      )}
    </g>
  )
}

/**
 * Viewer layer: follows zoom and pan like the object markers and is limited
 * to the visible part of the photo.
 */
export function CoordinatesLayer({
  gl,
  image,
  zoom,
  pan,
  wcs
}: {
  gl: ViewerGL | null
  image: ImageData32 | null
  zoom: number
  pan: { x: number; y: number }
  wcs: Wcs | null
}): JSX.Element | null {
  // Choices from the Objects step: changing them redraws the layer.
  useSettings()
  const choice = coordinatesChoice()
  // The caption previewed in the viewer by the Export step, with the same
  // layout as CaptionLayer: labels must not overlap it.
  const preview = useViewerCaption((s) => s.preview)
  const cropStore = useApp((s) => s.crop)
  const cropInProgress = useViewerCrop((s) => s.inProgress)
  const crop = cropInProgress ?? cropStore
  const boxShape =
    image && crop.width > 0 ? (crop.height * image.height) / (crop.width * image.width) : 0
  const layout = useMemo(() => {
    if (!preview || !(boxShape > 0)) return null
    const height = Math.max(1, Math.round(preview.width * boxShape))
    return layoutPerFile(preview.data, preview.choice, preview.width, height)
  }, [preview, boxShape])
  if (!gl || !image || !wcs || noCoordinates(choice)) return null
  const displayWidth = gl.screenWidth
  const displayHeight = gl.screenHeight
  if (displayWidth === 0 || displayHeight === 0) return null

  const eff = zoom === 0 ? gl.fitZoom() : zoom
  const photoW = image.width * eff
  const photoH = image.height * eff
  const photoX = displayWidth / 2 + pan.x - photoW / 2
  const photoY = displayHeight / 2 + pan.y - photoH / 2
  // Part of the photo inside the view, normalized.
  const region = {
    x0: Math.max(0, -photoX / photoW),
    y0: Math.max(0, -photoY / photoH),
    x1: Math.min(1, (displayWidth - photoX) / photoW),
    y1: Math.min(1, (displayHeight - photoY) / photoH)
  }
  if (region.x1 <= region.x0 || region.y1 <= region.y0) return null

  const body = 12
  const reserved: { x0: number; y0: number; x1: number; y1: number }[] = []
  if (layout !== null && layout.area.width > 0) {
    const k = (crop.width * photoW) / layout.width
    const a = layout.area
    const x = photoX + crop.x * photoW + a.x * k
    const y = photoY + crop.y * photoH + a.y * k
    reserved.push({ x0: x, y0: y, x1: x + a.width * k, y1: y + a.height * k })
  }
  const marks = coordinatesScene(
    wcs,
    {
      ox: photoX,
      oy: photoY,
      width: photoW,
      height: photoH,
      region,
      body,
      // While a caption is being previewed it takes precedence; otherwise the saved choice.
      angle: toolsCorner(preview?.choice ?? captionChoice()),
      reserved
    },
    choice
  )
  if (marks.length === 0) return null
  return (
    <svg className="sl-viewer-layer" viewBox={`0 0 ${displayWidth} ${displayHeight}`} preserveAspectRatio="none">
      <defs>
        <clipPath id="sl-clip-coordinates">
          <rect x={photoX} y={photoY} width={photoW} height={photoH} />
        </clipPath>
      </defs>
      <g clipPath="url(#sl-clip-coordinates)">
        <CoordinateMarks marks={marks} body={body} thickness={1} />
      </g>
    </svg>
  )
}
