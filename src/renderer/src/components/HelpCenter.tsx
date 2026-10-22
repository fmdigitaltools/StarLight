import { Fragment, type JSX } from 'react'
import { t, byLanguage, format } from '@shared/i18n/i18n'
import { useApp } from '../store/appStore'
import { Button } from './Controls'
import {
  CloseIcon,
  ImportIcon,
  CorrectIcon,
  FiltersIcon,
  ObjectsIcon,
  ExportIcon,
  CropIcon,
  CalibrateIcon,
  AlignIcon,
  StarIcon,
  WandIcon,
  ProcessIcon,
  HelpIcon,
  FolderIcon,
  EyeIcon,
  InfoIcon, RestartIcon, StraightenIcon } from './Icons'
import { OBJECT_COUNT } from '@core/catalog/catalog'
import { licenseNote } from '@shared/version'
import { ShortcutList } from './ShortcutsWindow'
import { keysOf } from '../shortcuts'
import { useGlossaryWindow } from './GlossaryWindow'
import { getTerms } from '../glossary/terms'
import { HELP_CONTENT_IT, type HelpContent, type HelpIconName } from './helpContent.it'
import { HELP_CONTENT_EN } from './helpContent.en'
import '../styles/glossary.css'

/** Icon component for each icon name used in the help content. */
const ICONS: Record<HelpIconName, (props: { size?: number }) => JSX.Element> = {
  process: ProcessIcon,
  folder: FolderIcon,
  import: ImportIcon,
  calibrate: CalibrateIcon,
  align: AlignIcon,
  eye: EyeIcon,
  wand: WandIcon,
  correct: CorrectIcon,
  filters: FiltersIcon,
  objects: ObjectsIcon,
  export: ExportIcon,
  crop: CropIcon,
  straighten: StraightenIcon,
  restart: RestartIcon,
  info: InfoIcon,
  star: StarIcon
}

/** Help content in the current language. */
function helpContent(): HelpContent {
  return byLanguage({ it: HELP_CONTENT_IT, en: HELP_CONTENT_EN })
}

export function HelpCenter(): JSX.Element {
  const setHelpOpen = useApp((s) => s.setHelpOpen)
  const setOnboarding = useApp((s) => s.setOnboarding)
  const content = helpContent()

  function reviewGuide(): void {
    setHelpOpen(false)
    setOnboarding(true)
  }

  /** Closes the guide and opens the glossary, optionally on a given entry. */
  function openGlossary(term?: string): void {
    setHelpOpen(false)
    useGlossaryWindow.getState().open(term)
  }

  return (
    <div className="sl-overlay" onClick={() => setHelpOpen(false)}>
      <div className="sl-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="sl-dialog-head">
          <HelpIcon size={22} />
          <div>
            <h2 className="sl-dialog-title">{t('helpCenter.title')}</h2>
            <p className="sl-dialog-subtitle">{t('helpCenter.subtitle')}</p>
          </div>
          <div className="sl-topbar-spacer" />
          <Button
            variant="ghost"
            icon={<CloseIcon size={16} />}
            onClick={() => setHelpOpen(false)}
          >
            {t('helpCenter.close')}
          </Button>
        </header>

        <div className="sl-dialog-body">
          <h3 className="sl-guide-section-title">{t('helpCenter.sections.tools')}</h3>
          <div className="sl-guide-grid">
            {content.tools.map((s) => {
              const Icon = ICONS[s.icon]
              return (
                <div key={s.title} className="sl-guide-entry">
                  <div className="sl-guide-icon">
                    <Icon size={18} />
                  </div>
                  <div className="sl-guide-entry-title">{s.title}</div>
                  <p className="sl-guide-entry-text">
                    {format(s.text, { objectCount: OBJECT_COUNT, cropKey: keysOf('crop') })}
                  </p>
                </div>
              )
            })}
          </div>

          <h3 className="sl-guide-section-title">{t('helpCenter.sections.shortcuts')}</h3>
          <p className="sl-guide-entry-text sl-guide-shortcuts-intro">
            {format(content.shortcutsIntro, {
              compareKey: keysOf('compare'),
              shortcutListKey: keysOf('shortcutList')
            })}
          </p>
          <div className="sl-shortcuts-in-guide">
            <ShortcutList />
          </div>

          <h3 className="sl-guide-section-title">{t('helpCenter.sections.glossary')}</h3>
          <p className="sl-guide-entry-text sl-guide-shortcuts-intro">
            {format(content.glossaryIntro, { count: getTerms().length })}
            {content.initialEntries.map((term, i) => (
              <Fragment key={term}>
                {i > 0 ? ', ' : ''}
                <button type="button" className="sl-glossary-link" onClick={() => openGlossary(term)}>
                  {term}
                </button>
              </Fragment>
            ))}
            .
          </p>
          <Button variant="secondary" icon={<HelpIcon size={15} />} onClick={() => openGlossary()}>
            {t('helpCenter.openGlossary')}
          </Button>
        </div>

        <footer className="sl-dialog-footer">
          <span className="sl-guide-entry-text">
            {t('helpCenter.footer.tourNote')}
            <br />
            <span className="sl-selectable" style={{ opacity: 0.75 }}>{licenseNote()}</span>
          </span>
          <Button variant="primary" icon={<WandIcon size={15} />} onClick={reviewGuide}>
            {t('helpCenter.footer.replayTour')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
