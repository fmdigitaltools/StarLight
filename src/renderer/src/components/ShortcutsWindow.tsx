import { Fragment, useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Button } from './Controls'
import { CloseIcon, HelpIcon } from './Icons'
import {
  GROUPS,
  REMINDERS,
  SHORTCUTS,
  shownCombinations,
  shortcutFor,
  keysOf,
  type ShortcutGroup
} from '../shortcuts'
import { t } from '@shared/i18n/i18n'
import '../styles/shortcuts.css'

/**
 * Keyboard shortcuts window, opened from Help or with Ctrl+/ (or "?"): the
 * complete list, divided into groups, with a search field. Keys and
 * descriptions come from `shortcuts.ts`, the same source used by the key
 * handler, so the list always matches the actual behavior.
 */

export const useShortcutsWindow = create<{
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
}>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen }))
}))

export function ShortcutsWindow(): JSX.Element | null {
  const open = useShortcutsWindow((s) => s.isOpen)
  if (!open) return null
  // Rendered outside the menu bar, like the other windows opened from it.
  return createPortal(<ModalWindow />, document.body)
}

/** Language-file key of the title shown for each group. */
const GROUP_LABELS: Record<ShortcutGroup, string> = {
  File: 'shortcutsWindow.groups.file',
  Edit: 'shortcutsWindow.groups.edit',
  View: 'shortcutsWindow.groups.view',
  Workflow: 'shortcutsWindow.groups.workflow',
  Image: 'shortcutsWindow.groups.image',
  Help: 'shortcutsWindow.groups.help'
}

interface Row {
  group: ShortcutGroup
  keys: string[][]
  action: string
  words?: string
}

/** All rows, actual shortcuts and mouse reminders, group by group. */
function rows(): Row[] {
  const all: Row[] = [
    ...SHORTCUTS.map((s) => ({ group: s.group, keys: shownCombinations(s), action: s.action, words: s.words })),
    ...REMINDERS
  ]
  return GROUPS.flatMap((g) => all.filter((r) => r.group === g))
}

/** Removes accents and capitals, so that "modalita" matches "modalità". */
function normalize(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/** A key combination drawn as keys: Ctrl + Shift + S. */
function Keys({ keys }: { keys: string[] }): JSX.Element {
  return (
    <span className="sl-shortcut-combo">
      {keys.map((t, i) => (
        <Fragment key={t + i}>
          {i > 0 ? <span className="sl-shortcut-plus">+</span> : null}
          <kbd className="sl-key sl-key-large">{t}</kbd>
        </Fragment>
      ))}
    </span>
  )
}

/**
 * The grouped list, used by this window and by the help center. With a
 * search query it shows only the rows that contain it, in the description
 * or in the keys.
 */
export function ShortcutList({ search = '' }: { search?: string }): JSX.Element {
  const normalizedQuery = normalize(search.trim())
  const visibleItems = rows().filter(
    (r) =>
      normalizedQuery === '' ||
      normalize(r.action).includes(normalizedQuery) ||
      normalize(t(GROUP_LABELS[r.group])).includes(normalizedQuery) ||
      normalize(r.words ?? '').includes(normalizedQuery) ||
      r.keys.some((c) => normalize(c.join('+')).includes(normalizedQuery))
  )
  if (visibleItems.length === 0) {
    return <p className="sl-note sl-shortcuts-empty">{t('shortcutsWindow.noResults', { query: search.trim() })}</p>
  }
  return (
    <div className="sl-shortcuts-groups">
      {GROUPS.map((g) => {
        const ofGroup = visibleItems.filter((r) => r.group === g)
        if (ofGroup.length === 0) return null
        return (
          <section key={g} className="sl-shortcuts-group">
            <h3 className="sl-guide-section-title">{t(GROUP_LABELS[g])}</h3>
            <ul className="sl-shortcuts-list">
              {ofGroup.map((r) => (
                <li key={r.action} className="sl-shortcut">
                  <span className="sl-shortcut-keys">
                    {r.keys.map((c, i) => (
                      <Fragment key={c.join('+')}>
                        {i > 0 ? <span className="sl-shortcut-or">{t('shortcutsWindow.or')}</span> : null}
                        <Keys keys={c} />
                      </Fragment>
                    ))}
                  </span>
                  <span className="sl-shortcut-action">{r.action}</span>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function ModalWindow(): JSX.Element {
  const close = useShortcutsWindow((s) => s.close)
  const [search, setSearch] = useState('')
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    field.current?.focus()
    return () => before?.focus?.()
  }, [])

  return (
    <div className="sl-overlay" onClick={close}>
      <div
        className="sl-dialog sl-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-shortcuts-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            // The first Esc clears the search, the second one closes the window.
            if (search !== '') setSearch('')
            else close()
            return
          }
          // Ctrl+/ closes this window even from the search field, while "?"
          // stays a character that can be typed.
          const s = shortcutFor(e.nativeEvent)
          if (s?.id === 'shortcutList' && e.ctrlKey) {
            e.preventDefault()
            e.stopPropagation()
            close()
            return
          }
          // Only F1 and F11 reach the general key handler; all other keys
          // stay here and never reach the viewer.
          if (!(s !== null && (s.id === 'help' || s.id === 'fullScreen'))) e.stopPropagation()
        }}
      >
        <header className="sl-dialog-head">
          <HelpIcon size={22} />
          <div>
            <h2 className="sl-dialog-title" id="sl-shortcuts-title">
              {t('shortcutsWindow.title')}
            </h2>
            <p className="sl-dialog-subtitle">
              {t('shortcutsWindow.subtitle', { keys: keysOf('shortcutList') })}
            </p>
          </div>
        </header>

        <div className="sl-shortcuts-search">
          <input
            ref={field}
            className="sl-settings-field"
            type="search"
            placeholder={t('shortcutsWindow.searchPlaceholder')}
            aria-label={t('shortcutsWindow.searchLabel')}
            value={search}
            spellCheck={false}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="sl-dialog-body">
          <ShortcutList search={search} />
        </div>

        <footer className="sl-dialog-footer">
          <span className="sl-guide-entry-text">
            {t('shortcutsWindow.footnote')}
          </span>
          <Button variant="primary" icon={<CloseIcon size={15} />} onClick={close}>
            {t('shortcutsWindow.close')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
