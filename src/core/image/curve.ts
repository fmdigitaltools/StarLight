import { t } from '@shared/i18n/i18n'

/**
 * Tone curves.
 *
 * A curve maps each pixel's current value to its new value: the diagonal
 * leaves the image unchanged, raising it brightens and lowering it darkens.
 * Applied to a single channel, it can also remove color casts that global
 * color balancing does not fix.
 *
 * Points are joined with a monotone interpolation: an ordinary spline
 * between closely spaced points would overshoot and locally reverse the
 * direction of the curve.
 */

export interface CurvePoint {
  /** Input value, from 0 to 1. */
  x: number
  /** Output value, from 0 to 1. */
  y: number
}

/** Channel a curve acts on. */
export type CurveChannel = 'light' | 'red' | 'green' | 'blue'

export interface Curves {
  light: CurvePoint[]
  red: CurvePoint[]
  green: CurvePoint[]
  blue: CurvePoint[]
}

/** Curve that changes nothing: the diagonal. */
export const NEUTRAL_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]

export const NEUTRAL_CURVES: Curves = {
  light: NEUTRAL_CURVE,
  red: NEUTRAL_CURVE,
  green: NEUTRAL_CURVE,
  blue: NEUTRAL_CURVE
}

/** True if the curve coincides with the diagonal. */
export function neutralCurve(points: CurvePoint[]): boolean {
  if (points.length !== 2) return false
  return (
    Math.abs(points[0].x) < 1e-6 &&
    Math.abs(points[0].y) < 1e-6 &&
    Math.abs(points[1].x - 1) < 1e-6 &&
    Math.abs(points[1].y - 1) < 1e-6
  )
}

/** True if none of the four curves has been modified. */
export function neutralCurves(curves: Curves): boolean {
  return (
    neutralCurve(curves.light) &&
    neutralCurve(curves.red) &&
    neutralCurve(curves.green) &&
    neutralCurve(curves.blue)
  )
}

/** Sorts the points and drops duplicates sharing the same x. */
export function sortPoints(points: CurvePoint[]): CurvePoint[] {
  const sortedItems = [...points].sort((a, b) => a.x - b.x)
  const cleanedValues: CurvePoint[] = []
  for (const p of sortedItems) {
    const previous = cleanedValues[cleanedValues.length - 1]
    if (previous && Math.abs(previous.x - p.x) < 0.004) {
      cleanedValues[cleanedValues.length - 1] = p
      continue
    }
    cleanedValues.push(p)
  }
  return cleanedValues
}

/**
 * Builds the curve's lookup table.
 *
 * Uses the Fritsch-Carlson method: slopes are estimated at the points and
 * limited wherever they would cause oscillation, giving a smooth curve that
 * never reverses direction.
 */
export function buildLut(points: CurvePoint[], size = 256): Float32Array {
  const lut = new Float32Array(size)
  const p = sortPoints(points)

  if (p.length === 0) {
    for (let i = 0; i < size; i++) lut[i] = i / (size - 1)
    return lut
  }

  if (p.length === 1) {
    for (let i = 0; i < size; i++) lut[i] = p[0].y
    return lut
  }

  const n = p.length
  const intervals = n - 1

  // Slope of each segment.
  const delta = new Float64Array(intervals)
  for (let i = 0; i < intervals; i++) {
    const dx = p[i + 1].x - p[i].x
    delta[i] = dx > 1e-9 ? (p[i + 1].y - p[i].y) / dx : 0
  }

  // Slope at the points: mean of the adjacent segments.
  const slopes = new Float64Array(n)
  slopes[0] = delta[0]
  slopes[n - 1] = delta[intervals - 1]
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      // Direction change: the point is a local maximum or minimum.
      slopes[i] = 0
    } else {
      slopes[i] = (delta[i - 1] + delta[i]) / 2
    }
  }

  // Correction that keeps the curve from overshooting the points.
  for (let i = 0; i < intervals; i++) {
    if (Math.abs(delta[i]) < 1e-12) {
      slopes[i] = 0
      slopes[i + 1] = 0
      continue
    }
    const a = slopes[i] / delta[i]
    const b = slopes[i + 1] / delta[i]
    const s = a * a + b * b
    if (s > 9) {
      const factor = 3 / Math.sqrt(s)
      slopes[i] = factor * a * delta[i]
      slopes[i + 1] = factor * b * delta[i]
    }
  }

  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)

    if (x <= p[0].x) {
      lut[i] = p[0].y
      continue
    }
    if (x >= p[n - 1].x) {
      lut[i] = p[n - 1].y
      continue
    }

    // Segment containing x.
    let k = 0
    while (k < intervals - 1 && x > p[k + 1].x) k++

    const h = p[k + 1].x - p[k].x
    const t = h > 1e-9 ? (x - p[k].x) / h : 0
    const t2 = t * t
    const t3 = t2 * t

    // Hermite polynomial.
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2

    const value =
      h00 * p[k].y + h10 * h * slopes[k] + h01 * p[k + 1].y + h11 * h * slopes[k + 1]

    lut[i] = value < 0 ? 0 : value > 1 ? 1 : value
  }

  return lut
}

/** Curve value at a point, using the precomputed table. */
export function evaluateLut(lut: Float32Array, x: number): number {
  const last = lut.length - 1
  const position = (x < 0 ? 0 : x > 1 ? 1 : x) * last
  const i = Math.floor(position)
  const fraction = position - i
  if (i >= last) return lut[last]
  return lut[i] + (lut[i + 1] - lut[i]) * fraction
}

/**
 * Preset curves, used as starting points. Name and description are getters so
 * that the text follows the current interface language.
 */
export const PRESET_CURVES: { id: string; name: string; description: string; points: CurvePoint[] }[] = [
  {
    id: 'neutral',
    get name() {
      return t('coreImageCurve.neutral.name')
    },
    get description() {
      return t('coreImageCurve.neutral.description')
    },
    points: NEUTRAL_CURVE
  },
  {
    id: 'contrast',
    get name() {
      return t('coreImageCurve.contrast.name')
    },
    get description() {
      return t('coreImageCurve.contrast.description')
    },
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.18 },
      { x: 0.75, y: 0.84 },
      { x: 1, y: 1 }
    ]
  },
  {
    id: 'soft',
    get name() {
      return t('coreImageCurve.soft.name')
    },
    get description() {
      return t('coreImageCurve.soft.description')
    },
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.33 },
      { x: 0.75, y: 0.68 },
      { x: 1, y: 1 }
    ]
  },
  {
    id: 'faint-signal',
    get name() {
      return t('coreImageCurve.faintSignal.name')
    },
    get description() {
      return t('coreImageCurve.faintSignal.description')
    },
    points: [
      { x: 0, y: 0 },
      { x: 0.15, y: 0.3 },
      { x: 0.5, y: 0.66 },
      { x: 1, y: 1 }
    ]
  },
  {
    id: 'contained-stars',
    get name() {
      return t('coreImageCurve.containedStars.name')
    },
    get description() {
      return t('coreImageCurve.containedStars.description')
    },
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.52 },
      { x: 0.82, y: 0.9 },
      { x: 1, y: 0.97 }
    ]
  }
]

/** Field of `Curves` that corresponds to each channel. */
export const CURVE_KEY: Record<CurveChannel, keyof Curves> = { light: 'light', red: 'red', green: 'green', blue: 'blue' }
