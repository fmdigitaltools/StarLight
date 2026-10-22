/**
 * Check of the Vibrance sliders (Color tab) and Vignette (Filters panel).
 *
 * Verifies three things:
 *  1. the sum with the photographic filter (`effectiveFilter`): the slider
 *     adds to or subtracts from the character of the filter and the total
 *     stays within the useful range (vibrance between -1 and 1, vignette
 *     between 0 and 1);
 *  2. that the viewer shader still contains the same formulas rewritten
 *     below, and that viewer and export both pass the two values;
 *  3. that the export chain gives, pixel by pixel, what the shader would
 *     give: the saved file must match what is seen.
 *
 * The shader runs on the graphics card and cannot be executed here: its
 * final part (the photographic filter) is rewritten line by line, as in
 * test-background.ts, and compared with `applyCorrections`.
 *
 * Usage: TEST_SCRIPT=tools/test-vibrance.ts node tools/run-test.mjs [file.fit]
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { computeStats } from '../src/core/image/stats'
import { autoStretch } from '../src/core/image/stretch'
import { applyCorrections, type CorrectionParams } from '../src/core/export/processing'
import { testFile } from './test-files.mjs'
import {
  effectiveFilter,
  filterById,
  applyFilterAmount,
  NEUTRAL_FILTER,
  FILTERS,
  type FilterParams
} from '../src/core/image/photoFilters'

let problems = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  OK   ' : '  ERROR ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) problems++
}
const neighbor = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

/* ---- 1. Sum with the photographic filter ---- */

console.log('--- SUM WITH THE PHOTOGRAPHIC FILTER ---')
result('with no filter and sliders at zero nothing is applied', effectiveFilter('none', 0.75, 0, 0) === undefined)
const onlyManual = effectiveFilter('none', 0.75, 0.4, 0.25)
result(
  'with no filter only the sliders count',
  onlyManual !== undefined && neighbor(onlyManual.vibrance, 0.4) && neighbor(onlyManual.vignette, 0.25) &&
    onlyManual.curve === NEUTRAL_FILTER.curve && onlyManual.temperature === NEUTRAL_FILTER.temperature
)
// A filter with its own vignette and vibrance, to see the sum.
const testFilter = FILTERS.find((f) => f.parameters.vignette > 0.001 && Math.abs(f.parameters.vibrance) > 0.001)
result('a filter with its own vibrance and vignette exists', testFilter !== undefined)
const sampleId = testFilter?.id ?? 'none'
const base = applyFilterAmount(filterById(sampleId).parameters, 0.75)
const sum = effectiveFilter(sampleId, 0.75, 0.2, 0.1) as FilterParams
result(
  'with filter "' + sampleId + '" the slider is added',
  neighbor(sum.vibrance, Math.max(-1, Math.min(1, base.vibrance + 0.2))) &&
    neighbor(sum.vignette, Math.max(0, Math.min(1, base.vignette + 0.1))),
  'vibrance ' + base.vibrance.toFixed(3) + ' → ' + sum.vibrance.toFixed(3) +
    ', vignette ' + base.vignette.toFixed(3) + ' → ' + sum.vignette.toFixed(3)
)
const minus = effectiveFilter(sampleId, 0.75, -1, -1) as FilterParams
result(
  'the slider can subtract, without going below the limit',
  neighbor(minus.vibrance, Math.max(-1, base.vibrance - 1)) && minus.vignette === 0
)
const tooMuch = effectiveFilter(sampleId, 1, 1, 1) as FilterParams
result('the total does not exceed the maximum', tooMuch.vibrance <= 1 && tooMuch.vignette <= 1)
const restUnchanged = (['temperature', 'tint', 'saturation', 'curve', 'brightness', 'monochrome', 'toningStrength'] as const)
  .every((k) => sum[k] === base[k])
result('the rest of the filter does not change', restUnchanged)

/* ---- 2. The shader formulas and the values passed ---- */

console.log('--- SHADER, VIEWER AND EXPORT ---')
const shader = readFileSync('src/renderer/src/gpu/fragment.glsl', 'utf-8').replace(/\s+/g, ' ')
const expectedRows = [
  'float push = uVibrance * (1.0 - smoothstep(0.0, 0.6, currentSaturation));',
  'color = mix(vec3(light), color, 1.0 + push);',
  'float edgeDistance = length(fromCenter) * 1.414;',
  'float factor = 1.0 - uVignette * smoothstep(0.45, 1.0, edgeDistance);'
]
for (const r of expectedRows) result('the shader contains "' + r.slice(0, 48) + '…"', shader.includes(r))
// Vibrance before the filter saturation, vignette last: the same order
// as the rewrite below and as applyPixelFilter.
const order = [
  shader.indexOf('abs(uVibrance)'),
  shader.indexOf('abs(uFilterSaturation)'),
  shader.indexOf('sCurve(color, uFilterCurve)'),
  shader.indexOf('uVignette > 0.001')
]
result('order of the steps in the shader', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])))
for (const file of ['src/renderer/src/components/Viewer.tsx', 'src/renderer/src/export/exportImage.ts']) {
  const text = readFileSync(file, 'utf-8').replace(/\s+/g, ' ')
  result(
    file.split('/').pop() + ' passes the manual vibrance and vignette',
    /effectiveFilter\( *\w+\.filter, *\w+\.filterIntensity, *\w+\.vibrance, *\w+\.vignette *\)/.test(text)
  )
}

/* ---- 3. Viewer and export on the same pixels ---- */

const path = process.argv[2] ?? testFile('m27-stacked')
const readResult = readFits(new Uint8Array(readFileSync(path)), path)
const image = debayer(readResult.image, readResult.metadata.bayer)
const w = image.width
const h = image.height
const n = w * h
const median = (c: number): number => computeStats(image.data.subarray(c * n, (c + 1) * n)).median
const background: [number, number, number] =
  image.channels === 1 ? [median(0), median(0), median(0)] : [median(0), median(1), median(2)]

const parameters = (filter: FilterParams | undefined): CorrectionParams => ({
  stretch: autoStretch(image),
  brightness: 0,
  contrast: 0.1,
  saturation: 0.2,
  redGain: 1,
  greenGain: 1,
  blueGain: 1,
  gamma: 1,
  noiseReduction: 0,
  sharpness: 0,
  backgroundNeutralization: 0,
  skyBackground: background,
  filter
})

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const clamp = (v: number): number => Math.min(1, Math.max(0, v))
const light = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/**
 * The photographic filter as fragment.glsl writes it, with `uv` at the
 * center of the pixel as the graphics card interpolates it.
 */
function likeTheShader(color: number[], f: FilterParams, uvx: number, uvy: number): number[] {
  const c = color.slice()
  if (Math.abs(f.temperature) > 0.001 || Math.abs(f.tint) > 0.001) {
    c[0] *= 1 + f.temperature * 0.28
    c[2] *= 1 - f.temperature * 0.28
    c[1] *= 1 - f.tint * 0.18
    c[0] *= 1 + f.tint * 0.07
    c[2] *= 1 + f.tint * 0.07
  }
  if (f.monochrome > 0.001) {
    const g = light(c)
    for (let k = 0; k < 3; k++) c[k] = c[k] + (g - c[k]) * f.monochrome
  }
  if (f.toningStrength > 0.001) {
    const m = smoothstep(0.15, 0.85, light(c))
    for (let k = 0; k < 3; k++) c[k] += (f.shadowsToning[k] + (f.highlightsToning[k] - f.shadowsToning[k]) * m) * f.toningStrength
  }
  if (Math.abs(f.vibrance) > 0.001) {
    const l = light(c)
    const sat = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])
    const boost = f.vibrance * (1 - smoothstep(0, 0.6, sat))
    for (let k = 0; k < 3; k++) c[k] = l + (c[k] - l) * (1 + boost)
  }
  if (Math.abs(f.saturation) > 0.001) {
    const l = light(c)
    for (let k = 0; k < 3; k++) c[k] = l + (c[k] - l) * (1 + f.saturation)
  }
  for (let k = 0; k < 3; k++) {
    let x = c[k]
    if (Math.abs(f.curve) >= 0.001) {
      x = clamp(x)
      const soft = x * x * (3 - 2 * x)
      x = x + ((f.curve > 0 ? soft : x + (x - soft)) - x) * Math.abs(f.curve)
    }
    c[k] = clamp(x + f.brightness)
  }
  if (f.vignette > 0.001) {
    const distance = Math.hypot(uvx - 0.5, uvy - 0.5) * 1.414
    const factor = 1 - f.vignette * smoothstep(0.45, 1, distance)
    for (let k = 0; k < 3; k++) c[k] *= factor
  }
  return c.map(clamp)
}

console.log('--- VIEWER AND EXPORT (' + path.split(/[\/]/).pop() + ', ' + w + '×' + h + ') ---')
const withoutFilter = applyCorrections(image, parameters(undefined))
const cases: { name: string; filter: string; vibrance: number; vignette: number }[] = [
  { name: 'vibrance only +0.6', filter: 'none', vibrance: 0.6, vignette: 0 },
  { name: 'vibrance only −0.5', filter: 'none', vibrance: -0.5, vignette: 0 },
  { name: 'vignette only 40%', filter: 'none', vibrance: 0, vignette: 0.4 },
  { name: 'filter "' + sampleId + '" + sliders', filter: sampleId, vibrance: 0.3, vignette: 0.2 }
]
// Viewer and export both take the pixel center for the vignette (taking
// the corner, the difference would reach 1/1000): the difference must stay
// below the step of a 16-bit-per-channel file.
const TOLERANCE = 1 / 65535
for (const testCase of cases) {
  const f = effectiveFilter(testCase.filter, 0.75, testCase.vibrance, testCase.vignette)
  if (f === undefined) {
    result(testCase.name, false, 'filter not applied')
    continue
  }
  const exported = applyCorrections(image, parameters(f))
  let max = 0
  let changedItems = 0
  for (let i = 0; i < n; i += 37) {
    const x = i % w
    const y = Math.floor(i / w)
    const before = [withoutFilter.data[i], withoutFilter.data[n + i], withoutFilter.data[2 * n + i]]
    const expected = likeTheShader(before, f, (x + 0.5) / w, (y + 0.5) / h)
    for (let c = 0; c < 3; c++) {
      const obtained = exported.data[c * n + i]
      max = Math.max(max, Math.abs(expected[c] - obtained))
      if (Math.abs(before[c] - obtained) > 1 / 255) changedItems++
    }
  }
  result(
    testCase.name + ': export matches the viewer',
    max < TOLERANCE && changedItems > 0,
    'maximum difference ' + max.toExponential(1) + ', visibly changed values ' + changedItems
  )
}

// The vignette darkens the corners and leaves the center.
const vign = applyCorrections(image, parameters(effectiveFilter('none', 0.75, 0, 0.5)))
const center = Math.floor(h / 2) * w + Math.floor(w / 2)
const angle = 0
result(
  'vignette: center intact, corner darker',
  Math.abs(vign.data[center] - withoutFilter.data[center]) < 1e-6 &&
    (withoutFilter.data[angle] === 0 || vign.data[angle] < withoutFilter.data[angle])
)

// With a crop the vignette is centered on the exported box: the center of
// the box stays intact, the center of the image (here the top-left corner
// of the box) gets darker.
{
  const vignetteFilter = effectiveFilter('none', 0.75, 0, 0.5)
  const box = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
  const withCrop = applyCorrections(image, { ...parameters(vignetteFilter), vignetteBox: box })
  const boxCenter = Math.floor(h * 0.75) * w + Math.floor(w * 0.75)
  const boxCorner = Math.floor(h * 0.5) * w + Math.floor(w * 0.5)
  result(
    'with a crop the vignette is centered on the exported box',
    Math.abs(withCrop.data[boxCenter] - withoutFilter.data[boxCenter]) < 1e-6 &&
      (withoutFilter.data[boxCorner] === 0 || withCrop.data[boxCorner] < withoutFilter.data[boxCorner])
  )
  const whole = applyCorrections(image, {
    ...parameters(vignetteFilter),
    vignetteBox: { x: 0, y: 0, width: 1, height: 1 }
  })
  result('without a crop the result is the same as before', whole.data.every((v, i) => v === vign.data[i]))
}

console.log(problems === 0 ? '\nAll good.' : '\n' + problems + ' problems.')
process.exit(problems === 0 ? 0 : 1)
