import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Button, Toggle, Slider, Segmented } from './Controls'
import { t, formatDate, formatDecimal, formatNumber, LANGUAGES } from '@shared/i18n/i18n'
import { FolderIcon, CloseIcon, RestartIcon } from './Icons'
import {
  FOLDER_FIELD,
  DEFAULT_SETTINGS,
  GAIA_MAGNITUDE_MAX,
  GAIA_MAGNITUDE_MIN,
  shownSubfolder,
  systemWorkFolder,
  workPaths,
  resetSettings,
  type FolderType,
  writeSettings,
  readSettings,
  useSettings,
  type LanguageSetting
} from '../settings'
import { automaticWorkers, cores } from '../workers/pool'
import { frameCache } from '../hooks/useLibrary'
import { recommendedBudget, formatBytes } from '@core/memory'
import { APP_VERSION } from '@shared/version'
import { checkForUpdatesFromMenu } from './UpdateWindow'
import { restartProgram } from '../hooks/useProject'
import { previewUsage } from '../hooks/framePreviews'
import { gaiaCache } from '../gaiaStars'
import {
  applyChoices,
  softwareRendering,
  measureComputer,
  testGraphics,
  recap,
  currentChoices,
  useComputerChoice
} from '../performance'
import {
  chosenDifferences,
  choicesForComputer,
  type ComputerData,
  type PerformanceChoices
} from '@core/automaticPerformance'
import type { SpaceEntry } from '@shared/performance'
import '../styles/settings.css'

/**
 * Settings window, divided into tabs. Every choice takes effect immediately
 * and is saved to the preferences (see `settings.ts`): there is no Apply
 * button.
 */

export const useSettingsWindow = create<{ isOpen: boolean; open: () => void; close: () => void }>(
  (set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false })
  })
)

type TabId = 'general' | 'performance' | 'telescope' | 'network' | 'updates'

/** Tabs with the language key of their title (translated at render time). */
const TABS: { id: TabId; titleKey: string }[] = [
  { id: 'general', titleKey: 'settingsWindow.tabs.general' },
  { id: 'performance', titleKey: 'settingsWindow.tabs.performance' },
  { id: 'telescope', titleKey: 'settingsWindow.tabs.telescope' },
  { id: 'network', titleKey: 'settingsWindow.tabs.network' },
  { id: 'updates', titleKey: 'settingsWindow.tabs.updates' }
]

const GB = 1073741824


/** Last selected tab, so the window reopens at the same place. */
let lastTab: TabId = 'general'

export function SettingsWindow(): JSX.Element | null {
  const open = useSettingsWindow((s) => s.isOpen)
  if (!open) return null
  // Rendered outside the top bar, whose blur filter would otherwise confine
  // the overlay within it.
  return createPortal(<ModalWindow />, document.body)
}

function ModalWindow(): JSX.Element {
  const close = useSettingsWindow((s) => s.close)
  const [tab, setTab] = useState<TabId>(lastTab)
  const tabList = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Focus goes to the selected tab; on close it returns to where it was.
    const before = document.activeElement as HTMLElement | null
    tabList.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    return () => before?.focus?.()
  }, [])

  function choose(id: TabId, withFocus = false): void {
    lastTab = id
    setTab(id)
    if (withFocus) tabList.current?.querySelector<HTMLButtonElement>('[data-tab="' + id + '"]')?.focus()
  }

  function tabsKey(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const i = TABS.findIndex((s) => s.id === tab)
    let next: number | null = null
    if (e.key === 'ArrowDown') next = (i + 1) % TABS.length
    else if (e.key === 'ArrowUp') next = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    if (next === null) return
    e.preventDefault()
    choose(TABS[next].id, true)
  }

  return (
    <div className="sl-overlay" onClick={close}>
      <div
        className="sl-dialog sl-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-settings-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
          // While the window is open, keys do not reach the viewer
          // shortcuts (0, 1, +, -, R). F1 still works.
          if (e.key !== 'F1') e.stopPropagation()
        }}
      >
        <header className="sl-dialog-head">
          <GearIcon />
          <div>
            <h2 className="sl-dialog-title" id="sl-settings-title">
              {t('settingsWindow.title')}
            </h2>
            <p className="sl-dialog-subtitle">{t('settingsWindow.subtitle')}</p>
          </div>
          <div className="sl-topbar-spacer" />
          <Button variant="ghost" icon={<CloseIcon size={16} />} onClick={close}>
            {t('settingsWindow.close')}
          </Button>
        </header>

        <div className="sl-settings-layout">
          <div
            className="sl-settings-tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t('settingsWindow.sectionsLabel')}
            ref={tabList}
            onKeyDown={tabsKey}
          >
            {TABS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={'sl-tab-' + s.id}
                data-tab={s.id}
                aria-selected={s.id === tab}
                aria-controls="sl-settings-page"
                tabIndex={s.id === tab ? 0 : -1}
                className="sl-settings-tab"
                onClick={() => choose(s.id)}
              >
                {t(s.titleKey)}
              </button>
            ))}
          </div>

          <div
            className="sl-settings-page"
            id="sl-settings-page"
            role="tabpanel"
            aria-labelledby={'sl-tab-' + tab}
          >
            {tab === 'general' ? <GeneralTab /> : null}
            {tab === 'performance' ? <PerformanceTab /> : null}
            {tab === 'telescope' ? <TelescopeTab /> : null}
            {tab === 'network' ? <NetworkTab /> : null}
            {tab === 'updates' ? <UpdatesTab /> : null}
          </div>
        </div>

        <footer className="sl-dialog-footer">
          <Button
            variant="ghost"
            icon={<RestartIcon size={15} />}
            onClick={() => void resetSettings()}
            title={t('settingsWindow.resetHint')}
          >
            {t('settingsWindow.reset')}
          </Button>
          <Button variant="primary" onClick={close}>
            {t('settingsWindow.done')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

/* ---- Shared pieces ---- */

function Entry({
  label,
  explanation,
  children
}: {
  label?: string
  explanation?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div className="sl-settings-item">
      {label ? <span className="sl-settings-label">{label}</span> : null}
      {children}
      {explanation ? <p className="sl-settings-explanation">{explanation}</p> : null}
    </div>
  )
}

/**
 * Path field: the path can be typed by hand or picked with Browse…. The
 * value is saved when the field loses focus or Enter is pressed, not on
 * every keystroke.
 */
function PathField({
  id,
  value,
  placeholder,
  onChangeValue,
  onBrowse
}: {
  id: string
  value: string
  placeholder: string
  onChangeValue: (v: string) => void
  onBrowse: () => Promise<string | null>
}): JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])

  // Paths pasted from File Explorer are often wrapped in quotes.
  const confirm = (): void => {
    const cleaned = text.trim().replace(/^"(.*)"$/, '$1')
    if (cleaned !== value) onChangeValue(cleaned)
  }

  return (
    <div className="sl-settings-row">
      <input
        id={id}
        className="sl-settings-field"
        type="text"
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={confirm}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm()
        }}
      />
      <Button
        icon={<FolderIcon size={16} />}
        onClick={() =>
          void onBrowse().then((choice) => {
            if (choice) onChangeValue(choice)
          })
        }
      >
        {t('settingsWindow.browse')}
      </Button>
      {value !== '' ? (
        <Button variant="ghost" onClick={() => onChangeValue('')} title={t('settingsWindow.clearPathHint')}>
          {t('settingsWindow.clearPath')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * One of the folders derived from the work folder: the path in use and the
 * button to choose a different one, or to return to the one inside the work
 * folder.
 */
function FolderRow({
  name,
  usage,
  path,
  separate: separate,
  onChoose,
  onDefault
}: {
  name: string
  usage: string
  path: string
  separate: boolean
  onChoose: () => Promise<void>
  onDefault: () => void
}): JSX.Element {
  return (
    <div className="sl-settings-folder">
      <div className="sl-settings-folder-head">
        <span className="sl-settings-folder-name">{name}</span>
        {separate ? <span className="sl-settings-folder-note">{t('settingsWindow.folders.separate')}</span> : null}
      </div>
      <div className="sl-settings-row">
        <span className="sl-settings-path" title={path}>
          {path}
        </span>
        <Button icon={<FolderIcon size={16} />} onClick={() => void onChoose()}>
          {separate ? t('settingsWindow.change') : t('settingsWindow.folders.useDifferent')}
        </Button>
        {separate ? (
          <Button variant="ghost" onClick={onDefault} title={t('settingsWindow.folders.defaultHint')}>
            {t('settingsWindow.default')}
          </Button>
        ) : null}
      </div>
      <p className="sl-settings-explanation">{usage}</p>
    </div>
  )
}

/* ---- Tabs ---- */

/** The three derived folders and what they are for (language keys, translated at render time). */
const DERIVED_FOLDERS: { type: FolderType; usageKey: string; choiceTitleKey: string }[] = [
  {
    type: 'projects',
    usageKey: 'settingsWindow.folders.projectsUsage',
    choiceTitleKey: 'settingsWindow.folders.projectsTitle'
  },
  {
    type: 'exports',
    usageKey: 'settingsWindow.folders.exportsUsage',
    choiceTitleKey: 'settingsWindow.folders.exportsTitle'
  },
  {
    type: 'sessions',
    usageKey: 'settingsWindow.folders.sessionsUsage',
    choiceTitleKey: 'settingsWindow.folders.sessionsTitle'
  }
]

/**
 * Up to this many languages the choice is a row of buttons, all visible at
 * once; beyond it the row would not fit and a drop-down list takes its place.
 */
const MAX_LANGUAGE_BUTTONS = 3

/** Languages in alphabetical order of their own names, for the drop-down list. */
const LANGUAGES_BY_NAME = [...LANGUAGES].sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }))

function GeneralTab(): JSX.Element {
  const currentSettings = useSettings()
  const [system, setSystem] = useState('')
  useEffect(() => {
    void systemWorkFolder().then(setSystem)
  }, [])

  // Until the Documents path has arrived, a placeholder is shown.
  const paths = workPaths(currentSettings, system || t('settingsWindow.general.documentsPlaceholder'))

  async function changeJob(): Promise<void> {
    const choice = await window.starlight.chooseFolder(t('settingsWindow.general.workFolderDialog'), paths.job)
    if (!choice) return
    // Choosing the Documents folder again is the same as the default.
    void writeSettings({ workFolder: choice === system ? '' : choice })
  }

  return (
    <>
      <h3 className="sl-settings-page-title">{t('settingsWindow.tabs.general')}</h3>
      <Entry label={t('common.language.label')} explanation={t('common.language.hint')}>
        {LANGUAGES.length <= MAX_LANGUAGE_BUTTONS ? (
          <Segmented<LanguageSetting>
            value={currentSettings.language}
            options={[
              { value: 'auto', label: t('common.language.auto') },
              // Each language is shown with its own name, whatever the current language.
              ...LANGUAGES.map((l) => ({ value: l.value as LanguageSetting, label: l.label }))
            ]}
            onChange={(v) => void writeSettings({ language: v })}
          />
        ) : (
          <select
            className="sl-settings-select"
            value={currentSettings.language}
            onChange={(e) => void writeSettings({ language: e.target.value as LanguageSetting })}
          >
            <option value="auto">{t('common.language.auto')}</option>
            {LANGUAGES_BY_NAME.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        )}
      </Entry>
      <Entry
        label={t('settingsWindow.general.workFolder')}
        explanation={t('settingsWindow.general.workFolderHint')}
      >
        <div className="sl-settings-row">
          <span className="sl-settings-path" title={paths.job}>
            {paths.job}
          </span>
          <Button icon={<FolderIcon size={16} />} onClick={() => void changeJob()}>
            {t('settingsWindow.change')}
          </Button>
          {currentSettings.workFolder !== '' ? (
            <Button
              variant="ghost"
              onClick={() => void writeSettings({ workFolder: '' })}
              title={system ? t('settingsWindow.general.defaultFolderHintPath', { path: system }) : t('settingsWindow.general.defaultFolderHint')}
            >
              {t('settingsWindow.default')}
            </Button>
          ) : null}
        </div>
      </Entry>
      <Entry
        label={t('settingsWindow.folders.label')}
        explanation={t('settingsWindow.folders.hint')}
      >
        <div className="sl-settings-folders">
          {DERIVED_FOLDERS.map((c) => (
            <FolderRow
              key={c.type}
              name={shownSubfolder(currentSettings, system, c.type)}
              usage={t(c.usageKey)}
              path={paths[c.type]}
              separate={currentSettings[FOLDER_FIELD[c.type]] !== ''}
              onChoose={async () => {
                const choice = await window.starlight.chooseFolder(t(c.choiceTitleKey), paths[c.type])
                if (choice) void writeSettings({ [FOLDER_FIELD[c.type]]: choice })
              }}
              onDefault={() => void writeSettings({ [FOLDER_FIELD[c.type]]: '' })}
            />
          ))}
        </div>
      </Entry>
      <Entry explanation={t('settingsWindow.general.reopenHint')}>
        <Toggle
          label={t('settingsWindow.general.reopen')}
          active={currentSettings.reopenLastProject}
          onChange={(v) => void writeSettings({ reopenLastProject: v })}
        />
      </Entry>
      <Entry explanation={t('settingsWindow.general.recoveryHint')}>
        <Toggle
          label={t('settingsWindow.general.recovery')}
          active={currentSettings.recoverySave}
          onChange={(v) => void writeSettings({ recoverySave: v })}
        />
      </Entry>
    </>
  )
}

function PerformanceTab(): JSX.Element {
  const currentSettings = useSettings()
  const [ram, setRam] = useState<number | null>(null)
  useEffect(() => {
    void window.starlight.systemInfo().then((info) => {
      const value = Number(info['totalRam'])
      if (Number.isFinite(value) && value > 0) setRam(value)
    })
  }, [])

  const n = cores()
  const automatic = automaticWorkers()
  const workerChoice = Math.min(currentSettings.analysisWorkers, n)

  const budgetAuto = recommendedBudget(ram ?? 8 * GB)
  // Offered sizes: from 1 GB up to three quarters of the installed memory.
  const cap = ram !== null ? ram * 0.75 : 32 * GB
  const measurements = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64].filter((g) => g * GB <= cap)
  if (currentSettings.frameMemoryGB > 0 && !measurements.includes(currentSettings.frameMemoryGB)) {
    measurements.push(currentSettings.frameMemoryGB)
    measurements.sort((a, b) => a - b)
  }

  return (
    <>
      <h3 className="sl-settings-page-title">{t('settingsWindow.tabs.performance')}</h3>
      <ComputerBox />
      <Entry
        label={t('settingsWindow.performance.threads')}
        explanation={t('settingsWindow.performance.threadsHint', { count: n })}
      >
        <select
          className="sl-settings-select"
          value={workerChoice}
          onChange={(e) => void writeSettings({ analysisWorkers: Number(e.target.value) })}
        >
          <option value={0}>{t('settingsWindow.performance.threadsAuto', { count: automatic })}</option>
          {Array.from({ length: n }, (_, i) => i + 1).map((k) => (
            <option key={k} value={k}>
              {t('settingsWindow.performance.threadsCount', { count: k })}
            </option>
          ))}
        </select>
      </Entry>
      <Entry
        label={t('settingsWindow.performance.memory')}
        explanation={t('settingsWindow.performance.memoryHint', {
          ram: ram !== null ? t('settingsWindow.performance.memoryRam', { size: formatBytes(ram) }) : '',
          used: formatBytes(frameCache.usage),
          budget: formatBytes(frameCache.budget)
        })}
      >
        <select
          className="sl-settings-select"
          value={currentSettings.frameMemoryGB}
          onChange={(e) => void writeSettings({ frameMemoryGB: Number(e.target.value) })}
        >
          <option value={0}>{t('settingsWindow.performance.memoryAuto', { size: formatBytes(budgetAuto) })}</option>
          {measurements.map((g) => (
            <option key={g} value={g}>
              {g} GB
            </option>
          ))}
        </select>
      </Entry>
      <GraphicsEntries />
      <Entry explanation={t('settingsWindow.performance.lowPriorityHint')}>
        <Toggle
          label={t('settingsWindow.performance.lowPriority')}
          active={currentSettings.lowPriorityComputation}
          onChange={(v) => void writeSettings({ lowPriorityComputation: v })}
        />
      </Entry>
      <SpaceSection />
    </>
  )
}

/**
 * Summary of the settings chosen automatically for this computer (see
 * performance.ts) and the button to redo the choice. The button changes
 * nothing by itself: it shows what would change and waits for Apply.
 */
function ComputerBox(): JSX.Element {
  const currentSettings = useSettings()
  const registered = useComputerChoice((s) => s.registered)
  const [proposal, setProposal] = useState<{ computerInfo: ComputerData; choices: PerformanceChoices } | null>(null)
  const [state, setState] = useState<'idle' | 'measuring' | 'alreadyOptimal' | 'unavailable'>('idle')

  const byHand = registered ? chosenDifferences(registered.choices, currentChoices(currentSettings)).length : 0
  const changes = proposal ? chosenDifferences(currentChoices(currentSettings), proposal.choices) : []

  async function optimize(): Promise<void> {
    setState('measuring')
    setProposal(null)
    const computerInfo = await measureComputer()
    if (!computerInfo) {
      setState('unavailable')
      return
    }
    const choices = choicesForComputer(computerInfo)
    if (chosenDifferences(currentChoices(readSettings()), choices).length === 0) {
      // Nothing to change: only the summary and the date are updated.
      await applyChoices(computerInfo, choices)
      setState('alreadyOptimal')
      return
    }
    setProposal({ computerInfo, choices })
    setState('idle')
  }

  const data = registered
    ? formatDate(new Date(registered.data), { day: 'numeric', month: 'long', year: 'numeric' })
    : ''

  return (
    <div className="sl-settings-box">
      <span className="sl-settings-label">{t('settingsWindow.computer.label')}</span>
      <p className="sl-settings-explanation">
        {registered
          ? t('settingsWindow.computer.chosenOn', { recap: recap(registered), date: data })
          : t('settingsWindow.computer.notYet')}
        {byHand > 0
          ? ' ' + (byHand === 1 ? t('settingsWindow.computer.byHandOne') : t('settingsWindow.computer.byHandOther', { count: byHand }))
          : ''}
      </p>
      {proposal ? (
        <>
          <p className="sl-settings-explanation">{t('settingsWindow.computer.applyChanges')}</p>
          <ul className="sl-settings-changes">
            {changes.map((c) => (
              <li key={c.key}>
                {c.name}: {c.before} → <strong>{c.after}</strong>
              </li>
            ))}
          </ul>
          <div className="sl-settings-row">
            <Button
              variant="primary"
              onClick={() => {
                const p = proposal
                setProposal(null)
                void applyChoices(p.computerInfo, p.choices)
              }}
            >
              {t('settingsWindow.computer.apply')}
            </Button>
            <Button variant="ghost" onClick={() => setProposal(null)}>
              {t('settingsWindow.cancel')}
            </Button>
          </div>
        </>
      ) : (
        <div className="sl-settings-row">
          <Button onClick={() => void optimize()} disabledValue={state === 'measuring'}>
            {t('settingsWindow.computer.optimize')}
          </Button>
          {state === 'alreadyOptimal' ? (
            <span className="sl-settings-explanation">{t('settingsWindow.computer.alreadyOptimal')}</span>
          ) : null}
          {state === 'unavailable' ? (
            <span className="sl-settings-explanation sl-settings-explanation-warning">
              {t('settingsWindow.computer.measureFailed')}
            </span>
          ) : null}
        </div>
      )}
      <p className="sl-settings-explanation">{t('settingsWindow.computer.explain')}</p>
    </div>
  )
}

/** GPU and acceleration: choices that take effect at the next startup. */
function GraphicsEntries(): JSX.Element {
  const currentSettings = useSettings()
  const close = useSettingsWindow((s) => s.close)
  // With an outdated bridge (page reloaded during development) this information is missing.
  const inUse = window.starlight.startupChoices?.() ?? null
  const [graphics] = useState(() => testGraphics())
  const toRestart =
    inUse !== null &&
    (inUse.gpu !== currentSettings.gpu || inUse.graphicsAcceleration !== currentSettings.graphicsAcceleration)

  const activeTab = !graphics.webgl2
    ? t('settingsWindow.graphics.noneNoContext')
    : softwareRendering(graphics.name)
      ? t('settingsWindow.graphics.noneSoftware')
      : (graphics.name ?? t('settingsWindow.graphics.unnamed'))

  return (
    <>
      <Entry
        label={t('settingsWindow.graphics.gpu')}
        explanation={t('settingsWindow.graphics.gpuHint', { gpu: activeTab })}
      >
        <select
          className="sl-settings-select"
          value={currentSettings.gpu}
          onChange={(e) =>
            void writeSettings({ gpu: e.target.value === 'low-power' ? 'low-power' : 'high-performance' })
          }
        >
          <option value="high-performance">{t('settingsWindow.graphics.highPerformance')}</option>
          <option value="low-power">{t('settingsWindow.graphics.lowPower')}</option>
        </select>
      </Entry>
      <Entry explanation={t('settingsWindow.graphics.accelerationHint')}>
        <Toggle
          label={t('settingsWindow.graphics.acceleration')}
          active={currentSettings.graphicsAcceleration}
          onChange={(v) => void writeSettings({ graphicsAcceleration: v })}
        />
      </Entry>
      {toRestart ? (
        <div className="sl-settings-box">
          <p className="sl-settings-explanation sl-settings-explanation-warning">
            {t('settingsWindow.graphics.restartNotice')}
          </p>
          <div className="sl-settings-row">
            <Button
              variant="primary"
              icon={<RestartIcon size={15} />}
              onClick={() => {
                close()
                restartProgram()
              }}
            >
              {t('settingsWindow.graphics.restartNow')}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}

/** Items that can be cleared from the Disk space section. */
type ClearableItem = 'window' | 'log' | 'gaia'

/** One row of the section: name, size, purpose and, where possible, a Clear button. */
function SpaceRow({
  name,
  amount,
  explanation,
  clear,
  confirm,
  busy,
  onAsk,
  onCancel,
  onClear
}: {
  name: string
  amount: string
  explanation: string
  clear: boolean
  confirm: boolean
  busy: boolean
  onAsk: () => void
  onCancel: () => void
  onClear: () => void
}): JSX.Element {
  return (
    <div className="sl-settings-folder">
      <div className="sl-settings-folder-head">
        <span className="sl-settings-folder-name">{name}</span>
        <span className="sl-settings-space-amount">{amount}</span>
      </div>
      <p className="sl-settings-explanation">{explanation}</p>
      {clear ? (
        confirm ? (
          <div className="sl-settings-row">
            <span className="sl-settings-explanation">{t('settingsWindow.space.confirm')}</span>
            <Button variant="danger" onClick={onClear} disabledValue={busy}>
              {t('settingsWindow.space.clear')}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabledValue={busy}>
              {t('settingsWindow.cancel')}
            </Button>
          </div>
        ) : (
          <div className="sl-settings-row">
            <Button onClick={onAsk}>{t('settingsWindow.space.clear')}</Button>
          </div>
        )
      ) : null}
    </div>
  )
}

/**
 * Disk space: what StarLight stores on its own and how much space it takes.
 * Sizes are measured by the main process (src/main/performance.ts); Gaia
 * stars and thumbnails live only in memory and are listed separately.
 */
function SpaceSection(): JSX.Element {
  const [entries, setEntries] = useState<SpaceEntry[] | null>(null)
  const [confirm, setConfirm] = useState<ClearableItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [gaia, setGaia] = useState(() => gaiaCache.count())
  const thumbnails = previewUsage()

  async function measurement(): Promise<void> {
    const list = await window.starlight.listDiskUsage?.()
    setEntries(list ?? [])
    setGaia(gaiaCache.count())
  }
  useEffect(() => {
    void measurement()
  }, [])

  async function clear(id: ClearableItem): Promise<void> {
    setBusy(true)
    try {
      if (id === 'window') await window.starlight.clearWindowMemory()
      else if (id === 'log') await window.starlight.clearLog()
      else gaiaCache.clear()
    } catch {
      // On failure things stay as they were: the new measurement shows it.
    } finally {
      setConfirm(null)
      setBusy(false)
      await measurement()
    }
  }

  const entry = (id: SpaceEntry['id']): SpaceEntry | undefined => entries?.find((v) => v.id === id)
  const amount = (v: SpaceEntry | undefined): string =>
    entries === null ? t('settingsWindow.space.measuring') : !v || v.byte === 0 ? t('settingsWindow.space.empty') : formatBytes(v.byte)
  const row = (
    id: ClearableItem | null,
    name: string,
    textMeasurer: string,
    explanation: string
  ): JSX.Element => (
    <SpaceRow
      key={name}
      name={name}
      amount={textMeasurer}
      explanation={explanation}
      clear={id !== null}
      confirm={id !== null && confirm === id}
      busy={busy}
      onAsk={() => setConfirm(id)}
      onCancel={() => setConfirm(null)}
      onClear={() => id && void clear(id)}
    />
  )

  const windowEntry = entry('window')
  return (
    <Entry
      label={t('settingsWindow.space.label')}
      explanation={t('settingsWindow.space.hint')}
    >
      <div className="sl-settings-folders">
        {row(
          'window',
          t('settingsWindow.space.window'),
          amount(windowEntry),
          windowEntry?.clearOnNextStartup ? t('settingsWindow.space.windowHintPending') : t('settingsWindow.space.windowHint')
        )}
        {row(
          'log',
          t('settingsWindow.space.log'),
          amount(entry('log')),
          t('settingsWindow.space.logHint')
        )}
        {row(
          null,
          t('settingsWindow.space.recovery'),
          amount(entry('recovery')),
          t('settingsWindow.space.recoveryHint')
        )}
        {row(
          null,
          t('settingsWindow.space.updates'),
          amount(entry('updates')),
          t('settingsWindow.space.updatesHint')
        )}
        {row(
          'gaia',
          t('settingsWindow.space.gaia'),
          gaia.zones === 0
            ? t('settingsWindow.space.empty')
            : t(gaia.zones === 1 ? 'settingsWindow.space.gaiaAmountOne' : 'settingsWindow.space.gaiaAmountOther', {
                zones: gaia.zones,
                stars: formatNumber(gaia.stars)
              }),
          t('settingsWindow.space.gaiaHint')
        )}
        {row(
          null,
          t('settingsWindow.space.thumbnails'),
          thumbnails.number === 0 ? t('settingsWindow.space.empty') : thumbnails.number + ', ' + formatBytes(thumbnails.byte),
          t('settingsWindow.space.thumbnailsHint')
        )}
      </div>
    </Entry>
  )
}

function TelescopeTab(): JSX.Element {
  const currentSettings = useSettings()
  return (
    <>
      <h3 className="sl-settings-page-title">{t('settingsWindow.tabs.telescope')}</h3>
      <Entry
        label={t('settingsWindow.telescope.folder')}
        explanation={
          <>
            {t('settingsWindow.telescope.hintBefore')}
            <span className="sl-mono">{t('settingsWindow.telescope.networkExample')}</span>
            {t('settingsWindow.telescope.hintAfter')}
          </>
        }
      >
        <PathField
          id="sl-settings-telescope-folder"
          value={currentSettings.telescopeFolder}
          placeholder={t('settingsWindow.telescope.placeholder')}
          onChangeValue={(v) => void writeSettings({ telescopeFolder: v })}
          onBrowse={() =>
            window.starlight.chooseWatchedFolder(currentSettings.telescopeFolder === '' ? null : currentSettings.telescopeFolder)
          }
        />
      </Entry>
    </>
  )
}

function NetworkTab(): JSX.Element {
  const currentSettings = useSettings()
  return (
    <>
      <h3 className="sl-settings-page-title">{t('settingsWindow.tabs.network')}</h3>
      <Entry
        explanation={
          currentSettings.internet ? (
            t('settingsWindow.network.internetOn')
          ) : (
            <span className="sl-settings-explanation-warning">{t('settingsWindow.network.internetOff')}</span>
          )
        }
      >
        <Toggle
          label={t('settingsWindow.network.allowInternet')}
          active={currentSettings.internet}
          onChange={(v) => void writeSettings({ internet: v })}
        />
      </Entry>
      <Entry
        explanation={t('settingsWindow.network.magnitudeHint', { value: formatDecimal(DEFAULT_SETTINGS.gaiaMagnitude, 1) })}
      >
        <Slider
          label={t('settingsWindow.network.magnitude')}
          value={currentSettings.gaiaMagnitude}
          min={GAIA_MAGNITUDE_MIN}
          max={GAIA_MAGNITUDE_MAX}
          step={0.5}
          format={(v) => formatDecimal(v, 1)}
          onChange={(v) => void writeSettings({ gaiaMagnitude: v })}
        />
      </Entry>
    </>
  )
}

function UpdatesTab(): JSX.Element {
  const currentSettings = useSettings()
  return (
    <>
      <h3 className="sl-settings-page-title">{t('settingsWindow.tabs.updates')}</h3>
      <Entry
        explanation={
          currentSettings.internet ? (
            t('settingsWindow.updates.checkHint', { version: APP_VERSION })
          ) : (
            <span className="sl-settings-explanation-warning">{t('settingsWindow.updates.internetOff')}</span>
          )
        }
      >
        <Toggle
          label={t('settingsWindow.updates.checkAtStartup')}
          active={currentSettings.checkForUpdates}
          onChange={(v) => void writeSettings({ checkForUpdates: v })}
        />
      </Entry>
      <Entry
        label={t('settingsWindow.updates.channel')}
        explanation={t('settingsWindow.updates.channelHint')}
      >
        <select
          className="sl-settings-select"
          value={currentSettings.updatesChannel}
          onChange={(e) =>
            void writeSettings({ updatesChannel: e.target.value === 'test' ? 'test' : 'stable' })
          }
        >
          <option value="stable">{t('settingsWindow.updates.stableOnly')}</option>
          <option value="test">{t('settingsWindow.updates.includeDev')}</option>
        </select>
        {currentSettings.updatesChannel === 'test' ? (
          <p className="sl-settings-explanation sl-settings-explanation-warning">
            {t('settingsWindow.updates.devWarning')}
          </p>
        ) : null}
      </Entry>
      <Entry explanation={t('settingsWindow.updates.menuHint')}>
        <div className="sl-settings-row">
          <Button onClick={() => void checkForUpdatesFromMenu(true)}>{t('settingsWindow.updates.checkNow')}</Button>
        </div>
      </Entry>
    </>
  )
}

/** Gear, the usual symbol for settings. */
function GearIcon(): JSX.Element {
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
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}
