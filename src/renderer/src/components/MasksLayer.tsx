import { useEffect, useRef, useState, type JSX } from 'react'
import type { ImageData32 } from '@shared/types'
import type { ViewerGL } from '../gpu/viewerGL'
import { useApp } from '../store/appStore'
import { recordStep } from '../hooks/history'
import { t } from '@shared/i18n/i18n'
import {
  gpuMasks,
  chosenLayer,
  tintAtPoint,
  useBrushStrokeInProgress,
  useMaskTools
} from '../hooks/viewerMasks'
import {
  composeBrushStroke,
  startDimensions,
  mapToSource,
  paintedMeasurements,
  stamp,
  type LocalLayer
} from '@core/image/masks'
import { applyAffine, affineDeterminant, type AffineMatrix } from '@core/image/geometry'

/**
 * Viewer layer for painting the masks of local adjustments.
 *
 * With the brush or eraser the left button paints instead of panning the
 * image (other buttons and the wheel still pan and zoom). With the Draw tool
 * the user drags to place a linear or radial gradient. The gradients of the
 * selected layer are always shown by a dashed outline so their area of
 * effect is visible.
 *
 * One brush stroke, from button press to release, is a single history step.
 */

interface Props {
  gl: ViewerGL | null
  image: ImageData32 | null
  zoom: number
  pan: { x: number; y: number }
}

interface InProgress {
  level: LocalLayer
  eraser: boolean
  width: number
  height: number
  start: Uint8Array
  job: Uint8Array
  coverage: Float32Array
  last: { x: number; y: number }
}

export function MasksLayer({ gl, image, zoom, pan }: Props): JSX.Element | null {
  const levels = useApp((s) => s.localAdjustments)
  const geometry = useApp((s) => s.appliedGeometry)
  const step = useApp((s) => s.step)
  const selected = useMaskTools((s) => s.selected)
  const tool = useMaskTools((s) => s.tool)
  const size = useMaskTools((s) => s.size)
  const hardness = useMaskTools((s) => s.hardness)
  const opacity = useMaskTools((s) => s.opacity)
  const [slider, setCursor] = useState<{ x: number; y: number } | null>(null)
  const brushStroke = useRef<InProgress | null>(null)
  const trace = useRef<{ x: number; y: number } | null>(null)

  // Leaving the Correct step turns the tools off; otherwise the left button
  // would keep painting while the card is not visible.
  useEffect(() => {
    if (step !== 'correct' && useMaskTools.getState().tool !== 'none') {
      useMaskTools.getState().set({ tool: 'none' })
    }
  }, [step])

  const level = chosenLayer(levels, selected)
  if (!gl || !image || !level || step !== 'correct') return null
  const displayWidth = gl.screenWidth
  const displayHeight = gl.screenHeight
  if (displayWidth === 0 || displayHeight === 0) return null

  const eff = zoom === 0 ? gl.fitZoom() : zoom
  const W = image.width
  const H = image.height
  const photoX = displayWidth / 2 + pan.x - (W * eff) / 2
  const photoY = displayHeight / 2 + pan.y - (H * eff) / 2
  const map = mapToSource(geometry)
  // From the source image to the displayed one: the plugin transform.
  const forwardMatrix: AffineMatrix =
    geometry.type === 'transformed'
      ? geometry.matrix
      : [
          [1, 0, 0],
          [0, 1, 0]
        ]
  const start = startDimensions(geometry, image)
  const measurements = paintedMeasurements(start)

  /** From screen coordinates to source image pixels. */
  const towardStart = (sx: number, sy: number): { x: number; y: number } =>
    applyAffine(map, (sx - photoX) / eff - 0.5, (sy - photoY) / eff - 0.5)
  /** From source image pixels to screen coordinates. */
  const toScreen = (x: number, y: number): { x: number; y: number } => {
    const p = applyAffine(forwardMatrix, x, y)
    return { x: photoX + (p.x + 0.5) * eff, y: photoY + (p.y + 0.5) * eff }
  }
  /** From source image pixels to painted mask pixels. */
  const towardMask = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: ((p.x + 0.5) * measurements.width) / start.width - 0.5,
    y: ((p.y + 0.5) * measurements.height) / start.height - 0.5
  })
  // Number of source pixels per displayed image pixel.
  const startScale = Math.sqrt(Math.abs(affineDeterminant(map))) || 1
  const maskRadius =
    ((size / 2 / eff) * startScale * measurements.width) / start.width

  const painting = tool === 'brush' || tool === 'eraser'
  const geometric =
    level.mask.type === 'linear' || level.mask.type === 'radial' || level.mask.type === 'object'
  const activeTrace = tool === 'draw' && geometric
  const eyedropper = tool === 'eyedropper' && level.mask.type === 'color'
  const active = painting || activeTrace || eyedropper

  function position(e: React.MouseEvent): { x: number; y: number } {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  /** Stamps the brush from the previous point to this one at regular intervals. */
  function paintUpTo(p: InProgress, a: { x: number; y: number }): void {
    const from = p.last
    const distance = Math.hypot(a.x - from.x, a.y - from.y)
    const strokeStep = Math.max(0.5, maskRadius * 0.25)
    const n = Math.max(1, Math.ceil(distance / strokeStep))
    let r: { x0: number; y0: number; x1: number; y1: number } | null = null
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const touched = stamp(p.coverage, p.width, p.height, from.x + (a.x - from.x) * t, from.y + (a.y - from.y) * t, {
        radius: maskRadius,
        hardness,
        opacity
      })
      if (touched) {
        r = r
          ? {
              x0: Math.min(r.x0, touched.x0),
              y0: Math.min(r.y0, touched.y0),
              x1: Math.max(r.x1, touched.x1),
              y1: Math.max(r.y1, touched.y1)
            }
          : touched
      }
    }
    p.last = a
    if (!r) return
    composeBrushStroke(p.start, p.coverage, p.job, p.width, p.eraser, r)
    // Update the GPU immediately, only within the touched rectangle.
    const layer = gpuMasks.layer
    const channel = gpuMasks.channels.get(p.level.id)
    if (layer && channel !== undefined && layer.width === p.width && layer.height === p.height) {
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
          const k = y * p.width + x
          layer.data[k * 4 + channel] = p.job[k]
        }
      }
      gpuMasks.gl?.updatePainted(layer, r)
      gpuMasks.gl?.redraw()
    }
  }

  function press(e: React.MouseEvent): void {
    if (e.button !== 0 || !level || !active) return
    e.stopPropagation()
    e.preventDefault()
    const s = position(e)
    if (eyedropper && image) {
      // The hue of the clicked point becomes the mask hue.
      const tint = tintAtPoint(image, (s.x - photoX) / eff - 0.5, (s.y - photoY) / eff - 0.5)
      const st = useApp.getState()
      if (tint === null) {
        st.notify('info', t('masksLayer.greyPoint'))
        return
      }
      const id = level.id
      st.setLocalAdjustments(
        st.localAdjustments.map((l) => (l.id === id ? { ...l, mask: { ...l.mask, tint } } : l))
      )
      useMaskTools.getState().set({ tool: 'none', showMask: true })
      return
    }
    const p = towardStart(s.x, s.y)
    if (activeTrace) {
      trace.current = p
      return
    }
    const existing = level.mask.painted
    const same = existing && existing.width === measurements.width && existing.height === measurements.height
    const dataStart = same ? existing.data : new Uint8Array(measurements.width * measurements.height)
    const job = dataStart.slice()
    const q = towardMask(p)
    const newValue: InProgress = {
      level,
      eraser: tool === 'eraser',
      width: measurements.width,
      height: measurements.height,
      start: dataStart,
      job,
      coverage: new Float32Array(measurements.width * measurements.height),
      last: q
    }
    brushStroke.current = newValue
    useBrushStrokeInProgress.setState({
      id: level.id,
      painted: { width: measurements.width, height: measurements.height, data: job }
    })
    // First stamp, at the pressed point.
    newValue.last = { x: q.x - 1e-3, y: q.y }
    paintUpTo(newValue, q)
  }

  function updateTrace(from: { x: number; y: number }, a: { x: number; y: number }): void {
    if (!level) return
    const m = level.mask
    const patch =
      m.type === 'linear'
        ? { ax: from.x, ay: from.y, bx: a.x, by: a.y }
        : (() => {
            const r = Math.max(2, Math.hypot(a.x - from.x, a.y - from.y))
            const ratio = m.rx > 0 ? m.ry / m.rx : 1
            return { cx: from.x, cy: from.y, rx: r, ry: Math.max(2, r * ratio) }
          })()
    const id = level.id
    const s = useApp.getState()
    s.setLocalAdjustments(
      s.localAdjustments.map((l) => (l.id === id ? { ...l, mask: { ...l.mask, ...patch } } : l))
    )
  }

  function move(e: React.MouseEvent): void {
    const s = position(e)
    setCursor(s)
    if (trace.current) {
      e.stopPropagation()
      updateTrace(trace.current, towardStart(s.x, s.y))
      return
    }
    const p = brushStroke.current
    if (!p) return
    e.stopPropagation()
    paintUpTo(p, towardMask(towardStart(s.x, s.y)))
  }

  function release(): void {
    if (trace.current) {
      trace.current = null
      return
    }
    const p = brushStroke.current
    if (!p) return
    brushStroke.current = null
    const id = p.level.id
    const painted = { width: p.width, height: p.height, data: p.job }
    recordStep(p.eraser ? t('masksLayer.stepEraser') : t('masksLayer.stepBrush'), () => {
      const s = useApp.getState()
      s.setLocalAdjustments(
        s.localAdjustments.map((l) => (l.id === id ? { ...l, mask: { ...l.mask, painted } } : l))
      )
    })
    useBrushStrokeInProgress.setState({ id: null, painted: null })
  }

  // Outline of the selected layer's gradients.
  const m = level.mask
  let outline: JSX.Element | null = null
  if (m.type === 'linear') {
    const a = toScreen(m.ax, m.ay)
    const b = toScreen(m.bx, m.by)
    // Two perpendicular lines: where the effect is full and where it ends.
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    const nx = (-dy / l) * 2000
    const ny = (dx / l) * 2000
    outline = (
      <g className="sl-mask-outline">
        <line x1={a.x - nx} y1={a.y - ny} x2={a.x + nx} y2={a.y + ny} />
        <line x1={b.x - nx} y1={b.y - ny} x2={b.x + nx} y2={b.y + ny} strokeDasharray="6 5" />
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeDasharray="2 4" />
        <circle cx={a.x} cy={a.y} r={5} />
        <circle cx={b.x} cy={b.y} r={4} className="sl-mask-empty" />
      </g>
    )
  } else if (m.type === 'radial' || m.type === 'object') {
    const c = toScreen(m.cx, m.cy)
    // Ellipse axes mapped to the screen (a plugin may have rotated the image).
    const ca = Math.cos(m.angle)
    const sa = Math.sin(m.angle)
    const end = toScreen(m.cx + ca * m.rx, m.cy + sa * m.rx)
    const end2 = toScreen(m.cx - sa * m.ry, m.cy + ca * m.ry)
    const rx = Math.hypot(end.x - c.x, end.y - c.y)
    const ry = Math.hypot(end2.x - c.x, end2.y - c.y)
    const angle = (Math.atan2(end.y - c.y, end.x - c.x) * 180) / Math.PI
    const inner = Math.max(0, 1 - (0.02 + 0.98 * m.feather))
    outline = (
      <g className="sl-mask-outline">
        <ellipse cx={c.x} cy={c.y} rx={rx} ry={ry} transform={`rotate(${angle} ${c.x} ${c.y})`} />
        {inner > 0.02 ? (
          <ellipse
            cx={c.x}
            cy={c.y}
            rx={rx * inner}
            ry={ry * inner}
            transform={`rotate(${angle} ${c.x} ${c.y})`}
            strokeDasharray="6 5"
          />
        ) : null}
        <circle cx={c.x} cy={c.y} r={4} />
      </g>
    )
  }

  return (
    <div
      className={'sl-mask-layer' + (active ? ' sl-mask-layer--active' : '')}
      onMouseDown={press}
      onMouseMove={move}
      onMouseUp={release}
      onMouseLeave={() => {
        setCursor(null)
        release()
      }}
      data-guide="mask-layer"
    >
      <svg viewBox={`0 0 ${displayWidth} ${displayHeight}`} preserveAspectRatio="none">
        {outline}
        {painting && slider ? (
          <g className="sl-mask-brush">
            <circle cx={slider.x} cy={slider.y} r={size / 2} />
            {hardness < 0.95 ? <circle cx={slider.x} cy={slider.y} r={(size / 2) * Math.max(0.05, hardness)} className="sl-mask-empty" /> : null}
          </g>
        ) : null}
      </svg>
    </div>
  )
}
