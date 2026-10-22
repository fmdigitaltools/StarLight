import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../store/appStore'
import { Button } from './Controls'
import { FolderIcon } from './Icons'
import {
  useProjectDialogs,
  proposedName,
  proposedPosition,
  saveAsChosen,
  saveProject,
  proceed,
  giveUp,
  type NextAction,
  type Action
} from '../hooks/useProject'
import { PROJECT_FILE_NAME, cleanName, joinPath } from '@core/project'
import { shownResult } from '../hooks/temporaryResult'
import { t } from '@shared/i18n/i18n'
import '../styles/project.css'

/**
 * Project dialogs: the name for "Save as" and the confirmation before
 * closing or opening when there is unsaved work.
 */
export function ProjectDialogs(): JSX.Element | null {
  const dialog = useProjectDialogs((s) => s.dialog)
  if (!dialog) return null
  // Rendered outside the top bar: its blur filter would confine the overlay
  // inside the bar instead of covering the whole window.
  if (dialog.type === 'saveAs') return createPortal(<NameDialog next={dialog.next} />, document.body)
  return createPortal(<ConfirmDialog next={dialog.next} />, document.body)
}

function closeDialog(): void {
  useProjectDialogs.getState().openDialog(null)
}

/** Closes the dialog, abandoning the action that was meant to follow. */
function cancelDialog(next: NextAction): void {
  giveUp(next)
  closeDialog()
}

function NameDialog({ next }: { next: NextAction }): JSX.Element {
  const [name, setName] = useState(proposedName)
  const [location, setLocation] = useState('')
  const [alreadyExists, setAlreadyExists] = useState(false)
  const [inProgress, setInProgress] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void proposedPosition().then(setLocation)
    field.current?.select()
  }, [])

  const cleaned = cleanName(name)
  const folder = location && cleaned ? joinPath(location, cleaned) : ''

  // Warns before replacing a project with the same name.
  useEffect(() => {
    if (!folder) {
      setAlreadyExists(false)
      return
    }
    let valid = true
    const wait = window.setTimeout(() => {
      void window.starlight.projectExists(folder, PROJECT_FILE_NAME).then((v) => {
        if (valid) setAlreadyExists(v && useApp.getState().project?.folder !== folder)
      })
    }, 150)
    return () => {
      valid = false
      window.clearTimeout(wait)
    }
  }, [folder])

  async function confirm(): Promise<void> {
    if (!folder || inProgress) return
    setInProgress(true)
    closeDialog()
    await saveAsChosen(location, cleaned, next)
  }

  async function changePosition(): Promise<void> {
    const choice = await window.starlight.chooseProjectLocation(location)
    if (choice) setLocation(choice)
  }

  return (
    <div className="sl-overlay" onClick={() => cancelDialog(next)}>
      <div
        className="sl-dialog sl-dialog-narrow"
        role="dialog"
        aria-labelledby="sl-project-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancelDialog(next)
        }}
      >
        <header className="sl-dialog-head">
          <SaveIcon size={22} />
          <div>
            <h2 className="sl-dialog-title" id="sl-project-title">
              {t('projectDialogs.saveAs.title')}
            </h2>
            <p className="sl-dialog-subtitle">
              {t('projectDialogs.saveAs.subtitle')}
            </p>
          </div>
        </header>

        <div className="sl-dialog-body sl-project-body">
          <label className="sl-project-label" htmlFor="sl-project-name">
            {t('projectDialogs.saveAs.name')}
          </label>
          <input
            id="sl-project-name"
            ref={field}
            className="sl-project-field"
            type="text"
            value={name}
            maxLength={120}
            autoFocus
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirm()
            }}
          />

          <span className="sl-project-label">{t('projectDialogs.saveAs.location')}</span>
          <div className="sl-project-location">
            <span className="sl-project-path" title={folder || location}>
              {folder || location || '…'}
            </span>
            <Button icon={<FolderIcon size={16} />} onClick={() => void changePosition()}>
              {t('projectDialogs.saveAs.change')}
            </Button>
          </div>

          {!cleaned && name.trim() !== '' ? (
            <p className="sl-project-note sl-project-note-error">
              {t('projectDialogs.saveAs.invalidName')}
            </p>
          ) : cleaned !== name.trim() && cleaned ? (
            <p className="sl-project-note">
              {t('projectDialogs.saveAs.cleanedName', { name: cleaned })}
            </p>
          ) : null}
          {alreadyExists ? (
            <p className="sl-project-note sl-project-note-warning">
              {t('projectDialogs.saveAs.alreadyExists')}
            </p>
          ) : null}
        </div>

        <footer className="sl-dialog-footer">
          <Button variant="ghost" onClick={() => cancelDialog(next)}>
            {t('projectDialogs.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<SaveIcon size={16} />}
            disabledValue={!folder || inProgress}
            onClick={() => void confirm()}
          >
            {alreadyExists ? t('projectDialogs.replace') : t('projectDialogs.save')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

/** Language-file key of the explanation shown for each action. */
const EXPLANATIONS: Record<Action, string> = {
  close: 'projectDialogs.confirm.close',
  new: 'projectDialogs.confirm.new',
  open: 'projectDialogs.confirm.open',
  quit: 'projectDialogs.confirm.quit',
  restart: 'projectDialogs.confirm.restart',
  frame: 'projectDialogs.confirm.frame'
}

/** A result (stacked, drizzle, mosaic) is named explicitly: it is the longest work to redo. */
const RESULT_EXPLANATION = 'projectDialogs.confirm.frameResult'

function ConfirmDialog({ next }: { next: Action }): JSX.Element {
  const project = useApp((s) => s.project)
  const saveRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Focus goes to "Save", the choice that loses nothing.
    saveRef.current?.querySelector<HTMLButtonElement>('.sl-btn-primary')?.focus()
  }, [])

  const title = project
    ? t('projectDialogs.confirm.titleProject', { name: project.name })
    : t('projectDialogs.confirm.title')
  const text = t(next === 'frame' && shownResult() !== null ? RESULT_EXPLANATION : EXPLANATIONS[next])

  return (
    <div className="sl-overlay" onClick={() => cancelDialog(next)}>
      <div
        className="sl-dialog sl-dialog-narrow"
        role="alertdialog"
        aria-labelledby="sl-confirm-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancelDialog(next)
        }}
        ref={saveRef}
      >
        <header className="sl-dialog-head">
          <SaveIcon size={22} />
          <div>
            <h2 className="sl-dialog-title" id="sl-confirm-title">
              {title}
            </h2>
            <p className="sl-dialog-subtitle">{text}</p>
          </div>
        </header>
        <footer className="sl-dialog-footer">
          <Button variant="ghost" onClick={() => cancelDialog(next)}>
            {t('projectDialogs.cancel')}
          </Button>
          <div className="sl-project-buttons">
            <Button
              variant="danger"
              onClick={() => {
                closeDialog()
                void proceed(next)
              }}
            >
              {next === 'frame' ? t('projectDialogs.confirm.openAnyway') : t('projectDialogs.confirm.dontSave')}
            </Button>
            <Button
              variant="primary"
              icon={<SaveIcon size={16} />}
              onClick={() => {
                closeDialog()
                void saveProject(next)
              }}
            >
              {t('projectDialogs.save')}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/** Save icon: a floppy disk, drawn in outline like the other icons. */
export function SaveIcon({ size = 20 }: { size?: number }): JSX.Element {
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
      <path d="M5 4h11l3 3v12a1 1 0 01-1 1H6a1 1 0 01-1-1V5a1 1 0 011-1z" />
      <path d="M8 4v5h7V4" />
      <path d="M8 20v-6h8v6" />
    </svg>
  )
}
