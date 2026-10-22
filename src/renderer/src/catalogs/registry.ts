import { create } from 'zustand'
import type { InstalledCatalog, CatalogInstallResult } from '@shared/catalogs'
import { analyzeCatalogObjects, catalogName, type CatalogIndexEntry, type ObjectDescriber } from '@core/catalog/package'
import { registerProtectedCatalogs, removeCatalog, type CatalogObjects } from '@core/catalog/catalog'
import { excludedCatalog, installationRejected } from '@shared/protectionTexts'
import type { CelestialObject } from '@shared/types'
import { recognizeObjects } from '@core/catalog/recognition'
import { useApp } from '../store/appStore'
import { noInternetNotice, internetAllowed } from '../settings'
import { formatNumber, t } from '@shared/i18n/i18n'

/**
 * Deep-sky catalogs on the interface side: which ones are installed, which
 * can be downloaded from the server, and how they join the object catalog.
 *
 * At startup the objects of the installed catalogs are read from disk and
 * added to the catalog bundled with the program; after an installation or an
 * uninstallation the catalog is rebuilt and the objects of the open image are
 * recognised again, so new markers appear immediately.
 *
 * Star packages for plate solving (manifest type `stars`) are installed,
 * enabled and uninstalled the same way, but they do not join the object
 * catalog: their stars are read by the main process when a field needs to
 * be solved.
 */

/** State of the server list. */
export type ServerState =
  | { phase: 'never' }
  | { phase: 'reading' }
  | { phase: 'ready'; catalogs: CatalogIndexEntry[] }
  | { phase: 'error'; message: string }

interface CatalogsState {
  installedItems: InstalledCatalog[]
  server: ServerState
  /** Catalog being installed or uninstalled. */
  inProgress: string | null
  /** Bytes received and total of the download in progress. */
  progress: { received: number; total: number } | null
}

export const useCatalogs = create<CatalogsState>(() => ({
  installedItems: [],
  server: { phase: 'never' },
  inProgress: null,
  progress: null
}))

window.starlight.onCatalogProgress((a) => {
  if (useCatalogs.getState().inProgress === a.id)
    useCatalogs.setState({
      progress: { received: a.received, total: a.total }
    })
})

/** Recognises the objects of the open image again with the updated catalog. */
function recognizeAgain(): void {
  const app = useApp.getState()
  const frame = app.frame.find((f) => f.id === app.activeFrameId)
  if (frame) app.setObjects(recognizeObjects(frame.metadata))
}

/** A catalog that could not be loaded: name and problem, for the notices. */
export interface RejectedCatalog {
  id: string
  name: string
  problem: string
}

/**
 * Reads from disk and checks the objects of an installed catalog
 * (analyzeCatalogObjects): the objects, or the problem that excludes it.
 */
async function readObjects(
  c: InstalledCatalog
): Promise<{ objects: CelestialObject[]; describe: ObjectDescriber } | { problem: string }> {
  try {
    const tsv = await window.starlight.catalogObjects(c.id)
    const analysis = analyzeCatalogObjects(tsv, c.manifest)
    return analysis.errors.length > 0
      ? { problem: analysis.errors[0] }
      : { objects: analysis.objects, describe: analysis.describe }
  } catch (e) {
    return { problem: withoutIpcPrefix(e instanceof Error ? e.message : String(e)) }
  }
}

function withoutIpcPrefix(m: string): string {
  return m.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}

/**
 * Adds the given catalogs to the object catalog, each one checked; any that
 * fail the checks or make the build fail are excluded for this session (the
 * main process remembers it, the gallery shows it). Returns the excluded
 * ones.
 */
async function loadProtected(catalogs: InstalledCatalog[]): Promise<RejectedCatalog[]> {
  const rejected: RejectedCatalog[] = []
  const readCount: CatalogObjects[] = []
  for (const c of catalogs) {
    const r = await readObjects(c)
    if ('problem' in r) rejected.push({ id: c.id, name: catalogName(c.manifest), problem: r.problem })
    else readCount.push({ id: c.id, objects: r.objects, describe: r.describe })
  }
  // All together: the catalog is rebuilt only once, if none of them causes damage.
  for (const e of registerProtectedCatalogs(readCount)) {
    const c = catalogs.find((x) => x.id === e.id)
    rejected.push({ id: e.id, name: (c ? catalogName(c.manifest) : e.id), problem: e.error })
  }
  for (const s of rejected) await window.starlight.excludeCatalog(s.id, s.problem).catch(() => undefined)
  if (rejected.length > 0) await rereadInstalled().catch(() => undefined)
  return rejected
}

/** Reads the objects of an installed catalog from disk and adds them; notifies if it must be excluded. */
async function load(c: InstalledCatalog): Promise<void> {
  if (c.manifest.type === 'stars' || c.problems) return
  for (const s of await loadProtected([c])) useApp.getState().notify('warning', excludedCatalog(s.name, s.problem))
}

/** Reads the installed list again (without touching the object catalog). */
async function rereadInstalled(): Promise<InstalledCatalog[]> {
  const installedItems = await window.starlight.installedCatalogs()
  useCatalogs.setState({ installedItems })
  return installedItems
}

/**
 * At startup: adds all installed and enabled catalogs to the object catalog.
 * Returns those that could not be loaded (rejected by the main process
 * checks or by the ones made here while reading the objects): the notice is
 * given by startupNotice.ts, together with the one for plugins.
 */
async function loadAtStartup(): Promise<RejectedCatalog[]> {
  try {
    const installedItems = (await rereadInstalled()).filter((c) => c.active)
    const alreadyDiscarded: RejectedCatalog[] = installedItems
      .filter((c) => c.problems)
      .map((c) => ({ id: c.id, name: catalogName(c.manifest), problem: c.problems![0] }))
    const toLoad = installedItems.filter((c) => !c.problems && c.manifest.type !== 'stars')
    const newOnes = toLoad.length > 0 ? await loadProtected(toLoad) : []
    if (toLoad.length > 0) recognizeAgain()
    return [...alreadyDiscarded, ...newOnes]
  } catch {
    // No readable installed catalog: the bundled one remains.
    return []
  }
}

export const firstCatalogRead: Promise<RejectedCatalog[]> = loadAtStartup()

/** Reads the installed list again, for example after a package has been excluded. */
export function updateInstalled(): Promise<void> {
  return rereadInstalled().then(
    () => undefined,
    () => undefined
  )
}

/** True if a star package for plate solving is installed and enabled. */
export function activeLocalStars(): boolean {
  return useCatalogs.getState().installedItems.some((c) => c.manifest.type === 'stars' && c.active && !c.problems)
}

/** Asks the server for the catalog list, if internet access is allowed. */
export async function readServer(): Promise<void> {
  if (!internetAllowed()) {
    useCatalogs.setState({
      server: {
        phase: 'error',
        message: noInternetNotice(t('catalogsRegistry.featureCatalogList'))
      }
    })
    return
  }
  useCatalogs.setState({ server: { phase: 'reading' } })
  const result = await window.starlight.availableCatalogs()
  useCatalogs.setState({
    server: result.ok ? { phase: 'ready', catalogs: result.catalogs } : { phase: 'error', message: result.error }
  })
}

async function finish(result: CatalogInstallResult): Promise<boolean> {
  const notify = useApp.getState().notify
  if (!result.ok) {
    if (!result.cancelled) notify('error', installationRejected('catalog', result.name ?? null, result.errors, result.remedy))
    return false
  }
  const installedItems = await rereadInstalled()
  const newValue = installedItems.find((c) => c.id === result.manifest.id)
  // A disabled catalog stays disabled even after an update.
  if (newValue && newValue.active) await load(newValue)
  recognizeAgain()
  if (result.manifest.type === 'stars') {
    notify(
      'ok',
      t(result.updated ? 'catalogsRegistry.starsUpdated' : 'catalogsRegistry.starsInstalled', {
        name: catalogName(result.manifest),
        count: formatNumber(result.manifest.objects)
      })
    )
    return true
  }
  notify(
    'ok',
    t(result.updated ? 'catalogsRegistry.catalogUpdated' : 'catalogsRegistry.catalogInstalled', {
      name: catalogName(result.manifest),
      count: formatNumber(result.manifest.objects)
    })
  )
  return true
}


async function withStatus(id: string, action: () => Promise<CatalogInstallResult>): Promise<boolean> {
  if (useCatalogs.getState().inProgress) return false
  useCatalogs.setState({ inProgress: id, progress: null })
  try {
    return await finish(await action())
  } catch (e) {
    useApp
      .getState()
      .notify('error', installationRejected('catalog', null, [e instanceof Error ? e.message : String(e)]))
    return false
  } finally {
    useCatalogs.setState({ inProgress: null, progress: null })
  }
}

/** Downloads from the server and installs (or updates) a catalog. */
export function downloadCatalog(id: string): Promise<boolean> {
  if (!internetAllowed()) {
    useApp.getState().notify('error', noInternetNotice(t('catalogsRegistry.featureDownload')))
    return Promise.resolve(false)
  }
  return withStatus(id, () => window.starlight.installCatalog(id))
}

export function cancelDownload(): void {
  const id = useCatalogs.getState().inProgress
  if (id) void window.starlight.cancelCatalog(id)
}

export function installCatalogFromArchive(): Promise<boolean> {
  return withStatus('archive', () => window.starlight.installCatalogFromArchive())
}

/**
 * Enables or disables an installed catalog. When disabled it stays on disk
 * but its objects leave the object catalog; the choice persists across
 * startups.
 */
export async function enableCatalog(id: string, active: boolean): Promise<void> {
  if (useCatalogs.getState().inProgress) return
  const entry = useCatalogs.getState().installedItems.find((c) => c.id === id)
  useCatalogs.setState({ inProgress: id })
  try {
    await window.starlight.enableCatalog(id, active)
    if (active && entry) await load(entry)
    else removeCatalog(id)
    await rereadInstalled()
    recognizeAgain()
    const stars = entry?.manifest.type === 'stars'
    useApp
      .getState()
      .notify(
        'ok',
        t(
          stars
            ? active
              ? 'catalogsRegistry.starsEnabled'
              : 'catalogsRegistry.starsDisabled'
            : active
              ? 'catalogsRegistry.catalogEnabled'
              : 'catalogsRegistry.catalogDisabled',
          { name: entry ? catalogName(entry.manifest) : id }
        )
      )
  } catch (e) {
    useApp.getState().notify('error', t('catalogsRegistry.operationFailed', { detail: e instanceof Error ? e.message : String(e) }))
  } finally {
    useCatalogs.setState({ inProgress: null })
  }
}

export async function uninstallCatalog(id: string): Promise<void> {
  if (useCatalogs.getState().inProgress) return
  const installed = useCatalogs.getState().installedItems.find((c) => c.id === id)
  const name = installed ? catalogName(installed.manifest) : id
  useCatalogs.setState({ inProgress: id })
  try {
    await window.starlight.uninstallCatalog(id)
    removeCatalog(id)
    await rereadInstalled()
    recognizeAgain()
    useApp.getState().notify('ok', t('catalogsRegistry.uninstalled', { name }))
  } catch (e) {
    useApp.getState().notify('error', t('catalogsRegistry.uninstallFailed', { detail: e instanceof Error ? e.message : String(e) }))
  } finally {
    useCatalogs.setState({ inProgress: null })
  }
}
