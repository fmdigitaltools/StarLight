/**
 * False positives of satellite trails: on clean files none must be found,
 * neither with normal sensitivity, nor with the automatic one, nor with the
 * maximum one. It applies to whole trails and to partial ones.
 *
 * Usage: TEST_SCRIPT=tools/test-clean-trails.ts node tools/run-test.mjs [file.fit ...]
 * Without arguments it tries all the .fit files of the stacked sample images. Exits with 1 if it finds
 * a trail, with 77 if there are no files to try.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { detectTrails, automaticTrails } from '../src/core/image/trails'
import { testFile } from './test-files.mjs'

const folder = testFile('stacks')
const file =
  process.argv.length > 2
    ? process.argv.slice(2)
    : existsSync(folder)
      ? readdirSync(folder)
          .filter((f) => /\.fit$/i.test(f))
          .map((f) => join(folder, f))
      : []
if (file.length === 0) {
  console.log('No .fit file in ' + folder + ': test skipped.')
  process.exit(77)
}

let falsePositives = 0
for (const path of file) {
  const readResult = readFits(new Uint8Array(readFileSync(path)), path)
  const img = debayer(readResult.image, readResult.metadata.bayer)
  const auto = automaticTrails(img)
  const rows: string[] = []
  for (const s of [0.5, auto.sensitivity, 1]) {
    const t0 = performance.now()
    const foundAll = detectTrails(img, s)
    falsePositives += foundAll.length
    rows.push(
      's=' +
        s +
        ': ' +
        foundAll.length +
        ' (' +
        (performance.now() - t0).toFixed(0) +
        ' ms)' +
        foundAll
          .map(
            (t) =>
              ' [' +
              t.angle.toFixed(1) +
              '° ' +
              (t.whole ? 'whole' : 'partial') +
              ' cov ' +
              Math.round(t.coverage * 100) +
              '% strength ' +
              t.strength.toFixed(1) +
              ' from (' +
              t.x1.toFixed(0) +
              ',' +
              t.y1.toFixed(0) +
              ') to (' +
              t.x2.toFixed(0) +
              ',' +
              t.y2.toFixed(0) +
              ')]'
          )
          .join('')
    )
  }
  console.log(path.replace(/^.*[\\/]/, '').padEnd(60) + img.width + 'x' + img.height + '  ' + rows.join('  '))
}
console.log(
  falsePositives === 0
    ? 'RESULT: passed, no trail on the clean files'
    : 'RESULT: failed, ' + falsePositives + ' trails found on the clean files'
)
process.exit(falsePositives === 0 ? 0 : 1)
