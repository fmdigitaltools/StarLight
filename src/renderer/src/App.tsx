import { useEffect, type JSX } from 'react'
import { useApp, useApp as useAppStore, type WorkflowStep } from './store/appStore'
import { TopBar } from './components/TopBar'
import { WorkflowBar } from './components/WorkflowBar'
import { StatusBar } from './components/StatusBar'
import { Viewer } from './components/Viewer'
import { SidePanel } from './panels/SidePanel'
import { Onboarding } from './components/Onboarding'
import { HelpCenter } from './components/HelpCenter'
import { AboutWindow } from './components/AboutWindow'
import { Notices } from './components/Notices'
import { useShortcuts } from './hooks/useShortcuts'
import { useLibrary, fileFromCommandLine } from './hooks/useLibrary'
import { openFromPath, openProjectFromFile, LAST_PROJECT_KEY } from './hooks/useProject'
import { settingsReady } from './settings'
import { suggestRecovery } from './hooks/recovery'
import { RecoveryWindow } from './components/RecoveryWindow'
import { useLanguage } from './useLanguage'
import { t } from '@shared/i18n/i18n'

export default function App(): JSX.Element {
  const setVersions = useApp((s) => s.setVersions)
  const setOnboarding = useApp((s) => s.setOnboarding)
  const onboardingActive = useApp((s) => s.onboardingActive)
  const helpOpenActive = useApp((s) => s.helpOpenActive)
  const infoOpen = useApp((s) => s.infoOpen)
  const openPanel = useApp((s) => s.openPanel)
  const togglePanel = useApp((s) => s.togglePanel)
  // The interface is rebuilt when the language changes, so that every text is
  // read again from the language files; the work state lives in the store
  // and is not affected. The startup effect below stays mounted.
  const language = useLanguage()

  const { importList, openFrame } = useLibrary()

  useShortcuts()

  useEffect(() => {
    let cancelled = false

    const startup = (async () => {
      const versions = await window.starlight.versions()
      if (!cancelled) setVersions(versions)

      const initials = await fileFromCommandLine()
      // If the previous shutdown was not clean, recovering the leftover work
      // is offered first (see hooks/recovery.ts).
      const recovery = await suggestRecovery()
      const recovered = recovery === 'recovered'

      // A file opened with a double-click is loaded immediately: a project
      // is opened (after a recovery, asking for confirmation because there
      // is work to lose), FITS files are imported.
      if (!cancelled && initials.project !== null) {
        if (recovered) await openProjectFromFile(initials.project)
        else await openFromPath(initials.project)
      } else if (!cancelled && initials.fits.length > 0) {
        await importList(initials.fits)
      } else if (!cancelled && !recovered && (await settingsReady()).reopenLastProject) {
        // Reopens the last project, if the settings ask for it and the file
        // still exists. A file opened with a double-click takes precedence.
        const last = (await window.starlight.readPreferences())[LAST_PROJECT_KEY]
        if (typeof last === 'string' && (await window.starlight.exist([last]))[0] && !cancelled) {
          await openFromPath(last)
        }
      }

      const requestedStep = await window.starlight.initialStep()
      if (!cancelled && requestedStep !== null) {
        useAppStore.getState().setStep(requestedStep as WorkflowStep)
      }

      // On the first startup the onboarding tour starts by itself.
      const prefs = await window.starlight.readPreferences()
      if (!cancelled && prefs['onboardingCompleted'] !== true) {
        setOnboarding(true)
      }
    })()

    /*
     * Files opened while StarLight is already running (double-click in File
     * Explorer). They are handled one at a time and only after startup has
     * finished, so they do not overlap with opening the initial files.
     */
    // A failed step must not block the ones that follow.
    let tail: Promise<void> = startup.catch(() => undefined)
    const stop = window.starlight.onFilesOpened((opened) => {
      tail = tail.then(async () => {
        if (cancelled) return
        if (opened.project !== null) {
          // Like File → Open project: asks for confirmation if there is unsaved work.
          await openProjectFromFile(opened.project)
          return
        }
        if (opened.fits.length === 0) return
        const state = useAppStore.getState()
        if (state.job.active) {
          state.notify('warning', t('rendererApp.waitForJob'))
          return
        }
        // They are added to the library and the first one is shown, even if
        // another frame was already in the viewer: it is the one just opened.
        await importList(opened.fits)
        const first = useAppStore.getState().frame.find((f) => f.path === opened.fits[0].path)
        if (first && useAppStore.getState().activeFrameId !== first.id) await openFrame(first.id)
      }).catch(() => undefined)
    })

    return () => {
      cancelled = true
      stop()
    }
  }, [setVersions, setOnboarding, importList, openFrame])

  return (
    <div className="sl-app" key={language}>
      <TopBar />
      <div className={'sl-body' + (openPanel ? ' sl-body--panel-open' : '')}>
        <WorkflowBar />
        <main className="sl-stage">
          <Viewer />
        </main>
        <SidePanel />
        <button
          type="button"
          className={'sl-panel-toggle' + (openPanel ? ' sl-panel-toggle--open' : '')}
          onClick={togglePanel}
          title={openPanel ? t('rendererApp.hideTools') : t('rendererApp.showTools')}
          aria-label={openPanel ? t('rendererApp.hideTools') : t('rendererApp.showTools')}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>
      <StatusBar />

      <Notices />
      {onboardingActive ? <Onboarding /> : null}
      {helpOpenActive ? <HelpCenter /> : null}
      {infoOpen ? <AboutWindow /> : null}
      <RecoveryWindow />
    </div>
  )
}
