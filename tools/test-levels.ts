/**
 * Check of the levels shown by the histogram and the curve editor.
 *
 * Verifies that (1) the "final" histogram, computed on a sample, has the
 * same distribution as the full-resolution export with the photographic
 * filter on; (2) the filter and the color adjustments, which act after the
 * curves, do not change the levels entering the curves; (3) the light
 * curve receives the channels already passed through the channel curves;
 * (4) with "preserve color" the input of the light curve is the stretched
 * luminance. It uses a synthetic image: no files.
 *
 * Usage: node tools/run-tests.mjs --only levels
 */
import type { ImageData32 } from '../src/shared/types'
import { applyCorrections, type CorrectionParams } from '../src/core/export/processing'
import { effectiveFilter } from '../src/core/image/photoFilters'
import { NEUTRAL_CURVES, NEUTRAL_CURVE } from '../src/core/image/curve'
import { computeHistogram, computeStats } from '../src/core/image/stats'
import { mtf } from '../src/core/image/stretch'
import { sampleLevels, levelsHistograms } from '../src/core/image/levels'

let problems = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  OK   ' : '  ERROR ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) problems++
}

/** Maximum distance between the cumulative distributions of two histograms. */
function distance(a: Uint32Array, b: Uint32Array): number {
  let ta = 0
  let tb = 0
  for (let i = 0; i < a.length; i++) {
    ta += a[i]
    tb += b[i]
  }
  let ca = 0
  let cb = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    ca += a[i] / ta
    cb += b[i] / tb
    max = Math.max(max, Math.abs(ca - cb))
  }
  return max
}

/* ---- Synthetic image: background with gradient and noise, a nebula, stars ---- */
const W = 1200
const H = 800
const n = W * H
const data = new Float32Array(n * 3)
let seed = 12345
const testCase = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x
    const dx = (x - W * 0.55) / (W * 0.18)
    const dy = (y - H * 0.45) / (H * 0.22)
    const nebula = 0.08 * Math.exp(-(dx * dx + dy * dy))
    const gradient = 0.01 * (x / W)
    const noise = (testCase() - 0.5) * 0.01
    data[i] = 0.05 + gradient + nebula * 1.2 + noise
    data[n + i] = 0.055 + gradient + nebula * 0.6 + noise
    data[2 * n + i] = 0.06 + gradient * 0.5 + nebula * 0.9 + noise
  }
}
for (let s = 0; s < 400; s++) {
  const cx = Math.floor(testCase() * W)
  const cy = Math.floor(testCase() * H)
  const light = 0.2 + testCase() * 0.8
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const v = light * Math.exp(-(dx * dx + dy * dy) / 2)
      for (let c = 0; c < 3; c++) data[c * n + y * W + x] += v
    }
  }
}
const image: ImageData32 = { width: W, height: H, channels: 3, data: data }
const background: [number, number, number] = [0, 1, 2].map(
  (c) => computeStats(data.subarray(c * n, (c + 1) * n)).median
) as [number, number, number]

const base: CorrectionParams = {
  stretch: { shadows: 0.045, midtones: 0.08, highlights: 1 },
  brightness: 0,
  contrast: 0,
  saturation: 0,
  redGain: 1,
  greenGain: 1,
  blueGain: 1,
  gamma: 1,
  noiseReduction: 0,
  sharpness: 0,
  backgroundNeutralization: 0.5,
  skyBackground: background,
  preserveColor: false,
  curves: NEUTRAL_CURVES
}
// Strong filter, with vignetting: it depends on the pixel position.
const filter = effectiveFilter('deep-sky', 1, 0.2, 0.6)
const withFilter: CorrectionParams = { ...base, contrast: 0.15, saturation: 0.2, filter }

const sample = sampleLevels(image)
const bins = 256

console.log('--- FINAL HISTOGRAM: SAMPLE VERSUS WHOLE EXPORT ---')
const whole = computeHistogram(applyCorrections(image, withFilter), bins)
const final = levelsHistograms(sample, withFilter, 'final', bins)
result('three channels', final.length === 3)
for (let c = 0; c < 3; c++) {
  const d = distance(final[c], whole[c])
  result('channel ' + c + ': same distribution', d < 0.01, 'cumulative difference ' + d.toFixed(4))
}
const withoutFilter = levelsHistograms(sample, base, 'final', bins)
const dFilter = distance(final[1], withoutFilter[1])
result('the filter changes the final histogram', dFilter > 0.05, 'difference ' + dFilter.toFixed(3))

console.log('--- CURVE INPUT ---')
const baseInput = levelsHistograms(sample, base, 'curvesInput', bins, 'red')
const filterInput = levelsHistograms(sample, withFilter, 'curvesInput', bins, 'red')
result(
  'filter and color (after the curves) do not change it',
  [0, 1, 2].every((c) => distance(baseInput[c], filterInput[c]) === 0)
)
const redCurve = [
  { x: 0, y: 0 },
  { x: 0.3, y: 0.55 },
  { x: 1, y: 1 }
]
const lightCurve = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0.2 },
  { x: 1, y: 1 }
]
const withCurves: CorrectionParams = {
  ...base,
  curves: { light: lightCurve, red: redCurve, green: NEUTRAL_CURVE, blue: NEUTRAL_CURVE }
}
const redInput = levelsHistograms(sample, withCurves, 'curvesInput', bins, 'red')
result('the red curve does not change its own input', distance(redInput[0], baseInput[0]) === 0)
const lightInput = levelsHistograms(sample, withCurves, 'curvesInput', bins, 'light')
const dLight = distance(lightInput[0], baseInput[0])
result('the light curve receives the already-curved red', dLight > 0.05, 'difference ' + dLight.toFixed(3))
const dGreen = distance(lightInput[1], baseInput[1])
// The neutral curve tables round off by a hair: minimal tolerance.
result('…and the untouched green', dGreen < 0.002, 'difference ' + dGreen.toFixed(4))
// The light curve applied to its own input must give the final result
// (without color or filter): this proves that the input is the right one.
const onlyCurves = levelsHistograms(sample, withCurves, 'final', bins)
const onlyChannels = applyCorrections(sample.image, {
  ...withCurves,
  curves: { ...withCurves.curves!, light: NEUTRAL_CURVE }
})
const expectedLight = applyCorrections(sample.image, withCurves)
result(
  'light input = channels after the channel curves',
  distance(lightInput[0], computeHistogram(onlyChannels, bins)[0]) === 0 &&
    distance(onlyCurves[0], computeHistogram(expectedLight, bins)[0]) === 0
)

console.log('--- PRESERVE COLOR ---')
const keep: CorrectionParams = { ...withCurves, preserveColor: true }
const keepInput = levelsHistograms(sample, keep, 'curvesInput', bins, 'light')
result('a single histogram (the luminance)', keepInput.length === 1)
// Expected: stretched luminance computed by hand as in the shader.
const s = keep.stretch
const q = keep.backgroundNeutralization
const meanBackground = (background[0] + background[1] + background[2]) / 3
const shadows = s.shadows - meanBackground * q
const interval = s.highlights - shadows
const m = sample.image.width * sample.image.height
const expected = new Uint32Array(bins)
const cd = sample.image.data
for (let i = 0; i < m; i++) {
  let l = 0
  for (let c = 0; c < 3; c++) l += Math.max(0, (Math.max(0, cd[c * m + i]) - background[c] * q - shadows) / interval)
  l /= 3
  const ld = mtf(Math.min(l, 1), s.midtones)
  expected[Math.min(bins - 1, Math.max(0, Math.round(ld * (bins - 1))))]++
}
const dKeep = distance(keepInput[0], expected)
result('matches the stretched luminance of the shader', dKeep < 0.01, 'cumulative difference ' + dKeep.toFixed(4))
const finalKeep = levelsHistograms(sample, { ...keep, filter }, 'final', bins)
result('the final stays at three channels', finalKeep.length === 3)

console.log('--- TIMING ---')
const start = performance.now()
for (let k = 0; k < 10; k++) levelsHistograms(sample, withFilter, 'final', bins)
const ms = (performance.now() - start) / 10
result('fast recomputation on the sample', ms < 60, ms.toFixed(1) + ' ms per recomputation, ' + m + ' pixels')

console.log(problems === 0 ? '\nAll good.' : '\nProblems: ' + problems)
process.exit(problems === 0 ? 0 : 1)
