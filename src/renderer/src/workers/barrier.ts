import { t } from '@shared/i18n/i18n'

/**
 * Barrier between the threads of the synchronous squad (see syncSquad.ts),
 * in a file of its own because both the chain worker and the helpers use it.
 *
 * The control vector, in shared memory, contains:
 * [0] how many participants have reached the barrier,
 * [1] barrier generation (increases at every crossing),
 * [2] nonzero if a participant had an error.
 */

/** Beyond this time a barrier is considered stuck: an error is better than an endless wait. */
const MAX_WAIT_MS = 120000

/**
 * Waits until all participants arrive here. The last one to arrive
 * advances the generation and wakes the others.
 */
export function barrier(control: Int32Array, participants: number): void {
  const generation = Atomics.load(control, 1)
  if (Atomics.add(control, 0, 1) === participants - 1) {
    Atomics.store(control, 0, 0)
    Atomics.add(control, 1, 1)
    Atomics.notify(control, 1)
    return
  }
  while (Atomics.load(control, 1) === generation) {
    if (Atomics.load(control, 2) !== 0) throw new Error(t('workersBarrier.threadStopped'))
    if (Atomics.wait(control, 1, generation, MAX_WAIT_MS) === 'timed-out') {
      throw new Error(t('workersBarrier.threadNotResponding'))
    }
  }
}

/** Signals an error to everyone, so that nobody keeps waiting at the barrier. */
export function reportError(control: Int32Array): void {
  Atomics.store(control, 2, 1)
  Atomics.notify(control, 1)
}

