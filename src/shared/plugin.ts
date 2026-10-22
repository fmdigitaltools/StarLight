import type { PluginManifest } from '@core/plugin/manifest'

/**
 * What the main process sends to the interface for each plugin, installed or
 * listed in the gallery. Images arrive ready to display (`data:` URLs),
 * because the page cannot read files.
 */
export interface PluginInfo {
  manifest: PluginManifest
  /**
   * `bundled`: plugin from the gallery shipped with StarLight, enabled and
   * disabled without copying it; `file`: installed from a folder or an
   * archive, installed and uninstalled.
   */
  origin?: 'bundled' | 'file'
  icon: string | null
  previewBefore: string | null
  previewAfter: string | null
}

/**
 * An installed plugin (or a bundled, enabled one) that failed the startup
 * checks: it is not loaded, and the gallery shows it with the reason.
 */
export interface PluginNotLoaded {
  /** Folder name, which should match the manifest id. */
  id: string
  /** Name from the manifest if readable, otherwise the folder name. */
  name: string
  origin: 'bundled' | 'file'
  /** Ready-made sentences to show (shared/protectionTexts.ts). */
  problems: string[]
  /** What the user can do about it. */
  remedy: string
}

/** Plugin list as seen by the interface. */
export interface PluginList {
  /** Loaded and available in the Process step. */
  loadedItems: PluginInfo[]
  /** Installed from file but disabled by the user (for example after repeated errors). */
  disabledItems: PluginInfo[]
  /** Rejected at startup because they fail the checks. */
  notLoaded: PluginNotLoaded[]
}

/** Result of an installation: on failure, the sentences to show. */
export type PluginInstallResult =
  | { ok: true; manifest: PluginManifest; updated: boolean }
  | { ok: false; cancelled?: boolean; errors: string[]; remedy?: string; name?: string }

/**
 * The plugin sandbox closed during a run: `memory` if the plugin exceeded the
 * memory limit (`limitMB`), `crashed` for any other unexpected exit.
 */
export interface SandboxFailed {
  id: number
  reason: 'memory' | 'crashed'
  limitMB: number
}

/**
 * Message of the error thrown by the main process when plugin.js changed
 * after startup and no longer passes the checks: a code, not a sentence, so
 * the renderer shows the text (EXECUTION.codeChanged) in its own language.
 */
export const PLUGIN_CODE_CHANGED = 'plugin-code-changed'

/** How many distinct sessions have seen this plugin version stop. */
export interface PluginFaultResult {
  sessions: number
}
