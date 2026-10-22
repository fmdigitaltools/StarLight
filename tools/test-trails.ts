/**
 * Test of satellite trails (src/core/image/trails.ts).
 *
 * On a clean real file: 1) no trail must be found; 2) a synthetic elongated
 * object (edge-on galaxy) and a nearly straight filament of irregular width
 * and brightness, like those in nebulae, must be left alone (a perfectly
 * straight segment, as wide as a star and uniform, would instead be a
 * partial trail and would be removed: see test-partial-trails.ts); 3)
 * realistic synthetic trails (bright, faint, colored like satellite
 * flashes, of different widths) must be found and reconstructed.
 * The reconstruction is compared with the clean file: along the trail the
 * mean difference must be zero and the grain similar to the real one.
 *
 * Usage: TEST_SCRIPT=tools/test-trails.ts node tools/run-test.mjs file.fit [output-folder]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch, type StretchParams } from '../src/core/image/stretch'
import { encodeBmp } from '../src/core/export/encoding'
import { medianAndMad } from '../src/core/image/selection'
import { MAD_TO_SIGMA } from '../src/core/image/stats'
import { blur } from '../src/core/image/cleanup'
import { detectTrails, removeTrails, automaticTrails, type Trail } from '../src/core/image/trails'
import type { ImageData32 } from '../src/shared/types'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('m33')
if (!existsSync(path)) {
  console.log('Missing ' + path + ': test skipped.')
  process.exit(77)
}
/** Problems found: if there is at least one, the test fails. */
let problems = 0
const output = process.argv[3] ?? '.'
mkdirSync(output, { recursive: true })
const name = basename(path).replace(/\.fit$/i, '')

const readResult = readFits(new Uint8Array(readFileSync(path)), path)
const cleaned = debayer(readResult.image, readResult.metadata.bayer)
const w = cleaned.width
const h = cleaned.height
const n = w * h
const C = cleaned.channels
console.log(name + ': ' + w + ' x ' + h + ', ' + C + ' channels')

// Noise and background per channel.
const sigmaC: number[] = []
const backgroundC: number[] = []
for (let c = 0; c < C; c++) {
  const p = cleaned.data.subarray(c * n, (c + 1) * n)
  // True pixel noise: spread of the fine part (pixel minus its blur).
  // Differences between adjacent pixels underestimate it, because in
  // demosaiced and stacked files neighboring pixels are correlated.
  const smoothed = blur(p, w, h, 8)
  const end = new Float32Array(n)
  for (let i = 0; i < n; i++) end[i] = p[i] - smoothed[i]
  sigmaC.push(medianAndMad(end).mad * MAD_TO_SIGMA)
  backgroundC.push(medianAndMad(p).median)
}
console.log(
  'noise per channel: ' +
    sigmaC.map((s) => s.toExponential(2)).join(' ') +
    '  background ' +
    backgroundC.map((f) => f.toFixed(4)).join(' ')
)

/** Synthetic trail: line through (cx, cy) at an angle, Gaussian profile, amplitude along t. */
interface Synthetic {
  name: string
  cx: number
  cy: number
  degrees: number
  fwhm: number
  /** Amplitude in noise units, as a function of position t (pixels from the center). */
  amplitude: (t: number) => number
  color: [number, number, number]
}

let seed = 12345
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
  return (seed + 0.5) / 4294967296
}
function gauss(): number {
  return Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())
}

function addTrails(img: ImageData32, trails: Synthetic[]): ImageData32 {
  const data = img.data.slice()
  const meanSigma = sigmaC.reduce((a, b) => a + b, 0) / C
  for (const s of trails) {
    const a = (s.degrees * Math.PI) / 180
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const sd = s.fwhm / 2.3548
    const radius = Math.ceil(sd * 5)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = (x - s.cx) * -dy + (y - s.cy) * dx
        if (Math.abs(d) > radius) continue
        const t = (x - s.cx) * dx + (y - s.cy) * dy
        const profile = Math.exp((-d * d) / (2 * sd * sd))
        const signal = s.amplitude(t) * meanSigma * profile
        for (let c = 0; c < C; c++) {
          const v = signal * s.color[c]
          // Photon noise of the trail: variance proportional to the signal,
          // with the same gain that gives the background noise.
          const gain = (sigmaC[c] * sigmaC[c]) / Math.max(1e-4, backgroundC[c])
          const i = c * n + y * w + x
          data[i] = Math.min(1, data[i] + v + Math.sqrt(Math.max(0, v * gain)) * gauss())
        }
      }
    }
  }
  return { ...img, data }
}

/** Synthetic edge-on galaxy and short straight filament: they must be left alone. */
function addElongatedObjects(img: ImageData32): ImageData32 {
  const data = img.data.slice()
  const meanSigma = sigmaC.reduce((a, b) => a + b, 0) / C
  const cx = w * 0.3
  const cy = h * 0.7
  const a = (35 * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  // Like NGC 891 in a 1.3° x 0.7° field: one third of the short side long.
  const L = Math.min(w, h) * 0.16 // semi-major axis
  const B = L / 9
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x - cx) * dx + (y - cy) * dy
      const d = (x - cx) * -dy + (y - cy) * dx
      const r = Math.sqrt((t / L) ** 2 + (d / B) ** 2)
      if (r > 4) continue
      // Exponential profile with a nucleus and a dark dust lane in the plane.
      let v = 60 * Math.exp(-r * 3) + 300 * Math.exp(-((t / (L * 0.08)) ** 2 + (d / (B * 0.5)) ** 2))
      v *= 1 - 0.6 * Math.exp(-((d / (B * 0.12)) ** 2)) * Math.exp(-((t / L) ** 2))
      for (let c = 0; c < C; c++) data[c * n + y * w + x] += v * meanSigma * [1.1, 1, 0.85][c]
    }
  }
  // Filament: nearly straight segment half the field long, faint, not
  // touching the edges, with width and brightness varying along its path.
  const fx = w * 0.62
  const fy = h * 0.35
  const fa = (78 * Math.PI) / 180
  const fdx = Math.cos(fa)
  const fdy = Math.sin(fa)
  const meta = Math.min(w, h) * 0.6
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x - fx) * fdx + (y - fy) * fdy
      const d = (x - fx) * -fdy + (y - fy) * fdx
      if (Math.abs(d) > 10 || Math.abs(t) > meta) continue
      const sd = 1.3 * (1.6 + Math.sin(t / 53) + 0.5 * Math.sin(t / 17))
      const strength = 2.5 * (0.55 + 0.45 * Math.sin(t / 41) * Math.sin(t / 13))
      const v = strength * Math.exp(-(d * d) / (2 * sd * sd)) * Math.min(1, (meta - Math.abs(t)) / 50)
      for (let c = 0; c < C; c++) data[c * n + y * w + x] += v * meanSigma
    }
  }
  return { ...img, data }
}

const trails: Synthetic[] = [
  { name: 'bright white', cx: w * 0.5, cy: h * 0.5, degrees: 23, fwhm: 3, amplitude: () => 25, color: [1, 1, 1] },
  { name: 'faint', cx: w * 0.4, cy: h * 0.45, degrees: 97, fwhm: 2.5, amplitude: () => 1, color: [1, 1, 1] },
  { name: 'very faint', cx: w * 0.7, cy: h * 0.6, degrees: 52, fwhm: 2.5, amplitude: () => 0.5, color: [1, 1, 1] },
  {
    name: 'flash orange',
    cx: w * 0.6,
    cy: h * 0.3,
    degrees: 141,
    fwhm: 3.5,
    amplitude: (t) => 1.5 + 90 * Math.exp(-(((t - 300) / 180) ** 2)),
    color: [1.2, 0.8, 0.45]
  },
  {
    name: 'variable cyan',
    cx: w * 0.55,
    cy: h * 0.8,
    degrees: 4,
    fwhm: 2,
    amplitude: (t) => 3.5 * (0.6 + 0.4 * Math.sin(t / 90)),
    color: [0.7, 0.9, 1.3]
  },
  { name: 'wide medium', cx: w * 0.2, cy: h * 0.5, degrees: 64, fwhm: 6, amplitude: () => 1.8, color: [1, 1, 1] }
]

const angleDifference = (a: number, b: number): number => Math.abs(((((a - b) % 180) + 270) % 180) - 90)

const time = (f: () => void): number => {
  const t0 = performance.now()
  f()
  return performance.now() - t0
}

function print(s: Trail): string {
  return (
    'angle ' +
    s.angle.toFixed(2) +
    '°, width ' +
    s.width.toFixed(1) +
    ' px, coverage ' +
    Math.round(s.coverage * 100) +
    '%, strength ' +
    s.strength.toFixed(1) +
    ', from (' +
    s.x1.toFixed(0) +
    ',' +
    s.y1.toFixed(0) +
    ') to (' +
    s.x2.toFixed(0) +
    ',' +
    s.y2.toFixed(0) +
    ')'
  )
}

// 1. Clean file.
console.log('\n--- CLEAN FILE ---')
const auto = automaticTrails(cleaned)
console.log('automatic choice: sensitivity ' + auto.sensitivity)
for (const s of [0.5, auto.sensitivity, 1]) {
  let foundAll: Trail[] = []
  const ms = time(() => (foundAll = detectTrails(cleaned, s)))
  console.log('sensitivity ' + s + ': ' + foundAll.length + ' trails (' + ms.toFixed(0) + ' ms)')
  for (const t of foundAll) console.log('   FALSE POSITIVE ' + print(t))
  problems += foundAll.length
}

// 2. Elongated objects that do not cross the field.
console.log('\n--- SYNTHETIC EDGE-ON GALAXY AND FILAMENT ---')
const elongated = addElongatedObjects(cleaned)
for (const s of [0.5, 1]) {
  const foundAll = detectTrails(elongated, s)
  console.log('sensitivity ' + s + ': ' + foundAll.length + ' trails')
  for (const t of foundAll) console.log('   FALSE POSITIVE ' + print(t))
  problems += foundAll.length
}

// 3. Synthetic trails.
console.log('\n--- SYNTHETIC TRAILS ---')
const dirty = addTrails(cleaned, trails)
let result = removeTrails(dirty, auto)
const ms = time(() => (result = removeTrails(dirty, auto)))
console.log(
  'found ' + result.trails.length + ' of ' + trails.length + ' (' + ms.toFixed(0) + ' ms, detection and reconstruction)'
)
for (const s of trails) {
  const grip = result.trails.find((t) => {
    const from = angleDifference(t.angle, s.degrees)
    if (from > 1) return false
    // distance of the synthetic trail's center from the detected line
    const lx = t.x2 - t.x1
    const ly = t.y2 - t.y1
    const L = Math.hypot(lx, ly)
    return Math.abs(((s.cx - t.x1) * ly - (s.cy - t.y1) * lx) / L) < 4
  })
  console.log('  ' + s.name.padEnd(18) + (grip ? 'FOUND  ' + print(grip) : 'MISSED'))
  if (!grip) problems++
}
for (const t of result.trails) {
  const note = trails.some((s) => angleDifference(t.angle, s.degrees) < 1)
  if (!note) {
    console.log('  extra: ' + print(t))
    problems++
  }
}

// Reconstruction quality along each trail, compared with the clean file.
// The reconstruction has its own grain, independent of the clean file's:
// the spread of the ideal difference is therefore √2 = 1.41 times the noise.
console.log('\n  reconstruction (noise units; ideal: mean deviation 0, spread 1.41):')
for (const s of trails) {
  const a = (s.degrees * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const band = Math.max(2, s.fwhm)
  let sum = 0
  let count = 0
  const residuals: number[] = []
  let trailResidual = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = (x - s.cx) * -dy + (y - s.cy) * dx
      if (Math.abs(d) > band) continue
      for (let c = 0; c < C; c++) {
        const i = c * n + y * w + x
        const r = (result.image.data[i] - cleaned.data[i]) / sigmaC[c]
        if (Math.abs(r) > 20) continue // stars cut by the trail: set aside
        sum += r
        count++
        if ((x + y) % 3 === 0) {
          residuals.push(result.image.data[i] - cleaned.data[i])
        }
        trailResidual += (dirty.data[i] - cleaned.data[i]) / sigmaC[c]
      }
    }
  }
  const sd = (v: number[]): number => {
    const m = v.reduce((p, q) => p + q, 0) / v.length
    return Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / v.length)
  }
  const meanSigma = sigmaC.reduce((p, q) => p + q, 0) / C
  console.log(
    '  ' +
      s.name.padEnd(18) +
      'mean trail ' +
      (trailResidual / count).toFixed(2) +
      ' → mean deviation ' +
      (sum / count).toFixed(3) +
      ', spread of the deviation ' +
      (sd(residuals) / meanSigma).toFixed(2)
  )
}

// Mean deviation profile across the trails: a light or dark line
// left by the reconstruction would appear here as a value far from 0.
console.log('\n  mean deviation by distance from the center (noise units, -12 to +12 px):')
for (const s of trails) {
  const a = (s.degrees * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const sums = new Float64Array(25)
  const tallies = new Float64Array(25)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.round((x - s.cx) * -dy + (y - s.cy) * dx)
      if (Math.abs(d) > 12) continue
      for (let c = 0; c < C; c++) {
        const i = c * n + y * w + x
        const r = (result.image.data[i] - cleaned.data[i]) / sigmaC[c]
        if (Math.abs(r) > 20) continue
        sums[d + 12] += r
        tallies[d + 12]++
      }
    }
  }
  console.log('  ' + s.name.padEnd(18) + Array.from(sums, (v, k) => (v / Math.max(1, tallies[k])).toFixed(2)).join(' '))
}

// Images: enlarged before/after crops and the whole image reduced.
const stretch: StretchParams = autoStretch(cleaned)
function crop(img: ImageData32, x0: number, y0: number, side: number, scale: number): ImageData32 {
  const L = side * scale
  const out = new Float32Array(L * L * C)
  for (let y = 0; y < L; y++) {
    for (let x = 0; x < L; x++) {
      const sx = Math.min(w - 1, Math.max(0, Math.floor(x0 + x / scale)))
      const sy = Math.min(h - 1, Math.max(0, Math.floor(y0 + y / scale)))
      for (let c = 0; c < C; c++) out[c * L * L + y * L + x] = img.data[c * n + sy * w + sx]
    }
  }
  return { width: L, height: L, channels: C as 1 | 3, data: out }
}
function sideBySide(images: ImageData32[]): ImageData32 {
  const W = images.reduce((p, q) => p + q.width + 4, -4)
  const H = Math.max(...images.map((q) => q.height))
  const out = new Float32Array(W * H * C)
  let ox = 0
  for (const im of images) {
    for (let c = 0; c < C; c++) {
      for (let y = 0; y < im.height; y++) {
        for (let x = 0; x < im.width; x++) {
          out[c * W * H + y * W + ox + x] = im.data[c * im.width * im.height + y * im.width + x]
        }
      }
    }
    ox += im.width + 4
  }
  return { width: W, height: H, channels: C as 1 | 3, data: out }
}
function save(img: ImageData32, file: string): void {
  writeFileSync(join(output, file), Buffer.from(encodeBmp(applyStretch(img, stretch))))
}
function reduce(img: ImageData32, f: number): ImageData32 {
  const W = Math.floor(w / f)
  const H = Math.floor(h / f)
  const out = new Float32Array(W * H * C)
  for (let c = 0; c < C; c++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) out[c * W * H + y * W + x] = img.data[c * n + y * f * w + x * f]
    }
  }
  return { width: W, height: H, channels: C as 1 | 3, data: out }
}
// Difference between reconstructed and clean, laid on the background: shows lines,
// blotches or lost stars left by the reconstruction.
const difference = new Float32Array(cleaned.data.length)
for (let c = 0; c < C; c++) {
  for (let i = 0; i < n; i++)
    difference[c * n + i] = backgroundC[c] + result.image.data[c * n + i] - cleaned.data[c * n + i]
}
const diffImage: ImageData32 = { ...cleaned, data: difference }
save(sideBySide([reduce(dirty, 4), reduce(result.image, 4)]), name + '-whole.bmp')
for (const [k, s] of trails.entries()) {
  // Crop around a point of the trail (for the flash, on the flash).
  const t = s.name.startsWith('flash') ? 300 : 0
  const a = (s.degrees * Math.PI) / 180
  const px = s.cx + t * Math.cos(a)
  const py = s.cy + t * Math.sin(a)
  const side = 120
  const x0 = Math.round(px - side / 2)
  const y0 = Math.round(py - side / 2)
  save(
    sideBySide([
      crop(cleaned, x0, y0, side, 3),
      crop(dirty, x0, y0, side, 3),
      crop(result.image, x0, y0, side, 3),
      crop(diffImage, x0, y0, side, 3)
    ]),
    name + '-trail' + (k + 1) + '.bmp'
  )
}
console.log('\nimages in ' + output)
console.log(problems === 0 ? 'RESULT: passed' : 'RESULT: failed (' + problems + ' problems)')
process.exit(problems === 0 ? 0 : 1)
