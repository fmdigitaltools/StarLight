import { useEffect, type JSX } from 'react'
import type { ImageData32 } from '@shared/types'
import type { ViewerGL } from '../gpu/viewerGL'
import { useApp } from '../store/appStore'
import { useCometNucleus } from '../hooks/cometNucleus'
import { t } from '@shared/i18n/i18n'

/**
 * Comet nucleus marks in the viewer: a crosshair on the point chosen in the
 * displayed frame and, while the Stack panel waits for a click, a line that
 * says what to do. The click itself is captured by the viewer and converted
 * with `pointFromScreen`.
 */

interface ViewState {
  gl: ViewerGL | null
  image: ImageData32 | null
  zoom: number
  pan: { x: number; y: number }
}

/**
 * Converts a screen point (relative to the canvas) to image pixels, with
 * the same geometry as the markers. Null if it falls outside the photo.
 */
export function pointFromScreen(
  { gl, image, zoom, pan }: ViewState,
  mx: number,
  my: number
): { x: number; y: number } | null {
  if (!gl || !image) return null
  const eff = zoom === 0 ? gl.fitZoom() : zoom
  if (!(eff > 0)) return null
  const photoX = gl.screenWidth / 2 + pan.x - (image.width * eff) / 2
  const photoY = gl.screenHeight / 2 + pan.y - (image.height * eff) / 2
  // The center of the first pixel is 0,0: subtract half a pixel.
  const x = (mx - photoX) / eff - 0.5
  const y = (my - photoY) / eff - 0.5
  if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return null
  return { x, y }
}

export function NucleusMarker({ gl, image, zoom, pan }: ViewState): JSX.Element | null {
  const activeFrameId = useApp((s) => s.activeFrameId)
  const first = useCometNucleus((s) => s.first)
  const last = useCometNucleus((s) => s.last)
  const wait = useCometNucleus((s) => s.wait)

  // Esc cancels waiting for the click.
  useEffect(() => {
    if (!wait) return
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useCometNucleus.getState().cancelWait()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [wait])

  if (!gl || !image) return null
  const displayWidth = gl.screenWidth
  const displayHeight = gl.screenHeight
  if (displayWidth === 0 || displayHeight === 0) return null
  const eff = zoom === 0 ? gl.fitZoom() : zoom
  const photoX = displayWidth / 2 + pan.x - (image.width * eff) / 2
  const photoY = displayHeight / 2 + pan.y - (image.height * eff) / 2

  const points = [first, last].filter(
    (p) => p !== null && p.frameId === activeFrameId && p.width === image.width
  )
  const pending = wait !== null && wait.frameId === activeFrameId
  if (points.length === 0 && !pending) return null

  const color = 'rgba(255, 194, 71, 0.95)'
  return (
    <svg className="sl-viewer-layer" viewBox={`0 0 ${displayWidth} ${displayHeight}`} preserveAspectRatio="none">
      {points.map((p, i) => {
        if (!p) return null
        const cx = photoX + (p.x + 0.5) * eff
        const cy = photoY + (p.y + 0.5) * eff
        return (
          <g key={i} stroke={color} strokeWidth={1.5} fill="none">
            <circle cx={cx} cy={cy} r={12} vectorEffect="non-scaling-stroke" />
            <line x1={cx - 20} y1={cy} x2={cx - 6} y2={cy} vectorEffect="non-scaling-stroke" />
            <line x1={cx + 6} y1={cy} x2={cx + 20} y2={cy} vectorEffect="non-scaling-stroke" />
            <line x1={cx} y1={cy - 20} x2={cx} y2={cy - 6} vectorEffect="non-scaling-stroke" />
            <line x1={cx} y1={cy + 6} x2={cx} y2={cy + 20} vectorEffect="non-scaling-stroke" />
          </g>
        )
      })}
      {pending ? (
        <text
          x={displayWidth / 2}
          y={28}
          fill={color}
          fontSize={14}
          textAnchor="middle"
          style={{ paintOrder: 'stroke', stroke: 'rgba(5,8,15,0.9)', strokeWidth: 4 }}
        >
          {wait?.which === 'first' ? t('nucleusMarker.clickFirst') : t('nucleusMarker.clickLast')}
        </text>
      ) : null}
    </svg>
  )
}
