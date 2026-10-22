/**
 * Test of partial trails (src/core/image/trails.ts).
 *
 * Synthetic trails of every kind are added to a clean real file (whole,
 * ending midway, starting and ending inside, dashed, double and triple
 * parallel, faint, short) together with objects that are NOT trails
 * (edge-on galaxies, a curved filament, a straight filament of irregular
 * width). The test checks that the trails are found and reconstructed only
 * where present, and that the other objects are left alone. A second test
 * puts a thin edge-on galaxy inside a protected zone (as if the catalog
 * placed it there).
 *
 * Usage: TEST_SCRIPT=tools/test-partial-trails.ts node tools/run-test.mjs file.fit [output-folder]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { deflateSync } from 'node:zlib'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch, type StretchParams } from '../src/core/image/stretch'
import { medianAndMad } from '../src/core/image/selection'
import { MAD_TO_SIGMA } from '../src/core/image/stats'
import { blur } from '../src/core/image/cleanup'
import { detectTrails, removeTrails, automaticTrails, type Trail, type ProtectedZone } from '../src/core/image/trails'
import type { ImageData32 } from '../src/shared/types'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('m33')
if (!existsSync(path)) {
  console.log('Missing ' + path + ': test skipped.')
  process.exit(77)
}
/** Problems found: if there is at least one, the test fails (exit code 1). */
const problems: string[] = []
const output = process.argv[3] ?? '.'
mkdirSync(output, { recursive: true })
const name = basename(path).replace(/\.fits?$/i, '')

const readResult = readFits(new Uint8Array(readFileSync(path)), path)
const cleaned = debayer(readResult.image, readResult.metadata.bayer)
const w = cleaned.width
const h = cleaned.height
const n = w * h
const C = cleaned.channels
console.log(name + ': ' + w + ' x ' + h + ', ' + C + ' channels')

const sigmaC: number[] = []
const backgroundC: number[] = []
for (let c = 0; c < C; c++) {
  const p = cleaned.data.subarray(c * n, (c + 1) * n)
  const smoothed = blur(p, w, h, 8)
  const end = new Float32Array(n)
  for (let i = 0; i < n; i++) end[i] = p[i] - smoothed[i]
  sigmaC.push(medianAndMad(end).mad * MAD_TO_SIGMA)
  backgroundC.push(medianAndMad(p).median)
}
const meanSigma = sigmaC.reduce((a, b) => a + b, 0) / C

let seed = 12345
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
  return (seed + 0.5) / 4294967296
}
function gauss(): number {
  return Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())
}

/**
 * Synthetic trail: segment from t = from to t = a along the line through
 * (cx, cy) at the given angle; `amplitude(t)` in noise units; `rows` are
 * the distances of the parallel lines from the line.
 */
interface Synthetic {
  name: string
  cx: number
  cy: number
  degrees: number
  fwhm: number
  from: number
  a: number
  amplitude: (t: number) => number
  rows?: number[]
  color?: [number, number, number]
}

function drawTrail(data: Float32Array, s: Synthetic): void {
  const an = (s.degrees * Math.PI) / 180
  const dx = Math.cos(an)
  const dy = Math.sin(an)
  const sd = s.fwhm / 2.3548
  const rows = s.rows ?? [0]
  const radius = Math.ceil(sd * 5) + Math.max(...rows.map(Math.abs))
  const color = s.color ?? [1, 1, 1]
  // Box that contains the segment.
  const xs = [s.cx + s.from * dx, s.cx + s.a * dx]
  const ys = [s.cy + s.from * dy, s.cy + s.a * dy]
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - radius - 2))
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + radius + 2))
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - radius - 2))
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) + radius + 2))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = (x - s.cx) * dx + (y - s.cy) * dy
      if (t < s.from - 3 * sd || t > s.a + 3 * sd) continue
      const d = (x - s.cx) * -dy + (y - s.cy) * dx
      // Rounded ends, like a star that starts or stops moving.
      const long =
        t < s.from
          ? Math.exp(-((t - s.from) ** 2) / (2 * sd * sd))
          : t > s.a
            ? Math.exp(-((t - s.a) ** 2) / (2 * sd * sd))
            : 1
      let profile = 0
      for (const r of rows) profile += Math.exp(-((d - r) ** 2) / (2 * sd * sd))
      const signal = s.amplitude(Math.max(s.from, Math.min(s.a, t))) * meanSigma * profile * long
      if (signal <= 0) continue
      for (let c = 0; c < C; c++) {
        const v = signal * color[c]
        const gain = (sigmaC[c] * sigmaC[c]) / Math.max(1e-4, backgroundC[c])
        const i = c * n + y * w + x
        data[i] = Math.min(1, data[i] + v + Math.sqrt(Math.max(0, v * gain)) * gauss())
      }
    }
  }
}

/** Edge-on galaxy: exponential profile, nucleus, dust lane. */
function drawGalaxy(
  data: Float32Array,
  cx: number,
  cy: number,
  degrees: number,
  L: number,
  B: number,
  strength: number
): void {
  const an = (degrees * Math.PI) / 180
  const dx = Math.cos(an)
  const dy = Math.sin(an)
  const R = 4 * L
  for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, cy + R); y++) {
    for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
      const t = (x - cx) * dx + (y - cy) * dy
      const d = (x - cx) * -dy + (y - cy) * dx
      const r = Math.sqrt((t / L) ** 2 + (d / B) ** 2)
      if (r > 4) continue
      let v = strength * Math.exp(-r * 3) + 5 * strength * Math.exp(-((t / (L * 0.08)) ** 2 + (d / (B * 0.5)) ** 2))
      v *= 1 - 0.6 * Math.exp(-((d / (B * 0.12)) ** 2)) * Math.exp(-((t / L) ** 2))
      for (let c = 0; c < C; c++) data[c * n + y * w + x] += v * meanSigma * [1.1, 1, 0.85][c]
    }
  }
}

/** Filament: circular arc (curved) or straight line, with irregular width and brightness. */
function drawFilament(
  data: Float32Array,
  cx: number,
  cy: number,
  curveRadius: number,
  start: number,
  end: number,
  strength: number,
  irregular: boolean
): void {
  // Points along the curve, one per pixel.
  const length = Math.abs(end - start) * (curveRadius > 0 ? curveRadius : 1)
  for (let s = 0; s < length; s += 0.5) {
    const u = s / length
    let px: number
    let py: number
    if (curveRadius > 0) {
      const a = start + (end - start) * u
      px = cx + curveRadius * Math.cos(a)
      py = cy + curveRadius * Math.sin(a)
    } else {
      px = cx + (start + (end - start) * u) * Math.cos(1.1)
      py = cy + (start + (end - start) * u) * Math.sin(1.1)
    }
    const width = irregular ? 3 + 2.5 * Math.sin(u * 17) + 1.5 * Math.sin(u * 41) : 3
    const sd = Math.max(1, width) / 2.3548
    const amp = (strength * (irregular ? 0.6 + 0.4 * Math.sin(u * 23) * Math.sin(u * 7) : 1) * 0.5) / sd
    for (let y = Math.floor(py - 4 * sd); y <= py + 4 * sd; y++) {
      for (let x = Math.floor(px - 4 * sd); x <= px + 4 * sd; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const r2 = (x - px) ** 2 + (y - py) ** 2
        const v = amp * Math.exp(-r2 / (2 * sd * sd)) * meanSigma * 0.25
        for (let c = 0; c < C; c++) data[c * n + y * w + x] += v
      }
    }
  }
}

const dash =
  (period: number, filled: number, amplitude: number) =>
  (t: number): number =>
    ((t % period) + period) % period < filled ? amplitude : 0

const m = Math.min(w, h)
const trails: Synthetic[] = [
  { name: 'bright whole', cx: w * 0.5, cy: h * 0.5, degrees: 23, fwhm: 3.5, from: -1e5, a: 1e5, amplitude: () => 25 },
  { name: 'faint whole', cx: w * 0.4, cy: h * 0.45, degrees: 97, fwhm: 3.5, from: -1e5, a: 1e5, amplitude: () => 1 },
  // Satellite entering the shadow: bright up to the middle, then fading out over 60 px.
  {
    name: 'half shadow',
    cx: w * 0.5,
    cy: h * 0.3,
    degrees: 160,
    fwhm: 4,
    from: -1e5,
    a: 0.1 * m,
    amplitude: (t) => 8 * Math.min(1, Math.max(0, (0.1 * m - t) / 60))
  },
  // Starts and ends inside the field.
  {
    name: 'inside-inside',
    cx: w * 0.3,
    cy: h * 0.8,
    degrees: 71,
    fwhm: 3.5,
    from: -0.25 * m,
    a: 0.25 * m,
    amplitude: () => 5
  },
  // Airplane: three parallel lines 9 px apart, with dashes (blinking lights).
  {
    name: 'airplane three lines',
    cx: w * 0.65,
    cy: h * 0.6,
    degrees: 128,
    fwhm: 3.5,
    from: -0.35 * m,
    a: 1e5,
    amplitude: dash(70, 35, 20),
    rows: [-9, 0, 9]
  },
  // Airplane: one line, sparse dashes.
  {
    name: 'sparse dashes',
    cx: w * 0.2,
    cy: h * 0.25,
    degrees: 8,
    fwhm: 3.5,
    from: -0.3 * m,
    a: 0.3 * m,
    amplitude: dash(50, 18, 15)
  },
  // Faint partial trail.
  {
    name: 'faint partial',
    cx: w * 0.75,
    cy: h * 0.2,
    degrees: 105,
    fwhm: 3.5,
    from: -0.4 * m,
    a: 0.3 * m,
    amplitude: () => 1.5
  },
  // Short but bright.
  { name: 'short', cx: w * 0.15, cy: h * 0.55, degrees: 41, fwhm: 4, from: -130, a: 130, amplitude: () => 10 },
  // Colored flash on a partial trail.
  {
    name: 'partial flash',
    cx: w * 0.8,
    cy: h * 0.85,
    degrees: 3,
    fwhm: 3,
    from: -0.3 * m,
    a: 0.2 * m,
    amplitude: (t) => 1.5 + 60 * Math.exp(-((t / 120) ** 2)),
    color: [1.2, 0.8, 0.45]
  }
]

const angleDifference = (a: number, b: number): number => Math.abs(((((a - b) % 180) + 270) % 180) - 90)
function print(s: Trail): string {
  return (
    'angle ' +
    s.angle.toFixed(2) +
    '° width ' +
    s.width.toFixed(1) +
    ' fwhm ' +
    s.fwhm.toFixed(2) +
    ' cov ' +
    Math.round(s.coverage * 100) +
    '% ' +
    (s.whole ? 'whole' : 'partial') +
    (s.lines > 1 ? ' lines ' + s.lines : '') +
    ' strength ' +
    s.strength.toFixed(1) +
    ' (' +
    s.x1.toFixed(0) +
    ',' +
    s.y1.toFixed(0) +
    ')-(' +
    s.x2.toFixed(0) +
    ',' +
    s.y2.toFixed(0) +
    ')'
  )
}
function time<T>(f: () => T): [T, number] {
  const t0 = performance.now()
  const r = f()
  return [r, performance.now() - t0]
}

/** Ends of the synthetic trail inside the image. */
function extremes(s: Synthetic): [number, number, number, number] {
  const an = (s.degrees * Math.PI) / 180
  const dx = Math.cos(an)
  const dy = Math.sin(an)
  // clipping of the line to the image
  let ta = -Infinity
  let tb = Infinity
  for (const [p, d, hi] of [
    [s.cx, dx, w - 1],
    [s.cy, dy, h - 1]
  ]) {
    if (Math.abs(d) < 1e-12) continue
    let u = (0 - p) / d
    let v = (hi - p) / d
    if (u > v) [u, v] = [v, u]
    ta = Math.max(ta, u)
    tb = Math.min(tb, v)
  }
  ta = Math.max(ta, s.from)
  tb = Math.min(tb, s.a)
  return [s.cx + ta * dx, s.cy + ta * dy, s.cx + tb * dx, s.cy + tb * dy]
}

// --- 1. Clean file ---
console.log('\n--- CLEAN FILE ---')
const auto = automaticTrails(cleaned)
for (const s of [0.5, auto.sensitivity, 1]) {
  const [foundAll, ms] = time(() => detectTrails(cleaned, s))
  console.log('sensitivity ' + s + ': ' + foundAll.length + ' trails (' + ms.toFixed(0) + ' ms)')
  for (const t of foundAll) {
    console.log('   FALSE POSITIVE ' + print(t))
    problems.push('false positive ' + print(t))
  }
}

// --- 2. Objects that are not trails ---
console.log('\n--- ELONGATED OBJECTS THAT ARE NOT TRAILS ---')
const objects = cleaned.data.slice()
// Like NGC 891: large and bright.
drawGalaxy(objects, w * 0.3, h * 0.7, 35, m * 0.16, (m * 0.16) / 9, 60)
// Like NGC 4565: long and very thin, fainter.
const thinGalaxy = { cx: w * 0.7, cy: h * 0.35, degrees: 140, L: m * 0.22, B: (m * 0.22) / 14 }
drawGalaxy(
  objects,
  thinGalaxy.cx,
  thinGalaxy.cy,
  thinGalaxy.degrees,
  thinGalaxy.L,
  thinGalaxy.B,
  25
)
// Curved filament (radius 1500 px, 40°).
drawFilament(objects, w * 0.5 - 1500, h * 0.5, 1500, -0.35, 0.35, 12, false)
// Straight but irregular filament (wide and bright in places).
drawFilament(objects, w * 0.15, h * 0.1, 0, 0, m * 0.6, 14, true)
const withObjects: ImageData32 = { ...cleaned, data: objects }
for (const s of [0.5, 1]) {
  const foundAll = detectTrails(withObjects, s)
  console.log('sensitivity ' + s + ': ' + foundAll.length + ' trails')
  for (const t of foundAll) {
    console.log('   FALSE POSITIVE ' + print(t))
    problems.push('false positive ' + print(t))
  }
}

// --- 3. Synthetic trails ---
console.log('\n--- SYNTHETIC TRAILS ---')
const dirtyData = cleaned.data.slice()
for (const s of trails) drawTrail(dirtyData, s)
const dirty: ImageData32 = { ...cleaned, data: dirtyData }
const [result, ms] = time(() => removeTrails(dirty, auto))
console.log(
  'automatic sensitivity ' +
    auto.sensitivity +
    ': found ' +
    result.trails.length +
    ' (' +
    ms.toFixed(0) +
    ' ms, detection and reconstruction)'
)
const grips = new Set<Trail>()
for (const s of trails) {
  const [x1, y1, x2, y2] = extremes(s)
  const grip = result.trails.find((t) => {
    if (angleDifference(t.angle, s.degrees) > 1) return false
    const lx = t.x2 - t.x1
    const ly = t.y2 - t.y1
    const L = Math.hypot(lx, ly)
    return Math.abs(((s.cx - t.x1) * ly - (s.cy - t.y1) * lx) / L) < 12
  })
  if (grip) grips.add(grip)
  let note = ''
  if (grip) {
    // Deviation of the ends along the line, in pixels (the direction may be reversed).
    const e1 = Math.min(
      Math.hypot(grip.x1 - x1, grip.y1 - y1) + Math.hypot(grip.x2 - x2, grip.y2 - y2),
      Math.hypot(grip.x1 - x2, grip.y1 - y2) + Math.hypot(grip.x2 - x1, grip.y2 - y1)
    )
    note =
      '  [ends: total deviation ' +
      e1.toFixed(0) +
      ' px; true from (' +
      x1.toFixed(0) +
      ',' +
      y1.toFixed(0) +
      ') a (' +
      x2.toFixed(0) +
      ',' +
      y2.toFixed(0) +
      ')]'
  }
  console.log('  ' + s.name.padEnd(18) + (grip ? 'FOUND  ' + print(grip) + note : 'MISSED'))
  if (!grip) problems.push('missed trail: ' + s.name)
}
for (const t of result.trails) {
  if (grips.has(t)) continue
  console.log('  extra: ' + print(t))
  problems.push('extra trail: ' + print(t))
}

// Pixels changed far from the synthetic trails: there should be none.
let changedOutside = 0
let changedItems = 0
const neighbor = new Uint8Array(n)
for (const s of trails) {
  const [x1, y1, x2, y2] = extremes(s)
  const L = Math.hypot(x2 - x1, y2 - y1)
  const ux = (x2 - x1) / L
  const uy = (y2 - y1) / L
  const R = 40 + Math.max(0, ...(s.rows ?? [0]).map(Math.abs))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x - x1) * ux + (y - y1) * uy
      if (t < -60 || t > L + 60) continue
      if (Math.abs((x - x1) * -uy + (y - y1) * ux) <= R) neighbor[y * w + x] = 1
    }
  }
}
for (let i = 0; i < n; i++) {
  if (result.image.data[i] !== dirty.data[i]) {
    changedItems++
    if (!neighbor[i]) changedOutside++
  }
}
console.log('changed pixels: ' + changedItems + ', far from the synthetic trails: ' + changedOutside)

// Residual along each trail, compared with the clean file.
console.log('\n  reconstruction (noise units; ideal: mean deviation ~0):')
for (const s of trails) {
  const an = (s.degrees * Math.PI) / 180
  const dx = Math.cos(an)
  const dy = Math.sin(an)
  const rows = s.rows ?? [0]
  let sum = 0
  let count = 0
  let before = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x - s.cx) * dx + (y - s.cy) * dy
      if (t < s.from || t > s.a) continue
      const d = (x - s.cx) * -dy + (y - s.cy) * dx
      if (!rows.some((r) => Math.abs(d - r) <= Math.max(1.5, s.fwhm / 2))) continue
      for (let c = 0; c < C; c++) {
        const i = c * n + y * w + x
        const r = (result.image.data[i] - cleaned.data[i]) / sigmaC[c]
        if (Math.abs(r) > 30) continue
        sum += r
        before += (dirty.data[i] - cleaned.data[i]) / sigmaC[c]
        count++
      }
    }
  }
  console.log(
    '  ' +
      s.name.padEnd(18) +
      'mean trail ' +
      (before / Math.max(1, count)).toFixed(2) +
      ' → after ' +
      (sum / Math.max(1, count)).toFixed(3)
  )
  // Remainder of the trail after reconstruction: beyond half a noise
  // deviation, on average, a piece remained (or the background is wrong).
  if (Math.abs(sum / Math.max(1, count)) > 0.5) problems.push('incomplete reconstruction: ' + s.name)
}

// --- 4. Protected zone ---
console.log('\n--- PROTECTED ZONE (position and shape from the catalog) ---')
const galAngle = (thinGalaxy.degrees * Math.PI) / 180
const zone: ProtectedZone = {
  cx: thinGalaxy.cx,
  cy: thinGalaxy.cy,
  semiMajor: thinGalaxy.L * 1.2,
  semiMinor: thinGalaxy.B * 1.2,
  angle: galAngle
}
// Extreme case: inside the zone, an object that by shape would be a trail
// (straight, as wide as a star, constant brightness) along the axis of
// the galaxy. Without the zone it is caught, with the zone it is not.
const asTrail = cleaned.data.slice()
drawTrail(asTrail, {
  name: 'x',
  cx: zone.cx,
  cy: zone.cy,
  degrees: thinGalaxy.degrees,
  fwhm: 3.5,
  from: -thinGalaxy.L,
  a: thinGalaxy.L,
  amplitude: () => 6
})
for (const s of [0.5, 1]) {
  const without = detectTrails({ ...cleaned, data: asTrail }, s).length
  const combined = detectTrails({ ...cleaned, data: asTrail }, s, [zone]).length
  console.log('sensitivity ' + s + ': without zone ' + without + ', with zone ' + combined + ' (expected: 1, 0)')
  if (without !== 1 || combined !== 0) problems.push('protected zone, sensitivity ' + s + ': ' + without + ', ' + combined)
}
// A real trail crossing the protected zone must still be caught.
const crosses = cleaned.data.slice()
drawGalaxy(crosses, zone.cx, zone.cy, thinGalaxy.degrees, thinGalaxy.L, thinGalaxy.B, 25)
drawTrail(crosses, {
  name: 'x',
  cx: zone.cx,
  cy: zone.cy,
  degrees: thinGalaxy.degrees + 3,
  fwhm: 3.5,
  from: -1e5,
  a: 1e5,
  amplitude: () => 6
})
const cross = detectTrails({ ...cleaned, data: crosses }, 0.5, [zone])
console.log('whole trail almost parallel to the protected galaxy: ' + cross.map(print).join(' | '))
if (cross.length !== 1 || !cross[0].whole) problems.push('whole trail inside the protected zone not caught')

// --- Images ---
const stretch: StretchParams = autoStretch(cleaned)
function png(img: ImageData32, file: string): void {
  const s = applyStretch(img, stretch)
  const W = s.width
  const H = s.height
  const rows = Buffer.alloc((W * 3 + 1) * H)
  const N = W * H
  for (let y = 0; y < H; y++) {
    rows[y * (W * 3 + 1)] = 0
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        const v = s.data[(s.channels === 3 ? c * N : 0) + y * W + x]
        rows[y * (W * 3 + 1) + 1 + x * 3 + c] = Math.max(0, Math.min(255, Math.round(v * 255)))
      }
    }
  }
  const crc = (b: Buffer): number => {
    let c = ~0
    for (const x of b) {
      c ^= x
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
    return ~c >>> 0
  }
  const piece = (type: string, data: Buffer): Buffer => {
    const l = Buffer.alloc(4)
    l.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([l, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  writeFileSync(
    join(output, file),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      piece('IHDR', ihdr),
      piece('IDAT', deflateSync(rows)),
      piece('IEND', Buffer.alloc(0))
    ])
  )
}
function crop(img: ImageData32, x0: number, y0: number, lw: number, lh: number, scale: number): ImageData32 {
  const W = lw * scale
  const H = lh * scale
  const out = new Float32Array(W * H * C)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, Math.floor(x0 + x / scale)))
      const sy = Math.min(h - 1, Math.max(0, Math.floor(y0 + y / scale)))
      for (let c = 0; c < C; c++) out[c * W * H + y * W + x] = img.data[c * n + sy * w + sx]
    }
  }
  return { width: W, height: H, channels: C as 1 | 3, data: out }
}
function sideBySide(images: ImageData32[]): ImageData32 {
  const W = images.reduce((p, q) => p + q.width + 4, -4)
  const H = Math.max(...images.map((q) => q.height))
  const out = new Float32Array(W * H * C)
  let ox = 0
  for (const im of images) {
    for (let c = 0; c < C; c++) {
      for (let y = 0; y < im.height; y++) {
        for (let x = 0; x < im.width; x++)
          out[c * W * H + y * W + ox + x] = im.data[c * im.width * im.height + y * im.width + x]
      }
    }
    ox += im.width + 4
  }
  return { width: W, height: H, channels: C as 1 | 3, data: out }
}
function reduce(img: ImageData32, f: number): ImageData32 {
  const W = Math.floor(w / f)
  const H = Math.floor(h / f)
  const out = new Float32Array(W * H * C)
  for (let c = 0; c < C; c++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // block mean: thin trails remain visible
        let s = 0
        for (let yy = 0; yy < f; yy++)
          for (let xx = 0; xx < f; xx++) s += img.data[c * n + (y * f + yy) * w + x * f + xx]
        out[c * W * H + y * W + x] = s / (f * f)
      }
    }
  }
  return { width: W, height: H, channels: C as 1 | 3, data: out }
}
png(sideBySide([reduce(dirty, 4), reduce(result.image, 4)]), name + '-whole-before-after.png')
png(reduce(withObjects, 4), name + '-objects-not-trails.png')
for (const [k, s] of trails.entries()) {
  const [x1, y1, x2, y2] = extremes(s)
  // Crop on the inner end (where the trail stops), or at the center.
  const inner = s.a < 1e4 ? [x2, y2] : s.from > -1e4 ? [x1, y1] : [(x1 + x2) / 2, (y1 + y2) / 2]
  const side = 160
  const x0 = Math.round(inner[0] - side / 2)
  const y0 = Math.round(inner[1] - side / 2)
  png(
    sideBySide([
      crop(cleaned, x0, y0, side, side, 2),
      crop(dirty, x0, y0, side, side, 2),
      crop(result.image, x0, y0, side, side, 2)
    ]),
    name + '-trail' + (k + 1) + '-' + s.name.replace(/ /g, '-') + '.png'
  )
}
console.log('\nimages in ' + output + ' (crops: clean | with trail | reconstructed)')
if (problems.length === 0) console.log('RESULT: passed')
else console.log('RESULT: failed\n  ' + problems.join('\n  '))
process.exit(problems.length === 0 ? 0 : 1)
