/**
 * StarLight glossary: the terms used in the interface, each with its
 * definition (what it is) and its role in the program (what StarLight
 * does with it and where it is found). This is the single source of the
 * glossary texts, used by the Glossary window and the help center.
 *
 * The entries live in two files with the same structure and order:
 * `terms.it.ts` (Italian) and `terms.en.ts` (English). `getTerms()`
 * returns the list for the current interface language.
 *
 * Rules for adding an entry (add it to both files, in the same position):
 * - professional, impersonal register, plain sentences;
 * - the `inStarLight` field describes only what the program actually
 *   does: verify it in the code before writing it;
 * - `see` cross-references use the exact `term` of another entry in the
 *   same language (or one of its `alternatives`): those that match no
 *   entry are shown as plain text.
 */

import { byLanguage } from '@shared/i18n/i18n'
import { TERMS_IT } from './terms.it'
import { TERMS_EN } from './terms.en'

/**
 * Category identifiers. They are stable keys, identical in both
 * languages; the displayed labels are defined by the Glossary window.
 */
export type GlossaryCategory =
  | 'capture'
  | 'calibration'
  | 'stacking'
  | 'processing'
  | 'color'
  | 'astrometry'
  | 'plugins'
  | 'export'
  | 'usage'

/** Order in which the categories appear in the window. */
export const GLOSSARY_CATEGORIES: GlossaryCategory[] = [
  'capture',
  'calibration',
  'stacking',
  'processing',
  'color',
  'astrometry',
  'plugins',
  'export',
  'usage'
]

export interface GlossaryEntry {
  term: string
  /** Synonyms, abbreviations and alternative names the term can be searched by. */
  alternatives?: string[]
  category: GlossaryCategory
  /** What it is and what it consists of. */
  definition: string
  /** What StarLight does with it and where it is found in the program. */
  inStarLight: string
  /** Cross-references to other entries, by term name in the same language. */
  see?: string[]
}

/**
 * Glossary entries for the current interface language. Call it when the
 * text is needed (during render or in a function), not at module level:
 * the language can change while the program is running.
 */
export function getTerms(): GlossaryEntry[] {
  return byLanguage({ it: TERMS_IT, en: TERMS_EN })
}
