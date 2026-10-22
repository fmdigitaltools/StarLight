import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useHistory, undo, repeat } from '../hooks/history'
import { useApp } from '../store/appStore'
import { useLibrary } from '../hooks/useLibrary'
import { useProject } from '../hooks/useProject'
import { effectiveZoom, toggleFullscreen, HISTORY_EVENT } from '../hooks/useShortcuts'
import { keysOf } from '../shortcuts'
import { ShortcutsWindow, useShortcutsWindow } from './ShortcutsWindow'
import { useDetectedStars } from './DetectedStars'
import { SettingsWindow, useSettingsWindow } from './SettingsWindow'
import { PluginGallery } from './PluginGallery'
import { LicenseWindow, useLicenseWindow, openDonations } from './LicenseWindow'
import { BatchWindow, useBatchWindow } from './BatchWindow'
import { GlossaryWindow, useGlossaryWindow } from './GlossaryWindow'
import { donationsNotice } from '@shared/version'
import { UpdateWindow, checkForUpdatesFromMenu } from './UpdateWindow'
import { useLogWindow } from './LogWindow'
import { usePlugin } from '../plugin/registry'
import { useRecentProjects, openRecent, clearRecent } from '../hooks/recentProjects'
import '../styles/project.css'
import '../styles/settings.css'
import { t } from '@shared/i18n/i18n'

/**
 * Drop-down menus of the top bar, drawn like the rest of the app (not the
 * system menu): File, Edit, View, Plugins, Settings and Help. Adding a menu
 * only takes a new entry in the `menu` list of `MenuBar`; a menu without a
 * drop-down (like Settings) has `action` instead of `entries`.
 *
 * Keyboard: Enter, Space or Down arrow open the menu; the arrows move
 * through the entries, skipping unavailable ones; Enter runs the entry; Esc
 * closes the menu and returns focus to its title; Left and Right arrows
 * move to the adjacent menu.
 */

export type MenuEntry =
  | {
      type?: 'item'
      label: string
      action: () => void
      /** Keys shown on the right, as a reminder only. */
      keys?: string
      /** Short note on the right in place of the keys. */
      note?: string
      disabled?: boolean
      hint?: string
      /**
       * Toggle entry: true or false shows the state with a check mark;
       * absent for normal entries.
       */
      checked?: boolean
      /**
       * Side submenu: the entry does not run an action but opens a second
       * list on its right (for example the recent projects).
       */
      submenu?: MenuEntry[]
    }
  | { type: 'separator' }

export interface MenuDefinition {
  id: string
  label: string
  /** Drop-down entries. */
  entries?: MenuEntry[]
  /** Menu without a drop-down: the title runs this action directly. */
  action?: () => void
  hint?: string
}

export function MenuBar(): JSX.Element {
  const project = useApp((s) => s.project)
  const empty = useApp((s) => s.frame.length === 0 && s.image === null)
  const noImage = useApp((s) => s.image === null)
  const markers = useApp((s) => s.adjustments.showStars)
  const openPanel = useApp((s) => s.openPanel)
  const visibleStars = useDetectedStars((s) => s.visibleItems)
  const { importFile, importFolder } = useLibrary()
  const { newValue, open, save, saveAs, close, exit } = useProject()

  // Actions read the state at click time, not when the menu is drawn.
  const appState = useApp.getState
  const recent = useRecentProjects((s) => s.entries)
  const undoStep = useHistory((s) => (s.index > 0 ? s.steps[s.index].label : null))
  const redoStep = useHistory((s) => (s.index < s.steps.length - 1 ? s.steps[s.index + 1].label : null))

  const menu: MenuDefinition[] = [
    {
      id: 'file',
      label: t('menuBar.file.title'),
      entries: [
        { label: t('menuBar.file.newProject'), action: newValue, keys: keysOf('new'), disabled: empty },
        { label: t('menuBar.file.openProject'), action: () => void open(), keys: keysOf('open') },
        {
          label: t('menuBar.file.recentProjects'),
          action: () => undefined,
          // The last five, most recent first: a click reopens them.
          submenu:
            recent.length > 0
              ? [
                  ...recent.map(
                    (r): MenuEntry => ({
                      label: r.name,
                      action: () => void openRecent(r),
                      hint: r.folder
                    })
                  ),
                  { type: 'separator' },
                  { label: t('menuBar.file.clearRecent'), action: clearRecent }
                ]
              : [{ label: t('menuBar.file.noRecent'), action: () => undefined, disabled: true }]
        },
        {
          label: t('menuBar.file.save'),
          action: () => void save(),
          keys: keysOf('save'),
          disabled: empty,
          hint: project ? t('menuBar.file.saveHint', { name: project.name }) : undefined
        },
        { label: t('menuBar.file.saveAs'), action: saveAs, keys: keysOf('saveAs'), disabled: empty },
        { label: t('menuBar.file.closeProject'), action: close, keys: keysOf('close'), disabled: empty },
        { type: 'separator' },
        { label: t('menuBar.file.importFiles'), action: () => void importFile(), keys: keysOf('import') },
        { label: t('menuBar.file.importFolder'), action: () => void importFolder() },
        {
          label: t('menuBar.file.export'),
          action: () => {
            const s = useApp.getState()
            s.setStep('export')
            if (!s.openPanel) s.togglePanel()
          },
          keys: keysOf('export'),
          disabled: noImage
        },
        {
          label: t('menuBar.file.batch'),
          action: () => useBatchWindow.getState().open(),
          hint: t('menuBar.file.batchHint')
        },
        { type: 'separator' },
        { label: t('menuBar.file.exit'), action: exit }
      ]
    },
    {
      id: 'edit',
      label: t('menuBar.edit.title'),
      entries: [
        {
          label: undoStep ? t('menuBar.edit.undoStep', { step: undoStep }) : t('menuBar.edit.undo'),
          action: undo,
          keys: keysOf('undo'),
          disabled: undoStep === null
        },
        {
          label: redoStep ? t('menuBar.edit.redoStep', { step: redoStep }) : t('menuBar.edit.redo'),
          action: repeat,
          keys: keysOf('redo'),
          disabled: redoStep === null
        },
        { type: 'separator' },
        {
          label: t('menuBar.edit.history'),
          action: () => window.dispatchEvent(new Event(HISTORY_EVENT)),
          keys: keysOf('history'),
          disabled: undoStep === null && redoStep === null,
          hint: t('menuBar.edit.historyHint')
        }
      ]
    },
    {
      id: 'view',
      label: t('menuBar.view.title'),
      entries: [
        {
          label: t('menuBar.view.fit'),
          action: () => appState().fitView(),
          keys: keysOf('fit'),
          disabled: noImage
        },
        {
          label: t('menuBar.view.actualSize'),
          action: () => appState().setZoom(1),
          keys: keysOf('actualSize'),
          disabled: noImage,
          hint: t('menuBar.view.actualSizeHint')
        },
        {
          label: t('menuBar.view.zoomIn'),
          action: () => appState().setZoom(effectiveZoom() * 1.25),
          keys: keysOf('zoomIn'),
          disabled: noImage
        },
        {
          label: t('menuBar.view.zoomOut'),
          action: () => appState().setZoom(effectiveZoom() / 1.25),
          keys: keysOf('zoomOut'),
          disabled: noImage
        },
        { type: 'separator' },
        {
          label: t('menuBar.view.markers'),
          action: () => appState().updateAdjustments({ showStars: !appState().adjustments.showStars }),
          keys: keysOf('markers'),
          checked: markers,
          disabled: noImage,
          hint: t('menuBar.view.markersHint')
        },
        {
          label: t('menuBar.view.stars'),
          action: () => useDetectedStars.getState().toggle(),
          keys: keysOf('stars'),
          checked: visibleStars,
          disabled: noImage,
          hint: t('menuBar.view.starsHint')
        },
        { type: 'separator' },
        {
          label: t('menuBar.view.panel'),
          action: () => appState().togglePanel(),
          keys: keysOf('panel'),
          checked: openPanel
        },
        {
          label: t('menuBar.view.fullScreen'),
          action: toggleFullscreen,
          keys: keysOf('fullScreen')
        }
      ]
    },
    {
      id: 'plugin',
      label: t('menuBar.plugins.title'),
      // No drop-down: the title opens the gallery directly. Installed plugins
      // are enabled and adjusted in the Process step.
      action: () => usePlugin.getState().openGallery(),
      hint: t('menuBar.plugins.hint')
    },
    {
      id: 'settings',
      label: t('menuBar.settings.title'),
      action: () => useSettingsWindow.getState().open(),
      hint: t('menuBar.settings.hint')
    },
    {
      id: 'help',
      label: t('menuBar.help.title'),
      entries: [
        {
          label: t('menuBar.help.onboarding'),
          action: () => appState().setOnboarding(true),
          hint: t('menuBar.help.onboardingHint')
        },
        { label: t('menuBar.help.guide'), action: () => appState().setHelpOpen(true), keys: keysOf('help') },
        {
          label: t('menuBar.help.glossary'),
          action: () => useGlossaryWindow.getState().open(),
          hint: t('menuBar.help.glossaryHint')
        },
        { type: 'separator' },
        {
          label: t('menuBar.help.checkUpdates'),
          action: () => void checkForUpdatesFromMenu(),
          hint: t('menuBar.help.checkUpdatesHint')
        },
        {
          label: t('menuBar.help.log'),
          action: () => useLogWindow.getState().open(),
          hint: t('menuBar.help.logHint')
        },
        { type: 'separator' },
        {
          label: t('menuBar.help.shortcuts'),
          action: () => useShortcutsWindow.getState().open(),
          keys: keysOf('shortcutList'),
          hint: t('menuBar.help.shortcutsHint')
        },
        { type: 'separator' },
        { label: t('menuBar.help.license'), action: () => useLicenseWindow.getState().open() },
        {
          label: t('menuBar.help.support'),
          // Without a donations page to open, a notice instead of a broken link.
          action: () => {
            if (!openDonations()) appState().notify('info', donationsNotice())
          },
          hint: t('menuBar.help.supportHint')
        },
        { label: t('menuBar.help.about'), action: () => appState().setInfo(true) }
      ]
    }
  ]

  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  /** Menu whose first entry receives focus as soon as it opens (when moving with the arrows). */
  const focusOnFirst = useRef<string | null>(null)

  // Closes when clicking elsewhere.
  useEffect(() => {
    if (openMenu === null) return
    function outside(e: MouseEvent): void {
      if (bar.current && !bar.current.contains(e.target as Node)) setOpenMenu(null)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [openMenu])

  // After moving with the arrows from inside a drop-down, focus goes to
  // the first available entry of the adjacent menu.
  useEffect(() => {
    if (openMenu === null || focusOnFirst.current !== openMenu) return
    focusOnFirst.current = null
    bar.current
      ?.querySelector<HTMLButtonElement>('[data-dropdown="' + openMenu + '"] button:not(:disabled)')
      ?.focus()
  }, [openMenu])

  function moveMenu(id: string, direction: 1 | -1, fromInside: boolean): void {
    const i = menu.findIndex((m) => m.id === id)
    const next = menu[(i + direction + menu.length) % menu.length]
    // A menu without a drop-down only receives focus: there is nothing to open.
    setOpenMenu(next.entries ? next.id : null)
    bar.current?.querySelector<HTMLButtonElement>('[data-menu="' + next.id + '"]')?.focus()
    if (fromInside && next.entries) focusOnFirst.current = next.id
  }

  return (
    <div className="sl-menubar" ref={bar} role="menubar" data-guide="menubar">
      {menu.map((m) => (
        <Dropdown
          key={m.id}
          definition={m}
          openMenu={openMenu === m.id}
          // With a menu already open, hovering another title opens it.
          onHover={() => {
            if (openMenu !== null && openMenu !== m.id) setOpenMenu(m.entries ? m.id : null)
          }}
          onToggle={() => {
            if (m.action) {
              setOpenMenu(null)
              m.action()
            } else setOpenMenu(openMenu === m.id ? null : m.id)
          }}
          onOpen={() => setOpenMenu(m.id)}
          onClose={() => setOpenMenu(null)}
          onMove={(direction, fromInside) => moveMenu(m.id, direction, fromInside)}
        />
      ))}
      {/* The project name, with the unsaved-changes dot, is in the bar above the viewer. */}
      <SettingsWindow />
      <PluginGallery />
      <LicenseWindow />
      <BatchWindow />
      <ShortcutsWindow />
      <GlossaryWindow />
      <UpdateWindow />
    </div>
  )
}

interface DropdownProps {
  definition: MenuDefinition
  openMenu: boolean
  onHover: () => void
  onToggle: () => void
  onOpen: () => void
  onClose: () => void
  onMove: (direction: 1 | -1, fromInside: boolean) => void
}

function Dropdown({
  definition,
  openMenu,
  onHover,
  onToggle,
  onOpen,
  onClose,
  onMove
}: DropdownProps): JSX.Element {
  const title = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  /** Which entry receives focus when opened from the keyboard: first or last. */
  const initialFocus = useRef<'first' | 'last' | null>(null)
  const entries = definition.entries
  // If at least one entry has a check mark, all entries leave room for it
  // so that the labels stay aligned.
  const withChecks = entries?.some((v) => v.type !== 'separator' && v.checked !== undefined) ?? false

  /** Index of the entry whose side submenu is open. */
  const [submenuOpen, setSubmenuOpen] = useState<number | null>(null)
  useEffect(() => {
    if (!openMenu) setSubmenuOpen(null)
  }, [openMenu])

  const activeEntries = (): HTMLButtonElement[] =>
    Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled), :scope > .sl-menu-group > button:not(:disabled)') ?? []
    )

  useEffect(() => {
    if (!openMenu || initialFocus.current === null) return
    const active = activeEntries()
    ;(initialFocus.current === 'first' ? active[0] : active[active.length - 1])?.focus()
    initialFocus.current = null
  }, [openMenu])

  function closeAndReturn(): void {
    onClose()
    title.current?.focus()
  }

  function titleKey(e: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      onMove(e.key === 'ArrowRight' ? 1 : -1, false)
      return
    }
    // A menu without a drop-down behaves like a button.
    if (!entries) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onToggle()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      initialFocus.current = 'first'
      if (openMenu) activeEntries()[0]?.focus()
      else onOpen()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      initialFocus.current = 'last'
      if (openMenu) activeEntries().slice(-1)[0]?.focus()
      else onOpen()
    } else if (e.key === 'Escape' && openMenu) {
      e.preventDefault()
      onClose()
    }
  }

  function openSubmenu(index: number, withFocus: boolean): void {
    setSubmenuOpen(index)
    if (withFocus) {
      requestAnimationFrame(() =>
        list.current?.querySelector<HTMLButtonElement>('.sl-menu-submenu button:not(:disabled)')?.focus()
      )
    }
  }

  /** Keys inside the submenu: up and down through its entries, Left or Esc to go back. */
  function submenuKey(e: ReactKeyboardEvent<HTMLDivElement>, index: number): void {
    const active = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const i = active.indexOf(document.activeElement as HTMLButtonElement)
    const goBack = (): void => {
      setSubmenuOpen(null)
      list.current?.querySelector<HTMLButtonElement>('[data-submenu="' + index + '"]')?.focus()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      active[(i + step + active.length) % active.length]?.focus()
    } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      e.preventDefault()
      goBack()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
    } else if (e.key === 'Tab') {
      onClose()
    } else return
    e.stopPropagation()
  }

  function listKey(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const active = activeEntries()
    const i = active.indexOf(document.activeElement as HTMLButtonElement)
    let next: HTMLButtonElement | undefined
    if (e.key === 'ArrowDown') next = active[(i + 1) % active.length]
    else if (e.key === 'ArrowUp') next = active[(i - 1 + active.length) % active.length]
    else if (e.key === 'Home') next = active[0]
    else if (e.key === 'End') next = active[active.length - 1]
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeAndReturn()
      return
    } else if (e.key === 'ArrowRight' && document.activeElement?.hasAttribute('data-submenu')) {
      // On the entry with the submenu, the Right arrow opens it.
      e.preventDefault()
      openSubmenu(Number(document.activeElement.getAttribute('data-submenu')), true)
      return
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      onMove(e.key === 'ArrowRight' ? 1 : -1, true)
      return
    } else if (e.key === 'Tab') {
      onClose()
      return
    }
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  return (
    <div className="sl-menu">
      <button
        ref={title}
        type="button"
        className={'sl-menu-title' + (openMenu ? ' sl-menu-title--open' : '')}
        data-menu={definition.id}
        data-guide={'menu-' + definition.id}
        role="menuitem"
        aria-haspopup={entries ? 'menu' : undefined}
        aria-expanded={entries ? openMenu : undefined}
        title={definition.hint}
        onClick={onToggle}
        onMouseEnter={onHover}
        onKeyDown={titleKey}
      >
        {definition.label}
      </button>
      {openMenu && entries ? (
        <div
          ref={list}
          className="sl-menu-dropdown"
          role="menu"
          aria-label={definition.label}
          data-dropdown={definition.id}
          onKeyDown={listKey}
        >
          {entries.map((v, i) =>
            v.type === 'separator' ? (
              <div key={'sep' + i} className="sl-menu-separator" role="separator" />
            ) : v.submenu ? (
              <div key={v.label} className="sl-menu-group" onMouseEnter={() => openSubmenu(i, false)}>
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={submenuOpen === i}
                  data-submenu={i}
                  className={'sl-menu-item' + (submenuOpen === i ? ' sl-menu-item--open' : '')}
                  disabled={v.disabled}
                  title={v.hint}
                  onMouseEnter={(e) => e.currentTarget.focus()}
                  onClick={() => openSubmenu(i, true)}
                >
                  <span className="sl-menu-item-text">
                    {withChecks ? <span className="sl-menu-check" aria-hidden="true" /> : null}
                    {v.label}
                  </span>
                  <span className="sl-menu-arrow" aria-hidden="true">›</span>
                </button>
                {submenuOpen === i ? (
                  <div
                    className="sl-menu-dropdown sl-menu-submenu"
                    role="menu"
                    aria-label={v.label}
                    onKeyDown={(e) => submenuKey(e, i)}
                  >
                    {v.submenu.map((sv, j) =>
                      sv.type === 'separator' ? (
                        <div key={'sep' + j} className="sl-menu-separator" role="separator" />
                      ) : (
                        <button
                          key={sv.label + j}
                          type="button"
                          role="menuitem"
                          className="sl-menu-item"
                          disabled={sv.disabled}
                          title={sv.hint}
                          onMouseEnter={(e) => e.currentTarget.focus()}
                          onClick={() => {
                            onClose()
                            sv.action()
                          }}
                        >
                          <span className="sl-menu-item-text">{sv.label}</span>
                          {sv.note ? <span className="sl-menu-note">{sv.note}</span> : null}
                        </button>
                      )
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <button
                key={v.label}
                type="button"
                role={v.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={v.checked}
                className="sl-menu-item"
                disabled={v.disabled}
                title={v.hint}
                onMouseEnter={(e) => {
                  setSubmenuOpen(null)
                  e.currentTarget.focus()
                }}
                onClick={() => {
                  onClose()
                  v.action()
                }}
              >
                <span className="sl-menu-item-text">
                  {withChecks ? (
                    <span className="sl-menu-check" aria-hidden="true">
                      {v.checked ? <Checkmark /> : null}
                    </span>
                  ) : null}
                  {v.label}
                </span>
                {v.keys ? <span className="sl-menu-keys">{v.keys}</span> : null}
                {v.note ? <span className="sl-menu-note">{v.note}</span> : null}
              </button>
            )
          )}
        </div>
      ) : null}
    </div>
  )
}

function Checkmark(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  )
}
