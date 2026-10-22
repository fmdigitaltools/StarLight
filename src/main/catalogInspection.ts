import { join } from 'node:path'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { CATALOG, REMEDIES, ZIP } from '@shared/protectionTexts'
import {
  CATALOG_MANIFEST_FILE,
  OBJECTS_FILE,
  CATALOG_MANIFEST_LIMIT_BYTES,
  OBJECTS_LIMIT_BYTES,
  PACKAGE_LIMIT_BYTES,
  STARS_LIMIT_BYTES,
  analyzeCatalogObjects,
  catalogName,
  checkCatalogManifest,
  type CatalogManifest
} from '@core/catalog/package'
import { hasControlCharacters, isSimpleFileName } from '@core/plugin/manifest'
import {
  STARS_HEADER_BYTES,
  STARS_FILE,
  headerBytes,
  readStarsIndex,
  readStarsHeader,
  checkStarFile
} from '@core/astrometry/localStars'
import { readZip, type ZipLimits } from './zip'
import { t } from '../shared/i18n/i18n'

/**
 * Inspection of catalog packages: the checks a catalog must pass when it is
 * installed (downloaded from the server or chosen from disk) and the quicker
 * ones repeated at every startup on catalogs already installed. It does not
 * depend on Electron, so the tests (tools/test-protection.ts) can use it as
 * it is.
 *
 * At installation, in order:
 * 1. the archive passes the readZip checks (see zip.ts) with the catalog
 *    limits: 20 files, 300 MB extracted, objects.tsv up to 48 MB and
 *    stars.bin up to 256 MB;
 * 2. `catalog.json` exists, is not huge, is valid JSON and passes
 *    `checkCatalogManifest` (format, open license, group, numbers);
 * 3. for an object catalog, `objects.tsv` passes `analyzeCatalogObjects`
 *    (readable rows, allowed values, share of bad rows, count consistent
 *    with the manifest);
 * 4. for a star package, `stars.bin` passes `checkStarFile` (index, length,
 *    count, limiting magnitude, cells);
 * 5. the data license text is present.
 * The error texts live in shared/protectionTexts.ts.
 */

export const CATALOG_ZIP_LIMITS: ZipLimits = {
  file: 20,
  total: 300 * 1024 * 1024,
  perFile: STARS_LIMIT_BYTES,
  get what() {
    return t('mainCatalogInspection.whatCatalog')
  }
}

const DOCUMENT_LIMIT = 1024 * 1024
const MB = 1024 * 1024

export type CatalogInspectionResult =
  | { ok: true; manifest: CatalogManifest; toCopy: Map<string, Buffer> }
  | { ok: false; errors: string[]; remedy: string; name?: string }

export function catalogDocumentAllowed(name: string): boolean {
  return /^(license|attribution|credits|readme)(\.(md|txt))?$/i.test(name)
}

function declaredName(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const n = (json as Record<string, unknown>)['name']
  return typeof n === 'string' && n.trim() !== '' && !hasControlCharacters(n) ? n.trim().slice(0, 80) : undefined
}

/** Reads and checks the manifest; on failure returns the errors and the remedy. */
function readManifest(
  raw: Buffer | undefined,
  fromDisk: boolean
): { ok: true; manifest: CatalogManifest } | { ok: false; errors: string[]; remedy: string; name?: string } {
  if (!raw) return { ok: false, errors: [CATALOG.isMissing.manifest], remedy: fromDisk ? REMEDIES.reinstallCatalog : REMEDIES.fileChoice }
  if (raw.length > CATALOG_MANIFEST_LIMIT_BYTES) {
    return { ok: false, errors: [CATALOG.manifestTooLarge(CATALOG_MANIFEST_LIMIT_BYTES / 1024)], remedy: REMEDIES.catalogAuthor }
  }
  let json: unknown
  try {
    json = JSON.parse(raw.toString('utf-8').replace(/^﻿/, ''))
  } catch {
    return { ok: false, errors: [CATALOG.manifestNotJson], remedy: REMEDIES.catalogAuthor }
  }
  const result = checkCatalogManifest(json)
  if (!result.ok) return { ok: false, errors: result.errors, remedy: result.remedy ?? REMEDIES.catalogAuthor, name: declaredName(json) }
  return result
}

/** Checks the files of a package; returns the manifest and what to copy. */
export function inspectCatalog(file: Map<string, Buffer>, downloaded = false): CatalogInspectionResult {
  const m = readManifest(file.get(CATALOG_MANIFEST_FILE), false)
  if (!m.ok) return m
  const manifest = m.manifest
  const remedy = downloaded ? REMEDIES.retryServer : REMEDIES.catalogAuthor
  const reject = (errors: string[]): CatalogInspectionResult => ({ ok: false, errors, remedy, name: catalogName(manifest) })
  const toCopy = new Map<string, Buffer>([[CATALOG_MANIFEST_FILE, file.get(CATALOG_MANIFEST_FILE)!]])
  if (manifest.type === 'stars') {
    const stars = file.get(STARS_FILE)
    if (!stars) return reject([CATALOG.isMissing.stars])
    if (stars.length > STARS_LIMIT_BYTES) return reject([CATALOG.starsTooLarge(STARS_LIMIT_BYTES / MB)])
    const problems = checkStarFile(stars, manifest.objects, manifest.limitMagnitude ?? 0)
    if (problems.length > 0) return reject(problems)
    toCopy.set(STARS_FILE, stars)
  } else {
    const tsv = file.get(OBJECTS_FILE)
    if (!tsv) return reject([CATALOG.isMissing.objects])
    if (tsv.length > OBJECTS_LIMIT_BYTES) return reject([CATALOG.objectsTooBig(OBJECTS_LIMIT_BYTES / MB)])
    const analysis = analyzeCatalogObjects(tsv.toString('utf-8'), manifest)
    if (analysis.errors.length > 0) return reject(analysis.errors)
    toCopy.set(OBJECTS_FILE, tsv)
  }
  let license = false
  for (const [name, data] of file) {
    if (!catalogDocumentAllowed(name) || data.length > DOCUMENT_LIMIT) continue
    toCopy.set(name, data)
    if (/^licen/i.test(name)) license = true
  }
  if (!license) return reject([CATALOG.isMissing.license])
  return { ok: true, manifest, toCopy }
}

/**
 * Opens a package: the catalog can sit at the root of the archive or inside
 * a single folder within it.
 */
export function fileFromCatalogZip(archive: Buffer): Map<string, Buffer> {
  if (archive.length > PACKAGE_LIMIT_BYTES) throw new Error(ZIP.archiveTooLarge(t('mainCatalogInspection.whatCatalog'), PACKAGE_LIMIT_BYTES / MB))
  const entries = readZip(archive, CATALOG_ZIP_LIMITS)
  const manifests = entries.filter((v) => v.name === CATALOG_MANIFEST_FILE || /^[^/]+\/catalog\.json$/.test(v.name))
  if (manifests.length === 0) throw new Error(CATALOG.isMissing.archiveManifest)
  if (manifests.length > 1) throw new Error(ZIP.multipleManifests(CATALOG_MANIFEST_FILE))
  const prefix = manifests[0].name.slice(0, manifests[0].name.length - CATALOG_MANIFEST_FILE.length)
  const file = new Map<string, Buffer>()
  for (const v of entries) {
    if (!v.name.startsWith(prefix)) continue
    const name = v.name.slice(prefix.length)
    if (name.includes('/') || !isSimpleFileName(name)) continue
    file.set(name, v.data)
  }
  return file
}

/** Result of rechecking an installed catalog. */
export type RecheckResult =
  | { ok: true; manifest: CatalogManifest; byte: number }
  | { ok: false; errors: string[]; remedy: string; name?: string; manifest?: CatalogManifest; byte: number }

/**
 * Quick recheck of an installed catalog, at every startup: the manifest, the
 * folder named after the id, the license, and the data file present and
 * within the limits. For stars the index is also read and compared with the
 * file length (a few kB), not all the stars. The contents of objects.tsv are
 * rechecked by the interface while it reads them (analyzeCatalogObjects).
 */
export async function recheckCatalog(folder: string, folderName: string): Promise<RecheckResult> {
  let byte = 0
  const names: string[] = []
  try {
    for (const v of await readdir(folder, { withFileTypes: true })) {
      if (!v.isFile()) continue
      names.push(v.name)
      byte += (await stat(join(folder, v.name))).size
    }
  } catch {
    return { ok: false, errors: [CATALOG.unreadableFile(folderName)], remedy: REMEDIES.reinstallCatalog, byte }
  }
  let raw: Buffer | undefined
  if (names.includes(CATALOG_MANIFEST_FILE)) {
    const path = join(folder, CATALOG_MANIFEST_FILE)
    raw = (await stat(path)).size > CATALOG_MANIFEST_LIMIT_BYTES ? Buffer.alloc(CATALOG_MANIFEST_LIMIT_BYTES + 1) : await readFile(path)
  }
  const m = readManifest(raw, true)
  if (!m.ok) return { ...m, remedy: m.remedy === REMEDIES.updateStarLight ? m.remedy : REMEDIES.reinstallCatalog, byte }
  const manifest = m.manifest
  const discard = (errors: string[], remedy: string = REMEDIES.reinstallCatalog): RecheckResult => ({
    ok: false,
    errors,
    remedy,
    name: catalogName(manifest),
    manifest,
    byte
  })
  if (manifest.id !== folderName) return discard([CATALOG.differentFolder(folderName, manifest.id)])
  if (!names.some((n) => /^licen/i.test(n) && catalogDocumentAllowed(n))) return discard([CATALOG.isMissing.license])
  if (manifest.type === 'stars') {
    if (!names.includes(STARS_FILE)) return discard([CATALOG.isMissing.stars])
    const path = join(folder, STARS_FILE)
    const length = (await stat(path)).size
    if (length > STARS_LIMIT_BYTES) return discard([CATALOG.starsTooLarge(STARS_LIMIT_BYTES / MB)])
    const handle = await open(path, 'r')
    try {
      const read = async (n: number): Promise<Buffer> => {
        const b = Buffer.alloc(n)
        const { bytesRead } = await handle.read(b, 0, n, 0)
        return b.subarray(0, bytesRead)
      }
      const { cells } = readStarsHeader(await read(STARS_HEADER_BYTES))
      const index = readStarsIndex(await read(headerBytes(cells)), length)
      if (index.stars !== manifest.objects) return discard([CATALOG.starsDifferentCount(index.stars, manifest.objects)])
    } catch (e) {
      return discard([e instanceof Error ? e.message : String(e)])
    } finally {
      await handle.close().catch(() => undefined)
    }
  } else {
    if (!names.includes(OBJECTS_FILE)) return discard([CATALOG.isMissing.objects])
    if ((await stat(join(folder, OBJECTS_FILE))).size > OBJECTS_LIMIT_BYTES) {
      return discard([CATALOG.objectsTooBig(OBJECTS_LIMIT_BYTES / MB)])
    }
  }
  return { ok: true, manifest, byte }
}
