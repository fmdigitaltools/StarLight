import { t } from '@shared/i18n/i18n'

/**
 * Photo filters.
 *
 * They do not correct defects: they give the image a character, like
 * classic film stocks or darkroom toning. They act after the stretch,
 * when the image is already readable, and are always adjustable: at zero
 * intensity the filter has no visible effect.
 *
 * Each filter combines a few elementary effects, all computed on the GPU:
 *   temperature and tint  shift the white balance
 *   toning                colors shadows and highlights separately
 *   vibrance              saturates dull colors without washing out the others
 *   curve                 opens or closes the contrast softly
 *   vignette              darkens the edges to focus the eye
 */

export interface FilterParams {
  /** From -1 (cool) to 1 (warm). */
  temperature: number
  /** From -1 (green) to 1 (magenta). */
  tint: number
  /** Color given to the shadows. */
  shadowsToning: [number, number, number]
  /** Color given to the highlights. */
  highlightsToning: [number, number, number]
  /** How strong the toning is, from 0 to 1. */
  toningStrength: number
  /** Selective saturation: acts on dull colors, from -1 to 1. */
  vibrance: number
  /** Overall saturation, from -1 to 1. */
  saturation: number
  /** Soft-curve contrast, from -1 to 1. */
  curve: number
  /** Additional brightness, from -0.5 to 0.5. */
  brightness: number
  /** Edge darkening, from 0 to 1. */
  vignette: number
  /** How far the image tends toward monochrome, from 0 to 1. */
  monochrome: number
}

export interface PhotoFilter {
  id: string
  /** Display name in the current language. */
  name: string
  /** Description in the current language. */
  description: string
  /** Family, used to group the filters in the interface. */
  family: 'natural' | 'color' | 'toning' | 'atmosphere' | 'monochrome'
  /**
   * Three colors for the preview in the grid, from the center to the edge:
   * bright core, nebula, sky background. They are computed by actually
   * applying the filter to three reference colors (see REFERENCE_COLORS).
   */
  preview: [string, string, string]
  parameters: FilterParams
}

/** Neutral filter: no alteration. */
export const NEUTRAL_FILTER: FilterParams = {
  temperature: 0,
  tint: 0,
  shadowsToning: [0, 0, 0],
  highlightsToning: [0, 0, 0],
  toningStrength: 0,
  vibrance: 0,
  saturation: 0,
  curve: 0,
  brightness: 0,
  vignette: 0,
  monochrome: 0
}

/** Soft contrast curve, identical to the shader one. */
function sCurve(value: number, strength: number): number {
  if (Math.abs(strength) < 0.001) return value
  const x = value < 0 ? 0 : value > 1 ? 1 : value
  const soft = x * x * (3 - 2 * x)
  const target = strength > 0 ? soft : x + (x - soft)
  return x + (target - x) * Math.abs(strength)
}

/** Gradual transition, like the shader smoothstep. */
function smoothStep(from: number, a: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (a - from)))
  return t * t * (3 - 2 * t)
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function luminance(c: number[]): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/**
 * Applies the photo filter to a pixel (values from 0 to 1, modified in
 * place), repeating exactly the steps of the viewer shader: the exported
 * image and the grid previews must match what is displayed.
 *
 * @param x, y position from 0 to 1 in the frame, for the vignette
 */
export function applyPixelFilter(rgb: number[], p: FilterParams, x: number, y: number): void {
  if (Math.abs(p.temperature) > 0.001 || Math.abs(p.tint) > 0.001) {
    rgb[0] *= 1 + p.temperature * 0.28
    rgb[2] *= 1 - p.temperature * 0.28
    rgb[1] *= 1 - p.tint * 0.18
    rgb[0] *= 1 + p.tint * 0.07
    rgb[2] *= 1 + p.tint * 0.07
  }

  if (p.monochrome > 0.001) {
    const gray = luminance(rgb)
    for (let c = 0; c < 3; c++) rgb[c] += (gray - rgb[c]) * p.monochrome
  }

  if (p.toningStrength > 0.001) {
    const mix = smoothStep(0.15, 0.85, luminance(rgb))
    for (let c = 0; c < 3; c++) {
      const shouldTint = p.shadowsToning[c] + (p.highlightsToning[c] - p.shadowsToning[c]) * mix
      rgb[c] += shouldTint * p.toningStrength
    }
  }

  if (Math.abs(p.vibrance) > 0.001) {
    const light = luminance(rgb)
    const sat = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])
    const boost = p.vibrance * (1 - smoothStep(0, 0.6, sat))
    for (let c = 0; c < 3; c++) rgb[c] = light + (rgb[c] - light) * (1 + boost)
  }

  if (Math.abs(p.saturation) > 0.001) {
    const light = luminance(rgb)
    for (let c = 0; c < 3; c++) rgb[c] = light + (rgb[c] - light) * (1 + p.saturation)
  }

  for (let c = 0; c < 3; c++) rgb[c] = clamp(sCurve(rgb[c], p.curve) + p.brightness)

  if (p.vignette > 0.001) {
    const distance = Math.hypot(x - 0.5, y - 0.5) * 1.414
    const factor = 1 - p.vignette * smoothStep(0.45, 1, distance)
    for (let c = 0; c < 3; c++) rgb[c] *= factor
  }
}

/**
 * Reference colors for the previews, as in a typical deep-sky photo: the
 * bright, warm core of a nebula, the pinkish nebula around it, and the
 * dark, slightly cool sky background. Each sits at a distance from the
 * center of the preview (which is a radial gradient), so the filter
 * vignette also shows at the edge. The three colors were chosen by
 * measuring the perceptual difference (ΔE) between the previews of all
 * filters: with these, the most similar pairs are those of filters that
 * really do look alike (None and Natural).
 */
const REFERENCE_COLORS: { rgb: [number, number, number]; x: number; y: number }[] = [
  { rgb: [0.86, 0.78, 0.72], x: 0.5, y: 0.5 },
  { rgb: [0.48, 0.26, 0.32], x: 0.25, y: 0.25 },
  { rgb: [0.12, 0.13, 0.17], x: 0, y: 0 }
]

function hexadecimal(rgb: number[]): string {
  return '#' + rgb.map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('')
}

/** Preview of a filter: the reference colors after the full-strength filter. */
function computePreview(p: FilterParams): [string, string, string] {
  const [a, b, c] = REFERENCE_COLORS.map((r) => {
    const rgb = [...r.rgb]
    applyPixelFilter(rgb, p, r.x, r.y)
    return hexadecimal(rgb)
  })
  return [a, b, c]
}

/**
 * Compact builder: values not given stay neutral. Name and description are
 * read from the language files on access (never at module load), so they
 * follow the current language.
 *
 * @param key key of the filter in the corePhotoFilters language file
 */
function f(
  id: string,
  key: string,
  family: PhotoFilter['family'],
  parameters: Partial<FilterParams>
): PhotoFilter {
  const completeOnes = { ...NEUTRAL_FILTER, ...parameters }
  return {
    id,
    get name() {
      return t('corePhotoFilters.' + key + '.name')
    },
    get description() {
      return t('corePhotoFilters.' + key + '.description')
    },
    family,
    preview: computePreview(completeOnes),
    parameters: completeOnes
  }
}

export const FILTERS: PhotoFilter[] = [
  f('none', 'none', 'natural',
    {}),

  f('natural', 'natural', 'natural',
    { vibrance: 0.18, curve: 0.12 }),

  f('deep-sky', 'deepSky', 'natural',
    { curve: 0.3, vibrance: 0.35, brightness: -0.03, shadowsToning: [-0.02, 0, 0.05], toningStrength: 0.5 }),

  f('blazing-nebula', 'blazingNebula', 'color',
    { temperature: 0.35, vibrance: 0.4, highlightsToning: [0.12, 0.01, -0.05], toningStrength: 0.7, curve: 0.2 }),

  f('polar-chill', 'polarChill', 'color',
    { temperature: -0.42, vibrance: 0.2, shadowsToning: [-0.04, 0.01, 0.1], toningStrength: 0.6 }),

  f('aquamarine', 'aquamarine', 'color',
    { temperature: -0.25, tint: -0.2, vibrance: 0.3, highlightsToning: [-0.06, 0.08, 0.06], toningStrength: 0.65 }),

  f('amethyst', 'amethyst', 'color',
    { tint: 0.22, vibrance: 0.28, shadowsToning: [0.02, -0.02, 0.09], highlightsToning: [0.09, -0.02, 0.12], toningStrength: 0.7 }),

  f('aurora', 'aurora', 'color',
    { tint: -0.3, vibrance: 0.35, shadowsToning: [-0.05, 0.08, 0.0], highlightsToning: [0.08, -0.02, 0.06], toningStrength: 0.75 }),

  f('cosmic-sunset', 'cosmicSunset', 'color',
    { temperature: 0.28, shadowsToning: [0.07, -0.03, 0.07], highlightsToning: [0.12, 0.05, -0.06], toningStrength: 0.8, vibrance: 0.25 }),

  f('cinematic', 'cinematic', 'toning',
    { shadowsToning: [-0.08, 0.02, 0.1], highlightsToning: [0.12, 0.04, -0.08], toningStrength: 0.9, curve: 0.25, vibrance: 0.15 }),

  f('antique-gold', 'antiqueGold', 'toning',
    { temperature: 0.4, monochrome: 0.55, highlightsToning: [0.14, 0.08, -0.08], toningStrength: 0.85, curve: 0.18 }),

  f('copper', 'copper', 'toning',
    { temperature: 0.3, monochrome: 0.7, shadowsToning: [0.05, -0.01, -0.03], highlightsToning: [0.14, 0.05, -0.04], toningStrength: 0.9, curve: 0.3 }),

  f('blue-night', 'blueNight', 'toning',
    { monochrome: 0.75, shadowsToning: [-0.06, -0.02, 0.12], highlightsToning: [-0.02, 0.03, 0.14], toningStrength: 0.95, curve: 0.22 }),
  f('ice', 'ice', 'atmosphere',
    { temperature: -0.3, brightness: 0.05, curve: -0.1, highlightsToning: [-0.04, 0.02, 0.08], toningStrength: 0.6, vibrance: -0.1 }),

  f('pastel', 'pastel', 'atmosphere',
    { saturation: -0.3, curve: -0.25, brightness: 0.06, highlightsToning: [0.04, 0.02, 0.05], toningStrength: 0.5 }),

  f('dreamy', 'dreamy', 'atmosphere',
    { curve: -0.35, brightness: 0.08, vibrance: 0.1, shadowsToning: [0.03, 0.02, 0.06], toningStrength: 0.5 }),

  f('dramatic', 'dramatic', 'atmosphere',
    { curve: 0.55, vignette: 0.45, vibrance: 0.2, brightness: -0.04 }),

  f('vintage', 'vintage', 'atmosphere',
    { saturation: -0.25, temperature: 0.22, curve: -0.12, vignette: 0.3, shadowsToning: [0.06, 0.03, -0.02], toningStrength: 0.7 }),

  f('diamond-stars', 'diamondStars', 'atmosphere',
    { curve: 0.4, brightness: -0.05, vibrance: -0.12, highlightsToning: [0.03, 0.04, 0.06], toningStrength: 0.4 }),

  f('milky-way', 'milkyWay', 'color',
    { temperature: 0.18, vibrance: 0.3, curve: 0.25, shadowsToning: [-0.03, 0.0, 0.06], highlightsToning: [0.08, 0.04, -0.03], toningStrength: 0.6 }),

  f('false-color', 'falseColor', 'color',
    { saturation: 0.55, tint: 0.3, curve: 0.3, shadowsToning: [-0.06, 0.04, 0.1], highlightsToning: [0.12, -0.04, 0.1], toningStrength: 0.9 }),

  f('silver', 'silver', 'monochrome',
    { monochrome: 1, curve: 0.3 }),

  f('charcoal', 'charcoal', 'monochrome',
    { monochrome: 1, curve: 0.45, brightness: -0.06, vignette: 0.3 }),

  f('sepia', 'sepia', 'monochrome',
    { monochrome: 1, shadowsToning: [0.05, 0.01, -0.04], highlightsToning: [0.14, 0.07, -0.08], toningStrength: 1, curve: 0.2 }),

  f('graphite', 'graphite', 'monochrome',
    { monochrome: 1, shadowsToning: [-0.04, -0.01, 0.07], highlightsToning: [-0.01, 0.02, 0.06], toningStrength: 0.8, curve: 0.25 })
]

/** Filter matching an identifier, or the neutral one. */
export function filterById(id: string): PhotoFilter {
  return FILTERS.find((filter) => filter.id === id) ?? FILTERS[0]
}

/** Interpolates between the neutral filter and the chosen one, according to the intensity. */
export function applyFilterAmount(p: FilterParams, intensity: number): FilterParams {
  const k = Math.max(0, Math.min(1, intensity))
  const m = (v: number): number => v * k
  return {
    temperature: m(p.temperature),
    tint: m(p.tint),
    shadowsToning: [m(p.shadowsToning[0]), m(p.shadowsToning[1]), m(p.shadowsToning[2])],
    highlightsToning: [m(p.highlightsToning[0]), m(p.highlightsToning[1]), m(p.highlightsToning[2])],
    toningStrength: m(p.toningStrength),
    vibrance: m(p.vibrance),
    saturation: m(p.saturation),
    curve: m(p.curve),
    brightness: m(p.brightness),
    vignette: m(p.vignette),
    monochrome: m(p.monochrome)
  }
}

/** Number of available filters, not counting the "None" entry. */
export const FILTER_COUNT = FILTERS.length - 1

/**
 * Filter to actually apply: the chosen one, scaled by the intensity, plus
 * the vibrance and vignette from the manual sliders.
 *
 * The manual values are added to those of the filter instead of replacing
 * them: the slider adds to or subtracts from the character given by the
 * filter. The total stays within the useful range (vibrance from -1 to 1,
 * vignette from 0 to 1). The viewer, the preview and export all use this
 * function, so the saved file matches what is displayed.
 *
 * @returns undefined if there is nothing to apply
 */
export function effectiveFilter(
  id: string,
  intensity: number,
  vibrance: number,
  vignette: number
): FilterParams | undefined {
  const none = id === 'none'
  if (none && Math.abs(vibrance) <= 0.001 && vignette <= 0.001) return undefined
  const base = none ? NEUTRAL_FILTER : applyFilterAmount(filterById(id).parameters, intensity)
  return {
    ...base,
    vibrance: Math.max(-1, Math.min(1, base.vibrance + vibrance)),
    vignette: Math.max(0, Math.min(1, base.vignette + vignette))
  }
}
