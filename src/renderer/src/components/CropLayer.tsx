import { useEffect, useRef, useState, type JSX } from 'react'
import type { ImageData32 } from '@shared/types'
import type { ViewerGL } from '../gpu/viewerGL'
import { useApp } from '../store/appStore'
import { framingRatio, fullCrop, dragCrop, type CropGrip, type Crop } from '@core/export/crop'
import { useViewerCrop } from '../hooks/viewerCrop'
import { useMaskTools } from '../hooks/viewerMasks'
import { useCometNucleus } from '../hooks/cometNucleus'
import { recordStep } from '../hooks/history'
import { t as i18nT } from '@shared/i18n/i18n'

/**
 * Export crop shown in the viewer while the Crop button of the top bar is
 * on (see hooks/viewerCrop): the part that will be removed is darkened and
 * the kept box has a dashed border with eight handles.
 *
 * Dragging the inside moves the box; pulling corners and sides resizes it,
 * respecting the aspect ratio or preset chosen in the Export step. Outside
 * the box the mouse still pans the image and the wheel still zooms it. The
 * mask brush and eraser, and waiting for the click on the comet nucleus,
 * take precedence: in those moments the box is only displayed.
 */

interface ViewState {
  gl: ViewerGL | null
  image: ImageData32 | null
  zoom: number
  pan: { x: number; y: number }
}

/** Half size of a handle's hit area, in screen pixels. */
const GRIP = 7
/** Side of the small square drawn for each handle. */
const HANDLE_SIDE = 8

const SLIDERS: Record<CropGrip, string> = {
  inside: 'move',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize'
}

/** Photo rectangle on screen, in viewer CSS pixels. */
interface Photo {
  x: number
  y: number
  l: number
  a: number
}

interface DragState {
  grip: CropGrip
  start: Crop
  ratio: number | null
  /** Grabbed point, as fractions of the image. */
  fx: number
  fy: number
  /** Position of the layer on screen, to convert the mouse coordinates. */
  left: number
  top: number
}

function sameCrop(a: Crop, b: Crop): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function CropLayer({ gl, image, zoom, pan }: ViewState): JSX.Element | null {
  const on = useViewerCrop((s) => s.on)
  const inProgress = useViewerCrop((s) => s.inProgress)
  const cropStore = useApp((s) => s.crop)
  const tool = useMaskTools((s) => s.tool)
  const awaitingNucleus = useCometNucleus((s) => s.wait)
  const [isDragging, setDragging] = useState<CropGrip | null>(null)

  // Last drawn geometry: the drag reads it again on every move, so it stays
  // correct even if the view is zoomed meanwhile.
  const photo = useRef<Photo | null>(null)
  const grip = useRef<DragState | null>(null)

  const editable = on && tool === 'none' && awaitingNucleus === null

  useEffect(() => {
    if (isDragging === null) return
    function pointFraction(clientX: number, clientY: number, t: DragState): { x: number; y: number } | null {
      const f = photo.current
      if (!f || f.l <= 0 || f.a <= 0) return null
      return { x: (clientX - t.left - f.x) / f.l, y: (clientY - t.top - f.y) / f.a }
    }
    function move(e: MouseEvent): void {
      const t = grip.current
      const img = useApp.getState().image
      if (!t || !img) return
      const p = pointFraction(e.clientX, e.clientY, t)
      if (!p) return
      useViewerCrop
        .getState()
        .setInProgress(dragCrop(t.start, t.grip, p.x - t.fx, p.y - t.fy, t.ratio, img.width, img.height))
    }
    function end(confirm: boolean): void {
      const t = grip.current
      grip.current = null
      setDragging(null)
      const state = useViewerCrop.getState()
      const final = state.inProgress
      // A whole drag is a single history step.
      if (confirm && t && final && !sameCrop(final, t.start)) {
        recordStep(i18nT('cropLayer.historyStep'), () => useApp.getState().setCrop(final))
      }
      state.setInProgress(null)
    }
    const release = (): void => end(true)
    // Esc in the middle of a drag puts the box back as it was.
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') end(false)
    }
    // The cursor stays the handle's cursor even when leaving the box.
    const previousSlider = document.body.style.cursor
    document.body.style.cursor = SLIDERS[isDragging]
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', release)
    window.addEventListener('keydown', key)
    return () => {
      document.body.style.cursor = previousSlider
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', release)
      window.removeEventListener('keydown', key)
    }
  }, [isDragging])

  // Turning the button off (or switching to the brush or eraser) drops a
  // drag in progress.
  useEffect(() => {
    if (editable || grip.current === null) return
    grip.current = null
    setDragging(null)
    useViewerCrop.getState().setInProgress(null)
  }, [editable])

  if (!on || !gl || !image) return null
  const displayWidth = gl.screenWidth
  const displayHeight = gl.screenHeight
  if (displayWidth === 0 || displayHeight === 0) return null
  const eff = zoom === 0 ? gl.fitZoom() : zoom
  const photoWidth = image.width * eff
  const photoHeight = image.height * eff
  const photoX = displayWidth / 2 + pan.x - photoWidth / 2
  const photoY = displayHeight / 2 + pan.y - photoHeight / 2
  photo.current = { x: photoX, y: photoY, l: photoWidth, a: photoHeight }

  const crop = inProgress ?? cropStore
  const rx = photoX + crop.x * photoWidth
  const ry = photoY + crop.y * photoHeight
  const rl = crop.width * photoWidth
  const ra = crop.height * photoHeight

  // Whole photo minus the kept box: with evenodd the surrounding frame stays darkened.
  const border =
    `M${photoX},${photoY}h${photoWidth}v${photoHeight}h${-photoWidth}z ` + `M${rx},${ry}h${rl}v${ra}h${-rl}z`

  function grab(e: React.MouseEvent<SVGElement>, which: CropGrip): void {
    if (e.button !== 0 || !image) return
    // The viewer below must neither pan the image nor receive the click.
    e.stopPropagation()
    e.preventDefault()
    const svg = e.currentTarget.ownerSVGElement ?? (e.currentTarget as unknown as SVGSVGElement)
    const area = svg.getBoundingClientRect()
    const s = useApp.getState()
    grip.current = {
      grip: which,
      start: s.crop,
      ratio: framingRatio({ crop: s.crop, aspectRatio: s.aspectRatio, preset: s.preset }),
      fx: (e.clientX - area.left - photoX) / photoWidth,
      fy: (e.clientY - area.top - photoY) / photoHeight,
      left: area.left,
      top: area.top
    }
    useViewerCrop.getState().setInProgress(s.crop)
    setDragging(which)
  }

  const sensitive = (which: CropGrip): React.SVGProps<SVGRectElement> =>
    editable
      ? {
          style: { pointerEvents: 'all', cursor: SLIDERS[which] },
          onMouseDown: (e) => grab(e, which)
        }
      : {}

  // Sides: hit strips along the whole edge. Corners: squares on top.
  const sides: { which: CropGrip; x: number; y: number; l: number; a: number }[] = [
    { which: 'n', x: rx, y: ry - GRIP, l: rl, a: 2 * GRIP },
    { which: 's', x: rx, y: ry + ra - GRIP, l: rl, a: 2 * GRIP },
    { which: 'w', x: rx - GRIP, y: ry, l: 2 * GRIP, a: ra },
    { which: 'e', x: rx + rl - GRIP, y: ry, l: 2 * GRIP, a: ra }
  ]
  const points: { which: CropGrip; x: number; y: number }[] = [
    { which: 'nw', x: rx, y: ry },
    { which: 'ne', x: rx + rl, y: ry },
    { which: 'sw', x: rx, y: ry + ra },
    { which: 'se', x: rx + rl, y: ry + ra },
    { which: 'n', x: rx + rl / 2, y: ry },
    { which: 's', x: rx + rl / 2, y: ry + ra },
    { which: 'w', x: rx, y: ry + ra / 2 },
    { which: 'e', x: rx + rl, y: ry + ra / 2 }
  ]

  return (
    <svg
      className="sl-viewer-layer"
      viewBox={`0 0 ${displayWidth} ${displayHeight}`}
      preserveAspectRatio="none"
      aria-label={i18nT('cropLayer.ariaLabel')}
    >
      <path d={border} fillRule="evenodd" fill="rgba(5, 8, 14, 0.62)" />
      <rect
        x={rx}
        y={ry}
        width={rl}
        height={ra}
        fill="transparent"
        stroke="rgba(34, 232, 255, 0.75)"
        strokeWidth={1}
        strokeDasharray="6 4"
        // A box as large as the image has nowhere to go: there the mouse
        // keeps panning the image.
        {...(fullCrop(crop) ? {} : sensitive('inside'))}
      />
      {editable ? (
        <>
          {sides.map((l) => (
            <rect key={'side-' + l.which} x={l.x} y={l.y} width={l.l} height={l.a} fill="transparent" {...sensitive(l.which)} />
          ))}
          {points.map((p) => (
            <g key={'handle-' + p.which}>
              <rect
                x={p.x - HANDLE_SIDE / 2}
                y={p.y - HANDLE_SIDE / 2}
                width={HANDLE_SIDE}
                height={HANDLE_SIDE}
                fill={isDragging === p.which ? 'rgb(34, 232, 255)' : 'rgba(5, 8, 14, 0.85)'}
                stroke="rgb(34, 232, 255)"
                strokeWidth={1.2}
              />
              {/* Hit area slightly larger than the small square. */}
              <rect
                x={p.x - GRIP - 2}
                y={p.y - GRIP - 2}
                width={2 * GRIP + 4}
                height={2 * GRIP + 4}
                fill="transparent"
                {...sensitive(p.which)}
              />
            </g>
          ))}
        </>
      ) : null}
    </svg>
  )
}
