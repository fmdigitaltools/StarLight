import { useEffect, useRef, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Controls'
import { whenSaved, useRecoveryWindow } from '../hooks/recovery'
import { t } from '@shared/i18n/i18n'

/**
 * Window shown at startup when the previous session did not close cleanly
 * and left a copy of unsaved work (see hooks/recovery.ts): Recover or
 * Discard. It cannot be dismissed by clicking outside or pressing Esc,
 * because an accidental choice would lose the work.
 */
export function RecoveryWindow(): JSX.Element | null {
  const copy = useRecoveryWindow((s) => s.copy)
  const choose = useRecoveryWindow((s) => s.choose)
  const window = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Focus goes to Recover, the choice that loses nothing.
    window.current?.querySelector<HTMLButtonElement>('.sl-btn-primary')?.focus()
  }, [copy])

  if (copy === null || choose === null) return null

  const when = whenSaved(copy.info.savedAt)
  const di = copy.info.project
    ? t('recoveryWindow.sourceProject', { name: copy.info.project.name })
    : t('recoveryWindow.sourceUnsaved')

  return createPortal(
    <div className="sl-overlay">
      <div
        className="sl-dialog sl-dialog-narrow"
        role="alertdialog"
        aria-labelledby="sl-recovery-title"
        aria-describedby="sl-recovery-text"
        ref={window}
        data-guide="recovery-window"
      >
        <header className="sl-dialog-head">
          <RecoveryIcon size={22} />
          <div>
            <h2 className="sl-dialog-title" id="sl-recovery-title">
              {t('recoveryWindow.title')}
            </h2>
            <p className="sl-dialog-subtitle" id="sl-recovery-text">
              {t('recoveryWindow.message', { when: when ? ' ' + when : '', source: di })}
            </p>
            <p className="sl-dialog-subtitle">
              {copy.info.project ? t('recoveryWindow.explainProject') : t('recoveryWindow.explainUnsaved')}
            </p>
          </div>
        </header>
        <footer className="sl-dialog-footer">
          <Button variant="danger" onClick={() => choose(false)} data="recovery-discard">
            {t('recoveryWindow.discard')}
          </Button>
          <Button variant="primary" onClick={() => choose(true)} data="recovery-restore">
            {t('recoveryWindow.recover')}
          </Button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

/** Recovery icon: an arrow circling back around a clock. */
function RecoveryIcon({ size = 20 }: { size?: number }): JSX.Element {
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
    >
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4h4" />
      <path d="M12 8v4l3 2" />
    </svg>
  )
}
