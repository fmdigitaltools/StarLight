/*
 * Converts the example photos (already processed JPEG or PNG, role
 * "samples" among the test files, see test-files.mjs) into a raw format that
 * the plugin preview tool can read without external decoders.
 *
 * It uses Electron's image decoder, already among the project
 * dependencies:
 *   npx electron tools/convert-samples.cjs
 *
 * For each photo it writes to .raw/<name>.rgb, next to the photos, a
 * file with width and height (two 32-bit integers) followed by the 8-bit
 * RGB pixels, row by row (the folder generate-plugin-previews.ts reads).
 */
const { app, nativeImage } = require('electron')
const { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

// Among the test files: see test-files.mjs (same rule, here without modules).
const base = process.env.STARLIGHT_TEST_DATA ?? join(__dirname, '..')
const rolesFile = join(base, 'test-data.json')
const roles = existsSync(rolesFile) ? JSON.parse(readFileSync(rolesFile, 'utf8')) : {}
const folder = join(base, roles.samples ?? 'samples')
const output = join(folder, '.raw')

app.whenReady().then(() => {
  mkdirSync(output, { recursive: true })
  for (const name of readdirSync(folder)) {
    if (!/\.(jpe?g|png)$/i.test(name)) continue
    const image = nativeImage.createFromPath(join(folder, name))
    if (image.isEmpty()) {
      console.error('unreadable: ' + name)
      continue
    }
    const { width, height } = image.getSize()
    // toBitmap returns 8-bit BGRA.
    const bgra = image.toBitmap()
    const data = Buffer.alloc(8 + width * height * 3)
    data.writeUInt32LE(width, 0)
    data.writeUInt32LE(height, 4)
    for (let i = 0; i < width * height; i++) {
      data[8 + i * 3] = bgra[i * 4 + 2]
      data[8 + i * 3 + 1] = bgra[i * 4 + 1]
      data[8 + i * 3 + 2] = bgra[i * 4]
    }
    writeFileSync(join(output, name + '.rgb'), data)
    console.log(name + ': ' + width + ' x ' + height)
  }
  app.quit()
})
