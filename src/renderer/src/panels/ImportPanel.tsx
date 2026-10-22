import type { JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Button, DataEntry, Label } from '../components/Controls'
import { TrashIcon, EyeIcon, EyeClosedIcon } from '../components/Icons'
import { useLibrary } from '../hooks/useLibrary'
import { describeInstrument, describeFocuser, describeLocation } from '@core/catalog/instrument'
import { formatRightAscension, formatDeclination } from '@core/catalog/recognition'
import { formatBytes } from '@core/memory'
import type { ImageFormat, FrameType, LoadedFrame } from '@shared/types'
import { FrameThumbnail } from '../components/FrameThumbnail'
import { formatDecimal, t } from '@shared/i18n/i18n'

/** Language key of the display name of each file format in the frame data. */
const FORMAT_NAME_KEYS: Record<ImageFormat, string> = {
  fits: 'importPanel.format.fits',
  'fits-compressed': 'importPanel.format.fitsCompressed',
  'fits-gzip': 'importPanel.format.fitsGzip',
  xisf: 'importPanel.format.xisf',
  tiff: 'importPanel.format.tiff',
  png: 'importPanel.format.png'
}

/** Language key of the name of each frame type in the list. */
const TYPE_NAME_KEYS: Record<FrameType, string | null> = {
  stacked: 'importPanel.frameType.stacked',
  light: 'importPanel.frameType.light',
  dark: 'importPanel.frameType.dark',
  flat: 'importPanel.frameType.flat',
  bias: 'importPanel.frameType.bias',
  unknown: null
}

/**
 * Details of a frame in the library, one per row: what it is, when it was
 * captured, with which exposure and filter, and how large it is. They help
 * tell apart dozens of files with similar names. The panel is narrow, so
 * each row must stay short and missing data is omitted.
 */
function frameRows(f: LoadedFrame): string[] {
  const m = f.metadata
  const lines: string[] = []

  const typeKey = TYPE_NAME_KEYS[m.frameType]
  const type = typeKey ? t(typeKey) : null
  const object = m.object?.trim() || null
  const what = [object, type].filter(Boolean).join(' · ')
  if (what) lines.push(what)

  if (m.dateObs) lines.push(localDateTime(m.dateObs))

  const exposure: string[] = []
  if (m.frameType === 'stacked' && m.stackCount !== null && m.exposure !== null) {
    exposure.push(m.stackCount + ' × ' + m.exposure + ' s')
  } else if (m.exposure !== null) {
    exposure.push(t('importPanel.rows.exposure', { value: m.exposure }))
  }
  if (m.filter) exposure.push(t('importPanel.rows.filter', { filter: m.filter }))
  if (exposure.length > 0) lines.push(exposure.join(' · '))

  lines.push(t('importPanel.rows.size', { width: f.width, height: f.height }))
  return lines
}

/**
 * DATE-OBS is in Universal Time per the FITS standard: here it is converted
 * to the computer's local time and written as day/month/year. If the value
 * cannot be parsed it is shown as it appears in the file.
 */
function localDateTime(dateObs: string): string {
  const withTimezone = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(dateObs) ? dateObs : dateObs + 'Z'
  const timestamp = new Date(withTimezone)
  if (Number.isNaN(timestamp.getTime())) return dateObs.replace('T', ' ').slice(0, 16)
  const two = (n: number): string => String(n).padStart(2, '0')
  const data = two(timestamp.getDate()) + '/' + two(timestamp.getMonth() + 1) + '/' + timestamp.getFullYear()
  if (!dateObs.includes('T')) return data
  return t('importPanel.dateTime', { date: data, time: two(timestamp.getHours()) + ':' + two(timestamp.getMinutes()) })
}

/** List of imported frames and details of the open frame. */
export function ImportPanel(): JSX.Element {
  const frame = useApp((s) => s.frame)
  const activeFrameId = useApp((s) => s.activeFrameId)
  const removeFrame = useApp((s) => s.removeFrame)
  const clearLibrary = useApp((s) => s.clearLibrary)
  const toggleExclusion = useApp((s) => s.toggleExclusion)
  const { openFrame } = useLibrary()

  const active = frame.find((f) => f.id === activeFrameId) ?? null
  const bundled = frame.filter((f) => !f.excluded).length
  const m = active?.metadata
  const focuser = m ? describeFocuser(m) : null
  const place = m ? describeLocation(m) : null

  return (
    <>
      {/* The import commands live in the top bar (Import frames, Folder) and
          in the File menu, so they are not repeated here. With an empty
          library only a pointer to them is shown. */}
      {frame.length === 0 ? (
        <Tab title={t('importPanel.library.title')} data="tab-library">
          <p className="sl-note">{t('importPanel.library.empty')}</p>
        </Tab>
      ) : null}

      {frame.length > 0 ? (
        <Tab
          title={t('importPanel.library.title')}
          action={
            <Label color="cyan">
              {bundled} / {frame.length}
            </Label>
          }
          description={t('importPanel.library.description')}
          data="tab-library"
        >
          <div className="sl-library sl-library-thumbnails">
            {frame.map((f) => {
              const classes = ['sl-frame']
              if (f.id === activeFrameId) classes.push('sl-active')
              if (f.excluded) classes.push('sl-excluded')
              return (
                <div key={f.id} className={classes.join(' ')}>
                  <button
                    type="button"
                    className="sl-frame-open sl-frame-open-row"
                    onClick={() => void openFrame(f.id)}
                    title={f.path}
                  >
                    <FrameThumbnail path={f.path} fileName={f.fileName} />
                    <span className="sl-frame-rows">
                      <span className="sl-frame-name">{f.fileName}</span>
                      {frameRows(f).map((row, i) => (
                        <span key={i} className="sl-frame-meta">
                          {row}
                        </span>
                      ))}
                    </span>
                  </button>
                  <div className="sl-frame-actions">
                    <button
                      type="button"
                      className="sl-frame-action"
                      onClick={() => toggleExclusion(f.id)}
                      title={f.excluded ? t('importPanel.library.include') : t('importPanel.library.exclude')}
                    >
                      {f.excluded ? <EyeClosedIcon size={15} /> : <EyeIcon size={15} />}
                    </button>
                    <button
                      type="button"
                      className="sl-frame-action"
                      onClick={() => removeFrame(f.id)}
                      title={t('importPanel.library.remove')}
                    >
                      <TrashIcon size={15} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <Button
            variant="danger"
            fullWidth
            icon={<TrashIcon size={17} />}
            onClick={clearLibrary}
          >
            {t('importPanel.library.clear')}
          </Button>
        </Tab>
      ) : null}

      {active && m ? (
        <Tab
          title={t('importPanel.data.title')}
          data="tab-data"
          description={
            m.format === 'tiff' || m.format === 'png'
              ? t(m.object !== null ? 'importPanel.data.pixelsOnlyWithObject' : 'importPanel.data.pixelsOnlyWithoutObject', {
                  format: m.format === 'tiff' ? 'TIFF' : 'PNG'
                })
              : undefined
          }
        >
          <DataEntry name={t('importPanel.data.object')} value={m.object ?? t('importPanel.data.notDeclaredMasculine')} />
          <DataEntry name={t('importPanel.data.instrument')} value={describeInstrument(m)} />
          {m.ra !== null ? (
            <DataEntry name={t('importPanel.data.rightAscension')} value={formatRightAscension(m.ra)} />
          ) : null}
          {m.dec !== null ? (
            <DataEntry name={t('importPanel.data.declination')} value={formatDeclination(m.dec)} />
          ) : null}
          <DataEntry
            name={t('importPanel.data.exposure')}
            value={m.exposure !== null ? m.exposure + ' s' : t('importPanel.data.notDeclaredFeminine')}
          />
          {m.stackCount !== null ? (
            <DataEntry name={t('importPanel.data.stackCount')} value={m.stackCount} />
          ) : null}
          {m.totalExposure !== null ? (
            <DataEntry
              name={t('importPanel.data.totalExposure')}
              value={
                m.totalExposure >= 60
                  ? Math.floor(m.totalExposure / 60) + ' min ' + (m.totalExposure % 60) + ' s'
                  : m.totalExposure + ' s'
              }
            />
          ) : null}
          <DataEntry name={t('importPanel.data.gain')} value={m.gain !== null ? m.gain : t('importPanel.data.notDeclaredMasculine')} />
          <DataEntry
            name={t('importPanel.data.sensorTemperature')}
            value={m.sensorTemp !== null ? formatDecimal(m.sensorTemp, 1) + ' °C' : t('importPanel.data.notDeclaredFeminine')}
          />
          <DataEntry name={t('importPanel.data.filter')} value={m.filter ?? t('importPanel.data.noFilter')} />
          {focuser !== null ? (
            <DataEntry
              name={t('importPanel.data.focuser.name')}
              value={focuser}
              hint={t('importPanel.data.focuser.hint')}
            />
          ) : null}
          {place !== null ? (
            <DataEntry
              name={t('importPanel.data.location.name')}
              value={place}
              hint={t('importPanel.data.location.hint')}
            />
          ) : null}
          <DataEntry
            name={t('importPanel.data.bayer.name')}
            value={m.bayer === 'NONE' ? t('importPanel.data.bayer.colorImage') : m.bayer}
            hint={t('importPanel.data.bayer.hint')}
          />
          <DataEntry
            name={t('importPanel.data.pixelScale.name')}
            value={
              m.pixelScale !== null
                ? t('importPanel.data.pixelScale.value', { value: formatDecimal(m.pixelScale, 2) })
                : t('importPanel.data.pixelScale.unavailable')
            }
            hint={t('importPanel.data.pixelScale.hint')}
          />
          {m.format !== undefined && m.format !== 'fits' ? (
            <DataEntry name={t('importPanel.data.format')} value={t(FORMAT_NAME_KEYS[m.format])} />
          ) : null}
          <DataEntry
            name={t('importPanel.data.bitDepth.name')}
            value={t(active.bitpix < 0 ? 'importPanel.data.bitDepth.floatingPoint' : 'importPanel.data.bitDepth.integer', {
              bits: Math.abs(active.bitpix)
            })}
          />
          <DataEntry name={t('importPanel.data.fileSize')} value={formatBytes(active.sizeBytes)} />
          {m.dateObs !== null ? (
            <DataEntry name={t('importPanel.data.captureStart')} value={localDateTime(m.dateObs)} />
          ) : null}
        </Tab>
      ) : null}

      {active && active.stats.max > 0 ? (
        <Tab title={t('importPanel.stats.title')} description={t('importPanel.stats.description')}>
          <DataEntry name={t('importPanel.stats.min')} value={formatDecimal(active.stats.min, 5)} />
          <DataEntry name={t('importPanel.stats.median')} value={formatDecimal(active.stats.median, 5)} />
          <DataEntry name={t('importPanel.stats.mean')} value={formatDecimal(active.stats.mean, 5)} />
          <DataEntry name={t('importPanel.stats.max')} value={formatDecimal(active.stats.max, 5)} />
          <DataEntry
            name={t('importPanel.stats.noise.name')}
            value={formatDecimal(active.stats.mad * 1.4826, 6)}
            hint={t('importPanel.stats.noise.hint')}
          />
          <DataEntry
            name={t('importPanel.stats.saturated.name')}
            value={formatDecimal(active.stats.saturatedPct, 3) + ' %'}
            hint={t('importPanel.stats.saturated.hint')}
          />
        </Tab>
      ) : null}
    </>
  )
}
