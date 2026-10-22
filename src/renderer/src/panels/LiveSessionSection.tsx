import { useEffect, useState, type JSX } from 'react'
import { Tab, Button, Toggle, DataEntry, Label } from '../components/Controls'
import { FolderIcon, EyeIcon } from '../components/Icons'
import type { StartOptions } from '../hooks/useStacking'
import {
  useSession,
  startSession,
  stopSession,
  setFolder,
  setSessionOptions,
  loadRememberedFolder,
  browseFolder,
  type NoisePoint,
  setKeepAccepted
} from '../hooks/useSession'
import { formatDate, formatDecimal, t } from '@shared/i18n/i18n'
import '../styles/session.css'

/**
 * "Live session" section of the Stack panel: watches the folder where the
 * frames arrive and re-stacks on every arrival, with the same choices
 * (method, thresholds, alignment) set in the panel.
 */
export function LiveSessionSection({ options }: { options: StartOptions }): JSX.Element {
  const s = useSession()
  const [includeExisting, setIncludeExisting] = useState(true)
  const [startup, setStart] = useState(false)

  useEffect(() => {
    void loadRememberedFolder()
  }, [])

  // The panel choices also apply to the upcoming live stacks.
  useEffect(() => {
    setSessionOptions(options)
  }, [options])

  const start = async (): Promise<void> => {
    setStart(true)
    try {
      await startSession(includeExisting)
    } finally {
      setStart(false)
    }
  }

  const last = s.noiseHistory[s.noiseHistory.length - 1]

  let state: JSX.Element
  if (!s.reachable) state = <Label color="red">{t('liveSessionSection.state.unreachable')}</Label>
  else if (s.stackingInProgress) state = <Label color="cyan">{t('liveSessionSection.state.stacking')}</Label>
  else if (s.analyzing > 0) state = <Label color="cyan">{t('liveSessionSection.state.analyzing')}</Label>
  else state = <Label color="lime">{t('liveSessionSection.state.listening')}</Label>

  return (
    <Tab
      title={t('liveSessionSection.title')}
      action={s.active ? state : undefined}
      description={t('liveSessionSection.description')}
      data="tab-live-session"
    >
      <div className="sl-session-folder">
        <input
          className="sl-session-field sl-mono"
          type="text"
          value={s.folder}
          placeholder={t('liveSessionSection.folder.placeholder')}
          spellCheck={false}
          disabled={s.active}
          onChange={(e) => setFolder(e.target.value)}
          title={t('liveSessionSection.folder.hint')}
        />
        <Button
          icon={<FolderIcon size={15} />}
          disabledValue={s.active}
          onClick={() => void browseFolder()}
          title={t('liveSessionSection.folder.browseHint')}
        >
          {t('liveSessionSection.folder.browse')}
        </Button>
      </div>

      {!s.active ? (
        <Toggle
          label={t('liveSessionSection.includeExisting.label')}
          active={includeExisting}
          onChange={setIncludeExisting}
          hint={t('liveSessionSection.includeExisting.hint')}
        />
      ) : null}

      <Toggle
        label={t('liveSessionSection.keepAccepted.label')}
        active={s.keepAccepted}
        onChange={setKeepAccepted}
        hint={t('liveSessionSection.keepAccepted.hint')}
      />

      <Button
        variant={s.active ? 'danger' : 'secondary'}
        fullWidth
        icon={<EyeIcon size={16} />}
        disabledValue={startup || (!s.active && s.folder.trim() === '')}
        onClick={() => void (s.active ? stopSession() : start())}
        data="live-session-button"
      >
        {s.active
          ? t('liveSessionSection.stop')
          : startup
            ? t('liveSessionSection.starting')
            : t('liveSessionSection.start')}
      </Button>

      {s.active && s.mode === 'polling' ? (
        <p className="sl-session-note">
          {t('liveSessionSection.pollingNotice')}
        </p>
      ) : null}

      {s.networkNotice ? <p className="sl-session-notice">{s.networkNotice}</p> : null}

      {s.active || s.arrived > 0 ? (
        <>
          <DataEntry name={t('liveSessionSection.stats.arrived')} value={s.arrived} />
          {s.incoming.length > 0 ? (
            <DataEntry
              name={t('liveSessionSection.stats.incoming')}
              value={s.incoming.length}
              hint={t('liveSessionSection.stats.incomingHint', { files: s.incoming.join(', ') })}
            />
          ) : null}
          <DataEntry name={t('liveSessionSection.stats.stacked')} value={s.usedFrames} />
          <DataEntry
            name={t('liveSessionSection.stats.rejected')}
            value={s.rejected.length}
            hint={t('liveSessionSection.stats.rejectedHint')}
          />
          {s.suggestedCrop ? (
            <DataEntry
              name={t('liveSessionSection.stats.edges')}
              value={t('liveSessionSection.stats.edgesValue')}
              hint={t('liveSessionSection.stats.edgesHint')}
            />
          ) : null}
          {last ? (
            <DataEntry
              name={t('liveSessionSection.stats.noiseReduced')}
              value={
                last.noise > 0
                  ? t('liveSessionSection.stats.noiseTimes', { times: formatDecimal(last.singleNoise / last.noise, 2) })
                  : t('liveSessionSection.stats.notMeasurable')
              }
              hint={t('liveSessionSection.stats.noiseHint', {
                expected: formatDecimal(Math.sqrt(last.frame), 2),
                frames: last.frame
              })}
            />
          ) : null}
          {s.lastUpdate !== null ? (
            <DataEntry
              name={t('liveSessionSection.stats.updatedAt')}
              value={formatDate(new Date(s.lastUpdate), { timeStyle: 'medium' })}
              hint={t('liveSessionSection.stats.lastDuration', { seconds: formatDecimal(s.lastDuration, 1) })}
            />
          ) : s.active ? (
            <p className="sl-session-note">{t('liveSessionSection.waitingImage')}</p>
          ) : null}

          {s.noiseHistory.length >= 2 ? <NoiseChart points={s.noiseHistory} /> : null}

          {s.problem ? <p className="sl-session-notice">{s.problem}</p> : null}

          {s.rejected.length > 0 ? (
            <ul className="sl-session-rejects">
              {s.rejected.slice(-8).map((x, i) => (
                <li key={x.fileName + i}>
                  <span className="sl-mono">{x.fileName}</span>
                  <span className="sl-reason">{x.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </Tab>
  )
}

/**
 * Noise trend at each stack, relative to the first one. The dashed line is
 * the decrease predicted by theory (square root of the number of frames):
 * if the measured line stays close to it, the frames are helping.
 */
function NoiseChart({ points }: { points: NoisePoint[] }): JSX.Element {
  const L = 200
  const A = 60
  const first = points[0]
  const minFrame = first.frame
  const maxFrame = Math.max(minFrame + 1, points[points.length - 1].frame)
  const x = (n: number): number => ((n - minFrame) / (maxFrame - minFrame)) * L
  // Vertical axis: noise relative to the first stack, from 1 at the top to 0 at the bottom.
  const y = (relative: number): number => A - Math.min(1, Math.max(0, relative)) * (A - 2) - 1

  const measured = points
    .map(
      (p, i) =>
        (i === 0 ? 'M' : 'L') +
        x(p.frame).toFixed(1) +
        ' ' +
        y(first.noise > 0 ? p.noise / first.noise : 1).toFixed(1)
    )
    .join(' ')
  const theory: string[] = []
  for (let i = 0; i <= 24; i++) {
    const n = minFrame + ((maxFrame - minFrame) * i) / 24
    theory.push((i === 0 ? 'M' : 'L') + x(n).toFixed(1) + ' ' + y(Math.sqrt(minFrame / n)).toFixed(1))
  }

  return (
    <div>
      <svg
        className="sl-session-chart"
        viewBox={'0 0 ' + L + ' ' + A}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('liveSessionSection.chart.label')}
      >
        <path className="sl-theory" d={theory.join(' ')} />
        <path className="sl-measured" d={measured} />
      </svg>
      <div className="sl-session-legend">
        <span>{t('liveSessionSection.chart.measured')}</span>
        <span className="sl-theory">{t('liveSessionSection.chart.theory')}</span>
      </div>
    </div>
  )
}
