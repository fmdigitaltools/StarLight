import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Disk space used by a folder and everything it contains.
 *
 * A folder that does not exist takes zero. Links are not followed (they could
 * lead outside or loop forever) and files that cannot be read, for example
 * because they are in use, are skipped: the count is an estimate and must
 * never fail.
 *
 * It lives in its own file, without Electron, so it can be tested on its own
 * (tools/test-performance.ts).
 */
export async function folderSize(path: string): Promise<{ byte: number; file: number }> {
  let byte = 0
  let file = 0
  const toView = [path]
  while (toView.length > 0) {
    const folder = toView.pop() as string
    let info
    try {
      info = await lstat(folder)
    } catch {
      continue
    }
    if (info.isFile()) {
      byte += info.size
      file++
      continue
    }
    if (!info.isDirectory()) continue
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      continue
    }
    for (const v of entries) {
      const p = join(folder, v.name)
      if (v.isDirectory()) toView.push(p)
      else if (v.isFile()) {
        try {
          byte += (await lstat(p)).size
          file++
        } catch {
          // File removed or locked in the meantime: not counted.
        }
      }
    }
  }
  return { byte, file }
}
