import { t } from './i18n/i18n'

/**
 * StarLight version information, shown in the interface (top bar, About
 * window, status bar). Single source of truth: change it here and in
 * package.json.
 */

export const APP_NAME = 'StarLight'

/**
 * Version of the application, following Semantic Versioning 2.0.0
 * (https://semver.org): MAJOR.MINOR.PATCH, with a pre-release tag for test
 * releases (1.0.0-beta.1, 1.0.0-beta.2…, then 1.0.0). After 1.0.0: PATCH for
 * fixes, MINOR for compatible new features, MAJOR for incompatible changes.
 */
export const APP_VERSION = '1.0.0-beta.1'

/** Pre-release tag of the version ("beta" in 1.0.0-beta.1), empty for a stable release. */
export const PRERELEASE = /^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(APP_VERSION)?.[1]?.toLowerCase() ?? ''

/** Development stage derived from the version: "Beta", "Alpha", "RC", or empty when stable. */
export const APP_STAGE = PRERELEASE === 'rc' ? 'RC' : PRERELEASE.charAt(0).toUpperCase() + PRERELEASE.slice(1)

/**
 * Code name. It was "Andromeda" throughout the Alpha stage; from the Beta
 * onwards each new version is named after a different well-known celestial
 * object, never repeated (patch releases keep the name of their version).
 */
export const APP_CODENAME = 'Vega'

/** Compact label for the top bar, e.g. "v1.0.0-beta.1": the version already names the stage. */
export const VERSION_LABEL = `v${APP_VERSION}`

/** Main window title. */
export const WINDOW_TITLE = `${APP_NAME} ${VERSION_LABEL}`

export interface RuntimeVersions {
  app: string
  stage: string
  codename: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
}

/*
 * Attribution and license. No copyright notice is shown: the program only
 * displays the author and the license.
 */

/** Pseudonym under which the application is signed. */
export const AUTHOR = 'FM Digital Tools'

/** Author website, with the contact form. */
export const AUTHOR_URL = 'https://fmdigitaltools.com/'

/**
 * Author contact, shown in the About window. Assembled at run time so the address
 * never appears whole in the published source, where address harvesters look for it.
 */
export const AUTHOR_EMAIL = ['dev', 'fmdigitaltools.com'].join('@')

/**
 * License under which StarLight is distributed: GNU GPL version 3 or, at the
 * user's option, any later version. The full text is in the LICENSE file at
 * the project root and can be opened from the Help menu.
 * Returns the license text in the current language.
 */
export function rightsText(): string {
  return t('sharedVersion.rights')
}

/** SPDX identifier of the license, the same one written in package.json. */
export const SPDX_LICENSE = 'GPL-3.0-or-later'

/**
 * Donations page (Ko-fi). While it contains the "…" placeholder, the
 * interface recognises it and, instead of opening a link that leads nowhere,
 * says the page will be available soon. Writing the real address here
 * enables it.
 */
export const DONATIONS_URL = 'https://ko-fi.com/fmdigitaltools'

/** True while DONATIONS_URL is still the placeholder. */
export function donationsAvailable(): boolean {
  return !DONATIONS_URL.includes('…')
}

/** Message shown while the donations page does not exist, in the current language. */
export function donationsNotice(): string {
  return t('sharedVersion.donationsNotice')
}

/**
 * Update and catalog server: an address on the StarLight domain that points
 * to the Cloudflare Worker serving the files of the R2 bucket (latest.yml,
 * installer, blockmap, catalogs). While it is a placeholder containing "…",
 * update checks do not start and the menu reports that the service is not
 * configured yet.
 */
export const UPDATES_URL = 'https://updates.fmdigitaltools.com/'

/**
 * Direct address of the Worker, used when the main one does not respond
 * (src/main/server.ts). Do not change it: versions installed before the
 * domain existed look for updates here.
 */
export const FALLBACK_UPDATES_URL = 'https://starlight-updates.fm-digitals.workers.dev/'

/** True once UPDATES_URL is no longer the placeholder. */
export function updatesConfigured(): boolean {
  return !UPDATES_URL.includes('…')
}

/**
 * Optional key for the update server, sent with every request in the
 * UPDATES_KEY_HEADER header. Empty means open access (no header). Fill it in
 * only if the Worker is configured to require it. It is not a real secret:
 * anyone with the program can read it; it only keeps random requests away.
 */
export const UPDATES_KEY = ''

/** Name of the header carrying the key (the same in the Worker). */
export const UPDATES_KEY_HEADER = 'X-StarLight-Key'

/** Message shown while the update server is not configured, in the current language. */
export function updatesNotice(): string {
  return t('sharedVersion.updatesNotice')
}

/**
 * Attribution note shown at the bottom of windows: author and license,
 * without copyright symbol or years.
 */
export function licenseNote(): string {
  return AUTHOR + ' — ' + rightsText()
}
