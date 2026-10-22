import { useEffect, useRef, type JSX } from 'react'
import { useLevels } from '../hooks/useLevels'
import { t } from '@shared/i18n/i18n'

/**
 * Levels histogram.
 *
 * Shows how brightness values are distributed in the image, from black on
 * the left to white on the right, so the user can tell whether faint signal
 * is being clipped or stars are being blown out. The levels are those of the
 * image as displayed in the viewer, after all adjustments and the photo
 * filter (computed on a sample of pixels, see useLevels).
 */

interface Props {
  /** Compact version shown in the viewer bar. */
  compactValue?: boolean
}

export function Histogram({ compactValue = false }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const histograms = useLevels('final', 256)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const l = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const a = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== l || canvas.height !== a) {
      canvas.width = l
      canvas.height = a
    }

    ctx.clearRect(0, 0, l, a)

    if (!histograms) return

    const bins = 256
    const transformedValues = histograms

    // Logarithmic scale: without it the sky background peak would flatten
    // everything else into invisibility.
    let max = 0
    for (const h of transformedValues) {
      for (let i = 0; i < bins; i++) {
        const v = Math.log1p(h[i])
        if (v > max) max = v
      }
    }
    if (max <= 0) return

    const colors =
      transformedValues.length === 3
        ? ['rgba(255,92,122,0.75)', 'rgba(70,255,166,0.75)', 'rgba(90,160,255,0.75)']
        : ['rgba(34,232,255,0.8)']

    ctx.globalCompositeOperation = 'screen'

    transformedValues.forEach((h, channel) => {
      ctx.beginPath()
      ctx.moveTo(0, a)
      for (let i = 0; i < bins; i++) {
        const x = (i / (bins - 1)) * l
        const y = a - (Math.log1p(h[i]) / max) * a * 0.96
        ctx.lineTo(x, y)
      }
      ctx.lineTo(l, a)
      ctx.closePath()
      ctx.fillStyle = colors[channel]
      ctx.fill()
    })

    ctx.globalCompositeOperation = 'source-over'

    // Vertical guides at every quarter of the scale.
    ctx.strokeStyle = 'rgba(169,184,212,0.14)'
    ctx.lineWidth = 1
    for (let q = 1; q < 4; q++) {
      const x = Math.round((q / 4) * l) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, a)
      ctx.stroke()
    }
  }, [histograms])

  const title = t('histogram.tooltip')

  if (compactValue) {
    return (
      <div className="sl-histogram sl-histogram-compact" title={title}>
        <canvas ref={canvasRef} />
      </div>
    )
  }

  return (
    <div className="sl-histogram" title={title}>
      <canvas ref={canvasRef} />
    </div>
  )
}
