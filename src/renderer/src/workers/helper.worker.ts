/// <reference lib="webworker" />

import './followLanguage'
import { runPart, type ParallelTask } from '@core/image/parallel'
import { barrier, reportError } from './barrier'

/**
 * Helper of the processing chain worker: runs its share of each task on
 * the data in shared memory (see `syncSquad.ts`).
 */

export type HelperMessage =
  | { type: 'start'; control: Int32Array; index: number; participants: number }
  | { type: 'task'; task: ParallelTask }

let control: Int32Array | null = null
let index = 0
let participants = 1

self.onmessage = (event: MessageEvent<HelperMessage>): void => {
  const m = event.data
  if (m.type === 'start') {
    control = m.control
    index = m.index
    participants = m.participants
    self.postMessage('ready')
    return
  }
  const c = control
  if (!c) return
  try {
    runPart(m.task, index, participants, () => barrier(c, participants))
  } catch {
    reportError(c)
  }
}
