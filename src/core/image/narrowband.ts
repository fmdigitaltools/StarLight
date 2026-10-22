import type { FrameMetadata, ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { MAD_TO_SIGMA } from './stats'
import { mtf } from './stretch'
import { blur } from './cleanup'
import { kth, medianAndMad } from './selection'
import { filterFromHeader } from './photometry'
import { analyzeStars, releaseStarAnalysis, type StarAnalysis } from './starReduction'

/**
 * Narrowband from a color sensor with a dual-band filter.
 *
 * The dual-band light-pollution filter (for example FILTER = 'LP') lets
 * through only two narrow windows: the hydrogen one (H-alpha, 656 nm) and
 * the oxygen one (OIII, 501 nm). Behind them the pixels of the Bayer
 * matrix split as follows:
 * - red sees almost only H-alpha (its sensitivity at 501 nm is a few
 *   percent);
 * - green and blue see mostly OIII, but also pick up a sizable share of
 *   H-alpha: at 656 nm the green of Sony sensors still has 18-25% of the
 *   red response, the blue 6-12%.
 * With the sensor response curves these leaks are removed (see `SENSORS`
 * and `extractBands`).
 *
 * From this the two bands are derived (see `extractBands`) and recombined
 * into the palettes used in narrowband. Everything happens on linear
 * data: the stretch comes later, in the Correct step.
 *
 * The palettes change the colors deliberately and not faithfully: for this
 * reason the step is off by default and the automatic finish does not
 * turn it on by itself.
 */

/**
 * - 'natural': no change;
 * - 'hoo': H-alpha in red, OIII in green and blue;
 * - 'foraxx': like HOO, but green takes H-alpha where the two bands are
 *   both strong (the Foraxx dynamic blend): golden transitions between
 *   the red of hydrogen and the cyan of oxygen;
 * - 'sho': imitation of the "Hubble palette" (sulfur, hydrogen, oxygen).
 *   Without a sulfur (SII) filter that band does not exist: here it is
 *   replaced by H-alpha, so it is a SYNTHETIC palette, which gives the
 *   gold and blue look but does not show sulfur.
 */
export type NarrowbandPalette = 'natural' | 'hoo' | 'foraxx' | 'sho'

/** All the palettes, in the order in which the panel shows them. */
export const NARROWBAND_PALETTES: readonly NarrowbandPalette[] = ['natural', 'hoo', 'foraxx', 'sho']

export interface NarrowbandParams {
  palette: NarrowbandPalette
  /**
   * Balance between the two bands, from -1 (more H-alpha) to 1 (more
   * OIII); 0 keeps the balance measured on the image.
   */
  balance: number
  /** Multiplier of OIII alone, from 0 to 2; 1 changes nothing. */
  oiiiIntensity: number
  /** If true, the stars keep the color of the starting image. */
  naturalStars: boolean
  /**
   * Sensor with which the image was taken, to separate the two lines with
   * its response (see `sensorFromMetadata`). Missing or unknown: the mean
   * response of the Sony STARVIS sensors.
   */
  sensor?: NarrowbandSensor
}

export const NARROWBAND_NEUTRAL: NarrowbandParams = {
  palette: 'natural',
  balance: 0,
  oiiiIntensity: 1,
  naturalStars: true
}

/** The two extracted bands, with the background at zero, and the measurements taken. */
export interface ExtractedBands {
  width: number
  height: number
  /** H-alpha above the sky background (may be slightly negative in the noise). */
  ha: Float32Array
  /** OIII above the background, already brought to the H-alpha scale. */
  oiii: Float32Array
  /** Neutral sky level to which the recomposed image is brought back. */
  background: number
  noiseHa: number
  noiseOiii: number
  /** Gain applied to OIII to even it out with H-alpha. */
  oiiiGain: number
  /** Sensor whose response was used. */
  sensor: NarrowbandSensor
  /**
   * Blend used: for each channel (red, green, blue), how much of one unit
   * of H-alpha and one unit of OIII ends up in it. H-alpha is in units of
   * the red, OIII in units of the green.
   */
  sensorMix: [[number, number], [number, number], [number, number]]
}

// ---------------------------------------------------------------------------
// Sensor response
// ---------------------------------------------------------------------------

/**
 * Sensors whose response is known: 'starvis' is the mean of the two Sony
 * sensors measured, used for instruments that are not recognized.
 */
export type NarrowbandSensor = 'imx462' | 'imx662' | 'imx585' | 'starvis'

/** Relative response (peak = 1) of the three channels, in the order R, G, B. */
type Rgb = readonly [number, number, number]

interface SensorResponse {
  name: string
  /** At the three lines: H-alpha 656.3 nm, OIII 500.7 nm and 495.9 nm. */
  ha: Rgb
  o5007: Rgb
  o4959: Rgb
}

/**
 * Relative per-channel efficiency curves published by Sony and reproduced
 * by astronomy-camera vendors, read (digitized) from the charts pixel by
 * pixel:
 * - IMX462: Sony chart "IMX462LQR-C spectral sensitivity characteristics";
 * - IMX662: the "IMX662 QE Curve" chart, which the vendor states comes
 *   from Sony;
 * - IMX585: the vendor chart for the IMX585 is identical to the IMX662 one
 *   (same generation of color filters, or a reused image): the same values
 *   are used.
 * Reading uncertainty: about ±0.01-0.02 on the value of each channel; the
 * curves are the typical ones of the model, a single unit may deviate by
 * a few percent. A typical dual-band filter has windows about 20 nm
 * (H-alpha) and 30 nm (OIII) wide, so it lets the lines through without
 * attenuating them differently from channel to channel: only the sensor
 * response at the three wavelengths matters.
 *
 * Test on raw data with an IMX462 sensor (NGC 7000, where oxygen is almost
 * absent): with these values the OIII separated in the brightest hydrogen
 * areas no longer follows its details (correlation from 0.51 to 0.13);
 * with half the leak it stays at 0.34, with one and a half times it turns
 * negative (-0.12). The curves are therefore right to within 20-30%.
 */
const SENSORS: Record<Exclude<NarrowbandSensor, 'starvis'>, SensorResponse> = {
  imx462: {
    name: 'IMX462',
    ha: [0.81, 0.25, 0.125],
    o5007: [0.043, 0.768, 0.416],
    o4959: [0.038, 0.732, 0.461]
  },
  imx662: {
    name: 'IMX662',
    ha: [0.989, 0.176, 0.064],
    o5007: [0.027, 0.79, 0.395],
    o4959: [0.024, 0.748, 0.448]
  },
  imx585: {
    name: 'IMX585',
    ha: [0.989, 0.176, 0.064],
    o5007: [0.027, 0.79, 0.395],
    o4959: [0.024, 0.748, 0.448]
  }
}

/** Mean of the measured sensors, channel by channel. */
function meanResponse(): SensorResponse {
  const a = SENSORS.imx462
  const b = SENSORS.imx662
  const mean = (x: Rgb, y: Rgb): Rgb => [(x[0] + y[0]) / 2, (x[1] + y[1]) / 2, (x[2] + y[2]) / 2]
  return {
    name: 'IMX462 and IMX662 (mean response)',
    ha: mean(a.ha, b.ha),
    o5007: mean(a.o5007, b.o5007),
    o4959: mean(a.o4959, b.o4959)
  }
}

function response(s: NarrowbandSensor | undefined): { sensor: NarrowbandSensor; r: SensorResponse } {
  if (s === 'imx462' || s === 'imx662' || s === 'imx585') return { sensor: s, r: SENSORS[s] }
  return { sensor: 'starvis', r: meanResponse() }
}

/**
 * Sensor of the instrument that took the file, from the header: first the
 * recognized model code (see instrument.ts), then the camera name, which
 * for astronomy cameras usually contains the sensor number (ASI462MC,
 * IMX662...). Otherwise the mean response.
 */
export function sensorFromMetadata(
  m: Pick<FrameMetadata, 'instrumentInfo' | 'instrument' | 'telescope'> | null | undefined
): NarrowbandSensor {
  if (!m) return 'starvis'
  const model = m.instrumentInfo?.model ?? null
  if (model === 'S50') return 'imx462'
  if (model === 'S30') return 'imx662'
  if (model === 'S30 Pro') return 'imx585'
  // No curves for the other recognized models: mean response.
  if (model !== null) return 'starvis'
  const names = [m.instrument, m.telescope, m.instrumentInfo?.reportedName].filter((v) => !!v).join(' ')
  if (/(IMX|ASI|\b)462/i.test(names)) return 'imx462'
  if (/(IMX|ASI|\b)662/i.test(names)) return 'imx662'
  if (/(IMX|ASI|\b)585|URANUS-?C/i.test(names)) return 'imx585'
  return 'starvis'
}

/** Sentence for the interface: which sensor's response is used. */
export function describeSensor(s: NarrowbandSensor | undefined): string {
  const { sensor, r } = response(s)
  return sensor === 'starvis'
    ? t('coreNarrowband.sensor.unknown')
    : t('coreNarrowband.sensor.known', { sensor: r.name })
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/** Approximate percentile over a regular sample of the pixels. */
function percentile(p: Float32Array, q: number): number {
  const step = Math.max(1, Math.floor(p.length / 200000))
  const sample = new Float32Array(Math.floor(p.length / step))
  for (let k = 0; k < sample.length; k++) sample[k] = p[k * step]
  return kth(sample, Math.min(sample.length - 1, Math.max(0, Math.floor(q * sample.length))))
}

/**
 * Sky level of a plane, from the low tail of the distribution of a
 * smoothed version (5th and 30th percentile): in nebulae that fill the
 * field, like NGC 7000, the median is already nebula. For a normal
 * distribution there are 1.12 deviations between the two percentiles, and
 * the 30th percentile lies 0.52 deviations below the center.
 */
function skyLevel(smoothed: Float32Array): number {
  const p05 = percentile(smoothed, 0.05)
  const p30 = percentile(smoothed, 0.3)
  return p30 + 0.524 * ((p30 - p05) / 1.121)
}

/**
 * Noise of a plane from the differences between pixels a few columns
 * apart: object and gradients cancel out, the grain remains. The distance
 * of 4 pixels steps over the correlation introduced by the color
 * reconstruction (debayer) and by noise reduction.
 */
function planeNoise(p: Float32Array): number {
  const jump = 4
  const step = Math.max(1, Math.floor(p.length / 200000))
  const count = Math.floor((p.length - jump) / step)
  const differences = new Float32Array(count)
  for (let k = 0; k < count; k++) {
    const i = k * step
    differences[k] = p[i] - p[i + jump]
  }
  return Math.max(1e-7, (medianAndMad(differences).mad * MAD_TO_SIGMA) / Math.SQRT2)
}

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

type Blend = ExtractedBands['sensorMix']

/**
 * Blend of the two lines in the three channels of the image as it arrives
 * at this step: the sensor curves say how much each channel sees of each
 * line in the raw data, then each channel may have been multiplied by its
 * own factor by the color balance.
 *
 * The columns are brought to unity in red for H-alpha and in green for
 * OIII, the same scales as before the correction.
 */
function sensorBlend(r: SensorResponse, factors: Rgb): Blend {
  // OIII is two lines, 500.7 and 495.9 nm, the first three times stronger.
  const oiii = (c: number): number => 0.75 * r.o5007[c] + 0.25 * r.o4959[c]
  const h = [0, 1, 2].map((c) => factors[c] * r.ha[c])
  const o = [0, 1, 2].map((c) => factors[c] * oiii(c))
  return [
    [1, o[0] / o[1]],
    [h[1] / h[0], 1],
    [h[2] / h[0], o[2] / o[1]]
  ]
}

/**
 * Coefficients to derive H-alpha and OIII from the three channels: least
 * squares weighted with the inverse of the squared noise of each channel,
 * so the cleanest channel counts more. The two columns of the blend are
 * very different (red against green and blue), so the system is well
 * posed; a touch of regularization avoids divisions by zero with odd data.
 */
function separationCoefficients(m: Blend, noises: number[]): [Rgb, Rgb] {
  const weight = noises.map((s) => 1 / (s * s))
  let a = 0
  let b = 0
  let d = 0
  for (let c = 0; c < 3; c++) {
    a += weight[c] * m[c][0] * m[c][0]
    b += weight[c] * m[c][0] * m[c][1]
    d += weight[c] * m[c][1] * m[c][1]
  }
  const reg = 1e-6 * (a + d)
  a += reg
  d += reg
  const det = a * d - b * b
  const kh = [0, 1, 2].map((c) => (weight[c] * (d * m[c][0] - b * m[c][1])) / det)
  const ko = [0, 1, 2].map((c) => (weight[c] * (a * m[c][1] - b * m[c][0])) / det)
  return [
    [kh[0], kh[1], kh[2]],
    [ko[0], ko[1], ko[2]]
  ]
}

/**
 * Derives H-alpha and OIII from a color image taken with the dual-band
 * filter.
 *
 * 1. Each channel has its own sky level subtracted: the two bands start at
 *    zero and the recomposed background will be neutral gray.
 * 2. Each channel is a blend of the two lines: with the IMX462 sensor,
 *    green receives about 31% of the H-alpha that reaches red and blue
 *    15%; red receives 5% of the OIII of green (see `SENSORS` and
 *    `sensorBlend`). The amounts come from the real sensor curves, not
 *    from the image: measuring them on the data does not work, because
 *    the two lines almost always arise at the same points and a
 *    regression attributes the light to one band or the other at random
 *    (the estimate of the leak into green jumped from 0 to 0.35 just by
 *    changing the smoothing).
 * 3. For each pixel, the amount of H-alpha and OIII that explains the
 *    three channels is solved (weighted least squares, see
 *    `separationCoefficients`): this way the copy of H-alpha that green
 *    and blue had picked up disappears from OIII, and the little OIII
 *    seen by red from H-alpha. The curves apply to raw data. The chain's
 *    color balance then multiplies the channels by factors that on the
 *    test files stay between 0.9 and 1.13: without other information the
 *    curves are therefore used as they are; if the factors are known they
 *    are passed in `colorGains`.
 *
 * The separation works only on data in which the channels have not been
 * mixed: colored-grain reduction (`colorNoise`) smooths the ratios between
 * the channels and leaves the details to the brightness alone, which with
 * this filter is almost all H-alpha, and after it green and blue copy the
 * H-alpha details (on NGC 7000 the correlation of details between OIII
 * and H-alpha goes from 0.12 to 0.84). For this reason the chain, with
 * narrowband active, does not smooth the color and cleans the noise band
 * by band, after the separation (see chain.ts).
 * 4. OIII, almost always much fainter, is brought closer to H-alpha: the
 *    gain evens out half of the signal difference (on a logarithmic
 *    scale) and does not take its noise beyond twice that of H-alpha.
 *    Evening out everything would turn even nebulae almost devoid of
 *    oxygen, like NGC 7000, cyan and inflate their grain.
 *
 * What is left out: continuum light (stars, galaxies, reflection nebulae)
 * goes through the same windows and ends up in both bands; for stars
 * there is the option that keeps their color. The H-beta line (486 nm)
 * also falls on the edge of the OIII window and, to the extent the
 * filter lets it through, ends up in OIII.
 */
export function extractBands(
  img: ImageData32,
  chosenSensor?: NarrowbandSensor,
  /**
   * Factors by which the channels were multiplied after capture (color
   * balance), if known; otherwise they are taken as 1.
   */
  colorGains?: readonly [number, number, number]
): ExtractedBands {
  const w = img.width
  const h = img.height
  const n = w * h
  if (img.channels !== 3) throw new Error(t('coreNarrowband.requiresColor'))
  const d = img.data
  const planes = [d.subarray(0, n), d.subarray(n, 2 * n), d.subarray(2 * n, 3 * n)]
  const { sensor, r: sensorResponse } = response(chosenSensor)

  // Two smoothings: a light one, which says where the stars are, and a
  // wide one, for the sky level and for the nebula signal, where the grain
  // would skew the count.
  const smoothed = planes.map((p) => blur(p, w, h, 2))
  const wide = planes.map((p) => blur(p, w, h, 8))
  const backgrounds = wide.map(skyLevel)
  const noises = planes.map(planeNoise)
  const wideNoises = wide.map(planeNoise)

  // Nebula pixels: above the sky in red or blue, far from saturation and
  // not on a star (which sticks out of the wide version).
  const step = Math.max(1, Math.floor(n / 300000))
  const nebula: number[] = []
  for (let i = 0; i < n; i += step) {
    if (planes[0][i] > 0.95 || planes[1][i] > 0.95 || planes[2][i] > 0.95) continue
    let star = false
    for (let c = 0; c < 3; c++) {
      const above = wide[c][i] - backgrounds[c]
      if (smoothed[c][i] - wide[c][i] > 4 * noises[c] + 0.15 * Math.max(0, above)) star = true
    }
    if (star) continue
    const rr = wide[0][i] - backgrounds[0]
    const bb = wide[2][i] - backgrounds[2]
    if (rr < 4 * wideNoises[0] && bb < 4 * wideNoises[2]) continue
    nebula.push(i)
  }

  const factors: Rgb =
    colorGains && colorGains.every((g) => Number.isFinite(g) && g > 0) ? colorGains : [1, 1, 1]
  const sensorMix = sensorBlend(sensorResponse, factors)
  const [kh, ko] = separationCoefficients(sensorMix, noises)
  const split = (k: Rgb, i: number, sources: Float32Array[]): number =>
    k[0] * (sources[0][i] - backgrounds[0]) + k[1] * (sources[1][i] - backgrounds[1]) + k[2] * (sources[2][i] - backgrounds[2])
  const combinedNoise = (k: Rgb): number =>
    Math.sqrt((k[0] * noises[0]) ** 2 + (k[1] * noises[1]) ** 2 + (k[2] * noises[2]) ** 2)
  const noiseHa = combinedNoise(kh)
  const rawNoiseOiii = combinedNoise(ko)

  const ha = new Float32Array(n)
  const oiii = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    ha[i] = split(kh, i, planes)
    oiii[i] = split(ko, i, planes)
  }

  // Signal of the two bands: median over the nebula pixels.
  let gain = 1
  if (nebula.length > 100) {
    const haValues = new Float64Array(nebula.length)
    const oValues = new Float64Array(nebula.length)
    nebula.forEach((i, j) => {
      haValues[j] = split(kh, i, wide)
      oValues[j] = split(ko, i, wide)
    })
    const signalHa = kth(haValues, haValues.length >> 1)
    const signalO = Math.max(signalHa / 50, kth(oValues, oValues.length >> 1))
    const ratio = signalHa / signalO
    const noiseLimit = (2 * noiseHa) / rawNoiseOiii
    if (ratio > 1) gain = clamp(Math.min(Math.sqrt(ratio), noiseLimit), 1, 8)
  }
  for (let i = 0; i < n; i++) oiii[i] *= gain

  return {
    width: w,
    height: h,
    ha,
    oiii,
    background: (backgrounds[0] + backgrounds[1] + backgrounds[2]) / 3,
    noiseHa,
    noiseOiii: rawNoiseOiii * gain,
    oiiiGain: gain,
    sensor,
    sensorMix
  }
}


// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/**
 * Weight of the Foraxx dynamic blend at a pixel, from 0 to 1. The original
 * formula works on the stretched image: t = (H·O)^(1 − H·O), large only
 * where both bands are strong. On linear data H·O would always be almost
 * zero, so here the bands are stretched internally, with a common curve
 * that brings the typical H-alpha signal to mid-scale.
 */
function foraxxWeight(hn: number, on: number): number {
  const x = hn * on
  return x <= 0 ? 0 : Math.pow(x, 1 - x)
}

/** Internal stretch curve for the Foraxx blend. */
function innerCurve(b: ExtractedBands): (v: number) => number {
  const n = b.ha.length
  const step = Math.max(1, Math.floor(n / 200000))
  const values: number[] = []
  for (let i = 0; i < n; i += step) if (b.ha[i] > 3 * b.noiseHa) values.push(b.ha[i])
  const signal = values.length > 50 ? kth(Float64Array.from(values), values.length >> 1) : 10 * b.noiseHa
  // White at a few times the typical signal, midtones chosen so that the
  // typical signal reaches 0.5.
  const white = Math.max(1e-6, signal * 6)
  const x = signal / white
  let lo = 0.0001
  let hi = 0.9999
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2
    if (mtf(x, m) > 0.5) lo = m
    else hi = m
  }
  const m = (lo + hi) / 2
  return (v: number) => mtf(clamp(v / white, 0, 1), m)
}

/**
 * Smoothing between 0 and 1, like the one in the other tools: no steps at
 * the edge of the masks.
 */
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Star mask: at each pixel, the fraction of light that comes from the star
 * and not from the nebula it sits on. At the center of a bright star it is
 * almost 1, toward the edge it falls with the star's light; around a faint
 * star above the nebula it stays low. Used as a weight, it gives the stars
 * their original color while leaving the palette to the surrounding
 * nebula, without edges.
 */
function starMask(img: ImageData32, analysis?: StarAnalysis): Float32Array {
  const w = img.width
  const h = img.height
  const own = analysis ? null : analyzeStars(img)
  const a = analysis ?? (own as StarAnalysis)
  const lum = a.softLuminance
  const m = new Float32Array(w * h)
  for (const s of a.stars) {
    const rMax = s.radius * 1.4 + 1
    const x0 = Math.max(0, Math.floor(s.x - rMax))
    const x1 = Math.min(w - 1, Math.ceil(s.x + rMax))
    const y0 = Math.max(0, Math.floor(s.y - rMax))
    const y1 = Math.min(h - 1, Math.ceil(s.y + rMax))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - s.x
        const dy = y - s.y
        const r = Math.sqrt(dx * dx + dy * dy)
        if (r > rMax) continue
        const i = y * w + x
        const l = lum[i]
        if (l <= 0) continue
        const fraction = clamp((l - s.lumBackground) / l, 0, 1)
        const v = fraction * (1 - smooth(s.radius * 0.9, rMax, r)) * (0.3 + 0.7 * s.certainty)
        if (v > m[i]) m[i] = v
      }
    }
  }
  if (own) releaseStarAnalysis(own)
  return m
}

/**
 * Recomposes the image in the chosen palette. With 'natural' it returns
 * the image as it is (the same object). Black-and-white images pass
 * through unchanged.
 */
export function narrowband(
  img: ImageData32,
  p: NarrowbandParams,
  /**
   * Bands already extracted from the same image: to avoid recomputing them
   * (previews) or because the chain has already cleaned them band by band.
   * `img` is then used only for the star color.
   */
  alreadyExtractedBands?: ExtractedBands
): ImageData32 {
  if (p.palette === 'natural' || img.channels !== 3) return img
  const b = alreadyExtractedBands ?? extractBands(img, p.sensor)
  const w = img.width
  const h = img.height
  const n = w * h

  // The balance shifts light between the two bands in equal parts: toward
  // OIII one grows as much as the other falls, and the overall light stays
  // similar. Up to a factor of 4 difference at the extremes.
  const bil = clamp(p.balance, -1, 1)
  const gHa = Math.pow(2, -bil)
  const gO = Math.pow(2, bil) * clamp(p.oiiiIntensity, 0, 2)

  const curve = p.palette === 'foraxx' ? innerCurve(b) : null
  const out = new Float32Array(3 * n)
  const f = b.background
  for (let i = 0; i < n; i++) {
    const H = b.ha[i] * gHa
    const O = b.oiii[i] * gO
    let R: number
    let G: number
    let B: number
    if (p.palette === 'hoo') {
      R = H
      G = O
      B = O
    } else if (p.palette === 'foraxx' && curve) {
      const t = foraxxWeight(curve(H), curve(O))
      R = H
      G = t * H + (1 - t) * O
      B = O
    } else {
      // Synthetic Hubble: sulfur and hydrogen are both H-alpha (red and
      // green), then the excess green is removed as the SCNR technique
      // does, no further than the mean of red and blue. Where there is
      // only hydrogen the green stays at half the red (gold); where there
      // is oxygen the color moves toward white and cyan.
      R = H
      G = Math.min(H, (H + O) / 2)
      B = O
    }
    out[i] = clamp(f + R, 0, 1)
    out[n + i] = clamp(f + G, 0, 1)
    out[2 * n + i] = clamp(f + B, 0, 1)
  }

  if (p.naturalStars) {
    const m = starMask(img)
    const d = img.data
    for (let i = 0; i < n; i++) {
      const a = m[i]
      if (a <= 0) continue
      for (let c = 0; c < 3; c++) {
        const j = c * n + i
        out[j] += (d[j] - out[j]) * a
      }
    }
  }
  return { width: w, height: h, channels: 3, data: out }
}

/** True if the value of the header FILTER keyword indicates the dual-band filter. */
export function dualBandFile(headerFilter: unknown): boolean {
  return filterFromHeader(headerFilter) === 'dual-band'
}

/**
 * Automatic choice: narrowband makes sense only with the dual-band filter,
 * and then HOO is suggested, the palette most faithful to the two lines
 * actually captured, with the stars in their own color. Otherwise it
 * returns the neutral values. The automatic finish does not apply it: it
 * is used to prefill the Process step when requested.
 */
export function automaticNarrowband(headerFilter: unknown): NarrowbandParams {
  return dualBandFile(headerFilter) ? { ...NARROWBAND_NEUTRAL, palette: 'hoo' } : NARROWBAND_NEUTRAL
}

/**
 * Reduced copy (block average) for the palette previews: the long side
 * becomes at most `side` pixels.
 */
export function reduceForPreview(img: ImageData32, side: number): ImageData32 {
  const factor = Math.max(1, Math.floor(Math.max(img.width, img.height) / side))
  const w = Math.max(1, Math.floor(img.width / factor))
  const h = Math.max(1, Math.floor(img.height / factor))
  const n = img.width * img.height
  const out = new Float32Array(img.channels * w * h)
  const area = factor * factor
  for (let c = 0; c < img.channels; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let yy = 0; yy < factor; yy++) {
          const base = c * n + (y * factor + yy) * img.width + x * factor
          for (let xx = 0; xx < factor; xx++) s += img.data[base + xx]
        }
        out[c * w * h + y * w + x] = s / area
      }
    }
  }
  return { width: w, height: h, channels: img.channels, data: out }
}
