import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Button } from './Controls'
import { CloseIcon } from './Icons'
import { useApp } from '../store/appStore'
import { noInternetNotice, settingsReady, internetAllowed, readSettings } from '../settings'
import { APP_NAME, updatesNotice } from '@shared/version'
import { releaseNotesFor, type InstallResult, type UpdateStatus } from '@shared/updates'
import { t, formatDecimal, getLanguage } from '@shared/i18n/i18n'
import '../styles/updates.css'

/**
 * Automatic update window: "StarLight X.Y.Z is available" with the release
 * notes and a choice between Update now, Later and Skip this version;
 * then download progress and installation.
 *
 * The actual work is done by the main process (src/main/updates.ts): this
 * component shows the status received from it and forwards the user's
 * choices. It stays mounted at all times (in the menu bar) because it also
 * starts the check at startup and reports when a background download has
 * finished.
 */

interface WindowState {
  isOpen: boolean
  state: UpdateStatus | null
  /** Result of the last request to install immediately, if it failed. */
  installResult: InstallResult | null
  /**
   * Seconds left before the automatic restart after "Update now", or null.
   * The restart is announced and can be postponed: closing the window
   * cancels it.
   */
  restartIn: number | null
  open: () => void
  close: () => void
}

/** Notice period, in seconds, before closing the program to install. */
const RESTART_NOTICE_S = 10

export const useUpdateWindow = create<WindowState>((set) => ({
  isOpen: false,
  state: null,
  installResult: null,
  restartIn: null,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false, installResult: null, restartIn: null })
}))

/** Delay after startup before the automatic check, so that everything else loads first. */
const STARTUP_CHECK_DELAY_MS = 8000

function notify(type: 'info' | 'ok' | 'warning' | 'error', text: string): void {
  useApp.getState().notify(type, text)
}

/**
 * "Check for updates…" item of the Help menu. If the check is slow the
 * window opens immediately and shows that it is waiting; if the service is
 * not configured a notice is enough.
 */
export async function checkForUpdatesFromMenu(withWindow = false): Promise<void> {
  if (!internetAllowed()) {
    notify('warning', noInternetNotice(t('updateWindow.noInternetSubject')))
    return
  }
  const updateWindow = useUpdateWindow.getState()
  const timer = window.setTimeout(() => updateWindow.open(), 400)
  const state = await window.starlight.checkForUpdates(true, readSettings().updatesChannel)
  window.clearTimeout(timer)
  useUpdateWindow.setState({ state })
  // When called from Settings, a notice at the bottom would be hidden behind
  // that window, so this window is shown instead with the same message.
  if (state.phase === 'notConfigured' && !withWindow) {
    useUpdateWindow.getState().close()
    notify('info', updatesNotice())
    return
  }
  useUpdateWindow.getState().open()
}

/** Requests immediate installation; if that is not possible, the window explains why. */
async function installNow(): Promise<void> {
  const result = await window.starlight.installUpdate()
  if (!result.ok) useUpdateWindow.setState({ installResult: result, isOpen: true })
}

export function UpdateWindow(): JSX.Element | null {
  const open = useUpdateWindow((s) => s.isOpen)
  const state = useUpdateWindow((s) => s.state)

  useEffect(() => {
    let previous: UpdateStatus | null = null
    const receive = (s: UpdateStatus): void => {
      const before = previous
      previous = s
      useUpdateWindow.setState({ state: s })
      const { isOpen: visible } = useUpdateWindow.getState()
      if (before?.phase === s.phase) return

      // New version found by the automatic check: offer it.
      if (s.phase === 'available' && !s.manual) useUpdateWindow.getState().open()

      // Download finished.
      if (s.phase === 'ready' && before?.phase === 'downloading') {
        // With "Update now" and the window still open, a visible countdown
        // starts that can be interrupted; if the window was closed in the
        // meantime to keep working, it is reopened to ask, rather than closing
        // the program without warning.
        if (s.installImmediately && visible) useUpdateWindow.setState({ restartIn: RESTART_NOTICE_S })
        else if (s.installImmediately) useUpdateWindow.getState().open()
        else if (!visible) {
          notify('ok', t('updateWindow.readyOnClose', { app: APP_NAME, version: s.newVersion ?? '' }))
        }
      }

      // A failed background download is reported; a failed automatic check is
      // not, to avoid bothering the user at every startup.
      if (s.phase === 'error' && !visible && before?.phase === 'downloading' && s.error) notify('error', s.error)
    }
    const stop = window.starlight.onUpdateStatus(receive)
    void window.starlight.updateStatus().then((s) => {
      previous ??= s
      useUpdateWindow.setState({ state: s })
    })

    // Check at startup, if the settings allow it. The main process runs it
    // only once even if the page reloads.
    let timer = 0
    void settingsReady().then((settings) => {
      if (!settings.checkForUpdates || !settings.internet) return
      timer = window.setTimeout(() => {
        const currentSettings = readSettings()
        if (!currentSettings.checkForUpdates || !currentSettings.internet) return
        void window.starlight.checkForUpdates(false, currentSettings.updatesChannel)
      }, STARTUP_CHECK_DELAY_MS)
    })

    return () => {
      stop()
      window.clearTimeout(timer)
    }
  }, [])

  if (!open || state === null) return null
  // Rendered outside the menu bar, like the other windows opened from it.
  return createPortal(<ModalWindow state={state} />, document.body)
}

/* ---- Formatting ---- */

function megabyte(byte: number): string {
  return formatDecimal(byte / 1048576, 1) + ' MB'
}

/* ---- Window ---- */

function ModalWindow({ state }: { state: UpdateStatus }): JSX.Element {
  const close = useUpdateWindow((s) => s.close)
  const result = useUpdateWindow((s) => s.installResult)
  const restartIn = useUpdateWindow((s) => s.restartIn)
  const dialog = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => before?.focus?.()
  }, [])

  useEffect(() => {
    if (restartIn === null) return
    if (restartIn <= 0) {
      useUpdateWindow.setState({ restartIn: null })
      void installNow()
      return
    }
    const t = window.setTimeout(() => useUpdateWindow.setState({ restartIn: restartIn - 1 }), 1000)
    return () => window.clearTimeout(t)
  }, [restartIn])

  const newValue = state.newVersion ?? ''

  function later(): void {
    // The installer downloads in the background and installs on exit.
    if (state.phase === 'available') void window.starlight.downloadUpdate(false)
    close()
  }

  async function skip(): Promise<void> {
    setBusy(true)
    try {
      await window.starlight.skipUpdate(newValue)
    } catch (e) {
      // The window stays open so the user can retry or choose another option.
      notify(
        'error',
        t('updateWindow.skipFailed', { version: newValue }) + ' ' + (e instanceof Error ? e.message : String(e))
      )
      return
    } finally {
      setBusy(false)
    }
    close()
    notify('info', t('updateWindow.skipped', { version: newValue }))
  }

  let title: string
  let subtitle: ReactNode = null
  let body: ReactNode
  let left: ReactNode = null
  let right: ReactNode

  const closeButton = (
    <Button variant="primary" onClick={close} data="update-close">
      {t('updateWindow.close')}
    </Button>
  )

  switch (state.phase) {
    case 'available': {
      // Notes in the current language, else English.
      const notes = releaseNotesFor(state.whatsNew, getLanguage())
      title = t('updateWindow.available.title', { app: APP_NAME, version: newValue })
      subtitle = t('updateWindow.available.subtitle', { version: state.currentVersion })
      body = (
        <>
          <h3 className="sl-update-section">{t('updateWindow.available.whatsNew')}</h3>
          {notes ? (
            // One item per line (see tools/write-release-notes.mjs): one bullet each.
            <ul className="sl-update-news">
              {notes
                .split(/\r?\n/)
                .map((row) => row.replace(/^\s*[-•*]\s*/, '').trim())
                .filter((row) => row !== '')
                .map((row, i) => (
                  <li key={i}>{row}</li>
                ))}
            </ul>
          ) : (
            <p className="sl-update-note">{t('updateWindow.available.noNotes')}</p>
          )}
          <p className="sl-update-note">{t('updateWindow.available.explain')}</p>
        </>
      )
      left = (
        <Button variant="ghost" onClick={() => void skip()} disabledValue={busy} data="update-skip">
          {t('updateWindow.skipVersion')}
        </Button>
      )
      right = (
        <>
          <Button onClick={later} data="update-later">
            {t('updateWindow.later')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void window.starlight.downloadUpdate(true)}
            data="update-now"
          >
            {t('updateWindow.updateNow')}
          </Button>
        </>
      )
      break
    }

    case 'downloading': {
      title = t('updateWindow.downloading.title', { app: APP_NAME, version: newValue })
      subtitle = state.installImmediately
        ? t('updateWindow.downloading.subtitleNow')
        : t('updateWindow.downloading.subtitleLater')
      const percent = Math.round(state.percent)
      body = (
        <>
          <ProgressBar percent={state.percent} />
          <div className="sl-update-data">
            <span>
              {state.total > 0
                ? t('updateWindow.downloading.amount', { done: megabyte(state.downloadedItems), total: megabyte(state.total) })
                : t('updateWindow.downloading.preparing')}
              {state.speed > 0 ? ' · ' + t('updateWindow.downloading.speed', { speed: megabyte(state.speed) }) : ''}
            </span>
            <span className="sl-update-percent">{percent}%</span>
          </div>
          <p className="sl-update-note">{t('updateWindow.downloading.keepWorking')}</p>
        </>
      )
      right = (
        <Button variant="primary" onClick={close} data="update-background">
          {t('updateWindow.downloading.background')}
        </Button>
      )
      break
    }

    case 'ready': {
      title = t('updateWindow.ready.title', { app: APP_NAME, version: newValue })
      subtitle =
        restartIn !== null
          ? (
              <span className="sl-update-count">
                {t('updateWindow.ready.countdownBefore')}
                <strong>{restartIn}</strong>
                {restartIn === 1 ? t('updateWindow.ready.countdownAfterOne') : t('updateWindow.ready.countdownAfterOther')}
              </span>
            )
          : t('updateWindow.ready.subtitle')
      body = (
        <>
          <ProgressBar percent={100} />
          {result?.reason === 'unsavedWork' ? (
            <p className="sl-update-notice">{t('updateWindow.ready.unsavedWork')}</p>
          ) : null}
          {result?.reason === 'development' ? (
            <p className="sl-update-notice">{t('updateWindow.ready.development')}</p>
          ) : null}
          <p className="sl-update-note">
            {restartIn !== null ? t('updateWindow.ready.noteCountdown') : t('updateWindow.ready.note')}
          </p>
        </>
      )
      right = (
        <>
          <Button onClick={close} data="update-later">
            {t('updateWindow.later')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              useUpdateWindow.setState({ restartIn: null })
              void installNow()
            }}
            data="update-install"
          >
            {restartIn !== null ? t('updateWindow.ready.restartNow') : t('updateWindow.ready.installRestart')}
          </Button>
        </>
      )
      break
    }

    case 'upToDate':
      title = t('updateWindow.upToDate.title', { app: APP_NAME })
      body = <p className="sl-update-text">{t('updateWindow.upToDate.body', { version: state.currentVersion })}</p>
      right = closeButton
      break

    case 'error':
      title = t('updateWindow.error.title')
      body = <p className="sl-update-text">{state.error ?? t('updateWindow.error.unexpected')}</p>
      right = (
        <>
          <Button onClick={() => void checkForUpdatesFromMenu(true)} data="update-retry">
            {t('updateWindow.error.retry')}
          </Button>
          {closeButton}
        </>
      )
      break

    case 'notConfigured':
      title = t('updateWindow.notConfiguredTitle')
      body = <p className="sl-update-text">{updatesNotice()}</p>
      right = closeButton
      break

    default:
      title = t('updateWindow.checking.title')
      body = <p className="sl-update-text">{t('updateWindow.checking.body')}</p>
      right = closeButton
  }

  return (
    <div className="sl-overlay" onClick={close}>
      <div
        ref={dialog}
        tabIndex={-1}
        className="sl-dialog sl-dialog-narrow sl-update"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-update-title"
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
          <UpdateIcon />
          <div>
            <h2 className="sl-dialog-title" id="sl-update-title">
              {title}
            </h2>
            {subtitle ? <p className="sl-dialog-subtitle">{subtitle}</p> : null}
          </div>
          <div className="sl-topbar-spacer" />
          <Button variant="ghost" icon={<CloseIcon size={16} />} onClick={close}>
            {t('updateWindow.close')}
          </Button>
        </header>
        <div className="sl-dialog-body" aria-live="polite">
          {body}
        </div>
        <footer className="sl-dialog-footer">
          <div className="sl-update-footer-group">{left}</div>
          <div className="sl-update-footer-group">{right}</div>
        </footer>
      </div>
    </div>
  )
}

/** Bar with a cyan-to-magenta gradient, like the installer's. */
function ProgressBar({ percent }: { percent: number }): JSX.Element {
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div
      className="sl-update-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      aria-label={t('updateWindow.downloading.progressLabel')}
    >
      <div className="sl-update-bar-fill" style={{ width: p + '%' }} />
      <div className="sl-update-bar-head" style={{ left: p + '%' }} />
    </div>
  )
}

/** Downward arrow inside a circle: a new version to download. */
function UpdateIcon(): JSX.Element {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="sl-update-icon"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v9M8 12.5l4 4 4-4" />
    </svg>
  )
}
