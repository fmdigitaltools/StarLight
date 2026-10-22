/**
 * Program log: types shared by the main process (src/main/log.ts), the bridge
 * and the interface (renderer/src/errorLog.ts, components/LogWindow.tsx).
 *
 * The log is a text file in the program data folder that records startup,
 * shutdown and errors. It stays on the computer and is never sent anywhere.
 * It is meant for users who want to report a problem: they can copy its
 * report and paste it wherever they like.
 */

/** Severity of an entry. */
export type LogLevel = 'info' | 'warning' | 'error'

/**
 * Where an entry comes from: the main process, the window, a compute worker,
 * a plugin, the interface (React), or an Electron child process (GPU,
 * utility services).
 */
export type LogOrigin = 'startup' | 'main' | 'window' | 'ui' | 'worker' | 'plugin' | 'process'

/** A log entry, already anonymised. */
export interface LogEntry {
  /** Local date and time, e.g. "2026-10-17 21:03:05". */
  when: string
  level: LogLevel
  origin: string
  text: string
}

/** Severe error from the previous session (or from before a reload). */
export interface SevereError {
  when: string
  /** Short plain-language description. */
  description: string
}

/** Log folder inside the program data folder. */
export const LOG_FOLDER = 'log'

/**
 * Start of the entry the window writes when it opens, followed by the
 * graphics card it sees and by "; screen …". The main process reads the card
 * name from it for the report. Log entries are never translated: this prefix
 * stays the same whatever the interface language.
 */
export const WINDOW_OPENED_PREFIX = 'Window opened. Graphics: '

/** Graphics card name in a "window opened" entry, or null. */
export function windowGraphicsFromEntry(text: string): string | null {
  if (!text.startsWith(WINDOW_OPENED_PREFIX)) return null
  const name = text.slice(WINDOW_OPENED_PREFIX.length).split(';')[0].trim()
  return name === '' ? null : name
}
