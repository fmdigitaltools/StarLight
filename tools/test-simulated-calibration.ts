/**
 * Calibration test on simulated frames (tools/simulate-sensor.ts).
 *
 * Real darks, flats and biases are not available, so a simulated sensor with
 * known defects (hot pixels, amplifier glow, row pattern, vignette, dust
 * shadows, PRNU) produces lights, darks, flats and biases. The same engine
 * functions the app uses build the masters, calibrate and stack. The
 * residual of each defect is then measured numerically.
 *
 * Everything runs in memory with no files, but the frames still go through
 * FITS encoding and the app's reader, so the headers are recognized exactly
 * as in real files.
 *
 *   $env:TEST_SCRIPT='tools/test-simulated-calibration.ts'; node tools/run-test.mjs
 */
import type { BayerPattern, FrameMetadata, ImageData32 } from '../src/shared/types'
import { readFits } from '../src/core/fits/reader'
import { encodeFits } from '../src/core/export/encoding'
import { colorAt, debayer, toLuminance } from '../src/core/image/debayer'
import { calibrate, countDefectivePixels, createMaster, defectMap } from '../src/core/stack/calibration'
import {
  conditionsOf,
  correctFlat,
  captureDate,
  dequantize,
  canonicalMaster,
  usableMaster,
  quantize,
  unmosaic,
  chooseMaster,
  type MasterEntry
} from '../src/core/stack/calibrationLibrary'
import {
  noDarkNotice,
  masterConditions,
  lightResult,
  groupCalibration,
  summarizeCalibration,
  usageRow,
  flatCorrectionChoice,
  chooseForLight,
  sessionEntry,
  type CalibrationFrame,
  type CalibrationGroup
} from '../src/core/stack/calibrationGroups'
import { detectStars } from '../src/core/stars/detection'
import { align } from '../src/core/stack/alignment'
import { stack } from '../src/core/stack/stacking'
import {
  COLOR_SENSOR,
  MONO_SENSOR,
  createScene,
  createSensor,
  thermalFactor,
  fitsFile,
  simulatedFrame,
  expectedLight,
  sessionPlan,
  sessionToGroups,
  simulateFrame,
  type SimulatedFrame,
  type SensorParams,
  type Scene,
  type Sensor
} from './simulate-sensor'

let errors = 0
function check(ok: boolean, what: string): void {
  if (!ok) errors++
  console.log((ok ? 'ok   ' : 'NO   ') + what)
}
const note = (text: string): void => console.log('     ' + text)
const f1 = (v: number): string => v.toFixed(1)
const f2 = (v: number): string => v.toFixed(2)
const pc = (v: number, digits = 2): string => (v * 100).toFixed(digits) + ' %'
const ADU = 65535
const a3 = (v: number): string => v.toLocaleString('it-IT')

/* ---- Reading as the app does ---- */

interface ReadResult {
  image: ImageData32
  meta: FrameMetadata
}

/** The frame goes through the FITS file and the app's reader, then color is rebuilt as the analysis worker does. */
function read(s: Sensor, f: SimulatedFrame, adu?: Uint16Array): ReadResult {
  const file = fitsFile(s, adu ?? f.produce(), f.data)
  const r = readFits(file, f.name)
  return { image: debayer(r.image, r.metadata.bayer), meta: r.metadata }
}

/** The master as the Calibrate panel builds it: median, then canonical form. */
function compose(readCount: ReadResult[]): ImageData32 {
  return canonicalMaster(createMaster(readCount.map((l) => l.image)), readCount[0].meta.bayer)
}

/** The library entry of a master, following the rules of the app's save-to-library step (src/renderer/src/calibration/library.ts). */
function entryOf(type: MasterEntry['type'], master: ImageData32, readCount: ReadResult[], created: string): MasterEntry {
  const meta = readCount.map((l) => l.meta)
  const median = (v: (number | null)[]): number | null => {
    const x = v.filter((a): a is number => a !== null).sort((a, b) => a - b)
    return x.length ? (x.length % 2 ? x[x.length >> 1] : (x[(x.length >> 1) - 1] + x[x.length >> 1]) / 2) : null
  }
  const kept = unmosaic(master, meta[0].bayer)
  const { minimum, max } = quantize(kept.data)
  return {
    id: type + '-' + Math.random().toString(16).slice(2),
    type,
    created,
    captured: captureDate(meta.map((m) => m.dateObs)),
    width: master.width,
    height: master.height,
    planes: kept.channels,
    channels: master.channels,
    bayer: meta[0].bayer,
    exposure: median(meta.map((m) => m.exposure)),
    gain: median(meta.map((m) => m.gain)),
    temperature: median(meta.map((m) => m.sensorTemp)),
    instrument: meta[0].instrument,
    filter: type === 'flat' ? meta[0].filter : null,
    frame: readCount.length,
    defectivePixels: 0,
    flatCorrection: null,
    minimum,
    max,
    byte: 0
  }
}

/* ---- Measurements ---- */

/** Value actually measured by the sensor at pixel i (the color of its filter). */
function raw(im: ImageData32, schema: BayerPattern, i: number): number {
  if (im.channels === 1) return im.data[i]
  const x = i % im.width
  const y = (i - x) / im.width
  return im.data[colorAt(schema, x, y) * im.width * im.height + i]
}

function median(v: number[] | Float32Array): number {
  const a = Array.from(v).sort((x, y) => x - y)
  if (a.length === 0) return NaN
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/** Robust deviation (MAD × 1.4826). */
function robustSigma(v: number[]): number {
  const m = median(v)
  return median(v.map((x) => Math.abs(x - m))) * 1.4826
}

/** Mask of the scene's stars as seen from a frame shifted by (dx, dy). */
function starMask(scene: Scene, w: number, h: number, dx = 0, dy = 0): Uint8Array {
  const m = new Uint8Array(w * h)
  for (const st of scene.stars) {
    const r = Math.ceil(st.fwhm * 2 + 3 * Math.log2(1 + st.flux / 40))
    const sx = st.x - dx
    const sy = st.y - dy
    for (let y = Math.max(0, Math.floor(sy - r)); y <= Math.min(h - 1, Math.ceil(sy + r)); y++) {
      for (let x = Math.max(0, Math.floor(sx - r)); x <= Math.min(w - 1, Math.ceil(sx + r)); x++) {
        if ((x - sx) ** 2 + (y - sy) ** 2 <= r * r) m[y * w + x] = 1
      }
    }
  }
  return m
}

/**
 * Residual of a pixel relative to its same-color neighbors (two pixels away,
 * the median of the eight): removes the background and the nebula, leaving
 * the defect of the single pixel.
 */
function pixelResidual(im: ImageData32, schema: BayerPattern, i: number): number {
  const w = im.width
  const x = i % w
  const y = (i - x) / w
  const v: number[] = []
  for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    v.push(raw(im, schema, (y + oy) * w + x + ox))
  }
  return raw(im, schema, i) - median(v)
}

interface HotPixelsResult {
  remaining: number
  total: number
  sigma: number
}

/**
 * True hot pixels (from the model) that remain more than 5 σ above their
 * same-color neighbors in an unshifted frame (sensor coordinates).
 */
function remainingHotPixels(im: ImageData32, schema: BayerPattern, s: Sensor, mask: Uint8Array, minElectrons: number): HotPixelsResult {
  const w = im.width
  const h = im.height
  const rnd = (k: number): number => ((k * 2654435761) >>> 0) % (w * h)
  const background: number[] = []
  for (let k = 0; background.length < 4000 && k < 100000; k++) {
    const i = rnd(k + 1)
    const x = i % w
    const y = (i - x) / w
    if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3 || mask[i]) continue
    background.push(pixelResidual(im, schema, i))
  }
  const sigma = robustSigma(background)
  let remaining = 0
  let total = 0
  for (const c of s.hotPixels) {
    const x = c.index % w
    const y = (c.index - x) / w
    if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3 || mask[c.index]) continue
    if (c.dark * 60 < minElectrons) continue
    total++
    if (Math.abs(pixelResidual(im, schema, c.index)) > 5 * sigma) remaining++
  }
  return { remaining, total, sigma }
}

/**
 * Outlier pixels anywhere: luminance more than 8 σ from the 5 × 5 median,
 * outside the stars. Counts hot pixels, black holes and cosmic rays.
 */
function anomalies(im: ImageData32, mask: Uint8Array, margin = 4): number {
  const w = im.width
  const h = im.height
  const l = toLuminance(im)
  const res = new Float32Array(w * h)
  const v = new Float32Array(25)
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let k = 0
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) v[k++] = l[(y + dy) * w + x + dx]
      v.sort()
      res[y * w + x] = l[y * w + x] - v[12]
    }
  }
  const sample: number[] = []
  for (let i = 0; i < res.length; i += 37) if (!mask[i]) sample.push(res[i])
  const sigma = robustSigma(sample)
  let count = 0
  const where: string[] = []
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const i = y * w + x
      if (!mask[i] && Math.abs(res[i]) > 8 * sigma) {
        count++
        if (where.length < 12) where.push(x + ',' + y + ':' + (res[i] / sigma).toFixed(1))
      }
    }
  }
  if (process.env.VERBOSE) note('  anomalies (σ ' + (sigma * ADU).toFixed(2) + ' ADU): ' + where.join(' '))
  return count
}

/** Per-channel medians of side-`side` blocks, using only pixels actually measured in that color, divided by the channel median. */
function relativeBlocks(im: ImageData32, schema: BayerPattern, side: number, channel: number): { values: number[]; x: number[]; y: number[] } {
  const w = im.width
  const h = im.height
  const allItems: number[] = []
  const values: number[] = []
  const xs: number[] = []
  const ys: number[] = []
  for (let by = 0; by + side <= h; by += side) {
    for (let bx = 0; bx + side <= w; bx += side) {
      const v: number[] = []
      for (let y = by; y < by + side; y++) {
        for (let x = bx; x < bx + side; x++) {
          if (schema !== 'NONE' && colorAt(schema, x, y) !== channel) continue
          v.push(raw(im, schema, y * w + x))
        }
      }
      const m = median(v)
      values.push(m)
      xs.push(bx + side / 2)
      ys.push(by + side / 2)
      allItems.push(m)
    }
  }
  const center = median(allItems)
  return { values: values.map((v) => v / center - 1), x: xs, y: ys }
}

/** Depth of a dust shadow: median over the ring relative to the surrounding crown. */
function dustDepth(im: ImageData32, schema: BayerPattern, channel: number, px: number, py: number, radius: number): number {
  const w = im.width
  const ring: number[] = []
  const outerRing: number[] = []
  for (let y = Math.floor(py - radius * 2); y <= py + radius * 2; y++) {
    for (let x = Math.floor(px - radius * 2); x <= px + radius * 2; x++) {
      if (x < 0 || y < 0 || x >= w || y >= im.height) continue
      if (schema !== 'NONE' && colorAt(schema, x, y) !== channel) continue
      const d = Math.hypot(x - px, y - py)
      const v = raw(im, schema, y * w + x)
      if (d > radius * 0.55 && d < radius * 0.85) ring.push(v)
      else if (d > radius * 1.3 && d < radius * 1.9) outerRing.push(v)
    }
  }
  return 1 - median(ring) / median(outerRing)
}

/**
 * Noise of an image on the pixels actually measured in one color: residual
 * from the mean of the four diagonal neighbors (same color for the green of
 * RGGB and for a monochrome sensor). Returns the pixel σ, corrected for the
 * neighbor averaging and for the row noise that enters it.
 */
function pixelNoise(im: ImageData32, schema: BayerPattern, mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): number[] {
  const w = im.width
  const r: number[] = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (schema !== 'NONE' && colorAt(schema, x, y) !== 1) continue
      const i = y * w + x
      if (mask[i]) continue
      const neighbors = (raw(im, schema, i - w - 1) + raw(im, schema, i - w + 1) + raw(im, schema, i + w - 1) + raw(im, schema, i + w + 1)) / 4
      r.push(raw(im, schema, i) - neighbors)
    }
  }
  return r
}

/** Typical deviation of the row medians (in ADU) after removing the slow trend across rows. */
function rowsReason(im: ImageData32, schema: BayerPattern, scale: number): number {
  const w = im.width
  const h = im.height
  const rows: number[] = []
  for (let y = 0; y < h; y++) {
    const v: number[] = []
    // Green pixels only: in a color sensor the rows alternate red and blue, which have different levels.
    for (let x = 8; x < w - 8; x++) if (schema === 'NONE' || colorAt(schema, x, y) === 1) v.push(raw(im, schema, y * w + x))
    rows.push(median(v) * scale)
  }
  const remainders: number[] = []
  for (let y = 6; y < h - 6; y++) remainders.push(rows[y] - median(rows.slice(y - 6, y + 7)))
  return robustSigma(remainders)
}

function mean(images: ImageData32[]): ImageData32 {
  const d = new Float32Array(images[0].data.length)
  for (const im of images) for (let i = 0; i < d.length; i++) d[i] += im.data[i] / images.length
  return { ...images[0], data: d }
}

/** Light with dark and flat, without defective-pixel correction; computed only once. */
const flatDarkMemory = new WeakMap<ImageData32, ImageData32>()
function onlyFlatDark(light: ImageData32, dark: ImageData32, flat: ImageData32): ImageData32 {
  let r = flatDarkMemory.get(light)
  if (!r) {
    r = calibrate(light, { dark, flat })
    flatDarkMemory.set(light, r)
  }
  return r
}

function maxDifference(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

/* =================================================================== */

interface Test {
  name: string
  p: SensorParams
  lights: number
  temperature: number
  flatExposure: number
  filter: string
}

function testSensor(test: Test): void {
  const t0 = performance.now()
  const s = createSensor(test.p)
  const { width: w, height: h, bayer: schema } = test.p
  const n = w * h
  const scene = createScene(w, h)
  const start = Date.parse('2026-10-12T20:00:00Z')
  const plane = sessionPlan(s, scene, {
    lights: test.lights,
    dark: 9,
    flat: 9,
    bias: 15,
    darkOtherTemperature: 5,
    lightExposure: 60,
    temperature: test.temperature,
    temperatureDeviation: 8,
    flatExposure: test.flatExposure,
    filter: test.filter,
    start,
    dithering: 6,
    seed: 7
  })
  const allItems = (type: string, other = false): SimulatedFrame[] =>
    plane.filter((f) => f.type === type && (type !== 'dark' || /C_\d+\.fit$/.test(f.name) === other))

  console.log('\n===== ' + test.name + ': ' + w + ' × ' + h + (schema === 'NONE' ? ', monochrome' : ', Bayer ' + schema) + ' =====')
  note(
    'model: bias ' + test.p.biasLevel + ' ADU, ' + test.p.electronsPerAdu + ' e⁻/ADU, read ' + test.p.readNoise + ' e⁻, ' +
      'dark current ' + test.p.darkCurrent + ' e⁻/s at ' + test.p.referenceTemperature + ' °C (×2 every ' + test.p.doublingDegrees + ' °C), ' +
      s.hotPixels.length + ' hot pixels, vignette ' + pc(test.p.vignette, 0) + ', ' + s.dusts.length + ' dust spots, PRNU ' + pc(test.p.prnu, 0)
  )

  /* ---- Headers ---- */
  const lights = allItems('light').map((f) => ({ f, l: read(s, f) }))
  const m0 = lights[0].l.meta
  check(
    m0.frameType === 'light' && m0.exposure === 60 && m0.gain === test.p.setGain && m0.bayer === schema &&
      m0.instrument === test.p.instrument && m0.filter === test.filter && m0.sensorTemp !== null &&
      Math.abs(m0.sensorTemp - test.temperature) < 0.5 && m0.dateObs !== null,
    'light headers read like real ones: type, exposure, gain, temperature, filter, Bayer, instrument, date'
  )
  const loadedDarks = allItems('dark').map((f) => read(s, f))
  const flatsRead = allItems('flat').map((f) => read(s, f))
  const biasRead = allItems('bias').map((f) => read(s, f))
  check(
    loadedDarks.every((d) => d.meta.frameType === 'dark') && flatsRead.every((d) => d.meta.frameType === 'flat') && biasRead.every((d) => d.meta.frameType === 'bias'),
    'darks, flats and biases recognized from the header (IMAGETYP)'
  )
  const flatLevel = median(flatsRead[0].image.data.subarray(n, 2 * n).filter((_, i) => i % 97 === 0))
  note('flat: median level' + (schema === 'NONE' ? '' : ' of green') + ' ' + pc(schema === 'NONE' ? median(flatsRead[0].image.data.filter((_, i) => i % 97 === 0)) : flatLevel, 0) + ' of the dynamic range')

  /* ---- Masters, as in the Calibrate panel ---- */
  const bias = compose(biasRead)
  const dark = compose(loadedDarks)
  // No dark at the flats' exposure: the flat is corrected with the bias, as in the panel.
  const flat = correctFlat(compose(flatsRead), bias)
  {
    // Every model hot pixel with at least 100 e⁻ more than its neighbors at this exposure must be found.
    const thermal = thermalFactor(test.p, test.temperature) * 60
    const map = defectMap(dark, 6)
    const obvious = s.hotPixels.filter((c) => {
      const x = c.index % w
      const y = (c.index - x) / w
      return x >= 2 && y >= 2 && x < w - 2 && y < h - 2 && (c.dark - test.p.darkCurrent) * thermal > 100
    })
    const taken = obvious.filter((c) => map.planes[c.index] !== 0).length
    note('defective pixels found in the master dark: ' + a3(countDefectivePixels(dark)) + ' (in the model ' + a3(s.hotPixels.length) + ' pixels above 10 times the typical dark current, not all above the threshold, plus the tail of normal pixels)')
    note('obvious hot pixels (over 100 e⁻ in 60 s) recognized: ' + taken + ' of ' + obvious.length + '; flagged pixels (including color neighbors): ' + a3(map.pixel.length))
    check(taken === obvious.length, 'all obvious hot pixels are recognized in the master dark')
    // The amplifier glow rises gradually: it must not turn into a patch of defective pixels.
    const side = Math.floor(Math.min(w, h) * 0.08)
    let inGlow = 0
    for (let y = 2; y < side; y++) for (let x = w - side; x < w - 2; x++) if (map.planes[y * w + x] !== 0 && s.dark[y * w + x] - s.glow[y * w + x] < test.p.darkCurrent * 10) inGlow++
    note('normal pixels flagged as defective in the glow corner: ' + inGlow + ' of ' + a3((side - 2) * (side - 2)))
    // A few are: in the glow the dark is noisier and some pixels exceed the threshold, which is measured over the whole sensor.
    check(inGlow <= side * side * 0.05, 'the amplifier glow is not mistaken for a patch of defective pixels (at most 5 % of the corner pixels)')
  }

  // The master in the sensor format matches the median of the raw frames.
  if (schema !== 'NONE') {
    const rawDarks = allItems('dark').map((f) => readFits(fitsFile(s, f.produce(), f.data), f.name).image)
    const sensor = unmosaic(dark, schema)
    const direct = createMaster(rawDarks)
    check(sensor.channels === 1 && maxDifference(sensor.data, direct.data) === 0, 'color master kept in the sensor format (one Bayer plane): identical to the median of the raw frames')
  }

  /* ---- Hot pixels ---- */
  const L0 = lights[0].l.image
  const mask0 = starMask(scene, w, h)
  const onlyBias = calibrate(L0, { bias })
  const onlyDark = calibrate(L0, { dark })
  const full = calibrate(L0, { dark, flat, correctDefectivePixels: true })
  if (schema !== 'NONE') {
    // Calibrating in the sensor format (before color reconstruction, with
    // the masters kept in that format) or afterwards, as the app does, gives
    // the same result: bilinear reconstruction is linear and leaves measured
    // pixels unchanged.
    const rawValue = readFits(fitsFile(s, lights[0].f.produce(), lights[0].f.data), lights[0].f.name).image
    const inSensor = debayer(calibrate(rawValue, { dark: unmosaic(dark, schema) }), schema)
    let different = 0
    for (let i = 0; i < inSensor.data.length; i++) if (Math.abs(inSensor.data[i] - onlyDark.data[i]) > 1e-6) different++
    const withSensorFlat = calibrate(rawValue, { dark: unmosaic(dark, schema), flat: unmosaic(flat, schema) })
    // In the sensor format the flat is normalized over all colors together: channels are compared up to a scale factor.
    let flatDeviation = 0
    for (let c = 0; c < 3; c++) {
      const ratios: number[] = []
      for (let i = 0; i < n; i += 3) {
        const x = i % w
        const y = (i - x) / w
        if (colorAt(schema, x, y) !== c || withSensorFlat.data[i] < 1e-3) continue
        ratios.push(onlyFlatDark(L0, dark, flat).data[c * n + i] / withSensorFlat.data[i])
      }
      const m = median(ratios)
      for (const r of ratios) flatDeviation = Math.max(flatDeviation, Math.abs(r / m - 1))
    }
    note('calibration in the sensor format versus after color reconstruction: differing values ' + different + ' (dark), maximum relative deviation with the flat ' + flatDeviation.toExponential(1))
    check(different <= n * 3 * 0.001 && flatDeviation < 1e-4, 'calibrating before or after color reconstruction gives the same result (master in the sensor format)')
  }

  const minE = 200
  const cRaw =remainingHotPixels(L0, schema, s, mask0, minE)
  const cBiasOnly = remainingHotPixels(onlyBias, schema, s, mask0, minE)
  const cDarkOnly = remainingHotPixels(onlyDark, schema, s, mask0, minE)
  const cFull = remainingHotPixels(full, schema, s, mask0, minE)
  note('hot pixels (over ' + minE + ' e⁻ in 60 s) still above 5 σ from neighbors in a light:')
  note('  raw ' + cRaw.remaining + ' / ' + cRaw.total + ', bias only ' + cBiasOnly.remaining + ', dark subtracted ' + cDarkOnly.remaining + ', full calibration ' + cFull.remaining)
  check(cRaw.remaining > 0.9 * cRaw.total, 'almost all hot pixels are visible in the raw light')
  // After subtracting the dark, the thermal-signal noise of the hottest pixels remains and saturated ones become holes: that is why the correction is needed.
  check(cDarkOnly.remaining <= 0.25 * cDarkOnly.total, 'after dark subtraction at most a quarter remain (noise of the hottest and saturated ones)')
  check(cFull.remaining <= 0.02 * cFull.total + 1, 'with defective-pixel correction at most 2 % remain')

  /* ---- Background noise against the expected value ---- */
  {
    // Star-free box near the center: the measured noise of the subtracted
    // dark compared with the model prediction.
    const x0 = Math.floor(w * 0.55)
    const y0 = Math.floor(h * 0.25)
    const x1 = x0 + 160
    const y1 = y0 + 120
    const theoreticalLight = expectedLight(s, scene, 0, 0)
    const k = 1 / test.p.electronsPerAdu
    const term = thermalFactor(test.p, lights[0].l.meta.sensorTemp ?? test.temperature) * 60
    let sum = 0
    let count = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x
        if ((schema !== 'NONE' && colorAt(schema, x, y) !== 1) || mask0[i]) continue
        if (s.dark[i] > test.p.darkCurrent * 10) continue
        const e = theoreticalLight[i] * s.response[i] * 60
        const d = s.dark[i] * term
        // Light: Poisson and read noise; master dark: median of 9 (efficiency ≈ 1.5).
        sum += (e + d) * k * k + test.p.readNoise * test.p.readNoise * k * k + ((d * k * k + test.p.readNoise ** 2 * k * k) * 1.5) / loadedDarks.length
        count++
      }
    }
    const rows = test.p.randomRows ** 2 * (1 + 1.5 / loadedDarks.length)
    const wait = Math.sqrt(sum / count)
    const residuals = pixelNoise(onlyDark, schema, mask0, x0, y0, x1, y1)
    const measured = Math.sqrt(Math.max(0, (robustSigma(residuals) * ADU) ** 2 - rows * 1.5) / 1.25)
    note('background noise with the dark subtracted: ' + f2(measured) + ' ADU, expected from the model ' + f2(wait) + ' ADU')
    check(Math.abs(measured / wait - 1) < 0.08, 'background noise is as expected (within 8 %): calibration adds no noise')
    // With the flat, noise scales like the signal, nothing more.
    const withFlat = robustSigma(pixelNoise(full, schema, mask0, x0, y0, x1, y1))
    const signalRatio = median(greenData(full, schema, x0, y0, x1, y1)) / median(greenData(onlyDark, schema, x0, y0, x1, y1))
    const noiseRatio = withFlat / robustSigma(residuals)
    note('with the flat: signal ×' + signalRatio.toFixed(3) + ', noise ×' + noiseRatio.toFixed(3))
    check(Math.abs(noiseRatio / signalRatio - 1) < 0.05, 'the flat scales noise like the signal (within 5 %): it adds none')
  }

  /* ---- Row pattern ---- */
  {
    const rawValues = mean(lights.map((x) => x.l.image))
    const calibratedFrames = mean(lights.map((x) => calibrate(x.l.image, { dark, flat, correctDefectivePixels: true })))
    const before = rowsReason(rawValues, schema, ADU)
    const after = rowsReason(calibratedFrames, schema, ADU)
    note('row pattern in the mean of the ' + lights.length + ' lights (on the sensor): before ' + f2(before) + ' ADU, after ' + f2(after) + ' ADU (model fixed pattern ' + test.p.biasRows + ' ADU)')
    check(after < 0.45 * before, 'the fixed row pattern disappears with calibration (the per-shot row noise remains)')
  }

  /* ---- Vignette and dust on a uniform sky ---- */
  {
    const uniformValue = createScene(w, h, { stars: false, nebula: false, background: [40, 50, 35], gradient: [0, 0] })
    const lightU = expectedLight(s, uniformValue, 0, 0)
    const tests: ImageData32[] = []
    const onlyDarkU: ImageData32[] = []
    for (let k = 0; k < 4; k++) {
      const f = { ...lights[0].f, produce: () => simulateFrame(s, { type: 'light', exposure: 60, temperature: test.temperature, light: lightU, seed: 900 + k }) }
      const l = read(s, f).image
      tests.push(calibrate(l, { dark, flat, correctDefectivePixels: true }))
      onlyDarkU.push(calibrate(l, { dark }))
    }
    const after = mean(tests)
    const before = mean(onlyDarkU)
    const channels = schema === 'NONE' ? [0] : [0, 1, 2]
    for (const c of channels) {
      const bBefore = relativeBlocks(before, schema, 32, c).values
      const bAfter = relativeBlocks(after, schema, 32, c).values
      const maxBefore = Math.max(...bBefore.map(Math.abs))
      const maxAfter = Math.max(...bAfter.map(Math.abs))
      const name = schema === 'NONE' ? 'mono' : 'RGB'[c]
      note('uniform sky, channel ' + name + ': maximum deviation of 32 × 32 blocks from flat: without flat ' + pc(maxBefore, 1) + ', with the flat ' + pc(maxAfter, 2))
      check(maxAfter < 0.01, 'vignette corrected by the flat in channel ' + name + ' (deviation < 1 %)')
    }
    for (const pol of s.dusts) {
      const c = schema === 'NONE' ? 0 : 1
      const a = dustDepth(before, schema, c, pol.x, pol.y, pol.radius)
      const b = dustDepth(after, schema, c, pol.x, pol.y, pol.radius)
      note('dust at (' + Math.round(pol.x) + ', ' + Math.round(pol.y) + '), radius ' + f1(pol.radius) + ' px, depth ' + pc(pol.depth, 1) + ': without flat ' + pc(a, 2) + ', with the flat ' + pc(b, 2))
      check(Math.abs(b) < 0.004, 'dust shadow gone (residual < 0.4 %)')
    }
    if (schema !== 'NONE') {
      const ratios = (im: ImageData32): [number, number] => {
        const m = [0, 1, 2].map((c) => median(channelData(im, schema, c)))
        return [m[0] / m[1], m[2] / m[1]]
      }
      const [rp, bp] = ratios(before)
      const [rd, bd] = ratios(after)
      note('color balance of the uniform sky R/G, B/G: without flat ' + rp.toFixed(3) + ', ' + bp.toFixed(3) + '; with the flat ' + rd.toFixed(3) + ', ' + bd.toFixed(3))
      check(Math.abs(rd / rp - 1) < 0.01 && Math.abs(bd / bp - 1) < 0.01, 'the flat corrects the light without changing the color balance (the panel color does not leak into the light)')
    }
  }

  /* ---- The master stored at 16 bits ---- */
  {
    let worst = 0
    for (const [name, m] of [['dark', dark], ['flat', flat], ['bias', bias]] as const) {
      const kept = unmosaic(m, schema)
      const { values, minimum, max } = quantize(kept.data)
      const reread = usableMaster({ ...kept, data: dequantize(values, minimum, max) }, schema)
      const step = (max - minimum) / 65535
      const rejection = maxDifference(reread.data, m.data)
      // Beyond half a step, only the rounding of 32-bit numbers.
      worst = Math.max(worst, (rejection - 4e-7) / step)
      note('master ' + name + ' at 16 bits: maximum deviation ' + (rejection * ADU).toFixed(4) + ' ADU (half step ' + ((step / 2) * ADU).toFixed(4) + ' ADU)')
    }
    check(worst <= 0.5001, 'masters saved at 16 bits and read back equal within half a step')
    // The light calibrated with the re-read masters versus the one calibrated with the session masters.
    const rereading = (m: ImageData32): ImageData32 => {
      const c = unmosaic(m, schema)
      const q = quantize(c.data)
      return usableMaster({ ...c, data: dequantize(q.values, q.minimum, q.max) }, schema)
    }
    const compare = (correction: boolean): { different: number; maxDeviation: number } => {
      const a = calibrate(L0, { dark, flat, correctDefectivePixels: correction })
      const b = calibrate(L0, { dark: rereading(dark), flat: rereading(flat), correctDefectivePixels: correction })
      let different = 0
      let maxDeviation = 0
      for (let i = 0; i < a.data.length; i++) {
        const d = Math.abs(a.data[i] - b.data[i])
        if (d > 0.05 * sigma) different++
        maxDeviation = Math.max(maxDeviation, d)
      }
      return { different, maxDeviation }
    }
    const sigma = robustSigma(pixelNoise(full, schema, mask0, 50, 50, 250, 250))
    const without = compare(false)
    const combined = compare(true)
    note('light calibrated with re-read masters versus session masters: maximum deviation ' + (without.maxDeviation / sigma).toFixed(4) + ' σ of the background')
    note('  with defective-pixel correction: values differing by more than 0.05 σ: ' + combined.different + ' of ' + a3(n * full.channels) + ' (pixels at the threshold limit, corrected in one case and not the other)')
    check(without.maxDeviation < 0.05 * sigma, 'calibration with library masters gives the same light as with session masters (within 0.05 σ)')
    check(combined.different <= n * full.channels * 0.0005, 'even with defective-pixel correction at most 0.05 % of values change')
    // The 16-bit FITS export also preserves the master.
    const fits = readFits(new Uint8Array(encodeFits(dark, {}, 16)))
    const fitsDeviation = maxDifference(fits.image.data, dark.data)
    check(fitsDeviation <= 0.5 / 65535 + 1e-7, 'master dark as 16-bit FITS read back within half a step (' + (fitsDeviation * ADU).toFixed(3) + ' ADU)')
  }

  /* ---- Library: temperature, filter, age ---- */
  const otherDarks = allItems('dark', true).map((f) => read(s, f))
  const warmDark = compose(otherDarks)
  const today = '2026-10-18T12:00:00Z'
  const cond = conditionsOf(m0, w, h, L0.channels as 1 | 3)
  const vDark = entryOf('dark', dark, loadedDarks, today)
  const vHot = entryOf('dark', warmDark, otherDarks, today)
  const vFlat = entryOf('flat', flat, flatsRead, today)
  const vBias = entryOf('bias', bias, biasRead, today)
  note('library: dark at ' + f1(vDark.temperature ?? NaN) + ' °C and at ' + f1(vHot.temperature ?? NaN) + ' °C; light at ' + f1(cond.temperature ?? NaN) + ' °C')
  check(chooseMaster([vHot, vDark], 'dark', cond)?.entry === vDark, 'library: the dark at the light’s temperature is chosen')
  check(chooseMaster([vHot], 'dark', cond) === null, 'library: the dark 8 °C warmer is not chosen (outside ±3 °C)')
  check(chooseMaster([vHot, vBias], 'bias', cond)?.entry === vBias, 'library: without a suitable dark the bias remains')
  check(chooseMaster([vFlat], 'flat', cond)?.entry === vFlat, 'library: the flat from the same evening and filter is chosen')
  const otherFilter = { ...vFlat, id: 'altro', filter: test.filter === 'L' ? 'Ha' : 'IRCUT' }
  check(chooseMaster([otherFilter], 'flat', cond) === null, 'library: a flat of another filter is rejected')
  // Age: what counts is the date the flats were captured, not the date
  // the master was composed.
  const old = { ...vFlat, id: 'old', captured: '2026-09-01T19:00:00Z', created: today }
  check(chooseMaster([old], 'flat', cond) === null, 'library: a flat captured 41 days before the light is rejected, even if composed today')
  const late = { ...vFlat, id: 'late', captured: vFlat.captured, created: '2026-12-01T10:00:00Z' }
  check(chooseMaster([late], 'flat', cond)?.entry === late, 'library: a flat from the same evening composed weeks later remains valid')

  // What would happen if the warmer dark were used anyway.
  {
    const wrongValue = calibrate(L0, { dark: warmDark, flat, correctDefectivePixels: true })
    const correct = full
    const zones = (im: ImageData32, x0: number, y0: number, side: number): number => {
      const v: number[] = []
      for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) if (!mask0[y * w + x]) v.push(raw(im, schema, y * w + x))
      return median(v) * ADU
    }
    const side = Math.floor(Math.min(w, h) * 0.06)
    const correctBackground = zones(correct, Math.floor(w * 0.6), Math.floor(h * 0.25), side)
    const wrongBackground = zones(wrongValue, Math.floor(w * 0.6), Math.floor(h * 0.25), side)
    const correctAngle = zones(correct, w - side - 2, 2, side)
    const wrongAngle = zones(wrongValue, w - side - 2, 2, side)
    let blacks = 0
    let blacksCorrect = 0
    for (let i = 0; i < n; i++) {
      if (raw(wrongValue, schema, i) === 0) blacks++
      if (raw(correct, schema, i) === 0) blacksCorrect++
    }
    const wrongHotPixels = remainingHotPixels(wrongValue, schema, s, mask0, minE)
    note('if the dark 8 °C warmer were used (dark current ×' + f2(thermalFactor(test.p, test.temperature + 8)) + '):')
    note('  background ' + f1(wrongBackground) + ' ADU instead of ' + f1(correctBackground) + '; glow corner ' + f1(wrongAngle) + ' instead of ' + f1(correctAngle) +
      '; zeroed pixels ' + blacks + ' instead of ' + blacksCorrect + '; hot pixels still visible ' + wrongHotPixels.remaining + ' (as holes or remnants)')
    check(wrongBackground < correctBackground, 'a dark that is too warm removes too much: the library is right not to choose it')
  }

  /* ---- Stacking ---- */
  {
    const calibratedFrames = lights.map((x) => calibrate(x.l.image, { dark, flat, correctDefectivePixels: true }))
    const withBias = lights.map((x) => calibrate(x.l.image, { bias, flat }))
    const stars = calibratedFrames.map((im) => detectStars(im))
    const transforms = [{ a: 1, b: 0, tx: 0, ty: 0 }]
    let maxError = 0
    let validItems = true
    for (let k = 1; k < calibratedFrames.length; k++) {
      const r = align(stars[0], stars[k])
      validItems &&= r.valid
      transforms.push(r.transformation)
      // The transformations map the frame to the reference: pixel (x, y)
      // of frame k sees the sky at (x + dx, y + dy) of the reference.
      const [dx, dy] = lights[k].f.shift ?? [0, 0]
      maxError = Math.max(maxError, Math.hypot(r.transformation.tx - dx, r.transformation.ty - dy))
      if (process.env.VERBOSE) note('  frame ' + k + ': ' + r.transformation.tx.toFixed(3) + ', ' + r.transformation.ty.toFixed(3) + ' versus ' + dx.toFixed(3) + ', ' + dy.toFixed(3))
    }
    note('stars found in the first calibrated light: ' + stars[0].length + '; maximum alignment deviation from the true dithering: ' + maxError.toFixed(3) + ' px')
    check(validItems && maxError < 0.15, 'alignment of the calibrated lights within 0.15 px of the simulated dithering')
    const opt = { method: 'rejection' as const, rejectionThreshold: 3 }
    const stackResult = stack(calibratedFrames.map((im, k) => ({ image: im, transformation: transforms[k], weight: 1 })), opt)
    const biasStack = stack(withBias.map((im, k) => ({ image: im, transformation: transforms[k], weight: 1 })), opt)
    const mask = starMask(scene, w, h)
    // In the stacked image the borders as wide as the dithering receive fewer frames: only the inner pixels are examined.
    const margin = 4 + 6 + 2
    // For the single light, a shot without cosmic rays: those of one
    // shot are removed by stacking, not by calibration.
    const withoutRays: Sensor = { ...s, p: { ...s.p, cosmicRays: 0 } }
    const cleanedAdu = simulateFrame(withoutRays, { type: 'light', exposure: 60, temperature: lights[0].f.data.temperature, light: expectedLight(s, scene, 0, 0), seed: 777 })
    const L0Clean = read(s, lights[0].f, cleanedAdu).image
    const rawA = anomalies(L0Clean, mask, margin)
    const biasA = anomalies(calibrate(L0Clean, { bias, flat }), mask, margin)
    const calibratedA = anomalies(calibrate(L0Clean, { dark, flat, correctDefectivePixels: true }), mask, margin)
    const stackA = anomalies(stackResult.image, mask, margin)
    const stackBiasA = anomalies(biasStack.image, mask, margin)
    note('outlier pixels (over 8 σ from neighbors, outside stars and borders): raw light ' + rawA + ', calibrated ' + calibratedA + ', stacked ' + stackA)
    note('without dark (bias and flat only, as when the library has no suitable dark): light ' + biasA + ', stacked with rejection ' + stackBiasA)
    check(calibratedA <= 0.02 * rawA + 1, 'calibration removes at least 98 % of the outlier pixels of a light')
    check(stackA <= 2, 'no outlier pixels remain in the calibrated stack (cosmic rays are rejected too)')
    check(stackBiasA <= Math.max(5, biasA * 0.1), 'without a dark, dithering and rejection remove at least 90 % of the hot pixels from the stack')

    // Noise: means over 4 × 4 pixel blocks, minus the mean of the
    // neighboring blocks. On blocks, interpolation (color reconstruction,
    // alignment) no longer matters, and the comparison between a single
    // frame and the stack is fair.
    const blockNoise = (im: ImageData32): number => {
      const plane = im.channels === 3 ? n : 0
      const side = 4
      const bx0 = Math.floor((w * 0.55) / side)
      const by0 = Math.floor((h * 0.15) / side)
      const nbx = 60
      const nby = 45
      const means = new Float64Array(nbx * nby).fill(NaN)
      for (let by = 0; by < nby; by++) {
        for (let bx = 0; bx < nbx; bx++) {
          let sum = 0
          let free = true
          for (let y = 0; y < side && free; y++) {
            for (let x = 0; x < side; x++) {
              const i = ((by0 + by) * side + y) * w + (bx0 + bx) * side + x
              if (mask[i]) {
                free = false
                break
              }
              sum += im.data[plane + i]
            }
          }
          if (free) means[by * nbx + bx] = sum / (side * side)
        }
      }
      const residuals: number[] = []
      for (let by = 1; by < nby - 1; by++) {
        for (let bx = 1; bx < nbx - 1; bx++) {
          const m = means[by * nbx + bx]
          let sum = 0
          let count = 0
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const v = means[(by + dy) * nbx + bx + dx]
            if ((dx || dy) && !Number.isNaN(v)) {
              sum += v
              count++
            }
          }
          if (!Number.isNaN(m) && count === 8) residuals.push(m - sum / 8)
        }
      }
      return robustSigma(residuals)
    }
    const gain = blockNoise(calibratedFrames[0]) / blockNoise(stackResult.image)
    note('background noise: stack ' + gain.toFixed(2) + ' times lower than a single frame (√' + calibratedFrames.length + ' = ' + Math.sqrt(calibratedFrames.length).toFixed(2) + ')')
    check(gain > 0.85 * Math.sqrt(calibratedFrames.length), 'noise drops as expected from stacking (at least 85 % of √N)')

    // Amplifier glow: the top-right corner against a nearby area, minus
    // the difference that genuinely exists in the sky (the gradient).
    const side = Math.floor(Math.min(w, h) * 0.05)
    const sky = expectedLight(s, scene, 0, 0)
    const zone = (im: ImageData32 | Float32Array, x0: number): number => {
      const v: number[] = []
      for (let y = 10; y < 10 + side; y++) {
        for (let x = x0; x < x0 + side; x++) {
          const i = y * w + x
          if (mask[i] || (schema !== 'NONE' && colorAt(schema, x, y) !== 1)) continue
          v.push(im instanceof Float32Array ? im[i] : raw(im, schema, i))
        }
      }
      return median(v)
    }
    const xAngle = w - side - margin
    const xNeighbor = w - 4 * side - margin
    const expected = zone(sky, xAngle) / zone(sky, xNeighbor)
    const glow = (im: ImageData32): number => (zone(im, xAngle) - expected * zone(im, xNeighbor)) * ADU
    note('amplifier glow left in the corner: calibrated stack ' + f1(glow(stackResult.image)) + ' ADU, stack without dark ' + f1(glow(biasStack.image)) + ' ADU (sky background ' + f1(zone(stackResult.image, xNeighbor) * ADU) + ' ADU)')
    check(Math.abs(glow(stackResult.image)) < 2, 'the amplifier glow disappears with the dark (under 2 ADU)')
  }

  console.log('     (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s)')
}

function greenData(im: ImageData32, schema: BayerPattern, x0: number, y0: number, x1: number, y1: number): number[] {
  const v: number[] = []
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (schema === 'NONE' || colorAt(schema, x, y) === 1) v.push(raw(im, schema, y * im.width + x))
  return v
}

function channelData(im: ImageData32, schema: BayerPattern, c: number): number[] {
  const v: number[] = []
  for (let y = 0; y < im.height; y += 1) for (let x = 0; x < im.width; x += 1) if (colorAt(schema, x, y) === c && (x * 7 + y * 13) % 5 === 0) v.push(raw(im, schema, y * im.width + x))
  return v
}

function toLuminanceValue(im: ImageData32, i: number): number {
  if (im.channels === 1) return im.data[i]
  const n = im.width * im.height
  return (im.data[i] + im.data[n + i] + im.data[2 * n + i]) / 3
}

/* =================================================================== */
/*  Several condition groups in the same session                        */
/* =================================================================== */

/** A frame read as the Calibrate panel sees it. */
function asCalibration(f: SimulatedFrame, l: ReadResult): CalibrationFrame {
  return {
    id: f.name,
    name: f.name,
    path: 'simulated/' + f.name,
    type: f.type as CalibrationFrame['type'],
    width: l.image.width,
    height: l.image.height,
    channels: l.image.channels as 1 | 3,
    meta: l.meta
  }
}

interface TestMaster {
  entry: MasterEntry
  image: ImageData32
}

interface CompositeSession {
  session: TestMaster[]
  groups: CalibrationGroup[]
  rejected: ReturnType<typeof groupCalibration>['rejected']
  corrections: Map<string, { type: 'dark' | 'bias'; id: string } | null>
}

/**
 * The Calibrate panel's composition: group, then bias, dark and flat in
 * that order, each flat corrected with the dark of its exposure or with the
 * bias of its gain (flat-correction choice).
 */
function composeSession(calibration: { f: SimulatedFrame; l: ReadResult }[], library: MasterEntry[]): CompositeSession {
  const byId = new Map(calibration.map((x) => [x.f.name, x.l]))
  const { groups, rejected } = groupCalibration(calibration.map((x) => asCalibration(x.f, x.l)))
  const session: TestMaster[] = []
  const corrections = new Map<string, { type: 'dark' | 'bias'; id: string } | null>()
  for (const type of ['bias', 'dark', 'flat'] as const) {
    for (const g of groups.filter((x) => x.type === type)) {
      const readCount = g.frame.map((f) => byId.get(f.id) as ReadResult)
      let master = compose(readCount)
      const c = masterConditions(type, master.width, master.height, master.channels as 1 | 3, readCount.map((l) => l.meta))
      let correction: 'dark' | 'bias' | null = null
      if (type === 'flat') {
        const choice = flatCorrectionChoice(session.map((m) => m.entry), library, c)
        corrections.set(g.key, choice ? { type: choice.type, id: choice.choice.entry.id } : null)
        if (choice) {
          const toSubtract = session.find((m) => m.entry.id === choice.choice.entry.id)?.image
          if (toSubtract) {
            master = correctFlat(master, toSubtract)
            correction = choice.type
          }
        }
      }
      session.push({ entry: sessionEntry(g.key, c, { flatCorrection: correction }), image: master })
    }
  }
  return { session, groups, rejected, corrections }
}

/** The calibration of one light as the app does when analyzing a frame: masters chosen by conditions, on the spot. */
function calibrateLight(l: ReadResult, composed: CompositeSession, library: TestMaster[]): { image: ImageData32; choice: ReturnType<typeof chooseForLight> } {
  const c = conditionsOf(l.meta, l.image.width, l.image.height, l.image.channels as 1 | 3)
  const choice = chooseForLight(composed.session.map((m) => m.entry), library.map((m) => m.entry), c)
  const imageOf = (m: { entry: MasterEntry } | null): ImageData32 | null =>
    m ? ([...composed.session, ...library].find((x) => x.entry.id === m.entry.id)?.image ?? null) : null
  const dark = imageOf(choice.dark)
  const copy: ImageData32 = { ...l.image, data: new Float32Array(l.image.data) }
  const image =
    dark || choice.flat || choice.bias
      ? calibrate(copy, { dark, flat: imageOf(choice.flat), bias: imageOf(choice.bias), correctDefectivePixels: dark !== null, inPlace: true })
      : copy
  return { image, choice }
}

function describeMasterTest(v: MasterEntry | undefined): string {
  if (!v) return '?'
  return (
    v.type + ' ' + (v.exposure ?? '-') + ' s, gain ' + (v.gain ?? '-') + ', ' +
    (v.temperature === null ? '-' : v.temperature.toFixed(1)) + ' °C' + (v.filter ? ', ' + v.filter : '')
  )
}

function describeGroupTest(g: CalibrationGroup): string {
  return describeMasterTest(sessionEntry(g.key, g.conditions)) + (g.night ? ', ' + g.night : '')
}

function testGroups(): void {
  const t0 = performance.now()
  console.log('\n===== Several groups in the same session: two exposures, two temperatures, two filters, two nights =====')
  const p: SensorParams = { ...COLOR_SENSOR, width: 512, height: 384 }
  const s = createSensor(p)
  const { width: w, height: h, bayer: schema } = p
  const scene = createScene(w, h)
  const night1 = Date.parse('2026-10-12T20:00:00Z')
  const plane = sessionToGroups(s, scene, { lights: 3, lightsWithoutDark: 2 })
  const readCount = plane.map((f) => ({ f, l: read(s, f) }))
  const calib = readCount.filter((x) => x.f.type !== 'light')
  const lights = readCount.filter((x) => x.f.type === 'light')
  const composed = composeSession(calib, [])
  for (const g of composed.groups) note('group: ' + describeGroupTest(g) + ', ' + g.frame.length + ' frames')
  for (const x of composed.rejected) note('excluded: ' + x.frame.name + ' ' + x.reason)

  const ofKind = (t: string): CalibrationGroup[] => composed.groups.filter((g) => g.type === t)
  check(ofKind('dark').length === 4, 'four dark groups: 60 s at 18 °C, 60 s at 26 °C, 30 s at 18 °C, 1.5 s (flat darks)')
  const g60 = ofKind('dark').find((g) => g.conditions.exposure !== null && Math.abs(g.conditions.exposure - 60) < 1 && (g.conditions.temperature ?? 0) < 20)
  check(g60?.frame.length === 6, 'the 60.3 s dark joins the 60 s group (exposure within 1 %)')
  check(composed.rejected.length === 1 && composed.rejected[0].frame.name.startsWith('Dark_60s_22C'), 'the isolated dark at 22 °C is excluded, with an explanation')
  check(ofKind('bias').length === 2, 'two bias groups, one for each gain')
  check(ofKind('flat').length === 2 && ofKind('flat').every((g) => g.night !== null), 'two flat groups, one for each filter and night')
  {
    const lp = ofKind('flat').find((g) => g.conditions.filter === 'LP') as CalibrationGroup
    const ha = ofKind('flat').find((g) => g.conditions.filter === 'Ha') as CalibrationGroup
    const cLp = composed.corrections.get(lp.key)
    const cHa = composed.corrections.get(ha.key)
    const entry = (id: string | undefined): MasterEntry | undefined => composed.session.find((m) => m.entry.id === id)?.entry
    note(
      'flat LP corrected with: ' + (cLp ? cLp.type + ' ' + describeMasterTest(entry(cLp.id)) : 'nothing') +
        '; flat Ha with: ' + (cHa ? cHa.type + ' ' + describeMasterTest(entry(cHa.id)) : 'nothing')
    )
    check(cLp?.type === 'dark' && entry(cLp.id)?.exposure === 1.5, 'the LP flat is corrected with the dark of its exposure (1.5 s)')
    check(cHa?.type === 'bias' && entry(cHa.id)?.gain === 100, 'the Ha flat, with no dark at its exposure, is corrected with the bias of its gain (100, not 200)')
  }

  // Each light: the right group, never a dark outside tolerance.
  const results: ReturnType<typeof lightResult>[] = []
  let outside = 0
  let wrongItems = 0
  const calibratedFrames = new Map<string, { image: ImageData32; choice: ReturnType<typeof chooseForLight> }>()
  for (const x of lights) {
    const r = calibrateLight(x.l, composed, [])
    calibratedFrames.set(x.f.name, r)
    const c = conditionsOf(x.l.meta, w, h, 3)
    results.push(lightResult(r.choice, c, composed.session.map((m) => m.entry)))
    const d = r.choice.dark?.entry
    if (d) {
      const exposureOk = d.exposure !== null && c.exposure !== null && Math.abs(d.exposure - c.exposure) <= 0.01 * c.exposure
      const tempOk = d.temperature !== null && c.temperature !== null && Math.abs(d.temperature - c.temperature) <= 3
      if (!exposureOk || !tempOk || d.gain !== c.gain) outside++
    }
    const expected = x.f.name.startsWith('Light_45s')
      ? !d && r.choice.bias?.entry.gain === 100
      : !!d && d.exposure !== null && Math.abs(d.exposure - (c.exposure as number)) < 0.5 && Math.abs((d.temperature as number) - (c.temperature as number)) < 1
    const flatOk = r.choice.flat?.entry.filter === x.l.meta.filter
    if (!expected || !flatOk) {
      wrongItems++
      note('  ' + x.f.name + ': dark ' + (d ? describeMasterTest(d) : 'none') + ', flat ' + (r.choice.flat ? describeMasterTest(r.choice.flat.entry) : 'none'))
    }
  }
  check(wrongItems === 0, 'each light gets the dark of its exposure and temperature and the flat of its filter (60 s lights at 18 and 26 °C, 30 s, 45 s)')
  check(outside === 0, 'no light gets a dark outside tolerance (exposure ±1 %, same gain, ±3 °C)')

  // Summary by light groups.
  const summary = summarizeCalibration(results)
  note('stacking summary:')
  for (const g of summary) {
    note('  ' + g.description)
    note('    dark: ' + (g.dark ? usageRow(g.dark) : 'none' + (g.withoutDark ? ' (' + g.withoutDark + ')' : '')))
    note('    flat: ' + (g.flat ? usageRow(g.flat) : 'none'))
    note('    bias: ' + (g.bias ? usageRow(g.bias) : g.dark ? 'not needed' : 'none'))
  }
  const notices = summary.map(noDarkNotice).filter((a): a is string => a !== null)
  for (const a of notices) note('notice: ' + a)
  check(summary.length === 4, 'summary in four light groups, one per master combination')
  check(
    notices.length === 1 && notices[0].startsWith('2 luci da 45 s') && notices[0].includes('nessun dark ha la posa di 45 s') && notices[0].includes('con bias e flat'),
    'a single notice: the two 45 s lights, calibrated with bias and flat, without a dark, with the reason'
  )

  // Lights calibrated with their own group: the hot pixels disappear.
  const mask = starMask(scene, w, h)
  for (const prefix of ['Light_60s_LP_18C', 'Light_30s_LP_18C', 'Light_60s_Ha_26C']) {
    const r = calibratedFrames.get(prefix + '_0001.fit') as { image: ImageData32 }
    const hotPixels = remainingHotPixels(r.image, schema, s, mask, 200)
    note(prefix + ': hot pixels over 5 σ after calibration: ' + hotPixels.remaining + ' of ' + hotPixels.total)
    check(hotPixels.remaining <= 0.02 * hotPixels.total + 1, 'lights ' + prefix.slice(6).replace(/_/g, ' ') + ': hot pixels removed by the dark of their own group')
  }
  {
    // The light at 26 °C with the dark at 18 °C: what a single master would do.
    const light = lights.find((x) => x.f.name === 'Light_60s_Ha_26C_0001.fit') as { l: ReadResult }
    const d18 = composed.session.find((m) => m.entry.type === 'dark' && m.entry.exposure === 60 && (m.entry.temperature as number) < 20) as TestMaster
    const correct = calibratedFrames.get('Light_60s_Ha_26C_0001.fit') as { image: ImageData32; choice: ReturnType<typeof chooseForLight> }
    const flatHa = composed.session.find((m) => m.entry.id === correct.choice.flat?.entry.id) as TestMaster
    const wrongValue = calibrate(light.l.image, { dark: d18.image, flat: flatHa.image, correctDefectivePixels: true })
    // Sky background (green pixels outside stars) and glow corner, in ADU.
    const zone = (im: ImageData32, x0: number, y0: number, side: number): number => {
      const v: number[] = []
      for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) if (!mask[y * w + x] && colorAt(schema, x, y) === 1) v.push(raw(im, schema, y * w + x))
      return median(v) * ADU
    }
    const side = Math.floor(Math.min(w, h) * 0.08)
    const background = (im: ImageData32): number => zone(im, Math.floor(w * 0.55), Math.floor(h * 0.3), side)
    const angle = (im: ImageData32): number => zone(im, w - side - 4, 4, side)
    note(
      'the light at 26 °C with the dark at 18 °C (as with a single master): background ' + f1(background(wrongValue)) + ' ADU instead of ' + f1(background(correct.image)) +
        ', glow corner ' + f1(angle(wrongValue)) + ' instead of ' + f1(angle(correct.image))
    )
    check(background(wrongValue) - background(correct.image) > 1 && angle(wrongValue) - angle(correct.image) > 1, 'with the dark at the wrong temperature thermal signal would remain: the right group removes it')
  }

  // Library fallback, for the 45 s lights.
  {
    const dark45 = Array.from({ length: 3 }, (_, k) =>
      simulatedFrame(s, { name: 'Dark_45s_' + k + '.fit', type: 'dark', exposure: 45, temperature: 18.2, start: night1 - 5 * 86400000 + k * 60000, seed: 900 + k })
    )
    const l45 = dark45.map((f) => read(s, f))
    const m45 = compose(l45)
    const v45 = entryOf('dark', m45, l45, '2026-10-07T10:00:00Z')
    // The library also holds a 60 s dark at 18 °C: the session has its own, which takes precedence.
    const other = { ...entryOf('dark', m45, l45, '2026-10-07T10:00:00Z'), id: 'lib-60', exposure: 60, temperature: 18 }
    const library: TestMaster[] = [{ entry: v45, image: m45 }, { entry: other, image: m45 }]
    const light = (prefix: string): ReadResult => (lights.find((x) => x.f.name.startsWith(prefix)) as { l: ReadResult }).l
    const r45 = calibrateLight(light('Light_45s'), composed, library)
    const r60 = calibrateLight(light('Light_60s_LP'), composed, library)
    check(
      r45.choice.dark?.origin === 'library' && r45.choice.dark.entry.id === v45.id && r45.choice.bias === null,
      '45 s lights: without a suitable dark in the session the library one is used (and the bias is no longer needed)'
    )
    check(r60.choice.dark?.origin === 'session', '60 s lights: the session dark takes precedence over the library one')
    const without18 = composed.session.filter((m) => !(m.entry.type === 'dark' && m.entry.exposure === 60 && (m.entry.temperature as number) < 20))
    const r = calibrateLight(light('Light_60s_LP'), { ...composed, session: without18 }, [])
    check(r.choice.dark === null, 'without the dark at 18 °C the light at 18 °C stays without a dark: the one at 26 °C is not used')
  }
  console.log('     (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s)')
}

/**
 * A session with a single group per type: the result must be bit-for-bit
 * identical to the single-master approach (one master per type from all
 * frames, used for every light).
 */
function testOneGroup(): void {
  const t0 = performance.now()
  console.log('\n===== A single group per type: identical to the single-master result =====')
  const p: SensorParams = { ...COLOR_SENSOR, width: 512, height: 384 }
  const s = createSensor(p)
  const scene = createScene(p.width, p.height)
  const plane = sessionPlan(s, scene, {
    lights: 4,
    dark: 7,
    flat: 6,
    bias: 8,
    darkOtherTemperature: 0,
    lightExposure: 60,
    temperature: 18,
    temperatureDeviation: 8,
    flatExposure: 1.5,
    filter: 'LP',
    start: Date.parse('2026-10-12T20:00:00Z'),
    dithering: 6,
    seed: 21
  })
  const readCount = plane.map((f) => ({ f, l: read(s, f) }))
  const ofKind = (t: string): ReadResult[] => readCount.filter((x) => x.f.type === t).map((x) => x.l)

  // Reference: one master per type with all frames, the flat corrected with the bias, the same masters for every light.
  const bias = compose(ofKind('bias'))
  const dark = compose(ofKind('dark'))
  const flat = correctFlat(compose(ofKind('flat')), bias)
  const before = ofKind('light').map((l) =>
    calibrate({ ...l.image, data: new Float32Array(l.image.data) }, { dark, flat, bias, correctDefectivePixels: true, inPlace: true })
  )

  // Grouping: groups, with a choice for each light.
  const composed = composeSession(readCount.filter((x) => x.f.type !== 'light'), [])
  check(composed.groups.length === 3 && composed.rejected.length === 0, 'one group per type, no frame excluded')
  const after = ofKind('light').map((l) => calibrateLight(l, composed, []).image)
  let different = 0
  for (let k = 0; k < before.length; k++) {
    const a = new Uint32Array(before[k].data.buffer)
    const b = new Uint32Array(after[k].data.buffer)
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different++
  }
  note('differing values between reference and grouping: ' + different + ' of ' + a3(before.length * before[0].data.length))
  check(different === 0, 'with a single group per type the calibrated lights are bit-for-bit identical to the reference')
  console.log('     (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s)')
}

/** The grouping rules on metadata alone, without pixels. */
function testGroupRules(): void {
  console.log('\n===== Grouping rules =====')
  const base: FrameMetadata = {
    object: null, ra: null, dec: null, exposure: 60, gain: 100, sensorTemp: 18, dateObs: '2026-10-12T22:00:00', instrument: 'Camera',
    telescope: null, filter: null, focalLength: null, pixelSize: null, bayer: 'RGGB', pixelScale: null, frameType: 'dark', stackCount: null,
    totalExposure: null, instrumentInfo: null, wcs: null
  }
  const f = (name: string, extra: Partial<FrameMetadata> = {}, type: CalibrationFrame['type'] = 'dark', width = 100): CalibrationFrame => ({
    id: name, name, path: 'x/' + name, type, width, height: 80, channels: 3, meta: { ...base, ...extra, frameType: type }
  })
  const onlyOne = groupCalibration([f('Dark_single.fit')])
  check(onlyOne.groups.length === 1 && onlyOne.rejected.length === 0, 'a lone dark is used as it is (it may be a ready-made master)')
  const withMaster = groupCalibration([f('a.fit'), f('b.fit'), f('MasterDark_60s_25C.fit', { sensorTemp: 25 })])
  check(withMaster.groups.length === 2 && withMaster.rejected.length === 0, 'a ready-made master among other darks is not excluded')
  const withStack = groupCalibration([f('a.fit'), f('b.fit'), f('c.fit', { sensorTemp: 25, stackCount: 20 })])
  check(withStack.groups.length === 2 && withStack.rejected.length === 0, 'neither is a file that declares itself the combination of several frames')
  const binning = groupCalibration([f('a.fit'), f('b.fit'), f('c.fit', {}, 'dark', 50), f('d.fit', {}, 'dark', 50)])
  check(binning.groups.length === 2, 'different dimensions (binning) make different groups')
  const drift = groupCalibration(['15', '16', '17', '18', '19', '20', '21'].map((t) => f('d' + t + '.fit', { sensorTemp: Number(t) })))
  const widths = drift.groups.map(
    (g) => Math.max(...g.frame.map((x) => x.meta.sensorTemp as number)) - Math.min(...g.frame.map((x) => x.meta.sensorTemp as number))
  )
  check(drift.groups.length === 2 && widths.every((l) => l <= 3), 'darks warming from 15 to 21 °C: groups at most 3 °C wide')
  const nights = groupCalibration([
    f('f1.fit', { filter: 'LP' }, 'flat'),
    f('f2.fit', { filter: 'LP' }, 'flat'),
    f('f3.fit', { filter: 'LP', dateObs: '2026-10-14T22:00:00' }, 'flat'),
    f('f4.fit', { filter: 'LP', dateObs: '2026-10-14T22:00:00' }, 'flat')
  ])
  check(nights.groups.length === 2 && nights.groups.every((g) => g.night !== null), 'flats of the same filter on two nights: two groups')
  const gains = groupCalibration([f('b1.fit', {}, 'bias'), f('b2.fit', {}, 'bias'), f('b3.fit', { gain: 0 }, 'bias'), f('b4.fit', { gain: 0 }, 'bias')])
  check(gains.groups.length === 2, 'biases of two gains: two groups')
}

// ONLY_GROUPS=1 skips the two long sensor tests.
if (!process.env.ONLY_GROUPS) {
  testSensor({ name: 'Color sensor', p: { ...COLOR_SENSOR, width: 1024, height: 768 }, lights: 8, temperature: 18, flatExposure: 1.5, filter: 'LP' })
  testSensor({ name: 'Monochrome sensor', p: { ...MONO_SENSOR, width: 768, height: 576 }, lights: 8, temperature: -10, flatExposure: 2, filter: 'L' })
}
testGroups()
testOneGroup()
testGroupRules()

console.log(errors === 0 ? '\nAll checks passed.' : '\n' + errors + ' checks failed.')
process.exit(errors === 0 ? 0 : 1)
