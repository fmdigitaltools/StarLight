import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp, NEUTRAL_ADJUSTMENTS } from '../store/appStore'
import { useViewerCrop } from '../hooks/viewerCrop'
import { useStraighten } from '../hooks/straighten'
import { StraightenViewer } from './StraightenViewer'
import { ViewerGL } from '../gpu/viewerGL'
import { Empty, Button, Label } from './Controls'
import { ImportIcon, FolderIcon } from './Icons'
import galaxySvg from '../assets/galaxy.svg?raw'
import { useLibrary } from '../hooks/useLibrary'
import { imageSkyBackground } from '@core/image/skyBackground'
import { NEUTRAL_FILTER, effectiveFilter } from '@core/image/photoFilters'
import { NEUTRAL_CURVES, buildLut, neutralCurves } from '@core/image/curve'
import { autoStretch } from '@core/image/stretch'
import { buildGhsLut } from '@core/image/ghs'
import { Histogram } from './Histogram'
import type { RecognizedObject, ImageData32, Wcs } from '@shared/types'
import {
  chooseMarkers,
  circleRadius,
  objectEllipsePixels,
  markerEllipse,
  filterMarkerTypes
} from '@core/catalog/crowding'
import { DetectedStars } from './DetectedStars'
import { reducedMotionActive, markerPreferences, useSettings } from '../settings'
import { useDisplayedAstrometry } from '../hooks/displayedAstrometry'
import { NucleusMarker, pointFromScreen } from './NucleusMarker'
import { useCometNucleus } from '../hooks/cometNucleus'
import { useComparison } from '../hooks/comparison'
import { useLocalAdjustmentsInViewer } from '../hooks/viewerMasks'
import { MasksLayer } from './MasksLayer'
import { CropLayer } from './CropLayer'
import { CaptionLayer } from './CaptionLayer'
import { CoordinatesLayer } from './CoordinatesLayer'
import '../styles/shortcuts.css'
import { t } from '@shared/i18n/i18n'

/**
 * Redraws on size changes of both the window and the canvas itself (when the
 * side drawer opens and narrows the available area). Kept outside Viewer on
 * purpose: a listener created inside it would capture the whole render scope,
 * image included, and keep the pixels of a closed image alive.
 */
function useRedrawOnResize(canvasRef: React.RefObject<HTMLCanvasElement | null>, generation: number): void {
  useEffect(() => {
    function redraw(): void {
      useApp.setState((s) => ({ pan: { ...s.pan } }))
    }
    window.addEventListener('resize', redraw)
    const canvas = canvasRef.current
    let observer: ResizeObserver | null = null
    if (canvas && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(redraw)
      observer.observe(canvas)
    }
    return () => {
      window.removeEventListener('resize', redraw)
      observer?.disconnect()
    }
  }, [canvasRef, generation])
}

export function Viewer(): JSX.Element {
  const glRef = useRef<ViewerGL | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragState = useRef<{ active: boolean; x: number; y: number } | null>(null)
  // Where the button was pressed: tells a click apart from a drag.
  const clickStart = useRef<{ x: number; y: number } | null>(null)
  // Point under the cursor at the last wheel step, so the zoom centers on it.
  const zoomAnchor = useRef<{ mx: number; my: number } | null>(null)

  const image = useApp((s) => s.image)
  const adjustments = useApp((s) => s.adjustments)
  const zoom = useApp((s) => s.zoom)
  const pan = useApp((s) => s.pan)
  // Solution and positions for the displayed image: if a plugin rotated
  // or mirrored it, the markers follow.
  const astrometry = useDisplayedAstrometry()
  const objects = astrometry.objects
  const curves = useApp((s) => s.curves)
  // Export crop, including while it is being dragged: the vignette is centered on it.
  const cropStore = useApp((s) => s.crop)
  const cropInProgress = useViewerCrop((s) => s.inProgress)
  const crop = cropInProgress ?? cropStore
  // Marker density and types: changing them redraws the viewer.
  useSettings()
  // Straighten preview: the view rotates by the remaining difference to the chosen angle.
  const straightenAngle = useStraighten((s) => (s.open ? s.angle : null))
  const freeRotation = useApp((s) => s.freeRotation)
  const rotationPreview = straightenAngle === null ? 0 : straightenAngle - freeRotation
  const frame = useApp((s) => s.frame)
  const activeFrameId = useApp((s) => s.activeFrameId)
  const project = useApp((s) => s.project)
  const modified = useApp((s) => s.modified)
  const setZoom = useApp((s) => s.setZoom)
  const setPan = useApp((s) => s.setPan)
  const notify = useApp((s) => s.notify)

  // Before/after comparison (backslash key held down, see hooks/useShortcuts.ts):
  // shows the image as it was when opened, i.e. the original data with only
  // the automatic stretch, without touching any of the work done.
  const originalImage = useApp((s) => s.originalImage)
  const comparison = useComparison((s) => s.active)
  const before = useMemo(() => {
    if (!comparison || !image) return null
    const base = originalImage ?? image
    return { image: base, adjustments: { ...NEUTRAL_ADJUSTMENTS, stretch: autoStretch(base) } }
  }, [comparison, originalImage, image])
  const shown = before?.image ?? image
  const shownAdjustments = before?.adjustments ?? adjustments
  const shownCurves = before ? NEUTRAL_CURVES : curves
  // Last loaded image: the comparison must not refit the view.
  const loaded = useRef<{ image: ImageData32 | null; generation: number }>({ image: null, generation: -1 })

  const [error, setError] = useState<string | null>(null)
  // Changes whenever the graphics context is created, so that the effects
  // depending on it run again.
  const [generation, setGeneration] = useState(0)
  // Displayed zoom, animated toward the target for smooth zooming.
  const [viewerZoom, setViewerZoom] = useState(0)
  const viewerZoomRef = useRef(0)
  const { importFile, importFolder } = useLibrary()

  const active = frame.find((f) => f.id === activeFrameId) ?? null
  // Channel medians, shared with the filter thumbnails (see core/image/skyBackground).
  const sky = useMemo((): [number, number, number] => (image ? imageSkyBackground(image) : [0, 0, 0]), [image])
  // Local adjustments (masks): parameters and masks uploaded to the GPU.
  const locals = useLocalAdjustmentsInViewer(glRef.current, image, generation)

  /**
   * Creates the graphics context. A callback ref is used instead of a
   * mount effect because the canvas only appears in the page once there is
   * an image to show: an effect that runs only once would never find it.
   */
  const attachCanvas = useCallback((node: HTMLCanvasElement | null): void => {
    if (node === null) {
      glRef.current?.release()
      glRef.current = null
      canvasRef.current = null
      return
    }
    canvasRef.current = node
    if (glRef.current) return
    try {
      glRef.current = new ViewerGL(node)
      setError(null)
      setGeneration((g) => g + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Uploads the image to GPU memory.
  useEffect(() => {
    if (!shown) {
      // Nothing to show: forget the last image, so its pixels can be freed.
      loaded.current = { image: null, generation: -1 }
      return
    }
    if (!glRef.current) return
    try {
      glRef.current.loadImage(shown)
      // Switching between before and after only changes the displayed data: the view stays where it is.
      const c = loaded.current
      if (c.image !== image || c.generation !== generation) useApp.getState().fitView()
      loaded.current = { image, generation }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      notify('error', t('viewer.gpuLoadFailed', { message }))
    }
  }, [shown, image, notify, generation])

  // Curves are converted to lookup tables and uploaded as textures only
  // when they change, not on every frame.
  useEffect(() => {
    const gl = glRef.current
    if (!gl) return
    if (neutralCurves(shownCurves)) {
      gl.loadCurves(null)
      return
    }
    gl.loadCurves({
      light: buildLut(shownCurves.light, 256),
      red: buildLut(shownCurves.red, 256),
      green: buildLut(shownCurves.green, 256),
      blue: buildLut(shownCurves.blue, 256)
    })
  }, [shownCurves, generation, shown])

  // GHS stretch lookup table, rebuilt only when it changes.
  const withGhs = shownAdjustments.withGhs
  const ghs = shownAdjustments.ghs
  useEffect(() => {
    const gl = glRef.current
    if (!gl) return
    gl.loadGhs(withGhs ? buildGhsLut(ghs, 4096) : null)
  }, [withGhs, ghs, generation, shown])

  // Smooth zoom toward the point under the cursor. The value in the store
  // is the target; a short animation reaches it and, when the zoom was
  // started by the wheel, the pan is updated at every step so that the
  // point under the mouse stays put instead of drifting toward the center.
  useEffect(() => {
    const gl = glRef.current
    if (!gl || !image) return
    const target = zoom === 0 ? gl.fitZoom() : zoom
    const from = viewerZoomRef.current
    const displayWidth = gl.screenWidth
    const displayHeight = gl.screenHeight
    const panFrom = useApp.getState().pan
    const anchor = zoomAnchor.current
    zoomAnchor.current = null
    // Offset from the center of the image point under the cursor.
    const ix = anchor ? anchor.mx - displayWidth / 2 - panFrom.x : 0
    const iy = anchor ? anchor.my - displayHeight / 2 - panFrom.y : 0
    const moveToward = (eff: number): void => {
      if (!anchor || from <= 0) return
      useApp.getState().setPan(
        anchor.mx - displayWidth / 2 - (ix / from) * eff,
        anchor.my - displayHeight / 2 - (iy / from) * eff
      )
    }
    // With reduced motion the zoom jumps straight to the final value.
    if (from <= 0 || Math.abs(target - from) < 1e-4 || reducedMotionActive()) {
      viewerZoomRef.current = target
      setViewerZoom(target)
      moveToward(target)
      return
    }
    let raf = 0
    const start = performance.now()
    const duration = 180
    const animate = (t: number): void => {
      const k = Math.min(1, (t - start) / duration)
      const e = 1 - Math.pow(1 - k, 3)
      const v = from + (target - from) * e
      viewerZoomRef.current = v
      setViewerZoom(v)
      moveToward(v)
      if (k < 1) raf = requestAnimationFrame(animate)
    }
    raf = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(raf)
  }, [zoom, image, generation])

  // Drawing: runs again on every adjustment or view change.
  useEffect(() => {
    const gl = glRef.current
    if (!gl || !image) return

    const effectiveZoom = viewerZoom > 0 ? viewerZoom : gl.fitZoom()

    gl.draw({
      shadows: shownAdjustments.stretch.shadows,
      midtones: shownAdjustments.stretch.midtones,
      highlights: shownAdjustments.stretch.highlights,
      brightness: shownAdjustments.brightness,
      contrast: shownAdjustments.contrast,
      saturation: shownAdjustments.saturation,
      redGain: shownAdjustments.redGain,
      greenGain: shownAdjustments.greenGain,
      blueGain: shownAdjustments.blueGain,
      gamma: shownAdjustments.gamma,
      noiseReduction: shownAdjustments.noiseReduction,
      sharpness: shownAdjustments.sharpness,
      backgroundNeutralization: shownAdjustments.backgroundNeutralization,
      skyBackground: sky,
      preserveColor: shownAdjustments.preserveColor,
      // Chosen filter plus manual vibrance and vignette: the same
      // combination used on export.
      filter:
        effectiveFilter(
          shownAdjustments.filter,
          shownAdjustments.filterIntensity,
          shownAdjustments.vibrance,
          shownAdjustments.vignette
        ) ?? NEUTRAL_FILTER,
      // The vignette is centered on the export crop.
      vignetteBox: crop,
      // The "before" comparison leaves out local adjustments too.
      locals: before ? null : locals,
      zoom: effectiveZoom,
      panX: pan.x,
      panY: pan.y
    })
  }, [shown, shownAdjustments, viewerZoom, pan, sky, generation, shownCurves, locals, before, crop])

  useRedrawOnResize(canvasRef, generation)

  function wheel(e: React.WheelEvent): void {
    if (!image) return
    e.preventDefault()
    const gl = glRef.current
    const rect = e.currentTarget.getBoundingClientRect()
    zoomAnchor.current = { mx: e.clientX - rect.left, my: e.clientY - rect.top }
    const current = zoom === 0 && gl ? gl.fitZoom() : zoom
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setZoom(current * factor)
  }

  function press(e: React.MouseEvent): void {
    if (!image) return
    dragState.current = { active: true, x: e.clientX - pan.x, y: e.clientY - pan.y }
    clickStart.current = { x: e.clientX, y: e.clientY }
  }

  function move(e: React.MouseEvent): void {
    const t = dragState.current
    if (!t || !t.active) return
    setPan(e.clientX - t.x, e.clientY - t.y)
  }

  function release(): void {
    dragState.current = null
  }

  /**
   * A still click (not a drag) while the Stack panel is waiting for the
   * comet nucleus delivers the point, in image pixels.
   */
  function releaseOnClick(e: React.MouseEvent): void {
    const start = clickStart.current
    clickStart.current = null
    release()
    const nucleus = useCometNucleus.getState()
    if (!nucleus.wait || !start || !image) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return
    const rect = e.currentTarget.getBoundingClientRect()
    const p = pointFromScreen(
      { gl: glRef.current, image, zoom: viewerZoom, pan },
      e.clientX - rect.left,
      e.clientY - rect.top
    )
    if (p) nucleus.recordClick(activeFrameId, p.x, p.y, image.width, image.height)
  }

  if (error !== null) {
    return (
      <Empty
        icon={<EmptyGalaxy />}
        title={t('viewer.unavailable')}
        text={error}
      />
    )
  }

  if (!image) {
    return (
      <Empty
        icon={<EmptyGalaxy />}
        title={t('viewer.empty.title')}
        text={t('viewer.empty.text')}
        action={
          <>
            <Button variant="primary" icon={<ImportIcon size={17} />} onClick={importFile}>
              {t('viewer.empty.chooseFrames')}
            </Button>
            <Button icon={<FolderIcon size={17} />} onClick={importFolder}>
              {t('viewer.empty.openFolder')}
            </Button>
          </>
        }
      />
    )
  }

  return (
    <>
      <div className="sl-viewer-bar">
        <div className="sl-viewer-title">
          {/* With a project open: its name and the unsaved-changes dot; the file name stays in the status bar. */}
          {project ? (
            <span
              className="sl-viewer-name sl-viewer-project"
              title={t(modified ? 'viewer.projectTitleModified' : 'viewer.projectTitle', { folder: project.folder })}
            >
              <span className="sl-project-name-text">{project.name}</span>
              {modified ? <span className="sl-project-modified" aria-label={t('viewer.unsavedChanges')} /> : null}
            </span>
          ) : (
            <span className="sl-viewer-name">{active?.fileName ?? t('viewer.defaultFileName')}</span>
          )}
          {active?.metadata.frameType === 'stacked' ? (
            <Label color="violet" title={t('viewer.stacked.title')}>
              {t('viewer.stacked.label')}
            </Label>
          ) : null}
          {active?.metadata.instrumentInfo?.model ? (
            <Label color="cyan" title={t('viewer.instrumentTitle')}>
              {active.metadata.instrumentInfo.model}
            </Label>
          ) : null}
          {objects.length > 0 ? (
            <Label color="magenta" title={t('viewer.objectTitle')}>
              {objects[0].object.id}
            </Label>
          ) : null}
        </div>
        <div className="sl-topbar-spacer" />
        <Histogram compactValue />
      </div>

      <div
        className="sl-viewer"
        onWheel={wheel}
        onMouseDown={press}
        onMouseMove={move}
        onMouseUp={releaseOnClick}
        onMouseLeave={release}
        data-guide="viewer"
      >
        <div
          className="sl-viewer-content"
          style={
            rotationPreview !== 0
              ? {
                  transform: 'rotate(' + rotationPreview + 'deg)',
                  transformOrigin: 'calc(50% + ' + pan.x + 'px) calc(50% + ' + pan.y + 'px)'
                }
              : undefined
          }
        >
        <canvas ref={attachCanvas} />
        {/* Below the markers: with the Crop button on, darkens the part the export will remove and lets the user drag the box. */}
        {before ? null : <CropLayer gl={glRef.current} image={image} zoom={viewerZoom} pan={pan} />}
        {/* Grid, orientation and scale chosen in the Objects step, below the markers. */}
        <CoordinatesLayer gl={glRef.current} image={image} zoom={viewerZoom} pan={pan} wcs={astrometry.wcs} />
        {adjustments.showStars ? (
          <ObjectMarkers
            gl={glRef.current}
            image={image}
            zoom={viewerZoom}
            pan={pan}
            pixelScale={astrometry.pixelScale}
            wcs={astrometry.wcs}
            objects={objects}
            hiddenPositions={astrometry.hidden}
          />
        ) : null}
        <DetectedStars gl={glRef.current} image={image} zoom={viewerZoom} pan={pan} />
        <NucleusMarker gl={glRef.current} image={image} zoom={viewerZoom} pan={pan} />
        <MasksLayer gl={glRef.current} image={image} zoom={viewerZoom} pan={pan} />
        {/* The export caption as it will appear in the file: presentation only, never part of the data. */}
        {before ? null : <CaptionLayer gl={glRef.current} image={image} zoom={viewerZoom} pan={pan} />}
        </div>
        <StraightenViewer />
        {before ? <div className="sl-viewer-compare">{t('viewer.comparisonBefore')}</div> : null}
      </div>
    </>
  )
}

/**
 * Galaxy shown in the empty viewer, inlined in the page rather than used as
 * an image: this way the stylesheet can reach the small stars and make them
 * twinkle one by one while the galaxy stays still.
 */
function EmptyGalaxy(): JSX.Element {
  return <div className="sl-empty-galaxy" aria-hidden="true" dangerouslySetInnerHTML={{ __html: galaxySvg }} />
}

/** View geometry used to place the markers exactly like the image. */
interface MarkersView {
  gl: ViewerGL | null
  image: ImageData32 | null
  zoom: number
  pan: { x: number; y: number }
  pixelScale: number | null
  /** Astrometric solution: orients the galaxy ellipses. */
  wcs: Wcs | null
  objects: RecognizedObject[]
  /** True if a plugin moved the pixels without declaring how: no circles, only the names. */
  hiddenPositions: boolean
}

/**
 * Marks the recognized objects. Those with a known position (from the
 * astrometric solution) get a thin circle with a short leader line and the
 * name; those recognized but not placeable are listed in a corner, without
 * inventing a point.
 *
 * Normalized coordinates are converted to screen pixels with the same
 * transform as the shader (centering, zoom, pan), so the markers follow the
 * image when it is zoomed or moved.
 */
function ObjectMarkers({
  gl,
  image,
  zoom,
  pan,
  pixelScale,
  wcs,
  objects,
  hiddenPositions
}: MarkersView): JSX.Element | null {
  if (!gl || !image) return null
  const displayWidth = gl.screenWidth
  const displayHeight = gl.screenHeight
  if (displayWidth === 0 || displayHeight === 0) return null

  const eff = zoom === 0 ? gl.fitZoom() : zoom
  const W = image.width
  const H = image.height

  // Photo rectangle on screen: markers are clipped to it so they do not
  // spill over the dark border when zoomed in.
  const photoX = displayWidth / 2 + pan.x - (W * eff) / 2
  const photoY = displayHeight / 2 + pan.y - (H * eff) / 2
  const photoW = W * eff
  const photoH = H * eff
  // Part of the photo that falls inside the view.
  const visibleX0 = Math.max(0, photoX)
  const visibleY0 = Math.max(0, photoY)
  const visibleX1 = Math.min(displayWidth, photoX + photoW)
  const visibleY1 = Math.min(displayHeight, photoY + photoH)

  const placed = objects.filter((o) => o.position !== null)
  const onlyName = objects.filter((o) => o.position === null)
  if (placed.length === 0 && onlyName.length === 0) return null

  const white = 'rgba(255,255,255,0.9)'

  // Geometry of each marker, computed once. A marker is shown only if it
  // fits entirely inside the photo, name included: if the name would risk
  // leaving the frame, the marker is hidden.
  const marks = placed.map((o) => {
    const p = o.position as { x: number; y: number }
    const cx = (p.x - 0.5) * W * eff + displayWidth / 2 + pan.x
    const cy = (p.y - 0.5) * H * eff + displayHeight / 2 + pan.y
    // Oriented ellipse for elongated galaxies, circle for everything else.
    const ellipseShape = markerEllipse(objectEllipsePixels(o.object, pixelScale, wcs), eff, 6, 16, 340, 16)
    const radius = ellipseShape.rx
    const dash = 15
    // The name goes above if there is room inside the photo, otherwise
    // below. The leader line starts at the ellipse edge and rises past its
    // highest point, so the name never touches the outline of a tilted ellipse.
    const top = ellipseShape.halfHeight
    const above = cy - top - dash - 16 > photoY
    const yOuter = above ? cy - top - dash : cy + top + dash
    const yInner = above ? cy - ellipseShape.chord : cy + ellipseShape.chord
    const yText = above ? yOuter - 6 : yOuter + 16
    // Space taken by the name (width estimated from the number of characters).
    const halfNameWidth = o.object.id.length * 3.9 + 3
    // The center must fall in the actually visible part of the photo:
    // objects outside the view must not use up slots of the name cap.
    const centerInside = cx >= visibleX0 && cx <= visibleX1 && cy >= visibleY0 && cy <= visibleY1
    const nameInside =
      cx - halfNameWidth >= photoX &&
      cx + halfNameWidth <= photoX + photoW &&
      yText - 12 >= photoY &&
      yText + 3 <= photoY + photoH
    return {
      object: o,
      cx,
      cy,
      radius,
      ellipse: ellipseShape,
      yOuter,
      yInner,
      yText,
      nameInside,
      centerInside
    }
  })

  // Crowding filter: decides, at the current scale, which markers get a
  // name, which are grouped and which stay a small circle (see
  // core/catalog/crowding.ts). Hidden types and density come from the
  // Objects panel.
  const preferences = markerPreferences()
  const allowed = new Set(filterMarkerTypes(objects, preferences.hidden))
  const candidates = marks.filter((s) => s.centerInside && allowed.has(s.object))
  const choice = chooseMarkers(candidates, visibleX1 - visibleX0, visibleY1 - visibleY0, {
    limits: { x0: photoX, y0: photoY, x1: photoX + photoW, y1: photoY + photoH },
    textBody: 13,
    textMeasurer: (t) => t.length * 7.8,
    density: preferences.density
  })
  const visibleItems = choice.withName.map((m) => ({
    ...m.candidate,
    id: m.candidate.object.object.id,
    text: m.text
  }))
  const smallCircles = choice.unnamed
  if (visibleItems.length === 0 && smallCircles.length === 0 && onlyName.length === 0) return null

  return (
    <svg className="sl-viewer-layer" viewBox={`0 0 ${displayWidth} ${displayHeight}`} preserveAspectRatio="none">
      <defs>
        <clipPath id="sl-clip-photo">
          <rect x={photoX} y={photoY} width={photoW} height={photoH} />
        </clipPath>
      </defs>

      {/* Circles and leader lines, clipped to the photo edge as a safeguard. */}
      <g clipPath="url(#sl-clip-photo)">
        {visibleItems.map((s) => (
          <g key={s.id}>
            <ellipse
              cx={s.cx}
              cy={s.cy}
              rx={s.ellipse.rx}
              ry={s.ellipse.ry}
              transform={`rotate(${(s.ellipse.angle * 180) / Math.PI} ${s.cx} ${s.cy})`}
              fill="none"
              stroke={white}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={s.cx}
              y1={s.yOuter}
              x2={s.cx}
              y2={s.yInner}
              stroke={white}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
        {smallCircles.map((c) => (
          <circle
            key={c.object.object.id}
            cx={c.cx}
            cy={c.cy}
            r={circleRadius(c.radius, 13)}
            fill="none"
            stroke="rgba(255,255,255,0.6)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>

      {/* Names: only for markers entirely inside the photo. */}
      <g>
        {visibleItems.map((s) => (
          <text
            key={s.id}
            x={s.cx}
            y={s.yText}
            fill="#fff"
            fontSize={13}
            textAnchor="middle"
            style={{ paintOrder: 'stroke', stroke: 'rgba(5,8,15,0.85)', strokeWidth: 3 }}
          >
            {s.text}
          </text>
        ))}
      </g>

      {onlyName.length > 0 ? (
        <text
          x={14}
          y={displayHeight - 14}
          fill="rgba(255,255,255,0.85)"
          fontSize={13}
          style={{ paintOrder: 'stroke', stroke: 'rgba(5,8,15,0.85)', strokeWidth: 3 }}
        >
          {t(hiddenPositions ? 'viewer.inFieldHidden' : 'viewer.inField', {
            names: onlyName.map((o) => o.object.id).join(', ')
          })}
        </text>
      ) : null}
    </svg>
  )
}
