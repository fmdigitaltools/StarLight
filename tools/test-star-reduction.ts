/**
 * Test of star reduction on a real file.
 *
 * Usage:
 *   TEST_SCRIPT=tools/test-star-reduction.ts node tools/run-test.mjs \
 *     <file.fit> <output folder> [amount] [attenuation] [x,y,side[,scale] ...]
 *
 * Without amount and attenuation it uses the automatic parameters. Writes
 * a reduced whole-image preview (before | after) and, for each crop given,
 * the enlarged comparison (three times if no scale is given). Both halves
 * are stretched with the same curve, measured on the original.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { ImageData32 } from '@shared/types'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch } from '../src/core/image/stretch'
import { encodeBmp } from '../src/core/export/encoding'
import { reduceStars, automaticStarReduction } from '../src/core/image/starReduction'

const [source, output, qArg, aArg, ...crops] = process.argv.slice(2)
mkdirSync(output, { recursive: true })
const name = basename(source).replace(/\.fit$/i, '')

const readResult = readFits(new Uint8Array(readFileSync(source)))
const img = debayer(readResult.image, readResult.metadata.bayer)
console.log(name + ': ' + img.width + ' x ' + img.height + ', channels ' + img.channels)

let t0 = performance.now()
const auto = automaticStarReduction(img)
console.log('automatic: ' + JSON.stringify(auto) + ' in ' + (performance.now() - t0).toFixed(0) + ' ms')
const parameters =
  qArg !== undefined && qArg !== '-' ? { quantity: Number(qArg), attenuation: Number(aArg ?? 0) } : auto

t0 = performance.now()
const reduced = reduceStars(img, parameters)
console.log('reduction ' + JSON.stringify(parameters) + ': ' + (performance.now() - t0).toFixed(0) + ' ms')

const curve = autoStretch(img)
const before = applyStretch(img, curve)
const after = applyStretch(reduced, curve)

/** Crop [x, y, side] enlarged s times, before and after side by side. */
function sideBySide(
  a: ImageData32,
  b: ImageData32,
  x0: number,
  y0: number,
  lw: number,
  lh: number,
  s: number
): ImageData32 {
  const W = lw * s * 2 + 4
  const H = lh * s
  const n = W * H
  const na = a.width * a.height
  const data = new Float32Array(n * 3).fill(0.5)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < lw * s; x++) {
      const sx = Math.min(a.width - 1, x0 + Math.floor(x / s))
      const sy = Math.min(a.height - 1, y0 + Math.floor(y / s))
      const j = sy * a.width + sx
      for (let c = 0; c < 3; c++) {
        const cc = a.channels === 3 ? c : 0
        data[c * n + y * W + x] = a.data[cc * na + j]
        data[c * n + y * W + x + lw * s + 4] = b.data[cc * na + j]
      }
    }
  }
  return { width: W, height: H, channels: 3, data }
}

/** Reduction by block averaging, for the whole-image preview. */
function reduce(a: ImageData32, f: number): ImageData32 {
  const W = Math.floor(a.width / f)
  const H = Math.floor(a.height / f)
  const n = W * H
  const na = a.width * a.height
  const data = new Float32Array(n * a.channels)
  for (let c = 0; c < a.channels; c++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0
        for (let dy = 0; dy < f; dy++) {
          for (let dx = 0; dx < f; dx++) s += a.data[c * na + (y * f + dy) * a.width + x * f + dx]
        }
        data[c * n + y * W + x] = s / (f * f)
      }
    }
  }
  return { width: W, height: H, channels: a.channels, data }
}

const factor = 4
const pa = reduce(before, factor)
const pb = reduce(after, factor)
writeFileSync(
  join(output, name + '-whole.bmp'),
  Buffer.from(encodeBmp(sideBySide(pa, pb, 0, 0, pa.width, pa.height, 1)))
)

for (const r of crops) {
  const [x, y, side, scale = 3] = r.split(',').map(Number)
  const file = join(output, name + '-' + x + '-' + y + '.bmp')
  writeFileSync(file, Buffer.from(encodeBmp(sideBySide(before, after, x, y, side, side, scale))))
}
console.log('written to ' + output)
