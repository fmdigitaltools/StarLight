/**
 * Generates the icon images from resources/icon.svg.
 *
 * The vector drawing is redrawn at each size instead of being scaled down
 * once: this way even the sixteen-pixel icon stays sharp. The Windows .ico
 * file is then composed by wrapping the individual PNGs.
 *
 * Note: the body is inside a function and not at module level, because in
 * an ES module a top-level await prevents Electron from completing
 * startup.
 *
 * Usage:  npx electron tools/generate-icon.mjs
 */

import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = join(root, 'resources')
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

/** Composes an .ico file by wrapping already-encoded PNG images. */
function composeIco(images) {
  const count = images.length
  const headerSize = 6 + count * 16
  let dataOffset = headerSize

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)

  images.forEach((img, index) => {
    const base = 6 + index * 16
    // The size 256 is written as zero.
    const d = img.size >= 256 ? 0 : img.size
    header.writeUInt8(d, base)
    header.writeUInt8(d, base + 1)
    header.writeUInt8(0, base + 2)
    header.writeUInt8(0, base + 3)
    header.writeUInt16LE(1, base + 4)
    header.writeUInt16LE(32, base + 6)
    header.writeUInt32LE(img.data.length, base + 8)
    header.writeUInt32LE(dataOffset, base + 12)
    dataOffset += img.data.length
  })

  return Buffer.concat([header, ...images.map((i) => i.data)])
}

async function generate() {
  const svg = readFileSync(join(outputDir, 'icon.svg'), 'utf8')
  const svgBase64 = Buffer.from(svg, 'utf8').toString('base64')

  const win = new BrowserWindow({ show: false, width: 600, height: 600 })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body></body></html>'))

  const script =
    '(async () => {' +
    "  const image = new Image();" +
    "  await new Promise((resolve, reject) => {" +
    "    image.onload = resolve;" +
    "    image.onerror = () => reject(new Error('SVG cannot be loaded'));" +
    "    image.src = 'data:image/svg+xml;base64," + svgBase64 + "';" +
    '  });' +
    '  const results = {};' +
    '  for (const size of ' + JSON.stringify(SIZES) + ') {' +
    "    const canvas = document.createElement('canvas');" +
    '    canvas.width = size; canvas.height = size;' +
    "    const ctx = canvas.getContext('2d');" +
    '    ctx.imageSmoothingEnabled = true;' +
    "    ctx.imageSmoothingQuality = 'high';" +
    '    ctx.drawImage(image, 0, 0, size, size);' +
    "    results[size] = canvas.toDataURL('image/png');" +
    '  }' +
    '  return results;' +
    '})()'

  const results = await win.webContents.executeJavaScript(script)

  mkdirSync(outputDir, { recursive: true })

  const icoImages = []
  for (const size of SIZES) {
    const data = Buffer.from(results[String(size)].split(',')[1], 'base64')
    const name = 'icon-' + size + '.png'
    writeFileSync(join(outputDir, name), data)
    console.error('  ' + name + ' - ' + data.length + ' bytes')
    // The .ico format does not accept images over 256 pixels.
    if (size <= 256) icoImages.push({ size, data })
  }

  writeFileSync(join(outputDir, 'icon.ico'), composeIco(icoImages))
  writeFileSync(join(outputDir, 'icon.png'), Buffer.from(results['512'].split(',')[1], 'base64'))
  console.error('icon.ico composed with ' + icoImages.length + ' sizes')
}

app.whenReady().then(() => {
  generate()
    .then(() => {
      console.error('Done.')
      app.exit(0)
    })
    .catch((error) => {
      console.error('Error: ' + error.message)
      app.exit(1)
    })
})
