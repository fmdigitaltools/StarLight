import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { WatcherEvent, WatcherStartResult, WatchMode } from '@shared/watcher'
import { hasRawExtension, detectRaw } from '@core/raw/rawFormats'
import { t } from '../shared/i18n/i18n'

/*
 * Watched folder.
 *
 * During a capture session the instrument saves one frame after another to
 * a folder, local or on the network. This module watches it and notifies
 * the interface once per file, and only when the file is complete: reading
 * it while it is still being written would give a truncated frame.
 *
 * Two ways of noticing new files work together:
 * - operating system notifications (fs.watch), immediate;
 * - a periodic scan of the file list, which never misses an arrival. It is
 *   needed because on network shares (SMB, such as a telescope's) the
 *   notifications arrive late, sometimes never, and if the connection drops
 *   the system watcher stops silently.
 *
 * A file is considered complete when three conditions hold together:
 * 1. size and modification time have been steady for a while;
 * 2. the file opens for reading (on Windows the writer often locks it);
 * 3. its FITS header is readable and the declared data length is entirely
 *    present on disk.
 * If a condition fails the file stays pending and is checked again. Only if
 * it stays steady and incomplete for a long time is it reported.
 */

/**
 * Extensions recognized as frames: FITS (including compressed .fz and
 * .fits.gz) and XISF. Not TIFF and PNG: in capture folders they are usually
 * previews.
 */
const FITS_FILE_EXTENSIONS = ['.fit', '.fits', '.fts', '.fz', '.fit.gz', '.fits.gz', '.fts.gz', '.xisf']

function isFits(name: string): boolean {
  const lowercased = name.toLowerCase()
  // Camera RAW files too (tethered shooting).
  return FITS_FILE_EXTENSIONS.some((e) => lowercased.endsWith(e)) || hasRawExtension(name)
}

/**
 * A camera RAW file has no declared length to check: a steady size and an
 * openable file (conditions 1 and 2) are enough, plus the format signature
 * in the first bytes.
 */
async function checkRaw(path: string): Promise<CheckResult> {
  const file = await open(path, 'r')
  try {
    const head = Buffer.alloc(16)
    const { bytesRead } = await file.read(head, 0, 16, 0)
    if (bytesRead < 16) return 'incomplete'
    return detectRaw(new Uint8Array(head), basename(path)) !== null
      ? 'complete'
      : { unreadable: t('mainWatcher.reasons.notRaw') }
  } finally {
    await file.close()
  }
}

/**
 * Checks for formats other than uncompressed FITS.
 * - XISF: the XML header says where the data blocks are
 *   (location="attachment:position:length"); the file is complete when the
 *   whole header and the last byte of the last block are present.
 * - Gzip-compressed FITS: the length is not declared in the header; after
 *   the signature, a steady size and an openable file are enough, as for RAW.
 * Returns null if the file is not one of these formats (FITS checks follow).
 */
async function checkOtherFormats(path: string, size: number): Promise<CheckResult | null> {
  const file = await open(path, 'r')
  try {
    const head = Buffer.alloc(16)
    const { bytesRead } = await file.read(head, 0, 16, 0)
    if (bytesRead < 16) return 'incomplete'
    if (head[0] === 0x1f && head[1] === 0x8b) return 'complete'
    if (head.toString('latin1', 0, 8) !== 'XISF0100') return null
    const length = head.readUInt32LE(8)
    if (16 + length > size) return 'incomplete'
    const xml = Buffer.alloc(length)
    await file.read(xml, 0, length, 16)
    let end = 16 + length
    for (const m of xml.toString('utf8').matchAll(/location="attachment:(\d+):(\d+)/g)) {
      end = Math.max(end, Number(m[1]) + Number(m[2]))
    }
    return end <= size ? 'complete' : 'incomplete'
  } finally {
    await file.close()
  }
}

export interface WatcherOptions {
  /** How long size and time must stay steady, in milliseconds. */
  stabilityMs?: number
  /** How often the file list is rescanned, in milliseconds. */
  scanIntervalMs?: number
  /** How often pending files are checked again, in milliseconds. */
  checkIntervalMs?: number
  /** After how long a steady but incomplete file is reported as unreadable. */
  maxWaitMs?: number
  /** If true, files already present at start are reported too. */
  includeExisting?: boolean
  /** Skips system notifications and uses only the periodic scan. */
  onlyScan?: boolean
}

interface PendingFile {
  size: number
  modified: number
  /** Last moment the size or time changed. */
  idleSince: number
}

/** FITS block size: header and data are multiples of this size. */
const BLOCK = 2880
/** Beyond this number of blocks a FITS header is not plausible. */
const MAX_HEADER_BLOCKS = 200

type CheckResult = 'complete' | 'incomplete' | { unreadable: string }

/**
 * Checks that the file contains in full what its header declares. It walks
 * all the HDUs present: compressed .fz files have an empty primary HDU and
 * the data in the next one.
 */
async function checkFits(path: string, size: number): Promise<CheckResult> {
  const file = await open(path, 'r')
  try {
    let position = 0
    let sectionsWithData = 0
    while (position < size) {
      // Reads the header one block at a time up to the END card.
      const cards = new Map<string, string>()
      let end = false
      let blocks = 0
      while (!end) {
        if (blocks >= MAX_HEADER_BLOCKS) return { unreadable: t('mainWatcher.reasons.headerNoEnd') }
        if (position + BLOCK > size) return 'incomplete'
        const block = Buffer.alloc(BLOCK)
        const { bytesRead } = await file.read(block, 0, BLOCK, position)
        if (bytesRead < BLOCK) return 'incomplete'
        position += BLOCK
        blocks++
        for (let i = 0; i < BLOCK; i += 80) {
          const card = block.toString('latin1', i, i + 80)
          const key = card.slice(0, 8).trim()
          if (key === 'END') {
            end = true
            break
          }
          if (card[8] === '=') cards.set(key, card.slice(10).split('/')[0].trim())
        }
        if (blocks === 1 && position === BLOCK && sectionsWithData === 0 && !cards.has('SIMPLE')) {
          return { unreadable: t('mainWatcher.reasons.notFits') }
        }
      }

      const bitpix = Math.abs(Number(cards.get('BITPIX') ?? 0))
      const axes = Number(cards.get('NAXIS') ?? 0)
      let elements = axes > 0 ? 1 : 0
      for (let a = 1; a <= axes; a++) elements *= Number(cards.get('NAXIS' + a) ?? 0)
      const pcount = Number(cards.get('PCOUNT') ?? 0)
      const gcount = Number(cards.get('GCOUNT') ?? 1)
      const dataBytes = axes > 0 ? (bitpix / 8) * gcount * (pcount + elements) : 0
      if (!Number.isFinite(dataBytes) || dataBytes < 0) return { unreadable: t('mainWatcher.reasons.invalidHeader') }

      // Some programs do not pad the last block: it is enough that all the
      // declared data is present.
      if (position + dataBytes > size) return 'incomplete'
      if (dataBytes > 0) sectionsWithData++
      position += Math.ceil(dataBytes / BLOCK) * BLOCK
    }
    return sectionsWithData > 0 ? 'complete' : 'incomplete'
  } finally {
    await file.close()
  }
}

/**
 * Watches a folder and calls `notify` for every complete frame. It does not
 * depend on Electron, so it can be tested with a plain script.
 */
export class Watcher {
  private watcher: FSWatcher | null = null
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private checkTimer: ReturnType<typeof setInterval> | null = null
  private pending = new Map<string, PendingFile>()
  /** Files already reported, with the size they had at the time. */
  private reportedItems = new Map<string, number>()
  private reachable = true
  private scanInProgress = false
  private checkInProgress = false
  private stopped = false
  private latestArrivals = ''
  private mode: WatchMode = 'polling'

  private readonly stabilityMs: number
  private readonly scanIntervalMs: number
  private readonly checkIntervalMs: number
  private readonly maxWaitMs: number

  constructor(
    readonly folder: string,
    private readonly notify: (event: WatcherEvent) => void,
    private readonly options: WatcherOptions = {}
  ) {
    this.stabilityMs = options.stabilityMs ?? 1500
    this.scanIntervalMs = options.scanIntervalMs ?? 2000
    this.checkIntervalMs = options.checkIntervalMs ?? 500
    this.maxWaitMs = options.maxWaitMs ?? 120000
  }

  /** Starts watching. Fails if the folder cannot be reached. */
  async start(): Promise<WatcherStartResult> {
    try {
      const info = await stat(this.folder)
      if (!info.isDirectory()) return { ok: false, message: t('mainWatcher.errors.notFolder') }
    } catch (e) {
      return { ok: false, message: explainError(e) }
    }

    // Files already present: if they are not to be included, mark them as seen.
    if (this.options.includeExisting === false) {
      try {
        for (const entry of await readdir(this.folder, { withFileTypes: true })) {
          if (entry.isFile() && isFits(entry.name)) this.reportedItems.set(join(this.folder, entry.name), -1)
        }
      } catch (e) {
        return { ok: false, message: explainError(e) }
      }
    }

    this.mode = 'polling'
    if (!this.options.onlyScan) {
      try {
        this.watcher = watch(this.folder, { persistent: false }, (_type, name) => {
          if (name && isFits(name.toString())) this.annotate(join(this.folder, name.toString()))
        })
        // If the system watcher fails (network down), the periodic scan
        // remains and carries on by itself.
        this.watcher.on('error', () => {
          this.watcher?.close()
          this.watcher = null
          this.mode = 'polling'
        })
        this.mode = 'events'
      } catch {
        this.watcher = null
      }
    }

    void this.scan()
    this.scanTimer = setInterval(() => void this.scan(), this.scanIntervalMs)
    this.checkTimer = setInterval(() => void this.check(), this.checkIntervalMs)
    return { ok: true, mode: this.mode }
  }

  /** Stops everything. Can be called more than once. */
  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    if (this.scanTimer) clearInterval(this.scanTimer)
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.scanTimer = null
    this.checkTimer = null
    this.pending.clear()
  }

  /** Records a file that appeared or changed. */
  private annotate(path: string): void {
    if (this.stopped || this.pending.has(path)) return
    if (this.reportedItems.has(path)) return
    this.pending.set(path, { size: -1, modified: -1, idleSince: Date.now() })
  }

  /** Rescans the folder listing. */
  private async scan(): Promise<void> {
    if (this.scanInProgress || this.stopped) return
    this.scanInProgress = true
    try {
      const entries = await readdir(this.folder, { withFileTypes: true })
      if (!this.reachable) {
        this.reachable = true
        this.notify({ type: 'reachable', reachable: true, message: t('mainWatcher.reachableAgain') })
      }
      for (const entry of entries) {
        // On network shares some servers do not report the entry type: the
        // following check excludes folders anyway.
        if ((entry.isFile() || entry.isSymbolicLink()) && isFits(entry.name)) {
          this.annotate(join(this.folder, entry.name))
        }
      }
    } catch (e) {
      if (this.reachable && !this.stopped) {
        this.reachable = false
        this.notify({
          type: 'reachable',
          reachable: false,
          message: t('mainWatcher.unreachableRetrying', { error: explainError(e) })
        })
      }
    } finally {
      this.scanInProgress = false
    }
  }

  /** Checks pending files again and reports the complete ones. */
  private async check(): Promise<void> {
    if (this.checkInProgress || this.stopped) return
    this.checkInProgress = true
    try {
      for (const [path, entry] of [...this.pending]) {
        if (this.stopped) return
        await this.checkFile(path, entry)
      }
      const names = [...this.pending.keys()].map((p) => basename(p)).sort()
      const key = names.join('\n')
      if (key !== this.latestArrivals && !this.stopped) {
        this.latestArrivals = key
        this.notify({ type: 'incoming', fileNames: names })
      }
    } finally {
      this.checkInProgress = false
    }
  }

  private async checkFile(path: string, entry: PendingFile): Promise<void> {
    const now = Date.now()
    let info
    try {
      info = await stat(path)
    } catch {
      // Gone (renamed or deleted by the writer): nothing to report.
      this.pending.delete(path)
      return
    }
    if (!info.isFile()) {
      this.pending.delete(path)
      return
    }

    if (info.size !== entry.size || info.mtimeMs !== entry.modified) {
      entry.size = info.size
      entry.modified = info.mtimeMs
      entry.idleSince = now
      return
    }
    if (now - entry.idleSince < this.stabilityMs || info.size === 0) return

    let result: CheckResult
    try {
      result = hasRawExtension(path)
        ? await checkRaw(path)
        : ((await checkOtherFormats(path, info.size)) ?? (await checkFits(path, info.size)))
    } catch {
      // Cannot be opened: usually the writer still holds a lock on it.
      result = 'incomplete'
    }

    if (result === 'complete') {
      this.pending.delete(path)
      this.reportedItems.set(path, info.size)
      this.notify({ type: 'ready', path, fileName: basename(path), size: info.size })
      return
    }

    const reason =
      typeof result === 'object'
        ? result.unreadable
        : t('mainWatcher.reasons.stillIncomplete', { seconds: Math.round(this.maxWaitMs / 1000) })
    // A file that is not FITS is reported immediately; a truncated one only
    // after a long wait, because writing may simply have paused for a moment
    // (it happens over the network).
    if (typeof result === 'object' || now - entry.idleSince >= this.maxWaitMs) {
      this.pending.delete(path)
      this.reportedItems.set(path, info.size)
      this.notify({ type: 'unreadable', path, fileName: basename(path), reason })
    }
  }
}

/** Turns disk and network errors into a readable sentence. */
function explainError(e: unknown): string {
  const code = (e as { code?: string })?.code
  switch (code) {
    case 'ENOENT':
      return t('mainWatcher.errors.notFound')
    case 'EACCES':
    case 'EPERM':
      return t('mainWatcher.errors.noPermission')
    case 'ENOTDIR':
      return t('mainWatcher.errors.notFolder')
    case 'EHOSTUNREACH':
    case 'ETIMEDOUT':
    case 'ENETUNREACH':
    case 'EBUSY':
    case 'UNKNOWN':
      return t('mainWatcher.errors.networkNotResponding')
    default:
      return e instanceof Error
        ? t('mainWatcher.errors.unreadableWithDetail', { detail: e.message })
        : t('mainWatcher.errors.unreadable')
  }
}
