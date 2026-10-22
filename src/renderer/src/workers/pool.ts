import { readSettings, subscribeSettings } from '../settings'
import type { AlignmentRequest, AlignmentResponse } from './alignment.worker'
import type { AnalysisRequest, AnalysisResponse } from './analysis.worker'
import type { BandRequest, BandResponse } from './stacking.worker'
import type { HeaderRequest, HeaderResponse } from './headers.worker'

/**
 * Worker pools.
 *
 * A pool distributes identical tasks across several threads and assigns a
 * new one as soon as a worker becomes free, so slow tasks do not hold up
 * the others. There are three: one analyzes freshly read frames, one
 * aligns them to the reference, and the last computes the stacking bands.
 */

interface Task<Req, Res> {
  request: Req
  solve: (response: Res) => void
  reject: (error: Error) => void
}

class WorkerPool<Req, Res> {
  private workers: Worker[] = []
  private free: Worker[] = []
  private tail: Task<Req, Res>[] = []
  private inProgress = new Map<Worker, Task<Req, Res>>()
  /** Memory held by each worker, if it reports it in its responses. */
  private held = new Map<Worker, number>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  /** How many workers the pool should have (may change from the settings). */
  private wantedItems: number
  /** Counts the workers created, to give them distinct names. */
  private createdItems = 0

  /**
   * @param count number of workers to start
   * @param create builds the worker with the given index
   * @param toTransfer what to hand over to the worker without copying it
   * @param memoryOf memory the worker reports holding after a task (for
   * example LibRaw's after a RAW file): workers holding a lot of it are
   * replaced by new ones when the pool is idle, so that memory goes back
   * to the system.
   */
  constructor(
    count: number,
    private create: (index: number) => Worker,
    private toTransfer?: (request: Req) => Transferable[],
    private memoryOf?: (response: Res) => number
  ) {
    this.wantedItems = Math.max(1, count)
    this.adjust()
  }

  private add(): void {
    const worker = this.create(this.createdItems++)
    worker.onmessage = (event: MessageEvent<Res>) => {
      const task = this.inProgress.get(worker)
      this.inProgress.delete(worker)
      this.free.push(worker)
      if (this.memoryOf) this.held.set(worker, this.memoryOf(event.data))
      task?.solve(event.data)
      this.adjust()
      this.start()
    }
    worker.onerror = (event) => {
      const task = this.inProgress.get(worker)
      this.inProgress.delete(worker)
      this.free.push(worker)
      task?.reject(new Error(event.message))
      this.adjust()
      this.start()
    }
    this.workers.push(worker)
    this.free.push(worker)
  }

  /**
   * Brings the pool to the wanted size. Surplus workers are closed only
   * when they are free: a task already started is never interrupted.
   * Missing ones are created only when there is work to give (see
   * `start`): an idle worker still holds some memory.
   */
  private adjust(): void {
    while (this.workers.length > this.wantedItems && this.free.length > 0) {
      const surplus = this.free.pop() as Worker
      surplus.terminate()
      this.held.delete(surplus)
      this.workers = this.workers.filter((l) => l !== surplus)
    }
  }

  /**
   * Immediately closes all idle workers; new ones are created on the next
   * request. A worker that has just analyzed a frame still holds, until it
   * cleans up its memory, the intermediate data of that frame (tens of
   * bytes per pixel: over a gigabyte with a 61-megapixel sensor) and the
   * references to the shared-memory frames it touched. Closing it returns
   * everything to the system before the phases that need it; creating a
   * new one costs a few milliseconds.
   */
  dismiss(): void {
    for (const l of [...this.free]) {
      l.terminate()
      this.held.delete(l)
    }
    const closedItems = new Set(this.free)
    this.workers = this.workers.filter((l) => !closedItems.has(l))
    this.free = []
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * Replaces idle workers that hold a lot of memory. WebAssembly memory
   * grows up to the largest file decoded and never shrinks: a worker that
   * has read a 60-megapixel RAW file keeps more than 200 MB even when the
   * work is done, and a pool of twelve over 2 GB. A new worker costs a few
   * milliseconds.
   */
  private rest(): void {
    this.idleTimer = null
    if (this.tail.length > 0 || this.inProgress.size > 0) return
    for (const l of [...this.free]) {
      if ((this.held.get(l) ?? 0) < MEMORY_TO_RELEASE) continue
      l.terminate()
      this.held.delete(l)
      this.free = this.free.filter((x) => x !== l)
      this.workers = this.workers.filter((x) => x !== l)
    }
    this.adjust()
  }

  /** Schedules the replacement of heavy workers when the pool is idle. */
  private scheduleIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.memoryOf || this.tail.length > 0 || this.inProgress.size > 0) return
    this.idleTimer = setTimeout(() => this.rest(), TEAM_REST_MS)
  }

  /** Changes the number of workers without stopping the tasks in progress. */
  resize(count: number): void {
    this.wantedItems = Math.max(1, count)
    this.adjust()
    this.start()
  }

  /**
   * Number of workers in the pool: those that work when there is enough to
   * do (they are created on the first request).
   */
  get size(): number {
    return this.wantedItems
  }

  /** Queues a task. */
  run(request: Req): Promise<Res> {
    return new Promise((solve, reject) => {
      this.tail.push({ request, solve, reject })
      this.start()
    })
  }

  private start(): void {
    // A new worker is created only if all existing ones already have a
    // task, and never beyond the wanted number.
    while (this.tail.length > this.free.length && this.workers.length < this.wantedItems) this.add()
    while (this.free.length > 0 && this.tail.length > 0) {
      const worker = this.free.pop() as Worker
      const task = this.tail.shift() as Task<Req, Res>
      this.inProgress.set(worker, task)
      const transferred = this.toTransfer ? this.toTransfer(task.request) : []
      worker.postMessage(task.request, transferred)
    }
    this.scheduleIdle()
  }

  /** Closes all workers. */
  close(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.held.clear()
    for (const worker of this.workers) worker.terminate()
    this.workers = []
    this.free = []
    this.inProgress.clear()
    this.tail = []
  }
}

/** Held memory beyond which an idle worker is replaced. */
const MEMORY_TO_RELEASE = 64 * 1048576
/** Milliseconds of idle pool before heavy workers are replaced. */
const TEAM_REST_MS = 15000

/**
 * Cap on workers for short, numerous compute tasks (analysis and
 * alignment). Measured: twelve is the knee of the curve; beyond it there
 * is no gain, and at twenty-four 9% is lost. The cause is not the disk,
 * which weighs 2% even with a cold cache: on processors with mixed cores
 * the Windows scheduler puts the extra workers on the slow cores, which
 * finish last and hold up the whole batch. Pinning the process to the
 * fast cores only makes analysis 30% faster, but JavaScript does not
 * allow choosing the cores.
 */
const MIXED_CORES_CAP = 12

/** How many cores the system reports as available. */
export function cores(): number {
  return navigator.hardwareConcurrency || 4
}

/** Workers chosen automatically for analysis and alignment. */
export function automaticWorkers(): number {
  return Math.max(1, Math.min(MIXED_CORES_CAP, cores() - 2))
}

/**
 * Workers for analysis and alignment: the number chosen in the settings
 * (at most one per core), otherwise the automatic value.
 */
function shortWorkers(): number {
  const chosenItems = readSettings().analysisWorkers
  return chosenItems > 0 ? Math.min(chosenItems, cores()) : automaticWorkers()
}

export class AnalysisWorkerPool extends WorkerPool<AnalysisRequest, AnalysisResponse> {
  /**
   * @param count number of workers; if omitted it is derived from the
   * available cores, leaving two free.
   */
  constructor(count?: number) {
    super(
      count ?? shortWorkers(),
      (i) =>
        new Worker(new URL('./analysis.worker.ts', import.meta.url), {
          type: 'module',
          name: 'analysis-' + (i + 1)
        }),
      // The file content is handed to the worker without copying it.
      (request) => [request.buffer],
      (response) => response.rawMemory ?? 0
    )
  }

  /** Queues a frame to analyze. */
  analyze(request: AnalysisRequest): Promise<AnalysisResponse> {
    return this.run(request)
  }
}

export class AlignmentWorkerPool extends WorkerPool<AlignmentRequest, AlignmentResponse> {
  constructor(count?: number) {
    // Each frame takes a few tens of milliseconds of pure computation and
    // a few bytes of stars: the same cap as analysis applies.
    super(count ?? shortWorkers(), (i) =>
      new Worker(new URL('./alignment.worker.ts', import.meta.url), {
        type: 'module',
        name: 'alignment-' + (i + 1)
      })
    )
  }

  /** Queues a frame to align to the reference. */
  align(request: AlignmentRequest): Promise<AlignmentResponse> {
    return this.run(request)
  }
}

export class StackingWorkerPool extends WorkerPool<BandRequest, BandResponse> {
  constructor(count?: number) {
    // Stacking is pure computation on shared memory, split into a few
    // large bands: it pays to use almost all the cores. The cap prevents
    // the bands from becoming so thin on very large machines that worker
    // startup outweighs the computation itself.
    super(count ?? Math.max(1, Math.min(16, cores() - 2)), (i) =>
      new Worker(new URL('./stacking.worker.ts', import.meta.url), {
        type: 'module',
        name: 'stacking-' + (i + 1)
      })
    )
  }

  /** Queues a band of rows to compute. */
  band(request: BandRequest): Promise<BandResponse> {
    return this.run(request)
  }
}

/**
 * Workers that read the shooting metadata of RAW files during an import.
 * Measured on 29 RAW files from 16 to 117 MB (1.1 GB): one at a time
 * 1.3-1.7 s, with two 1.0 s, with three 0.87 s, with four 0.82 s. Almost
 * all the time goes into bringing the file from disk to the window; three
 * workers are enough to keep that step busy. Each worker holds one file in
 * memory at a time.
 */
export const HEADER_READ_WORKERS = 3

export class HeaderWorkerPool extends WorkerPool<HeaderRequest, HeaderResponse> {
  constructor(count = HEADER_READ_WORKERS) {
    super(
      count,
      (i) =>
        new Worker(new URL('./headers.worker.ts', import.meta.url), {
          type: 'module',
          name: 'headers-' + (i + 1)
        }),
      (request) => [request.buffer]
    )
  }

  /** Queues a RAW file whose shooting metadata is to be read. */
  read(request: HeaderRequest): Promise<HeaderResponse> {
    return this.run(request)
  }
}

/** Shared pools, created on the first request. */
let analysis: AnalysisWorkerPool | null = null
let alignment: AlignmentWorkerPool | null = null
let stacking: StackingWorkerPool | null = null

export function analysisWorkerPool(): AnalysisWorkerPool {
  if (!analysis) analysis = new AnalysisWorkerPool()
  return analysis
}

export function alignmentWorkerPool(): AlignmentWorkerPool {
  if (!alignment) alignment = new AlignmentWorkerPool()
  return alignment
}

export function stackingWorkerPool(): StackingWorkerPool {
  if (!stacking) stacking = new StackingWorkerPool()
  return stacking
}

/*
 * If the number of workers changes in the settings, the pools already
 * created adjust immediately, without interrupting the tasks in progress.
 */
subscribeSettings(() => {
  const count = shortWorkers()
  analysis?.resize(count)
  alignment?.resize(count)
})
