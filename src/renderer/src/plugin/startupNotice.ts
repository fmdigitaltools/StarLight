import { useApp } from '../store/appStore'
import { firstPluginRead, usePlugin } from './registry'
import { firstCatalogRead, useCatalogs } from '../catalogs/registry'
import {
  GALLERY,
  REMEDIES,
  notLoadedMessage,
  notLoadedSummary,
  type ProtectedItem
} from '@shared/protectionTexts'

/**
 * Startup notice for plugins and catalogs that failed the checks and were
 * not loaded: a single notice summarising all of them, with a button that
 * opens the gallery (where each one shows its problem and the buttons to
 * uninstall or reinstall it). None of them blocks startup: the rest of
 * StarLight works normally.
 */

interface Entry {
  what: ProtectedItem
  name: string
  problem: string
  remedy: string
}

async function notifyAtStartup(): Promise<void> {
  const [, catalogs] = await Promise.all([firstPluginRead, firstCatalogRead])
  const entries: Entry[] = usePlugin.getState().notLoaded.map((p) => ({
    what: 'plugin',
    name: p.name,
    problem: p.problems[0] ?? '',
    remedy: p.remedy
  }))
  const installedItems = useCatalogs.getState().installedItems
  for (const c of catalogs) {
    const entry = installedItems.find((x) => x.id === c.id)
    entries.push({
      what: entry?.manifest.type === 'stars' ? 'stars' : 'catalog',
      name: c.name,
      problem: c.problem,
      remedy: entry?.remedy ?? REMEDIES.reinstallCatalog
    })
  }
  if (entries.length === 0) return
  const onlyCatalogs = entries.every((v) => v.what !== 'plugin')
  const action = {
    label: GALLERY.actionOpenGallery,
    run: () => usePlugin.getState().openGallery(onlyCatalogs ? 'catalogs' : 'all')
  }
  const text =
    entries.length === 1
      ? notLoadedMessage(entries[0].what, entries[0].name, [entries[0].problem], entries[0].remedy)
      : notLoadedSummary(entries.map((v) => ({ name: v.name, problem: v.problem })))
  useApp.getState().notify('warning', text, action)
}

void notifyAtStartup().catch(() => undefined)
