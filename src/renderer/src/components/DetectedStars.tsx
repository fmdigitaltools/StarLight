import { useEffect, useState, type JSX } from 'react'
import { create } from 'zustand'
import type { ImageData32 } from '@shared/types'
import { detectStars, type Star } from '@core/stars/detection'
import type { ViewerGL } from '../gpu/viewerGL'
import { useApp } from '../store/appStore'
import { t } from '@shared/i18n/i18n'

/**
 * Detected stars, drawn over the image (View menu).
 *
 * Shows which stars are used by alignment, focus measurement and color
 * calibration: each detected star is marked by a circle sized by its HFR,
 * the radius that contains half of its light.
 *
 * Purely a visual aid: it is not part of the project and does not change
 * the image.
 */

export const useDetectedStars = create<{ visibleItems: boolean; toggle: () => void }>((set) => ({
  visibleItems: false,
  toggle: () => set((s) => ({ visibleItems: !s.visibleItems }))
}))

/** Maximum number of stars to mark (the brightest ones). */
const MAX_STARS = 1500

/** Stars already found for each image: detection takes a moment. */
const foundPerImage = new WeakMap<ImageData32, Star[]>()

interface Props {
  gl: ViewerGL | null
  image: ImageData32 | null
  zoom: number
  pan: { x: number; y: number }
}

export function DetectedStars({ gl, image, zoom, pan }: Props): JSX.Element | null {
  const visibleItems = useDetectedStars((s) => s.visibleItems)
  const [stars, setStars] = useState<Star[] | null>(null)

  useEffect(() => {
    if (!visibleItems || !image) {
      setStars(null)
      return
    }
    const already = foundPerImage.get(image)
    if (already) {
      setStars(already)
      return
    }
    setStars(null)
    // Detection blocks briefly, so the progress indicator is allowed to
    // appear first. If another job is already running, it is not replaced.
    const report = !useApp.getState().job.active
    if (report) useApp.getState().setJob(t('detectedStars.job'), 0.3)
    let done = false
    const wait = window.setTimeout(() => {
      done = true
      try {
        const foundAll = detectStars(image, { max: MAX_STARS })
        foundPerImage.set(image, foundAll)
        setStars(foundAll)
      } finally {
        if (report) useApp.getState().finishJob()
      }
    }, 30)
    return () => {
      window.clearTimeout(wait)
      if (!done && report) useApp.getState().finishJob()
    }
  }, [visibleItems, image])

  if (!visibleItems || !gl || !image || !stars) return null
  const displayWidth = gl.screenWidth
  const displayHeight = gl.screenHeight
  if (displayWidth === 0 || displayHeight === 0) return null

  // Same transform as the object markers (see Viewer).
  const eff = zoom === 0 ? gl.fitZoom() : zoom
  const W = image.width
  const H = image.height
  const photoX = displayWidth / 2 + pan.x - (W * eff) / 2
  const photoY = displayHeight / 2 + pan.y - (H * eff) / 2

  const circles: { cx: number; cy: number; r: number }[] = []
  for (const s of stars) {
    // The center of the first pixel is at 0,0: add half a pixel.
    const cx = photoX + (s.x + 0.5) * eff
    const cy = photoY + (s.y + 0.5) * eff
    if (cx < -20 || cy < -20 || cx > displayWidth + 20 || cy > displayHeight + 20) continue
    circles.push({ cx, cy, r: Math.max(5, s.hfr * 2 * eff) })
  }

  return (
    <svg className="sl-viewer-layer" viewBox={`0 0 ${displayWidth} ${displayHeight}`} preserveAspectRatio="none">
      <g>
        {circles.map((c, i) => (
          <circle
            key={i}
            cx={c.cx}
            cy={c.cy}
            r={c.r}
            fill="none"
            stroke="rgba(70, 255, 166, 0.8)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
      <text
        x={displayWidth - 14}
        y={displayHeight - 14}
        fill="rgba(70, 255, 166, 0.95)"
        fontSize={13}
        textAnchor="end"
        style={{ paintOrder: 'stroke', stroke: 'rgba(5,8,15,0.85)', strokeWidth: 3 }}
      >
        {stars.length === 0
          ? t('detectedStars.countNone')
          : stars.length === 1
            ? t('detectedStars.countOne')
            : stars.length >= MAX_STARS
              ? t('detectedStars.countBrightest', { count: stars.length })
              : t('detectedStars.countOther', { count: stars.length })}
      </text>
    </svg>
  )
}
