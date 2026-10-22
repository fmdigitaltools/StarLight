import { useEffect, useMemo, useRef, type JSX } from 'react'
import { Tab, Button, Toggle, DataEntry, Label } from '../components/Controls'
import { ObjectsIcon } from '../components/Icons'
import { useApp } from '../store/appStore'
import { useLibrary } from '../hooks/useLibrary'
import { scaleArcsec } from '@core/astrometry/wcs'
import { formatBytes } from '@core/memory'
import {
  useMosaic,
  togglePanel,
  setBlend,
  mosaicCandidates,
  evaluateChoice,
  composeChosenMosaic,
  type MosaicResult
} from '../hooks/useMosaic'
import { formatDecimal, formatNumber, t } from '@shared/i18n/i18n'
import '../styles/mosaic.css'

/** Outline colors in the preview, one per panel. */
const COLORS = ['var(--sl-cyan)', 'var(--sl-magenta)', 'var(--sl-lime)', 'var(--sl-amber)', 'var(--sl-violet)']


/**
 * "Mosaic" section of the Stack panel: joins several adjacent fields, each
 * with its own astrometric solution, into a wider field.
 */
export function MosaicSection(): JSX.Element {
  const frame = useApp((s) => s.frame)
  const activeJob = useApp((s) => s.job.active)
  const { chosenItems, blend, inProgress, result } = useMosaic()
  const { openFrame } = useLibrary()

  const candidates = useMemo(() => mosaicCandidates(frame), [frame])
  const choice = useMemo(() => evaluateChoice(frame, chosenItems), [frame, chosenItems])

  const solve = async (id: string): Promise<void> => {
    if (!(await openFrame(id))) return
    const app = useApp.getState()
    app.setStep('objects')
    app.notify('info', t('mosaicSection.solveNotice'))
  }

  const withoutWcs = choice.withoutWcs.length

  return (
    <>
      <Tab
        title={t('mosaicSection.title')}
        action={chosenItems.length > 0 ? <Label color="cyan">{choice.validItems.length}</Label> : undefined}
        description={t('mosaicSection.description')}
        data="tab-mosaic"
      >
        {candidates.length === 0 ? (
          <p className="sl-mosaic-note">{t('mosaicSection.noCandidates')}</p>
        ) : (
          <div className="sl-library">
            {candidates.map((f) => {
              const chosen = chosenItems.includes(f.id)
              const wcs = f.metadata.wcs
              return (
                <div key={f.id} className={'sl-frame' + (chosen ? ' sl-active' : '')}>
                  <button
                    type="button"
                    className="sl-frame-open"
                    onClick={() => togglePanel(f.id)}
                    title={chosen ? t('mosaicSection.removePanel') : t('mosaicSection.addPanel')}
                  >
                    <span className="sl-frame-name">
                      <input type="checkbox" className="sl-mosaic-check" checked={chosen} readOnly tabIndex={-1} />
                      {f.fileName}
                    </span>
                    <span className="sl-frame-meta">
                      {wcs !== null
                        ? t('mosaicSection.panelSolved', {
                            width: f.width,
                            height: f.height,
                            scale: formatDecimal(scaleArcsec(wcs), 2)
                          })
                        : t('mosaicSection.panelUnsolved', { width: f.width, height: f.height })}
                    </span>
                  </button>
                  <div className="sl-frame-actions">
                    {wcs === null ? (
                      <button
                        type="button"
                        className="sl-frame-action"
                        onClick={() => void solve(f.id)}
                        title={t('mosaicSection.openToSolve')}
                      >
                        <ObjectsIcon size={15} />
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {withoutWcs > 0 ? (
          <p className="sl-mosaic-notice">
            {withoutWcs === 1
              ? t('mosaicSection.withoutWcsOne')
              : t('mosaicSection.withoutWcsOther', { count: withoutWcs })}
          </p>
        ) : null}

        {choice.geometry !== null ? <Preview choice={choice} /> : null}

        {choice.geometry !== null ? (
          <>
            <DataEntry
              name={t('mosaicSection.size')}
              value={formatNumber(choice.geometry.width) + ' x ' + formatNumber(choice.geometry.height)}
            />
            <DataEntry
              name={t('mosaicSection.scale.name')}
              value={t('mosaicSection.scale.value', { value: formatDecimal(choice.geometry.scale, 2) })}
              hint={t('mosaicSection.scale.hint')}
            />
            <DataEntry
              name={t('mosaicSection.memory.name')}
              value={t('mosaicSection.memory.value', { size: formatBytes(choice.memory) })}
              hint={t('mosaicSection.memory.hint')}
            />
          </>
        ) : choice.problem !== null && chosenItems.length > 0 ? (
          <p className="sl-mosaic-note">{choice.problem}</p>
        ) : null}

        <Toggle
          label={t('mosaicSection.blend.label')}
          active={blend}
          onChange={setBlend}
          hint={t('mosaicSection.blend.hint')}
        />

        <Button
          variant="primary"
          fullWidth
          disabledValue={inProgress || activeJob || choice.geometry === null}
          onClick={() => void composeChosenMosaic()}
          data="mosaic-button"
        >
          {inProgress ? t('mosaicSection.composing') : t('mosaicSection.compose')}
        </Button>
      </Tab>

      {result !== null ? <MosaicSummary result={result} /> : null}
    </>
  )
}

/** Layout of the panels on the sky, drawn as numbered outlines. */
function Preview({ choice }: { choice: ReturnType<typeof evaluateChoice> }): JSX.Element | null {
  const g = choice.geometry
  if (g === null) return null
  const strokeWidth = Math.max(g.width, g.height) / 160
  return (
    <div className="sl-mosaic-preview">
      <svg
        viewBox={-strokeWidth * 2 + ' ' + -strokeWidth * 2 + ' ' + (g.width + strokeWidth * 4) + ' ' + (g.height + strokeWidth * 4)}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t('mosaicSection.previewAriaLabel')}
      >
        <rect x={0} y={0} width={g.width} height={g.height} className="sl-mosaic-field" />
        {g.outlines.map((points, k) => {
          const color = COLORS[k % COLORS.length]
          let cx = 0
          let cy = 0
          for (const p of points) {
            cx += p.x
            cy += p.y
          }
          cx /= points.length
          cy /= points.length
          return (
            <g key={k}>
              <polygon
                points={points.map((p) => p.x + ',' + p.y).join(' ')}
                fill={color}
                fillOpacity={0.1}
                stroke={color}
                strokeWidth={strokeWidth}
              />
              <text
                x={cx}
                y={cy}
                fill={color}
                fontSize={strokeWidth * 9}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {k + 1}
              </text>
            </g>
          )
        })}
      </svg>
      <ol className="sl-mosaic-legend">
        {choice.validItems.map((f, k) => (
          <li key={f.id} style={{ color: COLORS[k % COLORS.length] }}>
            <span>{f.fileName}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Summary of the last mosaic, with the coverage map. */
function MosaicSummary({ result }: { result: MosaicResult }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const { data, width, height } = result.thumbnail
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(width, height)
    // No panel: transparent; one: dark blue; two: cyan; three or more: green.
    const tints: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [30, 70, 110, 255],
      [34, 200, 230, 255],
      [160, 240, 60, 255]
    ]
    for (let i = 0; i < data.length; i++) {
      const tint = tints[Math.min(3, data[i])]
      img.data[i * 4] = tint[0]
      img.data[i * 4 + 1] = tint[1]
      img.data[i * 4 + 2] = tint[2]
      img.data[i * 4 + 3] = tint[3]
    }
    ctx.putImageData(img, 0, 0)
  }, [result])

  return (
    <Tab
      title={t('mosaicSection.summary.title')}
      action={<Label color="lime">{t('mosaicSection.summary.panels', { count: result.panels.length })}</Label>}
      description={t('mosaicSection.summary.description')}
    >
      <DataEntry
        name={t('mosaicSection.summary.size')}
        value={formatNumber(result.width) + ' x ' + formatNumber(result.height)}
      />
      <DataEntry name={t('mosaicSection.scale.name')} value={t('mosaicSection.scale.value', { value: formatDecimal(result.scale, 2) })} />
      <DataEntry
        name={t('mosaicSection.summary.covered.name')}
        value={formatDecimal(result.coveredFraction * 100, 1) + '%'}
        hint={t('mosaicSection.summary.covered.hint')}
      />
      <DataEntry
        name={t('mosaicSection.summary.overlap.name')}
        value={formatDecimal(result.overlapFraction * 100, 1) + '%'}
        hint={t('mosaicSection.summary.overlap.hint')}
      />
      <DataEntry name={t('mosaicSection.summary.time')} value={formatDecimal(result.timeSeconds, 1) + ' s'} />
      <div className="sl-mosaic-coverage">
        <canvas ref={canvasRef} aria-label={t('mosaicSection.summary.coverageAriaLabel')} />
        <p className="sl-mosaic-note">
          {t('mosaicSection.summary.coverageLegend')} <span className="sl-mosaic-one">{t('mosaicSection.summary.coverageOne')}</span>,{' '}
          <span className="sl-mosaic-two">{t('mosaicSection.summary.coverageTwo')}</span>,{' '}
          <span className="sl-mosaic-three">{t('mosaicSection.summary.coverageThree')}</span>.
        </p>
      </div>
      <div className="sl-library">
        {result.panels.map((name, k) => {
          const c = result.corrections[k]
          const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length
          return (
            <div key={name + k} className="sl-frame">
              <div className="sl-frame-open">
                <span className="sl-frame-name">
                  {k + 1}. {name}
                </span>
                <span className="sl-frame-meta">
                  {t('mosaicSection.summary.correction', {
                    gain: formatDecimal(mean(c.gain), 3),
                    background: (mean(c.background) >= 0 ? '+' : '') + formatDecimal(mean(c.background), 4)
                  })}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {result.pairsWithoutGain > 0 ? (
        <p className="sl-mosaic-note">
          {result.pairsWithoutGain === 1
            ? t('mosaicSection.summary.pairsWithoutGainOne')
            : t('mosaicSection.summary.pairsWithoutGainOther', { count: result.pairsWithoutGain })}
        </p>
      ) : null}
      {result.isolated.length > 0 ? (
        <p className="sl-mosaic-notice">
          {t('mosaicSection.summary.isolated', { panels: result.isolated.join(', ') })}
        </p>
      ) : null}
    </Tab>
  )
}
