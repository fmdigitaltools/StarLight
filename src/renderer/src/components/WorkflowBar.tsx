import type { JSX, ReactNode } from 'react'
import { useApp, type WorkflowStep } from '../store/appStore'
import {
  ImportIcon,
  CalibrateIcon,
  AlignIcon,
  ProcessIcon,
  CorrectIcon,
  FiltersIcon,
  ObjectsIcon,
  ExportIcon
} from './Icons'
import { useLibrary } from '../hooks/useLibrary'
import { t } from '@shared/i18n/i18n'

interface Step {
  id: WorkflowStep
  readonly label: string
  icon: ReactNode
  readonly description: string
  /** Requires at least one imported frame. */
  requiresFrame: boolean
  /** Requires a frame open in the viewer. */
  requiresImage: boolean
}

/**
 * Builds a step whose label and description are read from the language
 * files each time they are used, so they follow language changes.
 */
function makeStep(id: WorkflowStep, icon: ReactNode, requiresFrame: boolean, requiresImage: boolean): Step {
  return {
    id,
    icon,
    requiresFrame,
    requiresImage,
    get label() {
      return t('workflowBar.steps.' + id + '.label')
    },
    get description() {
      return t('workflowBar.steps.' + id + '.description')
    }
  }
}

/**
 * The steps are listed in the order in which they are actually tackled:
 * a first-time user can follow them from top to bottom without knowing
 * anything about astrophotography processing.
 */
export const STEPS: Step[] = [
  makeStep('import', <ImportIcon />, false, false),
  makeStep('calibrate', <CalibrateIcon />, true, false),
  makeStep('align', <AlignIcon />, true, false),
  makeStep('process', <ProcessIcon />, false, true),
  makeStep('correct', <CorrectIcon />, false, true),
  makeStep('filters', <FiltersIcon />, false, true),
  makeStep('objects', <ObjectsIcon />, false, true),
  makeStep('export', <ExportIcon />, false, true)
]

export function WorkflowBar(): JSX.Element {
  const step = useApp((s) => s.step)
  const setStep = useApp((s) => s.setStep)
  const frame = useApp((s) => s.frame)
  // Only whether there is an image: holding the image itself here would keep
  // its pixels alive in the buttons' handlers after it is closed.
  const withImage = useApp((s) => s.image !== null)
  const { importFile } = useLibrary()

  return (
    <nav className="sl-rail" data-guide="workflow" aria-label={t('workflowBar.ariaLabel')}>
      <span className="sl-rail-label">{t('workflowBar.title')}</span>
      {STEPS.map((p, index) => {
        const locked =
          (p.requiresFrame && frame.length === 0) || (p.requiresImage && !withImage)
        const active = step === p.id
        const classes = ['sl-step']
        if (active) classes.push('sl-active')
        // The import step shows as completed once there are frames.
        if (p.id === 'import' && frame.length > 0) classes.push('sl-step-done')

        return (
          <button
            key={p.id}
            type="button"
            className={classes.join(' ')}
            onClick={() => {
              setStep(p.id)
              // With an empty library the only thing to do is choose the
              // files: the file picker opens right away.
              if (p.id === 'import' && frame.length === 0) void importFile()
            }}
            disabled={locked}
            title={
              locked
                ? frame.length === 0
                  ? t('workflowBar.lockedNoFrame', { description: p.description })
                  : t('workflowBar.lockedNoImage', { description: p.description })
                : p.description
            }
            data-guide={'step-' + p.id}
          >
            <span className="sl-step-number">{index + 1}</span>
            {p.icon}
            <span className="sl-step-text">{p.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
