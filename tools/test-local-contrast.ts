/**
 * Test of local contrast (CLAHE).
 *
 * Local contrast is applied at the end of the chain: to test it on
 * realistic data the image is first prepared as Abracadabra does (hot
 * pixels, background, color, deconvolution, NL-Bayes on a single core).
 * The preparation is slow and is kept in a temporary folder.
 *
 * For each file it produces stretched before/after with the same curve: the
 * reduced overview and a 1:1 crop (center chosen with CX and CY).
 * Arguments: file [strength limit tiles suffix]; strength "auto" uses the
 * automatic parameters. With UNPREPARED=1 the preparation is skipped and the
 * debayered file is used as it is.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import type { ImageData32 } from '@shared/types'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch } from '../src/core/image/stretch'
import { computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { encodeBmp } from '../src/core/export/encoding'
import { firstStage, ABRACADABRA_PROCESSING } from '../src/core/image/chain'
import { nlBayes } from '../src/core/image/nlbayes'
import { localContrast, automaticLocalContrast } from '../src/core/image/localContrast'
import { testFile } from './test-files.mjs'

const output =
  join(tmpdir(), 'starlight-clahe')
mkdirSync(output, { recursive: true })

const file = process.argv[2] ?? testFile('m33')
const name = basename(file, '.fit') + (process.argv[6] ?? '')

/** Preparation as in Abracadabra, kept on disk. */
function prepare(): ImageData32 {
  const cache = join(output, basename(file, '.fit') + '-prepared.f32')
  const readResult = readFits(new Uint8Array(readFileSync(file)))
  const rawValue = debayer(readResult.image, readResult.metadata.bayer)
  if (process.env.UNPREPARED) return rawValue
  if (existsSync(cache)) {
    const b = readFileSync(cache)
    const data = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    return { ...rawValue, data }
  }
  let t = performance.now()
  const im = firstStage(rawValue, ABRACADABRA_PROCESSING, true).image
  console.log('first stage: ' + (performance.now() - t).toFixed(0) + ' ms')
  t = performance.now()
  const n = im.width * im.height
  const c = im.channels
  const y = new Float32Array(n)
  for (let k = 0; k < c; k++) for (let i = 0; i < n; i++) y[i] += im.data[k * n + i] / c
  const sigma = computeStats(y).mad * MAD_TO_SIGMA * 2.2
  const cleaned = nlBayes(y, im.width, im.height, sigma)
  const data = im.data.slice()
  for (let i = 0; i < n; i++) {
    const delta = cleaned[i] - y[i]
    for (let k = 0; k < c; k++) data[k * n + i] += delta
  }
  console.log('NL-Bayes: ' + (performance.now() - t).toFixed(0) + ' ms')
  writeFileSync(cache, Buffer.from(data.buffer))
  return { ...im, data }
}

function reduce(img: ImageData32, f: number): ImageData32 {
  const w = Math.floor(img.width / f)
  const h = Math.floor(img.height / f)
  const n0 = img.width * img.height
  const n = w * h
  const out = new Float32Array(n * img.channels)
  for (let k = 0; k < img.channels; k++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let dy = 0; dy < f; dy++)
          for (let dx = 0; dx < f; dx++) s += img.data[k * n0 + (y * f + dy) * img.width + x * f + dx]
        out[k * n + y * w + x] = s / (f * f)
      }
  return { width: w, height: h, channels: img.channels, data: out }
}

function cropRegion(img: ImageData32, cx: number, cy: number, side: number): ImageData32 {
  const x0 = Math.max(0, Math.min(img.width - side, Math.round(cx - side / 2)))
  const y0 = Math.max(0, Math.min(img.height - side, Math.round(cy - side / 2)))
  const n0 = img.width * img.height
  const n = side * side
  const out = new Float32Array(n * img.channels)
  for (let k = 0; k < img.channels; k++)
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) out[k * n + y * side + x] = img.data[k * n0 + (y0 + y) * img.width + x0 + x]
  return { width: side, height: side, channels: img.channels, data: out }
}

/** Places two images of the same size side by side. */
function sideBySide(a: ImageData32, b: ImageData32): ImageData32 {
  const w = a.width * 2 + 8
  const h = a.height
  const n = w * h
  const na = a.width * a.height
  const out = new Float32Array(n * 3)
  for (let k = 0; k < 3; k++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < a.width; x++) {
        out[k * n + y * w + x] = a.data[k * na + y * a.width + x]
        out[k * n + y * w + x + a.width + 8] = b.data[k * na + y * a.width + x]
      }
  return { width: w, height: h, channels: 3, data: out }
}

const img = prepare()
console.log(name + ': ' + img.width + ' x ' + img.height)

let t0 = performance.now()
const auto = automaticLocalContrast(img)
console.log('automatic: ' + JSON.stringify(auto) + ' in ' + (performance.now() - t0).toFixed(0) + ' ms')

const p =
  !process.argv[3] || process.argv[3] === 'auto'
    ? auto
    : {
        strength: Number(process.argv[3]),
        limit: process.argv[4] ? Number(process.argv[4]) : 2,
        boxes: process.argv[5] ? Number(process.argv[5]) : 8
      }
t0 = performance.now()
const after = localContrast(img, p)
console.log('localContrast ' + JSON.stringify(p) + ': ' + (performance.now() - t0).toFixed(0) + ' ms')

// Same curve for before and after, somewhat stronger than the automatic one
// to make the faint parts visible as someone finishing the image would see them.
const stretch = autoStretch(img, { targetBackground: 0.12 })
const a = applyStretch(img, stretch)
const b = applyStretch(after, stretch)
const save = (n: string, im: ImageData32): void => writeFileSync(join(output, n), Buffer.from(encodeBmp(im)))
save(name + '-overview.bmp', sideBySide(reduce(a, 4), reduce(b, 4)))
const cx = Number(process.env.CX ?? img.width / 2)
const cy = Number(process.env.CY ?? img.height / 2)
save(name + '-crop.bmp', sideBySide(cropRegion(a, cx, cy, 600), cropRegion(b, cx, cy, 600)))
