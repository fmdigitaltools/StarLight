import type { JSX } from 'react'
import type { LoadedFrame } from '@shared/types'
import { Tab, Button, Segmented, DataEntry, Label } from '../components/Controls'
import { cometName, type CometMode } from '@core/stack/comet'
import { useCometNucleus, type NucleusPoint, type WhichNucleus } from '../hooks/cometNucleus'
import { useLibrary } from '../hooks/useLibrary'
import { shotTimestamp, type CometResult, type CometOptions } from '../hooks/useStacking'
import { formatDecimal, t } from '@shared/i18n/i18n'

/**
 * "Comet" card of the Stack step: what must stay still in the result and
 * how to find the nucleus. The computation lives in `@core/stack/comet`,
 * the orchestration in `useStacking`.
 */

export type NucleusMode = 'automatic' | 'manual'

/** Comet modes; label, hint and explanation are language keys under `cometSection.mode.<value>`. */
const MODES: CometMode[] = ['stars', 'comet', 'both']

/** Nucleus search modes; label and hint are language keys under `cometSection.nucleusMode.<value>`. */
const NUCLEUS_MODES: NucleusMode[] = ['automatic', 'manual']

/** Light frames in shot order (or in library order when the date is missing). */
function inShotOrder(lights: LoadedFrame[]): LoadedFrame[] {
  const timestamps = lights.map((f) => shotTimestamp(f.metadata))
  if (timestamps.some((t) => t === undefined)) return lights
  return lights
    .map((f, i) => ({ f, t: timestamps[i] as number }))
    .sort((a, b) => a.t - b.t)
    .map((x) => x.f)
}

interface Props {
  lights: LoadedFrame[]
  mode: CometMode
  onMode: (m: CometMode) => void
  nucleus: NucleusMode
  onNucleus: (n: NucleusMode) => void
  disabledValue: boolean
}

/**
 * The comet options to pass to stacking, or the reason why stacking cannot
 * start yet (a click is missing).
 */
export function cometOptions(
  lights: LoadedFrame[],
  mode: CometMode,
  nucleus: NucleusMode,
  points: { first: NucleusPoint | null; last: NucleusPoint | null }
): { options?: CometOptions; isMissing?: string } {
  if (mode === 'stars') return {}
  if (nucleus === 'automatic') return { options: { mode, nucleus: 'automatic' } }
  const sortedItems = inShotOrder(lights)
  const first = sortedItems[0]
  const last = sortedItems[sortedItems.length - 1]
  const p = points.first && first && points.first.frameId === first.id ? points.first : null
  const u = points.last && last && points.last.frameId === last.id ? points.last : null
  if (!p || !u) {
    return { isMissing: t('cometSection.missingNucleus') }
  }
  return { options: { mode, nucleus: { first: p, last: u } } }
}

export function CometSection({ lights, mode, onMode, nucleus, onNucleus, disabledValue }: Props): JSX.Element {
  const { openFrame } = useLibrary()
  const firstPoint = useCometNucleus((s) => s.first)
  const lastPoint = useCometNucleus((s) => s.last)
  const wait = useCometNucleus((s) => s.wait)
  const ask = useCometNucleus((s) => s.ask)

  const sortedItems = inShotOrder(lights)
  const first = sortedItems[0]
  const last = sortedItems[sortedItems.length - 1]
  const declared = lights.find((f) => cometName(f.metadata.object))?.metadata.object ?? null

  async function indicate(which: WhichNucleus): Promise<void> {
    const frame = which === 'first' ? first : last
    if (!frame) return
    if (!(await openFrame(frame.id))) return
    ask(which, frame.id)
  }

  function pointState(which: WhichNucleus): string {
    const frame = which === 'first' ? first : last
    const point = which === 'first' ? firstPoint : lastPoint
    if (wait && wait.which === which) return t('cometSection.point.waiting')
    if (point && frame && point.frameId === frame.id) {
      return t('cometSection.point.set', { x: Math.round(point.x), y: Math.round(point.y) })
    }
    return t('cometSection.point.toSet')
  }

  return (
    <Tab
      title={t('cometSection.title')}
      action={declared && mode === 'stars' ? <Label color="amber">{declared}</Label> : undefined}
      description={t('cometSection.description')}
      data="tab-comet"
    >
      <Segmented
        value={mode}
        options={MODES.map((m) => ({
          value: m,
          label: t('cometSection.mode.' + m + '.label'),
          hint: t('cometSection.mode.' + m + '.hint')
        }))}
        onChange={onMode}
      />
      <p className="sl-card-desc">{t('cometSection.mode.' + mode + '.explanation')}</p>
      {declared && mode === 'stars' ? (
        <p className="sl-card-desc">
          {t('cometSection.declaredComet', { name: declared })}
        </p>
      ) : null}
      {mode !== 'stars' ? (
        <>
          <Segmented
            value={nucleus}
            options={NUCLEUS_MODES.map((n) => ({
              value: n,
              label: t('cometSection.nucleusMode.' + n + '.label'),
              hint: t('cometSection.nucleusMode.' + n + '.hint')
            }))}
            onChange={onNucleus}
          />
          {nucleus === 'automatic' ? (
            <p className="sl-card-desc">
              {t('cometSection.automaticExplanation')}
            </p>
          ) : (
            <>
              <p className="sl-card-desc">
                {t('cometSection.manualExplanation')}
              </p>
              <DataEntry name={first ? t('cometSection.firstFrameNamed', { file: first.fileName }) : t('cometSection.firstFrame')} value={pointState('first')} />
              <Button
                fullWidth
                disabledValue={disabledValue || !first}
                onClick={() => void indicate('first')}
                data="nucleus-first-button"
              >
                {t('cometSection.setFirst')}
              </Button>
              <DataEntry name={last ? t('cometSection.lastFrameNamed', { file: last.fileName }) : t('cometSection.lastFrame')} value={pointState('last')} />
              <Button
                fullWidth
                disabledValue={disabledValue || !last || last === first}
                onClick={() => void indicate('last')}
                data="nucleus-last-button"
              >
                {t('cometSection.setLast')}
              </Button>
            </>
          )}
        </>
      ) : null}
    </Tab>
  )
}

/** Summary rows after a comet stack. */
export function CometSummary({ comet }: { comet: CometResult }): JSX.Element {
  const modeName = t('cometSection.summary.modeName.' + (comet.mode === 'comet' || comet.mode === 'both' ? comet.mode : 'stars'))
  return (
    <>
      <DataEntry name={t('cometSection.summary.comet')} value={modeName} />
      <DataEntry
        name={t('cometSection.summary.nucleus')}
        value={t(
          comet.nucleus === 'automatic' ? 'cometSection.summary.nucleusAutomatic' : 'cometSection.summary.nucleusManual',
          { measured: comet.measured, total: comet.frame }
        )}
        hint={t('cometSection.summary.nucleusHint')}
      />
      <DataEntry
        name={t('cometSection.summary.path')}
        value={formatDecimal(comet.pathLength, 1) + ' px'}
        hint={t('cometSection.summary.pathHint')}
      />
      {comet.speed !== null ? (
        <DataEntry
          name={t('cometSection.summary.speed')}
          value={t('cometSection.summary.speedValue', { speed: formatDecimal(comet.speed, 1) })}
        />
      ) : (
        <DataEntry
          name={t('cometSection.summary.speed')}
          value={t('cometSection.summary.speedUnknown')}
          hint={t('cometSection.summary.speedUnknownHint')}
        />
      )}
      <DataEntry
        name={t('cometSection.summary.deviation')}
        value={formatDecimal(comet.deviation, 2) + ' px'}
        hint={t('cometSection.summary.deviationHint')}
      />
    </>
  )
}
