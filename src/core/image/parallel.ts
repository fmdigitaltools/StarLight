/**
 * Computations split across threads without changing the result.
 *
 * Much of the processing chain's time goes into blurs (the cleanup `blur`),
 * called dozens of times by almost every tool, and into a few other passes
 * that treat each row independently (the wavelet filter, the reduction of
 * the smooth versions used by local contrast). A blur is made
 * of moving-average passes along rows and columns, and each row (or column)
 * is computed on its own, without looking at the others: splitting them
 * across threads gives exactly the same numbers, bit for bit, with no seams.
 *
 * The engine code stays synchronous and knows nothing about threads: it asks
 * an "executor", if one is registered, to run a part on each participant.
 * The executor is registered by the chain worker (see
 * `renderer/src/workers/helper.worker.ts` and `barrier.ts`), which keeps a
 * squad of helpers ready with shared memory and waits for them with
 * `Atomics`. Without an executor (in test tools, or where shared memory is
 * unavailable) everything runs on a single thread.
 */

/** The three pairs of passes of a blur. */
export interface BlurTask {
  type: 'blur'
  /** Data to blur, overwritten with the result; in shared memory. */
  data: Float32Array
  /** Scratch buffer for the intermediate passes, same length; in shared memory. */
  scratch: Float32Array
  w: number
  h: number
  r: number
}

/** One pass of the wavelet B3 filter, with holes of step `d`. */
export interface TaskB3 {
  type: 'b3'
  from: Float32Array
  a: Float32Array
  w: number
  h: number
  d: number
}

/** Reduction of a plane by `factor` per side, averaging the blocks. */
export interface ReductionTask {
  type: 'downscale'
  from: Float32Array
  a: Float32Array
  w: number
  wr: number
  hr: number
  factor: number
}

export type ParallelTask = BlurTask | TaskB3 | ReductionTask

export interface ParallelExecutor {
  /** Threads that participate, including the caller. */
  participants: number
  /** Runs the task on all participants and returns when they have finished. */
  run(task: ParallelTask): void
}

let executor: ParallelExecutor | null = null

/** Registers (or removes, with null) the executor used by the engine on this thread. */
export function setExecutor(e: ParallelExecutor | null): void {
  executor = e
  reserve.length = 0
  inUse.clear()
}

/** Below this size, splitting the work costs more than it gains. */
const MIN_PIXELS = 400000

/** The executor, if splitting the work is worthwhile for a plane of `n` pixels. */
function executorFor(n: number): ParallelExecutor | null {
  return executor !== null && executor.participants > 1 && n >= MIN_PIXELS ? executor : null
}

/**
 * Pool of shared memory to reuse.
 *
 * Each task passes its arrays to the helpers, and each helper keeps a
 * reference to them until its garbage collector runs; but a helper allocates
 * almost nothing, so that moment in practice never comes before the helper
 * is closed at the end of the stage. A shared array handed to the helpers
 * therefore stays in memory for the whole stage, whether this thread keeps
 * it or not: dropping it would free nothing, and creating new shared arrays
 * for every task would make memory grow by gigabytes. Scratch arrays are
 * therefore taken from this pool and returned after use, and every array
 * returned is kept, so the same space serves all subsequent tasks; whoever
 * must keep a result receives a copy in ordinary memory. An array is
 * returned only after the task has finished (`run` returns when all
 * participants are done), so no helper is still using it.
 *
 * A request is served by the smallest free buffer that is large enough (a
 * view of the first `n` values): the reduced planes of local contrast reuse
 * the space of full planes instead of adding buffers of their own. The pool
 * is thus as large as the most shared memory a single tool uses at once, and
 * it is emptied when the executor changes, that is, at the end of the stage.
 */
const reserve: SharedArrayBuffer[] = []
/** Buffers of the pool currently handed out, so a double return is ignored. */
const inUse = new Set<SharedArrayBuffer>()

/**
 * Scratch array for a parallel task: in shared memory, taken from the pool,
 * if there is an executor (the helpers must be able to read and write it),
 * ordinary otherwise. Its initial content is undefined. It must be returned
 * with `returnShared` when no longer needed, and nobody may keep a
 * reference to it afterwards.
 *
 * The tools of the chain also take from here their large temporary planes,
 * even those no helper reads: returned after use, they are reused by the
 * next tool instead of waiting for the garbage collector, which on large
 * images would let gigabytes of dead planes pile up before freeing them.
 */
export function takeShared(n: number): Float32Array {
  if (!executor) return new Float32Array(n)
  const bytes = n * 4
  let best = -1
  for (let i = 0; i < reserve.length; i++) {
    const length = reserve[i].byteLength
    if (length >= bytes && (best < 0 || length < reserve[best].byteLength)) best = i
  }
  const b = best >= 0 ? reserve.splice(best, 1)[0] : new SharedArrayBuffer(bytes)
  inUse.add(b)
  return new Float32Array(b, 0, n)
}

/** Puts back into the pool an array obtained from `takeShared`. */
export function returnShared(v: Float32Array): void {
  const b = v.buffer
  if (!executor || !(b instanceof SharedArrayBuffer) || v.byteOffset !== 0) return
  if (!inUse.delete(b)) return
  reserve.push(b)
}

/**
 * The same array if it is already shared (or sharing is not needed),
 * otherwise a shared copy taken from the pool. If the result differs from
 * `p`, it is a temporary copy to be returned with `returnShared`.
 */
export function sharedValue(p: Float32Array): Float32Array {
  if (!executor || p.buffer instanceof SharedArrayBuffer) return p
  const c = takeShared(p.length)
  c.set(p)
  return c
}

/** Copy in ordinary memory of an array from the pool, which is then returned. */
export function copyAndReturn(v: Float32Array): Float32Array {
  if (!(v.buffer instanceof SharedArrayBuffer)) return v
  const copy = new Float32Array(v.length)
  copy.set(v)
  returnShared(v)
  return copy
}

/**
 * Blur with three moving-average passes over rows and columns, split across
 * threads if there is an executor. Returns a new array.
 */
export function blurMovingAverage(p: Float32Array, w: number, h: number, r: number): Float32Array {
  const e = executorFor(w * h)
  if (!e) {
    const a = p.slice()
    const b = new Float32Array(p.length)
    for (let pass = 0; pass < 3; pass++) {
      rowMeans(a, b, w, 0, h, r)
      columnMeans(b, a, w, h, 0, w, r)
    }
    return a
  }
  const data = takeShared(p.length)
  data.set(p)
  const scratch = takeShared(p.length)
  e.run({ type: 'blur', data, scratch, w, h, r })
  returnShared(scratch)
  return copyAndReturn(data)
}

/**
 * Like `blurMovingAverage`, with the same result, but written into `p`
 * itself: no new array is left behind, which on large images saves a plane
 * for every blur whose input is no longer needed.
 */
export function blurMovingAverageInPlace(p: Float32Array, w: number, h: number, r: number): Float32Array {
  const e = executorFor(w * h)
  if (!e) {
    const b = new Float32Array(p.length)
    for (let pass = 0; pass < 3; pass++) {
      rowMeans(p, b, w, 0, h, r)
      columnMeans(b, p, w, h, 0, w, r)
    }
    return p
  }
  const data = sharedValue(p)
  const scratch = takeShared(p.length)
  e.run({ type: 'blur', data, scratch, w, h, r })
  returnShared(scratch)
  if (data !== p) {
    p.set(data)
    returnShared(data)
  }
  return p
}

/**
 * One pass of the wavelet B3 filter (a trous, with holes of step `d`): first
 * along the rows, then along the columns into `a`. Each output row depends
 * only on complete rows of the row pass, so rows can be split across threads
 * without changing anything. With an executor both arrays must be in shared
 * memory.
 *
 * The row pass is not stored as a full plane: each thread keeps only the
 * 4d + 1 rows its column pass needs (see `b3Band`), computing again the few
 * rows it shares with its neighbors. The values are the same.
 */
export function smoothB3(from: Float32Array, w: number, h: number, d: number, a: Float32Array): void {
  const e = executorFor(w * h)
  if (!e) {
    b3Band(from, a, w, h, d, 0, h)
    return
  }
  e.run({ type: 'b3', from, a, w, h, d })
}

/**
 * Reduces `from` (width `w`) by `factor` per side into `a` (`wr` by `hr`),
 * averaging each block. Each reduced row is independent. With an executor
 * both arrays must be in shared memory.
 */
export function reducePlane(
  from: Float32Array,
  a: Float32Array,
  w: number,
  wr: number,
  hr: number,
  factor: number
): void {
  const e = executorFor(w * hr * factor)
  if (!e) {
    reduceRows(from, a, w, wr, 0, hr, factor)
    return
  }
  e.run({ type: 'downscale', from, a, w, wr, hr, factor })
}

/**
 * The part of a task that belongs to participant `index` out of
 * `participants`. `barrier` returns when all participants have reached it:
 * it separates the passes, because each pass reads the complete result of the
 * previous one, and closes the task.
 */
export function runPart(
  task: ParallelTask,
  index: number,
  participants: number,
  barrier: () => void
): void {
  const slice = (length: number): [number, number] => [
    Math.floor((length * index) / participants),
    Math.floor((length * (index + 1)) / participants)
  ]
  switch (task.type) {
    case 'blur': {
      const { data, scratch, w, h, r } = task
      const [y0, y1] = slice(h)
      const [x0, x1] = slice(w)
      for (let pass = 0; pass < 3; pass++) {
        rowMeans(data, scratch, w, y0, y1, r)
        barrier()
        columnMeans(scratch, data, w, h, x0, x1, r)
        barrier()
      }
      return
    }
    case 'b3': {
      const { from, a, w, h, d } = task
      const [y0, y1] = slice(h)
      b3Band(from, a, w, h, d, y0, y1)
      barrier()
      return
    }
    case 'downscale': {
      const [y0, y1] = slice(task.hr)
      reduceRows(task.from, task.a, task.w, task.wr, y0, y1, task.factor)
      barrier()
      return
    }
  }
}

/**
 * Moving average along the rows from `y0` to `y1` (exclusive). The borders,
 * where indices must be clamped, are handled separately: the central stretch
 * needs no checks. The indices read and the order of the sums are the same
 * in all stretches.
 */
function rowMeans(from: Float32Array, a: Float32Array, w: number, y0: number, y1: number, r: number): void {
  const den = 2 * r + 1
  // Central stretch: x - r >= 0 and x + r + 1 <= w - 1.
  const start = Math.min(w, r)
  const end = Math.max(start, w - r - 1)
  for (let y = y0; y < y1; y++) {
    const o = y * w
    let sum = 0
    for (let x = -r; x <= r; x++) sum += from[o + Math.min(w - 1, Math.max(0, x))]
    let x = 0
    for (; x < start; x++) {
      a[o + x] = sum / den
      sum += from[o + Math.min(w - 1, x + r + 1)] - from[o + Math.max(0, x - r)]
    }
    for (; x < end; x++) {
      a[o + x] = sum / den
      sum += from[o + x + r + 1] - from[o + x - r]
    }
    for (; x < w; x++) {
      a[o + x] = sum / den
      sum += from[o + Math.min(w - 1, x + r + 1)] - from[o + Math.max(0, x - r)]
    }
  }
}

/**
 * Moving average along the columns from `x0` to `x1` (exclusive). The column
 * sums advance together, one row at a time: memory is read in order instead
 * of jumping a whole row at every step, which is several times faster. The
 * sums stay in double precision.
 */
function columnMeans(
  from: Float32Array,
  a: Float32Array,
  w: number,
  h: number,
  x0: number,
  x1: number,
  r: number
): void {
  const width = x1 - x0
  if (width <= 0) return
  const sums = new Float64Array(width)
  const den = 2 * r + 1
  for (let y = -r; y <= r; y++) {
    const o = Math.min(h - 1, Math.max(0, y)) * w + x0
    for (let x = 0; x < width; x++) sums[x] += from[o + x]
  }
  for (let y = 0; y < h; y++) {
    const o = y * w + x0
    const more = Math.min(h - 1, y + r + 1) * w + x0
    const minus = Math.max(0, y - r) * w + x0
    for (let x = 0; x < width; x++) {
      a[o + x] = sums[x] / den
      sums[x] += from[more + x] - from[minus + x]
    }
  }
}

/** B3 spline kernel: 1, 4, 6, 4, 1 sixteenths. */
const B3_0 = 1 / 16
const B3_1 = 4 / 16
const B3_2 = 6 / 16

/** Index reflected at the borders (mirror, without repeating the edge pixel). */
function reflect(i: number, n: number): number {
  if (n === 1) return 0
  const period = 2 * n - 2
  let k = i % period
  if (k < 0) k += period
  return k < n ? k : period - k
}

/** Row pass of row `y`, written into `tmp` from position `t`. */
function b3Row(from: Float32Array, tmp: Float32Array, t: number, w: number, y: number, d: number): void {
  const o = y * w
  for (let x = 0; x < w; x++) {
    if (x >= 2 * d && x < w - 2 * d) {
      const i = o + x
      tmp[t + x] = B3_0 * (from[i - 2 * d] + from[i + 2 * d]) + B3_1 * (from[i - d] + from[i + d]) + B3_2 * from[i]
    } else {
      tmp[t + x] =
        B3_0 * (from[o + reflect(x - 2 * d, w)] + from[o + reflect(x + 2 * d, w)]) +
        B3_1 * (from[o + reflect(x - d, w)] + from[o + reflect(x + d, w)]) +
        B3_2 * from[o + x]
    }
  }
}

/**
 * Both passes for the output rows from `y0` to `y1` (excluded). The column
 * pass of row y reads the row pass at rows y ± d and y ± 2d, reflected at
 * the edges, all within 2d of y: the row pass is computed in order, just
 * before it is needed, into a ring of 4d + 1 rows (row r in slot r mod
 * 4d + 1). The column pass scans by rows to read memory in order.
 */
function b3Band(from: Float32Array, a: Float32Array, w: number, h: number, d: number, y0: number, y1: number): void {
  if (y0 >= y1) return
  const depth = 4 * d + 1
  const ring = ringOf(depth * w)
  let ready = Math.max(0, y0 - 2 * d)
  for (let y = y0; y < y1; y++) {
    const last = Math.min(h - 1, y + 2 * d)
    for (; ready <= last; ready++) b3Row(from, ring, (ready % depth) * w, w, ready, d)
    const o = y * w
    const am2 = (reflect(y - 2 * d, h) % depth) * w
    const am1 = (reflect(y - d, h) % depth) * w
    const ac = (y % depth) * w
    const ap1 = (reflect(y + d, h) % depth) * w
    const ap2 = (reflect(y + 2 * d, h) % depth) * w
    for (let x = 0; x < w; x++) {
      a[o + x] = B3_0 * (ring[am2 + x] + ring[ap2 + x]) + B3_1 * (ring[am1 + x] + ring[ap1 + x]) + B3_2 * ring[ac + x]
    }
  }
}

/** Ring of `b3Band`, kept for the next task of this thread. */
let b3Ring: Float32Array | null = null

function ringOf(length: number): Float32Array {
  if (b3Ring === null || b3Ring.length < length) b3Ring = new Float32Array(length)
  return b3Ring
}

/**
 * The sums of a reduced row advance together, one full row at a time: memory
 * is read in order. Each sum receives the pixels row by row, from the left,
 * always in the same order.
 */
function reduceRows(
  p: Float32Array,
  reduced: Float32Array,
  w: number,
  wr: number,
  y0: number,
  y1: number,
  factor: number
): void {
  const area = 1 / (factor * factor)
  const sums = new Float64Array(wr)
  for (let y = y0; y < y1; y++) {
    sums.fill(0)
    for (let dy = 0; dy < factor; dy++) {
      const o = (y * factor + dy) * w
      for (let x = 0; x < wr; x++) {
        const q = o + x * factor
        let sum = sums[x]
        for (let dx = 0; dx < factor; dx++) sum += p[q + dx]
        sums[x] = sum
      }
    }
    const r = y * wr
    for (let x = 0; x < wr; x++) reduced[r + x] = sums[x] * area
  }
}
