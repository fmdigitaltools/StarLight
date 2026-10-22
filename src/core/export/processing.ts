import type { ImageData32 } from '@shared/types'
import { applyStretchValue, mtf, type StretchParams } from '@core/image/stretch'
import { applyPixelFilter, type FilterParams } from '@core/image/photoFilters'
import { buildLut, neutralCurves, evaluateLut, type Curves } from '@core/image/curve'
import { buildGhsLut, type GhsParams } from '@core/image/ghs'
import {
  pixelSpatialFilter,
  noiseParams,
  neighborMean,
  needsSmoothing,
  adjustPixel,
  maskValues,
  MAX_LAYERS,
  type ReadyLocalAdjustments
} from '@core/image/masks'

/**
 * Full-resolution application of the adjustments, for export.
 *
 * The viewer shows the result computed by the GPU at screen resolution. On
 * export the same chain is repeated on the original data, in the same order
 * as the shader, so the saved file matches exactly what is on screen but
 * with every pixel available.
 */

export interface CorrectionParams {
  stretch: StretchParams
  brightness: number
  contrast: number
  saturation: number
  redGain: number
  greenGain: number
  blueGain: number
  gamma: number
  noiseReduction: number
  sharpness: number
  /** Fraction of the sky background subtracted from each channel, 0 to 1. */
  backgroundNeutralization: number
  skyBackground: [number, number, number]
  /** Color-preserving stretch, as in the shader. */
  preserveColor?: boolean
  /** Generalized hyperbolic stretch instead of the midtones stretch. */
  ghs?: GhsParams
  /**
   * Photo filter already scaled by its strength, with manual vibrance and
   * vignette already added (see effectiveFilter); not applied when absent.
   */
  filter?: FilterParams
  /**
   * Crop box, as fractions of the given image: the vignette is centered on
   * it, as in the viewer. Absent = the whole image.
   */
  vignetteBox?: { x: number; y: number; width: number; height: number }
  /** Tone curves; not applied when absent or neutral. */
  curves?: Curves
  /**
   * Local adjustments (masks), applied after all the others as in the
   * viewer; absent when there are none (see `prepareLocals`).
   */
  locals?: ReadyLocalAdjustments | null
}

/** Value rescaled between black and white point, clamped to [0,1]. */
function normalize(v: number, s: StretchParams): number {
  const x = (v - s.shadows) / Math.max(1e-6, s.highlights - s.shadows)
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Smooth transition, like the shader's smoothstep. */
function softStep(from: number, a: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (a - from)))
  return t * t * (3 - 2 * t)
}

/** Reads a pixel of a plane, replicating the edge. */
function sample(plane: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y
  return plane[cy * w + cx]
}

/**
 * Noise reduction by a mean weighted on neighbor similarity, equivalent to
 * the shader's: the immediate neighbors always, those at two and three
 * pixels with the weights from noiseParams, which grow with the intensity.
 * There are always three channels (see applyCorrections).
 */
function reduceNoise(
  channels: Float32Array[],
  w: number,
  h: number,
  intensity: number
): Float32Array[] {
  const threshold = 0.055 + 0.16 * (1 - intensity)
  const invThreshold2 = 1 / (threshold * threshold)
  const { mix, ring2, ring3 } = noiseParams(intensity)
  const radius = ring3 > 0.001 ? 3 : ring2 > 0.001 ? 2 : 1
  const [r, g, b] = channels
  const output = channels.map((c) => new Float32Array(c.length))
  const [ur, ug, ub] = output

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const cr = r[i]
      const cg = g[i]
      const cb = b[i]
      let sr = cr
      let sg = cg
      let sb = cb
      let weight = 1

      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx === 0 && dy === 0) continue
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx
          const j = yy * w + xx
          const vr = r[j]
          const vg = g[j]
          const vb = b[j]
          const d2 = (vr - cr) * (vr - cr) + (vg - cg) * (vg - cg) + (vb - cb) * (vb - cb)
          const distance = Math.max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy)
          const ws = distance === 3 ? ring3 : distance === 2 ? ring2 : 1
          const pv = ws * Math.exp(-d2 * invThreshold2)
          sr += vr * pv
          sg += vg * pv
          sb += vb * pv
          weight += pv
        }
      }

      ur[i] = cr + (sr / weight - cr) * mix
      ug[i] = cg + (sg / weight - cg) * mix
      ub[i] = cb + (sb / weight - cb) * mix
    }
  }

  return output
}

/** Unsharp mask: enhances fine detail. */
function increaseSharpness(
  channels: Float32Array[],
  w: number,
  h: number,
  intensity: number
): Float32Array[] {
  const output = channels.map((c) => new Float32Array(c.length))
  const strength = intensity * 2.2

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      for (let c = 0; c < channels.length; c++) {
        let blurredImage = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            blurredImage += sample(channels[c], w, h, x + dx, y + dy)
          }
        }
        blurredImage /= 9
        output[c][i] = channels[c][i] + (channels[c][i] - blurredImage) * strength
      }
    }
  }

  return output
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Applies the whole adjustment chain and returns a new three-channel
 * image, ready for encoding.
 */
export function applyCorrections(
  image: ImageData32,
  p: CorrectionParams
): ImageData32 {
  const n = image.width * image.height
  const w = image.width
  const h = image.height

  // The planes are split; a monochrome image is replicated on three
  // channels so the rest of the chain is the same.
  let channels: Float32Array[]
  if (image.channels === 3) {
    channels = [
      image.data.slice(0, n),
      image.data.slice(n, 2 * n),
      image.data.slice(2 * n, 3 * n)
    ]
  } else {
    const plane = image.data.slice(0, n)
    channels = [plane, plane.slice(), plane.slice()]
  }

  // The data as in the file: local-adjustment filters start from here, as
  // in the shader, which reads them from the original texture.
  const originals = channels
  if (p.noiseReduction > 0.001) channels = reduceNoise(channels, w, h, p.noiseReduction)
  if (p.sharpness > 0.001) channels = increaseSharpness(channels, w, h, p.sharpness)

  const gains = [p.redGain, p.greenGain, p.blueGain]
  const invGamma = 1 / p.gamma
  const gammaActive = Math.abs(p.gamma - 1) > 0.001

  const output = new Float32Array(n * 3)
  const filter = p.filter
  const box = p.vignetteBox ?? { x: 0, y: 0, width: 1, height: 1 }

  const ghsLut = p.ghs ? buildGhsLut(p.ghs, 4096) : null

  // Curves are converted into lookup tables once.
  const activeCurves = p.curves !== undefined && !neutralCurves(p.curves)
  const lightLut = activeCurves ? buildLut((p.curves as Curves).light, 1024) : null
  const channelsLut = activeCurves
    ? [
        buildLut((p.curves as Curves).red, 1024),
        buildLut((p.curves as Curves).green, 1024),
        buildLut((p.curves as Curves).blue, 1024)
      ]
    : null

  // The black point drops by the same average amount subtracted from the
  // background, exactly as the viewer shader does: the exported image must
  // match what is on screen.
  const backgroundCompensation =
    p.backgroundNeutralization > 0.001
      ? ((p.skyBackground[0] + p.skyBackground[1] + p.skyBackground[2]) / 3) * p.backgroundNeutralization
      : 0
  const effectiveStretch =
    backgroundCompensation > 0
      ? { ...p.stretch, shadows: p.stretch.shadows - backgroundCompensation }
      : p.stretch

  /*
   * The chain for one pixel, from a linear value to a final color. It is a
   * function because local adjustments with sharpening or noise reduction
   * repeat it on the filtered pixel, as the shader does.
   */
  const chain = (rgb: number[], i: number): void => {
    // Background neutralization: constant level per channel.
    if (p.backgroundNeutralization > 0.001) {
      for (let c = 0; c < 3; c++) {
        rgb[c] -= p.skyBackground[c] * p.backgroundNeutralization
      }
    }

    // Color-preserving stretch, identical to the shader's.
    if (p.preserveColor) {
      const s = effectiveStretch
      const interval = Math.max(1e-6, s.highlights - s.shadows)
      for (let c = 0; c < 3; c++) rgb[c] = Math.max(0, (rgb[c] - s.shadows) / interval)
      const l = (rgb[0] + rgb[1] + rgb[2]) / 3
      let ld = ghsLut ? evaluateLut(ghsLut, Math.min(l, 1)) : mtf(Math.min(l, 1), s.midtones)
      if (lightLut !== null) ld = evaluateLut(lightLut, ld)
      const k = l > 1e-6 ? ld / l : 0
      let max = 0
      for (let c = 0; c < 3; c++) {
        rgb[c] *= k
        if (rgb[c] > max) max = rgb[c]
      }
      const lm = Math.min(ld, 1)
      // Out of gamut: the color is pulled toward gray at the same
      // brightness, just enough to fit (see the shader).
      const fit = max > 1 ? Math.max(0, (1 - lm) / Math.max(1e-6, max - lm)) : 1
      // Dark areas fade toward gray, the brightest toward white.
      const mask = softStep(0.02, 0.06, ld) * fit * (1 - softStep(0.9, 1, ld))
      for (let c = 0; c < 3; c++) rgb[c] = lm + (rgb[c] - lm) * mask
    }

    // Stretch, curves, color balance, contrast, brightness.
    for (let c = 0; c < 3; c++) {
      let v = p.preserveColor
        ? rgb[c]
        : ghsLut
          ? evaluateLut(ghsLut, normalize(rgb[c], effectiveStretch))
          : applyStretchValue(rgb[c], effectiveStretch)
      if (!p.preserveColor && channelsLut !== null && lightLut !== null) {
        v = evaluateLut(channelsLut[c], v)
        v = evaluateLut(lightLut, v)
      }
      v *= gains[c]
      v = clamp((v - 0.5) * (1 + p.contrast) + 0.5)
      v = clamp(v + p.brightness)
      rgb[c] = v
    }

    // Saturation relative to luminance.
    if (Math.abs(p.saturation) > 0.001) {
      const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
      const factor = 1 + p.saturation
      for (let c = 0; c < 3; c++) {
        rgb[c] = clamp(luminance + (rgb[c] - luminance) * factor)
      }
    }

    if (gammaActive) {
      for (let c = 0; c < 3; c++) rgb[c] = Math.pow(rgb[c], invGamma)
    }

    if (filter !== undefined) {
      // Position at the pixel center, as the shader sees it: using the
      // corner would shift the vignette by half a pixel.
      applyPixelFilter(
        rgb,
        filter,
        ((i % w) + 0.5) / w / box.width - box.x / box.width,
        (Math.floor(i / w) + 0.5) / h / box.height - box.y / box.height
      )
      for (let c = 0; c < 3; c++) rgb[c] = clamp(rgb[c])
    }
  }

  const locals = p.locals ?? null
  const localValues = new Array<number>(MAX_LAYERS).fill(0)
  const filtered = [0, 0, 0]
  const adjusted = [0, 0, 0]
  const smoothed = [0, 0, 0]
  const withSmooth = locals !== null && needsSmoothing(locals)
  // Sky background luminance after the chain, measured at the center as in the shader.
  let backgroundLight = 0
  if (withSmooth) {
    const f = [Math.max(0, p.skyBackground[0]), Math.max(0, p.skyBackground[1]), Math.max(0, p.skyBackground[2])]
    chain(f, Math.floor(h / 2) * w + Math.floor(w / 2))
    backgroundLight = 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]
  }
  const withLocalFilters =
    locals !== null &&
    locals.layers.some((l) => l.adjustments.sharpness > 0.001 || l.adjustments.noiseReduction > 0.001)

  for (let i = 0; i < n; i++) {
    // As in the shader, negative values left by the filters are set to zero.
    let rgb: number[] = [Math.max(0, channels[0][i]), Math.max(0, channels[1][i]), Math.max(0, channels[2][i])]
    chain(rgb, i)

    if (locals !== null) {
      const x = i % w
      const y = (i - x) / w
      if (withSmooth) {
        neighborMean(originals, w, h, x, y, smoothed)
        for (let c = 0; c < 3; c++) smoothed[c] = Math.max(0, smoothed[c])
        chain(smoothed, i)
      }
      maskValues(locals, smoothed, x, y, localValues, backgroundLight)
      // Local sharpening and noise reduction: the difference between the
      // filtered and the original pixel, weighted by the mask, is added to
      // the linear data and the chain is repeated.
      if (withLocalFilters) {
        let delta0 = 0
        let delta1 = 0
        let delta2 = 0
        let spatial = false
        for (let l = 0; l < locals.layers.length; l++) {
          const r = locals.layers[l].adjustments
          const m = localValues[l]
          if (m <= 0 || (r.sharpness <= 0.001 && r.noiseReduction <= 0.001)) continue
          pixelSpatialFilter(originals, w, h, x, y, r.noiseReduction, r.sharpness, filtered)
          delta0 += m * (filtered[0] - originals[0][i])
          delta1 += m * (filtered[1] - originals[1][i])
          delta2 += m * (filtered[2] - originals[2][i])
          spatial = true
        }
        if (spatial) {
          rgb = [
            Math.max(0, channels[0][i] + delta0),
            Math.max(0, channels[1][i] + delta1),
            Math.max(0, channels[2][i] + delta2)
          ]
          chain(rgb, i)
        }
      }
      // Then the adjustments of each layer, weighted by its mask.
      for (let l = 0; l < locals.layers.length; l++) {
        const m = localValues[l]
        if (m <= 0) continue
        adjusted[0] = rgb[0]
        adjusted[1] = rgb[1]
        adjusted[2] = rgb[2]
        adjustPixel(adjusted, locals.layers[l].adjustments)
        for (let c = 0; c < 3; c++) rgb[c] = rgb[c] + (adjusted[c] - rgb[c]) * m
      }
    }

    output[i] = rgb[0]
    output[n + i] = rgb[1]
    output[2 * n + i] = rgb[2]
  }

  return { width: w, height: h, channels: 3, data: output }
}
