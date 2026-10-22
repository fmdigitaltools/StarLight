/**
 * The k-th smallest value of `data[0..count)`, found without sorting
 * everything: a three-way partition selection (Dutch national flag), the
 * same one used by stacking. Reorders the array in place; after the call
 * `data[k]` is exactly that value.
 *
 * It returns the same number found at position k after a full sort, but at
 * linear cost instead of n·log(n). It is used wherever medians and
 * percentiles of many samples are taken (rings around stars, background
 * blocks, wavelet layers), where sorting would dominate the running time.
 */
export function kth(data: Float32Array | Float64Array, k: number, count = data.length): number {
  return data instanceof Float32Array ? kth32(data, k, count) : kth64(data, k, count)
}

// Two identical copies, one per array type. With a single function that
// receives both Float32Array and Float64Array (including subarrays), V8
// cannot specialize element access and the selection becomes several times
// slower; in the Abracadabra chain, where millions of tile medians are
// taken, it was the heaviest item. Both copies return exactly the same value.

function kth32(data: Float32Array, k: number, count = data.length): number {
  let lo = 0
  let hi = count - 1
  while (lo < hi) {
    const pivot = data[(lo + hi) >> 1]
    let lt = lo
    let gt = hi
    let i = lo
    while (i <= gt) {
      const v = data[i]
      if (v < pivot) {
        const t = data[lt]
        data[lt] = v
        data[i] = t
        lt++
        i++
      } else if (v > pivot) {
        const t = data[gt]
        data[gt] = v
        data[i] = t
        gt--
      } else {
        i++
      }
    }
    if (k < lt) hi = lt - 1
    else if (k > gt) lo = gt + 1
    else break
  }
  return data[k]
}

function kth64(data: Float64Array, k: number, count = data.length): number {
  let lo = 0
  let hi = count - 1
  while (lo < hi) {
    const pivot = data[(lo + hi) >> 1]
    let lt = lo
    let gt = hi
    let i = lo
    while (i <= gt) {
      const v = data[i]
      if (v < pivot) {
        const t = data[lt]
        data[lt] = v
        data[i] = t
        lt++
        i++
      } else if (v > pivot) {
        const t = data[gt]
        data[gt] = v
        data[i] = t
        gt--
      } else {
        i++
      }
    }
    if (k < lt) hi = lt - 1
    else if (k > gt) lo = gt + 1
    else break
  }
  return data[k]
}

/**
 * Median and MAD (median of absolute deviations from the median) of a plane,
 * with exactly the same values as `computeStats`: same regular pixel sample,
 * same middle element. Only the way of finding it changes (selection instead
 * of sorting), and mean, deviation, minimum and maximum are skipped as they
 * are not needed here. The processing chain asks for these two measures
 * dozens of times: with `computeStats` they would cost almost a second,
 * this way a fraction of it.
 */
export function medianAndMad(data: Float32Array, maxSamples = 200000): { median: number; mad: number } {
  if (data.length === 0) return { median: 0, mad: 0 }
  const step = Math.max(1, Math.floor(data.length / maxSamples))
  const n = Math.floor(data.length / step)
  const sample = new Float32Array(n)
  for (let i = 0; i < n; i++) sample[i] = data[i * step]
  const center = Math.floor(n / 2)
  const median = kth(sample, center)
  // Deviations in single precision, as in computeStats.
  const rejections = new Float32Array(n)
  for (let i = 0; i < n; i++) rejections[i] = Math.abs(sample[i] - median)
  return { median, mad: kth(rejections, center) }
}
