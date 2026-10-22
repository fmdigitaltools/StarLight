/*
 * Batch processing, disk side: choosing the files, writing the output files
 * without ever overwriting an existing one, saving and reopening recipes. All
 * the computation happens in the interface, as for a single-image export.
 */
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { basename, dirname, extname, join } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { FileHandleInfo } from '@shared/types'
import { RAW_EXTENSIONS } from '@core/raw/rawFormats'
import { t } from '../shared/i18n/i18n'

/** A plain file name, never a path that leads elsewhere. */
function simpleName(name: string): boolean {
  return typeof name === 'string' && name !== '' && name === basename(name) && name !== '.' && name !== '..'
}

/** The given folder if it exists, otherwise the closest existing parent. */
async function firstExisting(path: string | null): Promise<string> {
  let p = path ? path.trim() : ''
  while (p !== '') {
    try {
      await stat(p)
      return p
    } catch {
      const su = dirname(p)
      if (su === p) break
      p = su
    }
  }
  return app.getPath('documents')
}

/**
 * Writes `data` into the folder with the given name; if the name is taken it
 * tries "name (2)", "name (3)" and so on. Exclusive writing ('wx') ensures an
 * existing file is never touched, even one that appears in the meantime.
 */
async function writeWithoutOverwriting(folder: string, name: string, data: ArrayBuffer): Promise<string> {
  if (!simpleName(name)) throw new Error(t('mainBatch.invalidFileName'))
  await mkdir(folder, { recursive: true })
  const extension = extname(name)
  const root = name.slice(0, name.length - extension.length)
  const buffer = Buffer.from(data)
  for (let i = 1; i <= 9999; i++) {
    const path = join(folder, i === 1 ? name : root + ' (' + i + ')' + extension)
    try {
      await writeFile(path, buffer, { flag: 'wx' })
      return path
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error(t('mainBatch.tooManySameName'))
}

export function registerBatchHandlers(window: () => BrowserWindow | null): void {
  ipcMain.handle('batch:chooseFiles', async (): Promise<FileHandleInfo[]> => {
    const f = window()
    if (!f) return []
    const result = await dialog.showOpenDialog(f, {
      title: t('mainBatch.chooseFiles.title'),
      buttonLabel: t('mainBatch.chooseFiles.button'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: t('mainBatch.filters.allImages'),
          extensions: ['fit', 'fits', 'fts', 'fz', 'gz', 'xisf', 'tif', 'tiff', 'png', ...RAW_EXTENSIONS]
        },
        { name: t('mainBatch.filters.allFiles'), extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return Promise.all(
      result.filePaths.map(async (p) => ({ path: p, fileName: basename(p), sizeBytes: (await stat(p)).size }))
    )
  })

  ipcMain.handle(
    'batch:write',
    (_e, folder: string, name: string, data: ArrayBuffer): Promise<string> =>
      writeWithoutOverwriting(folder, name, data)
  )

  ipcMain.handle(
    'batch:saveRecipe',
    async (_e, suggestedName: string, text: string, folder: string | null): Promise<string | null> => {
      const f = window()
      if (!f) return null
      const name = simpleName(suggestedName) ? suggestedName : 'recipe.recipe'
      const result = await dialog.showSaveDialog(f, {
        title: t('mainBatch.saveRecipe.title'),
        buttonLabel: t('mainBatch.saveRecipe.button'),
        defaultPath: join(await firstExisting(folder), name),
        filters: [
          { name: t('mainBatch.filters.recipes'), extensions: ['recipe'] },
          { name: t('mainBatch.filters.allFiles'), extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, text, 'utf-8')
      return result.filePath
    }
  )

  ipcMain.handle(
    'batch:openRecipe',
    async (_e, folder: string | null): Promise<{ path: string; text: string } | null> => {
      const f = window()
      if (!f) return null
      const result = await dialog.showOpenDialog(f, {
        title: t('mainBatch.openRecipe.title'),
        buttonLabel: t('mainBatch.openRecipe.button'),
        defaultPath: await firstExisting(folder),
        properties: ['openFile'],
        filters: [
          { name: t('mainBatch.filters.recipes'), extensions: ['recipe'] },
          { name: t('mainBatch.filters.allFiles'), extensions: ['*'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const path = result.filePaths[0]
      // A recipe is a small text file: a huge file certainly is not one.
      if ((await stat(path)).size > 4 * 1048576) throw new Error(t('mainBatch.notARecipe'))
      return { path, text: await readFile(path, 'utf-8') }
    }
  )
}
