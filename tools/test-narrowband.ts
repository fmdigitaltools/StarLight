/**
 * Narrowband test: runs the full chain with the HOO palette on real files
 * taken with the dual-band filter, as the application does (first stage
 * without color smoothing, deconvolution, band separation, band-by-band
 * NL-Bayes, third stage), and compares it with the legacy order (smoothed
 * color, NL-Bayes and wavelets on the luminance, bands separated only at
 * the end).
 *
 * Prints how much the OIII still follows the H-alpha detail in the
 * brightest hydrogen areas (on the raw data, where no smoothing has mixed
 * the channels yet, and at the end of the two chains: with the right
 * separation, where oxygen is missing, the correlation stays low) and the
 * grain of the OIII in the final image.
 *
 * Care when reading the correlation: it also depends on noise. The
 * separation puts noise of opposite sign into the two bands, which lowers
 * the correlation of the raw data; cleaning the bands removes it and raises
 * the correlation, even without any copy of the H-alpha. The fair
 * comparison between the two chains is the one "against the uncleaned
 * H-alpha" (the same reference band for both): there the OIII of the new
 * chain, being less noisy, would be favored to have the higher
 * correlation, so if it stays lower the copy has genuinely decreased.
 * Saves the stretched images for viewing, whole and in a 1:1 crop at the
 * center.
 *
 * Usage: TEST_SCRIPT=tools/test-narrowband.ts node tools/run-test.mjs <file.fit> <output folder>
 * NL-Bayes runs here on a single core, in stripes as in the application:
 * on an eight-megapixel file the test takes a few minutes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretch } from '../src/core/image/stretch'
import { encodeBmp } from '../src/core/export/encoding'
import { computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { nlBayes, STRIP_MARGIN } from '../src/core/image/nlbayes'
import { deconvolve } from '../src/core/image/deconvolution'
import { imageWavelets } from '../src/core/image/wavelets'
import {
  firstStage,
  thirdStage,
  extractChainBands,
  chainColorGains,
  applyPlaneAmount,
  applyReductionAmount,
  cleanBands,
  ABRACADABRA_PROCESSING,
  type ProcessingParams
} from '../src/core/image/chain'
import {
  extractBands,
  narrowband,
  automaticNarrowband,
  reduceForPreview,
  sensorFromMetadata,
  describeSensor,
  NARROWBAND_NEUTRAL,
  type NarrowbandPalette
} from '../src/core/image/narrowband'
import type { ImageData32 } from '../src/shared/types'
import { testFile } from './test-files.mjs'

const source = process.argv[2] ?? testFile('ngc7000')
const output = process.argv[3] ?? 'out-narrowband'
mkdirSync(output, { recursive: true })
const name = basename(source, '.fit')

const readResult = readFits(new Uint8Array(readFileSync(source)))
console.log('FILTER = ' + String(readResult.metadata.filter) + ' → ' + automaticNarrowband(readResult.metadata.filter).palette)
const rawValue = debayer(readResult.image, readResult.metadata.bayer)
const w = rawValue.width
const h = rawValue.height
const n = w * h
const sensor = sensorFromMetadata(readResult.metadata)
console.log(describeSensor(sensor))

/** NL-Bayes in stripes of 128 rows, like nlbayesParallel.ts, on a single core. */
function nlBayesStriped(plane: Float32Array): Float32Array {
  // Same noise estimate as sigmaNlBayes (nlbayesParallel.ts).
  const sigma = computeStats(plane).mad * MAD_TO_SIGMA * 2.2
  const stripes = Math.max(1, Math.ceil(h / 128))
  const useful = Math.ceil(h / stripes)
  const cleaned = new Float32Array(n)
  for (let start = 0; start < h; start += useful) {
    const end = Math.min(h, start + useful)
    const from = Math.max(0, start - STRIP_MARGIN)
    const a = Math.min(h, end + STRIP_MARGIN)
    const r = nlBayes(plane.slice(from * w, a * w), w, a - from, sigma)
    cleaned.set(r.subarray((start - from) * w, (end - from) * w), start * w)
  }
  return cleaned
}

/** NL-Bayes on the luminance, as it was done for all images (reduceNoiseNlBayes). */
function nlBayesBrightness(im: ImageData32): ImageData32 {
  const y = new Float32Array(n)
  for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) y[i] += im.data[k * n + i] / 3
  const p = nlBayesStriped(y)
  const data = im.data.slice()
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) data[k * n + i] += p[i] - y[i]
  return { ...im, data }
}

const hoo = { ...NARROWBAND_NEUTRAL, palette: 'hoo' as const, sensor }
const time = (): number => performance.now()
let t = time()

// --- New chain, like the application with the HOO palette ---------------
const pNew: ProcessingParams = { ...ABRACADABRA_PROCESSING, narrowband: hoo }
const first = firstStage(rawValue, pNew, true, true)
let usedValues = first.parameters
const gains = chainColorGains(usedValues, first.measurements)
const deconvolved = deconvolve(first.image, usedValues.deconvolution)
const bands = extractChainBands(deconvolved, usedValues, gains)
console.log(
  'color gains ' + gains.map((g) => g.toFixed(3)).join(' ') +
    ' · OIII gain ' + bands.oiiiGain.toFixed(2) +
    ' · Ha noise ' + bands.noiseHa.toExponential(2) +
    ' · OIII noise ' + bands.noiseOiii.toExponential(2)
)
const denoisedBands = {
  ...bands,
  ha: applyPlaneAmount(bands.ha, nlBayesStriped(bands.ha), usedValues.nlBayes),
  oiii: applyPlaneAmount(bands.oiii, nlBayesStriped(bands.oiii), usedValues.nlBayes)
}
const third = thirdStage(deconvolved, usedValues, true, denoisedBands, gains)
usedValues = third.parameters
const finalNew = third.image
console.log('new chain ' + ((time() - t) / 1000).toFixed(1) + ' s')

// --- Legacy order, with the same parameters ------------------------------
t = time()
const pBefore: ProcessingParams = { ...usedValues, narrowband: NARROWBAND_NEUTRAL }
const firstBefore = firstStage(rawValue, pBefore, false, true).image
const deconvolvedBefore = deconvolve(firstBefore, usedValues.deconvolution)
let before = applyReductionAmount(deconvolvedBefore, nlBayesBrightness(deconvolvedBefore), usedValues.nlBayes)
before = narrowband(imageWavelets(before, usedValues.wavelets), hoo)
const finalBefore = thirdStage(before, { ...pBefore, wavelets: { ...usedValues.wavelets, noiseReduction: [0, 0, 0, 0, 0], sharpness: [0, 0, 0, 0, 0] } }, false).image
console.log('legacy order ' + ((time() - t) / 1000).toFixed(1) + ' s')

// --- Measurements ----------------------------------------------------------
const rawBands = extractBands(rawValue, sensor)
console.log('raw data:           ' + measureContamination(rawBands.ha, rawBands.oiii))
const afterWavelets = cleanBands(denoisedBands, usedValues.wavelets, usedValues.colorNoise)
console.log('cleaned bands:      ' + measureContamination(afterWavelets.ha, afterWavelets.oiii))
for (const [label, im] of [['final, new:', finalNew], ['final, legacy:', finalBefore]] as [string, ImageData32][]) {
  // In HOO red is the H-alpha and green the OIII, over the same background.
  const background = computeStats(im.data.subarray(0, n)).median
  const ha = new Float32Array(n)
  const oiii = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    ha[i] = im.data[i] - background
    oiii[i] = im.data[n + i] - background
  }
  console.log(label.padEnd(20) + measureContamination(ha, oiii))
  console.log(' '.repeat(20) + 'against the uncleaned H-alpha: ' + measureContamination(bands.ha, oiii))
  console.log(' '.repeat(20) + 'grain (pixels 4 columns apart): H-alpha ' + grain(ha).toExponential(2) + ', OIII ' + grain(oiii).toExponential(2) + ', in OIII signal units ' + (grain(oiii) / signal(oiii)).toFixed(3))
}

/** Noise from the differences between pixels four columns apart (like the plane noise estimate). */
function grain(p: Float32Array): number {
  const d = new Float32Array(Math.floor((p.length - 4) / 7))
  for (let k = 0; k < d.length; k++) d[k] = p[k * 7] - p[k * 7 + 4]
  return (computeStats(d).mad * MAD_TO_SIGMA) / Math.SQRT2
}
/** Typical signal: 90th percentile minus the median. */
function signal(p: Float32Array): number {
  const c = Float32Array.from({ length: 50000 }, (_, k) => p[Math.floor((k * p.length) / 50000)]).sort()
  return Math.max(1e-9, c[45000] - c[25000])
}

/**
 * How much of the H-alpha structure reappears in the OIII. The image is
 * divided into 16 × 16 pixel blocks and the median of each is taken (the
 * stars, few per block, do not move it); the detail of a block is the
 * difference from the mean of the surrounding blocks (7 × 7), so nebula
 * structures remain and gradients disappear. On the third of blocks with
 * the most H-alpha, the slope of the OIII details against the H-alpha ones
 * and their correlation are measured: where oxygen is missing, with the
 * right separation, they go toward zero.
 */
function measureContamination(ha: Float32Array, o: Float32Array): string {
  const B = 16
  const gw = Math.floor(w / B)
  const gh = Math.floor(h / B)
  const mh = new Float64Array(gw * gh)
  const mo = new Float64Array(gw * gh)
  const bh = new Float64Array(B * B)
  const bo = new Float64Array(B * B)
  const median = (a: Float64Array): number => {
    const s = Float64Array.from(a).sort()
    return s[s.length >> 1]
  }
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      let k = 0
      for (let y = 0; y < B; y++)
        for (let x = 0; x < B; x++) {
          const i = (gy * B + y) * w + gx * B + x
          bh[k] = ha[i]
          bo[k++] = o[i]
        }
      mh[gy * gw + gx] = median(bh)
      mo[gy * gw + gx] = median(bo)
    }
  const R = 3
  const chosenItems: number[] = []
  const dh: number[] = []
  const dO: number[] = []
  for (let gy = R; gy < gh - R; gy++)
    for (let gx = R; gx < gw - R; gx++) {
      let sh = 0
      let so = 0
      for (let y = -R; y <= R; y++)
        for (let x = -R; x <= R; x++) {
          sh += mh[(gy + y) * gw + gx + x]
          so += mo[(gy + y) * gw + gx + x]
        }
      const q = (2 * R + 1) ** 2
      const j = gy * gw + gx
      chosenItems.push(j)
      dh[j] = mh[j] - sh / q
      dO[j] = mo[j] - so / q
    }
  chosenItems.sort((a, b) => mh[a] - mh[b])
  const bright = chosenItems.slice(Math.floor((chosenItems.length * 2) / 3))
  let shh = 0
  let soh = 0
  let soo = 0
  for (const j of bright) {
    shh += dh[j] * dh[j]
    soh += dO[j] * dh[j]
    soo += dO[j] * dO[j]
  }
  return (
    'OIII/H-alpha detail slope ' + (soh / shh).toFixed(3) + ', correlation ' + (soh / Math.sqrt(shh * soo)).toFixed(3)
  )
}

// --- Images ----------------------------------------------------------------
function save(im: ImageData32, label: string): void {
  const stretchedImage = saturate(applyStretch(im, autoStretch(im, { targetBackground: 0.16 })), 1.8)
  writeFileSync(join(output, name + '-' + label + '.bmp'), Buffer.from(encodeBmp(reduceForPreview(stretchedImage, 960))))
  const side = 600
  const x0 = Math.floor((w - side) / 2)
  const y0 = Math.floor((h - side) / 2)
  const r = new Float32Array(3 * side * side)
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) r[c * side * side + y * side + x] = stretchedImage.data[c * n + (y0 + y) * w + x0 + x]
  writeFileSync(
    join(output, name + '-' + label + '-1a1.bmp'),
    Buffer.from(encodeBmp({ width: side, height: side, channels: 3, data: r }))
  )
}

/** Saturation for viewing: color around the luminance, as the Correct step does. */
function saturate(im: ImageData32, s: number): ImageData32 {
  const d = new Float32Array(im.data)
  for (let i = 0; i < n; i++) {
    const l = (d[i] + d[n + i] + d[2 * n + i]) / 3
    for (let c = 0; c < 3; c++) d[c * n + i] = Math.min(1, Math.max(0, l + (d[c * n + i] - l) * s))
  }
  return { ...im, data: d }
}

save(finalNew, 'hoo-chain')
save(finalBefore, 'hoo-legacy')
// The two cleaned bands, in gray, and the other palettes on the same bands.
const gray = (p: Float32Array): ImageData32 => {
  const d = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) d[i] = d[n + i] = d[2 * n + i] = Math.max(0, p[i] + bands.background)
  return { width: w, height: h, channels: 3, data: d }
}
save(gray(afterWavelets.ha), 'ha')
save(gray(afterWavelets.oiii), 'oiii')
for (const palette of ['foraxx', 'sho'] as NarrowbandPalette[]) {
  save(narrowband(deconvolved, { ...hoo, palette }, { ...denoisedBands, ...afterWavelets }), palette)
}
