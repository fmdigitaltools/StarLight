import { useMemo, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Button, Toggle } from '../components/Controls'
import { FolderIcon, TrashIcon } from '../components/Icons'
import { writeSettings, useSettings } from '../settings'
import {
  MAX_FLAT_AGE_DAYS,
  TEMPERATURE_TOLERANCE,
  describeMaster,
  type FrameConditions,
  type MasterEntry
} from '@core/stack/calibrationLibrary'
import { noDarkReason, chooseForLight } from '@core/stack/calibrationGroups'
import { conditionsOf, removeFromLibrary, useCalibrationLibrary } from '../calibration/library'
import type { LoadedFrame } from '@shared/types'
import { formatDate, formatNumber, t } from '@shared/i18n/i18n'

/**
 * "Calibration library" card of the Calibrate panel: automatic reuse, the
 * masters that will be used for the frames of this session, and the list of
 * stored masters, each of which can be removed.
 */

/** Channels of the reconstructed image: raw frames from a color sensor become RGB. */
function rebuiltChannels(f: LoadedFrame): 1 | 3 {
  return f.channels === 1 && f.metadata.bayer !== 'NONE' ? 3 : f.channels
}

/** Groups of light frames sharing the same capture conditions. */
function lightGroups(frame: LoadedFrame[]): { conditions: FrameConditions; count: number }[] {
  const groups = new Map<string, { conditions: FrameConditions; count: number }>()
  for (const f of frame) {
    if (f.excluded || f.metadata.frameType !== 'light') continue
    const c = conditionsOf(f.metadata, f.width, f.height, rebuiltChannels(f))
    const key = [c.width, c.height, c.channels, c.bayer, c.exposure, c.gain, c.temperature === null ? '' : Math.round(c.temperature), c.filter].join('|')
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { conditions: c, count: 1 })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

function data(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? formatDate(d, { day: 'numeric', month: 'long', year: 'numeric' }) : ''
}

function megabyte(byte: number): string {
  return formatNumber(byte / (1024 * 1024), { maximumFractionDigits: 1 }) + ' MB'
}

export function CalibrationLibraryTab(): JSX.Element {
  const settings = useSettings()
  const entries = useCalibrationLibrary((s) => s.entries)
  const frame = useApp((s) => s.frame)
  const master = useApp((s) => s.master)
  const [deleting, setDeleting] = useState<string | null>(null)
  const notify = useApp((s) => s.notify)

  const groups = useMemo(() => lightGroups(frame).slice(0, 4), [frame])
  const sortedList = useMemo(() => [...entries].sort((a, b) => Date.parse(b.created) - Date.parse(a.created)), [entries])

  // Same rules as stacking: first the session masters with matching
  // conditions, then the library if reuse is enabled.
  const session = useMemo(() => master.groups.map((g) => g.entry), [master])
  const library = settings.calibrationLibrary ? entries : []
  const row = (type: 'dark' | 'flat' | 'bias', c: FrameConditions): string => {
    const choice = chooseForLight(session, library, c)
    const m = choice[type]
    if (m) {
      const text =
        m.origin === 'session'
          ? t('calibrationLibraryTab.usage.session', { master: describeMaster(m.entry) })
          : t('calibrationLibraryTab.usage.library', { master: describeMaster(m.entry), date: data(m.entry.created) })
      return m.note ? t('calibrationLibraryTab.usage.withNote', { text, note: m.note }) : text
    }
    if (type === 'bias' && choice.dark) return t('calibrationLibraryTab.usage.biasNotNeeded')
    if (type === 'dark') {
      const reason = noDarkReason([...session, ...library], c)
      if (reason) return t('calibrationLibraryTab.usage.noSuitableDark', { reason })
    }
    if (!settings.calibrationLibrary) return t('calibrationLibraryTab.usage.noneInSessionReuseOff')
    return t('calibrationLibraryTab.usage.noneAnywhere')
  }

  async function remove(v: MasterEntry): Promise<void> {
    setDeleting(v.id)
    try {
      await removeFromLibrary(v.id)
      notify('ok', t('calibrationLibraryTab.removed', { master: describeMaster(v) }))
    } catch (e) {
      notify('error', t('calibrationLibraryTab.removeFailed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <Tab
      title={t('calibrationLibraryTab.title')}
      description={t('calibrationLibraryTab.description', {
        tolerance: TEMPERATURE_TOLERANCE,
        maxDays: MAX_FLAT_AGE_DAYS
      })}
      data="tab-calibration-library"
    >
      <Toggle
        label={t('calibrationLibraryTab.reuse.label')}
        active={settings.calibrationLibrary}
        onChange={(v) => void writeSettings({ calibrationLibrary: v })}
        hint={t('calibrationLibraryTab.reuse.hint')}
      />

      {groups.length > 0 ? (
        <div className="sl-libcal-groups">
          {groups.map((g, i) => (
            <div key={i} className="sl-libcal-group">
              <div className="sl-libcal-group-title">
                {t(g.count === 1 ? 'calibrationLibraryTab.group.lightsOne' : 'calibrationLibraryTab.group.lightsOther', {
                  count: g.count
                })}
                {g.conditions.exposure !== null
                  ? t('calibrationLibraryTab.group.exposure', { value: formatNumber(g.conditions.exposure) })
                  : ''}
                {g.conditions.gain !== null
                  ? t('calibrationLibraryTab.group.gain', { value: formatNumber(g.conditions.gain) })
                  : ''}
                {g.conditions.temperature !== null
                  ? t('calibrationLibraryTab.group.temperature', {
                      value: formatNumber(g.conditions.temperature, { maximumFractionDigits: 1 })
                    })
                  : ''}
              </div>
              {(['dark', 'flat', 'bias'] as const).map((type) => (
                <div key={type} className="sl-libcal-choice">
                  <span className="sl-libcal-type">{t('calibrationLibraryTab.type.' + type)}</span>
                  <span>{row(type, g.conditions)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {sortedList.length === 0 ? (
        <p className="sl-note">{t('calibrationLibraryTab.empty')}</p>
      ) : (
        <ul className="sl-libcal-list" aria-label={t('calibrationLibraryTab.listAriaLabel')}>
          {sortedList.map((v) => (
            <li key={v.id} className="sl-libcal-item">
              <div className="sl-libcal-text">
                <span className="sl-libcal-name">{describeMaster(v)}</span>
                <span className="sl-libcal-details">
                  {t(v.frame === 1 ? 'calibrationLibraryTab.details.framesOne' : 'calibrationLibraryTab.details.framesOther', {
                    date: data(v.created),
                    count: v.frame,
                    width: v.width,
                    height: v.height,
                    size: megabyte(v.byte)
                  })}
                  {v.instrument ? ' · ' + v.instrument : ''}
                </span>
              </div>
              <Button
                variant="ghost"
                icon={<TrashIcon size={14} />}
                disabledValue={deleting !== null}
                onClick={() => void remove(v)}
                title={t('calibrationLibraryTab.delete.title')}
              >
                {t('calibrationLibraryTab.delete.label')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button icon={<FolderIcon size={15} />} onClick={() => void window.starlight.openCalibrationFolder()}>
        {t('calibrationLibraryTab.openFolder')}
      </Button>
    </Tab>
  )
}
