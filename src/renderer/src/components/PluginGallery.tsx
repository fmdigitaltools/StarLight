import { useEffect, useMemo, useState, type JSX, type PointerEvent as EventoPuntatore } from 'react'
import { createPortal } from 'react-dom'
import type { PluginInfo, PluginNotLoaded } from '@shared/plugin'
import { GALLERY } from '@shared/protectionTexts'
import { PLUGIN_CATEGORIES, type PluginCategory } from '@core/plugin/manifest'
import { Button, Label, Segmented } from './Controls'
import { CloseIcon, FolderIcon, TrashIcon } from './Icons'
import {
  usePlugin,
  enableBundled,
  disableBundled,
  installFromFolder,
  installFromArchive,
  uninstall,
  runPluginFromMenu,
  enableFromFile,
  localizedInfo
} from '../plugin/registry'
import { useApp } from '../store/appStore'
import { CatalogGallery } from './CatalogGallery'
import { useCatalogs, installCatalogFromArchive } from '../catalogs/registry'
import { getLanguage, t } from '@shared/i18n/i18n'
import { useLanguage } from '../useLanguage'
import '../styles/plugin.css'

/**
 * Plugin gallery: a window with cards for the available plugins, which can
 * be searched, filtered by category, installed and uninstalled.
 *
 * The list comes from the gallery bundled with StarLight (resources/plugin)
 * plus the plugins installed from a folder or an archive on the computer,
 * written by users or downloaded separately. The StarLight server does not
 * host third-party plugins: they are always installed from file, with the
 * buttons at the bottom of the window.
 *
 * The "Deep sky catalogs" section is different: it shows data-only
 * catalogs downloaded from the StarLight server (see CatalogGallery).
 */

type Filter = 'all' | PluginCategory | 'catalogs' | 'installed'

/** A grid entry: as it appears in the gallery and as it is installed. */
interface Entry {
  id: string
  gallery: PluginInfo | null
  installed: PluginInfo | null
  /** Installed from file but disabled. */
  deactivated: PluginInfo | null
}

export function PluginGallery(): JSX.Element | null {
  const open = usePlugin((s) => s.galleryOpen)
  if (!open) return null
  // Rendered outside the top bar, like the settings window.
  return createPortal(<ModalWindow />, document.body)
}

function ModalWindow(): JSX.Element {
  const close = usePlugin((s) => s.closeGallery)
  const installedItems = usePlugin((s) => s.installedItems)
  const disabledFromFile = usePlugin((s) => s.disabledItems)
  const notLoaded = usePlugin((s) => s.notLoaded)
  const pluginInProgress = usePlugin((s) => s.inProgress)
  const catalogInProgress = useCatalogs((s) => s.inProgress)
  const inProgress = pluginInProgress ?? catalogInProgress
  const [gallery, setGallery] = useState<PluginInfo[] | null>(null)
  const [filter, setFilter] = useState<Filter>(() => usePlugin.getState().galleryFilter)
  const [search, setSearch] = useState('')
  const language = useLanguage()

  useEffect(() => {
    let live = true
    window.starlight
      .pluginGallery()
      .then((g) => live && setGallery(g))
      .catch(() => live && setGallery([]))
    void usePlugin.getState().reload()
    const before = document.activeElement as HTMLElement | null
    document.querySelector<HTMLInputElement>('.sl-gallery-search')?.focus()
    return () => {
      live = false
      before?.focus?.()
    }
  }, [])

  const entries = useMemo((): Entry[] => {
    const map = new Map<string, Entry>()
    // The gallery arrives with the manifests as written: their texts are shown
    // in the current language, and translated again when it changes (`language`).
    for (const g of (gallery ?? []).map(localizedInfo))
      map.set(g.manifest.id, {
        id: g.manifest.id,
        gallery: g,
        installed: null,
        deactivated: null
      })
    for (const i of installedItems) {
      const v = map.get(i.manifest.id)
      if (v) v.installed = i
      else
        map.set(i.manifest.id, {
          id: i.manifest.id,
          gallery: null,
          installed: i,
          deactivated: null
        })
    }
    for (const d of disabledFromFile) {
      const v = map.get(d.manifest.id)
      if (v) v.deactivated = d
      else map.set(d.manifest.id, { id: d.manifest.id, gallery: null, installed: null, deactivated: d })
    }
    const text = search.trim().toLowerCase()
    return [...map.values()]
      .filter((v) => {
        const m = (v.installed ?? v.deactivated ?? v.gallery)!.manifest
        if (filter === 'installed' && !v.installed) return false
        if ((filter === 'astrophotography' || filter === 'photography') && m.category !== filter) return false
        if (!text) return true
        return [m.name, m.author, m.description, m.license].some((t) => t.toLowerCase().includes(text))
      })
      .sort((a, b) =>
        (a.installed ?? a.deactivated ?? a.gallery)!.manifest.name.localeCompare(
          (b.installed ?? b.deactivated ?? b.gallery)!.manifest.name,
          getLanguage()
        )
      )
  }, [gallery, installedItems, disabledFromFile, filter, search, language])

  const rejected = useMemo(() => {
    const text = search.trim().toLowerCase()
    return filter === 'astrophotography' || filter === 'photography'
      ? []
      : notLoaded.filter((p) => !text || p.name.toLowerCase().includes(text))
  }, [notLoaded, search, filter])

  // "All" and "Active" show plugins and catalogs in two blocks, each with
  // its own title; the other tabs show a single type.
  const withCatalogs = filter === 'all' || filter === 'installed'

  const plugin =
    gallery === null ? (
      <p className="sl-gallery-empty">{t('pluginGallery.loading')}</p>
    ) : entries.length === 0 && rejected.length === 0 ? (
      <p className="sl-gallery-empty">
        {filter === 'installed' && !search
          ? t('pluginGallery.noActive')
          : t('pluginGallery.noResults')}
      </p>
    ) : (
      <div className="sl-gallery-grid">
        {rejected.map((p) => (
          <NotLoadedCard key={'scartato-' + p.id} plugin={p} busy={inProgress !== null} inProgress={pluginInProgress === p.id} />
        ))}
        {entries.map((v) => (
          <PluginCard key={v.id} entry={v} busy={inProgress !== null} inProgress={pluginInProgress === v.id} />
        ))}
      </div>
    )

  return (
    <div className="sl-overlay" onClick={close}>
      <div
        className="sl-dialog sl-gallery"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-gallery-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
          // Keys typed in the search field must not reach the viewer shortcuts.
          if (e.key !== 'F1') e.stopPropagation()
        }}
      >
        <header className="sl-dialog-head">
          <PieceIcon />
          <div>
            <h2 className="sl-dialog-title" id="sl-gallery-title">
              {t('pluginGallery.title')}
            </h2>
            <p className="sl-dialog-subtitle">
              {t('pluginGallery.subtitle')}
            </p>
          </div>
          <div className="sl-topbar-spacer" />
          <Button variant="ghost" icon={<CloseIcon size={16} />} onClick={close}>
            {t('pluginGallery.close')}
          </Button>
        </header>

        <div className="sl-gallery-tools">
          <input
            className="sl-settings-field sl-gallery-search"
            type="search"
            placeholder={
              filter === 'catalogs'
                ? t('pluginGallery.searchCatalogsPlaceholder')
                : t('pluginGallery.searchPlaceholder')
            }
            aria-label={t('pluginGallery.searchLabel')}
            value={search}
            spellCheck={false}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="sl-gallery-filter">
            <Segmented<Filter>
              value={filter}
              options={[
                { value: 'all', label: t('pluginGallery.filter.all') },
                ...PLUGIN_CATEGORIES.map((c) => ({
                  value: c.value as Filter,
                  label: c.label
                })),
                { value: 'catalogs', label: t('pluginGallery.filter.catalogs') },
                { value: 'installed', label: t('pluginGallery.filter.active') }
              ]}
              onChange={setFilter}
            />
          </div>
        </div>

        <div className="sl-dialog-body sl-gallery-body">
          {filter === 'catalogs' ? (
            <CatalogGallery search={search} />
          ) : withCatalogs ? (
            <>
              <h3 className="sl-gallery-section-title">{t('pluginGallery.pluginsSection')}</h3>
              {plugin}
              <CatalogGallery search={search} inList onlyActive={filter === 'installed'} />
            </>
          ) : (
            plugin
          )}
        </div>

        <footer className="sl-dialog-footer">
          {filter === 'catalogs' ? (
            <div className="sl-gallery-from-file">
              <span className="sl-gallery-question">{t('pluginGallery.fromFile.catalogQuestion')}</span>
              <Button
                onClick={() => void installCatalogFromArchive()}
                disabledValue={inProgress !== null}
                title={t('pluginGallery.fromFile.catalogArchiveHint')}
              >
                {t('pluginGallery.fromFile.archive')}
              </Button>
            </div>
          ) : (
            <div className="sl-gallery-from-file">
              <span className="sl-gallery-question">{t('pluginGallery.fromFile.pluginQuestion')}</span>
              <Button
                icon={<FolderIcon size={15} />}
                onClick={() => void installFromFolder()}
                disabledValue={inProgress !== null}
                title={t('pluginGallery.fromFile.folderHint')}
              >
                {t('pluginGallery.fromFile.folder')}
              </Button>
              <Button
                onClick={() => void installFromArchive()}
                disabledValue={inProgress !== null}
                title={t('pluginGallery.fromFile.pluginArchiveHint')}
              >
                {t('pluginGallery.fromFile.archive')}
              </Button>
            </div>
          )}
          <Button variant="primary" onClick={close}>
            {t('pluginGallery.done')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

function PluginCard({ entry, busy, inProgress }: { entry: Entry; busy: boolean; inProgress: boolean }): JSX.Element {
  const info = (entry.installed ?? entry.deactivated ?? entry.gallery)!
  const m = info.manifest
  const suspendedReason = usePlugin((s) => s.suspended[entry.id])
  // Plugins from the bundled gallery are enabled and disabled; those taken
  // from a file are installed and uninstalled.
  const isBundled = entry.gallery !== null && (entry.installed === null || entry.installed.origin !== 'file')
  const loadedValue = entry.installed !== null
  const inUse = useApp((s) => s.processing.plugin.some((p) => p.id === entry.id && p.active))
  const category = PLUGIN_CATEGORIES.find((c) => c.value === m.category)?.label ?? m.category
  const show = entry.gallery ?? info

  return (
    <article className="sl-gallery-card" aria-label={m.name}>
      <BeforeAfter before={show.previewBefore} after={show.previewAfter} name={m.name} />
      <div className="sl-gallery-head">
        {info.icon ? (
          <img className="sl-gallery-icon" src={info.icon} alt="" />
        ) : (
          <span className="sl-gallery-icon" />
        )}
        <div className="sl-gallery-names">
          <h3 className="sl-gallery-name">{m.name}</h3>
          <span className="sl-gallery-author">
            {t('pluginGallery.card.authorVersion', { author: m.author, version: m.version })}
          </span>
        </div>
      </div>
      <div className="sl-gallery-labels">
        <Label color={m.category === 'astrophotography' ? 'violet' : 'cyan'}>{category}</Label>
        <Label title={t('pluginGallery.card.licenseHint')}>{m.license}</Label>
        {loadedValue ? (
          <Label color="lime" title={inUse ? t('pluginGallery.card.inUseHint') : t('pluginGallery.card.loadedHint')}>
            {isBundled
              ? inUse
                ? t('pluginGallery.card.activeInUse')
                : t('pluginGallery.card.active')
              : inUse
                ? t('pluginGallery.card.installedInUse')
                : t('pluginGallery.card.installed')}
          </Label>
        ) : null}
        {entry.deactivated && !loadedValue ? (
          <Label title={t('pluginGallery.card.disabledHint')}>{t('pluginGallery.card.disabled')}</Label>
        ) : null}
        {suspendedReason ? (
          <Label color="amber" title={GALLERY.suspended + ' (' + suspendedReason + ')'}>{GALLERY.suspendedLabel}</Label>
        ) : null}
        {!entry.gallery ? (
          <Label title={t('pluginGallery.card.fromFileHint')}>{t('pluginGallery.card.fromFile')}</Label>
        ) : null}
      </div>
      <p className="sl-gallery-description">
        {m.description}
      </p>
      <div className="sl-gallery-actions">
        {inProgress ? (
          <span className="sl-note">{t('pluginGallery.card.inProgress')}</span>
        ) : loadedValue ? (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                runPluginFromMenu(entry.id)
                usePlugin.getState().closeGallery()
              }}
              title={t('pluginGallery.card.useHint')}
            >
              {t('pluginGallery.card.use')}
            </Button>
            {isBundled ? (
              <Button
                variant="ghost"
                onClick={() => void disableBundled(entry.id)}
                disabledValue={busy}
                title={t('pluginGallery.card.disableHint')}
              >
                {t('pluginGallery.card.disable')}
              </Button>
            ) : (
              <Button
                variant="ghost"
                icon={<TrashIcon size={15} />}
                onClick={() => void uninstall(entry.id)}
                disabledValue={busy}
                title={t('pluginGallery.card.uninstallHint')}
              >
                {t('pluginGallery.card.uninstall')}
              </Button>
            )}
          </>
        ) : entry.deactivated ? (
          <>
            <Button
              variant="primary"
              onClick={() => void enableFromFile(entry.id, true)}
              disabledValue={busy}
              title={t('pluginGallery.card.reenableHint')}
            >
              {t('pluginGallery.card.reenable')}
            </Button>
            <Button
              variant="ghost"
              icon={<TrashIcon size={15} />}
              onClick={() => void uninstall(entry.id)}
              disabledValue={busy}
              title={t('pluginGallery.card.uninstallHint')}
            >
              {t('pluginGallery.card.uninstall')}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            onClick={() => void enableBundled(entry.id)}
            disabledValue={busy}
            title={t('pluginGallery.card.enableHint')}
          >
            {t('pluginGallery.card.enable')}
          </Button>
        )}
      </div>
    </article>
  )
}

/**
 * Card of a plugin that failed the startup checks: the problem found, what
 * to do, and the buttons to remove or reinstall it. A damaged bundled
 * plugin can only be disabled: restoring it requires reinstalling StarLight.
 */
function NotLoadedCard({
  plugin,
  busy,
  inProgress
}: {
  plugin: PluginNotLoaded
  busy: boolean
  inProgress: boolean
}): JSX.Element {
  return (
    <article className="sl-gallery-card sl-gallery-card--rejected" aria-label={plugin.name}>
      <div className="sl-gallery-head">
        <span className="sl-gallery-icon" />
        <div className="sl-gallery-names">
          <h3 className="sl-gallery-name">{plugin.name}</h3>
          <span className="sl-gallery-author">{GALLERY.plugin}</span>
        </div>
      </div>
      <div className="sl-gallery-labels">
        <Label color="red" title={GALLERY.notLoadedTitle}>
          {GALLERY.notLoadedLabel}
        </Label>
        {plugin.origin === 'file' ? <Label>{t('pluginGallery.card.fromFile')}</Label> : null}
      </div>
      <ul className="sl-gallery-problems">
        {plugin.problems.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
      <p className="sl-gallery-description">{plugin.remedy}</p>
      <div className="sl-gallery-actions">
        {inProgress ? (
          <span className="sl-note">{t('pluginGallery.card.inProgress')}</span>
        ) : plugin.origin === 'file' ? (
          <>
            <Button
              variant="secondary"
              onClick={() => void installFromArchive()}
              disabledValue={busy}
              title={GALLERY.reinstallPluginTitle}
            >
              {GALLERY.actionReinstall + '…'}
            </Button>
            <Button
              variant="ghost"
              icon={<TrashIcon size={15} />}
              onClick={() => void uninstall(plugin.id)}
              disabledValue={busy}
              title={GALLERY.uninstallTitle}
            >
              {t('pluginGallery.card.uninstall')}
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            onClick={() => void disableBundled(plugin.id)}
            disabledValue={busy}
            title={t('pluginGallery.card.disableNotLoadedHint')}
          >
            {t('pluginGallery.card.disable')}
          </Button>
        )}
      </div>
    </article>
  )
}

/**
 * Before and after preview in the same frame: the dividing line follows the
 * pointer, so the two versions can be compared at the same spot.
 */
function BeforeAfter({ before, after, name }: { before: string | null; after: string | null; name: string }): JSX.Element {
  const [split, setSplit] = useState(50)
  if (!before || !after)
    return <div className="sl-gallery-preview sl-gallery-preview--empty">{t('pluginGallery.preview.unavailable')}</div>
  const follow = (e: EventoPuntatore<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setSplit(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
  }
  return (
    <div
      className="sl-gallery-preview"
      onPointerMove={follow}
      onPointerLeave={() => setSplit(50)}
      title={t('pluginGallery.preview.hint')}
    >
      <img src={before} alt={t('pluginGallery.preview.beforeAlt', { name })} draggable={false} />
      <img
        src={after}
        alt={t('pluginGallery.preview.afterAlt', { name })}
        draggable={false}
        className="sl-gallery-after"
        style={{ clipPath: 'inset(0 0 0 ' + split + '%)' }}
      />
      <span className="sl-gallery-line" style={{ left: split + '%' }} />
      <span className="sl-gallery-tag sl-gallery-tag--before">{t('pluginGallery.preview.before')}</span>
      <span className="sl-gallery-tag sl-gallery-tag--after">{t('pluginGallery.preview.after')}</span>
    </div>
  )
}

/** A puzzle piece: the plugin symbol. */
function PieceIcon(): JSX.Element {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--sl-cyan)"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 8h3a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v4h-4a2 2 0 1 0-4 0H5v-4a2 2 0 1 0 0-4z" />
    </svg>
  )
}
