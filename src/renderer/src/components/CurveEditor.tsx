import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { useLevels } from '../hooks/useLevels'
import { t } from '@shared/i18n/i18n'
import { CURVE_KEY, buildLut, sortPoints, type CurveChannel, type CurvePoint } from '@core/image/curve'

/**
 * Curve editor.
 *
 * The curve of the selected channel is drawn over the levels histogram.
 * Clicking on an empty area adds a point, dragging moves it and a right
 * click removes it. The two end points cannot be removed because they
 * define black and white.
 *
 * The background histogram shows the levels entering the curve, i.e. the
 * values on the horizontal axis: after the stretch (and, for the lightness
 * curve, after the channel curves, which precede it in the pipeline). The
 * photo filter and color adjustments act AFTER the curves, so they are not
 * reflected here: the final result, filter included, is shown by the
 * histogram in the Stretch card and by the viewer histogram. With
 * "preserve color" the lightness curve acts on luminance and the background
 * shows luminance only (see core/image/levels.ts).
 */

const HEIGHT = 230
/** Radius within which a click grabs an existing point. */
const GRIP = 0.045

const COLORS: Record<CurveChannel, string> = {
  light: '#e8f1ff',
  red: '#ff5c7a',
  green: '#46ffa6',
  blue: '#5aa0ff'
}

export function CurveEditor({ channel }: { channel: CurveChannel }): JSX.Element {
  const curves = useApp((s) => s.curves)
  const setCurve = useApp((s) => s.setCurve)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragged = useRef<number | null>(null)
  const [activePoint, setActivePoint] = useState<number | null>(null)

  const points = curves[CURVE_KEY[channel]]
  // Background: the levels this curve actually receives, after the stretch
  // and before the curve itself, color and filter.
  const histogram = useLevels('curvesInput', 128, channel)
  const lut = useMemo(() => buildLut(points, 256), [points])

  /** Converts pointer coordinates to values from 0 to 1. */
  const coordinates = useCallback((e: React.MouseEvent | MouseEvent): CurvePoint => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const area = canvas.getBoundingClientRect()
    const x = (e.clientX - area.left) / area.width
    // The canvas vertical axis grows downwards.
    const y = 1 - (e.clientY - area.top) / area.height
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
  }, [])

  /** Index of the point nearest to the position, if within grip range. */
  const nearbyPoint = useCallback(
    (position: CurvePoint): number => {
      let neighbor = -1
      let minimum = GRIP
      points.forEach((p, i) => {
        const d = Math.hypot(p.x - position.x, p.y - position.y)
        if (d < minimum) {
          minimum = d
          neighbor = i
        }
      })
      return neighbor
    },
    [points]
  )

  // --- Drawing ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const wide = Math.round(canvas.clientWidth * dpr)
    const top = Math.round(canvas.clientHeight * dpr)
    if (canvas.width !== wide || canvas.height !== top) {
      canvas.width = wide
      canvas.height = top
    }

    ctx.clearRect(0, 0, wide, top)

    // Background histogram, on a logarithmic scale.
    if (histogram) {
      const bins = histogram[0].length
      let max = 0
      for (const h of histogram) {
        for (let i = 0; i < bins; i++) max = Math.max(max, Math.log1p(h[i]))
      }
      if (max > 0) {
        ctx.globalCompositeOperation = 'screen'
        const tints =
          histogram.length === 3
            ? ['rgba(255,92,122,0.2)', 'rgba(70,255,166,0.2)', 'rgba(90,160,255,0.2)']
            : ['rgba(169,184,212,0.24)']
        histogram.forEach((h, c) => {
          ctx.beginPath()
          ctx.moveTo(0, top)
          for (let i = 0; i < bins; i++) {
            ctx.lineTo((i / (bins - 1)) * wide, top - (Math.log1p(h[i]) / max) * top * 0.92)
          }
          ctx.lineTo(wide, top)
          ctx.closePath()
          ctx.fillStyle = tints[c]
          ctx.fill()
        })
        ctx.globalCompositeOperation = 'source-over'
      }
    }

    // Grid and reference diagonal.
    ctx.strokeStyle = 'rgba(169,184,212,0.12)'
    ctx.lineWidth = 1
    for (let q = 1; q < 4; q++) {
      const px = Math.round((q / 4) * wide) + 0.5
      const py = Math.round((q / 4) * top) + 0.5
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, top)
      ctx.moveTo(0, py)
      ctx.lineTo(wide, py)
      ctx.stroke()
    }
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(169,184,212,0.22)'
    ctx.beginPath()
    ctx.moveTo(0, top)
    ctx.lineTo(wide, 0)
    ctx.stroke()
    ctx.setLineDash([])

    // The curve.
    ctx.strokeStyle = COLORS[channel]
    ctx.lineWidth = 2 * dpr
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let i = 0; i < lut.length; i++) {
      const x = (i / (lut.length - 1)) * wide
      const y = top - lut[i] * top
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Control points.
    points.forEach((p, index) => {
      ctx.beginPath()
      ctx.arc(p.x * wide, top - p.y * top, (index === activePoint ? 6 : 4.5) * dpr, 0, Math.PI * 2)
      ctx.fillStyle = '#0b0f1a'
      ctx.fill()
      ctx.lineWidth = 2 * dpr
      ctx.strokeStyle = COLORS[channel]
      ctx.stroke()
    })
  }, [histogram, lut, points, channel, activePoint])

  // --- Dragging ---
  useEffect(() => {
    function move(e: MouseEvent): void {
      const index = dragged.current
      if (index === null) return
      const position = coordinates(e)
      const currentValues = useApp.getState().curves[CURVE_KEY[channel]]

      // End points stay pinned to the edges: they move up and down but not
      // horizontally.
      const locked = index === 0 || index === currentValues.length - 1
      const newOnes = currentValues.map((p, i) =>
        i === index ? { x: locked ? p.x : position.x, y: position.y } : p
      )
      setCurve(channel, sortPoints(newOnes))
    }

    function release(): void {
      dragged.current = null
    }

    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', release)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', release)
    }
  }, [channel, coordinates, setCurve])

  function press(e: React.MouseEvent): void {
    if (e.button !== 0) return
    const position = coordinates(e)
    const neighbor = nearbyPoint(position)

    if (neighbor >= 0) {
      dragged.current = neighbor
      setActivePoint(neighbor)
      return
    }

    // No point nearby: add a new one.
    const newOnes = sortPoints([...points, position])
    const index = newOnes.findIndex((p) => p.x === position.x && p.y === position.y)
    setCurve(channel, newOnes)
    dragged.current = index >= 0 ? index : null
    setActivePoint(index)
  }

  function contextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const neighbor = nearbyPoint(coordinates(e))
    // The two end points define black and white and cannot be removed.
    if (neighbor > 0 && neighbor < points.length - 1) {
      setCurve(
        channel,
        points.filter((_, i) => i !== neighbor)
      )
      setActivePoint(null)
    }
  }

  return (
    <div className="sl-curve">
      <canvas
        ref={canvasRef}
        className="sl-curve-canvas"
        style={{ height: HEIGHT }}
        onMouseDown={press}
        onContextMenu={contextMenu}
        title={t('curveEditor.canvasHint')}
      />
      <div className="sl-curve-axes">
        <span>{t('curveEditor.axisShadows')}</span>
        <span>{t('curveEditor.axisMidtones')}</span>
        <span>{t('curveEditor.axisHighlights')}</span>
      </div>
    </div>
  )
}
