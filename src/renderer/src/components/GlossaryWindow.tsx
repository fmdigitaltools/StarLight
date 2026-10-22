import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Button } from './Controls'
import { CloseIcon, HelpIcon } from './Icons'
import { shortcutFor } from '../shortcuts'
import {
  GLOSSARY_CATEGORIES,
  getTerms,
  type GlossaryCategory,
  type GlossaryEntry
} from '../glossary/terms'
import { getLanguage, t } from '@shared/i18n/i18n'
import '../styles/glossary.css'

/**
 * Glossary window, opened from the Help menu and from the help center: the
 * terms used in StarLight, with their definition and their role in the
 * program, a search field, a category filter and "See also" links that
 * jump to the related entry. The texts live in `glossary/terms.ts`.
 */

export const useGlossaryWindow = create<{
  isOpen: boolean
  /** Entry to show when the window opens, if requested. */
  initial: string | null
  open: (term?: string) => void
  close: () => void
}>((set) => ({
  isOpen: false,
  initial: null,
  open: (term) => set({ isOpen: true, initial: term ?? null }),
  close: () => set({ isOpen: false, initial: null })
}))

export function GlossaryWindow(): JSX.Element | null {
  const open = useGlossaryWindow((s) => s.isOpen)
  if (!open) return null
  // Rendered outside the menu bar, like the other windows opened from it.
  return createPortal(<ModalWindow />, document.body)
}

/** Removes capitals, accents and typographic apostrophes, so that "modalita" matches "modalità". */
function normalize(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`]/g, "'")
}

/** Stable identifier of an entry, used for cross-references and scrolling. */
function idOf(v: GlossaryEntry): string {
  return 'sl-glossary-' + normalize(v.term).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

interface GlossaryIndex {
  /** Entries in alphabetical order for the current language. */
  sorted: GlossaryEntry[]
  /**
   * Names an entry can be reached by: the terms first, then the alternative
   * names, which never override an actual term.
   */
  byName: Map<string, GlossaryEntry>
  /** Normalized searchable text for each entry. */
  text: Map<GlossaryEntry, { names: string; everything: string }>
}

/** Indexes built once per list of entries (one list per language). */
const INDEXES = new WeakMap<GlossaryEntry[], GlossaryIndex>()

function glossaryIndex(): GlossaryIndex {
  const terms = getTerms()
  const cached = INDEXES.get(terms)
  if (cached) return cached
  const locale = getLanguage()
  const sorted = [...terms].sort((a, b) => a.term.localeCompare(b.term, locale, { sensitivity: 'base' }))
  const byName = new Map<string, GlossaryEntry>()
  for (const v of terms) byName.set(normalize(v.term), v)
  for (const v of terms) {
    for (const a of v.alternatives ?? []) {
      const key = normalize(a)
      if (!byName.has(key)) byName.set(key, v)
    }
  }
  const text = new Map<GlossaryEntry, { names: string; everything: string }>(
    terms.map((v) => {
      const names = normalize([v.term, ...(v.alternatives ?? [])].join(' \u0001 '))
      return [v, { names, everything: names + ' ' + normalize(v.definition + ' ' + v.inStarLight) }]
    })
  )
  const index = { sorted, byName, text }
  INDEXES.set(terms, index)
  return index
}

/** The entry a cross-reference points to, or null if the name matches none. */
export function glossaryEntry(name: string): GlossaryEntry | null {
  return glossaryIndex().byName.get(normalize(name)) ?? null
}

/**
 * Relevance of an entry for a search: 0 if the term contains the query,
 * 1 if an alternative name contains it, 2 if it appears only in the text,
 * -1 if it does not appear. With several words, all of them must match.
 */
function relevance(v: GlossaryEntry, normalizedQuery: string): number {
  if (normalizedQuery === '') return 0
  const words = normalizedQuery.split(/\s+/).filter(Boolean)
  const found = glossaryIndex().text.get(v)!
  if (!words.every((p) => found.everything.includes(p))) return -1
  const term = normalize(v.term)
  if (term.includes(normalizedQuery)) return 0
  if (found.names.includes(normalizedQuery)) return 1
  return 2
}

type Filter = GlossaryCategory | 'all'

/** Language-file key of the name shown for each category. */
const CATEGORY_LABELS: Record<GlossaryCategory, string> = {
  capture: 'glossaryWindow.categories.capture',
  calibration: 'glossaryWindow.categories.calibration',
  stacking: 'glossaryWindow.categories.stacking',
  processing: 'glossaryWindow.categories.processing',
  color: 'glossaryWindow.categories.color',
  astrometry: 'glossaryWindow.categories.astrometry',
  plugins: 'glossaryWindow.categories.plugins',
  export: 'glossaryWindow.categories.export',
  usage: 'glossaryWindow.categories.usage'
}

function ModalWindow(): JSX.Element {
  const close = useGlossaryWindow((s) => s.close)
  const initial = useGlossaryWindow((s) => s.initial)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<Filter>('all')
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    field.current?.focus()
    return () => before?.focus?.()
  }, [])

  // Opening on a specific entry (for example from the help center).
  useEffect(() => {
    if (!initial) return
    const v = glossaryEntry(initial)
    if (v) setHighlighted(idOf(v))
  }, [initial])

  const normalizedQuery = normalize(search.trim())

  /** Entries matching the search, across all categories, with their relevance. */
  const language = getLanguage()
  const foundAll = useMemo(() => {
    const result: { entry: GlossaryEntry; rank: number }[] = []
    for (const v of glossaryIndex().sorted) {
      const rank = relevance(v, normalizedQuery)
      if (rank >= 0) result.push({ entry: v, rank })
    }
    // With a search, entries containing it in their name come first; ties
    // keep the alphabetical order (the sort is stable).
    if (normalizedQuery !== '') result.sort((a, b) => a.rank - b.rank)
    return result
  }, [normalizedQuery, language])

  const counts = useMemo(() => {
    const c = new Map<GlossaryCategory, number>()
    for (const { entry } of foundAll) c.set(entry.category, (c.get(entry.category) ?? 0) + 1)
    return c
  }, [foundAll])

  const visibleItems = category === 'all' ? foundAll : foundAll.filter((t) => t.entry.category === category)

  // Scrolls the entry requested by a cross-reference into view and highlights it briefly.
  useEffect(() => {
    if (!highlighted) return
    const node = document.getElementById(highlighted)
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    const t = window.setTimeout(() => setHighlighted(null), 2200)
    return () => window.clearTimeout(t)
  }, [highlighted])

  function goTo(name: string): void {
    const v = glossaryEntry(name)
    if (!v) return
    // The entry must be visible: clear any search or filter that would hide it.
    const rank = relevance(v, normalizedQuery)
    if (rank < 0) setSearch('')
    if (category !== 'all' && category !== v.category) setCategory('all')
    setHighlighted(idOf(v))
  }

  function chooseCategory(c: Filter): void {
    setCategory(c)
    list.current?.scrollTo({ top: 0 })
  }

  // Without a search the list is grouped by initial letter; with a search it is sorted by relevance.
  const withInitials = normalizedQuery === ''
  let previousInitial = ''

  return (
    <div className="sl-overlay" onClick={close}>
      <div
        className="sl-dialog sl-glossary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-glossary-title"
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
          // Only F1 and F11 reach the general key handler; all other keys
          // stay here and never reach the viewer shortcuts.
          const s = shortcutFor(e.nativeEvent)
          if (!(s !== null && (s.id === 'help' || s.id === 'fullScreen'))) e.stopPropagation()
        }}
      >
        <header className="sl-dialog-head">
          <HelpIcon size={22} />
          <div>
            <h2 className="sl-dialog-title" id="sl-glossary-title">
              {t('glossaryWindow.title')}
            </h2>
            <p className="sl-dialog-subtitle">
              {t('glossaryWindow.subtitle')}
            </p>
          </div>
          <div className="sl-topbar-spacer" />
          <Button variant="ghost" icon={<CloseIcon size={16} />} onClick={close}>
            {t('glossaryWindow.close')}
          </Button>
        </header>

        <div className="sl-glossary-search">
          <input
            ref={field}
            className="sl-settings-field sl-glossary-field"
            type="search"
            placeholder={t('glossaryWindow.searchPlaceholder')}
            aria-label={t('glossaryWindow.searchLabel')}
            value={search}
            spellCheck={false}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="sl-glossary-count" aria-live="polite">
            {visibleItems.length === 1
              ? t('glossaryWindow.countOne')
              : t('glossaryWindow.countOther', { count: visibleItems.length })}
          </span>
        </div>

        <div className="sl-glossary-body">
          <nav className="sl-glossary-categories" aria-label={t('glossaryWindow.categoriesLabel')}>
            <CategoryButton
              label={t('glossaryWindow.allEntries')}
              number={foundAll.length}
              active={category === 'all'}
              onClick={() => chooseCategory('all')}
            />
            {GLOSSARY_CATEGORIES.map((c) => (
              <CategoryButton
                key={c}
                label={t(CATEGORY_LABELS[c])}
                number={counts.get(c) ?? 0}
                active={category === c}
                onClick={() => chooseCategory(c)}
              />
            ))}
          </nav>

          <div className="sl-glossary-list" ref={list}>
            {visibleItems.length === 0 ? (
              <p className="sl-glossary-empty">
                {normalizedQuery !== '' ? (
                  <>
                    {category === 'all'
                      ? t('glossaryWindow.noResults', { query: search.trim() })
                      : t('glossaryWindow.noResultsInCategory', {
                          category: t(CATEGORY_LABELS[category]),
                          query: search.trim()
                        })}{' '}
                    {category !== 'all' && foundAll.length > 0 ? (
                      <button type="button" className="sl-glossary-link" onClick={() => chooseCategory('all')}>
                        {t('glossaryWindow.searchAllCategories')}
                      </button>
                    ) : (
                      t('glossaryWindow.searchScope')
                    )}
                  </>
                ) : (
                  t('glossaryWindow.emptyCategory')
                )}
              </p>
            ) : (
              visibleItems.map(({ entry }) => {
                const letter = entry.term.charAt(0).toLocaleUpperCase(language)
                const newLetter = withInitials && letter !== previousInitial
                previousInitial = letter
                return (
                  <Fragment key={entry.term}>
                    {newLetter ? <div className="sl-glossary-letter">{letter}</div> : null}
                    <GlossaryEntryView
                      entry={entry}
                      highlighted={highlighted === idOf(entry)}
                      showCategory={category === 'all'}
                      onView={goTo}
                    />
                  </Fragment>
                )
              })
            )}
          </div>
        </div>

        <footer className="sl-dialog-footer">
          <span className="sl-guide-entry-text">
            {t('glossaryWindow.footnote')}
          </span>
          <Button variant="primary" icon={<CloseIcon size={15} />} onClick={close}>
            {t('glossaryWindow.close')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

function CategoryButton({
  label,
  number,
  active,
  onClick
}: {
  label: string
  number: number
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={'sl-glossary-category' + (active ? ' sl-active' : '')}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="sl-glossary-category-name">{label}</span>
      <span className="sl-glossary-category-count">{number}</span>
    </button>
  )
}

function GlossaryEntryView({
  entry,
  highlighted,
  showCategory,
  onView
}: {
  entry: GlossaryEntry
  highlighted: boolean
  showCategory: boolean
  onView: (name: string) => void
}): JSX.Element {
  return (
    <article id={idOf(entry)} className={'sl-glossary-entry' + (highlighted ? ' sl-highlighted' : '')}>
      <header className="sl-glossary-entry-head">
        <h3 className="sl-glossary-term">{entry.term}</h3>
        {showCategory ? <span className="sl-glossary-label">{t(CATEGORY_LABELS[entry.category])}</span> : null}
      </header>
      {entry.alternatives && entry.alternatives.length > 0 ? (
        <p className="sl-glossary-alternatives sl-selectable">
          <span className="sl-glossary-section">{t('glossaryWindow.alsoKnownAs')}</span> {entry.alternatives.join(' · ')}
        </p>
      ) : null}
      <p className="sl-glossary-text sl-selectable">{entry.definition}</p>
      <div className="sl-glossary-in-starlight">
        <span className="sl-glossary-section">{t('glossaryWindow.inStarLight')}</span>
        <p className="sl-glossary-text sl-selectable">{entry.inStarLight}</p>
      </div>
      {entry.see && entry.see.length > 0 ? (
        <p className="sl-glossary-see">
          <span className="sl-glossary-section">{t('glossaryWindow.seeAlso')}</span>{' '}
          {entry.see.map((name, i) => {
            const destination = glossaryEntry(name)
            return (
              <Fragment key={name}>
                {i > 0 ? <span className="sl-glossary-separator">·</span> : null}
                {destination ? (
                  <button
                    type="button"
                    className="sl-glossary-link"
                    title={t('glossaryWindow.showEntry', { term: destination.term })}
                    onClick={() => onView(name)}
                  >
                    {name}
                  </button>
                ) : (
                  <span>{name}</span>
                )}
              </Fragment>
            )
          })}
        </p>
      ) : null}
    </article>
  )
}
