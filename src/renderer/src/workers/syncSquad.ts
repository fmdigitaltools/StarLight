import { runPart, type ParallelTask, type ParallelExecutor } from '@core/image/parallel'
import type { HelperMessage } from './helper.worker'
import { barrier, reportError } from './barrier'

/**
 * Squad of helpers for the synchronous engine.
 *
 * The chain worker runs the tools from start to finish without
 * interruption: their code is synchronous and cannot wait for messages. To
 * split the blurs across several threads (see `core/image/parallel.ts`)
 * it keeps a squad of helpers ready, working on the same data in shared
 * memory. For each task it tells every helper to start, runs its own
 * share, and waits for everyone to finish with `Atomics.wait`, which in
 * workers (not in the UI thread) is allowed to block the thread.
 *
 * The control vector, in shared memory, contains:
 * [0] how many participants have reached the barrier,
 * [1] barrier generation (increases at every crossing),
 * [2] nonzero if a participant had an error.
 */

/** Time allowed for the helpers to start; beyond it, work runs on a single thread. */
const MAX_STARTUP_MS = 15000

export interface SyncWorkerPool {
  executor: ParallelExecutor
  close: () => void
}

/**
 * Starts `helpers` workers and returns the executor to register with the
 * engine; null if shared memory is missing or the helpers fail to start
 * (the engine then works on a single thread, with the same result).
 */
export async function createSyncSquad(helpers: number): Promise<SyncWorkerPool | null> {
  if (helpers < 1 || typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return null
  const control = new Int32Array(new SharedArrayBuffer(3 * 4))
  const participants = helpers + 1
  const workerPool: Worker[] = []
  const close = (): void => {
    for (const l of workerPool) l.terminate()
  }
  try {
    for (let i = 0; i < helpers; i++) {
      workerPool.push(
        new Worker(new URL('./helper.worker.ts', import.meta.url), {
          type: 'module',
          name: 'helper-' + (i + 1)
        })
      )
    }
    const ready = Promise.all(
      workerPool.map(
        (l, i) =>
          new Promise<void>((solve, reject) => {
            l.onmessage = (): void => solve()
            l.onerror = (e): void => reject(new Error(e.message))
            const startup: HelperMessage = { type: 'start', control, index: i + 1, participants }
            l.postMessage(startup)
          })
      )
    )
    let expired: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<never>((_, reject) => {
      expired = setTimeout(() => reject(new Error('startup too slow')), MAX_STARTUP_MS)
    })
    try {
      await Promise.race([ready, limit])
    } finally {
      clearTimeout(expired)
    }
  } catch {
    close()
    return null
  }
  // From here on, the helpers report errors only through the control vector.
  for (const l of workerPool) {
    l.onmessage = null
    l.onerror = (): void => reportError(control)
  }
  const executor: ParallelExecutor = {
    participants,
    run(task: ParallelTask): void {
      const message: HelperMessage = { type: 'task', task }
      for (const l of workerPool) l.postMessage(message)
      try {
        runPart(task, 0, participants, () => barrier(control, participants))
      } catch (error) {
        reportError(control)
        throw error
      }
    }
  }
  return { executor, close }
}
