import type { LoadedFrame } from '@shared/types'
import { compactPlanes, estimateStacking, type EstimateResult, type FrameToEstimate } from '@core/memoryEstimate'
import { hasRawExtension } from '@core/raw/rawFormats'
import { useApp } from '../store/appStore'
import { frameCache } from './useLibrary'
import { stackingWorkerPool } from '../workers/pool'
import { conditionsOf, possibleMastersToLoad } from '../calibration/library'

/**
 * Memory estimate for a stacking run, on the renderer side: this module
 * gathers the measurements (free memory, recently opened frames, library
 * masters) and passes them to the rule in core/memoryEstimate.ts.
 */

/** Channels of a frame after color reconstruction: raw files from color sensors have three. */
function rebuiltChannels(f: LoadedFrame): 1 | 3 {
  return f.channels === 3 || f.metadata.bayer !== 'NONE' || hasRawExtension(f.fileName) ? 3 : 1
}

/** A library frame as the estimate sees it, without decoding it. */
function toEstimate(f: LoadedFrame): FrameToEstimate {
  const raw = hasRawExtension(f.fileName)
  return {
    width: f.width,
    height: f.height,
    channels: rebuiltChannels(f),
    fileBytes: f.sizeBytes,
    raw,
    compactValue: compactPlanes({
      bitpix: f.bitpix,
      fileChannels: f.channels,
      bayer: f.metadata.bayer,
      raw,
      bscale: f.header.cards['BSCALE'],
      bzero: f.header.cards['BZERO']
    })
  }
}

/**
 * How many analysis workers to use for these frames, or null if free memory
 * cannot be read (in which case stacking proceeds as usual).
 *
 * @param sums frame-sized images held at the same time by the sum
 * (see `EstimateRequest.sums`)
 * @param expanded true if the sum will fully rebuild compact frames
 * (see `EstimateRequest.expanded`)
 */
export async function estimateStackingMemory(
  frame: LoadedFrame[],
  workers: number,
  sums: number,
  expanded = false
): Promise<EstimateResult | null> {
  let free: number
  try {
    free = Number((await window.starlight.systemInfo()).freeRam)
  } catch {
    return null
  }
  if (!Number.isFinite(free) || free <= 0) return null

  const state = useApp.getState()
  // Recently opened frames can be released, except the one shown in the
  // viewer, which stays in memory anyway.
  const shown = state.image?.data.byteLength ?? 0
  const recoverable = Math.max(0, frameCache.usage - shown)

  // Library masters the analysis might load: for each set of light-frame
  // conditions, those the session does not have with matching conditions.
  // With several light groups there can be more than one per type. Masters
  // built in the session are already in memory, and the measured free
  // memory already accounts for them.
  let mastersToLoad = 0
  if (state.withCalibration) {
    try {
      mastersToLoad = await possibleMastersToLoad(
        frame.map((f) => conditionsOf(f.metadata, f.width, f.height, rebuiltChannels(f))),
        state.master.groups.map((g) => g.entry)
      )
    } catch {
      // An unreadable library will not be used during the analysis either.
    }
  }

  return estimateStacking({
    frame: frame.map(toEstimate),
    workers,
    workersSum: stackingWorkerPool().size,
    expanded,
    mastersToLoad,
    sums,
    freeMemory: free,
    recoverableMemory: recoverable
  })
}
