/**
 * Automatic updates: messages shared by the main process, the bridge and the
 * interface.
 *
 * The main process (src/main/updates.ts) talks to the update server and
 * downloads the new installer; the interface (components/UpdateWindow.tsx)
 * shows the progress and collects the user's choices. The status is always
 * sent whole: the receiver never has to rebuild anything from earlier
 * messages.
 */
import { FALLBACK_LANGUAGE, REFERENCE_LANGUAGE, type Language } from './i18n/i18n'

/** Versions offered: stable releases only, or test releases as well. */
export type UpdatesChannel = 'stable' | 'test'

export type UpdatePhase =
  /** No check performed yet. */
  | 'idle'
  /** The server address is still the placeholder: no check is made. */
  | 'notConfigured'
  /** Request to the server in progress. */
  | 'checking'
  /** The latest version is already installed (or the new one was skipped). */
  | 'upToDate'
  /** A new version exists and has not been downloaded yet. */
  | 'available'
  /** Installer download in progress. */
  | 'downloading'
  /** Installer downloaded and verified: installs on exit or immediately. */
  | 'ready'
  /** Something went wrong; `error` says what. */
  | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** Version in use, for example "0.4.0". */
  currentVersion: string
  /** New version found on the server, if any. */
  newVersion: string | null
  /**
   * Release notes of the new version, as plain text, one per language
   * (language code → text): the interface shows the current language, or
   * English (see releaseNotesFor).
   */
  whatsNew: ReleaseNotes | null
  /** Release date of the new version (ISO), if known. */
  releaseDate: string | null
  /** Download progress, from 0 to 100. */
  percent: number
  /** Bytes downloaded so far and total. */
  downloadedItems: number
  total: number
  /** Download speed in bytes per second. */
  speed: number
  /** True if the user asked to install as soon as the download finishes. */
  installImmediately: boolean
  /** True if the user started the last check (menu), false if automatic. */
  manual: boolean
  /** Plain-language explanation of the error. */
  error: string | null
}

/** Result of the request to install immediately. */
export interface InstallResult {
  ok: boolean
  /**
   * Why the installation did not happen:
   * - `unsavedWork`: closing now would lose changes;
   * - `notReady`: the installer has not been downloaded yet;
   * - `development`: StarLight is running from source, so installation is only simulated.
   */
  reason?: 'unsavedWork' | 'notReady' | 'development'
}

/** Release notes per language: language code → plain text. */
export type ReleaseNotes = Partial<Record<Language, string>>

/**
 * Most recent versions shown in What's new and in the update window: older
 * changes are cut off.
 */
export const MAX_WHATS_NEW_VERSIONS = 10

/*
 * Format of resources/release-notes.md (written by
 * tools/write-release-notes.mjs, copied by electron-builder into latest.yml):
 * one section per language, each opened by a marker line
 *
 *   <!-- lang:it -->
 *   first change
 *   second change
 *   <!-- lang:en -->
 *   …
 *
 * Text before the first marker (notes written without sections) counts as
 * English.
 */
const LANGUAGE_MARKER = /<!--\s*lang:([A-Za-z-]+)\s*-->/g

/** Splits release notes into their language sections (raw text, not cleaned). */
export function splitReleaseNotes(text: string): ReleaseNotes {
  const notes: ReleaseNotes = {}
  const markers = [...text.matchAll(LANGUAGE_MARKER)]
  const head = text.slice(0, markers[0]?.index ?? text.length).trim()
  if (head !== '') notes[FALLBACK_LANGUAGE] = head
  markers.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length
    const end = markers[i + 1]?.index ?? text.length
    const section = text.slice(start, end).trim()
    if (section !== '') notes[m[1].toLowerCase()] = section
  })
  return notes
}

/** The notes in the given language, else English, else Italian, else any. */
export function releaseNotesFor(notes: ReleaseNotes | null, language: Language): string | null {
  if (!notes) return null
  return notes[language] ?? notes[FALLBACK_LANGUAGE] ?? notes[REFERENCE_LANGUAGE] ?? Object.values(notes)[0] ?? null
}
