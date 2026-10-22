/**
 * Test of the library thumbnails: generates the thumbnail of a few real
 * files, measures the timings and saves it as PNG for inspection.
 *
 * Usage: TEST_SCRIPT=tools/test-thumbnails.ts node tools/run-test.mjs <output-folder> <file...>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readFits } from '@core/fits/reader'
import { computeThumbnail } from '@core/image/thumbnail'
import { debayer } from '@core/image/debayer'
import { encodePng } from './plugin-node'

const [output, ...file] = process.argv.slice(2)
mkdirSync(output, { recursive: true })

for (const path of file) {
  const t0 = performance.now()
  const buffer = readFileSync(path)
  const t1 = performance.now()
  const readResult = readFits(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), basename(path))
  const t2 = performance.now()
  const m = computeThumbnail(readResult.image, readResult.metadata.bayer, readResult.metadata.frameType !== 'stacked')
  const t3 = performance.now()
  // Comparison: the same thumbnail going through the full debayer.
  const withDebayer = computeThumbnail(debayer(readResult.image, readResult.metadata.bayer), 'NONE', readResult.metadata.frameType !== 'stacked')
  const t4 = performance.now()
  writeFileSync(join(output, basename(path) + '.png'), encodePng(m.side, m.side, new Uint8Array(m.rgba.buffer)))
  writeFileSync(join(output, basename(path) + '-debayer.png'), encodePng(withDebayer.side, withDebayer.side, new Uint8Array(withDebayer.rgba.buffer)))
  console.log(
    basename(path),
    readResult.image.width + 'x' + readResult.image.height + 'x' + readResult.image.channels,
    'bayer ' + readResult.metadata.bayer,
    '| disk ' + (t1 - t0).toFixed(0) + ' ms, decoding ' + (t2 - t1).toFixed(0) +
      ' ms, thumbnail ' + (t3 - t2).toFixed(1) + ' ms (with full debayer ' + (t4 - t3).toFixed(0) + ' ms)'
  )
}
