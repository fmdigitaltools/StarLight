import { create } from 'zustand'
import type { PluginInstallResult, PluginInfo, PluginNotLoaded } from '@shared/plugin'
import { activationRejected, installationRejected } from '@shared/protectionTexts'
import {
  completeValues,
  defaultValues,
  localizeManifest,
  type ActivePlugin,
  type ParameterValue,
  type PluginManifest
} from '@core/plugin/manifest'
import { useApp } from '../store/appStore'
import { getLanguage, onLanguageChange, t } from '@shared/i18n/i18n'

/**
 * Plugins on the interface side: which ones are installed, the gallery, and
 * enabling them in the Process step.
 *
 * The installed list comes from the main process, which reads it from the
 * user data folder. Each plugin's code is requested only when it needs to
 * run and is kept in memory until the plugin is reinstalled or removed.
 *
 * The manifests in the state are already in the current language (name,
 * description, parameter texts, from the manifest's `translations`, with
 * the English text where a translation is missing), and are translated again
 * when the language changes.
 */

/** The plugin with its manifest texts in the current language. */
export function localizedInfo(info: PluginInfo): PluginInfo {
  return { ...info, manifest: localizeManifest(info.manifest, getLanguage()) }
}

/** Name of a plugin in the current language. */
export function localizedName(manifest: PluginManifest): string {
  return localizeManifest(manifest, getLanguage()).name
}

/** Lists as read from the main process, before translation. */
let readInstalled: PluginInfo[] = []
let readDisabled: PluginInfo[] = []

interface PluginState {
  /** Loaded plugins: available in the Process step and in the menu. */
  installedItems: PluginInfo[]
  /** Installed from file and disabled by the user. */
  disabledItems: PluginInfo[]
  /** Rejected at startup because they fail the checks. */
  notLoaded: PluginNotLoaded[]
  /**
   * Plugins stopped during this session (id → reason): they do not run
   * again until StarLight is next opened.
   */
  suspended: Record<string, string>
  /** True after the first read from disk. */
  readCount: boolean
  galleryOpen: boolean
  /** Gallery section to show when it opens. */
  galleryFilter: 'all' | 'catalogs'
  /** Plugin being installed or uninstalled. */
  inProgress: string | null
  reload: () => Promise<void>
  openGallery: (filter?: 'all' | 'catalogs') => void
  closeGallery: () => void
}

export const usePlugin = create<PluginState>((set) => ({
  installedItems: [],
  disabledItems: [],
  notLoaded: [],
  suspended: {},
  readCount: false,
  galleryOpen: false,
  galleryFilter: 'all',
  inProgress: null,
  reload: async () => {
    try {
      const list = await window.starlight.listPlugins()
      readInstalled = list.loadedItems
      readDisabled = list.disabledItems
      set({
        installedItems: readInstalled.map(localizedInfo),
        disabledItems: readDisabled.map(localizedInfo),
        notLoaded: list.notLoaded,
        readCount: true
      })
    } catch {
      set({ readCount: true })
    }
  },
  openGallery: (filter = 'all') => set({ galleryOpen: true, galleryFilter: filter }),
  closeGallery: () => set({ galleryOpen: false })
}))

onLanguageChange(() =>
  usePlugin.setState({ installedItems: readInstalled.map(localizedInfo), disabledItems: readDisabled.map(localizedInfo) })
)

/**
 * First read at startup: the Plugins menu and the Process step need it. The
 * notice for rejected plugins is given by startupNotice.ts, together with
 * the one for catalogs.
 */
export const firstPluginRead: Promise<void> = usePlugin.getState().reload()

const codes = new Map<string, string>()

/** Text of the plugin.js file of an installed plugin. */
export async function codeOf(id: string): Promise<string> {
  const known = codes.get(id)
  if (known !== undefined) return known
  const code = await window.starlight.pluginCode(id)
  codes.set(id, code)
  return code
}

export function infoOf(id: string): PluginInfo | undefined {
  return usePlugin.getState().installedItems.find((p) => p.manifest.id === id)
}

/* ---- Installation ---- */

async function finishInstallation(result: PluginInstallResult): Promise<boolean> {
  const notify = useApp.getState().notify
  if (!result.ok) {
    if (!result.cancelled) notify('error', installationRejected('plugin', result.name ?? null, result.errors, result.remedy))
    return false
  }
  codes.delete(result.manifest.id)
  await usePlugin.getState().reload()
  notify(
    'ok',
    t(result.updated ? 'pluginRegistry.updated' : 'pluginRegistry.installed', { name: localizedName(result.manifest) })
  )
  return true
}

async function withStatus(id: string, action: () => Promise<PluginInstallResult>): Promise<boolean> {
  if (usePlugin.getState().inProgress) return false
  usePlugin.setState({ inProgress: id })
  try {
    return await finishInstallation(await action())
  } catch (e) {
    useApp.getState().notify('error', installationRejected('plugin', null, [e instanceof Error ? e.message : String(e)]))
    return false
  } finally {
    usePlugin.setState({ inProgress: null })
  }
}

/** Enables a bundled gallery plugin: from now on it loads with StarLight. */
export async function enableBundled(id: string): Promise<boolean> {
  if (usePlugin.getState().inProgress) return false
  usePlugin.setState({ inProgress: id })
  try {
    const result = await window.starlight.enableBundledPlugin(id, true)
    if (!result.ok) {
      useApp.getState().notify('error', activationRejected(result.name ?? null, result.errors, result.remedy))
      return false
    }
    codes.delete(id)
    await usePlugin.getState().reload()
    useApp.getState().notify('ok', t('pluginRegistry.enabled', { name: localizedName(result.manifest) }))
    return true
  } finally {
    usePlugin.setState({ inProgress: null })
  }
}

/** Disables a bundled gallery plugin: it is no longer loaded until it is enabled again. */
export async function disableBundled(id: string): Promise<void> {
  const info = infoOf(id)
  if (usePlugin.getState().inProgress) return
  usePlugin.setState({ inProgress: id })
  try {
    await window.starlight.enableBundledPlugin(id, false)
    codes.delete(id)
    removeFromProcessing(id)
    await usePlugin.getState().reload()
    useApp.getState().notify('ok', t('pluginRegistry.disabled', { name: info?.manifest.name ?? id }))
  } catch (e) {
    useApp.getState().notify('error', t('pluginRegistry.disableFailed', { detail: e instanceof Error ? e.message : String(e) }))
  } finally {
    usePlugin.setState({ inProgress: null })
  }
}

/** A plugin that is no longer loaded is also removed from the tools chosen in the Process step. */
function removeFromProcessing(id: string): void {
  const app = useApp.getState()
  if (app.processing.plugin.some((p) => p.id === id)) {
    app.setProcessing({ plugin: app.processing.plugin.filter((p) => p.id !== id) })
  }
}

export function installFromFolder(): Promise<boolean> {
  return withStatus('folder', () => window.starlight.installPluginFromFolder())
}

export function installFromArchive(): Promise<boolean> {
  return withStatus('archive', () => window.starlight.installPluginFromArchive())
}

export async function uninstall(id: string): Promise<void> {
  const st = usePlugin.getState()
  const info = infoOf(id) ?? st.disabledItems.find((p) => p.manifest.id === id)
  const discarded = st.notLoaded.find((p) => p.id === id)
  if (usePlugin.getState().inProgress) return
  usePlugin.setState({ inProgress: id })
  try {
    await window.starlight.uninstallPlugin(id)
    codes.delete(id)
    removeFromProcessing(id)
    await usePlugin.getState().reload()
    useApp.getState().notify('ok', t('pluginRegistry.uninstalled', { name: info?.manifest.name ?? discarded?.name ?? id }))
  } catch (e) {
    useApp.getState().notify('error', t('pluginRegistry.uninstallFailed', { detail: e instanceof Error ? e.message : String(e) }))
  } finally {
    usePlugin.setState({ inProgress: null })
  }
}

/**
 * Disables or re-enables a plugin installed from file, without removing it
 * from disk: while disabled it is not loaded, also at later startups.
 */
export async function enableFromFile(id: string, active: boolean): Promise<void> {
  const st = usePlugin.getState()
  if (st.inProgress) return
  const info = infoOf(id) ?? st.disabledItems.find((p) => p.manifest.id === id)
  usePlugin.setState({ inProgress: id })
  try {
    await window.starlight.enablePluginFromFile(id, active)
    codes.delete(id)
    if (!active) removeFromProcessing(id)
    await usePlugin.getState().reload()
    useApp
      .getState()
      .notify('ok', t(active ? 'pluginRegistry.reenabled' : 'pluginRegistry.disabled', { name: info?.manifest.name ?? id }))
  } catch (e) {
    useApp.getState().notify('error', t('pluginRegistry.operationFailed', { detail: e instanceof Error ? e.message : String(e) }))
  } finally {
    usePlugin.setState({ inProgress: null })
  }
}

/** Disables a plugin permanently, whatever its origin. */
export async function disablePermanently(id: string): Promise<void> {
  const info = infoOf(id)
  if (info?.origin === 'file') await enableFromFile(id, false)
  else await disableBundled(id)
}

/** Suspends a plugin until StarLight is next opened. */
export function suspend(id: string, reason: string): void {
  usePlugin.setState((s) => ({ suspended: { ...s.suspended, [id]: reason } }))
  codes.delete(id)
}

export function suspended(id: string): boolean {
  return id in usePlugin.getState().suspended
}

/* ---- Enabling in the Process step ---- */

function currentList(): ActivePlugin[] {
  return useApp.getState().processing.plugin
}

/**
 * Turns a plugin on or off. A plugin turned on goes to the end of the list:
 * plugins run in the order in which they were turned on.
 */
export function enablePlugin(id: string, active: boolean): void {
  const info = infoOf(id)
  if (!info) return
  const list = currentList()
  const present = list.find((p) => p.id === id)
  const values = present ? completeValues(info.manifest, present.values) : defaultValues(info.manifest)
  const others = list.filter((p) => p.id !== id)
  const newValue: ActivePlugin = { id, active, values }
  let plugin: ActivePlugin[]
  if (active) plugin = [...others, newValue]
  else plugin = present ? list.map((p) => (p.id === id ? newValue : p)) : list
  useApp.getState().setProcessing({ plugin })
}

export function setPluginValue(id: string, key: string, value: ParameterValue): void {
  const info = infoOf(id)
  if (!info) return
  const list = currentList()
  const present = list.find((p) => p.id === id)
  const values = { ...completeValues(info.manifest, present?.values), [key]: value }
  const newValue: ActivePlugin = { id, active: present?.active ?? false, values }
  useApp
    .getState()
    .setProcessing({ plugin: present ? list.map((p) => (p.id === id ? newValue : p)) : [...list, newValue] })
}

/** Resets a plugin's values to the defaults, without changing whether it is on. */
export function restorePlugin(id: string): void {
  const info = infoOf(id)
  if (!info) return
  const list = currentList()
  useApp.getState().setProcessing({
    plugin: list.map((p) => (p.id === id ? { ...p, values: defaultValues(info.manifest) } : p))
  })
}

/**
 * From the Plugins menu: turns the plugin on and goes to the Process step,
 * where the parameters are adjusted and Apply is pressed.
 */
export function runPluginFromMenu(id: string): void {
  const info = infoOf(id)
  if (!info) return
  const app = useApp.getState()
  const already = app.processing.plugin.find((p) => p.id === id)?.active === true
  if (!already) enablePlugin(id, true)
  app.setStep('process')
  if (!app.openPanel) app.togglePanel()
  app.notify(
    'info',
    t(already ? 'pluginRegistry.fromMenuAlreadyActive' : 'pluginRegistry.fromMenuActive', { name: info.manifest.name })
  )
}
