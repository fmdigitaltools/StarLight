import { useEffect, useMemo, type JSX } from 'react'
import { compareVersions } from '@core/plugin/manifest'
import {
  CATALOG_GROUPS,
  STAR_GROUP,
  formatBytes,
  dataLicenseName,
  catalogText,
  type CatalogGroup,
  type CatalogManifest,
  type CatalogIndexEntry
} from '@core/catalog/package'
import type { InstalledCatalog } from '@shared/catalogs'
import { Button, Label } from './Controls'
import { TrashIcon } from './Icons'
import { GALLERY } from '@shared/protectionTexts'
import {
  useCatalogs,
  readServer,
  downloadCatalog,
  cancelDownload,
  uninstallCatalog,
  enableCatalog,
  installCatalogFromArchive
} from '../catalogs/registry'
import { t, formatNumber, localeTag } from '@shared/i18n/i18n'

/**
 * "Deep-sky catalogs" section of the plugin gallery: the catalogs that can
 * be downloaded from the StarLight server and those already installed,
 * divided by group (emission nebulae, dark nebulae, galaxies…). Each card
 * says what the catalog contains, its size, who compiled it and under which
 * open license it can be used.
 *
 * The first group, "Stars for plate solving", collects the star packages
 * that allow plate solving without an internet connection: they are
 * downloaded, enabled and uninstalled like the others, but add no objects
 * to mark on the image.
 *
 * With `inList` the section appears below the plugins in the "All" and
 * "Active" filters: without the introduction, with its own title and, with
 * `onlyActive`, limited to installed and enabled catalogs.
 */

/** Translation keys of the catalog groups (the codes written in `catalog.json`). */
const GROUP_KEYS: Record<CatalogGroup, string> = {
  stars: 'stars',
  'emission-nebulae': 'emissionNebulae',
  'dark-nebulae': 'darkNebulae',
  'reflection-nebulae': 'reflectionNebulae',
  'planetary-nebulae': 'planetaryNebulae',
  'supernova-remnants': 'supernovaRemnants',
  galaxies: 'galaxies',
  'galaxy-groups': 'galaxyGroups',
  'star-clusters': 'starClusters',
  other: 'other'
}

/** Displayed name of a catalog group, in the current language. */
function groupLabel(group: string): string {
  return (CATALOG_GROUPS as readonly string[]).includes(group)
    ? t('catalogGallery.groups.' + GROUP_KEYS[group as CatalogGroup])
    : group
}


interface Entry {
  id: string
  server: CatalogIndexEntry | null
  installed: InstalledCatalog | null
}

export function CatalogGallery({
  search,
  inList = false,
  onlyActive = false
}: {
  search: string
  inList?: boolean
  onlyActive?: boolean
}): JSX.Element {
  const installedItems = useCatalogs((s) => s.installedItems)
  const server = useCatalogs((s) => s.server)

  useEffect(() => {
    if (useCatalogs.getState().server.phase !== 'reading') void readServer()
  }, [])

  const groups = useMemo(() => {
    const map = new Map<string, Entry>()
    for (const v of server.phase === 'ready' ? server.catalogs : [])
      map.set(v.id, { id: v.id, server: v, installed: null })
    for (const i of installedItems) {
      const v = map.get(i.id)
      if (v) v.installed = i
      else
        map.set(i.id, {
          id: i.id,
          server: null,
          installed: i
        })
    }
    const text = search.trim().toLowerCase()
    const entries = [...map.values()].filter((v) => {
      if (onlyActive && !v.installed?.active) return false
      if (!text) return true
      const m = (v.server ?? v.installed!.manifest) as CatalogManifest
      return [
        catalogText(m, 'name'),
        catalogText(m, 'authors'),
        catalogText(m, 'description'),
        m.name,
        m.license,
        groupLabel(m.group),
        m.example
      ].some((t) => t.toLowerCase().includes(text))
    })
    return CATALOG_GROUPS.map((g) => ({
      group: g,
      entries: entries
        .filter((v) => (v.server ?? v.installed!.manifest).group === g)
        .sort((a, b) =>
          catalogText(a.server ?? a.installed!.manifest, 'name').localeCompare(
            catalogText(b.server ?? b.installed!.manifest, 'name'),
            localeTag()
          )
        )
    })).filter((g) => g.entries.length > 0)
  }, [server, installedItems, search, onlyActive])

  // For active catalogs only, the installed ones are enough: neither the
  // server list nor its possible error is needed.
  const withServer = !onlyActive

  return (
    <>
      {inList ? (
        <h3 className="sl-gallery-section-title">{t('catalogGallery.title')}</h3>
      ) : (
        <p className="sl-catalogs-intro">{t('catalogGallery.intro')}</p>
      )}
      {withServer && server.phase === 'reading' ? (
        <p className="sl-gallery-empty">{t('catalogGallery.loading')}</p>
      ) : null}
      {withServer && server.phase === 'error' ? (
        <div className="sl-catalogs-error">
          <span>{server.message}</span>
          <Button variant="secondary" onClick={() => void readServer()}>
            {t('catalogGallery.retry')}
          </Button>
        </div>
      ) : null}
      {groups.length === 0 && (!withServer || server.phase !== 'reading') ? (
        <p className="sl-gallery-empty">
          {search
            ? t('catalogGallery.empty.noMatch')
            : onlyActive
              ? t('catalogGallery.empty.noActive')
              : t('catalogGallery.empty.none')}
        </p>
      ) : null}
      {groups.map((g) => (
        <section key={g.group} className="sl-catalogs-group" aria-label={groupLabel(g.group)}>
          <h3 className="sl-catalogs-title">{groupLabel(g.group)}</h3>
          <div className="sl-gallery-grid">
            {g.entries.map((v) => (
              <CatalogCard key={v.id} entry={v} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function CatalogCard({ entry }: { entry: Entry }): JSX.Element {
  const inProgress = useCatalogs((s) => s.inProgress)
  const progress = useCatalogs((s) => s.progress)
  const m: CatalogManifest = entry.server ?? entry.installed!.manifest
  const stars = m.type === 'stars'
  const busy = inProgress !== null
  const current = inProgress === entry.id
  const updatable =
    entry.installed !== null &&
    entry.server !== null &&
    compareVersions(entry.server.version, entry.installed.manifest.version) > 0
  const problems = entry.installed?.problems ?? null
  const name = catalogText(m, 'name')
  const weight = entry.installed
    ? t('catalogGallery.onDisk', { size: formatBytes(entry.installed.byte) })
    : entry.server
      ? formatBytes(entry.server.byte)
      : ''

  return (
    <article
      className={'sl-gallery-card sl-catalog-card' + (problems ? ' sl-gallery-card--rejected' : '')}
      aria-label={name}
    >
      <div className="sl-catalog-band" data-group={m.group}>
        <GroupIcon group={m.group} />
        <div className="sl-catalog-count">
          <strong>{formatNumber(m.objects)}</strong>
          <span>{stars ? t('catalogGallery.count.stars') : t('catalogGallery.count.objects')}</span>
        </div>
      </div>
      <div className="sl-gallery-names">
        <h3 className="sl-gallery-name">{name}</h3>
        <span className="sl-gallery-author">
          {t('catalogGallery.authorVersion', { authors: catalogText(m, 'authors'), version: m.version })}
        </span>
      </div>
      <div className="sl-gallery-labels">
        <Label color="violet" title={t('catalogGallery.licenseTitle')}>
          {dataLicenseName(m.license)}
        </Label>
        {weight ? <Label>{weight}</Label> : null}
        {stars ? (
          m.limitMagnitude !== undefined ? (
            <Label title={t('catalogGallery.limitMagnitudeTitle')}>
              {t('catalogGallery.limitMagnitude', { magnitude: formatNumber(m.limitMagnitude) })}
            </Label>
          ) : null
        ) : m.example ? (
          <Label title={t('catalogGallery.exampleTitle')}>{m.example}</Label>
        ) : null}
        {problems ? (
          <Label color="red" title={GALLERY.notLoadedTitle}>
            {GALLERY.notLoadedLabel}
          </Label>
        ) : entry.installed ? (
          entry.installed.active ? (
            <Label
              color="lime"
              title={
                stars
                  ? t('catalogGallery.status.activeStarsTitle')
                  : t('catalogGallery.status.activeTitle')
              }
            >
              {t('catalogGallery.status.active')}
            </Label>
          ) : (
            <Label
              title={
                stars
                  ? t('catalogGallery.status.disabledStarsTitle')
                  : t('catalogGallery.status.disabledTitle')
              }
            >
              {t('catalogGallery.status.disabled')}
            </Label>
          )
        ) : null}
        {entry.installed && !entry.server ? (
          <Label title={t('catalogGallery.status.fromFileTitle')}>{t('catalogGallery.status.fromFile')}</Label>
        ) : null}
      </div>
      {problems ? (
        <>
          <p className="sl-gallery-author">{GALLERY.catalog}</p>
          <ul className="sl-gallery-problems">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          {entry.installed?.remedy ? <p className="sl-gallery-description">{entry.installed.remedy}</p> : null}
        </>
      ) : (
        <p className="sl-gallery-description">
          {catalogText(m, 'description')}
        </p>
      )}
      <p className="sl-catalog-reference">
        {catalogText(m, 'reference')}
      </p>
      <div className="sl-gallery-actions">
        {current ? (
          <>
            <Progress received={progress?.received ?? 0} total={progress?.total ?? 0} />
            {progress && progress.received < progress.total ? (
              <Button variant="ghost" onClick={cancelDownload}>
                {t('catalogGallery.actions.stop')}
              </Button>
            ) : null}
          </>
        ) : entry.installed && problems ? (
          <>
            {entry.server ? (
              <Button
                variant="primary"
                onClick={() => void downloadCatalog(entry.id)}
                disabledValue={busy}
                title={GALLERY.downloadAgainTitle}
              >
                {GALLERY.actionDownloadAgain}
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() => void installCatalogFromArchive()}
                disabledValue={busy}
                title={GALLERY.reinstallCatalogTitle}
              >
                {GALLERY.actionReinstall + '…'}
              </Button>
            )}
            <Button
              variant="ghost"
              icon={<TrashIcon size={15} />}
              onClick={() => void uninstallCatalog(entry.id)}
              disabledValue={busy}
              title={GALLERY.uninstallTitle}
            >
              {t('catalogGallery.actions.uninstall')}
            </Button>
          </>
        ) : entry.installed ? (
          <>
            {updatable ? (
              <Button variant="primary" onClick={() => void downloadCatalog(entry.id)} disabledValue={busy}>
                {t('catalogGallery.actions.update', { version: entry.server!.version })}
              </Button>
            ) : null}
            {entry.installed.active ? (
              <Button
                variant="secondary"
                onClick={() => void enableCatalog(entry.id, false)}
                disabledValue={busy}
                title={
                  stars
                    ? t('catalogGallery.actions.disableStarsTitle')
                    : t('catalogGallery.actions.disableTitle')
                }
              >
                {t('catalogGallery.actions.disable')}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void enableCatalog(entry.id, true)}
                disabledValue={busy}
                title={
                  stars
                    ? t('catalogGallery.actions.enableStarsTitle')
                    : t('catalogGallery.actions.enableTitle')
                }
              >
                {t('catalogGallery.actions.enable')}
              </Button>
            )}
            <Button
              variant="ghost"
              icon={<TrashIcon size={15} />}
              onClick={() => void uninstallCatalog(entry.id)}
              disabledValue={busy}
              title={
                stars
                  ? t('catalogGallery.actions.uninstallStarsTitle')
                  : t('catalogGallery.actions.uninstallTitle')
              }
            >
              {t('catalogGallery.actions.uninstall')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => void downloadCatalog(entry.id)} disabledValue={busy}>
            {t('catalogGallery.actions.download')}
          </Button>
        )}
      </div>
    </article>
  )
}

function Progress({ received, total }: { received: number; total: number }): JSX.Element {
  const finished = total > 0 && received >= total
  const share = total > 0 ? Math.min(1, received / total) : 0
  return (
    <div className="sl-catalog-progress" role="status">
      <div className="sl-catalog-bar">
        <span style={{ width: Math.round(share * 100) + '%' }} />
      </div>
      <span className="sl-note">
        {total === 0
          ? t('catalogGallery.progress.connecting')
          : finished
            ? t('catalogGallery.progress.installing')
            : t('catalogGallery.progress.bytes', { received: formatBytes(received), total: formatBytes(total) })}
      </span>
    </div>
  )
}

/** Simple drawing for each catalog group. */
function GroupIcon({ group }: { group: string }): JSX.Element {
  const common = {
    width: 34,
    height: 34,
    viewBox: '0 0 24 24',
    fill: 'none',
    strokeWidth: 1.4,
    'aria-hidden': true
  } as const
  switch (group) {
    case STAR_GROUP:
      // Stars joined by lines: the pattern the solver recognizes.
      return (
        <svg {...common} stroke="currentColor">
          <path d="M5 16L10 7l9 4-6 8z" strokeOpacity="0.55" strokeDasharray="1.6 1.4" />
          <circle cx="5" cy="16" r="1.4" fill="currentColor" />
          <circle cx="10" cy="7" r="1.1" fill="currentColor" />
          <circle cx="19" cy="11" r="1.6" fill="currentColor" />
          <circle cx="13" cy="19" r="0.9" fill="currentColor" />
        </svg>
      )
    case 'dark-nebulae':
      return (
        <svg {...common} stroke="currentColor">
          <path d="M3 15c2-4 5-6 8-5s4 4 7 3 3-3 3-3v8H3z" fill="currentColor" fillOpacity="0.35" />
          <circle cx="6" cy="6" r="0.9" fill="currentColor" />
          <circle cx="17" cy="5" r="0.7" fill="currentColor" />
          <circle cx="12" cy="7" r="0.6" fill="currentColor" />
        </svg>
      )
    case 'galaxies':
      return (
        <svg {...common} stroke="currentColor">
          <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-25 12 12)" />
          <ellipse cx="12" cy="12" rx="2.6" ry="1.6" transform="rotate(-25 12 12)" fill="currentColor" />
        </svg>
      )
    case 'galaxy-groups':
      return (
        <svg {...common} stroke="currentColor">
          <ellipse cx="8" cy="9" rx="4" ry="1.8" transform="rotate(-20 8 9)" />
          <ellipse cx="16" cy="8" rx="3" ry="1.4" transform="rotate(30 16 8)" />
          <ellipse cx="12" cy="16" rx="4.5" ry="2" transform="rotate(10 12 16)" />
        </svg>
      )
    case 'planetary-nebulae':
      return (
        <svg {...common} stroke="currentColor">
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="12" cy="12" r="4" strokeOpacity="0.6" />
          <circle cx="12" cy="12" r="1.1" fill="currentColor" />
        </svg>
      )
    case 'star-clusters':
      return (
        <svg {...common} stroke="none" fill="currentColor">
          {[
            [12, 12, 1.4],
            [8, 9, 1],
            [16, 9, 1],
            [9, 15, 0.9],
            [15, 15, 1.1],
            [12, 6, 0.8],
            [5, 12, 0.7],
            [19, 13, 0.7],
            [12, 18, 0.8]
          ].map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} />
          ))}
        </svg>
      )
    case 'supernova-remnants':
      return (
        <svg {...common} stroke="currentColor">
          <path d="M12 3c3 1 6 3 7 6s0 7-3 9-7 2-9 0-3-6-2-9 4-6 7-6z" strokeDasharray="2 1.6" />
        </svg>
      )
    default:
      return (
        <svg {...common} stroke="currentColor">
          <path d="M4 14c1-5 5-9 9-8s7 4 6 8-6 6-10 5-6-2-5-5z" fill="currentColor" fillOpacity="0.18" />
          <circle cx="11" cy="12" r="1.2" fill="currentColor" />
        </svg>
      )
  }
}
