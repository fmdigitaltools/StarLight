/**
 * Messages of the watched folder, shared by the main process, the bridge and
 * the interface.
 *
 * The main process watches the folder where the capture frames arrive and
 * notifies the interface only when a file is complete: a frame that is still
 * being written is waited for, not reported as unreadable.
 */

/** How the folder is watched. */
export type WatchMode =
  /** Operating system notifications plus a periodic safety check. */
  | 'events'
  /** Periodic check only: used on network folders where notifications do not work. */
  | 'polling'

export type WatcherEvent =
  /** A new frame is complete and readable. Sent only once per file. */
  | { type: 'ready'; path: string; fileName: string; size: number }
  /** A file has been idle for a long time but is still incomplete or not a valid FITS file. */
  | { type: 'unreadable'; path: string; fileName: string; reason: string }
  /** Files that have appeared but are still being written. */
  | { type: 'incoming'; fileNames: string[] }
  /** The folder has become unreachable, or reachable again. */
  | { type: 'reachable'; reachable: boolean; message: string }

export interface WatcherStartResult {
  ok: boolean
  mode?: WatchMode
  /** Explanation to show if starting failed. */
  message?: string
}
