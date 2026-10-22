import { join } from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import { PLUGIN, REMEDIES, ZIP } from '@shared/protectionTexts'
import {
  CODE_FILE,
  MANIFEST_FILE,
  MAX_IMAGE_SIDE,
  CODE_LIMIT_BYTES,
  IMAGE_LIMIT_BYTES,
  MANIFEST_LIMIT_BYTES,
  hasControlCharacters,
  isSimpleFileName,
  checkCode,
  checkManifest,
  localizeManifest,
  type PluginManifest
} from '@core/plugin/manifest'
import { readZip, PLUGIN_LIMITS } from './zip'
import { getLanguage, t } from '../shared/i18n/i18n'

/**
 * Inspection of a candidate plugin: every check a plugin must pass, at
 * installation (from a folder or an archive) and at every startup (see
 * plugin.ts), gathered in a module without Electron so the tests
 * (tools/test-protection.ts) can use it as it is.
 *
 * The checks, in order:
 * 1. the `plugin.json` manifest exists, is not huge, is valid JSON and passes
 *    `checkManifest` (fields, license, consistent parameters);
 * 2. `plugin.js` exists, does not exceed 2 MB, is text, exports `processImage`
 *    and imports nothing (`checkCode`);
 * 3. the icon and the previews exist, are real images (judged by content,
 *    not extension) and do not exceed 4 MB or 4096 pixels per side: a PNG
 *    that is small on disk can become huge once decoded;
 * 4. only the expected files are copied, plus license and readme files up
 *    to 512 kB.
 * The error texts live in shared/protectionTexts.ts.
 */

/** Maximum size of a plugin's .zip archive. */
export const PLUGIN_ARCHIVE_LIMIT = 50 * 1024 * 1024
const DOCUMENT_LIMIT = 512 * 1024
const MB = 1024 * 1024

export type PluginInspectionResult =
  | { ok: true; manifest: PluginManifest; toCopy: Map<string, Buffer> }
  | { ok: false; errors: string[]; remedy: string; name?: string }

/** Optional files worth keeping: license and instructions. */
export function documentAllowed(name: string): boolean {
  return /^(licen[sz]e|licenza|copying|readme|leggimi)(\.(md|txt))?$/i.test(name)
}

/** True if the first bytes are those of a PNG, JPEG or WebP file. */
export function realImage(data: Buffer): boolean {
  if (data.length < 12) return false
  const png = data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG'
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
  return png || jpeg || webp
}

/**
 * Width and height stored in the header of a PNG, JPEG or WebP file, without
 * decoding the image; null if they cannot be found.
 */
export function imageDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 30) return null
  if (data[0] === 0x89 && data.toString('ascii', 12, 16) === 'IHDR') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let p = 2
    while (p + 9 < data.length) {
      if (data[p] !== 0xff) return null
      const marker = data[p + 1]
      if (marker === 0xff) {
        p++
        continue
      }
      const length = data.readUInt16BE(p + 2)
      // SOF0…SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(p + 5), width: data.readUInt16BE(p + 7) }
      }
      if (length < 2) return null
      p += 2 + length
    }
    return null
  }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const type = data.toString('ascii', 12, 16)
    if (type === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
    if (type === 'VP8L') {
      const b = data.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 }
    }
    if (type === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
  }
  return null
}

/**
 * The name declared in the manifest, if readable, for the messages: in the
 * current language if the manifest translates it, otherwise the main one.
 */
function declaredName(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined
  const g = json as Record<string, unknown>
  const translations = g['translations']
  const language = getLanguage()
  const own = (v: unknown, key: string): unknown =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined
  const translated = own(own(translations, language) ?? own(translations, language.split('-')[0]), 'name')
  const n = typeof translated === 'string' && translated.trim() !== '' ? translated : g['name']
  return typeof n === 'string' && n.trim() !== '' && !hasControlCharacters(n) ? n.trim().slice(0, 60) : undefined
}

/**
 * Checks a set of files (name → contents) that is a candidate plugin.
 * Returns the manifest and only the files to copy, or the errors to show
 * together with the remedy.
 */
export function inspectPlugin(file: Map<string, Buffer>, appVersion: string, fromArchive = false): PluginInspectionResult {
  const raw = file.get(MANIFEST_FILE)
  if (!raw) {
    return {
      ok: false,
      errors: [fromArchive ? PLUGIN.isMissing.archiveManifest : PLUGIN.isMissing.folderManifest],
      remedy: REMEDIES.fileChoice
    }
  }
  if (raw.length > MANIFEST_LIMIT_BYTES) {
    return { ok: false, errors: [PLUGIN.manifestTooLarge(MANIFEST_LIMIT_BYTES / 1024)], remedy: REMEDIES.pluginAuthor }
  }
  let json: unknown
  try {
    json = JSON.parse(raw.toString('utf-8').replace(/^﻿/, ''))
  } catch {
    return { ok: false, errors: [PLUGIN.manifestNotJson], remedy: REMEDIES.pluginAuthor }
  }
  const name = declaredName(json)
  const result = checkManifest(json, appVersion)
  if (!result.ok) return { ok: false, errors: result.errors, remedy: result.remedy ?? REMEDIES.pluginAuthor, name }
  const m = result.manifest
  const errors: string[] = []

  const code = file.get(CODE_FILE)
  if (!code) errors.push(PLUGIN.isMissing.code)
  else if (code.length > CODE_LIMIT_BYTES) errors.push(PLUGIN.codeTooLarge(CODE_LIMIT_BYTES / MB))
  else errors.push(...checkCode(code.toString('utf-8')))

  const toCopy = new Map<string, Buffer>()
  if (code) toCopy.set(CODE_FILE, code)
  toCopy.set(MANIFEST_FILE, raw)
  for (const fileName of new Set([m.icon, m.previews.before, m.previews.after])) {
    const data = file.get(fileName)
    if (!data) errors.push(PLUGIN.isMissing.image(fileName))
    else if (data.length > IMAGE_LIMIT_BYTES) errors.push(PLUGIN.imageTooLarge(fileName, IMAGE_LIMIT_BYTES / MB))
    else if (!realImage(data)) errors.push(PLUGIN.fakeImage(fileName))
    else {
      const measurements = imageDimensions(data)
      if (
        !measurements ||
        measurements.width < 1 ||
        measurements.height < 1 ||
        measurements.width > MAX_IMAGE_SIDE ||
        measurements.height > MAX_IMAGE_SIDE
      ) {
        errors.push(PLUGIN.oversizedImage(fileName, MAX_IMAGE_SIDE))
      } else toCopy.set(fileName, data)
    }
  }
  for (const [fileName, data] of file) {
    if (documentAllowed(fileName) && data.length <= DOCUMENT_LIMIT) toCopy.set(fileName, data)
  }
  if (errors.length > 0) return { ok: false, errors, remedy: REMEDIES.pluginAuthor, name: localizeManifest(m, getLanguage()).name }
  return { ok: true, manifest: m, toCopy }
}

/**
 * Reads from a folder only the top-level files a plugin needs (no subfolders
 * or links): the manifest, the code, the images named by the manifest, the
 * license and readme. Choosing the photo folder by mistake does not fill
 * memory: other files are never opened. A file over its limit is not read:
 * a placeholder one byte longer than the limit takes its place, so the
 * inspection reports it as too large.
 */
export async function readPluginFolder(folder: string): Promise<Map<string, Buffer>> {
  const file = new Map<string, Buffer>()
  const entries = (await readdir(folder, { withFileTypes: true })).filter((v) => v.isFile() && isSimpleFileName(v.name))
  const names = new Set(entries.map((v) => v.name))
  const read = async (name: string, limit: number): Promise<void> => {
    if (!names.has(name) || file.has(name)) return
    const path = join(folder, name)
    const info = await stat(path)
    file.set(name, info.size > limit ? Buffer.alloc(limit + 1) : await readFile(path))
  }
  await read(MANIFEST_FILE, MANIFEST_LIMIT_BYTES)
  await read(CODE_FILE, CODE_LIMIT_BYTES)
  // The images to read are the ones named by the manifest, if it is readable.
  const manifest = file.get(MANIFEST_FILE)
  if (manifest && manifest.length <= MANIFEST_LIMIT_BYTES) {
    try {
      const parsed: unknown = JSON.parse(manifest.toString('utf-8').replace(/^﻿/, ''))
      const g: Record<string, unknown> = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
      const previews = g['previews']
      const a = typeof previews === 'object' && previews !== null ? (previews as Record<string, unknown>) : {}
      for (const n of [g['icon'], a['before'], a['after']]) {
        if (typeof n === 'string' && isSimpleFileName(n)) await read(n, IMAGE_LIMIT_BYTES)
      }
    } catch {
      // Unreadable manifest: the inspection will report it.
    }
  }
  for (const v of entries) if (documentAllowed(v.name)) await read(v.name, DOCUMENT_LIMIT)
  return file
}

/**
 * From a ZIP archive: the plugin can sit at the root of the archive or inside
 * a single folder within it (as happens when the folder itself is zipped).
 */
export function fileFromPluginZip(archive: Buffer): Map<string, Buffer> {
  if (archive.length > PLUGIN_ARCHIVE_LIMIT) {
    throw new Error(ZIP.archiveTooLarge(t('mainZip.whatPlugin'), PLUGIN_ARCHIVE_LIMIT / MB))
  }
  const entries = readZip(archive, PLUGIN_LIMITS)
  const manifests = entries.filter((v) => v.name === MANIFEST_FILE || /^[^/]+\/plugin\.json$/.test(v.name))
  if (manifests.length === 0) throw new Error(PLUGIN.isMissing.archiveManifest)
  // An archive containing several plugins: which one to install cannot be guessed.
  if (manifests.length > 1) throw new Error(ZIP.multipleManifests(MANIFEST_FILE))
  const manifest = manifests[0]
  const prefix = manifest.name.slice(0, manifest.name.length - MANIFEST_FILE.length)
  const file = new Map<string, Buffer>()
  for (const v of entries) {
    if (!v.name.startsWith(prefix)) continue
    const name = v.name.slice(prefix.length)
    if (name.includes('/') || !isSimpleFileName(name)) continue
    file.set(name, v.data)
  }
  return file
}
