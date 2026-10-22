/**
 * Check of the Generalized Hyperbolic Stretch (GHS).
 *
 * 1. Numerical checks of the curve: identity with strength 0, fixed
 *    endpoints, monotonicity, continuity and smooth transition between the
 *    cases of b.
 * 2. Test on real images: automatic black point, automatic choice of the
 *    GHS parameters, stretch applied to the luminance with the channels in
 *    proportion (like "preserve color"), saving to BMP.
 *
 * Usage: TEST_SCRIPT=tools/test-ghs.ts node tools/run-test.mjs [file.fit ...]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import type { ImageData32 } from '../src/shared/types'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, mtf } from '../src/core/image/stretch'
import { encodeBmp } from '../src/core/export/encoding'
import { clean, FULL_CLEANUP } from '../src/core/image/cleanup'
import { nlBayes } from '../src/core/image/nlbayes'
import { computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { testFile } from './test-files.mjs'
import {
  ghs,
  buildGhsLut,
  automaticGhs,
  measureGhs,
  NEUTRAL_GHS,
  type GhsParams
} from '../src/core/image/ghs'

const OUTPUT =
  join(tmpdir(), 'starlight-ghs')
mkdirSync(OUTPUT, { recursive: true })

let problems = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  OK   ' : '  ERROR ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) problems++
}

console.log('--- CURVE ---')
{
  const lut = buildGhsLut(NEUTRAL_GHS)
  let rejection = 0
  for (let i = 0; i < lut.length; i++) rejection = Math.max(rejection, Math.abs(lut[i] - i / (lut.length - 1)))
  result('strength 0 = identity', rejection < 1e-6 && lut.length === 4096)

  const valuesB = [-5, -2, -1, -0.5, -1e-9, 0, 1e-9, 0.5, 1, 3, 8, 15]
  const cases: GhsParams[] = []
  for (const b of valuesB)
    for (const D of [0.5, 3, 10])
      for (const [lp, sp, hp] of [[0, 0, 1], [0, 0.1, 1], [0.05, 0.1, 0.6], [0.2, 0.2, 0.2], [0, 1, 1]])
        cases.push({ strength: D, localIntensity: b, symmetryPoint: sp, shadowProtection: lp, highlightProtection: hp })
  let monotonic = true
  let extremes = true
  let jump = 0
  let finished = true
  for (const p of cases) {
    const l = buildGhsLut(p, 20001)
    if (Math.abs(l[0]) > 1e-6 || Math.abs(l[l.length - 1] - 1) > 1e-6) extremes = false
    for (let i = 1; i < l.length; i++) {
      if (!Number.isFinite(l[i])) finished = false
      if (l[i] < l[i - 1] - 1e-6) monotonic = false
    }
    // Continuity around the joins.
    for (const x of [p.shadowProtection, p.symmetryPoint, p.highlightProtection]) {
      // With D = e^10 the slope reaches ~2e4: a step of 1e-12 makes it negligible.
      const d = Math.abs(ghs(x + 1e-12, p) - ghs(x - 1e-12, p))
      if (x > 0 && x < 1) jump = Math.max(jump, d)
    }
  }
  result('0 -> 0 and 1 -> 1', extremes)
  result('always increasing', monotonic)
  result('finite values', finished)
  result('continuous at the joins', jump < 1e-5, 'maximum jump ' + jump.toExponential(2))

  // Smooth transition between the cases: b close to 0 and to -1.
  const base: GhsParams = { strength: 4, localIntensity: 0, symmetryPoint: 0.1, shadowProtection: 0.02, highlightProtection: 0.8 }
  let d0 = 0
  let d1 = 0
  for (let x = 0; x <= 1; x += 0.001) {
    d0 = Math.max(d0, Math.abs(ghs(x, { ...base, localIntensity: 1e-4 }) - ghs(x, base)))
    d1 = Math.max(d1, Math.abs(ghs(x, { ...base, localIntensity: -1 + 1e-4 }) - ghs(x, { ...base, localIntensity: -1 })))
  }
  result('b -> 0 tends to the exponential', d0 < 1e-3, d0.toExponential(2))
  result('b -> -1 tends to the logarithm', d1 < 1e-3, d1.toExponential(2))
}

console.log('--- EDGE CASES OF THE AUTOMATIC CHOICE ---')
{
  const blank: ImageData32 = { width: 64, height: 48, channels: 3, data: new Float32Array(64 * 48 * 3) }
  const pv = automaticGhs(blank, 0, 1)
  result('black image: finite parameters', Object.values(pv).every((v) => Number.isFinite(v)), JSON.stringify(pv))
  const flatLine: ImageData32 = { width: 64, height: 48, channels: 1, data: new Float32Array(64 * 48).fill(0.3) }
  const pp = automaticGhs(flatLine, 0.3, 0.3)
  result('uniform image, black = white: finite parameters', Object.values(pp).every((v) => Number.isFinite(v)))
}

/** "Preserve color" stretch with black/white points and the GHS LUT applied to the luminance. */
function applyStretch(img: ImageData32, black: number, white: number, lut: Float32Array): ImageData32 {
  const n = img.width * img.height
  const ch = img.channels
  const out = new Float32Array(img.data.length)
  const iv = 1 / Math.max(1e-6, white - black)
  const last = lut.length - 1
  const rgb = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    let l = 0
    for (let c = 0; c < ch; c++) {
      rgb[c] = Math.max(0, (img.data[c * n + i] - black) * iv)
      l += rgb[c]
    }
    l /= ch
    const t = Math.min(1, l) * last
    const j = Math.min(last - 1, Math.floor(t))
    const ld = lut[j] + (lut[j + 1] - lut[j]) * (t - j)
    const k = l > 1e-6 ? ld / l : 0
    let max = 0
    for (let c = 0; c < ch; c++) {
      rgb[c] *= k
      if (rgb[c] > max) max = rgb[c]
    }
    for (let c = 0; c < ch; c++) out[c * n + i] = max > 1 ? rgb[c] / max : rgb[c]
  }
  return { ...img, data: out }
}

function save(img: ImageData32, name: string): void {
  writeFileSync(join(OUTPUT, name), Buffer.from(encodeBmp(img)))
}

/**
 * "Abracadabra-like" version: hot pixels, background, color and NL-Bayes on
 * the luminance (same sigma and same way of carrying the correction over to
 * the channels as nlbayesParallel). Single-core NL-Bayes is slow: the
 * result is kept in the output folder and reused.
 */
function cleanVersion(img: ImageData32, name: string): ImageData32 {
  const cache = join(OUTPUT, name + '-cleaned.f32')
  const n = img.width * img.height
  if (existsSync(cache)) {
    const b = readFileSync(cache)
    return { ...img, data: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
  }
  const t0 = performance.now()
  const a = clean(img, { ...FULL_CLEANUP, lightNoise: 0, sharpness: 0 }).image
  const y = new Float32Array(n)
  for (let k = 0; k < a.channels; k++) for (let i = 0; i < n; i++) y[i] += a.data[k * n + i] / a.channels
  const sigma = computeStats(y).mad * MAD_TO_SIGMA * 2.2
  const cleaned = nlBayes(y, a.width, a.height, sigma)
  const data = a.data.slice()
  for (let i = 0; i < n; i++) {
    const delta = cleaned[i] - y[i]
    for (let k = 0; k < a.channels; k++) data[k * n + i] += delta
  }
  writeFileSync(cache, Buffer.from(data.buffer))
  console.log('cleanup + NL-Bayes: ' + ((performance.now() - t0) / 1000).toFixed(0) + ' s')
  return { ...a, data }
}

function test(img: ImageData32, name: string): void {
  const st = autoStretch(img)
  const black = st.shadows
  const white = st.highlights

  let t0 = performance.now()
  const m = measureGhs(img, black, white)
  const tMeasure = performance.now() - t0
  t0 = performance.now()
  const p = automaticGhs(img, black, white)
  const tAuto = performance.now() - t0
  const short = (_k: string, v: unknown): unknown => (typeof v === 'number' ? +v.toPrecision(4) : v)
  console.log('measurements: ' + JSON.stringify(m, short))
  console.log('parameters: ' + JSON.stringify(p, short))
  console.log('time: measurement ' + tMeasure.toFixed(0) + ' ms, automatic (measurement included) ' + tAuto.toFixed(0) + ' ms')

  const fG = (x: number): number => ghs(x, p)
  const fM = (x: number): number => mtf(Math.min(1, Math.max(0, x)), st.midtones)
  const outputNoise = (f: (x: number) => number, x: number): string =>
    ((f(x + m.noise) - f(Math.max(0, x - m.noise))) / 2).toFixed(3)
  for (const [label, f] of [['GHS', fG], ['MTF', fM]] as const) {
    console.log(
      label + ': sky ' + f(m.sky).toFixed(3) + ', body ' + f(m.body).toFixed(3) +
      ', core ' + f(m.core).toFixed(3) + ', stars ' + f(m.stars).toFixed(3) +
      ', sky/body noise ' + outputNoise(f, m.sky) + ' / ' + outputNoise(f, m.body)
    )
  }

  t0 = performance.now()
  const lut = buildGhsLut(p)
  const done = applyStretch(img, black, white, lut)
  console.log('apply time ' + (performance.now() - t0).toFixed(0) + ' ms')
  save(done, name + '-ghs.bmp')

  // Comparison: the classic stretch (MTF) of the same program.
  const mtfLut = new Float32Array(4096)
  for (let i = 0; i < 4096; i++) mtfLut[i] = fM(i / 4095)
  save(applyStretch(img, black, white, mtfLut), name + '-mtf.bmp')
}

const args = process.argv.slice(2)
const onlyRaw = args.includes('--raw')
const file = args.filter((a) => !a.startsWith('--'))
const list = file.length > 0 ? file : [testFile('m27'), testFile('m33'), testFile('ngc7000')]

for (const path of list) {
  const name = basename(path, '.fit')
  const readResult = readFits(new Uint8Array(readFileSync(path)))
  const img = debayer(readResult.image, readResult.metadata.bayer)
  console.log('--- ' + name + ' (raw) ---')
  test(img, name + '-raw')
  if (onlyRaw) continue
  console.log('--- ' + name + ' (cleaned) ---')
  test(cleanVersion(img, name), name + '-cleaned')
}

console.log(problems === 0 ? 'All good.' : problems + ' problems.')
// Result for the aggregate runner (npm run test): exit code 1 if anything failed.
if (problems > 0) process.exitCode = 1
