/**
 * Diagnosis of the defects of an astronomical image.
 *
 * Measures what an automatic correction should then fix: noise
 * non-uniformity between center and edges (typical of alt-azimuth
 * mounts, where field rotation leaves the edges covered by fewer frames),
 * isolated anomalous pixels, background color casts and straight tracks.
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { debayer, toLuminance } from '../src/core/image/debayer'
import { computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('m27-stacked')
const readResult = readFits(new Uint8Array(readFileSync(path)), path)
const img = debayer(readResult.image, readResult.metadata.bayer)
const lum = toLuminance(img)
const w = img.width
const h = img.height

/** Local noise of a rectangular zone, from the difference between adjacent pixels. */
function regionNoise(x0: number, y0: number, width: number, height: number): number {
  const diff: number[] = []
  for (let y = y0; y < Math.min(h - 1, y0 + height); y++) {
    for (let x = x0; x < Math.min(w - 2, x0 + width); x++) {
      diff.push(Math.abs(lum[y * w + x + 1] - lum[y * w + x]))
    }
  }
  if (diff.length === 0) return 0
  diff.sort((a, b) => a - b)
  /*
   * The first quarter of the differences is used, not the median: where
   * there is a nebula or a cluster, half of the pixels border real
   * signal and the median would measure the structure of the subject
   * instead of the noise. The lowest values come instead from the
   * sky-only portions, which exist in every zone.
   */
  return (diff[Math.floor(diff.length * 0.25)] * MAD_TO_SIGMA) / Math.SQRT2
}

/** Median level of a zone. */
function zoneLevel(x0: number, y0: number, width: number, height: number): number {
  const v: number[] = []
  for (let y = y0; y < Math.min(h, y0 + height); y += 2) {
    for (let x = x0; x < Math.min(w, x0 + width); x += 2) v.push(lum[y * w + x])
  }
  v.sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)] ?? 0
}

console.log('image: ' + w + ' x ' + h + ', ' + img.channels + ' channels')

console.log('\n--- NOISE PER ZONE (field rotation) ---')
const side = Math.floor(Math.min(w, h) * 0.18)
const zones: [string, number, number][] = [
  ['center', Math.floor(w / 2 - side / 2), Math.floor(h / 2 - side / 2)],
  ['top-left corner', 0, 0],
  ['top-right corner', w - side, 0],
  ['bottom-left corner', 0, h - side],
  ['bottom-right corner', w - side, h - side],
  ['top edge', Math.floor(w / 2 - side / 2), 0],
  ['bottom edge', Math.floor(w / 2 - side / 2), h - side]
]
const centerNoise = regionNoise(zones[0][1], zones[0][2], side, side)
for (const [name, x, y] of zones) {
  const r = regionNoise(x, y, side, side)
  const level = zoneLevel(x, y, side, side)
  const ratio = r / Math.max(1e-9, centerNoise)
  const bars = '#'.repeat(Math.min(40, Math.round(ratio * 12)))
  console.log(
    '  ' + name.padEnd(20) + 'noise ' + r.toExponential(2) +
    '  (' + ratio.toFixed(2) + ' times the center)  level ' + level.toFixed(4) + '  ' + bars
  )
}

console.log('\n--- SKY BACKGROUND COLOR CAST ---')
if (img.channels === 3) {
  const n = w * h
  const names = ['red', 'green', 'blue']
  const medians: number[] = []
  for (let c = 0; c < 3; c++) {
    medians.push(computeStats(img.data.subarray(c * n, (c + 1) * n)).median)
  }
  const reference = Math.min(...medians)
  medians.forEach((m, c) => {
    const excess = ((m / reference - 1) * 100).toFixed(1)
    console.log('  ' + names[c].padEnd(7) + m.toFixed(5) + '   excess ' + excess + '%')
  })
  const imbalance = (Math.max(...medians) / reference - 1) * 100
  console.log('  maximum imbalance: ' + imbalance.toFixed(1) + '%')
  console.log(
    imbalance > 4
      ? '  verdict: background with a color cast, to be neutralized'
      : '  verdict: background already nearly neutral'
  )
}

console.log('\n--- ISOLATED ANOMALOUS PIXELS ---')
/*
 * A hot pixel greatly exceeds its neighbors without other equally
 * bright pixels around it: a star, even a small one, instead spreads its
 * light over several pixels because of turbulence and optics.
 */
const stats = computeStats(lum)
const threshold = stats.median + 8 * stats.mad * MAD_TO_SIGMA
let hotPixels = 0
let inspected = 0
for (let y = 1; y < h - 1; y++) {
  for (let x = 1; x < w - 1; x++) {
    const i = y * w + x
    const v = lum[i]
    if (v <= threshold) continue
    inspected++
    let nearbyMax = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        nearbyMax = Math.max(nearbyMax, lum[(y + dy) * w + x + dx])
      }
    }
    // Isolated: the brightest neighbor is worth less than a third of the center.
    if (nearbyMax < stats.median + (v - stats.median) * 0.33) hotPixels++
  }
}
console.log('  pixels above threshold: ' + inspected.toLocaleString('en-US'))
console.log('  isolated (hot or defective): ' + hotPixels.toLocaleString('en-US'))
console.log('  verdict: ' + (hotPixels > 50 ? 'cosmetic correction is advisable' : 'clean sensor'))

console.log('\n--- STRAIGHT TRACKS ---')
/*
 * A satellite trail crosses the frame as a thin, bright segment.
 * Alignments are searched by sampling lines at various inclinations and
 * measuring how much the mean level along the line exceeds the
 * surrounding background.
 */
/**
 * Mean level along a line, described by its center and direction.
 */
function meanAlongLine(cx: number, cy: number, dx: number, dy: number): number | null {
  let sum = 0
  let count = 0
  const step = Math.max(w, h)
  for (let t = -step / 2; t < step / 2; t += 2) {
    const x = Math.round(cx + dx * t)
    const y = Math.round(cy + dy * t)
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue
    sum += lum[y * w + x]
    count++
  }
  return count < Math.min(w, h) * 0.3 ? null : sum / count
}

let suspicious = 0
let best = 0
const angleSteps = 60
for (let a = 0; a < angleSteps; a++) {
  const angle = (a / angleSteps) * Math.PI
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  for (let offset = -0.45; offset <= 0.45; offset += 0.03) {
    const cx = w / 2 + -dy * offset * h
    const cy = h / 2 + dx * offset * w

    const mean = meanAlongLine(cx, cy, dx, dy)
    if (mean === null) continue

    /*
     * Comparison with the two parallel lines a short distance away.
     *
     * A trail is thin: the neighboring rows do not contain it and stay at
     * the sky level. A nebula or a cluster, instead, also extends
     * sideways, so it raises the neighboring lines in the same way and is
     * not mistaken for a track.
     */
    const distance = 6
    const near1 = meanAlongLine(cx - dy * distance, cy + dx * distance, dx, dy)
    const near2 = meanAlongLine(cx + dy * distance, cy - dx * distance, dx, dy)
    if (near1 === null || near2 === null) continue

    const localBackground = (near1 + near2) / 2
    const excess = (mean - localBackground) / Math.max(1e-9, stats.mad * MAD_TO_SIGMA)
    if (excess > best) best = excess
    if (excess > 6) suspicious++
  }
}
console.log('  suspicious alignments: ' + suspicious)
console.log('  maximum deviation along a line: ' + best.toFixed(1) + ' sigma')
console.log(
  '  verdict: ' +
    (suspicious > 0 ? 'possible track, to be checked by eye' : 'no obvious track')
)
