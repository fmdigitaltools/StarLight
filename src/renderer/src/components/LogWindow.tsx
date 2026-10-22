import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Button, Segmented } from './Controls'
import { CloseIcon, FolderIcon, TrashIcon } from './Icons'
import { useApp } from '../store/appStore'
import { logAvailable } from '../errorLog'
import { whenSaved, useRecoveryWindow } from '../hooks/recovery'
import type { SevereError, LogEntry } from '@shared/log'
import { t } from '@shared/i18n/i18n'
import '../styles/log.css'

/**
 * "Log and error reporting" window, opened from the Help menu: the latest
 * entries of the program log (see src/main/log.ts) and the commands to copy
 * the report to paste into a bug report, open the log folder and clear it.
 * Nothing is ever sent automatically.
 *
 * This file also holds the notice shown on restart after a severe error
 * (`SevereErrorNotice`), which offers to open the log.
 */

export const useLogWindow = create<{ isOpen: boolean; open: () => void; close: () => void }>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false })
}))

/** Language-file keys of the log entry sources. */
const SOURCE_NAMES: Record<string, string> = {
  startup: 'logWindow.sources.startup',
  main: 'logWindow.sources.main',
  window: 'logWindow.sources.window',
  ui: 'logWindow.sources.ui',
  worker: 'logWindow.sources.worker',
  plugin: 'logWindow.sources.plugin',
  process: 'logWindow.sources.process'
}

/** Language-file keys of the log entry levels. */
const LEVEL_NAMES: Record<LogEntry['level'], string> = {
  info: 'logWindow.levels.info',
  warning: 'logWindow.levels.warning',
  error: 'logWindow.levels.error'
}

type Filter = 'all' | 'problems'

export function LogWindow(): JSX.Element | null {
  const open = useLogWindow((s) => s.isOpen)
  if (!open) return null
  return createPortal(<ModalWindow />, document.body)
}

/** Copies text to the clipboard, with a fallback for when the modern API is not allowed. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

function ModalWindow(): JSX.Element {
  const close = useLogWindow((s) => s.close)
  const notify = useApp((s) => s.notify)
  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [confirmClear, setConfirmClear] = useState(false)
  // Confirmation on the button itself: notices are not visible if the interface has crashed.
  const [copied, setCopied] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const available = logAvailable()

  const update = useCallback(async (): Promise<void> => {
    if (!available) {
      setEntries([])
      return
    }
    try {
      setEntries(await window.starlight.logEntries())
    } catch {
      setEntries([])
    }
  }, [available])

  useEffect(() => {
    void update()
  }, [update])

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => before?.focus?.()
  }, [])

  async function copyReport(): Promise<void> {
    try {
      const text = await window.starlight.logReport()
      if (await copyToClipboard(text)) {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2500)
        notify('ok', t('logWindow.notices.copied'))
      } else {
        notify('warning', t('logWindow.notices.copyFailed'))
      }
    } catch {
      notify('warning', t('logWindow.notices.reportFailed'))
    }
  }

  async function clear(): Promise<void> {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    try {
      await window.starlight.clearLog()
      notify('ok', t('logWindow.notices.cleared'))
    } catch {
      notify('warning', t('logWindow.notices.clearFailed'))
    }
    await update()
  }

  const shown = (entries ?? []).filter((v) => filter === 'all' || v.level !== 'info')

  return (
    <div className="sl-overlay" onClick={close}>
      <div
        ref={dialog}
        tabIndex={-1}
        className="sl-dialog sl-log"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-log-title"
        data-guide="log-window"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
          // Keys stay in the window and never reach the viewer shortcuts.
          if (e.key !== 'F1') e.stopPropagation()
        }}
      >
        <header className="sl-dialog-head">
          <LogIcon size={22} />
          <div>
            <h2 className="sl-dialog-title" id="sl-log-title">
              {t('logWindow.title')}
            </h2>
            <p className="sl-dialog-subtitle">
              {t('logWindow.subtitle')}
            </p>
          </div>
          <div className="sl-topbar-spacer" />
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('logWindow.filter.all') },
              { value: 'problems', label: t('logWindow.filter.problems') }
            ]}
          />
        </header>

        <div className="sl-dialog-body sl-log-body">
          <p className="sl-note sl-log-intro">
            {t('logWindow.intro')}
          </p>
          {entries === null ? (
            <p className="sl-log-empty">{t('logWindow.reading')}</p>
          ) : !available ? (
            <p className="sl-log-empty">{t('logWindow.afterRestart')}</p>
          ) : shown.length === 0 ? (
            <p className="sl-log-empty">
              {filter === 'problems' ? t('logWindow.noProblems') : t('logWindow.empty')}
            </p>
          ) : (
            <ol className="sl-log-entries">
              {shown.map((v, i) => (
                <DisplayedEntry key={i + v.when} entry={v} />
              ))}
            </ol>
          )}
        </div>

        <footer className="sl-dialog-footer">
          <div className="sl-log-commands">
            <Button
              icon={<FolderIcon size={15} />}
              onClick={() => void window.starlight.openLogFolder()}
              disabledValue={!available}
              title={t('logWindow.openFolderHint')}
              data="log-folder"
            >
              {t('logWindow.openFolder')}
            </Button>
            <Button
              variant="danger"
              icon={<TrashIcon size={15} />}
              onClick={() => void clear()}
              disabledValue={!available}
              title={t('logWindow.clearHint')}
              data="log-clear"
            >
              {confirmClear ? t('logWindow.clearConfirm') : t('logWindow.clear')}
            </Button>
          </div>
          <div className="sl-log-commands">
            <Button onClick={close} icon={<CloseIcon size={15} />}>
              {t('logWindow.close')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void copyReport()}
              disabledValue={!available}
              title={t('logWindow.copyReportHint')}
              data="log-copy"
            >
              {copied ? t('logWindow.reportCopied') : t('logWindow.copyReport')}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function DisplayedEntry({ entry }: { entry: LogEntry }): JSX.Element {
  const [before, ...remainder] = entry.text.split('\n')
  return (
    <li className={'sl-log-entry sl-log-entry--' + entry.level}>
      <span className="sl-log-when sl-mono">{entry.when}</span>
      <span className={'sl-log-level sl-log-level--' + entry.level}>{t(LEVEL_NAMES[entry.level])}</span>
      <span className="sl-log-source">{SOURCE_NAMES[entry.origin] ? t(SOURCE_NAMES[entry.origin]) : entry.origin}</span>
      <div className="sl-log-text sl-selectable">
        {before}
        {remainder.length > 0 ? (
          <details className="sl-log-details">
            <summary>{t('logWindow.technicalDetails')}</summary>
            <pre className="sl-mono">{remainder.join('\n')}</pre>
          </details>
        ) : null}
      </div>
    </li>
  )
}

/** Log icon: a sheet with lines of text. */
function LogIcon({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="sl-log-icon"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 12.5h7M8.5 16h4.5" />
    </svg>
  )
}

/* ---- On restart after a severe error ---- */

/** Delay after startup, leaving room first for the work recovery offer. */
const NOTICE_DELAY_MS = 2500

/**
 * If a severe error occurred before this restart (window closed suddenly,
 * interface crashed), offers to open the log. It appears after the work
 * recovery window, if any, and never on top of it.
 */
export function SevereErrorNotice(): JSX.Element | null {
  const [error, setError] = useState<SevereError | null>(null)
  const [ready, setReady] = useState(false)
  const copyToRecover = useRecoveryWindow((s) => s.copy)
  const open = useLogWindow((s) => s.open)

  useEffect(() => {
    if (!logAvailable()) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.starlight
        .severeErrorLog()
        .then((e) => {
          if (!cancelled && e) {
            setError(e)
            setReady(true)
          }
        })
        .catch(() => undefined)
    }, NOTICE_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  if (!ready || error === null || copyToRecover !== null) return null

  const when = whenSaved(error.when.replace(' ', 'T'))
  const description = error.description.replace(/\.$/, '')

  function seen(): void {
    setError(null)
    if (typeof window.starlight.severeErrorSeen === 'function') void window.starlight.severeErrorSeen().catch(() => undefined)
  }

  return createPortal(
    <div className="sl-log-proposal" role="alert" data-guide="notice-severe-error">
      <LogIcon size={20} />
      <div className="sl-log-proposal-text">
        <strong>{t('logWindow.severe.title')}</strong>
        <span>
          {when
            ? t('logWindow.severe.textWithWhen', { description, when })
            : t('logWindow.severe.text', { description })}
        </span>
        <div className="sl-log-proposal-commands">
          <Button
            variant="primary"
            data="notice-error-open"
            onClick={() => {
              seen()
              open()
            }}
          >
            {t('logWindow.severe.openLog')}
          </Button>
          <Button variant="ghost" onClick={seen}>
            {t('logWindow.severe.notNow')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
