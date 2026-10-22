/**
 * Crops and enlarges a portion of a PNG image.
 *
 * Used to examine interface details closely in verification screenshots:
 * at full size a twenty-seven pixel brand mark cannot be judged.
 *
 * Usage:  npx electron tools/crop.mjs <input> <output> <x> <y> <width> <height> [scale]
 */

import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [input, output, x, y, width, height, scale = '6'] = args.slice(
  args.findIndex((a) => a.endsWith('.png'))
)

function generate() {
  const data = readFileSync(input).toString('base64')
  const win = new BrowserWindow({ show: false, width: 400, height: 400 })

  return win
    .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body></body></html>'))
    .then(() =>
      win.webContents.executeJavaScript(
        '(async () => {' +
          '  const img = new Image();' +
          "  await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64," + data + "'; });" +
          '  const s = ' + Number(scale) + ';' +
          "  const canvas = document.createElement('canvas');" +
          '  canvas.width = ' + Number(width) + ' * s;' +
          '  canvas.height = ' + Number(height) + ' * s;' +
          "  const ctx = canvas.getContext('2d');" +
          '  ctx.imageSmoothingEnabled = true;' +
          "  ctx.imageSmoothingQuality = 'high';" +
          '  ctx.drawImage(img, ' + Number(x) + ', ' + Number(y) + ', ' + Number(width) + ', ' +
          Number(height) + ', 0, 0, canvas.width, canvas.height);' +
          "  return canvas.toDataURL('image/png');" +
          '})()'
      )
    )
    .then((dataUrl) => {
      writeFileSync(output, Buffer.from(dataUrl.split(',')[1], 'base64'))
      console.error('crop saved to ' + output)
    })
}

app.whenReady().then(() => {
  generate()
    .then(() => app.exit(0))
    .catch((e) => {
      console.error('Error: ' + e.message)
      app.exit(1)
    })
})
