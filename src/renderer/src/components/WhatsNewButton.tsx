import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Controls'
import { CloseIcon, WhatsNewIcon } from './Icons'
import { updatePreferences } from '../settings'
import { APP_NAME, APP_VERSION, VERSION_LABEL } from '@shared/version'
import WHATS_NEW_IT from '@shared/whatsNew.json'
import WHATS_NEW_EN from '@shared/whatsNew.en.json'
import { MAX_WHATS_NEW_VERSIONS } from '@shared/updates'

import '../styles/whats-new.css'
import { t, byLanguage } from '@shared/i18n/i18n'

/**
 * What's new: a button next to the version number, in the brand row, that
 * opens the list of changes of every version (most recent first). Until the
 * changes of the running version have been opened the button glows and
 * pulses gently; once opened, it returns to normal until the next version.
 *
 * The entries come from src/shared/whatsNew.json (Italian) and
 * src/shared/whatsNew.en.json (English); tools/write-release-notes.mjs reads
 * every language for the release notes.
 */

interface WhatsNewEntry {
  version: string
  entries: string[]
}

/** Preferences file key: the last version whose changes have been read. */
const READ_KEY = 'whatsNewRead'

/**
 * Changes list in the current language, most recent first: only the latest
 * MAX_WHATS_NEW_VERSIONS versions, the older ones are cut off.
 */
function whatsNewList(): WhatsNewEntry[] {
  return byLanguage<WhatsNewEntry[]>({ it: WHATS_NEW_IT, en: WHATS_NEW_EN }).slice(0, MAX_WHATS_NEW_VERSIONS)
}

export function WhatsNewButton(): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false)
  // Off until the preferences have been read, so the button does not
  // light up for an instant at every startup.
  const [toRead, setToRead] = useState(false)

  useEffect(() => {
    void window.starlight
      .readPreferences()
      .then((p) => setToRead(p[READ_KEY] !== APP_VERSION))
      .catch(() => undefined)
  }, [])

  // Without changes for the running version the button has nothing to say.
  const presentItems = whatsNewList().some((v) => v.version === APP_VERSION)
  if (!presentItems) return null

  function openWhatsNew(): void {
    setIsOpen(true)
    if (toRead) {
      setToRead(false)
      void updatePreferences({ [READ_KEY]: APP_VERSION })
    }
  }

  return (
    <>
      <button
        type="button"
        className={'sl-whats-new-button' + (toRead ? ' sl-whats-new-unread' : '')}
        onClick={openWhatsNew}
        title={toRead ? t('whatsNewButton.unreadTitle') : t('whatsNewButton.title')}
        aria-label={toRead ? t('whatsNewButton.unreadTitle') : t('whatsNewButton.title')}
      >
        <WhatsNewIcon size={16} />
        {toRead ? <span className="sl-whats-new-dot" aria-hidden="true" /> : null}
      </button>
      {isOpen ? createPortal(<WhatsNewWindow close={() => setIsOpen(false)} />, document.body) : null}
    </>
  )
}

function WhatsNewWindow({ close }: { close: () => void }): JSX.Element {
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
        className="sl-dialog sl-dialog-narrow sl-whats-new"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-whats-new-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
          if (e.key !== 'F1') e.stopPropagation()
        }}
      >
        <header className="sl-dialog-head">
          <WhatsNewIcon size={22} className="sl-whats-new-icon" />
          <div>
            <h2 className="sl-dialog-title" id="sl-whats-new-title">
              {t('whatsNewButton.windowTitle', { app: APP_NAME })}
            </h2>
            <p className="sl-dialog-subtitle">
              {t('whatsNewButton.currentVersion', { version: VERSION_LABEL.replace(/^v/, '') })}
            </p>
          </div>
          <div className="sl-topbar-spacer" />
          <Button variant="ghost" icon={<CloseIcon size={16} />} onClick={close}>
            {t('whatsNewButton.close')}
          </Button>
        </header>
        <div className="sl-dialog-body sl-whats-new-body">
          {whatsNewList().map((v) => (
            <section key={v.version} className="sl-whats-new-version">
              <h3 className="sl-whats-new-version-title">
                {t('whatsNewButton.version', { version: v.version })}
                {v.version === APP_VERSION ? (
                  <span className="sl-whats-new-current">{t('whatsNewButton.inUse')}</span>
                ) : null}
              </h3>
              <ul className="sl-whats-new-items">
                {v.entries.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="sl-dialog-footer">
          <div />
          <Button variant="primary" onClick={close}>
            {t('whatsNewButton.close')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
