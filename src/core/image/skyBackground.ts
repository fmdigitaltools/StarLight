import type { ImageData32 } from '@shared/types'
import { computeStats } from './stats'

/**
 * Sky background level of each channel (the median over the whole image),
 * used by background removal in the viewer, in the filter thumbnails and
 * in export.
 *
 * On a large image this costs a few hundred milliseconds: the result is
 * tied to the image object (which is never modified in place) and is
 * computed only once for all consumers.
 */
const computed = new WeakMap<ImageData32, [number, number, number]>()

export function imageSkyBackground(image: ImageData32): [number, number, number] {
  const ready = computed.get(image)
  if (ready) return ready
  const n = image.width * image.height
  let background: [number, number, number]
  if (image.channels === 1) {
    const m = computeStats(image.data.subarray(0, n)).median
    background = [m, m, m]
  } else {
    background = [
      computeStats(image.data.subarray(0, n)).median,
      computeStats(image.data.subarray(n, 2 * n)).median,
      computeStats(image.data.subarray(2 * n, 3 * n)).median
    ]
  }
  computed.set(image, background)
  return background
}
