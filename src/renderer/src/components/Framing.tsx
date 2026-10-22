import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { resize } from '@core/export/resize'
import { applyCorrections } from '@core/export/processing'
import { toRgba8 } from '@core/export/encoding'
import { effectiveFilter } from '@core/image/photoFilters'
import { computeStats } from '@core/image/stats'
import { clampCrop } from '@core/export/crop'
import { chooseMarkers, circleRadius, objectEllipsePixels, markerEllipse } from '@core/catalog/crowding'
import { useDisplayedAstrometry } from '../hooks/displayedAstrometry'
import { useViewerCrop } from '../hooks/viewerCrop'
import { filterMarkerTypes } from '@core/catalog/crowding'
import { markerPreferences, useSettings } from '../settings'
import type { CaptionData, CaptionLayout, CaptionChoice } from '@core/export/caption'
import { drawCaption, layoutPerFile } from '../export/canvasCaption'
import { useStarLightLogo } from '../export/starLightLogo'
import { toolsCorner, coordinatesScene, type CoordinatesChoice } from '@core/astrometry/imageCoordinates'
import { CoordinateMarks } from './CoordinatesLayer'
import { t } from '@shared/i18n/i18n'

/**
 * Framing selection.
 *
 * Shows a small version of the image with the crop box on top, which can be
 * dragged with the mouse. The thumbnail is computed once per image and then
 * only re-corrected, because downscaling a two-megapixel frame on every
 * cursor movement would be needlessly expensive.
 */

const THUMBNAIL_WIDTH = 268

/** Caption preview canvas pixels per screen pixel. */
const PREVIEW_DENSITY = 2

/**
 * Caption preview: the same layout as the final file, drawn small over the
 * crop box, inside the photo as in the file.
 */
function CaptionPreview({
  layout,
  cssWidth
}: {
  layout: CaptionLayout
  cssWidth: number
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const logo = useStarLightLogo()
  const finalHeight = layout.height
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || cssWidth <= 0) return
    const scale = (cssWidth * PREVIEW_DENSITY) / layout.width
    canvas.width = Math.max(1, Math.round(layout.width * scale))
    canvas.height = Math.max(1, Math.round(finalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    drawCaption(ctx, layout, logo)
  }, [layout, cssWidth, finalHeight, logo])
  return (
    <canvas
      ref={canvasRef}
      className="sl-framing-caption"
      style={{ aspectRatio: layout.width + ' / ' + finalHeight }}
    />
  )
}

export function Framing({
  showMarkers = false,
  coordinates = null,
  caption = null,
  finalDimensions = null
}: {
  showMarkers?: boolean
  /** Grid, orientation and scale to show as they will appear in the file, or null. */
  coordinates?: CoordinatesChoice | null
  /** Caption to show as it will appear in the file, or null. */
  caption?: { data: CaptionData; choice: CaptionChoice } | null
  /** Dimensions of the exported file. */
  finalDimensions?: { width: number; height: number } | null
}): JSX.Element | null {
  const image = useApp((s) => s.image)
  const adjustments = useApp((s) => s.adjustments)
  const curves = useApp((s) => s.curves)
  // While dragging in the viewer the new box is not yet in the store (it
  // becomes a history step on release): the thumbnail follows it anyway.
  const cropStore = useApp((s) => s.crop)
  const cropInProgress = useViewerCrop((s) => s.inProgress)
  const crop = cropInProgress ?? cropStore
  const setCrop = useApp((s) => s.setCrop)
  // Solution and positions of the displayed image (rotated or mirrored by a
  // plugin, if applicable), not of the original one.
  const { objects, pixelScale, wcs } = useDisplayedAstrometry()
  // Marker density and types: changing them redraws the preview.
  useSettings()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ active: boolean; dxPercent: number; dyPercent: number } | null>(null)
  const [moving, setMoving] = useState(false)
  const [cssWidth, setCssWidth] = useState(0)

  // On-screen width of the thumbnail, to draw the caption preview at the
  // right density.
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observe = new ResizeObserver(() => setCssWidth(el.clientWidth))
    observe.observe(el)
    setCssWidth(el.clientWidth)
    return () => observe.disconnect()
  }, [image])

  // The same layout as the file: same entries, same proportions.
  const layout = useMemo(
    () =>
      caption && finalDimensions
        ? layoutPerFile(caption.data, caption.choice, finalDimensions.width, finalDimensions.height)
        : null,
    [caption, finalDimensions]
  )

  // Image downscaling: the expensive step, done only once.
  const thumbnail = useMemo(() => {
    if (!image) return null
    const height = Math.max(
      1,
      Math.round((image.height * THUMBNAIL_WIDTH) / image.width)
    )
    return resize(image, THUMBNAIL_WIDTH, height)
  }, [image])

  // Corrections on the thumbnail take only a few milliseconds.
  const correctedThumbnail = useMemo(() => {
    if (!thumbnail) return null
    const n = thumbnail.width * thumbnail.height
    const median = computeStats(thumbnail.data.subarray(0, n)).median
    return applyCorrections(thumbnail, {
      stretch: adjustments.stretch,
      brightness: adjustments.brightness,
      contrast: adjustments.contrast,
      saturation: adjustments.saturation,
      redGain: adjustments.redGain,
      greenGain: adjustments.greenGain,
      blueGain: adjustments.blueGain,
      gamma: adjustments.gamma,
      // Noise reduction and sharpening are not visible at this size and
      // would cost a convolution on every change.
      noiseReduction: 0,
      sharpness: 0,
      backgroundNeutralization: adjustments.backgroundNeutralization,
      skyBackground: [median, median, median],
      preserveColor: adjustments.preserveColor,
      ghs: adjustments.withGhs ? adjustments.ghs : undefined,
      curves,
      filter: effectiveFilter(
        adjustments.filter,
        adjustments.filterIntensity,
        adjustments.vibrance,
        adjustments.vignette
      ),
      // As in the exported file: the vignette follows the crop box.
      vignetteBox: crop
    })
  }, [thumbnail, adjustments, curves, crop])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !correctedThumbnail) return
    canvas.width = correctedThumbnail.width
    canvas.height = correctedThumbnail.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const pixel = toRgba8(correctedThumbnail) as Uint8ClampedArray<ArrayBuffer>
    ctx.putImageData(new ImageData(pixel, correctedThumbnail.width, correctedThumbnail.height), 0, 0)
  }, [correctedThumbnail])

  const moveTo = useCallback(
    (clientX: number, clientY: number): void => {
      const container = containerRef.current
      const state = drag.current
      if (!container || !state) return

      const area = container.getBoundingClientRect()
      const current = useApp.getState().crop
      const x = (clientX - area.left) / area.width - state.dxPercent
      const y = (clientY - area.top) / area.height - state.dyPercent

      setCrop(clampCrop({ ...current, x, y }))
    },
    [setCrop]
  )

  useEffect(() => {
    function move(e: MouseEvent): void {
      if (drag.current?.active) moveTo(e.clientX, e.clientY)
    }
    function release(): void {
      if (drag.current) {
        drag.current = null
        setMoving(false)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', release)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', release)
    }
  }, [moveTo])

  if (!image || !correctedThumbnail) return null

  function press(e: React.MouseEvent): void {
    const container = containerRef.current
    if (!container) return
    const area = container.getBoundingClientRect()
    const pointerX = (e.clientX - area.left) / area.width
    const pointerY = (e.clientY - area.top) / area.height

    // Offset between the grabbed point and the box corner, so the box does
    // not jump under the pointer.
    drag.current = {
      active: true,
      dxPercent: pointerX - crop.x,
      dyPercent: pointerY - crop.y
    }
    setMoving(true)
  }

  const boxStyle = {
    left: (crop.x * 100).toFixed(3) + '%',
    top: (crop.y * 100).toFixed(3) + '%',
    width: (crop.width * 100).toFixed(3) + '%',
    height: (crop.height * 100).toFixed(3) + '%'
  }

  const boxCssWidth = cssWidth * crop.width

  return (
    <div
      className={'sl-framing' + (moving ? ' sl-moving' : '')}
      ref={containerRef}
      onMouseDown={press}
      title={t('framing.dragHint')}
    >
      <canvas ref={canvasRef} className="sl-framing-canvas" />
      <div className="sl-framing-veil" />
      <div className="sl-framing-box" style={boxStyle}>
        <span className="sl-corner sl-corner-tl" />
        <span className="sl-corner sl-corner-tr" />
        <span className="sl-corner sl-corner-bl" />
        <span className="sl-corner sl-corner-br" />
      </div>
      {layout !== null ? (
        <div
          className="sl-framing-caption-layer"
          style={boxStyle}
        >
          <CaptionPreview layout={layout} cssWidth={boxCssWidth} />
        </div>
      ) : null}
      {coordinates !== null && wcs !== null && finalDimensions !== null ? (
        <svg
          className="sl-framing-markers"
          viewBox={`0 0 ${correctedThumbnail.width} ${correctedThumbnail.height}`}
          preserveAspectRatio="none"
        >
          {(() => {
            const mw = correctedThumbnail.width
            const mh = correctedThumbnail.height
            // Same proportions as the file: the file's text size (see
            // export/canvasCoordinates.ts) scaled down to the thumbnail, with
            // a minimum to stay readable.
            const fileBody = Math.max(11, Math.round((13 * finalDimensions.width) / 1000))
            const body = Math.max(5, (fileBody * mw * crop.width) / finalDimensions.width)
            // The caption box, mapped from the file to the thumbnail.
            const reserved: { x0: number; y0: number; x1: number; y1: number }[] = []
            if (layout !== null && layout.area.width > 0) {
              const k = (crop.width * mw) / layout.width
              const a = layout.area
              const x = crop.x * mw + a.x * k
              const y = crop.y * mh + a.y * k
              reserved.push({ x0: x, y0: y, x1: x + a.width * k, y1: y + a.height * k })
            }
            const marks = coordinatesScene(
              wcs,
              {
                ox: 0,
                oy: 0,
                width: mw,
                height: mh,
                region: { x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height },
                body,
                angle: toolsCorner(caption?.choice ?? null),
                reserved
              },
              coordinates
            )
            return <CoordinateMarks marks={marks} body={body} thickness={Math.max(0.5, body / 11)} />
          })()}
        </svg>
      ) : null}
      {showMarkers ? (
        <svg
          className="sl-framing-markers"
          viewBox={`0 0 ${correctedThumbnail.width} ${correctedThumbnail.height}`}
          preserveAspectRatio="none"
        >
          {(() => {
            const mw = correctedThumbnail.width
            const mh = correctedThumbnail.height
            const scale = mw / image.width
            const candidates = objects
              .filter((o) => o.position !== null)
              .map((o) => {
                const p = o.position as { x: number; y: number }
                const cx = p.x * mw
                const cy = p.y * mh
                const ellipseShape = markerEllipse(
                  objectEllipsePixels(o.object, pixelScale, wcs),
                  scale,
                  2,
                  4,
                  mw * 0.4,
                  6
                )
                const radius = ellipseShape.rx
                const top = ellipseShape.halfHeight
                const yText = cy - top - 3 > 9 ? cy - top - 3 : cy + top + 9
                const halfNameWidth = o.object.id.length * 2.6
                const nameInside = !(cx - halfNameWidth < 0 || cx + halfNameWidth > mw || yText - 8 < 0 || yText > mh)
                return { object: o, cx, cy, radius, ellipse: ellipseShape, yText, nameInside }
              })
            // Same crowding rule as the viewer and the export.
            const preferences = markerPreferences()
            const allowed = new Set(filterMarkerTypes(objects, preferences.hidden))
            const choice = chooseMarkers(
              candidates.filter((c) => allowed.has(c.object)),
              mw,
              mh,
              {
                limits: { x0: 0, y0: 0, x1: mw, y1: mh },
                textBody: 8,
                textMeasurer: (t) => t.length * 5.2,
                density: preferences.density
              }
            )
            return (
              <>
                {choice.unnamed.map((c) => (
                  <circle key={c.object.object.id} cx={c.cx} cy={c.cy} r={circleRadius(c.radius, 8)} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={0.8} />
                ))}
                {choice.withName.map(({ candidate: c, text }) => (
                  <g key={c.object.object.id}>
                    <ellipse
                      cx={c.cx}
                      cy={c.cy}
                      rx={c.ellipse.rx}
                      ry={c.ellipse.ry}
                      transform={`rotate(${(c.ellipse.angle * 180) / Math.PI} ${c.cx} ${c.cy})`}
                      fill="none"
                      stroke="rgba(255,255,255,0.92)"
                      strokeWidth={0.8}
                    />
                    <text x={c.cx} y={c.yText} fill="#fff" fontSize={8} textAnchor="middle" style={{ paintOrder: 'stroke', stroke: 'rgba(5,8,15,0.85)', strokeWidth: 2 }}>
                      {text}
                    </text>
                  </g>
                ))}
              </>
            )
          })()}
        </svg>
      ) : null}
    </div>
  )
}
