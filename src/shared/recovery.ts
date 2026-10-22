import type { ImageData32, Wcs } from './types'

/**
 * Automatic save for recovery: messages shared by the main process
 * (src/main/recovery.ts), the bridge and the interface
 * (renderer/src/hooks/recovery.ts).
 *
 * The recovery copy is a regular project in the `@core/project` format,
 * stored in the `recovery` folder inside the program data folder. It never
 * replaces the user's project: it only serves to resume work if StarLight
 * closes unexpectedly.
 */

/** What the copy records in addition to the project itself. */
export interface RecoveryInfo {
  /** The project the work belongs to, or null for work never saved. */
  project: { name: string; folder: string } | null
  /** Time of the automatic save, in ISO format. */
  savedAt: string
  /**
   * True if StarLight shut down normally after writing the copy. A normal
   * shutdown usually deletes the copy; the flag matters when deletion fails
   * (for example, a file locked by an antivirus), because the copy must not
   * be offered in that case.
   */
  cleanShutdown: boolean
}

/**
 * Image to write into the copy, encoded as FITS by the main process. The
 * pixels are sent beforehand, in chunks (`recovery:data`): sending them all
 * at once would freeze the interface for a tenth of a second with a large
 * image, while chunks go unnoticed.
 */
export interface RecoveryImage {
  /** File name inside the recovery folder. */
  name: string
  width: number
  height: number
  channels: ImageData32['channels']
  /** Keywords of the source frame to keep in the header. */
  cards: Record<string, string | number | boolean | null>
  wcs: Wcs | null
}

/** Recovery copy found at startup. */
export interface RecoveryCopy {
  /** Path of the copy's project file. */
  path: string
  info: RecoveryInfo
}

/** Values per pixel chunk sent to the main process (8 MB). */
export const VALUES_PER_CHUNK = 2 * 1024 * 1024

/** Name of the data folder subfolder that holds the copy. */
export const RECOVERY_FOLDER = 'recovery'
/** File with the copy's information, next to the project file. */
export const RECOVERY_INFO_NAME = 'recovery.json'
