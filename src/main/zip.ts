import { inflateRawSync } from 'node:zlib'
import { ZIP } from '@shared/protectionTexts'
import { t } from '../shared/i18n/i18n'

/**
 * Reader for the ZIP archives used to distribute plugins.
 *
 * Only the minimum is supported: entries stored as they are or compressed
 * with the most common method (deflate), without encryption and without the
 * ZIP64 extension for archives over 4 GB. Everything happens in memory and
 * nothing is written to disk: the files are then checked one by one before
 * installation.
 *
 * Conservative limits guard against archives crafted to cause harm: few
 * files, a bounded total size (declared and verified), no path leaving the
 * folder, no decompression bombs, no repeated entry with different contents.
 * The error texts live in shared/protectionTexts.ts.
 */

const MAX_FILE = 200
const MAX_TOTAL = 40 * 1024 * 1024

/**
 * Above this ratio between extracted and compressed size an entry is not
 * real data but a decompression bomb: a few bytes crafted to expand
 * enormously. Deflate peaks at roughly 1000:1, and no plugin or catalog
 * file comes anywhere near that.
 */
const BOMB_RATIO = 500

export interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string
  data: Buffer
}

/** Archive limits: plugins have their own, catalogs are larger. */
export interface ZipLimits {
  file: number
  total: number
  /** Word used in the messages ("a plugin", "a catalog"); read only when a message is built. */
  what: string
  /** Maximum size of a single extracted file, when different from the total. */
  perFile?: number
}

export const PLUGIN_LIMITS: ZipLimits = {
  file: MAX_FILE,
  total: MAX_TOTAL,
  get what() {
    return t('mainZip.whatPlugin')
  }
}

const MB = 1024 * 1024

export function readZip(archive: Buffer, limits: ZipLimits = PLUGIN_LIMITS): ZipEntry[] {
  // The end of central directory record lies within the last 64 kB (plus the comment).
  if (archive.length < 22) throw new Error(ZIP.notZip)
  const minimum = Math.max(0, archive.length - 65557)
  let end = -1
  for (let i = archive.length - 22; i >= minimum; i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error(ZIP.notZip)

  const entries = archive.readUInt16LE(end + 10)
  let position = archive.readUInt32LE(end + 16)
  // 0xffff and 0xffffffff signal the ZIP64 extension for huge archives, which is not supported.
  if (entries === 0xffff || position === 0xffffffff) throw new Error(ZIP.archiveTooLarge(limits.what, Math.round(limits.total / MB)))
  if (entries > limits.file) throw new Error(ZIP.tooManyFiles(limits.what, limits.file))
  if (position > end) throw new Error(ZIP.damaged)

  const result: ZipEntry[] = []
  const seenItems = new Map<string, Buffer>()
  let total = 0
  for (let v = 0; v < entries; v++) {
    if (position + 46 > archive.length || archive.readUInt32LE(position) !== 0x02014b50) {
      throw new Error(ZIP.damaged)
    }
    const options = archive.readUInt16LE(position + 8)
    const method = archive.readUInt16LE(position + 10)
    const compressed = archive.readUInt32LE(position + 20)
    const full = archive.readUInt32LE(position + 24)
    const nameLength = archive.readUInt16LE(position + 28)
    const extraLength = archive.readUInt16LE(position + 30)
    const commentLength = archive.readUInt16LE(position + 32)
    const locale = archive.readUInt32LE(position + 42)
    if (position + 46 + nameLength > archive.length) throw new Error(ZIP.damaged)
    const name = archive.toString('utf8', position + 46, position + 46 + nameLength).replace(/\\/g, '/')
    position += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue // folder
    if (options & 1) throw new Error(ZIP.password)
    if (compressed === 0xffffffff || full === 0xffffffff) throw new Error(ZIP.archiveTooLarge(limits.what, Math.round(limits.total / MB)))
    if (
      name.startsWith('/') ||
      /^[a-zA-Z]:/.test(name) ||
      name.split('/').some((p) => p === '..' || p === '.') ||
      name.includes('\u0000')
    ) {
      throw new Error(ZIP.disallowedPaths)
    }
    if (limits.perFile !== undefined && full > limits.perFile) {
      throw new Error(ZIP.fileTooLarge(name.split('/').pop() ?? name, Math.round(limits.perFile / MB)))
    }
    total += full
    if (total > limits.total) throw new Error(ZIP.tooLarge(limits.what, Math.round(limits.total / MB)))
    if (full > MB && full > Math.max(1, compressed) * BOMB_RATIO) throw new Error(ZIP.zipBomb)

    if (locale + 30 > archive.length || archive.readUInt32LE(locale) !== 0x04034b50) {
      throw new Error(ZIP.damaged)
    }
    const start = locale + 30 + archive.readUInt16LE(locale + 26) + archive.readUInt16LE(locale + 28)
    if (start + compressed > archive.length) throw new Error(ZIP.damaged)
    const compressedBytes = archive.subarray(start, start + compressed)
    let data: Buffer
    if (method === 0) data = Buffer.from(compressedBytes)
    else if (method === 8) {
      try {
        // Never more than declared: an entry that lies about its size stops
        // here instead of filling memory.
        data = inflateRawSync(compressedBytes, { maxOutputLength: Math.max(1, full) })
      } catch (e) {
        const code = (e as { code?: string }).code
        throw new Error(code === 'ERR_BUFFER_TOO_LARGE' ? ZIP.zipBomb : ZIP.damaged)
      }
    } else throw new Error(ZIP.unknownCompression)
    if (data.length !== full) throw new Error(ZIP.damaged)
    // Two entries with the same name (even differing only in case, which is
    // the same file on Windows) are accepted only if identical.
    const key = name.toLowerCase()
    const already = seenItems.get(key)
    if (already) {
      if (!already.equals(data)) throw new Error(ZIP.duplicateNames)
      continue
    }
    seenItems.set(key, data)
    result.push({ name, data })
  }
  return result
}
