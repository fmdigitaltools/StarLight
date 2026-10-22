/**
 * Deconvolution check: PSF estimation, timings, before/after comparison
 * (reduced whole image and enlarged 1:1 crops), and comparison between
 * tiled processing and whole-image processing.
 *
 * Usage: TEST_SCRIPT=tools/test-deconvolution.ts node tools/run-test.mjs
 *        <file.fit> <output folder> [iterations] [regularization] [x,y ...]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { ImageData32 } from '../src/shared/types'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch } from '../src/core/image/stretch'
import { encodeBmp } from '../src/core/export/encoding'
import { testFile } from './test-files.mjs'
import {
  estimatePsf,
  deconvolve,
  automaticDeconvolution,
  measureDeconvolution,
  DECONVOLUTION_MARGIN,
  type DeconvolutionParams
} from '../src/core/image/deconvolution'

const file = process.argv[2] ?? testFile('m27')
const output = process.argv[3] ?? '.'
mkdirSync(output, { recursive: true })
const name = basename(file, '.fit')

const readResult = readFits(new Uint8Array(readFileSync(file)))
const img = debayer(readResult.image, readResult.metadata.bayer)
console.log(name + ': ' + img.width + ' x ' + img.height + ', channels ' + img.channels)

let t0 = performance.now()
const sigma = estimatePsf(img)
console.log('estimated PSF sigma: ' + sigma.toFixed(2) + ' px (' + (performance.now() - t0).toFixed(0) + ' ms)')
const auto = automaticDeconvolution(img)
console.log('automatic: ' + JSON.stringify(auto))

const p: DeconvolutionParams = {
  iterations: process.argv[4] ? Number(process.argv[4]) : auto.iterations,
  psfRadius: sigma,
  regularization: process.argv[5] ? Number(process.argv[5]) : auto.regularization
}
t0 = performance.now()
const after = deconvolve(img, p)
console.log('deconvolution ' + JSON.stringify(p) + ': ' + (performance.now() - t0).toFixed(0) + ' ms')

// Same stretch for before and after, so the comparison is fair.
const st = autoStretch(img)
const beforeS = applyStretch(img, st)
const afterS = applyStretch(after, st)

function cropRegion(im: ImageData32, x0: number, y0: number, lw: number, lh: number, scale: number): ImageData32 {
  const n = im.width * im.height
  const W = lw * scale
  const H = lh * scale
  const out = new Float32Array(W * H * im.channels)
  for (let k = 0; k < im.channels; k++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const sx = Math.min(im.width - 1, x0 + Math.floor(x / scale))
        const sy = Math.min(im.height - 1, y0 + Math.floor(y / scale))
        out[k * W * H + y * W + x] = im.data[k * n + sy * im.width + sx]
      }
  return { width: W, height: H, channels: im.channels, data: out }
}

function reduce(im: ImageData32, f: number): ImageData32 {
  const W = Math.floor(im.width / f)
  const H = Math.floor(im.height / f)
  const n = im.width * im.height
  const out = new Float32Array(W * H * im.channels)
  for (let k = 0; k < im.channels; k++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += im.data[k * n + (y * f + dy) * im.width + x * f + dx]
        out[k * W * H + y * W + x] = s / (f * f)
      }
  return { width: W, height: H, channels: im.channels, data: out }
}

/** Places before (left) and after (right) side by side. */
function sideBySide(a: ImageData32, b: ImageData32): ImageData32 {
  const W = a.width * 2 + 4
  const H = a.height
  const out = new Float32Array(W * H * a.channels)
  for (let k = 0; k < a.channels; k++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < a.width; x++) {
        out[k * W * H + y * W + x] = a.data[k * a.width * H + y * a.width + x]
        out[k * W * H + y * W + x + a.width + 4] = b.data[k * a.width * H + y * a.width + x]
      }
  return { width: W, height: H, channels: a.channels, data: out }
}

const save = (fileName: string, im: ImageData32): void => {
  writeFileSync(join(output, fileName), Buffer.from(encodeBmp(im)))
  console.log('written ' + fileName)
}

const f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / 1400))
save(name + '-intera.bmp', sideBySide(reduce(beforeS, f), reduce(afterS, f)))

const crops = process.argv.slice(6)
for (const r of crops) {
  const [x, y] = r.split(',').map(Number)
  const side = 200
  save(
    name + '-crop-' + x + '-' + y + '.bmp',
    sideBySide(cropRegion(beforeS, x - side / 2, y - side / 2, side, side, 3), cropRegion(afterS, x - side / 2, y - side / 2, side, side, 3))
  )
}

// Tiles: same global measurements, margin declared by the module.
if (process.env.STRIPS) {
  const measurements = measureDeconvolution(img, sigma)
  const margin = process.env.MARGIN ? Number(process.env.MARGIN) : DECONVOLUTION_MARGIN(p, sigma)
  const n = img.width * img.height
  const w = img.width
  const stripes = 4
  const step = Math.ceil(img.height / stripes)
  const result = new Float32Array(img.data.length)
  t0 = performance.now()
  for (let s = 0; s < stripes; s++) {
    const a = s * step
    const b = Math.min(img.height, a + step)
    const from = Math.max(0, a - margin)
    const until = Math.min(img.height, b + margin)
    const hh = until - from
    const data = new Float32Array(w * hh * img.channels)
    for (let k = 0; k < img.channels; k++) data.set(img.data.subarray(k * n + from * w, k * n + until * w), k * w * hh)
    const partialValue = deconvolve({ width: w, height: hh, channels: img.channels, data: data }, p, measurements)
    for (let k = 0; k < img.channels; k++)
      result.set(partialValue.data.subarray(k * w * hh + (a - from) * w, k * w * hh + (b - from) * w), k * n + a * w)
  }
  let max = 0
  const noise = measurements.noise
  for (let i = 0; i < result.length; i++) max = Math.max(max, Math.abs(result[i] - after.data[i]))
  console.log(
    'tiles (margin ' + margin + '): ' + (performance.now() - t0).toFixed(0) + ' ms, max difference ' +
      max.toExponential(2) + ' = ' + (max / noise).toFixed(3) + ' noise units'
  )
}
