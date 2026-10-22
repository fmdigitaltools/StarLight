/**
 * Check of multi-night stacking (src/core/stack/nights.ts).
 *
 * Checks, on synthetic data and without files:
 *   - night recognition: a night straddling midnight stays whole, two
 *     distinct nights are separated, without a date frames are grouped by
 *     folder;
 *   - relative quality within each night: a hazy night is not discarded
 *     wholesale, but its worst frame is;
 *   - the measurements (background, noise, transparency from the stars)
 *     and the weights: the noisiest night weighs less, the best is 1;
 *   - normalization: two nights with different background and transparency
 *     give a stack without a step where the number of nights present
 *     changes;
 *   - identity with a single night: same score and same sum as before,
 *     bit for bit.
 *
 *   $env:TEST_SCRIPT='tools/test-nights.ts'; node tools/run-test.mjs
 */
import type { ImageData32 } from '../src/shared/types'
import { relativeQuality, detectStars, type SessionMeasurement } from '../src/core/stars/detection'
import { stack, type FrameToStack, type StackingOptions } from '../src/core/stack/stacking'
import { IDENTITY_TRANSFORMATION } from '../src/core/stack/alignment'
import {
  nightKey,
  medianOf,
  weighNights,
  qualityPerNight,
  groupByNight,
  fluxRatio,
  backgroundStatistics,
  type NightMeasurements
} from '../src/core/stack/nights'

let errors = 0
function check(ok: boolean, what: string): void {
  if (!ok) errors++
  console.log((ok ? 'ok   ' : 'NO   ') + what)
}

/* ---- Night recognition ---- */

// Fixed time zone for the check: Italian daylight time (UTC+2).
const italyTimeZone = (): number => 120
const nightFrames = [
  // Night of October 12, straddling midnight (local times 21, 23:50, 1:50, 4:30).
  { id: 'a1', path: 'D:\\Shots\\M31\\a1.fit', dateObs: '2026-10-12T19:00:00', longitude: 15 },
  { id: 'a2', path: 'D:\\Shots\\M31\\a2.fit', dateObs: '2026-10-12T21:50:00Z', longitude: 15 },
  { id: 'a3', path: 'D:\\Shots\\M31\\a3.fit', dateObs: '2026-10-12T23:50:00.000', longitude: 15 },
  { id: 'a4', path: 'D:\\Shots\\M31\\a4.fit', dateObs: '2026-10-13T02:30:00', longitude: 15 },
  // Night of October 15.
  { id: 'b1', path: 'D:\\Shots\\M31\\b1.fit', dateObs: '2026-10-15T20:10:00', longitude: 15 },
  { id: 'b2', path: 'D:\\Shots\\M31\\b2.fit', dateObs: '2026-10-16T00:40:00', longitude: 15 },
  // Without a date: by folder, with backslashes and forward slashes.
  { id: 'c1', path: 'D:\\Shots\\evening three\\c1.fit', dateObs: null },
  { id: 'c2', path: 'D:\\Shots\\evening three\\c2.fit', dateObs: 'not a date' },
  { id: 'd1', path: '/home/me/evening four/d1.fit', dateObs: null }
]
const nights = groupByNight(nightFrames, italyTimeZone)
const nightOf = (id: string): string => nights.find((n) => n.frame.includes(id))?.key ?? '?'
console.log('     ' + nights.map((n) => n.label + ' (' + n.frame.length + ')').join(' | '))
check(nights.length === 4, 'four groups: two nights with a date and two folders')
check(
  ['a1', 'a2', 'a3', 'a4'].every((id) => nightOf(id) === '2026-10-12'),
  'a night straddling midnight stays whole (from 21 to 4:30)'
)
check(nightOf('b1') === '2026-10-15' && nightOf('b2') === '2026-10-15', 'the night of the 15th is separate from that of the 12th')
check(nightOf('c1') === nightOf('c2') && nightOf('c1').startsWith('folder:'), 'without a readable date frames are grouped by folder')
check(nightOf('d1') !== nightOf('c1'), 'different folders, different groups')
check(nights[0].label === 'Notte del 12 ottobre' && nights.find((n) => n.frame.includes('c1'))?.label === 'Cartella «evening three»', 'labels: "Notte del 12 ottobre", "Cartella «evening three»"')
check(nights[0].key < nights[1].key && !nights[0].perFolder && nights[3].perFolder, 'first the nights in date order, then the folders')
// Longitude versus computer time zone: at UTC noon on the 13th, in
// Japan (135° east) it is already the evening of the 13th; in Italy with the time zone it is 14:00 on the 13th.
const utcNoon = Date.parse('2026-10-13T12:00:00Z')
check(nightKey(utcNoon, 135) === '2026-10-13', 'with the site longitude the local time applies (Japan: evening of the 13th)')
check(nightKey(utcNoon, null, italyTimeZone) === '2026-10-13', 'without longitude the computer time zone applies')
check(nightKey(Date.parse('2026-10-13T09:00:00Z'), null, italyTimeZone) === '2026-10-12', '11 in the morning still belongs to the previous night')
check(groupByNight([{ id: 'x', path: 'a.fit', dateObs: '2026-10-08T21:00:00' }], italyTimeZone)[0].label === 'Notte dell’8 ottobre', 'label with elision: "Notte dell’8 ottobre"')

/* ---- Quality within each night ---- */

const clear: SessionMeasurement[] = Array.from({ length: 10 }, (_, i) => ({ starCount: 200 + i, medianHfr: 2 }))
const hazy: SessionMeasurement[] = [
  ...Array.from({ length: 9 }, (_, i) => ({ starCount: 70 + i, medianHfr: 2.1 })),
  { starCount: 20, medianHfr: 2.6 }
]
const measurements = [...clear, ...hazy]
const keys = [...clear.map(() => 'A'), ...hazy.map(() => 'B')]
const THRESHOLD = 40
const globals = relativeQuality(measurements)
const perNight = qualityPerNight(measurements, keys)
const keptGlobal = globals.slice(10, 19).filter((q) => q >= THRESHOLD).length
const keptPerNight = perNight.slice(10, 19).filter((q) => q >= THRESHOLD).length
console.log('     hazy night, global scores ' + globals.slice(10).join(' ') + '; per night ' + perNight.slice(10).join(' '))
check(keptGlobal === 0, 'compared with the clear night, the hazy night would be discarded wholesale')
check(keptPerNight === 9, 'compared with itself, the hazy night keeps its 9 good frames')
check(perNight[19] < THRESHOLD, 'the worst frame of the hazy night stays below the threshold')
check(perNight.slice(0, 10).every((q, i) => Math.abs(q - globals[i]) <= 1 && q >= 95), 'the clear night stays as before, all above 95')
const oneNight = qualityPerNight(measurements, measurements.map(() => 'X'))
check(oneNight.every((q, i) => q === globals[i]), 'with a single night the score matches the usual one')

/* ---- Synthetic data: a star field seen on two nights ---- */

const W = 240
const H = 180
let seed = 12345
const random = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
const gauss = (): number => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())
const stars = Array.from({ length: 70 }, () => ({
  x: 8 + random() * (W + 60 - 16),
  y: 8 + random() * (H - 16),
  a: 0.03 + random() * 0.4
}))
/** Sky in the reference coordinates, without background. */
function sky(x: number, y: number, sigma: number): number {
  let v = 0
  for (const s of stars) {
    const dx = x - s.x
    const dy = y - s.y
    if (dx * dx + dy * dy < 100) v += s.a * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
  }
  return v
}
/**
 * One frame: background, transparency, noise and star width of its
 * night. `shift` is the field displacement: pixel (x, y) of the frame
 * looks at point (x + shift, y) of the reference.
 */
function frame(background: number, transparency: number, noise: number, sigma: number, shift: number): ImageData32 {
  const data = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) data[y * W + x] = background + transparency * sky(x + shift, y, sigma) + noise * gauss()
  }
  return { width: W, height: H, channels: 1, data }
}

// Night A: clear, dark background. Night B: hazy (70% of the light), bright
// background, noisier, field shifted by 60 pixels: the first 60 columns
// of the reference are seen only by night A.
const SHIFT_B = 60
const nightA = Array.from({ length: 8 }, () => frame(0.05, 1, 0.004, 1.5, 0))
const nightB = Array.from({ length: 8 }, () => frame(0.12, 0.7, 0.008, 1.5, SHIFT_B))

/* ---- Measurements ---- */

const statsA = backgroundStatistics(nightA[0])
const statsB = backgroundStatistics(nightB[0])
console.log(
  '     background A ' + statsA.background[0].toFixed(4) + ', noise A ' + statsA.noise[0].toFixed(4) +
    ' | background B ' + statsB.background[0].toFixed(4) + ', noise B ' + statsB.noise[0].toFixed(4)
)
check(Math.abs(statsA.background[0] - 0.05) < 0.002 && Math.abs(statsB.background[0] - 0.12) < 0.002, 'background measured on the sample within 0.002')
check(Math.abs(statsA.noise[0] / 0.004 - 1) < 0.1 && Math.abs(statsB.noise[0] / 0.008 - 1) < 0.1, 'noise measured on the sample within 10%')

const refStars = detectStars(nightA[0])
const transB = { ...IDENTITY_TRANSFORMATION, tx: SHIFT_B }
const fluxesA = nightA.slice(1).map((f) => fluxRatio(refStars, detectStars(f), IDENTITY_TRANSFORMATION))
const fluxesB = nightB.map((f) => fluxRatio(refStars, detectStars(f), transB))
const fluxA = medianOf(fluxesA.filter((r): r is number => r !== null))
const fluxB = medianOf(fluxesB.filter((r): r is number => r !== null))
console.log('     flux ratio: A ' + fluxA?.toFixed(3) + ', B ' + fluxB?.toFixed(3) + ' (expected 1 and 1/0.7 = 1.429)')
check(fluxA !== null && Math.abs(fluxA - 1) < 0.05, 'transparency of night A equal to the reference')
check(fluxB !== null && Math.abs(fluxB / (fluxA ?? 1) - 1 / 0.7) < 0.08, 'transparency of night B: the stars arrive with 70% of the light')

/* ---- Weights ---- */

const measurementOf = (key: string, label: string, imm: ImageData32[], flux: number | null): NightMeasurements => {
  const st = imm.slice(0, 6).map((i) => backgroundStatistics(i))
  return {
    key,
    label,
    frame: imm.length,
    hfr: 2,
    background: [medianOf(st.map((s) => s.background[0])) ?? 0],
    noise: [medianOf(st.map((s) => s.noise[0])) ?? 0],
    flux
  }
}
const mA = measurementOf('2026-10-12', 'Notte del 12 ottobre', nightA, fluxA)
const mB = measurementOf('2026-10-15', 'Notte del 15 ottobre', nightB, fluxB)
const weights = weighNights([mA, mB], '2026-10-12')
for (const p of weights) console.log('     ' + p.explanation)
const pA = weights[0]
const pB = weights[1]
check(pA.weight === 1 && pA.scale === 1 && pA.shift[0] === 0, 'the best night (and the reference) is worth 1 and is not normalized')
// Expected: normalized noise of B = 0.008 / 0.7 = 0.0114, that is 2.86 times
// that of A; weight = 1 / 2.86² = 0.12.
check(pB.weight > 0.08 && pB.weight < 0.17, 'the noisier, hazier night weighs less: ' + pB.weight.toFixed(3) + ' (expected about 0.12)')
check(/fondo cielo più chiaro/.test(pB.explanation) && /rumore/.test(pB.explanation), 'the explanation says why: brighter background and higher noise')
const withHfr = weighNights([mA, { ...mB, noise: mA.noise, flux: mA.flux, background: mA.background, hfr: 2.5 }], '2026-10-12')
check(Math.abs(withHfr[1].weight - 0.64) < 0.01 && /stelle più larghe del 25%/.test(withHfr[1].explanation), 'at equal noise, stars 1.25 times wider weigh 1/1.25² = 0.64')
const byHand = weighNights([mA, mB], '2026-10-12', { weights: { '2026-10-15': 0.5 } })
check(byHand[1].weight === 0.5 && byHand[1].manual && byHand[1].proposedWeight === pB.proposedWeight, 'the hand-chosen weight replaces the proposed one, which stays indicated')
const doubledNoise = weighNights([mA, { ...mA, key: 'b', label: 'Notte b', noise: mA.noise.map((r) => r * 2) }], mA.key)
check(Math.abs(doubledNoise[1].weight - 0.25) < 1e-9 && /rumore doppio/.test(doubledNoise[1].explanation), 'double noise: weight one quarter, and the explanation says so')

/* ---- Normalization: no step ---- */

const OPT: StackingOptions = { method: 'rejection', rejectionThreshold: 3 }
const toStack = (normalize: boolean): FrameToStack[] => [
  ...nightA.map((image) => ({ image, transformation: IDENTITY_TRANSFORMATION, weight: pA.weight })),
  ...nightB.map((image) => ({
    image,
    transformation: transB,
    weight: normalize ? pB.weight : 1,
    normalization: normalize ? { scale: [pB.scale], shift: pB.shift } : undefined
  }))
]
const columnBackgrounds = (img: ImageData32, x0: number, x1: number): number => {
  const v: number[] = []
  for (let y = 10; y < H - 10; y++) for (let x = x0; x < x1; x++) v.push(img.data[y * W + x])
  return medianOf(v) ?? 0
}
const without = stack(toStack(false), OPT)
const combined = stack(toStack(true), { ...OPT, weightsInRejection: true })
const stepWithout = columnBackgrounds(without.image, SHIFT_B + 5, SHIFT_B + 50) - columnBackgrounds(without.image, 5, SHIFT_B - 5)
const stepWith = columnBackgrounds(combined.image, SHIFT_B + 5, SHIFT_B + 50) - columnBackgrounds(combined.image, 5, SHIFT_B - 5)
console.log(
  '     background step where the second night enters: without normalization ' + stepWithout.toFixed(4) +
    ', with ' + stepWith.toFixed(4) + '; rejected values ' + without.rejectedValues + ' versus ' + combined.rejectedValues
)
check(stepWithout > 0.02, 'without normalization the step is visible (the test is sensitive)')
check(Math.abs(stepWith) < 0.001, 'with normalization the step disappears (less than 0.001)')
// The brightest star in the common part must have the light of the reference night.
const common = stars.filter((s) => s.x > SHIFT_B + 10 && s.x < W - 10).sort((a, b) => b.a - a.a)[0]
const peakOf = (img: ImageData32): number => img.data[Math.round(common.y) * W + Math.round(common.x)]
const peakAt = peakOf(nightA[0]) - 0.05
const peakWith = peakOf(combined.image) - columnBackgrounds(combined.image, SHIFT_B + 5, SHIFT_B + 50)
check(Math.abs(peakWith / peakAt - 1) < 0.08, 'a star in the common part keeps the reference light (' + (peakWith / peakAt).toFixed(3) + ')')

// Tail rejection: with many shots from one night and few from another
// with a much brighter background, without normalization the pixels of
// the latter look like disturbances and are almost all rejected.
const few = Array.from({ length: 2 }, () => frame(0.15, 0.7, 0.008, 1.5, SHIFT_B))
const sB = few.map((f) => backgroundStatistics(f))
const mFew: NightMeasurements = { ...mB, frame: 2, background: [medianOf(sB.map((x) => x.background[0])) ?? 0], noise: [medianOf(sB.map((x) => x.noise[0])) ?? 0] }
const pFew = weighNights([mA, mFew], mA.key)[1]
const withFew = (normalize: boolean): FrameToStack[] => [
  ...nightA.map((image) => ({ image, transformation: IDENTITY_TRANSFORMATION, weight: 1 })),
  ...few.map((image) => ({
    image,
    transformation: transB,
    weight: 1,
    normalization: normalize ? { scale: [pFew.scale], shift: pFew.shift } : undefined
  }))
]
// Pixels of the second night that fall in the common part.
const commonItems = 2 * (W - SHIFT_B) * H
const rejectionsWithout = stack(withFew(false), OPT).rejectedValues
const rejectionsWith = stack(withFew(true), OPT).rejectedValues
console.log('     two frames of a bright-background night among eight: rejected ' + rejectionsWithout + ' values without normalization, ' + rejectionsWith + ' with (out of ' + commonItems + ')')
check(rejectionsWithout > 0.8 * commonItems, 'without normalization rejection throws away almost the whole second night, mistaking the background for a disturbance')
// With normalization only the noise tails of the second night remain
// rejected; after scaling its noise is almost three times that of the first.
check(rejectionsWith < 0.2 * commonItems, 'with normalization the second night stays in the sum (only the tails of its noise are removed)')

/* ---- A single night: identity ---- */

const onlyA: FrameToStack[] = nightA.map((image, i) => ({ image, transformation: IDENTITY_TRANSFORMATION, weight: Math.max(0.2, (100 - i * 7) / 100) }))
const before = stack(onlyA, OPT)
const identical = stack(
  onlyA.map((f) => ({ ...f, normalization: { scale: [1], shift: [0] } })),
  OPT
)
let different = 0
for (let i = 0; i < before.image.data.length; i++) if (before.image.data[i] !== identical.image.data[i]) different++
check(different === 0, 'a neutral normalization leaves the sum identical bit for bit')
const mean = stack(onlyA, { method: 'mean', rejectionThreshold: 3 })
const neutralMean = stack(onlyA.map((f) => ({ ...f, normalization: { scale: [1], shift: [0] } })), { method: 'mean', rejectionThreshold: 3 })
let differentMean = 0
for (let i = 0; i < mean.image.data.length; i++) if (mean.image.data[i] !== neutralMean.image.data[i]) differentMean++
check(differentMean === 0, 'also with the weighted mean')
// Weighted rejection with all weights equal gives the usual simple mean.
const equal = onlyA.map((f) => ({ ...f, weight: 1 }))
const simple = stack(equal, OPT)
const equalWeighted = stack(equal, { ...OPT, weightsInRejection: true })
let rejection = 0
for (let i = 0; i < simple.image.data.length; i++) rejection = Math.max(rejection, Math.abs(simple.image.data[i] - equalWeighted.image.data[i]))
check(rejection < 1e-6 && simple.rejectedValues === equalWeighted.rejectedValues, 'weighted rejection with equal weights matches the usual one (' + rejection.toExponential(1) + ')')
check(groupByNight(nightFrames.slice(0, 4), italyTimeZone).length === 1, 'the frames of a single night form a single group: no weights or normalization')

console.log(errors === 0 ? '\nAll good.' : '\n' + errors + ' checks failed.')
process.exit(errors === 0 ? 0 : 1)
