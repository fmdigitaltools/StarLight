import { useRef, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { Slider, Toggle, Button } from './Controls'
import { useDisplayedAstrometry } from '../hooks/displayedAstrometry'
import {
  useStraighten,
  applyStraightening,
  closeStraighten,
  angleToStraighten,
  angleForNorthUp
} from '../hooks/straighten'
import { formatDecimal, t } from '@shared/i18n/i18n'

/**
 * Straighten panel over the viewer: free angle with preview, a line drawn on
 * the image to straighten it, north up from the astrometric solution, and
 * cropping of the uncovered corners. The actual computation runs on Apply;
 * until then the viewer only rotates the view.
 */
export function StraightenViewer(): JSX.Element | null {
  const { open, angle, trimEdges, lineTrace } = useStraighten()
  const image = useApp((s) => s.image)
  const busy = useApp((s) => s.job.active)
  const notify = useApp((s) => s.notify)
  const { wcs } = useDisplayedAstrometry()
  const [text, setText] = useState<string | null>(null)

  if (!open || !image) return null

  const set = (v: number): void => {
    // Always between −180° and 180°, with one decimal place.
    let a = ((((v + 180) % 360) + 360) % 360) - 180
    a = Math.round(a * 10) / 10
    useStraighten.setState({ angle: a })
  }
  const north = angleForNorthUp(wcs, image.width, image.height)
  const shownRotation = useApp.getState().freeRotation

  return (
    <>
      {lineTrace ? (
        <LineTrace
          onEnd={(delta) => {
            set(angle + delta)
            useStraighten.setState({ lineTrace: false })
          }}
        />
      ) : null}
      <div
        className="sl-straighten"
        role="dialog"
        aria-label={t('straightenViewer.title')}
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeStraighten()
          e.stopPropagation()
        }}
      >
        <div className="sl-straighten-title">{t('straightenViewer.title')}</div>
        <Slider
          label={t('straightenViewer.angle')}
          value={Math.max(-45, Math.min(45, angle))}
          min={-45}
          max={45}
          step={0.1}
          format={() => formatDecimal(angle, 1) + '°'}
          hint={t('straightenViewer.angleHint')}
          onChange={set}
        />
        <div className="sl-straighten-row">
          <label className="sl-straighten-field">
            <span>{t('straightenViewer.degrees')}</span>
            <input
              type="number"
              step={0.1}
              className="sl-settings-field sl-mono"
              value={text ?? String(angle)}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                const v = Number((text ?? '').replace(',', '.'))
                if (text !== null && Number.isFinite(v)) set(v)
                setText(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
          </label>
          <Button variant="ghost" onClick={() => set(0)} title={t('straightenViewer.resetHint')}>
            {t('straightenViewer.reset')}
          </Button>
        </div>
        <div className="sl-straighten-row">
          <Button
            variant={lineTrace ? 'primary' : 'secondary'}
            onClick={() => useStraighten.setState({ lineTrace: !lineTrace })}
            title={t('straightenViewer.traceHint')}
          >
            {lineTrace ? t('straightenViewer.tracing') : t('straightenViewer.trace')}
          </Button>
          <Button
            onClick={() =>
              north !== null ? set(shownRotation + north) : notify('info', t('straightenViewer.needsSolution'))
            }
            disabledValue={north === null}
            title={
              north === null
                ? t('straightenViewer.northUnavailableHint')
                : t('straightenViewer.northHint')
            }
          >
            {t('straightenViewer.northUp')}
          </Button>
        </div>
        <Toggle
          label={t('straightenViewer.trimEdges')}
          active={trimEdges}
          onChange={(v) => useStraighten.setState({ trimEdges: v })}
          hint={t('straightenViewer.trimEdgesHint')}
        />
        <div className="sl-straighten-actions">
          <Button variant="ghost" onClick={closeStraighten}>
            {t('straightenViewer.cancel')}
          </Button>
          <Button
            variant="primary"
            disabledValue={busy}
            onClick={() => {
              void applyStraightening().then((error) => {
                if (error) notify('error', error)
              })
            }}
          >
            {t('straightenViewer.apply')}
          </Button>
        </div>
      </div>
    </>
  )
}

/** Transparent layer over the viewer for drawing the straightening line. */
function LineTrace({ onEnd }: { onEnd: (delta: number) => void }): JSX.Element {
  const origin = useRef<{ x: number; y: number } | null>(null)
  const [line, setLine] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null)
  const position = (e: React.MouseEvent): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  return (
    <div
      className="sl-straighten-line"
      onMouseDown={(e) => {
        e.stopPropagation()
        const p = position(e)
        origin.current = p
        setLine({ a: p, b: p })
      }}
      onMouseMove={(e) => {
        e.stopPropagation()
        if (origin.current) setLine({ a: origin.current, b: position(e) })
      }}
      onMouseUp={(e) => {
        e.stopPropagation()
        const a = origin.current
        origin.current = null
        if (!a) return
        const b = position(e)
        setLine(null)
        // A click without dragging does not count.
        if (Math.hypot(b.x - a.x, b.y - a.y) >= 10) onEnd(angleToStraighten(a, b))
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      {line ? (
        <svg className="sl-straighten-svg">
          <line x1={line.a.x} y1={line.a.y} x2={line.b.x} y2={line.b.y} />
        </svg>
      ) : null}
    </div>
  )
}
