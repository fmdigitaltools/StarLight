/**
 * Test of the à trous wavelets: measures the noise per layer, applies the
 * automatic parameters and saves stretched before/after with the same
 * curve, as a reduced overview and as 1:1 crops.
 *
 * Usage: TEST_SCRIPT=tools/test-wavelets.ts node tools/run-test.mjs
 *        [file.fit] [output folder] [x,y,side ...crops]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import type { ImageData32 } from '../src/shared/types'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch } from '../src/core/image/stretch'
import { encodeBmp } from '../src/core/export/encoding'
import { testFile } from './test-files.mjs'
import {
  imageWavelets,
  automaticWavelets,
  measureWaveletNoise,
  normalizedNoise,
  type WaveletParams
} from '../src/core/image/wavelets'

const source = process.argv[2] ?? testFile('m27')
const output = process.argv[3] ?? join(tmpdir(), 'starlight-wavelets')
const crops = process.argv.slice(4).map((s) => s.split(',').map(Number))
mkdirSync(output, { recursive: true })
const name = basename(source).replace(/\.fit$/i, '')

const readResult = readFits(new Uint8Array(readFileSync(source)))
const img = debayer(readResult.image, readResult.metadata.bayer)
console.log(name + ': ' + img.width + ' x ' + img.height + ', channels ' + img.channels)

const n = img.width * img.height
const lum = new Float32Array(n)
for (let k = 0; k < img.channels; k++)
  for (let i = 0; i < n; i++) lum[i] += img.data[k * n + i] / img.channels
const noise = measureWaveletNoise(lum, img.width, img.height)
console.log('noise per layer: ' + noise.map((v) => v.toExponential(2)).join(' '))
console.log(
  'normalized:        ' +
    normalizedNoise(noise)
      .map((v) => v.toExponential(2))
      .join(' ')
)

let t0 = performance.now()
const auto: WaveletParams = automaticWavelets(img)
console.log('automatic (' + (performance.now() - t0).toFixed(0) + ' ms): ' + JSON.stringify(auto))
const chosenItems: WaveletParams = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : auto

t0 = performance.now()
const after = imageWavelets(img, chosenItems)
console.log('imageWavelets: ' + (performance.now() - t0).toFixed(0) + ' ms')

const curve = autoStretch(img)
const a = applyStretch(img, curve)
const b = applyStretch(after, curve)

function reduce(im: ImageData32, f: number): ImageData32 {
  const w = Math.floor(im.width / f)
  const h = Math.floor(im.height / f)
  const d = new Float32Array(w * h * im.channels)
  for (let k = 0; k < im.channels; k++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let dy = 0; dy < f; dy++)
          for (let dx = 0; dx < f; dx++)
            s += im.data[k * im.width * im.height + (y * f + dy) * im.width + x * f + dx]
        d[k * w * h + y * w + x] = s / (f * f)
      }
  return { width: w, height: h, channels: im.channels, data: d }
}

function cropRegion(im: ImageData32, x0: number, y0: number, side: number, zoom: number): ImageData32 {
  const w = side * zoom
  const d = new Float32Array(w * w * im.channels)
  for (let k = 0; k < im.channels; k++)
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.min(im.width - 1, x0 + Math.floor(x / zoom))
        const sy = Math.min(im.height - 1, y0 + Math.floor(y / zoom))
        d[k * w * w + y * w + x] = im.data[k * im.width * im.height + sy * im.width + sx]
      }
  return { width: w, height: w, channels: im.channels, data: d }
}

/** Before on the left, after on the right. */
function sideBySide(p: ImageData32, q: ImageData32): ImageData32 {
  const w = p.width * 2 + 4
  const h = p.height
  const d = new Float32Array(w * h * p.channels)
  for (let k = 0; k < p.channels; k++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < p.width; x++) {
        d[k * w * h + y * w + x] = p.data[k * p.width * h + y * p.width + x]
        d[k * w * h + y * w + x + p.width + 4] = q.data[k * p.width * h + y * p.width + x]
      }
  return { width: w, height: h, channels: p.channels, data: d }
}

const f = Math.max(1, Math.round(Math.max(img.width, img.height) / 1200))
writeFileSync(
  join(output, name + '-overview.bmp'),
  Buffer.from(encodeBmp(sideBySide(reduce(a, f), reduce(b, f))))
)
crops.forEach(([x, y, side], i) => {
  const z = side <= 200 ? 3 : 2
  writeFileSync(
    join(output, name + '-crop' + (i + 1) + '.bmp'),
    Buffer.from(encodeBmp(sideBySide(cropRegion(a, x, y, side, z), cropRegion(b, x, y, side, z))))
  )
})
console.log('saved in ' + output)
