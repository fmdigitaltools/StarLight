/**
 * Test of sky background extraction with radial basis functions.
 *
 * For each file it produces, in an output folder, images to inspect:
 * before and after with an aggressive stretch (the gradient and any eaten
 * object are only visible that way), the background model with widened
 * contrast, and the position of the samples (green = sky, red = discarded
 * as object). The images are reduced to a quarter; a central crop stays at
 * 1:1 scale.
 *
 * Usage:
 *   TEST_SCRIPT=tools/test-rbf-background.ts node tools/run-test.mjs \
 *     output-folder file1.fit [file2.fit ...] [--auto] [--samples N] [--lev L] [--tol T]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageData32 } from '../src/shared/types'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch } from '../src/core/image/stretch'
import { encodeBmp } from '../src/core/export/encoding'
import {
  extractRbfBackground,
  autoRbfBackground,
  rbfBackgroundSamples,
  DEFAULT_RBF_BACKGROUND,
  type RbfBackgroundParams
} from '../src/core/image/rbfBackground'

const args = process.argv.slice(2)
const output = args[0]
const file: string[] = []
const parameters: RbfBackgroundParams = { ...DEFAULT_RBF_BACKGROUND }
let automatic = false
for (let i = 1; i < args.length; i++) {
  const a = args[i]
  if (a === '--auto') automatic = true
  else if (a === '--samples') parameters.samplesPerSide = Number(args[++i])
  else if (a === '--lev') parameters.smoothness = Number(args[++i])
  else if (a === '--tol') parameters.tolerance = Number(args[++i])
  else file.push(a)
}
mkdirSync(output, { recursive: true })

/** Reduction by averaging over blocks of f × f pixels. */
function reduce(img: ImageData32, f: number): ImageData32 {
  const w = Math.floor(img.width / f)
  const h = Math.floor(img.height / f)
  const n = img.width * img.height
  const m = w * h
  const data = new Float32Array(m * img.channels)
  for (let k = 0; k < img.channels; k++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let yy = 0; yy < f; yy++) {
          for (let xx = 0; xx < f; xx++) s += img.data[k * n + (y * f + yy) * img.width + x * f + xx]
        }
        data[k * m + y * w + x] = s / (f * f)
      }
    }
  }
  return { width: w, height: h, channels: img.channels, data }
}

function cropRegion(img: ImageData32, x0: number, y0: number, w: number, h: number): ImageData32 {
  const n = img.width * img.height
  const data = new Float32Array(w * h * img.channels)
  for (let k = 0; k < img.channels; k++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) data[k * w * h + y * w + x] = img.data[k * n + (y0 + y) * img.width + x0 + x]
    }
  }
  return { width: w, height: h, channels: img.channels, data }
}

/** Aggressive stretch: background brought to 0.3, black point near the sky. */
function strongStretch(img: ImageData32): ImageData32 {
  return applyStretch(img, autoStretch(img, { targetBackground: 0.3, shadowsClipping: -2 }))
}

function save(name: string, img: ImageData32): void {
  writeFileSync(join(output, name + '.bmp'), Buffer.from(encodeBmp(img)))
}

function toRgb(img: ImageData32): ImageData32 {
  if (img.channels === 3) return img
  const n = img.width * img.height
  const data = new Float32Array(3 * n)
  for (let k = 0; k < 3; k++) data.set(img.data, k * n)
  return { ...img, channels: 3, data }
}

function mark(img: ImageData32, x: number, y: number, color: [number, number, number]): void {
  const n = img.width * img.height
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const xx = Math.round(x) + dx
      const yy = Math.round(y) + dy
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue
      for (let k = 0; k < 3; k++) img.data[k * n + yy * img.width + xx] = color[k]
    }
  }
}

for (const path of file) {
  const name = path.split(/[\\/]/).pop()!.replace(/\.fit.*$/i, '')
  const readResult = readFits(new Uint8Array(readFileSync(path)), path)
  const img = debayer(readResult.image, readResult.metadata.bayer)
  const p = automatic ? autoRbfBackground(img) : parameters
  console.log(
    name + ': ' + img.width + 'x' + img.height + ' channels ' + img.channels +
      '  parameters ' + JSON.stringify(p)
  )
  let t0 = performance.now()
  const result = extractRbfBackground(img, p)
  const time = performance.now() - t0
  t0 = performance.now()
  const auto = autoRbfBackground(img)
  const autoTime = performance.now() - t0
  console.log(
    '  time ' + time.toFixed(0) + ' ms (automatic ' + autoTime.toFixed(0) + ' ms, proposes ' +
      JSON.stringify(auto) + '), unevenness before ' + result.unevenness.toFixed(1) + '%'
  )

  const f = Math.max(1, Math.round(Math.max(img.width, img.height) / 1000))
  const before = toRgb(strongStretch(reduce(img, f)))
  const samples = rbfBackgroundSamples(img, p)
  let sky = 0
  for (const c of samples) {
    if (c.sky) sky++
    mark(before, c.x / f, c.y / f, c.sky ? [0, 1, 0] : [1, 0, 0])
  }
  console.log('  samples ' + samples.length + ', of sky ' + sky)
  save(name + '-before', before)
  save(name + '-after', strongStretch(reduce(result.image, f)))
  // Remaining background: a heavily reduced image, where only the large scale remains.
  save(name + '-after-large-scale', strongStretch(reduce(result.image, f * 4)))
  save(name + '-before-large-scale', strongStretch(reduce(img, f * 4)))

  // Model: difference between before and after, contrast widened over the range.
  const n = img.width * img.height
  const model = new Float32Array(img.data.length)
  for (let i = 0; i < img.data.length; i++) model[i] = img.data[i] - result.image.data[i]
  const mr = reduce({ ...img, data: model }, f * 4)
  let min = Infinity
  let max = -Infinity
  for (const v of mr.data) {
    if (v < min) min = v
    if (v > max) max = v
  }
  for (let i = 0; i < mr.data.length; i++) mr.data[i] = (mr.data[i] - min) / Math.max(1e-9, max - min)
  save(name + '-model', mr)
  void n

  const side = 800
  const x0 = Math.max(0, (img.width >> 1) - side / 2)
  const y0 = Math.max(0, (img.height >> 1) - side / 2)
  const rw = Math.min(side, img.width)
  const rh = Math.min(side, img.height)
  save(name + '-after-1to1', strongStretch(cropRegion(result.image, x0, y0, rw, rh)))
}
