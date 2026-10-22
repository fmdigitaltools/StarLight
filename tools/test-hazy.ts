/**
 * Check of star detection on hazy frames.
 *
 * With poor transparency (haze, mist, Moon) the background rises and
 * tilts, the star signal drops and the noise grows. If background and
 * noise were measured on the whole image, the background slope would
 * inflate the dispersion, the threshold would rise and the stars found
 * would collapse far more than the lost light justifies.
 * For this reason background and noise are measured per cell
 * (`estimateBackgroundMap` in `detection.ts`): this check makes sure it
 * stays that way.
 *
 * It uses the synthetic frames from `generate-test-fits.mjs` (no license
 * issues) and adds to the raw data, before color reconstruction, a haze:
 * attenuated signal, diffuse light with a slope, the noise of that light,
 * and a few hot pixels. It checks that:
 *  1. a reasonable share of the stars is still found on the hazy frame;
 *  2. the hazy frame aligns on the clean reference, at the same point
 *     where the clean frame aligns;
 *  3. no added hot pixel is mistaken for a star;
 *  4. the score relative to the session puts the hazy frame below the
 *     clean frames, well apart, while the clean ones stay above the
 *     default threshold;
 *  5. a steeply sloped sky without stars produces no fake stars;
 *  6. a band of zeros (edge of a stack or of a mosaic) produces no fake
 *     stars along the boundary.
 *
 * Usage: node <compiled file> [folder of the test frames]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import {
  DEFAULT_MIN_QUALITY,
  relativeQuality,
  detectStars,
  evaluateQuality,
  type Star
} from '../src/core/stars/detection'
import { align } from '../src/core/stack/alignment'
import type { BayerPattern, ImageData32 } from '../src/shared/types'
import { testFile } from './test-files.mjs'

const folder = process.argv[2] ?? testFile('synthetic-frames')
const file = readdirSync(folder)
  .filter((f) => /^Light_.*\.fit$/.test(f))
  .sort()
if (file.length < 2) {
  console.log('At least two test frames are needed in ' + folder)
  process.exit(77)
}

let failedItems = 0
function check(condition: boolean, description: string): void {
  console.log((condition ? '  ok      ' : '  FAILED  ') + description)
  if (!condition) failedItems++
}

function read(name: string): { raw: ImageData32; bayer: BayerPattern } {
  const r = readFits(new Uint8Array(readFileSync(join(folder, name))), name)
  return { raw: r.image, bayer: r.metadata.bayer }
}

/** Deterministic pseudo-random generator and Gaussian noise. */
function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
function gaussian(rnd: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd())
}

const ADU = 65535

/**
 * Haze on the raw data: the light of the sky and of the stars above the
 * background is reduced to `attenuation`, diffuse light is added (`background`
 * ADU plus `slope` ADU from one corner to the other) with its own noise, and
 * the read noise stays what it was.
 */
function makeHazy(raw: ImageData32, attenuation: number, background: number, slope: number): ImageData32 {
  const { width: w, height: h, data } = raw
  const sample = Array.from(data.filter((_, i) => i % 7 === 0)).sort((a, b) => a - b)
  const level = sample[sample.length >> 1]
  // Raw noise from the differences between photosites of the same color two
  // steps apart: the sky gradient does not enter it.
  const differences: number[] = []
  for (let i = 0; i + 2 < data.length; i += 13) differences.push(Math.abs(data[i + 2] - data[i]))
  differences.sort((p, q) => p - q)
  const spread = (differences[differences.length >> 1] * 1.4826) / Math.SQRT2
  const rnd = random(4242)
  const out = new Float32Array(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const diffuse = (background + slope * (0.6 * (x / w) + 0.4 * (y / h))) / ADU
      const noise = Math.sqrt((1 - attenuation * attenuation) * spread * spread + diffuse / ADU)
      out[i] = level + attenuation * (data[i] - level) + diffuse + noise * gaussian(rnd)
    }
  }
  return { ...raw, data: out }
}

/**
 * Hot pixels: single photosites higher than the background, always at the
 * same points. Half very hot, half only warm (about 12 times the raw
 * noise): the latter escape the color check and must be recognized by
 * their shape.
 */
const HOT_PIXELS = Array.from({ length: 80 }, (_, k) => ({
  x: 37 + ((k * 211) % 1000),
  y: 41 + ((k * 389) % 1840),
  amount: k % 2 === 0 ? 0.35 : 0.01
}))
function withHotPixels(raw: ImageData32): ImageData32 {
  const d = Float32Array.from(raw.data)
  for (const p of HOT_PIXELS) d[p.y * raw.width + p.x] = Math.min(1, d[p.y * raw.width + p.x] + p.amount)
  return { ...raw, data: d }
}
/**
 * Stars found on a hot pixel that were not there in the same frame
 * without hot pixels: those that were there are real stars that happen to
 * fall nearby.
 */
function starsOnHot(stars: Star[], withoutHot: Star[]): number {
  return stars.filter(
    (s) =>
      HOT_PIXELS.some((p) => Math.hypot(s.x - p.x, s.y - p.y) < 2.5) &&
      !withoutHot.some((v) => Math.hypot(s.x - v.x, s.y - v.y) < 2)
  ).length
}

const hfr = (stars: Star[]): number => evaluateQuality(stars, 1).medianHfr

// --- Clean and hazy frames ---
const a = read(file[0])
const b = read(file[1])
const ref = debayer(withHotPixels(a.raw), a.bayer)
const cleaned = debayer(withHotPixels(b.raw), b.bayer)
const rawHazy = makeHazy(b.raw, 0.5, 3000, 6000)
const hazyFrame = debayer(withHotPixels(rawHazy), b.bayer)

const all = { max: 1e7 }
const refStars = detectStars(ref)
const cleanStars = detectStars(cleaned)
const hazyStars = detectStars(hazyFrame)
const cleanCount = detectStars(cleaned, all).length
const hazyCount = detectStars(hazyFrame, all).length
console.log(
  'Stars: reference ' + refStars.length + ', clean ' + cleanCount + ', hazy ' + hazyCount +
    ' (' + ((hazyCount / cleanCount) * 100).toFixed(0) + '%)'
)

console.log('1. Stars on the hazy frame')
// With the light reduced to 45% and the background raised many times over,
// the faint stars really disappear: a single threshold would keep less than
// 15% of them, the per-cell one over 40%.
check(hazyCount >= cleanCount * 0.3, 'at least 30% of the stars of the clean frame')

console.log('2. Alignment of the hazy frame')
const alignedClean = align(refStars, cleanStars)
const alignedHazy = align(refStars, hazyStars)
const offset = Math.hypot(
  alignedHazy.transformation.tx - alignedClean.transformation.tx,
  alignedHazy.transformation.ty - alignedClean.transformation.ty
)
console.log(
  '   clean: ' + alignedClean.matchingStars + ' stars, hazy: ' + alignedHazy.matchingStars +
    ' stars, difference ' + offset.toFixed(3) + ' px'
)
check(alignedClean.valid, 'the clean frame aligns')
check(alignedHazy.valid, 'the hazy frame aligns')
check(offset < 0.3, 'at the same point as the clean one (within 0.3 px)')

console.log('3. Hot pixels')
const hotPixels =
  starsOnHot(detectStars(ref, all), detectStars(debayer(a.raw, a.bayer), all)) +
  starsOnHot(detectStars(cleaned, all), detectStars(debayer(b.raw, b.bayer), all)) +
  starsOnHot(detectStars(hazyFrame, all), detectStars(debayer(rawHazy, b.bayer), all))
console.log('   stars found on the ' + HOT_PIXELS.length + ' added hot pixels, over the three frames: ' + hotPixels)
check(hotPixels === 0, 'no hot pixel mistaken for a star')

console.log('4. Score relative to the session')
const relative = relativeQuality(
  [refStars, cleanStars, hazyStars].map((s) => ({ starCount: s.length, medianHfr: hfr(s) }))
)
console.log('   reference ' + relative[0] + ', clean ' + relative[1] + ', hazy ' + relative[2])
check(relative[2] < Math.min(relative[0], relative[1]), 'the hazy one below the clean ones')
check(relative[2] <= 60, 'the hazy one clearly below the clean ones (at most 60)')
check(Math.min(relative[0], relative[1]) >= DEFAULT_MIN_QUALITY, 'the clean ones above the threshold')

console.log('5. Sloped sky without stars')
{
  const w = 800
  const h = 600
  const rnd = random(99)
  const d = new Float32Array(w * h * 3)
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // From 0.02 to 0.32: a difference of 300 times the noise.
        const background = 0.02 + 0.3 * (x / w) * (0.5 + 0.5 * (y / h)) + 0.04 * Math.sin(y / 90)
        d[c * w * h + y * w + x] = background + 0.001 * gaussian(rnd)
      }
  const fake = detectStars({ width: w, height: h, channels: 3, data: d }).length
  console.log('   stars found: ' + fake)
  check(fake <= 2, 'no fake stars (at most 2 noise clumps)')
}

console.log('6. Band of zeros along the edge')
{
  const { width: w, height: h } = cleaned
  const n = w * h
  const clipped = Float32Array.from(cleaned.data)
  const edge = 180
  for (let c = 0; c < 3; c++) for (let y = 0; y < h; y++) clipped.fill(0, c * n + y * w, c * n + y * w + edge)
  const stars = detectStars({ ...cleaned, data: clipped }, all)
  const alongBoundary = stars.filter((s) => s.x < edge + 4).length
  // Real stars falling right on the boundary, in the whole frame.
  const real = detectStars(cleaned, all).filter((s) => s.x >= edge - 2 && s.x < edge + 4).length
  console.log('   stars along the boundary: ' + alongBoundary + ' (real ones in that strip: ' + real + ')')
  check(alongBoundary <= real + 2, 'no row of fake stars on the boundary')
}

if (failedItems > 0) {
  console.log('\n' + failedItems + ' checks failed.')
  process.exit(1)
}
console.log('\nAll good.')
