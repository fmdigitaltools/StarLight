import type { ImageData32 } from '@shared/types'
import { sharedMemoryAvailable } from '@shared/sharedMemory'
import { t } from '@shared/i18n/i18n'
import { masterAccess, isCompact, type KeptMaster } from './compactFrame'

/**
 * Frame calibration.
 *
 * A sensor does not record only the light of the stars. It adds a starting
 * level to the readout, a thermal signal that grows with exposure time and
 * temperature, and it responds non-uniformly because optics vignette and
 * dust casts shadows.
 *
 * Calibration frames measure these defects:
 *   bias  - instantaneous exposure with the shutter closed: the readout level
 *   dark  - exposure in the dark with the same duration: the thermal signal
 *   flat  - exposure of a uniform surface: the optical non-uniformities
 *
 * The correction is:  result = (light - dark) / normalised flat
 */

export type MasterType = 'dark' | 'flat' | 'bias'

/**
 * Combines several calibration frames into a single master.
 *
 * The median is used because it removes cosmic rays and isolated
 * disturbances, which in a master would then be subtracted from every frame.
 */
export function createMaster(frame: ImageData32[]): ImageData32 {
  if (frame.length === 0) throw new Error(t('coreCalibration.noFrames'))

  const first = frame[0]
  const w = first.width
  const h = first.height
  const channels = first.channels
  const total = w * h * channels

  for (const f of frame) {
    if (f.width !== w || f.height !== h || f.channels !== channels) {
      throw new Error(t('coreCalibration.masterSizesDiffer'))
    }
  }

  const output = new Float32Array(total)
  const values = new Float32Array(frame.length)

  for (let i = 0; i < total; i++) {
    for (let f = 0; f < frame.length; f++) values[f] = frame[f].data[i]

    // Insertion sort: calibration frames are few.
    for (let a = 1; a < frame.length; a++) {
      const v = values[a]
      let b = a - 1
      while (b >= 0 && values[b] > v) {
        values[b + 1] = values[b]
        b--
      }
      values[b + 1] = v
    }

    const meta = frame.length >> 1
    output[i] =
      (frame.length & 1) === 0 ? (values[meta - 1] + values[meta]) * 0.5 : values[meta]
  }

  return { width: w, height: h, channels: channels, data: output }
}

export interface CalibrationOptions {
  /** Full or compact masters (`KeptMaster` in compactFrame.ts): the result is the same. */
  dark?: KeptMaster | null
  flat?: KeptMaster | null
  bias?: KeptMaster | null
  /** Replaces defective pixels with the median of their neighbours. */
  correctDefectivePixels?: boolean
  /** Number of deviations beyond which a pixel is considered defective. */
  defectivePixelThreshold?: number
  /**
   * Writes the result into the light's own pixels instead of allocating new
   * ones. Useful when the light is not needed after calibration, as in
   * stacking: it saves a whole frame of memory, and if the light was in
   * shared memory the result stays there. The result is identical to the
   * other mode.
   */
  inPlace?: boolean
}

/**
 * Checks that the masters have the size of the light; otherwise throws an
 * error that explains it.
 */
export function checkMasterSizes(w: number, h: number, master: ({ width: number; height: number } | null)[]): void {
  for (const m of master) {
    if (m && (m.width !== w || m.height !== h)) {
      throw new Error(
        t('coreCalibration.sizeMismatch', { masterWidth: m.width, masterHeight: m.height, lightWidth: w, lightHeight: h })
      )
    }
  }
}

/**
 * Mean value of the flat per channel, on which the flat is normalised.
 *
 * Without normalisation the division would change the overall brightness
 * of the image. With a colour sensor each channel is normalised on its own:
 * the flat must correct the differences between areas of the sensor, not
 * the colour. With a single value for all channels, the colour of the panel
 * (or of the twilight sky) would pass into the light, and the same sky
 * would come out a different colour with flats taken differently.
 */
export function flatMeans(flat: KeptMaster | null, channels: number, n: number): number[] {
  const flatMean = [1, 1, 1]
  if (flat) {
    const note = isCompact(flat) ? compactMeans.get(flat) : undefined
    if (note && note.channels === channels) return note.means.slice()
    // The sums run through the values of each plane in the same order as the
    // full master. A compact master is reconstructed in strips, with one sum
    // per plane; with a single value for all planes the sums instead go
    // plane after plane, and one plane at a time is reconstructed.
    const flatPlanes = flat.channels === channels ? channels : 1
    const w = flat.width
    const nf = w * flat.height
    if (flatPlanes === flat.channels) {
      const sums = [0, 0, 0]
      const rows = isCompact(flat) ? STRIP_ROWS : flat.height
      for (let y0 = 0; y0 < flat.height; y0 += rows) {
        const y1 = Math.min(flat.height, y0 + rows)
        const a = masterAccess(flat, 0, nf, w, 0, y0, w, y1)
        for (let c = 0; c < flat.channels; c++) {
          const start = c * a.plane + y0 * w + a.offset
          let sum = sums[c]
          for (let i = start, end = start + (y1 - y0) * w; i < end; i++) sum += a.data[i]
          sums[c] = sum
        }
      }
      for (let c = 0; c < flatPlanes; c++) {
        const mean = sums[c] / (flatPlanes === 1 ? nf : n)
        flatMean[c] = mean > 0 ? mean : 1
      }
    } else {
      const buffer = planeForMaster(flat)
      let sum = 0
      for (let c = 0; c < flat.channels; c++) {
        const p = masterPlane(flat, c, buffer)
        for (let i = 0; i < p.length; i++) sum += p[i]
      }
      const mean = sum / (flat.channels * nf)
      flatMean[0] = mean > 0 ? mean : 1
    }
    if (flatPlanes === 1) flatMean[1] = flatMean[2] = flatMean[0]
    if (isCompact(flat)) compactMeans.set(flat, { channels, means: flatMean.slice() })
  }
  return flatMean
}

/** Means of the compact flats: reconstructing them for every frame would cost too much. */
const compactMeans = new WeakMap<KeptMaster, { channels: number; means: number[] }>()

/** Rows reconstructed at a time from compact masters. */
const STRIP_ROWS = 32

/** The plane in which to reconstruct a compact master; null for a full one. */
function planeForMaster(m: KeptMaster): Float32Array | null {
  return isCompact(m) ? new Float32Array(m.width * m.height) : null
}

/**
 * Plane c of a master, in full. For a full master it is a view on its data;
 * a compact one is reconstructed in strips into `plane`, a temporary plane
 * that the caller releases.
 */
function masterPlane(m: KeptMaster, c: number, plane: Float32Array | null): Float32Array {
  const w = m.width
  const n = w * m.height
  if (!isCompact(m) || !plane) return (m as ImageData32).data.subarray(c * n, (c + 1) * n)
  for (let y0 = 0; y0 < m.height; y0 += STRIP_ROWS) {
    const y1 = Math.min(m.height, y0 + STRIP_ROWS)
    const a = masterAccess(m, 0, n, w, 0, y0, w, y1)
    // The chunk may contain more rows than the strip: it is as wide as the master.
    const start = c * a.plane + y0 * w + a.offset
    plane.set(a.data.subarray(start, start + (y1 - y0) * w), y0 * w)
  }
  return plane
}

/**
 * Applies calibration to a light frame. Missing masters are simply
 * skipped: calibrating with the dark alone is possible.
 */
export function calibrate(light: ImageData32, options: CalibrationOptions): ImageData32 {
  const w = light.width
  const h = light.height
  const channels = light.channels
  const n = w * h

  const dark = options.dark ?? null
  const flat = options.flat ?? null
  const bias = options.bias ?? null

  checkMasterSizes(w, h, [dark, flat, bias])
  const flatMean = flatMeans(flat, channels, n)

  // In-place is safe: each output pixel depends only on the same pixel of
  // the light, read before it is written.
  const output = options.inPlace ? light.data : new Float32Array(n * channels)

  // The dark already contains the readout level: the bias is subtracted
  // only when working without a dark.
  const toSubtract = dark ?? bias
  // Compact masters are reconstructed in strips of rows; with full masters
  // the strip is the whole image.
  const compactItems = (toSubtract !== null && isCompact(toSubtract)) || (flat !== null && isCompact(flat))
  const rows = compactItems ? STRIP_ROWS : h
  for (let y0 = 0; y0 < h; y0 += rows) {
    const y1 = Math.min(h, y0 + rows)
    const s = toSubtract ? masterAccess(toSubtract, 0, n, w, 0, y0, w, y1) : null
    const f = flat ? masterAccess(flat, 1, n, w, 0, y0, w, y1) : null
    for (let c = 0; c < channels; c++) {
      const inverse = 1 / flatMean[c]
      // From an image index to the master's one: strips are as wide as the
      // image.
      const ds = s ? c * s.plane + s.offset - c * n : 0
      const df = f ? c * f.plane + f.offset - c * n : 0
      for (let i = c * n + y0 * w, end = c * n + y1 * w; i < end; i++) {
        let value = light.data[i]
        if (s) value -= s.data[i + ds]

        if (f) {
          const correction = f.data[i + df] * inverse
          // A value close to zero would make the division blow up.
          value = correction > 0.02 ? value / correction : value
        }

        output[i] = value < 0 ? 0 : value > 1 ? 1 : value
      }
    }
  }

  const result: ImageData32 = { width: w, height: h, channels: channels, data: output }

  if (options.correctDefectivePixels && dark) {
    if (options.inPlace) {
      replaceDefective(result, dark, options.defectivePixelThreshold ?? 6, output)
      return result
    }
    return correctDefective(result, dark, options.defectivePixelThreshold ?? 6)
  }

  return result
}

/* ---- Defective pixels ---- */

/**
 * The defective pixels of a dark master, plane by plane: bit c of
 * `planes[i]` says that pixel i is defective in channel c.
 */
export interface DefectMap {
  threshold: number
  planes: Uint8Array
  /** Pixels with at least one defective channel. */
  pixel: Uint32Array
  /**
   * Distinct defects: the true hot pixels, without the neighbouring pixels
   * onto which colour reconstruction spread them.
   */
  defects: number
}

/** Neighbours two steps away: in the sensor layout they have the same colour. */
export const RING: [number, number][] = [
  [-2, -2], [0, -2], [2, -2],
  [-2, 0], [2, 0],
  [-2, 2], [0, 2], [2, 2]
]

/** Median of 8 values (reorders the buffer). */
export function median8(v: Float32Array): number {
  for (let a = 1; a < 8; a++) {
    const x = v[a]
    let b = a - 1
    while (b >= 0 && v[b] > x) {
      v[b + 1] = v[b]
      b--
    }
    v[b + 1] = x
  }
  return (v[3] + v[4]) * 0.5
}

/** Maps already computed: the dark is the same for all the frames of a session. */
const computedMaps = new WeakMap<KeptMaster, DefectMap>()

/**
 * Finds the defective pixels of a dark master.
 *
 * A pixel is defective when in the dark it records much more than its
 * neighbours: the comparison is against the median of the eight pixels two
 * steps away, which in a colour sensor have the same colour, and the
 * threshold is in typical deviations of this difference, measured robustly.
 * Comparing with the neighbours and not with the mean of the whole dark,
 * the amplifier glow in a corner, which rises slowly, is not mistaken for
 * a patch of defective pixels, and hot pixels do not inflate the threshold.
 *
 * Each channel is examined on its own: in a colour dark a hot green pixel
 * shows only in the green plane (and, reduced, in the reconstructed green
 * of the neighbouring pixels, which if they stand out must be corrected too).
 *
 * The defect planes are in shared memory when available: they travel with
 * the compact frames to the sum workers without copies.
 */
export function defectMap(dark: KeptMaster, threshold: number): DefectMap {
  const already = computedMaps.get(dark)
  if (already && already.threshold === threshold) return already

  const w = dark.width
  const h = dark.height
  const n = w * h
  const planes = sharedMemoryAvailable ? new Uint8Array(new SharedArrayBuffer(n)) : new Uint8Array(n)
  const buffer = planeForMaster(dark)
  const residuals = new Float32Array(n)
  const neighbors = new Float32Array(8)
  const offsets = RING.map(([dx, dy]) => dy * w + dx)
  let defects = 0
  const inner = Math.max(0, w - 4) * Math.max(0, h - 4)

  for (let c = 0; c < dark.channels && inner > 0; c++) {
    const d = masterPlane(dark, c, buffer)
    residuals.fill(0)

    // Typical spread of the deviation from the neighbours, on a sample of pixels.
    const sample: number[] = []
    const step = Math.max(1, Math.floor(inner / 50000))
    for (let k = 0; k < inner; k += step) {
      const i = (2 + Math.floor(k / (w - 4))) * w + 2 + (k % (w - 4))
      for (let j = 0; j < 8; j++) neighbors[j] = d[i + offsets[j]]
      sample.push(d[i] - median8(neighbors))
    }
    sample.sort((a, b) => a - b)
    const center = sample[sample.length >> 1]
    const rejections = sample.map((v) => Math.abs(v - center)).sort((a, b) => a - b)
    const sigma = rejections[rejections.length >> 1] * 1.4826
    const limit = center + threshold * Math.max(1e-6, sigma)

    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x
        const v = d[i]
        // Quick rejection: a pixel that does not exceed `limit` even over the
        // lowest of its neighbours cannot exceed their median.
        let minimum = Infinity
        for (let j = 0; j < 8; j++) {
          const u = d[i + offsets[j]]
          neighbors[j] = u
          if (u < minimum) minimum = u
        }
        if (v - minimum <= limit) continue
        const r = v - median8(neighbors)
        if (r > limit) {
          planes[i] |= 1 << c
          residuals[i] = r
        }
      }
    }

    // Distinct defects are the local maxima: a hot pixel spread onto its
    // neighbours by colour reconstruction counts only once.
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x
        const r = residuals[i]
        if (r <= 0) continue
        let max = true
        for (let dy = -1; dy <= 1 && max; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if ((dx !== 0 || dy !== 0) && residuals[i + dy * w + dx] > r) {
              max = false
              break
            }
          }
        }
        if (max) defects++
      }
    }
  }

  let count = 0
  for (let i = 0; i < n; i++) if (planes[i] !== 0) count++
  const pixel = new Uint32Array(count)
  for (let i = 0, k = 0; i < n; i++) if (planes[i] !== 0) pixel[k++] = i

  const map: DefectMap = { threshold, planes, pixel, defects }
  computedMaps.set(dark, map)
  return map
}

/**
 * Replaces defective pixels with the median of their neighbours.
 *
 * Hot pixels are recognised from the dark master: they are the ones that
 * in the dark record much more light than their neighbours. They stay fixed
 * from one exposure to the next, so stacking does not eliminate them and
 * they must be handled here: even after subtracting the dark, their noise
 * (which grows with the thermal signal) makes them stand out, and
 * saturated ones become black holes. Only the defective channel is
 * replaced, with the median of the eight neighbours two steps away (of the
 * same colour, in the sensor layout).
 */
export function correctDefective(
  image: ImageData32,
  dark: KeptMaster,
  threshold: number
): ImageData32 {
  const output = new Float32Array(image.data)
  replaceDefective(image, dark, threshold, output)
  return { width: image.width, height: image.height, channels: image.channels, data: output }
}

/**
 * Writes into `output` the median of the neighbours in place of the
 * defective pixels. All medians are computed on the values of `image`
 * before any is written: so `output` may be the same image, and two nearby
 * defects do not influence each other, exactly as with a copy.
 */
function replaceDefective(
  image: ImageData32,
  dark: KeptMaster,
  threshold: number,
  output: Float32Array
): void {
  const w = image.width
  const n = w * image.height
  const map = defectMap(dark, threshold)
  const onePlane = dark.channels === 1
  const offsets = RING.map(([dx, dy]) => dy * w + dx)
  const neighbors = new Float32Array(8)

  // First the medians (position and value), then the writes.
  const positions: number[] = []
  const values: number[] = []
  for (let k = 0; k < map.pixel.length; k++) {
    const i = map.pixel[k]
    const bit = map.planes[i]
    for (let c = 0; c < image.channels; c++) {
      // A single-plane dark applies to all channels.
      if ((bit & (1 << (onePlane ? 0 : c))) === 0) continue
      const base = c * n
      for (let j = 0; j < 8; j++) neighbors[j] = image.data[base + i + offsets[j]]
      positions.push(base + i)
      values.push(median8(neighbors))
    }
  }
  for (let k = 0; k < positions.length; k++) output[positions[k]] = values[k]
}

/** Counts the defective pixels detected in a dark master (the distinct defects). */
export function countDefectivePixels(dark: KeptMaster, threshold = 6): number {
  return defectMap(dark, threshold).defects
}
