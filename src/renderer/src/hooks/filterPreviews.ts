import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImageData32 } from '@shared/types'
import { useApp } from '../store/appStore'
import { useDisplayedAstrometry } from './displayedAstrometry'
import { imageSkyBackground } from '@core/image/skyBackground'
import { FILTERS, effectiveFilter } from '@core/image/photoFilters'
import type { CorrectionParams } from '@core/export/processing'
import { prepareCrop, chooseSquare } from '@core/image/filterPreviews'
import type { FilterPreviewsRequest, FilterPreviewsResponse } from '../workers/filterPreviews.worker'

/**
 * Thumbnails of the filter grid, computed on the image being processed.
 *
 * The actual computation runs in a separate worker (see
 * workers/filterPreviews.worker.ts) using the export chain. This module
 * decides WHEN to recompute: after a short quiet period since the last change
 * (DELAY_MS) and never while a mouse button is pressed, i.e. while a slider
 * or a curve point is being dragged. Nothing is written to the store: neither
 * the history nor the recovery save sees these thumbnails.
 */

/** Quiet time required before recomputing, in milliseconds. */
const DELAY_MS = 250

export interface FilterPreviews {
  /** Side of the thumbnails, in pixels. */
  side: number
  /** RGBA pixels of each filter, by identifier. */
  pixel: Map<string, Uint8ClampedArray>
}

/* ---- Mouse button pressed: wait while dragging ---- */

let pressed = false
const onRelease = new Set<() => void>()
let isListening = false

function listenPointer(): void {
  if (isListening || typeof window === 'undefined') return
  isListening = true
  const release = (): void => {
    if (!pressed) return
    pressed = false
    const expected = [...onRelease]
    onRelease.clear()
    for (const f of expected) f()
  }
  window.addEventListener('pointerdown', () => (pressed = true), true)
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  window.addEventListener('blur', release)
}

/* ---- Data that depends only on the image: computed once ---- */

/**
 * Identity of the square in use. The pixels are not kept here: they are
 * copied from the image only when the worker does not have them yet (about
 * ten milliseconds) and transferred to it without a copy, so only one copy,
 * the worker's, stays in memory.
 */
interface Crop {
  key: string
  id: number
}

// Tied to the image without retaining it: once the image is closed, they go away.
const crops = new WeakMap<ImageData32, Crop>()
let cropCounter = 0

function cropFor(image: ImageData32, key: string): Crop {
  const ready = crops.get(image)
  if (ready && ready.key === key) return ready
  const newValue = { key, id: ++cropCounter }
  crops.set(image, newValue)
  return newValue
}

/** Latest result, shown immediately when returning to the Filters step. */
const latest = new WeakMap<ImageData32, { key: string; previews: FilterPreviews }>()

/** Measurements of the last computation, read by the tests (window.__filterPreviews). */
interface Measurements {
  cropMs: number
  backgroundMs: number
  workerMs: number
  totalMs: number
  squareSide: number
}

export function useFilterPreviews(): FilterPreviews | null {
  const image = useApp((s) => s.image)
  const adjustments = useApp((s) => s.adjustments)
  const curves = useApp((s) => s.curves)
  const astrometry = useDisplayedAstrometry()

  // The main subject, if object recognition has located it.
  const main = astrometry.objects.find((o) => o.position !== null) ?? null
  const center = main?.position ?? null
  const diameter =
    main && main.object.sizeArcmin && astrometry.pixelScale
      ? (main.object.sizeArcmin * 60) / astrometry.pixelScale
      : null
  const square = useMemo(
    () => (image ? chooseSquare(image.width, image.height, center, diameter) : null),
    [image, center?.x, center?.y, diameter]
  )
  const squareKey = square ? square.x0 + ',' + square.y0 + ',' + square.side : ''

  // Everything that affects the thumbnails: not the selected filter, because
  // the grid shows them all; the intensity does.
  const key = useMemo(
    () =>
      JSON.stringify([
        squareKey,
        adjustments.stretch,
        adjustments.brightness,
        adjustments.contrast,
        adjustments.saturation,
        adjustments.redGain,
        adjustments.greenGain,
        adjustments.blueGain,
        adjustments.gamma,
        adjustments.noiseReduction,
        adjustments.sharpness,
        adjustments.backgroundNeutralization,
        adjustments.preserveColor,
        adjustments.withGhs ? adjustments.ghs : null,
        curves,
        adjustments.filterIntensity,
        adjustments.vibrance,
        adjustments.vignette
      ]),
    [squareKey, adjustments, curves]
  )

  const [previews, setPreviews] = useState<FilterPreviews | null>(() =>
    (image ? latest.get(image)?.previews : null) ?? null
  )

  const worker = useRef<Worker | null>(null)
  const busy = useRef(false)
  /** Request to send as soon as the worker is free. */
  const pending = useRef<(() => void) | null>(null)
  const counter = useRef(0)
  /** Crop the current worker has already received. */
  const sent = useRef(-1)

  // The worker lives as long as the panel is open.
  useEffect(() => {
    listenPointer()
    return () => {
      worker.current?.terminate()
      worker.current = null
      busy.current = false
      pending.current = null
      sent.current = -1
    }
  }, [])

  useEffect(() => {
    if (!image || !square) {
      setPreviews(null)
      return
    }
    const last = latest.get(image)
    if (last && last.key === key) {
      setPreviews(last.previews)
      return
    }
    // With a new image the thumbnails of the previous one no longer apply;
    // with the same image they stay visible until the updated ones arrive.
    if (!last) setPreviews(null)

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const send = (): void => {
      if (cancelled) return
      if (busy.current) {
        pending.current = send
        return
      }
      const start = performance.now()
      const crop = cropFor(image, squareKey)
      const data = crop.id !== sent.current ? prepareCrop(image, square) : undefined
      const afterCrop = performance.now()
      const background = imageSkyBackground(image)
      const afterBackground = performance.now()
      const r = adjustments
      const corrections: Omit<CorrectionParams, 'filter'> = {
        stretch: r.stretch,
        brightness: r.brightness,
        contrast: r.contrast,
        saturation: r.saturation,
        redGain: r.redGain,
        greenGain: r.greenGain,
        blueGain: r.blueGain,
        gamma: r.gamma,
        noiseReduction: r.noiseReduction,
        sharpness: r.sharpness,
        backgroundNeutralization: r.backgroundNeutralization,
        skyBackground: background,
        preserveColor: r.preserveColor,
        ghs: r.withGhs ? r.ghs : undefined,
        curves
      }
      const request: FilterPreviewsRequest = {
        id: ++counter.current,
        cropId: crop.id,
        crop: data,
        corrections,
        correctionsKey: JSON.stringify([crop.id, corrections]),
        filters: FILTERS.map((f) => ({
          id: f.id,
          filter: effectiveFilter(f.id, r.filterIntensity, r.vibrance, r.vignette)
        }))
      }

      if (!worker.current) {
        worker.current = new Worker(new URL('../workers/filterPreviews.worker.ts', import.meta.url), {
          type: 'module',
          name: 'filter-previews'
        })
      }
      const w = worker.current
      busy.current = true
      sent.current = crop.id
      w.onmessage = (e: MessageEvent<FilterPreviewsResponse>): void => {
        busy.current = false
        const response = e.data
        if (response.result === 'ok' && response.thumbnails && response.side) {
          const pixel = new Map<string, Uint8ClampedArray>()
          for (const m of response.thumbnails) pixel.set(m.id, new Uint8ClampedArray(m.rgba))
          const result: FilterPreviews = { side: response.side, pixel }
          latest.set(image, { key, previews: result })
          const measurements: Measurements = {
            cropMs: afterCrop - start,
            backgroundMs: afterBackground - afterCrop,
            workerMs: response.ms ?? 0,
            totalMs: performance.now() - start,
            squareSide: square.side
          }
          ;(window as unknown as { __filterPreviews?: Measurements }).__filterPreviews = measurements
          if (!cancelled) setPreviews(result)
        } else if (response.result === 'error') {
          // The crop may not have arrived: it is sent again on the next round.
          sent.current = -1
          console.warn('Filter thumbnails not computed: ' + (response.message ?? ''))
        }
        const next = pending.current
        pending.current = null
        next?.()
      }
      w.onerror = (e): void => {
        e.preventDefault()
        busy.current = false
        sent.current = -1
        worker.current?.terminate()
        worker.current = null
        console.warn('Filter thumbnails not computed: ' + e.message)
        // A more recent request restarts with a new worker.
        const next = pending.current
        pending.current = null
        next?.()
      }
      w.postMessage(request, data ? [data.image.data.buffer] : [])
    }

    const program = (delay: number): void => {
      timer = setTimeout(() => {
        timer = null
        if (cancelled) return
        // While dragging, wait for the release, then for the quiet period.
        if (pressed) {
          onRelease.add(retry)
          return
        }
        send()
      }, delay)
    }
    const retry = (): void => {
      if (!cancelled) program(DELAY_MS)
    }

    // On first opening there is nothing to catch up with: start right away.
    program(last ? DELAY_MS : 0)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      onRelease.delete(retry)
      if (pending.current === send) pending.current = null
    }
    // Adjustments, curves and square are already summarized in `key`.
  }, [image, key])

  return image ? previews : null
}
