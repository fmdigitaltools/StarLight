import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Button, Segmented } from './Controls'
import { CloseIcon, InfoIcon } from './Icons'
import {
  APP_NAME,
  SPDX_LICENSE,
  DONATIONS_URL,
  donationsAvailable,
  AUTHOR
} from '@shared/version'
import { creditsFor, categoryTitlesFor, type CreditCategory } from '@shared/credits'
// Full text of the GPL, the same LICENSE file as the repository root:
// embedded in the interface so that it can be read offline.
import gplText from '../../../../LICENSE?raw'
import '../styles/license.css'
import { t, getLanguage } from '@shared/i18n/i18n'

/**
 * "License and credits" window, opened from the Help menu: one tab with the
 * full text of the StarLight license and one with the third-party credits
 * (components, data, services, methods).
 */

export const useLicenseWindow = create<{ isOpen: boolean; open: () => void; close: () => void }>(
  (set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false })
  })
)

/**
 * Opens the donations page in the browser. Returns false, opening nothing,
 * while the address is still the placeholder: the caller then shows a
 * notice instead.
 */
export function openDonations(): boolean {
  if (!donationsAvailable()) return false
  // The main window sends external links to the browser.
  window.open(DONATIONS_URL, '_blank', 'noopener')
  return true
}

type TabId = 'license' | 'credits'

const ORDER: CreditCategory[] = ['component', 'data', 'catalogs', 'service', 'algorithm', 'installer']

export function LicenseWindow(): JSX.Element | null {
  const open = useLicenseWindow((s) => s.isOpen)
  if (!open) return null
  // Rendered outside the menu bar, like the other windows opened from there.
  return createPortal(<ModalWindow />, document.body)
}

function ModalWindow(): JSX.Element {
  const close = useLicenseWindow((s) => s.close)
  const [tab, setTab] = useState<TabId>('license')
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => before?.focus?.()
  }, [])

  return (
    <div className="sl-overlay" onClick={close}>
      <div
        ref={dialog}
        tabIndex={-1}
        className="sl-dialog sl-license"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-license-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
          // Keys stay in the window and do not reach the viewer shortcuts.
          if (e.key !== 'F1') e.stopPropagation()
        }}
      >
        <header className="sl-dialog-head">
          <InfoIcon size={22} />
          <div>
            <h2 className="sl-dialog-title" id="sl-license-title">
              {t('licenseWindow.title')}
            </h2>
            <p className="sl-dialog-subtitle">
              {t('licenseWindow.subtitle', { app: APP_NAME, spdx: SPDX_LICENSE })}
            </p>
          </div>
          <div className="sl-topbar-spacer" />
          <Segmented<TabId>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'license', label: t('licenseWindow.tabs.license') },
              { value: 'credits', label: t('licenseWindow.tabs.credits') }
            ]}
          />
        </header>

        <div className="sl-dialog-body sl-license-body">
          {tab === 'license' ? <LicenseTab /> : <CreditsTab />}
        </div>

        <footer className="sl-dialog-footer">
          <span className="sl-guide-entry-text sl-selectable">
            {t('licenseWindow.footer', { app: APP_NAME, author: AUTHOR })}
          </span>
          <Button variant="primary" icon={<CloseIcon size={15} />} onClick={close}>
            {t('licenseWindow.close')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

function LicenseTab(): JSX.Element {
  return (
    <>
      <p className="sl-note sl-license-intro">{t('licenseWindow.licenseIntro', { app: APP_NAME })}</p>
      <pre className="sl-license-text sl-selectable">{gplText}</pre>
    </>
  )
}

function CreditsTab(): JSX.Element {
  const credits = creditsFor(getLanguage())
  const titles = categoryTitlesFor(getLanguage())
  return (
    <>
      <p className="sl-note sl-license-intro">{t('licenseWindow.creditsIntro', { app: APP_NAME })}</p>
      {ORDER.map((category) => {
        const entries = credits.filter((r) => r.category === category)
        if (entries.length === 0) return null
        return (
          <section key={category}>
            <h3 className="sl-guide-section-title">{titles[category]}</h3>
            <ul className="sl-credits">
              {entries.map((r) => (
                <li key={r.name} className="sl-credit">
                  <div className="sl-credit-row">
                    <span className="sl-credit-name">{r.name}</span>
                    <span className="sl-credit-license">{r.license}</span>
                    <span className="sl-credit-author">{r.author}</span>
                    <a
                      className="sl-credit-link"
                      href={r.link}
                      target="_blank"
                      rel="noreferrer"
                      title={t('licenseWindow.openLink', { link: r.link })}
                    >
                      {r.link.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                    </a>
                  </div>
                  {r.reference ? (
                    <p className="sl-credit-note sl-selectable">{r.reference}</p>
                  ) : null}
                  {r.note ? <p className="sl-credit-note sl-selectable">{r.note}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </>
  )
}
