import { t } from '@shared/i18n/i18n'

/**
 * List of keyboard shortcuts: the single source of keys and descriptions.
 * It is used by the key handler (`hooks/useShortcuts`), the Keyboard
 * shortcuts window, the help center and the menu hints, so what is shown and
 * what happens can never diverge. To add a shortcut: an entry here and its
 * command in `useShortcuts`.
 *
 * The choices follow common Windows conventions: Ctrl with the initial for
 * file commands, 0 and 1 to fit and show at 100%, Tab for the panel, F11 for
 * full screen, the backslash held down to see the original. The bare digits
 * are already used for zoom, so the workflow steps use Alt with the digit.
 *
 * Descriptions, search words and key names are read from the language files
 * through getters, so they follow a language change.
 */

const NS = 'rendererShortcuts.'

export type ShortcutGroup = 'File' | 'Edit' | 'View' | 'Workflow' | 'Image' | 'Help'

/** Order in which the groups appear in the window and in the help center. */
export const GROUPS: ShortcutGroup[] = ['File', 'Edit', 'View', 'Workflow', 'Image', 'Help']

/**
 * A key combination. `key` is compared with `KeyboardEvent.key` in lower
 * case; `code`, if present, with `KeyboardEvent.code` (needed for Alt with
 * digits, where some keyboard layouts change the character).
 */
export interface Combination {
  key: string
  code?: string
  ctrl?: boolean
  alt?: boolean
  /**
   * Shift required (true), forbidden (false or absent) or irrelevant:
   * "+", "?" and "/" are typed with or without Shift depending on the
   * keyboard layout.
   */
  shift?: boolean | 'either'
  /** How to display it, if different from what the fields above produce. */
  label?: string[]
}

export type ShortcutId =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'close'
  | 'import'
  | 'export'
  | 'undo'
  | 'redo'
  | 'history'
  | 'settings'
  | 'fit'
  | 'actualSize'
  | 'zoomIn'
  | 'zoomOut'
  | 'compare'
  | 'markers'
  | 'stars'
  | 'crop'
  | 'panel'
  | 'fullScreen'
  | 'step1'
  | 'step2'
  | 'step3'
  | 'step4'
  | 'step5'
  | 'step6'
  | 'step7'
  | 'step8'
  | 'abracadabra'
  | 'stretch'
  | 'reset'
  | 'brush'
  | 'eraser'
  | 'showMask'
  | 'biggerBrush'
  | 'smallerBrush'
  | 'help'
  | 'shortcutList'

export interface Shortcut {
  id: ShortcutId
  group: ShortcutGroup
  /** The equivalent combinations: the first one is the one shown in menus. */
  combinations: Combination[]
  /** What it does, in one sentence. */
  action: string
  /**
   * Also active while typing in a text field. Only for commands that have no
   * meaning inside the field (save, open, function keys); everything else is
   * left to the field.
   */
  alsoInFields?: boolean
  /** Other words to find it with the window's search. */
  words?: string
  /** Holding the key down repeats the command (zoom). */
  repeatable?: boolean
}

/** Descriptive rows only: mouse actions and keys handled by menus and windows. */
export interface Reminder {
  group: ShortcutGroup
  keys: string[][]
  action: string
}

/** A shortcut whose description (and search words, if `withWords`) come from the language files. */
function sc(s: Omit<Shortcut, 'action' | 'words'>, withWords = false): Shortcut {
  const shortcut = { ...s } as Shortcut
  Object.defineProperty(shortcut, 'action', { get: () => t(NS + 'actions.' + s.id), enumerable: true })
  if (withWords) Object.defineProperty(shortcut, 'words', { get: () => t(NS + 'words.' + s.id), enumerable: true })
  return shortcut
}

const step = (n: number): Shortcut =>
  sc({
    id: ('step' + n) as ShortcutId,
    group: 'Workflow',
    combinations: [{ key: String(n), code: 'Digit' + n, alt: true }]
  })

export const SHORTCUTS: Shortcut[] = [
  // File
  sc({ id: 'new', group: 'File', combinations: [{ key: 'n', ctrl: true }] }),
  sc({ id: 'open', group: 'File', combinations: [{ key: 'o', ctrl: true }], alsoInFields: true }),
  sc({ id: 'save', group: 'File', combinations: [{ key: 's', ctrl: true }], alsoInFields: true }),
  sc({ id: 'saveAs', group: 'File', combinations: [{ key: 's', ctrl: true, shift: true }], alsoInFields: true }),
  sc({ id: 'close', group: 'File', combinations: [{ key: 'w', ctrl: true }] }),
  sc({ id: 'import', group: 'File', combinations: [{ key: 'i', ctrl: true }] }, true),
  sc({ id: 'export', group: 'File', combinations: [{ key: 'e', ctrl: true }] }),

  // Edit
  sc({ id: 'undo', group: 'Edit', combinations: [{ key: 'z', ctrl: true }] }),
  sc({
    id: 'redo',
    group: 'Edit',
    combinations: [
      { key: 'y', ctrl: true },
      { key: 'z', ctrl: true, shift: true }
    ]
  }),
  sc({ id: 'history', group: 'Edit', combinations: [{ key: 'h', ctrl: true }] }, true),
  sc({ id: 'settings', group: 'Edit', combinations: [{ key: ',', ctrl: true }], alsoInFields: true }),

  // View
  sc({ id: 'fit', group: 'View', combinations: [{ key: '0' }, { key: '0', ctrl: true }] }, true),
  sc({ id: 'actualSize', group: 'View', combinations: [{ key: '1' }, { key: '1', ctrl: true }] }, true),
  sc(
    {
      id: 'zoomIn',
      group: 'View',
      combinations: [
        { key: '+', shift: 'either' },
        { key: '=', shift: 'either', label: [] },
        { key: '+', ctrl: true, shift: 'either' },
        { key: '=', ctrl: true, shift: 'either', label: [] }
      ],
      repeatable: true
    },
    true
  ),
  sc(
    {
      id: 'zoomOut',
      group: 'View',
      combinations: [
        { key: '-', shift: 'either' },
        { key: '-', ctrl: true, shift: 'either' }
      ],
      repeatable: true
    },
    true
  ),
  sc({ id: 'compare', group: 'View', combinations: [{ key: '\\' }] }, true),
  sc({ id: 'markers', group: 'View', combinations: [{ key: 'o' }] }, true),
  sc({ id: 'stars', group: 'View', combinations: [{ key: 's' }] }, true),
  sc({ id: 'crop', group: 'View', combinations: [{ key: 'c' }] }, true),
  sc({ id: 'panel', group: 'View', combinations: [{ key: 'tab', label: ['Tab'] }] }, true),
  sc({ id: 'fullScreen', group: 'View', combinations: [{ key: 'f11', label: ['F11'] }], alsoInFields: true }, true),

  // Workflow
  step(1),
  step(2),
  step(3),
  step(4),
  step(5),
  step(6),
  step(7),
  step(8),

  // Image
  sc({ id: 'abracadabra', group: 'Image', combinations: [{ key: 'a', ctrl: true, shift: true }] }, true),
  sc({ id: 'stretch', group: 'Image', combinations: [{ key: 'd' }] }, true),
  sc({ id: 'reset', group: 'Image', combinations: [{ key: 'r' }] }),
  sc({ id: 'brush', group: 'Image', combinations: [{ key: 'b' }] }, true),
  sc({ id: 'eraser', group: 'Image', combinations: [{ key: 'e' }] }, true),
  sc({ id: 'showMask', group: 'Image', combinations: [{ key: 'm' }] }, true),
  sc({ id: 'biggerBrush', group: 'Image', combinations: [{ key: ']', shift: 'either' }], repeatable: true }, true),
  sc({ id: 'smallerBrush', group: 'Image', combinations: [{ key: '[', shift: 'either' }], repeatable: true }, true),

  // Help
  sc({ id: 'help', group: 'Help', combinations: [{ key: 'f1', label: ['F1'] }], alsoInFields: true }),
  sc({
    id: 'shortcutList',
    group: 'Help',
    combinations: [
      { key: '/', ctrl: true, shift: 'either' },
      { key: '?', shift: 'either' }
    ]
  })
]

/** A reminder whose key names and description come from the language files. */
function reminder(group: ShortcutGroup, id: string, keyIds: string[][]): Reminder {
  return {
    group,
    get keys(): string[][] {
      return keyIds.map((row) => row.map((k) => t(NS + 'keys.' + k)))
    },
    get action(): string {
      return t(NS + 'reminders.' + id)
    }
  }
}

/** Mouse and menu keys: listed in the window but not handled by the key handler. */
export const REMINDERS: Reminder[] = [
  reminder('View', 'wheel', [['wheel']]),
  reminder('View', 'drag', [['drag']]),
  reminder('Help', 'esc', [['esc']]),
  reminder('Help', 'arrows', [['arrows'], ['enter']])
]

const KEY_NAMES: Record<string, string> = {
  tab: 'Tab',
  f1: 'F1',
  f11: 'F11',
  '\\': '\\',
  ',': ','
}

/** The keys of a combination, one per key cap: "Ctrl", "Shift", "S". */
export function comboKeys(c: Combination): string[] {
  if (c.label) return c.label
  const keys: string[] = []
  if (c.ctrl) keys.push('Ctrl')
  if (c.alt) keys.push('Alt')
  if (c.shift === true) keys.push(t(NS + 'keys.shift'))
  keys.push(KEY_NAMES[c.key] ?? c.key.toUpperCase())
  return keys
}

/** The combinations to display, without the hidden duplicates (empty label). */
export function shownCombinations(s: Shortcut): string[][] {
  return s.combinations.map(comboKeys).filter((t) => t.length > 0)
}

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

/** The hint for menus: the first combination, e.g. "Ctrl+Shift+S". */
export function keysOf(id: ShortcutId): string {
  const s = BY_ID.get(id)
  if (!s) return ''
  return comboKeys(s.combinations[0]).join('+')
}

function matches(c: Combination, e: KeyboardEvent): boolean {
  if (Boolean(c.ctrl) !== (e.ctrlKey || e.metaKey)) return false
  if (Boolean(c.alt) !== e.altKey) return false
  if (c.shift !== 'either' && Boolean(c.shift) !== e.shiftKey) return false
  if (c.code && e.code === c.code) return true
  return e.key.toLowerCase() === c.key
}

/** The shortcut pressed, or null if the key is not a shortcut. */
export function shortcutFor(e: KeyboardEvent): Shortcut | null {
  for (const s of SHORTCUTS) {
    if (s.combinations.some((c) => matches(c, e))) return s
  }
  return null
}
