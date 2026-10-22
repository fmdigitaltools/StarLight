import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { UndoIcon, RedoIcon, HistoryIcon } from './Icons'
import { useHistory, undo, repeat, goToStep } from '../hooks/history'
import { useApp } from '../store/appStore'
import { HISTORY_EVENT } from '../hooks/useShortcuts'
import { keysOf } from '../shortcuts'
import { t } from '@shared/i18n/i18n'
import '../styles/history.css'

function shortTime(ms: number): string {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/**
 * Undo, Redo and the edit history. The history is a list from oldest to
 * newest: clicking a step returns the image to that point; later steps stay
 * visible, grayed out, until a new edit is made.
 *
 * The top bar inserts other buttons among these (Reset after Redo, Fit after
 * History): they are passed in as children so that they stay in the same
 * group and the drop-down stays anchored to its container.
 */
export function HistoryControls({
  afterRedo,
  afterHistory
}: {
  afterRedo?: ReactNode
  afterHistory?: ReactNode
}): JSX.Element {
  const steps = useHistory((s) => s.steps)
  const index = useHistory((s) => s.index)
  const busy = useApp((s) => s.job.active)
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)

  const canUndo = index > 0 && !busy
  const canRedo = index < steps.length - 1 && !busy

  // Close on an outside click or Esc.
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent): void => {
      if (container.current && !container.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', outside)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', outside)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  // Ctrl+H (see shortcuts.ts) opens and closes the list.
  useEffect(() => {
    const toggle = (): void => {
      if (useHistory.getState().steps.length > 0) setOpen((v) => !v)
    }
    window.addEventListener(HISTORY_EVENT, toggle)
    return () => window.removeEventListener(HISTORY_EVENT, toggle)
  }, [])

  // Keep the current step in view.
  useEffect(() => {
    if (!open) return
    list.current?.querySelector('.sl-history-step--current')?.scrollIntoView({ block: 'nearest' })
  }, [open, index])

  return (
    <div className="sl-topbar-actions sl-history" ref={container} data-guide="history-actions">
      <button
        type="button"
        className="sl-btn sl-btn-secondary sl-btn-icon"
        onClick={undo}
        disabled={!canUndo}
        title={canUndo ? t('historyControls.undoHint', { step: steps[index].label }) : t('historyControls.nothingToUndo')}
        aria-label={t('historyControls.undo')}
      >
        <UndoIcon size={17} />
      </button>
      <button
        type="button"
        className="sl-btn sl-btn-secondary sl-btn-icon"
        onClick={repeat}
        disabled={!canRedo}
        title={canRedo ? t('historyControls.redoHint', { step: steps[index + 1].label }) : t('historyControls.nothingToRedo')}
        aria-label={t('historyControls.redo')}
      >
        <RedoIcon size={17} />
      </button>
      {afterRedo}
      <button
        type="button"
        className={'sl-btn sl-btn-secondary' + (open ? ' sl-btn-on' : '')}
        onClick={() => setOpen((v) => !v)}
        disabled={steps.length === 0}
        title={t('historyControls.historyHint', { keys: keysOf('history') })}
        aria-expanded={open}
      >
        <HistoryIcon size={17} />
        <span>{t('historyControls.history')}</span>
      </button>
      {afterHistory}

      {open ? (
        <div className="sl-history-dropdown" role="dialog" aria-label={t('historyControls.listLabel')}>
          <div className="sl-history-title">
            {t('historyControls.history')}
            <span className="sl-history-count">
              {steps.length - 1 === 1 ? t('historyControls.editCountOne') : t('historyControls.editCountOther', { count: steps.length - 1 })}
            </span>
          </div>
          <ol className="sl-history-list" ref={list}>
            {steps.map((p, i) => {
              const classes = ['sl-history-step']
              if (i === index) classes.push('sl-history-step--current')
              if (i > index) classes.push('sl-history-step--future')
              return (
                <li key={i}>
                  <button
                    type="button"
                    className={classes.join(' ')}
                    onClick={() => goToStep(i)}
                    disabled={busy}
                  >
                    <span className="sl-history-number">{i === 0 ? '·' : i}</span>
                    <span className="sl-history-name">{p.label}</span>
                    <span className="sl-history-time">{shortTime(p.now)}</span>
                  </button>
                </li>
              )
            })}
          </ol>
          <p className="sl-history-note">
            {t('historyControls.greyNote')}
          </p>
        </div>
      ) : null}
    </div>
  )
}
