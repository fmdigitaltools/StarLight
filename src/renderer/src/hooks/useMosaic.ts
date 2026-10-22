import { create } from 'zustand'
import type { LoadedFrame } from '@shared/types'
import {
  mosaicGeometry,
  mosaicMemory,
  type PanelCorrection,
  type PanelDescription,
  type MosaicGeometry
} from '@core/stack/mosaic'
import { autoStretch } from '@core/image/stretch'
import { formatBytes } from '@core/memory'
import { useApp } from '../store/appStore'
import { originalFrame, showResult } from './temporaryResult'
import type { MosaicRequest, MosaicResponse } from '../workers/mosaic.worker'
import { t, formatNumber } from '@shared/i18n/i18n'

/**
 * Mosaic from the Stack panel: choosing the panels among the library frames,
 * previewing the layout and composing it in a worker. The state lives
 * outside the panel, so the selection is kept when changing step.
 */

/** Outcome of the last mosaic, for the summary. */
export interface MosaicResult {
  width: number
  height: number
  scale: number
  panels: string[]
  coveredFraction: number
  overlapFraction: number
  corrections: PanelCorrection[]
  /** Names of the panels that do not touch any other. */
  isolated: string[]
  /** Pairs whose gain could not be measured (sky background only). */
  pairsWithoutGain: number
  thumbnail: { data: Uint8Array; width: number; height: number }
  timeSeconds: number
}

interface MosaicState {
  /** IDs of the frames chosen as panels. */
  chosenItems: string[]
  blend: boolean
  inProgress: boolean
  result: MosaicResult | null
}

export const useMosaic = create<MosaicState>(() => ({
  chosenItems: [],
  blend: true,
  inProgress: false,
  result: null
}))

export function togglePanel(id: string): void {
  useMosaic.setState((s) => ({
    chosenItems: s.chosenItems.includes(id) ? s.chosenItems.filter((x) => x !== id) : [...s.chosenItems, id]
  }))
}

export function setBlend(v: boolean): void {
  useMosaic.setState({ blend: v })
}

/** Frames that can serve as panels: everything except calibration frames. */
export function mosaicCandidates(frame: LoadedFrame[]): LoadedFrame[] {
  return frame
    .map(originalFrame)
    .filter(
      (f) =>
        f.metadata.frameType !== 'dark' && f.metadata.frameType !== 'flat' && f.metadata.frameType !== 'bias'
    )
}

/** What the current selection allows. */
export interface Choice {
  /** Chosen panels with an astrometric solution, in library order. */
  validItems: LoadedFrame[]
  /** Chosen panels without a solution: they must be plate solved first. */
  withoutWcs: LoadedFrame[]
  geometry: MosaicGeometry | null
  /** Why the mosaic cannot be made, if it cannot. */
  problem: string | null
  /** Estimated memory for the computation, in bytes. */
  memory: number
}

function description(f: LoadedFrame): PanelDescription | null {
  const wcs = f.metadata.wcs
  if (wcs === null || f.width <= 0 || f.height <= 0) return null
  return { width: f.width, height: f.height, wcs }
}

/** Analyzes the selection: geometry, memory, any problems. Fast. */
export function evaluateChoice(frame: LoadedFrame[], chosenItems: string[]): Choice {
  const candidates = mosaicCandidates(frame).filter((f) => chosenItems.includes(f.id))
  const validItems = candidates.filter((f) => description(f) !== null)
  const withoutWcs = candidates.filter((f) => description(f) === null)
  let geometry: MosaicGeometry | null = null
  let problem: string | null = null
  let memory = 0
  if (validItems.length < 2) {
    problem =
      withoutWcs.length > 0
        ? t('hooksUseMosaic.needTwoSolved')
        : t('hooksUseMosaic.needTwo')
  } else {
    try {
      const descriptions = validItems.map((f) => description(f) as PanelDescription)
      geometry = mosaicGeometry(descriptions)
      const channels = validItems.some((f) => f.channels === 3 || f.metadata.bayer !== 'NONE') ? 3 : 1
      const fileBytes = validItems.reduce((s, f) => s + f.sizeBytes, 0)
      memory = mosaicMemory(geometry, descriptions, channels, fileBytes)
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e)
    }
  }
  return { validItems, withoutWcs, geometry, problem, memory }
}

/** Last worker started, to terminate on restart. */
let worker: Worker | null = null

/** Composes the mosaic from the chosen panels and opens it in the viewer. */
export async function composeChosenMosaic(): Promise<void> {
  const app = useApp.getState()
  if (app.job.active || useMosaic.getState().inProgress) {
    app.notify('warning', t('hooksUseMosaic.busy'))
    return
  }
  const { chosenItems, blend } = useMosaic.getState()
  const choice = evaluateChoice(app.frame, chosenItems)
  if (choice.problem !== null || choice.geometry === null) {
    app.notify('warning', choice.problem ?? t('hooksUseMosaic.cannotCompose'))
    return
  }

  // Memory: as for drizzle, a quarter of the free memory is left to the
  // system and the rest of the application.
  try {
    const info = await window.starlight.systemInfo()
    const free = Number(info.freeRam)
    if (Number.isFinite(free) && free > 0 && choice.memory > free * 0.75) {
      app.notify(
        'warning',
        t('hooksUseMosaic.notEnoughMemory', { needed: formatBytes(choice.memory), free: formatBytes(free) })
      )
      return
    }
  } catch {
    // Without memory information, try anyway.
  }

  const panels = choice.validItems
  const start = performance.now()
  useMosaic.setState({ inProgress: true })
  try {
    const request: MosaicRequest = { panels: [], blend }
    for (let k = 0; k < panels.length; k++) {
      const f = panels[k]
      app.setJob(
        t('hooksUseMosaic.job.readingPanel', { index: k + 1, total: panels.length }),
        (k / panels.length) * 0.1
      )
      request.panels.push({
        buffer: await window.starlight.readFile(f.path),
        fileName: f.fileName,
        wcs: f.metadata.wcs as NonNullable<typeof f.metadata.wcs>,
        width: f.width,
        height: f.height
      })
    }

    worker?.terminate()
    const w = new Worker(new URL('../workers/mosaic.worker.ts', import.meta.url), {
      type: 'module',
      name: 'mosaic'
    })
    worker = w
    const response = await new Promise<Extract<MosaicResponse, { type: 'done' }>>((solve, reject) => {
      w.onmessage = (e: MessageEvent<MosaicResponse>): void => {
        const m = e.data
        if (m.type === 'progress') {
          useApp
            .getState()
            .setJob(t('hooksUseMosaic.job.progress', { label: m.label.toLowerCase() }), 0.1 + m.fraction * 0.88)
        } else if (m.type === 'error') {
          reject(new Error(m.message))
        } else {
          solve(m)
        }
      }
      w.onerror = (e): void => reject(new Error(e.message || t('hooksUseMosaic.interrupted')))
      w.postMessage(
        request,
        request.panels.map((p) => p.buffer)
      )
    })

    const image = {
      width: response.width,
      height: response.height,
      channels: response.channels,
      data: response.data
    }
    // The mosaic is shown in place of the panel whose scale and orientation
    // it took, with its own astrometric solution.
    const base = panels[choice.geometry.reference]
    showResult(base.id, image, () => ({
      wcs: response.wcs,
      pixelScale: response.scale,
      others: { ra: response.wcs.crval[0], dec: response.wcs.crval[1] },
      type: 'mosaic',
      panels: panels.map((f) => f.path)
    }))
    useApp.getState().updateAdjustments({ stretch: autoStretch(image) })

    const pairsWithoutGain = response.overlaps.filter((s) => s.measuredGain.some((m) => !m)).length
    useMosaic.setState({
      result: {
        width: response.width,
        height: response.height,
        scale: response.scale,
        panels: panels.map((f) => f.fileName),
        coveredFraction: response.coveredFraction,
        overlapFraction: response.overlapFraction,
        corrections: response.corrections,
        isolated: response.isolated.map((k) => panels[k].fileName),
        pairsWithoutGain: blend ? pairsWithoutGain : 0,
        thumbnail: response.thumbnail,
        timeSeconds: (performance.now() - start) / 1000
      }
    })

    const state = useApp.getState()
    state.finishJob()
    state.notify(
      'ok',
      t('hooksUseMosaic.done', {
        count: panels.length,
        width: formatNumber(response.width),
        height: formatNumber(response.height)
      })
    )
    if (response.isolated.length > 0) {
      state.notify(
        'warning',
        t('hooksUseMosaic.isolated', { panels: response.isolated.map((k) => panels[k].fileName).join(', ') })
      )
    }
  } catch (e) {
    const state = useApp.getState()
    state.finishJob()
    state.notify('error', t('hooksUseMosaic.failed', { message: e instanceof Error ? e.message : String(e) }))
  } finally {
    worker?.terminate()
    worker = null
    useMosaic.setState({ inProgress: false })
  }
}
