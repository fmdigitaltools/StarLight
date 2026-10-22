import { formatNumber, t } from './i18n/i18n'

/**
 * Texts of the protection checks: why a plugin or a catalog was not
 * installed, was not loaded at startup or was stopped while running, and
 * what the user can do about it.
 *
 * They all live here, in one place, so they can be reviewed together. The
 * checkers (manifest.ts, package.ts, zip.ts, the main process, the
 * interface) take their sentences from here and never write their own. The
 * texts themselves are in the `sharedProtectionTexts` language files; every
 * entry is a getter or a function, so it is translated when it is read and
 * follows a language change.
 *
 * Three kinds of text:
 * - **problems**, complete sentences that say in plain words what is wrong
 *   ("The plugin.js file is missing…");
 * - execution **reasons**, short sentence fragments that are inserted into a
 *   longer message ("returned an image with invalid dimensions");
 * - **remedies**, which say what to do.
 * The functions at the bottom compose the on-screen message with the name of
 * the plugin or catalog.
 */

const NS = 'sharedProtectionTexts.'

function tx(key: string, params?: Record<string, string | number>): string {
  return t(NS + key, params)
}

/* ---- Remedies ---- */

export const REMEDIES = {
  get pluginAuthor(): string { return tx('remedies.pluginAuthor') },
  get catalogAuthor(): string { return tx('remedies.catalogAuthor') },
  get downloadAgain(): string { return tx('remedies.downloadAgain') },
  get updateStarLight(): string { return tx('remedies.updateStarLight') },
  get reinstallPlugin(): string { return tx('remedies.reinstallPlugin') },
  get reinstallCatalog(): string { return tx('remedies.reinstallCatalog') },
  get reinstallStarLight(): string { return tx('remedies.reinstallStarLight') },
  get retryServer(): string { return tx('remedies.retryServer') },
  get fileChoice(): string { return tx('remedies.fileChoice') },
  get diskSpace(): string { return tx('remedies.diskSpace') },
  get repeatPlugin(): string { return tx('remedies.repeatPlugin') }
} as const

export type Remedy = (typeof REMEDIES)[keyof typeof REMEDIES]

/* ---- ZIP archives ---- */

export const ZIP = {
  get notZip(): string { return tx('zip.notZip') },
  get damaged(): string { return tx('zip.damaged') },
  get password(): string { return tx('zip.password') },
  get unknownCompression(): string { return tx('zip.unknownCompression') },
  get disallowedPaths(): string { return tx('zip.disallowedPaths') },
  get duplicateNames(): string { return tx('zip.duplicateNames') },
  tooManyFiles: (what: string, max: number): string => tx('zip.tooManyFiles', { what, max }),
  tooLarge: (what: string, mb: number): string => tx('zip.tooLarge', { what, mb }),
  fileTooLarge: (name: string, mb: number): string => tx('zip.fileTooLarge', { name, mb }),
  get zipBomb(): string { return tx('zip.zipBomb') },
  archiveTooLarge: (what: string, mb: number): string => tx('zip.archiveTooLarge', { what, mb }),
  multipleManifests: (file: string): string => tx('zip.multipleManifests', { file })
} as const

/* ---- File names and texts ---- */

export const NAMES = {
  reserved: (name: string): string => tx('names.reserved', { name }),
  controlCharacters: (field: string): string => tx('names.controlCharacters', { field })
} as const

/* ---- Plugin installation ---- */

export const PLUGIN = {
  isMissing: {
    get folderManifest(): string { return tx('plugin.isMissing.folderManifest') },
    get archiveManifest(): string { return tx('plugin.isMissing.archiveManifest') },
    get code(): string { return tx('plugin.isMissing.code') },
    image: (name: string): string => tx('plugin.isMissing.image', { name })
  },
  get manifestNotJson(): string { return tx('plugin.manifestNotJson') },
  get manifestNotObject(): string { return tx('plugin.manifestNotObject') },
  manifestTooLarge: (kb: number): string => tx('plugin.manifestTooLarge', { kb }),
  missingField: (name: string): string => tx('plugin.missingField', { name }),
  fieldTooLong: (name: string, max: number): string =>
    tx('plugin.fieldTooLong', { name: name[0].toUpperCase() + name.slice(1), max }),
  invalidId: (id: string): string => tx('plugin.invalidId', { id }),
  get invalidVersion(): string { return tx('plugin.invalidVersion') },
  nonOpenLicense: (license: string): string => tx('plugin.nonOpenLicense', { license }),
  get category(): string { return tx('plugin.category') },
  get icon(): string { return tx('plugin.icon') },
  get missingPreviews(): string { return tx('plugin.missingPreviews') },
  get previews(): string { return tx('plugin.previews') },
  get invalidMinVersion(): string { return tx('plugin.invalidMinVersion') },
  futureMinVersion: (minimum: string, app: string): string => tx('plugin.futureMinVersion', { minimum, app }),
  get site(): string { return tx('plugin.site') },
  get geometry(): string { return tx('plugin.geometry') },
  get paramsNotListed(): string { return tx('plugin.paramsNotListed') },
  tooManyParameters: (max: number): string => tx('plugin.tooManyParameters', { max }),
  duplicateParameter: (id: string): string => tx('plugin.duplicateParameter', { id }),
  translations: {
    get notObject(): string { return tx('plugin.translations.notObject') },
    tooMany: (max: number): string => tx('plugin.translations.tooMany', { max }),
    language: (language: string): string => tx('plugin.translations.language', { language }),
    entry: (language: string): string => tx('plugin.translations.entry', { language }),
    text: (language: string, field: string, max: number): string => tx('plugin.translations.text', { language, field, max }),
    unknownParameter: (language: string, id: string): string => tx('plugin.translations.unknownParameter', { language, id }),
    options: (language: string, id: string): string => tx('plugin.translations.options', { language, id }),
    unknownOption: (language: string, id: string, value: string): string =>
      tx('plugin.translations.unknownOption', { language, id, value })
  },
  parameter: {
    prefix: (n: number): string => tx('plugin.parameter.prefix', { n }),
    get notObject(): string { return tx('plugin.parameter.notObject') },
    get id(): string { return tx('plugin.parameter.id') },
    get label(): string { return tx('plugin.parameter.label') },
    get hint(): string { return tx('plugin.parameter.hint') },
    get minMax(): string { return tx('plugin.parameter.minMax') },
    get step(): string { return tx('plugin.parameter.step') },
    get defaultOutside(): string { return tx('plugin.parameter.defaultOutside') },
    get format(): string { return tx('plugin.parameter.format') },
    get whole(): string { return tx('plugin.parameter.whole') },
    get tooLargeItems(): string { return tx('plugin.parameter.tooLargeItems') },
    get toggle(): string { return tx('plugin.parameter.toggle') },
    get optionCount(): string { return tx('plugin.parameter.optionCount') },
    get option(): string { return tx('plugin.parameter.option') },
    duplicateOption: (value: string): string => tx('plugin.parameter.duplicateOption', { value }),
    get defaultChosen(): string { return tx('plugin.parameter.defaultChosen') },
    type: (type: string): string => tx('plugin.parameter.type', { type })
  },
  codeTooLarge: (mb: number): string => tx('plugin.codeTooLarge', { mb }),
  get codeWithoutProcess(): string { return tx('plugin.codeWithoutProcess') },
  get importCode(): string { return tx('plugin.importCode') },
  get codeNotText(): string { return tx('plugin.codeNotText') },
  imageTooLarge: (name: string, mb: number): string => tx('plugin.imageTooLarge', { name, mb }),
  fakeImage: (name: string): string => tx('plugin.fakeImage', { name }),
  oversizedImage: (name: string, side: number): string => tx('plugin.oversizedImage', { name, side }),
  unreadableFolder: (detail: string): string => tx('plugin.unreadableFolder', { detail }),
  copyFailed: (detail: string): string => tx('plugin.copyFailed', { detail }),
  get notInGallery(): string { return tx('plugin.notInGallery') },
  get unknown(): string { return tx('plugin.unknown') },
  differentFolder: (folder: string, id: string): string => tx('plugin.differentFolder', { folder, id })
} as const

/* ---- Catalog installation ---- */

export const CATALOG = {
  isMissing: {
    get manifest(): string { return tx('catalog.isMissing.manifest') },
    get archiveManifest(): string { return tx('catalog.isMissing.archiveManifest') },
    get objects(): string { return tx('catalog.isMissing.objects') },
    get stars(): string { return tx('catalog.isMissing.stars') },
    get license(): string { return tx('catalog.isMissing.license') }
  },
  get manifestNotJson(): string { return tx('catalog.manifestNotJson') },
  get manifestNotObject(): string { return tx('catalog.manifestNotObject') },
  manifestTooLarge: (kb: number): string => tx('catalog.manifestTooLarge', { kb }),
  get futureFormat(): string { return tx('catalog.futureFormat') },
  get unrecognizedFormat(): string { return tx('catalog.unrecognizedFormat') },
  get invalidTranslations(): string { return tx('catalog.invalidTranslations') },
  invalidNoteLanguages: (max: number): string => tx('catalog.invalidNoteLanguages', { max }),
  missingField: (name: string): string => tx('catalog.missingField', { name }),
  fieldTooLong: (key: string, max: number): string => tx('catalog.fieldTooLong', { key, max }),
  get invalidId(): string { return tx('catalog.invalidId') },
  get invalidVersion(): string { return tx('catalog.invalidVersion') },
  unknownType: (type: string): string => tx('catalog.unknownType', { type }),
  unknownGroup: (group: string): string => tx('catalog.unknownGroup', { group }),
  inconsistentGroup: (group: string): string => tx('catalog.inconsistentGroup', { group }),
  nonOpenLicense: (license: string): string => tx('catalog.nonOpenLicense', { license }),
  get objectCount(): string { return tx('catalog.objectCount') },
  tooManyObjects: (max: number): string => tx('catalog.tooManyObjects', { max: formatNumber(max) }),
  get limitMagnitude(): string { return tx('catalog.limitMagnitude') },
  objectsTooBig: (mb: number): string => tx('catalog.objectsTooBig', { mb }),
  get objectsNotText(): string { return tx('catalog.objectsNotText') },
  get objectsEmpty(): string { return tx('catalog.objectsEmpty') },
  malformedRows: (badOnes: number, totals: number, example: string): string =>
    tx('catalog.malformedRows', { bad: formatNumber(badOnes), total: formatNumber(totals), example }),
  tooManyLines: (max: number): string => tx('catalog.tooManyLines', { max: formatNumber(max) }),
  differentNumber: (readCount: number, declaredList: number): string =>
    tx('catalog.differentNumber', { declared: formatNumber(declaredList), read: formatNumber(readCount) }),
  row: {
    get code(): string { return tx('catalog.row.code') },
    get coordinates(): string { return tx('catalog.row.coordinates') },
    get dimensions(): string { return tx('catalog.row.dimensions') },
    get magnitude(): string { return tx('catalog.row.magnitude') },
    get angle(): string { return tx('catalog.row.angle') },
    get long(): string { return tx('catalog.row.long') },
    get number(): string { return tx('catalog.row.number') }
  },
  starsTooLarge: (mb: number): string => tx('catalog.starsTooLarge', { mb }),
  starsDifferentCount: (readCount: number, declaredList: number): string =>
    tx('catalog.starsDifferentCount', { read: formatNumber(readCount), declared: formatNumber(declaredList) }),
  fainterStars: (foundMatch: number, limit: number): string =>
    tx('catalog.fainterStars', { found: formatNumber(foundMatch), limit: formatNumber(limit) }),
  starsOutsideCell: (count: number): string => tx('catalog.starsOutsideCell', { count: formatNumber(count) }),
  get differentPackage(): string { return tx('catalog.differentPackage') },
  get fingerprint(): string { return tx('catalog.fingerprint') },
  get incomplete(): string { return tx('catalog.incomplete') },
  get largest(): string { return tx('catalog.largest') },
  copyFailed: (detail: string): string => tx('catalog.copyFailed', { detail }),
  get unknown(): string { return tx('catalog.unknown') },
  differentFolder: (folder: string, id: string): string => tx('catalog.differentFolder', { folder, id }),
  unreadableFile: (name: string): string => tx('catalog.unreadableFile', { name })
} as const

/* ---- Star file (stars.bin) ---- */

export const STARS = {
  get shortValue(): string { return tx('stars.shortValue') },
  get signature(): string { return tx('stars.signature') },
  get futureFormat(): string { return tx('stars.futureFormat') },
  get unrecognizedFormat(): string { return tx('stars.unrecognizedFormat') },
  corrupted: (part: string): string => tx('stars.corrupted', { part }),
  get incomplete(): string { return tx('stars.incomplete') },
  get coordinates(): string { return tx('stars.coordinates') }
} as const

/* ---- Plugin execution: reasons ---- */

export const EXECUTION = {
  /**
   * Thrown inside the sandbox when the forbidden environment is used,
   * followed by the name of the forbidden API and by `forbiddenTail`.
   */
  get forbidden(): string { return tx('execution.forbidden') },
  get forbiddenTail(): string { return tx('execution.forbiddenTail') },
  get withoutProcess(): string { return tx('execution.withoutProcess') },
  get noImage(): string { return tx('execution.noImage') },
  get dimensions(): string { return tx('execution.dimensions') },
  get channels(): string { return tx('execution.channels') },
  get dataType(): string { return tx('execution.dataType') },
  get tooLarge(): string { return tx('execution.tooLarge') },
  get length(): string { return tx('execution.length') },
  nonFinite: (count: number, total: number): string =>
    tx('execution.nonFinite', { count: formatNumber(count), total: formatNumber(total) }),
  outOfRange: (value: number): string => tx('execution.outOfRange', { value: formatValue(value) }),
  get withoutTransform(): string { return tx('execution.withoutTransform') },
  get incoherentTransformation(): string { return tx('execution.incoherentTransformation') },
  time: (seconds: number): string => tx('execution.time', { seconds }),
  memory: (mb: number): string =>
    tx('execution.memory', {
      size: mb >= 1024 ? formatNumber(mb / 1024, { maximumFractionDigits: 1 }) + ' GB' : mb + ' MB'
    }),
  get crashed(): string { return tx('execution.crashed') },
  get unreadableResponse(): string { return tx('execution.unreadableResponse') },
  get invalidResponse(): string { return tx('execution.invalidResponse') },
  get startupFailed(): string { return tx('execution.startupFailed') },
  error: (detail: string): string => tx('execution.error', { detail }),
  get codeChanged(): string { return tx('execution.codeChanged') }
} as const

function formatValue(v: number): string {
  return Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : formatNumber(v, { maximumFractionDigits: 3 })
}

/* ---- On-screen messages ---- */

export type ProtectedItem = 'plugin' | 'catalog' | 'stars'

function nameOf(what: ProtectedItem, name: string | null): string {
  const subject = what === 'plugin' ? 'plugin' : what === 'stars' ? 'stars' : 'catalog'
  return name ? tx('subject.' + subject + 'Named', { name }) : tx('subject.' + subject)
}

function merge(...parts: (string | undefined | null)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()).join(' ')
}

/** Installation rejected: who, what is wrong, what to do. */
export function installationRejected(what: ProtectedItem, name: string | null, problems: string[], remedy?: string): string {
  return merge(
    tx('messages.notInstalled', { subject: nameOf(what, name) }),
    problems.length === 1
      ? tx('messages.problemFound', { problem: problems[0] })
      : problems.length > 1
        ? tx('messages.problemsFound', { problems: problems.join(' ') })
        : '',
    remedy
  )
}

/** Enabling a bundled plugin was rejected. */
export function activationRejected(name: string | null, problems: string[], remedy?: string): string {
  return merge(tx('messages.notActivated', { subject: nameOf('plugin', name) }), problems.join(' '), remedy)
}

/** At startup: an installed plugin or catalog fails the checks. */
export function notLoadedMessage(what: ProtectedItem, name: string, problems: string[], remedy: string): string {
  return merge(
    tx('messages.notLoaded', { subject: nameOf(what, name) }),
    tx('messages.problemFound', { problem: problems[0] }),
    remedy,
    tx('messages.galleryButtons')
  )
}

/** At startup, more than one: a single summary notice. */
export function notLoadedSummary(entries: { name: string; problem: string }[]): string {
  return merge(
    tx('messages.notLoadedSummary', { count: entries.length }),
    entries.map((v) => tx('messages.summaryEntry', { name: v.name, problem: v.problem.replace(/\.$/, '') })).join('; ') + '.',
    tx('messages.summaryGallery')
  )
}

/** A plugin stopped during processing: it stays suspended for this session. */
export function pluginStopped(name: string, reason: string): string {
  return merge(
    tx('messages.stopped', { subject: nameOf('plugin', name), reason: reason.replace(/\.$/, '') }),
    tx('messages.stoppedDetail'),
    REMEDIES.repeatPlugin
  )
}

/** The same plugin had already stopped in a previous session. */
export function pluginStoppedAgain(name: string, reason: string, sessions: number): string {
  return merge(
    tx('messages.stopped', { subject: nameOf('plugin', name), reason: reason.replace(/\.$/, '') }),
    tx('messages.stoppedAgainDetail'),
    tx('messages.stoppedAgainSessions', { sessions })
  )
}

/** A plugin suspended in this session, skipped in a later processing run. */
export function suspendedPluginSkipped(name: string): string {
  return tx('messages.suspendedSkipped', { subject: nameOf('plugin', name) })
}

/** An object catalog excluded while being loaded or used. */
export function excludedCatalog(name: string, problem: string): string {
  return merge(
    tx('messages.catalogExcluded', { subject: nameOf('catalog', name), problem: problem.replace(/\.$/, '') }),
    tx('messages.catalogExcludedDetail'),
    REMEDIES.reinstallCatalog
  )
}

/** The star package cannot be read during plate solving. */
export function excludedStars(name: string, problem: string): string {
  return merge(
    tx('messages.starsExcluded', { subject: nameOf('stars', name), problem: problem.replace(/\.$/, '') }),
    tx('messages.starsExcludedDetail'),
    REMEDIES.reinstallCatalog
  )
}

/** Gallery notices, labels and buttons for plugins and catalogs that were not loaded. */
export const GALLERY = {
  get plugin(): string { return tx('gallery.plugin') },
  get catalog(): string { return tx('gallery.catalog') },
  get suspended(): string { return tx('gallery.suspended') },
  get reinstallPluginTitle(): string { return tx('gallery.reinstallPluginTitle') },
  get reinstallCatalogTitle(): string { return tx('gallery.reinstallCatalogTitle') },
  get downloadAgainTitle(): string { return tx('gallery.downloadAgainTitle') },
  get uninstallTitle(): string { return tx('gallery.uninstallTitle') },
  get notLoadedLabel(): string { return tx('gallery.notLoadedLabel') },
  get suspendedLabel(): string { return tx('gallery.suspendedLabel') },
  get notLoadedTitle(): string { return tx('gallery.notLoadedTitle') },
  get actionOpenGallery(): string { return tx('gallery.actionOpenGallery') },
  get actionDisablePlugin(): string { return tx('gallery.actionDisablePlugin') },
  get actionReinstall(): string { return tx('gallery.actionReinstall') },
  get actionDownloadAgain(): string { return tx('gallery.actionDownloadAgain') }
} as const
