import { useEffect, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { Button, DataEntry, Label } from './Controls'
import { CloseIcon, InfoIcon } from './Icons'
import {
  APP_NAME,
  APP_VERSION,
  APP_STAGE,
  APP_CODENAME,
  AUTHOR,
  AUTHOR_EMAIL,
  rightsText,
  donationsNotice as donationsNoticeText,
  licenseNote
} from '@shared/version'
import { objectCount } from '@core/catalog/catalog'
import { CATALOG_SOURCE } from '@core/catalog/openNgcData'
import { formatBytes } from '@core/memory'
import { openDonations, useLicenseWindow } from './LicenseWindow'
import { LegalSections } from './LegalSections'
import { t } from '@shared/i18n/i18n'
import '../styles/license.css'

/** About window: version, author, computer, privacy and legal notes. */
export function AboutWindow(): JSX.Element {
  const setInfo = useApp((s) => s.setInfo)
  const [system, setSystem] = useState<Record<string, number | string> | null>(null)
  // GPU name; null while detecting, '' when WebGL 2 is missing, 'undeclared' when the driver reports no name.
  const [gpuName, setGpuName] = useState<string | null>(null)
  // Notice shown inside the window: temporary notices would stay hidden behind the window overlay.
  const [donationsNotice, setDonationsNotice] = useState(false)

  useEffect(() => {
    void window.starlight.systemInfo().then(setSystem)

    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      setGpuName(ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'undeclared')
    } else {
      setGpuName('')
    }
  }, [])

  const graphics =
    gpuName === null
      ? ''
      : gpuName === ''
        ? t('aboutWindow.gpu.noWebgl')
        : gpuName === 'undeclared'
          ? t('aboutWindow.gpu.undeclared')
          : gpuName

  return (
    <div className="sl-overlay" onClick={() => setInfo(false)}>
      <div className="sl-dialog sl-dialog-narrow" onClick={(e) => e.stopPropagation()}>
        <header className="sl-dialog-head">
          <InfoIcon size={22} />
          <div>
            <h2 className="sl-dialog-title">{APP_NAME}</h2>
            <p className="sl-dialog-subtitle">
              {t('aboutWindow.subtitle')}
            </p>
          </div>
          <div className="sl-topbar-spacer" />
          <Label color="cyan">{APP_STAGE}</Label>
        </header>

        <div className="sl-dialog-body">
          <h3 className="sl-guide-section-title">{t('aboutWindow.application.title')}</h3>
          <DataEntry name={t('aboutWindow.application.version')} value={APP_VERSION + ' ' + APP_STAGE} />
          <DataEntry name={t('aboutWindow.application.codename')} value={APP_CODENAME} />
          <DataEntry
            name={t('aboutWindow.application.catalog')}
            value={t('aboutWindow.application.catalogValue', { count: objectCount(), source: CATALOG_SOURCE })}
          />

          <h3 className="sl-guide-section-title">{t('aboutWindow.author.title')}</h3>
          <DataEntry name={t('aboutWindow.author.developedBy')} value={AUTHOR} />
          <DataEntry
            name={t('aboutWindow.author.contact')}
            value={<span className="sl-selectable">{AUTHOR_EMAIL}</span>}
            hint={t('aboutWindow.author.contactHint')}
          />
          <DataEntry
            name={t('aboutWindow.author.license')}
            value={
              <button
                type="button"
                className="sl-credit-link sl-info-license"
                onClick={() => {
                  setInfo(false)
                  useLicenseWindow.getState().open()
                }}
              >
                {rightsText()}
              </button>
            }
            hint={t('aboutWindow.author.licenseHint')}
          />

          <h3 className="sl-guide-section-title">{t('aboutWindow.computer.title')}</h3>
          <DataEntry name={t('aboutWindow.computer.gpu')} value={graphics} />
          <DataEntry
            name={t('aboutWindow.computer.cpu')}
            value={system !== null ? t('aboutWindow.computer.cpuValue', { model: String(system['cpuModel']), cores: String(system['cpuCores']) }) : '…'}
          />
          <DataEntry
            name={t('aboutWindow.computer.memory')}
            value={system !== null ? formatBytes(Number(system['totalRam'])) : '…'}
          />

          <LegalSections
            openLicense={() => {
              setInfo(false)
              useLicenseWindow.getState().open()
            }}
          />

          <div className="sl-info-support">
            <span>{t('aboutWindow.support.text')}</span>
            <Button
              variant="ghost"
              onClick={() => setDonationsNotice(!openDonations())}
              title={t('aboutWindow.support.buttonHint')}
            >
              {t('aboutWindow.support.button')}
            </Button>
          </div>
          {donationsNotice ? (
            <p className="sl-note sl-info-notice" role="status">
              {donationsNoticeText()}
            </p>
          ) : null}
        </div>

        <footer className="sl-dialog-footer">
          <span className="sl-guide-entry-text sl-selectable">{licenseNote()}</span>
          <Button
            variant="primary"
            icon={<CloseIcon size={15} />}
            onClick={() => setInfo(false)}
          >
            {t('aboutWindow.close')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
