/**
 * Generates the icon and before/after previews of the plugins in the
 * bundled gallery (resources/plugin), actually applying each plugin, in
 * its sandbox, to a stretched crop of a real shot.
 *
 * Usage (from the project root, compiling to a dedicated output file):
 *   node_modules/@esbuild/win32-x64/esbuild.exe tools/generate-plugin-previews.ts --bundle
 *     --platform=node --format=esm --alias:@shared=./src/shared --alias:@core=./src/core
 *     --outfile=<temporary folder>/plugin-previews.mjs
 *   node <temporary folder>/plugin-previews.mjs [--overview <folder>]
 *
 * With --only id1,id2 only the listed plugins are regenerated.
 * With --overview it writes only the two reduced full shots, to choose
 * where to crop.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageData32 } from '../src/shared/types'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretchValue, type StretchParams } from '../src/core/image/stretch'
import { runInSandbox } from '../src/core/plugin/isolation'
import { checkManifest, defaultValues, type ParameterValues } from '../src/core/plugin/manifest'
import { APP_VERSION } from '../src/shared/version'
import { nodeWorker, encodePng } from './plugin-node'
import { testFile } from './test-files.mjs'

const PLUGIN_FOLDER = 'resources/plugin'
const PREVIEW_SIDE = 240
const ICON_SIDE = 72

interface Shot {
  image: ImageData32
  stretch: StretchParams
}

const shots = new Map<string, Shot>()
function shot(name: string): Shot {
  const alreadyRead = shots.get(name)
  if (alreadyRead) return alreadyRead
  // Already processed photos (examples/…jpg): the pixels are the ones to
  // display, so the stretch is neutral. They must first be converted with
  // "npx electron tools/convert-samples.cjs".
  if (name.startsWith('examples/')) {
    const raw = readFileSync(join(testFile('stacks'), 'examples', '.raw', name.slice('examples/'.length) + '.rgb'))
    const width = raw.readUInt32LE(0)
    const height = raw.readUInt32LE(4)
    const n = width * height
    const data = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[c * n + i] = raw[8 + i * 3 + c] / 255
    const r: Shot = { image: { width, height, channels: 3, data }, stretch: { shadows: 0, midtones: 0.5, highlights: 1 } }
    shots.set(name, r)
    return r
  }
  const readResult = readFits(new Uint8Array(readFileSync(join(testFile('stacks'), name))), name)
  const image = debayer(readResult.image, readResult.metadata.bayer)
  const r = { image, stretch: autoStretch(image) }
  shots.set(name, r)
  return r
}

/** Square crop centered on (cx, cy), `side` pixels wide, reduced to PREVIEW_SIDE by averaging. */
function cropRegion(im: ImageData32, cx: number, cy: number, side: number): ImageData32 {
  const output = PREVIEW_SIDE
  const step = side / output
  const x0 = Math.round(cx - side / 2)
  const y0 = Math.round(cy - side / 2)
  const n = output * output
  const data = new Float32Array(n * im.channels)
  const nIn = im.width * im.height
  for (let c = 0; c < im.channels; c++) {
    for (let y = 0; y < output; y++) {
      for (let x = 0; x < output; x++) {
        let sum = 0
        let tally = 0
        for (let sy = Math.floor(y * step); sy < Math.floor((y + 1) * step); sy++) {
          for (let sx = Math.floor(x * step); sx < Math.floor((x + 1) * step); sx++) {
            const px = Math.min(im.width - 1, Math.max(0, x0 + sx))
            const py = Math.min(im.height - 1, Math.max(0, y0 + sy))
            sum += im.data[c * nIn + py * im.width + px]
            tally++
          }
        }
        data[c * n + y * output + x] = tally > 0 ? sum / tally : 0
      }
    }
  }
  return { width: output, height: output, channels: im.channels, data }
}

/** As the viewer shows the data: stretch, then 8 bit. */
function toRgba(im: ImageData32, d: StretchParams): Uint8Array {
  const n = im.width * im.height
  const rgba = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = im.data[(im.channels === 3 ? c : 0) * n + i]
      rgba[i * 4 + c] = Math.round(Math.min(1, Math.max(0, applyStretchValue(v, d))) * 255)
    }
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

/** Reduces a square RGBA image by area averaging. */
function reduceRgba(rgba: Uint8Array, side: number, newValue: number): Uint8Array {
  const out = new Uint8Array(newValue * newValue * 4)
  const k = side / newValue
  for (let y = 0; y < newValue; y++) {
    for (let x = 0; x < newValue; x++) {
      const s = [0, 0, 0, 0]
      let tally = 0
      for (let sy = Math.floor(y * k); sy < Math.floor((y + 1) * k); sy++) {
        for (let sx = Math.floor(x * k); sx < Math.floor((x + 1) * k); sx++) {
          for (let c = 0; c < 4; c++) s[c] += rgba[(sy * side + sx) * 4 + c]
          tally++
        }
      }
      for (let c = 0; c < 4; c++) out[(y * newValue + x) * 4 + c] = Math.round(s[c] / Math.max(1, tally))
    }
  }
  return out
}

/**
 * Icon: before and after split diagonally, with rounded corners and a
 * thin light line along the cut, so it reads well even when small.
 */
function icon(before: Uint8Array, after: Uint8Array): Uint8Array {
  const L = ICON_SIDE
  const a = reduceRgba(before, PREVIEW_SIDE, L)
  const b = reduceRgba(after, PREVIEW_SIDE, L)
  const out = new Uint8Array(L * L * 4)
  const radius = 16
  for (let y = 0; y < L; y++) {
    for (let x = 0; x < L; x++) {
      const i = (y * L + x) * 4
      // Distance from the diagonal cut (from bottom left to top right).
      const d = (x + y - (L - 1)) / Math.SQRT2
      const src = d < 0 ? a : b
      for (let c = 0; c < 3; c++) out[i + c] = src[i + c]
      if (Math.abs(d) < 0.9) for (let c = 0; c < 3; c++) out[i + c] = Math.round(out[i + c] * 0.3 + 235 * 0.7)
      // Rounded corners with a soft edge.
      const qx = Math.max(radius - x - 0.5, x + 0.5 - (L - radius), 0)
      const qy = Math.max(radius - y - 0.5, y + 0.5 - (L - radius), 0)
      const outside = Math.hypot(qx, qy) - radius
      out[i + 3] = Math.round(Math.min(1, Math.max(0, 0.5 - outside)) * 255)
    }
  }
  return out
}

/**
 * One entry of the private crop file (role "preview-crops" among the test
 * files, kept outside the project). `id` and `values` use the plugin ids
 * and parameter ids of the bundled plugins.
 */
interface Choice {
  id: string
  file: string
  cx: number
  cy: number
  side: number
  values?: ParameterValues
  /**
   * White point of the stretch, in place of the automatic one: to show a
   * plugin that works on the bright areas, a strong stretch is needed that
   * brings them to white, as someone looking for the faint parts would do.
   */
  white?: number
  /**
   * Reduces the crop to luminance only, in a single channel: to show a
   * plugin designed for black and white shots.
   */
  monochrome?: boolean
}

/** Luminance (BT.709 weights) in a single channel. */
function toBlackAndWhite(im: ImageData32): ImageData32 {
  if (im.channels !== 3) return im
  const n = im.width * im.height
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = 0.2126 * im.data[i] + 0.7152 * im.data[n + i] + 0.0722 * im.data[2 * n + i]
  return { width: im.width, height: im.height, channels: 1, data }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const iPan = args.indexOf('--overview')
  if (iPan >= 0) {
    const where = args[iPan + 1] ?? '.'
    for (const name of ['M_27.fit', 'M_33.fit']) {
      const r = shot(name)
      console.log(name + ': ' + r.image.width + ' x ' + r.image.height + ', channels ' + r.image.channels)
      const side = Math.max(r.image.width, r.image.height)
      const reduced = cropRegion(r.image, r.image.width / 2, r.image.height / 2, side)
      writeFileSync(join(where, name + '.png'), encodePng(PREVIEW_SIDE, PREVIEW_SIDE, toRgba(reduced, r.stretch)))
    }
    return
  }

  // With --only id1,id2 only the listed plugins are regenerated.
  const iOnly = args.indexOf('--only')
  const onlyThese = iOnly >= 0 ? new Set((args[iOnly + 1] ?? '').split(',')) : null
  const choices: Choice[] = JSON.parse(readFileSync(testFile('preview-crops'), 'utf-8'))
  for (const s of choices) {
    if (onlyThese && !onlyThese.has(s.id)) continue
    const folder = join(PLUGIN_FOLDER, s.id)
    const result = checkManifest(JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf-8')), APP_VERSION)
    if (!result.ok) throw new Error(s.id + ': ' + result.errors.join(' '))
    const m = result.manifest
    const code = readFileSync(join(folder, 'plugin.js'), 'utf-8')
    const r = shot(s.file)
    const crop = cropRegion(r.image, s.cx, s.cy, s.side)
    const piece = s.monochrome ? toBlackAndWhite(crop) : crop
    const d = s.white !== undefined ? { ...r.stretch, highlights: s.white } : r.stretch
    const response = await runInSandbox(nodeWorker(code), {
      image: piece,
      values: { ...defaultValues(m), ...(s.values ?? {}) },
      context: {
        stretch: { black: d.shadows, midtones: d.midtones, white: d.highlights },
        starLightVersion: APP_VERSION
      }
    })
    if (response.result !== 'ok') throw new Error(s.id + ': ' + response.message)
    const before = toRgba(piece, d)
    const after = toRgba(response.image, d)
    writeFileSync(join(folder, m.previews.before), encodePng(PREVIEW_SIDE, PREVIEW_SIDE, before))
    writeFileSync(join(folder, m.previews.after), encodePng(PREVIEW_SIDE, PREVIEW_SIDE, after))
    writeFileSync(join(folder, m.icon), encodePng(ICON_SIDE, ICON_SIDE, icon(before, after)))
    console.log(s.id + ': previews and icon written (' + s.file + ')')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
