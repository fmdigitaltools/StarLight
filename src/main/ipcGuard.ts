/*
 * Check on who sends messages to the main process.
 *
 * Every channel registered with ipcMain.handle or ipcMain.on answers only the
 * top frame of the StarLight window. The other windows (splash, plugin
 * sandbox) have no access to these channels through their preload, but the
 * check keeps it that way even if a page or a frame ends up somewhere it
 * should not: a refused request is written to the log and gets no answer.
 *
 * It must be installed before any channel is registered (see index.ts).
 */
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { writeLog } from './log'

function allowed(event: IpcMainEvent | IpcMainInvokeEvent, appWindow: () => BrowserWindow | null): boolean {
  const w = appWindow()
  if (!w || w.isDestroyed()) return false
  return event.sender === w.webContents && event.senderFrame === event.sender.mainFrame
}

function refuse(channel: string): void {
  writeLog('warning', 'main', 'Message refused, sender is not the StarLight window: ' + channel)
}

export function guardIpc(appWindow: () => BrowserWindow | null): void {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      if (!allowed(event, appWindow)) {
        refuse(channel)
        throw new Error('Sender not allowed')
      }
      return listener(event, ...args)
    })
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, listener) =>
    on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (!allowed(event, appWindow)) {
        refuse(channel)
        return
      }
      listener(event, ...args)
    })
}
