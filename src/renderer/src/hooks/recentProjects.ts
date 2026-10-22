import { create } from 'zustand'
import { useApp } from '../store/appStore'
import { updatePreferences } from '../settings'
import { PROJECT_FILE_NAME, joinPath } from '@core/project'
import { openProjectFromFile } from './useProject'
import { t } from '@shared/i18n/i18n'

/**
 * Recent projects in the File menu: the last five saved or opened, newest
 * first, so they can be reopened without browsing for them. The list is
 * stored in the preferences, so it persists across launches.
 */

/** Preferences key holding the list. */
const RECENT_PROJECTS_KEY = 'recentProjects'

/** How many projects to keep in the list. */
const MAX_RECENT = 5

export interface RecentProject {
  name: string
  folder: string
}

interface RecentState {
  entries: RecentProject[]
}

export const useRecentProjects = create<RecentState>(() => ({ entries: [] }))

/** Keeps only well-formed entries: the preferences file can be edited by hand. */
function validEntries(raw: unknown): RecentProject[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (v): v is RecentProject =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as RecentProject).name === 'string' &&
        typeof (v as RecentProject).folder === 'string'
    )
    .slice(0, MAX_RECENT)
}

function write(entries: RecentProject[]): void {
  useRecentProjects.setState({ entries })
  void updatePreferences({ [RECENT_PROJECTS_KEY]: entries })
}

void window.starlight
  .readPreferences()
  .then((prefs) => {
    useRecentProjects.setState({ entries: validEntries(prefs[RECENT_PROJECTS_KEY]) })
  })
  .catch(() => undefined)

/*
 * Every project saved or opened goes to the top of the list; if it was
 * already there, it moves to the top instead of appearing twice.
 */
useApp.subscribe((s, before) => {
  if (s.project === null || s.project.folder === before.project?.folder) return
  const newValue = { name: s.project.name, folder: s.project.folder }
  const others = useRecentProjects.getState().entries.filter((v) => v.folder !== newValue.folder)
  write([newValue, ...others].slice(0, MAX_RECENT))
})

/** Reopens a project from the list; if it has since been moved or deleted, removes it. */
export async function openRecent(entry: RecentProject): Promise<void> {
  const path = joinPath(entry.folder, PROJECT_FILE_NAME)
  const [exists] = await window.starlight.exist([path]).catch(() => [true])
  if (!exists) {
    write(useRecentProjects.getState().entries.filter((v) => v.folder !== entry.folder))
    useApp
      .getState()
      .notify('warning', t('hooksRecentProjects.notFound', { name: entry.name }))
    return
  }
  await openProjectFromFile(path)
}

/** Clears the list (File menu item). */
export function clearRecent(): void {
  write([])
}
