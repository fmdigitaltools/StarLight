/**
 * Physical simulator of an astrophotography sensor.
 *
 * Used to test calibration (darks, flats, bias and the master library)
 * without real frames: it produces 16-bit lights, darks, flats and biases
 * with the same defects as a real sensor, each known exactly, so that a
 * test can measure how much of each remains after calibration. The final
 * proof remains the one with real frames.
 *
 * The model, pixel by pixel, in electrons and then in ADU:
 *
 *   electrons = Poisson( light · optics · PRNU · QE(color) · exposure
 *                        + (dark current + glow) · exposure · 2^((T − Tref) / doubling) )
 *               + cosmic rays
 *   ADU       = bias(pixel) + row(y) + column(x) + random frame row
 *               + electrons / (e⁻/ADU) + read noise
 *
 * where:
 *   - bias: starting level (offset) with a small fixed per-pixel pattern,
 *     plus a fixed row and column pattern;
 *   - dark current: log-normal distribution among normal pixels, plus a
 *     tail of hot pixels (some very hot, some saturated even in short
 *     exposures); it doubles every `doublingDegrees` °C;
 *   - amplifier glow: thermal signal that decays from a corner of the
 *     sensor;
 *   - PRNU: pixel-to-pixel response difference (about 1 %);
 *   - optics: vignette toward the edges and donut-shaped dust shadows,
 *     present in the same way in lights and flats;
 *   - QE: for a color sensor, the response of each pixel's filter in the
 *     Bayer pattern.
 *
 * Lights contain a sky with a gradient, stars (Moffat profile), a nebula
 * and small shifts between shots (dithering).
 *
 * It is a reusable module: used by tools/test-simulated-calibration.ts
 * (everything in memory) and tools/generate-simulated-calibration.ts (which
 * writes the FITS files to drag into the app).
 */
import type { BayerPattern } from '../src/shared/types'
import { colorAt } from '../src/core/image/debayer'

/* ---- Reproducible random numbers ---- */

/** Seeded pseudorandom generator (mulberry32): the same files on every run. */
export function generator(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Number with a standard normal distribution (Box-Muller). */
export function gauss(rnd: () => number): number {
  const u = Math.max(1e-12, rnd())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
}

/**
 * Poisson count: exact for small means (where the shape matters, for
 * example in the dark current), normal for large means.
 */
export function poisson(rnd: () => number, mean: number): number {
  if (mean <= 0) return 0
  if (mean < 30) {
    const limit = Math.exp(-mean)
    let k = 0
    let p = rnd()
    while (p > limit) {
      k++
      p *= rnd()
    }
    return k
  }
  return Math.max(0, mean + Math.sqrt(mean) * gauss(rnd))
}

/* ---- Parameters ---- */

export interface SensorParams {
  width: number
  height: number
  /** 'RGGB' for a color sensor, 'NONE' for a monochrome one. */
  bayer: BayerPattern
  /** Instrument name written to INSTRUME. */
  instrument: string
  /** Configured gain (GAIN) and offset (OFFSET), as the capture software writes them. */
  setGain: number
  configuredOffset: number
  /** Electrons per ADU (EGAIN). */
  electronsPerAdu: number
  /** Read noise in electrons. */
  readNoise: number
  /** Bias level in ADU. */
  biasLevel: number
  /** Fixed bias pattern: spread per pixel, per row, per column (ADU). */
  biasPixel: number
  biasRows: number
  biasColumns: number
  /** Row noise that changes with every shot (ADU): calibration does not remove it. */
  randomRows: number
  /** Typical dark current (e⁻/s) at the reference temperature. */
  darkCurrent: number
  referenceTemperature: number
  /** Degrees over which the dark current doubles. */
  doublingDegrees: number
  /** Log-normal spread of the dark current among normal pixels. */
  darkSpread: number
  /** Fractions of hot, very hot and saturated pixels. */
  hotFraction: number
  veryHotFraction: number
  saturatedFraction: number
  /** Amplifier glow in the top-right corner (e⁻/s) and its falloff distance (fraction of the short side). */
  glow: number
  glowFalloffs: number
  /** Response non-uniformity (PRNU), relative spread. */
  prnu: number
  /** Light falloff in the corners due to vignetting (0.3 = 30 %). */
  vignette: number
  /** Dust shadows: how many and how dark (fraction of light removed on the ring). */
  dusts: number
  dustDepth: [number, number]
  /** Quantum efficiency per channel (R, G, B); for a monochrome sensor the first is used. */
  qe: [number, number, number]
  /** Cosmic rays per megapixel per minute of exposure. */
  cosmicRays: number
  seed: number
}

/** An uncooled color sensor, typical of smart telescopes and color cameras. */
export const COLOR_SENSOR: SensorParams = {
  width: 1920,
  height: 1080,
  bayer: 'RGGB',
  instrument: 'Simulated sensor SL-C1',
  setGain: 100,
  configuredOffset: 40,
  electronsPerAdu: 0.5,
  readNoise: 1.6,
  biasLevel: 800,
  biasPixel: 1.2,
  biasRows: 2.5,
  biasColumns: 1.5,
  randomRows: 0.5,
  darkCurrent: 0.15,
  referenceTemperature: 18,
  doublingDegrees: 6,
  darkSpread: 0.35,
  hotFraction: 0.0015,
  veryHotFraction: 0.0002,
  saturatedFraction: 0.00003,
  glow: 2.5,
  glowFalloffs: 0.12,
  prnu: 0.01,
  vignette: 0.3,
  dusts: 5,
  dustDepth: [0.03, 0.08],
  qe: [0.55, 0.8, 0.6],
  cosmicRays: 8,
  seed: 20261018
}

/** A cooled monochrome sensor with a filter wheel. */
export const MONO_SENSOR: SensorParams = {
  ...COLOR_SENSOR,
  bayer: 'NONE',
  instrument: 'Simulated sensor SL-M1',
  setGain: 120,
  configuredOffset: 30,
  electronsPerAdu: 0.4,
  biasLevel: 600,
  darkCurrent: 0.004,
  referenceTemperature: -10,
  glow: 0.08,
  qe: [0.8, 0.8, 0.8],
  seed: 20261019
}

/* ---- The sensor: the fixed maps ---- */

export interface Dust {
  x: number
  y: number
  /** Outer radius of the ring in pixels. */
  radius: number
  depth: number
}

export interface Sensor {
  p: SensorParams
  /** Per-pixel bias in ADU, including rows and columns. */
  bias: Float32Array
  /** The bias row pattern only (ADU), to measure its residual. */
  rows: Float32Array
  /** Per-pixel dark current at the reference temperature (e⁻/s), including the glow. */
  dark: Float32Array
  /** The glow only (e⁻/s at the reference temperature). */
  glow: Float32Array
  /** Per-pixel response: PRNU × vignette × dust × QE of the pixel's color. */
  response: Float32Array
  /** The optical part only (vignette × dust), the same for all colors. */
  optics: Float32Array
  /** The vignette only. */
  vignette: Float32Array
  dusts: Dust[]
  /** Hot pixels: index and dark current (e⁻/s at the reference temperature). */
  hotPixels: { index: number; dark: number }[]
}

/** Color recorded by the pixel: 0 R, 1 G, 2 B (always 0 for a monochrome sensor). */
export function pixelColor(p: SensorParams, x: number, y: number): number {
  return p.bayer === 'NONE' ? 0 : colorAt(p.bayer, x, y)
}

function smoothed(t: number): number {
  const v = t < 0 ? 0 : t > 1 ? 1 : t
  return v * v * (3 - 2 * v)
}

/**
 * Transmission of a dust shadow: dust on the glass in front of the sensor,
 * blurred, casts a dark ring with a lighter center (the central obstruction
 * of the optics punches a hole in its disk).
 */
function dustShadow(d: Dust, distance: number): number {
  const r = d.radius
  const inner = r * 0.42
  const edge = Math.max(1.5, r * 0.08)
  const outside = smoothed((r - distance) / edge) // 1 inside the disk
  const center = smoothed((inner - distance) / edge) // 1 in the hole
  const shadow = outside * (1 - 0.75 * center)
  return 1 - d.depth * shadow
}

export function createSensor(p: SensorParams): Sensor {
  const { width: w, height: h } = p
  const n = w * h
  const rnd = generator(p.seed)

  const rows = new Float32Array(h)
  for (let y = 0; y < h; y++) rows[y] = gauss(rnd) * p.biasRows
  const columns = new Float32Array(w)
  for (let x = 0; x < w; x++) columns[x] = gauss(rnd) * p.biasColumns

  const bias = new Float32Array(n)
  const dark = new Float32Array(n)
  const glow = new Float32Array(n)
  const response = new Float32Array(n)
  const optics = new Float32Array(n)
  const vignette = new Float32Array(n)
  const hotPixels: { index: number; dark: number }[] = []

  // Dust spots stay away from the edges and come in different sizes.
  const side = Math.min(w, h)
  const dusts: Dust[] = []
  for (let k = 0; k < p.dusts; k++) {
    dusts.push({
      x: w * (0.12 + 0.76 * rnd()),
      y: h * (0.12 + 0.76 * rnd()),
      radius: side * (0.012 + 0.025 * rnd()),
      depth: p.dustDepth[0] + (p.dustDepth[1] - p.dustDepth[0]) * rnd()
    })
  }

  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const halfDiagonal2 = cx * cx + cy * cy
  // Coefficients of r² and r⁴ that give the desired falloff in the corners.
  const a2 = p.vignette * 0.7
  const a4 = p.vignette * 0.3
  const falloff = p.glowFalloffs * side

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      bias[i] = p.biasLevel + rows[y] + columns[x] + gauss(rnd) * p.biasPixel

      // Dark current: log-normal, plus the tail of hot pixels.
      let d = p.darkCurrent * Math.exp(gauss(rnd) * p.darkSpread - (p.darkSpread * p.darkSpread) / 2)
      const u = rnd()
      if (u < p.saturatedFraction) d = 5000 + 5000 * rnd()
      else if (u < p.saturatedFraction + p.veryHotFraction) d = p.darkCurrent * Math.exp(Math.log(300) + rnd() * Math.log(20))
      else if (u < p.saturatedFraction + p.veryHotFraction + p.hotFraction) d = p.darkCurrent * Math.exp(Math.log(15) + rnd() * Math.log(20))
      if (d > p.darkCurrent * 10) hotPixels.push({ index: i, dark: d })

      // Amplifier glow in the top-right corner.
      const dx = w - 1 - x
      const dy = y
      const g = p.glow * Math.exp(-Math.sqrt(dx * dx + dy * dy) / falloff)
      glow[i] = g
      dark[i] = d + g

      const r2 = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) / halfDiagonal2
      const v = 1 - a2 * r2 - a4 * r2 * r2
      let o = v
      for (const pol of dusts) {
        const ddx = x - pol.x
        const ddy = y - pol.y
        if (Math.abs(ddx) > pol.radius + 3 || Math.abs(ddy) > pol.radius + 3) continue
        o *= dustShadow(pol, Math.sqrt(ddx * ddx + ddy * ddy))
      }
      vignette[i] = v
      optics[i] = o
      response[i] = o * (1 + gauss(rnd) * p.prnu) * p.qe[pixelColor(p, x, y)]
    }
  }

  return { p, bias, rows, dark, glow, response, optics, vignette, dusts, hotPixels }
}

/** Dark-current factor at a temperature, relative to the reference temperature. */
export function thermalFactor(p: SensorParams, temperature: number): number {
  return Math.pow(2, (temperature - p.referenceTemperature) / p.doublingDegrees)
}

/* ---- The sky scene ---- */

export interface Star {
  x: number
  y: number
  /** Total flux in e⁻/s with QE 1. */
  flux: number
  fwhm: number
  /** Relative color (R, G, B). */
  color: [number, number, number]
}

export interface Cloud {
  x: number
  y: number
  sigma: number
  /** e⁻/s per pixel with QE 1, per channel. */
  amplitude: [number, number, number]
}

export interface Scene {
  width: number
  height: number
  /** Sky background in e⁻/s per pixel with QE 1, per channel. */
  background: [number, number, number]
  /** Gradient: relative variation of the background from one edge to the other, in x and y. */
  gradient: [number, number]
  stars: Star[]
  nebula: Cloud[]
}

export interface SceneOptions {
  stars?: boolean
  nebula?: boolean
  background?: [number, number, number]
  gradient?: [number, number]
  seed?: number
}

/** A sky scene with stars, a gradient and an emission nebula. */
export function createScene(w: number, h: number, options: SceneOptions = {}): Scene {
  const rnd = generator(options.seed ?? 4242)
  const stars: Star[] = []
  if (options.stars ?? true) {
    const count = Math.round((w * h) / 4000)
    for (let k = 0; k < count; k++) {
      // Many faint, few bright; the brightest saturate at the center.
      const u = rnd()
      const t = rnd()
      stars.push({
        x: rnd() * w,
        y: rnd() * h,
        flux: 25 + 7000 * Math.pow(u, 5),
        fwhm: 2.8 + 0.6 * rnd(),
        color: [0.75 + 0.55 * t, 1, 1.25 - 0.5 * t]
      })
    }
  }
  const nebula: Cloud[] = []
  if (options.nebula ?? true) {
    // Hydrogen (red) with an oxygen core (cyan), slightly left of center.
    const side = Math.min(w, h)
    for (let k = 0; k < 9; k++) {
      const oxygen = k < 2
      nebula.push({
        x: w * (0.38 + 0.18 * (rnd() - 0.5)),
        y: h * (0.5 + 0.3 * (rnd() - 0.5)),
        sigma: side * (oxygen ? 0.04 : 0.05 + 0.08 * rnd()),
        amplitude: oxygen ? [0.2, 1.4, 1.6] : [1.8 + 1.6 * rnd(), 0.35, 0.3]
      })
    }
  }
  return {
    width: w,
    height: h,
    background: options.background ?? [4, 5, 3.5],
    gradient: options.gradient ?? [0.25, -0.12],
    stars,
    nebula
  }
}

/**
 * Expected light on the sensor, in e⁻/s per pixel (before the optics and
 * the QE, which the sensor applies itself), with the sky shifted by (dx, dy):
 * sensor pixel (x, y) sees point (x + dx, y + dy) of the scene.
 */
export function expectedLight(s: Sensor, scene: Scene, dx: number, dy: number): Float32Array {
  const { width: w, height: h } = s.p
  const p = s.p
  const light = new Float32Array(w * h)
  const [gx, gy] = scene.gradient
  const mono = p.bayer === 'NONE'
  const backgroundMean = (scene.background[0] + scene.background[1] + scene.background[2]) / 3

  for (let y = 0; y < h; y++) {
    const Y = y + dy
    for (let x = 0; x < w; x++) {
      const X = x + dx
      const c = pixelColor(p, x, y)
      const g = 1 + gx * (X / scene.width - 0.5) + gy * (Y / scene.height - 0.5)
      let v = (mono ? backgroundMean : scene.background[c]) * g
      for (const nb of scene.nebula) {
        const ex = X - nb.x
        const ey = Y - nb.y
        const d2 = (ex * ex + ey * ey) / (2 * nb.sigma * nb.sigma)
        if (d2 > 12) continue
        const a = mono ? (nb.amplitude[0] + nb.amplitude[1] + nb.amplitude[2]) / 3 : nb.amplitude[c]
        v += a * Math.exp(-d2)
      }
      light[y * w + x] = v
    }
  }

  // Stars with a Moffat profile (β = 3), normalized over the drawn box.
  const beta = 3
  for (const st of scene.stars) {
    const sx = st.x - dx
    const sy = st.y - dy
    const alpha = st.fwhm / (2 * Math.sqrt(Math.pow(2, 1 / beta) - 1))
    const radius = Math.ceil(st.fwhm * 4)
    const x0 = Math.max(0, Math.floor(sx - radius))
    const x1 = Math.min(w - 1, Math.ceil(sx + radius))
    const y0 = Math.max(0, Math.floor(sy - radius))
    const y1 = Math.min(h - 1, Math.ceil(sy + radius))
    if (x0 > x1 || y0 > y1) continue
    // Normalization: integral of the profile over the plane.
    const norm = (beta - 1) / (Math.PI * alpha * alpha)
    const colorMean = (st.color[0] + st.color[1] + st.color[2]) / 3
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const r2 = ((x - sx) * (x - sx) + (y - sy) * (y - sy)) / (alpha * alpha)
        const c = pixelColor(p, x, y)
        const color = mono ? colorMean : st.color[c]
        light[y * w + x] += st.flux * color * norm * Math.pow(1 + r2, -beta)
      }
    }
  }
  return light
}

/* ---- The frames ---- */

export type FrameType = 'light' | 'dark' | 'flat' | 'bias'

export interface FrameOptions {
  type: FrameType
  exposure: number
  temperature: number
  /** Lights only: the expected light (see `expectedLight`). */
  light?: Float32Array
  /** Flats only: fraction of the dynamic range reached at the center in green (0.45). */
  flatLevel?: number
  /** Flats only: panel color (R, G, B). */
  panelColor?: [number, number, number]
  seed: number
}

/** A raw frame in ADU, as the camera writes it. */
export function simulateFrame(s: Sensor, o: FrameOptions): Uint16Array {
  const p = s.p
  const { width: w, height: h } = p
  const n = w * h
  const rnd = generator(o.seed)
  const adu = new Uint16Array(n)
  const thermal = thermalFactor(p, o.temperature) * o.exposure
  const k = 1 / p.electronsPerAdu
  const rnAdu = p.readNoise * k

  // Flat panel level: green at the center reaches `flatLevel` of the dynamic range.
  let panel: [number, number, number] = [0, 0, 0]
  if (o.type === 'flat') {
    const center = Math.floor(h / 2) * w + Math.floor(w / 2)
    const greenResponse = s.optics[center] * p.qe[p.bayer === 'NONE' ? 0 : 1]
    const electrons = ((o.flatLevel ?? 0.45) * 65535 - p.biasLevel) * p.electronsPerAdu
    const flux = electrons / (greenResponse * o.exposure)
    const col = o.panelColor ?? [1, 1, 1]
    panel = [flux * col[0], flux * col[1], flux * col[2]]
    if (p.bayer === 'NONE') panel = [flux, flux, flux]
  }

  for (let y = 0; y < h; y++) {
    const randomRow = gauss(rnd) * p.randomRows
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      let expected = s.dark[i] * thermal
      if (o.type === 'light' && o.light) expected += o.light[i] * s.response[i] * o.exposure
      else if (o.type === 'flat') expected += panel[pixelColor(p, x, y)] * s.response[i] * o.exposure
      const electrons = poisson(rnd, expected)
      const v = s.bias[i] + randomRow + electrons * k + gauss(rnd) * rnAdu
      adu[i] = v <= 0 ? 0 : v >= 65535 ? 65535 : Math.round(v)
    }
  }

  // Cosmic rays: short bright tracks, in proportion to the area and the exposure.
  if (o.type === 'light' || o.type === 'dark') {
    const count = Math.round(((p.cosmicRays * n) / 1e6) * (o.exposure / 60))
    for (let c = 0; c < count; c++) {
      let x = Math.floor(rnd() * w)
      let y = Math.floor(rnd() * h)
      const length = 1 + Math.floor(rnd() * 4)
      const ex = (1000 + 15000 * rnd()) * k
      const stepX = rnd() < 0.5 ? 1 : 0
      const stepY = 1 - stepX
      for (let t = 0; t < length && x < w && y < h; t++) {
        const i = y * w + x
        adu[i] = Math.min(65535, adu[i] + Math.round(ex))
        x += stepX
        y += stepY
      }
    }
  }
  return adu
}

/* ---- Header and FITS file ---- */

export interface HeaderData {
  type: FrameType
  exposure: number
  /** Sensor temperature as read (CCD-TEMP). */
  temperature: number
  /** Cooling set-point temperature, if any. */
  setTemperature?: number | null
  filter?: string | null
  /** Capture date, ISO. */
  data: string
  object?: string | null
  /**
   * Gain written to GAIN, if different from the sensor's. It changes only
   * the header, not the pixels: used to test master selection by gain.
   */
  gain?: number
}

const IMAGETYP: Record<FrameType, string> = {
  light: 'Light Frame',
  dark: 'Dark Frame',
  flat: 'Flat Field',
  bias: 'Bias Frame'
}

function card(key: string, value: string | number | boolean, comment?: string): string {
  let text: string
  if (typeof value === 'string') text = ("'" + value.replace(/'/g, "''") + "'").padEnd(20, ' ')
  else if (typeof value === 'boolean') text = (value ? 'T' : 'F').padStart(20, ' ')
  else text = String(value).toUpperCase().padStart(20, ' ')
  let row = key.padEnd(8, ' ') + '= ' + text
  if (comment) row += ' / ' + comment
  return row.slice(0, 80).padEnd(80, ' ')
}

/** ISO date in the FITS header format (no time zone, UTC). */
export function fitsData(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '')
}

/** The header cards as a capture program would write them. */
export function header(s: Sensor, d: HeaderData): string[] {
  const p = s.p
  const cards = [
    card('SIMPLE', true, 'file conforms to the FITS standard'),
    card('BITPIX', 16, '16-bit integers'),
    card('NAXIS', 2, 'number of axes'),
    card('NAXIS1', p.width, 'width in pixels'),
    card('NAXIS2', p.height, 'height in pixels'),
    card('BZERO', 32768, 'unsigned values'),
    card('BSCALE', 1, 'scale factor'),
    card('IMAGETYP', IMAGETYP[d.type], 'frame type'),
    card('EXPTIME', Number(d.exposure.toFixed(3)), '[s] exposure duration'),
    card('DATE-OBS', d.data, 'exposure start, UTC'),
    card('INSTRUME', p.instrument, 'camera'),
    card('TELESCOP', 'Simulated refractor 80/480', 'telescopio'),
    card('FOCALLEN', 480, '[mm] focal length'),
    card('XPIXSZ', 2.9, '[um] pixel size'),
    card('YPIXSZ', 2.9, '[um] pixel size'),
    card('XBINNING', 1, 'horizontal binning'),
    card('YBINNING', 1, 'vertical binning'),
    card('GAIN', d.gain ?? p.setGain, 'configured gain'),
    card('OFFSET', p.configuredOffset, 'configured offset'),
    card('EGAIN', p.electronsPerAdu, '[e-/ADU] electrons per ADU'),
    card('CCD-TEMP', Number(d.temperature.toFixed(1)), '[C] sensor temperature')
  ]
  if (d.setTemperature !== undefined && d.setTemperature !== null) {
    cards.push(card('SET-TEMP', d.setTemperature, '[C] set-point temperature'))
  }
  if (p.bayer !== 'NONE') {
    cards.push(card('BAYERPAT', p.bayer, 'Bayer pattern'))
    cards.push(card('XBAYROFF', 0, 'pattern offset in x'))
    cards.push(card('YBAYROFF', 0, 'pattern offset in y'))
  }
  cards.push(card('ROWORDER', 'TOP-DOWN', 'row order'))
  if (d.filter) cards.push(card('FILTER', d.filter, 'filtro'))
  if (d.object) cards.push(card('OBJECT', d.object, 'object name'))
  cards.push(card('SWCREATE', 'StarLight, sensor simulator', 'simulated data, not a real capture'))
  return cards
}

/** An unsigned 16-bit FITS file (BZERO 32768), like those written by cameras. */
export function fitsFile(s: Sensor, adu: Uint16Array, d: HeaderData): Uint8Array {
  const cards = header(s, d)
  cards.push('END'.padEnd(80, ' '))
  let text = cards.join('')
  text = text.padEnd(Math.ceil(text.length / 2880) * 2880, ' ')
  const dataBytes = Math.ceil((adu.length * 2) / 2880) * 2880
  const output = new Uint8Array(text.length + dataBytes)
  for (let i = 0; i < text.length; i++) output[i] = text.charCodeAt(i)
  const view = new DataView(output.buffer, text.length)
  for (let i = 0; i < adu.length; i++) view.setInt16(i * 2, adu[i] - 32768, false)
  return output
}

/* ---- A complete session ---- */

export interface SessionPlan {
  lights: number
  dark: number
  flat: number
  bias: number
  /** Darks with the same exposure but at a different temperature. */
  darkOtherTemperature: number
  lightExposure: number
  temperature: number
  /** Temperature difference of the "wrong" darks. */
  temperatureDeviation: number
  flatExposure: number
  filter: string
  /** Session start, ms since the epoch. */
  start: number
  /** Maximum dithering amplitude, in pixels. */
  dithering: number
  seed: number
}

export interface SimulatedFrame {
  name: string
  type: FrameType
  data: HeaderData
  /** Sky shift (lights only). */
  shift?: [number, number]
  /** The raw frame, produced on demand so that not everything is held in memory. */
  produce: () => Uint16Array
}

/**
 * The list of frames of a session, each produced only when needed
 * (`produce`): for 1920 × 1080 and tens of frames this saves memory.
 */
export function sessionPlan(s: Sensor, scene: Scene, plane: SessionPlan): SimulatedFrame[] {
  const frame: SimulatedFrame[] = []
  const rnd = generator(plane.seed)
  const minute = 60000
  const measuredTemp = (t: number): number => t + (rnd() - 0.5) * 0.4
  const cooled = s.p.referenceTemperature < 0
  const imp = (t: number): number | null => (cooled ? t : null)
  const exposure = (x: number): string => (x >= 1 ? String(Number(x.toFixed(1))) + 's' : String(Math.round(x * 1000)) + 'ms')
  const num = (k: number): string => String(k + 1).padStart(4, '0')

  // Flats at dusk, before the session.
  for (let k = 0; k < plane.flat; k++) {
    const data: HeaderData = {
      type: 'flat',
      exposure: plane.flatExposure,
      temperature: measuredTemp(plane.temperature),
      setTemperature: imp(plane.temperature),
      filter: plane.filter,
      data: fitsData(plane.start - 30 * minute + k * 5000)
    }
    const seed = plane.seed * 31 + 1000 + k
    frame.push({
      name: 'Flat_' + exposure(plane.flatExposure) + '_' + plane.filter + '_' + num(k) + '.fit',
      type: 'flat',
      data,
      produce: () =>
        simulateFrame(s, { type: 'flat', exposure: plane.flatExposure, temperature: data.temperature, flatLevel: 0.45, panelColor: [1.15, 1, 0.8], seed })
    })
  }

  // Lights, with dithering between shots.
  for (let k = 0; k < plane.lights; k++) {
    const dx = k === 0 ? 0 : (rnd() * 2 - 1) * plane.dithering
    const dy = k === 0 ? 0 : (rnd() * 2 - 1) * plane.dithering
    const data: HeaderData = {
      type: 'light',
      exposure: plane.lightExposure,
      temperature: measuredTemp(plane.temperature),
      setTemperature: imp(plane.temperature),
      filter: plane.filter,
      data: fitsData(plane.start + k * (plane.lightExposure * 1000 + 8000)),
      object: 'Simulated nebula'
    }
    const seed = plane.seed * 31 + 2000 + k
    frame.push({
      name: 'Light_' + exposure(plane.lightExposure) + '_' + plane.filter + '_' + num(k) + '.fit',
      type: 'light',
      data,
      shift: [dx, dy],
      produce: () =>
        simulateFrame(s, { type: 'light', exposure: plane.lightExposure, temperature: data.temperature, light: expectedLight(s, scene, dx, dy), seed })
    })
  }

  // Darks at the end of the night, at the same temperature.
  const end = plane.start + plane.lights * (plane.lightExposure * 1000 + 8000)
  for (let k = 0; k < plane.dark; k++) {
    const data: HeaderData = {
      type: 'dark',
      exposure: plane.lightExposure,
      temperature: measuredTemp(plane.temperature),
      setTemperature: imp(plane.temperature),
      data: fitsData(end + k * (plane.lightExposure * 1000 + 2000))
    }
    const seed = plane.seed * 31 + 3000 + k
    frame.push({
      name: 'Dark_' + exposure(plane.lightExposure) + '_' + num(k) + '.fit',
      type: 'dark',
      data,
      produce: () => simulateFrame(s, { type: 'dark', exposure: plane.lightExposure, temperature: data.temperature, seed })
    })
  }

  // Bias.
  for (let k = 0; k < plane.bias; k++) {
    const data: HeaderData = {
      type: 'bias',
      exposure: 0.001,
      temperature: measuredTemp(plane.temperature),
      setTemperature: imp(plane.temperature),
      data: fitsData(end + plane.dark * (plane.lightExposure * 1000 + 2000) + k * 1000)
    }
    const seed = plane.seed * 31 + 4000 + k
    frame.push({
      name: 'Bias_' + num(k) + '.fit',
      type: 'bias',
      data,
      produce: () => simulateFrame(s, { type: 'bias', exposure: 0.001, temperature: data.temperature, seed })
    })
  }

  // Darks with the same exposure but at another temperature (another, warmer evening).
  const otherTemperature = plane.temperature + plane.temperatureDeviation
  for (let k = 0; k < plane.darkOtherTemperature; k++) {
    const data: HeaderData = {
      type: 'dark',
      exposure: plane.lightExposure,
      temperature: measuredTemp(otherTemperature),
      setTemperature: imp(otherTemperature),
      data: fitsData(plane.start + 3 * 86400000 + k * (plane.lightExposure * 1000 + 2000))
    }
    const seed = plane.seed * 31 + 5000 + k
    frame.push({
      name: 'Dark_' + exposure(plane.lightExposure) + '_' + Math.round(otherTemperature) + 'C_' + num(k) + '.fit',
      type: 'dark',
      data,
      produce: () => simulateFrame(s, { type: 'dark', exposure: plane.lightExposure, temperature: data.temperature, seed })
    })
  }
  return frame
}

/* ---- A frame with arbitrary conditions ---- */

export interface FrameRequest {
  name: string
  type: FrameType
  exposure: number
  /** Sensor temperature (the sessions add a small reading offset of about ±0.2 °C). */
  temperature: number
  filter?: string | null
  /** Gain in the header (see `HeaderData.gain`). */
  gain?: number
  /** Exposure start, ms since the epoch. */
  start: number
  seed: number
  /** Lights only: the scene and the sky shift (dithering). */
  scene?: Scene
  shift?: [number, number]
}

/**
 * A single frame with arbitrary exposure, temperature, filter and date, for
 * sessions that `sessionPlan` does not cover (several exposures, several
 * temperatures, several filters and several nights together).
 */
export function simulatedFrame(s: Sensor, r: FrameRequest): SimulatedFrame {
  const cooled = s.p.referenceTemperature < 0
  const data: HeaderData = {
    type: r.type,
    exposure: r.exposure,
    temperature: r.temperature,
    setTemperature: cooled ? Math.round(r.temperature) : null,
    filter: r.type === 'light' || r.type === 'flat' ? (r.filter ?? null) : null,
    data: fitsData(r.start),
    object: r.type === 'light' ? 'Simulated nebula' : null,
    gain: r.gain
  }
  const [dx, dy] = r.shift ?? [0, 0]
  return {
    name: r.name,
    type: r.type,
    data,
    shift: r.type === 'light' ? [dx, dy] : undefined,
    produce: () =>
      simulateFrame(s, {
        type: r.type,
        exposure: r.exposure,
        temperature: r.temperature,
        light: r.type === 'light' && r.scene ? expectedLight(s, r.scene, dx, dy) : undefined,
        flatLevel: 0.45,
        panelColor: [1.15, 1, 0.8],
        seed: r.seed
      })
  }
}

/**
 * A session with several condition groups together, to test the automatic
 * grouping of the Calibrate panel: color sensor, two nights (12 and 14
 * October 2026).
 *   - darks of 60 s at 18 °C (plus one of 60.3 s, which must join them),
 *     60 s at 26 °C, 30 s at 18 °C, 1.5 s (flat darks for LP) and a
 *     single one of 60 s at 22 °C, to be excluded;
 *   - bias at gain 100 and at gain 200 (in the header only);
 *   - LP flats of 1.5 s the first night, Ha flats of 4 s the second;
 *   - LP lights of 60 s and 30 s at 18 °C, Ha of 60 s at 26 °C, and LP of
 *     45 s at 18 °C, for which no dark is suitable.
 */
export function sessionToGroups(s: Sensor, scene: Scene, o: { lights: number; lightsWithoutDark: number }): SimulatedFrame[] {
  const night1 = Date.parse('2026-10-12T20:00:00Z')
  const night2 = Date.parse('2026-10-14T20:00:00Z')
  const plane: SimulatedFrame[] = []
  let seed = 100
  const series = (n: number, prefix: string, r: Omit<FrameRequest, 'name' | 'seed'>): void => {
    for (let k = 0; k < n; k++) {
      plane.push(
        simulatedFrame(s, {
          ...r,
          name: prefix + '_' + String(k + 1).padStart(4, '0') + '.fit',
          // Sensor reading with a small offset, like real ones.
          temperature: r.temperature + (((k * 7) % 5) - 2) * 0.1,
          start: r.start + k * (r.exposure * 1000 + 5000),
          seed: seed++,
          shift: r.type === 'light' && k > 0 ? [((k * 37) % 9) - 4, ((k * 53) % 7) - 3] : [0, 0]
        })
      )
    }
  }
  const evening = 3 * 3600000
  series(5, 'Dark_60s_18C', { type: 'dark', exposure: 60, temperature: 18, start: night1 + evening })
  series(1, 'Dark_60.3s_18C', { type: 'dark', exposure: 60.3, temperature: 18, start: night1 + evening + 600000 })
  series(5, 'Dark_60s_26C', { type: 'dark', exposure: 60, temperature: 26, start: night2 + evening })
  series(5, 'Dark_30s_18C', { type: 'dark', exposure: 30, temperature: 18, start: night1 + evening + 900000 })
  series(3, 'Dark_1.5s_18C', { type: 'dark', exposure: 1.5, temperature: 18, start: night1 - 1200000 })
  series(1, 'Dark_60s_22C', { type: 'dark', exposure: 60, temperature: 22.2, start: night1 + evening + 1800000 })
  series(5, 'Bias_g100', { type: 'bias', exposure: 0.001, temperature: 18, start: night1 + evening + 2400000 })
  series(3, 'Bias_g200', { type: 'bias', exposure: 0.001, temperature: 18, start: night1 + evening + 2500000, gain: 200 })
  series(5, 'Flat_1.5s_LP', { type: 'flat', exposure: 1.5, temperature: 18, filter: 'LP', start: night1 - 1800000 })
  series(5, 'Flat_4s_Ha', { type: 'flat', exposure: 4, temperature: 26, filter: 'Ha', start: night2 - 1800000 })
  series(o.lights, 'Light_60s_LP_18C', { type: 'light', exposure: 60, temperature: 18, filter: 'LP', start: night1, scene })
  series(o.lights, 'Light_30s_LP_18C', { type: 'light', exposure: 30, temperature: 18, filter: 'LP', start: night1 + 600000, scene })
  series(o.lights, 'Light_60s_Ha_26C', { type: 'light', exposure: 60, temperature: 26, filter: 'Ha', start: night2, scene })
  series(o.lightsWithoutDark, 'Light_45s_LP_18C', { type: 'light', exposure: 45, temperature: 18, filter: 'LP', start: night1 + 1200000, scene })
  return plane
}
