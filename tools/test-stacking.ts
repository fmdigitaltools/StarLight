/**
 * Test of star detection, alignment and stacking on the sample frames,
 * which contain a known shift from one frame to the next.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { computeImageStats, computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { toLuminance } from '../src/core/image/debayer'
import { detectStars, evaluateQuality } from '../src/core/stars/detection'
import { align, rotationDegrees, scale } from '../src/core/stack/alignment'
import { stack } from '../src/core/stack/stacking'
import { testFile } from './test-files.mjs'

const folder = process.argv[2] ?? testFile('synthetic-frames')
const file = readdirSync(folder)
  .filter((f) => f.endsWith('.fit'))
  .sort()

console.log('--- LOADING ---')
const images = []
for (const name of file) {
  const t0 = performance.now()
  const result = readFits(new Uint8Array(readFileSync(join(folder, name))))
  const rgb = debayer(result.image, result.metadata.bayer)
  images.push({ name, image: rgb })
  console.log(name + ': ' + (performance.now() - t0).toFixed(0) + ' ms')
}

console.log('--- STAR DETECTION ---')
const frameStars = []
for (const { name, image } of images) {
  const t0 = performance.now()
  const stars = detectStars(image)
  const noise = computeStats(toLuminance(image)).mad * MAD_TO_SIGMA
  const quality = evaluateQuality(stars, noise)
  frameStars.push(stars)
  console.log(
    name +
      ': ' +
      stars.length +
      ' stars, median HFR ' +
      quality.medianHfr.toFixed(2) +
      ' px, score ' +
      quality.score +
      ' (' +
      (performance.now() - t0).toFixed(0) +
      ' ms)'
  )
}

console.log('--- ALIGNMENT ON THE FIRST FRAME ---')
const transformations = [{ a: 1, b: 0, tx: 0, ty: 0 }]
for (let i = 1; i < frameStars.length; i++) {
  const t0 = performance.now()
  const r = align(frameStars[0], frameStars[i])
  transformations.push(r.transformation)
  // Result for whoever runs it together with the others (npm run test): exit code 1 if something is wrong.
  if (!r.valid) process.exitCode = 1
  console.log(
    file[i] +
      ': shift ' +
      r.transformation.tx.toFixed(2) +
      ', ' +
      r.transformation.ty.toFixed(2) +
      ' px | rotation ' +
      rotationDegrees(r.transformation).toFixed(3) +
      ' degrees | scale ' +
      scale(r.transformation).toFixed(4) +
      ' | stars ' +
      r.matchingStars +
      ' | error ' +
      r.meanError.toFixed(3) +
      ' px | ' +
      (r.valid ? 'VALID' : 'INVALID') +
      ' (' +
      (performance.now() - t0).toFixed(0) +
      ' ms)'
  )
}

/**
 * Local noise measurement.
 *
 * The deviation computed over the whole image would include the
 * light-pollution gradient, which varies from one corner to the other and
 * would hide the noise. Here the difference between adjacent pixels is
 * measured instead, in a star-free area: the sky signal changes slowly, so
 * what remains is noise.
 */
function localNoise(image: { width: number; height: number; channels: 1 | 3; data: Float32Array }): number {
  const w = image.width
  const plane = image.data
  const differences: number[] = []
  // Central box, away from the edges.
  for (let y = Math.floor(image.height * 0.6); y < Math.floor(image.height * 0.6) + 200; y++) {
    for (let x = Math.floor(w * 0.1); x < Math.floor(w * 0.1) + 200; x++) {
      differences.push(Math.abs(plane[y * w + x + 1] - plane[y * w + x]))
    }
  }
  differences.sort((a, b) => a - b)
  // The difference between two independent pixels has a spread larger by
  // the square root of two than the noise of a single pixel.
  return (differences[Math.floor(differences.length / 2)] * 1.4826) / Math.SQRT2
}

console.log('--- STACKING ---')
for (const method of ['mean', 'median', 'rejection'] as const) {
  const t0 = performance.now()
  const result = stack(
    images.map((im, i) => ({
      image: im.image,
      transformation: transformations[i],
      weight: 1
    })),
    { method, rejectionThreshold: 3 }
  )
  const noiseBefore = localNoise(images[0].image)
  const noiseAfter = localNoise(result.image)
  console.log(
    method.padEnd(12) +
      ' time ' +
      (performance.now() - t0).toFixed(0) +
      ' ms | noise ' +
      noiseBefore.toFixed(6) +
      ' -> ' +
      noiseAfter.toFixed(6) +
      ' (' +
      (noiseBefore / Math.max(1e-9, noiseAfter)).toFixed(2) +
      ' times better, expected ' + Math.sqrt(images.length).toFixed(2) + ') | rejected ' +
      result.rejectedValues
  )
}

console.log('--- STAR CHECK AFTER STACKING ---')
const stacked = stack(
  images.map((im, i) => ({ image: im.image, transformation: transformations[i], weight: 1 })),
  { method: 'rejection', rejectionThreshold: 3 }
)
const finalStars = detectStars(stacked.image)
const finalQuality = evaluateQuality(
  finalStars,
  computeStats(toLuminance(stacked.image)).mad * MAD_TO_SIGMA
)
console.log(
  'stars in the result: ' +
    finalStars.length +
    ' | median HFR ' +
    finalQuality.medianHfr.toFixed(2) +
    ' px (if the alignment were wrong it would be much higher)'
)
