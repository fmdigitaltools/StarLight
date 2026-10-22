/**
 * Generator of test FITS files, with the typical header of a short
 * focal length smart telescope.
 *
 * Produces monochrome sub-frames with a GRBG Bayer matrix, 16 bit,
 * complete with a realistic header, stars, a light-pollution gradient and
 * read noise. Used to try StarLight without needing a real session.
 *
 * Usage:  node tools/generate-test-fits.mjs [folder] [frameCount]
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { testFile } from './test-files.mjs'

const WIDTH = 1080
const HEIGHT = 1920
const BAYER = 'GRBG'

const outDir = process.argv[2] ?? testFile('synthetic-frames')
const frameCount = Number(process.argv[3] ?? 8)

/** Deterministic pseudorandom generator, for reproducible results. */
function makeRandom(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Gaussian noise via the Box-Muller transform. */
function gaussian(rnd) {
  const u = Math.max(1e-9, rnd())
  const v = rnd()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Builds an 80-character header card. */
function card(key, value, comment) {
  let valueStr
  if (typeof value === 'string') {
    const quoted = "'" + value + "'"
    valueStr = quoted.padEnd(20, ' ')
  } else if (typeof value === 'boolean') {
    valueStr = (value ? 'T' : 'F').padStart(20, ' ')
  } else {
    valueStr = String(value).padStart(20, ' ')
  }
  let line = key.padEnd(8, ' ') + '= ' + valueStr
  if (comment) line += ' / ' + comment
  return line.slice(0, 80).padEnd(80, ' ')
}

/** Fixed star positions, shared by all frames of the session. */
function buildStarField(count) {
  const rnd = makeRandom(20261015)
  const stars = []
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rnd() * WIDTH,
      y: rnd() * HEIGHT,
      // Brightness distribution similar to the real one: many faint, few bright.
      flux: 200 + Math.pow(rnd(), 3) * 42000,
      fwhm: 2.6 + rnd() * 1.4
    })
  }
  // Bright central core simulating the framed object.
  stars.push({ x: WIDTH * 0.5, y: HEIGHT * 0.5, flux: 55000, fwhm: 18 })
  return stars
}

const starField = buildStarField(900)

function renderFrame(index) {
  const rnd = makeRandom(1000 + index * 77)
  const pixels = new Uint16Array(WIDTH * HEIGHT)

  // Tracking drift: every frame is shifted by a few pixels.
  const driftX = Math.sin(index * 0.7) * 6 + (rnd() - 0.5) * 2
  const driftY = Math.cos(index * 0.5) * 5 + (rnd() - 0.5) * 2

  // Seeing varying from frame to frame.
  const seeing = 1 + (rnd() - 0.5) * 0.25

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      // Light-pollution gradient stronger at the bottom right.
      const gradient = 900 + 420 * (x / WIDTH) + 700 * (y / HEIGHT)
      const noise = gaussian(rnd) * 55
      let value = gradient + noise
      pixels[y * WIDTH + x] = value < 0 ? 0 : value > 65535 ? 65535 : value
    }
  }

  // Stars are added with a Gaussian profile.
  for (const star of starField) {
    const cx = star.x + driftX
    const cy = star.y + driftY
    const sigma = (star.fwhm * seeing) / 2.3548
    const radius = Math.ceil(sigma * 4)
    const peak = star.flux / (2 * Math.PI * sigma * sigma)

    const x0 = Math.max(0, Math.floor(cx - radius))
    const x1 = Math.min(WIDTH - 1, Math.ceil(cx + radius))
    const y0 = Math.max(0, Math.floor(cy - radius))
    const y1 = Math.min(HEIGHT - 1, Math.ceil(cy + radius))

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx
        const dy = y - cy
        const amount = peak * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
        if (amount < 0.5) continue
        // The green pixels of the GRBG matrix collect more signal.
        const isGreen = (x & 1) === ((y & 1) === 0 ? 0 : 1)
        const scaled = amount * (isGreen ? 1 : 0.72)
        const i = y * WIDTH + x
        const sum = pixels[i] + scaled
        pixels[i] = sum > 65535 ? 65535 : sum
      }
    }
  }

  return pixels
}

function buildFits(pixels, index) {
  const dateObs = new Date(Date.UTC(2026, 9, 15, 21, 12, 0) + index * 11000).toISOString()

  const cards = [
    card('SIMPLE', true, 'file conforms to the FITS standard'),
    card('BITPIX', 16, '16-bit signed integers'),
    card('NAXIS', 2, 'two-dimensional image'),
    card('NAXIS1', WIDTH, 'width in pixels'),
    card('NAXIS2', HEIGHT, 'height in pixels'),
    card('BZERO', 32768, 'offset for unsigned values'),
    card('BSCALE', 1, 'scale factor'),
    card('IMAGETYP', 'Light Frame', 'image type'),
    card('EXPTIME', 10.0, 'exposure time in seconds'),
    card('EXPOSURE', 10.0, 'exposure time in seconds'),
    card('GAIN', 80, 'sensor gain'),
    card('CCD-TEMP', 24.5, 'sensor temperature in C'),
    card('XPIXSZ', 2.9, 'pixel size in microns'),
    card('YPIXSZ', 2.9, 'pixel size in microns'),
    card('XBINNING', 1, 'horizontal binning'),
    card('YBINNING', 1, 'vertical binning'),
    card('FOCALLEN', 250, 'focal length in mm'),
    card('APERTURE', 50, 'aperture in mm'),
    card('INSTRUME', 'Seestar S50', 'telescope model'),
    card('TELESCOP', 'Seestar S50', 'telescope'),
    card('OBJECT', 'M 42', 'framed object'),
    card('OBJCTRA', '05 35 17.300', 'object right ascension'),
    card('OBJCTDEC', '-05 23 28.00', 'object declination'),
    card('RA', 83.822083, 'right ascension in degrees'),
    card('DEC', -5.391111, 'declination in degrees'),
    card('FILTER', 'IRCUT', 'filter in use'),
    card('BAYERPAT', BAYER, 'Bayer matrix pattern'),
    card('XBAYROFF', 0, 'horizontal matrix offset'),
    card('YBAYROFF', 0, 'vertical matrix offset'),
    card('DATE-OBS', dateObs.slice(0, 23), 'exposure start UTC'),
    card('CREATOR', 'ZWO Seestar', 'capture software'),
    card('SITELAT', 51.4769, 'observing latitude'),
    card('SITELONG', -0.0005, 'observing longitude'),
    'END'.padEnd(80, ' ')
  ]

  // The header takes a whole number of 2880-byte blocks.
  let headerText = cards.join('')
  const headerBlocks = Math.ceil(headerText.length / 2880)
  headerText = headerText.padEnd(headerBlocks * 2880, ' ')

  const headerBytes = Buffer.from(headerText, 'ascii')

  // The data must be written big-endian with the BZERO offset.
  const dataBytes = Buffer.alloc(Math.ceil((pixels.length * 2) / 2880) * 2880)
  for (let i = 0; i < pixels.length; i++) {
    dataBytes.writeInt16BE(pixels[i] - 32768, i * 2)
  }

  return Buffer.concat([headerBytes, dataBytes])
}

mkdirSync(outDir, { recursive: true })

console.log('Generating ' + frameCount + ' test frames in: ' + outDir)
for (let i = 0; i < frameCount; i++) {
  const pixels = renderFrame(i)
  const fits = buildFits(pixels, i)
  const name = 'Light_M42_10.0s_IRCUT_' + String(i + 1).padStart(4, '0') + '.fit'
  writeFileSync(join(outDir, name), fits)
  console.log('  created ' + name + ' (' + (fits.length / 1048576).toFixed(1) + ' MB)')
}
console.log('Done. Import this folder into StarLight to try the complete workflow.')
