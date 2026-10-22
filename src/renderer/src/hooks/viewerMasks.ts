import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { ImageData32 } from '@shared/types'
import { useApp } from '../store/appStore'
import type { ViewerGL, ViewLocalParams } from '../gpu/viewerGL'
import { applyCorrections } from '@core/export/processing'
import { imageSkyBackground } from '@core/image/skyBackground'
import { effectiveFilter } from '@core/image/photoFilters'
import {
  MAX_LAYERS,
  startDimensions,
  packPainted,
  packStars,
  layerActs,
  mapToSource,
  imageStars,
  starsInMemory,
  tintOf,
  type LocalLayer,
  type PaintedMask,
  type Layer4
} from '@core/image/masks'

/**
 * Local adjustments in the viewer: which layers to send to the shader, the
 * image masks (painted and star masks) to upload to the GPU, and the state of
 * the tools (brush, eraser, mask shown in red).
 *
 * The tool state is part of neither the project nor the history: it is a way
 * of working, like zoom.
 */

export type MaskTool = 'none' | 'brush' | 'eraser' | 'draw' | 'eyedropper'

interface ToolsState {
  /** Layer selected in the card, or null. */
  selected: string | null
  tool: MaskTool
  /** Brush diameter, in screen pixels. */
  size: number
  /** From 0 (softest edge) to 1 (hard edge). */
  hardness: number
  /** From 0 to 1. */
  opacity: number
  /** Shows the mask of the selected layer in semi-transparent red. */
  showMask: boolean
  set: (patch: Partial<Omit<ToolsState, 'set'>>) => void
}

export const useMaskTools = create<ToolsState>((set) => ({
  selected: null,
  tool: 'none',
  size: 80,
  hardness: 0.5,
  opacity: 1,
  showMask: false,
  set: (patch) => set(patch)
}))

/**
 * Brush stroke in progress: while the mouse button is held down the painted
 * mask changes here, outside the store, and becomes a history step only on
 * release.
 */
export const useBrushStrokeInProgress = create<{ id: string | null; painted: PaintedMask | null }>(() => ({
  id: null,
  painted: null
}))

/** Painted masks currently uploaded to the GPU, so they can be updated piecewise while painting. */
export const gpuMasks: {
  gl: ViewerGL | null
  layer: Layer4 | null
  /** Channel of each layer in the texture. */
  channels: Map<string, number>
} = { gl: null, layer: null, channels: new Map() }

/** Star searches in progress, so they are not repeated. */
const searchesInProgress = new WeakSet<ImageData32>()

/**
 * Prepares the local adjustments for the viewer and keeps their image masks
 * uploaded. Returns the parameters to pass to `draw`, or null if there is
 * nothing to apply or show.
 */
export function useLocalAdjustmentsInViewer(
  gl: ViewerGL | null,
  image: ImageData32 | null,
  generation: number
): ViewLocalParams | null {
  const layersStore = useApp((s) => s.localAdjustments)
  const geometry = useApp((s) => s.appliedGeometry)
  const selected = useMaskTools((s) => s.selected)
  const show = useMaskTools((s) => s.showMask)
  const tool = useMaskTools((s) => s.tool)
  const inProgress = useBrushStrokeInProgress()
  // Incremented when a star search finishes.
  const [foundStars, setFoundStars] = useState(0)

  // Layers to send to the shader: those that have an effect, plus the
  // selected one if its mask is being viewed or drawn.
  const highlighted = selected !== null && (show || tool !== 'none') ? selected : null
  const layers = useMemo(() => {
    const withBrushStroke = layersStore.map((l) =>
      l.id === inProgress.id && inProgress.painted ? { ...l, mask: { ...l.mask, painted: inProgress.painted } } : l
    )
    return withBrushStroke
      .filter((l) => layerActs(l) || l.id === highlighted)
      .slice(0, MAX_LAYERS)
  }, [layersStore, inProgress, highlighted])

  const start = useMemo(
    () => (image ? startDimensions(geometry, image) : { width: 1, height: 1 }),
    [geometry, image]
  )

  // Painted masks: repacked only when they change (which layers, in which
  // order, with which mask).
  const paintedMemo = useRef<{ key: unknown[]; layer: Layer4 | null } | null>(null)
  const paintedKey: unknown[] = [start, ...layers.map((l) => l.mask.painted)]
  const previous = paintedMemo.current
  if (
    previous === null ||
    previous.key.length !== paintedKey.length ||
    previous.key.some((v, i) => v !== paintedKey[i])
  ) {
    paintedMemo.current = { key: paintedKey, layer: packPainted(layers, start) }
  }
  const paintedItems = paintedMemo.current?.layer ?? null

  // Star masks need the stars of the image.
  const withStars = layers.some((l) => l.mask.type === 'stars')
  const stars = image && withStars ? starsInMemory(image) : null
  useEffect(() => {
    if (!image || !withStars || starsInMemory(image) || searchesInProgress.has(image)) return
    searchesInProgress.add(image)
    // The search blocks briefly: let the notice appear first.
    useMaskNotices.setState({ findStars: true })
    const t = window.setTimeout(() => {
      try {
        imageStars(image)
      } finally {
        searchesInProgress.delete(image)
        useMaskNotices.setState({ findStars: false })
        setFoundStars((n) => n + 1)
      }
    }, 40)
    return () => window.clearTimeout(t)
  }, [image, withStars, foundStars])

  const starsKey = layers
    .map((l, i) => (l.mask.type === 'stars' ? i + ':' + l.mask.starSize + ':' + l.mask.feather : ''))
    .join('|')
  const starsMemo = useRef<{ key: unknown[]; starLayers: ReturnType<typeof packStars> } | null>(null)
  const keyS: unknown[] = [image, stars, starsKey]
  if (starsMemo.current === null || starsMemo.current.key.some((v, i) => v !== keyS[i])) {
    starsMemo.current = { key: keyS, starLayers: image ? packStars(layers, image, stars) : null }
  }
  const starLayers = starsMemo.current.starLayers

  // Upload to the GPU.
  useEffect(() => {
    if (!gl) return
    gl.loadPainted(paintedItems)
    gpuMasks.gl = gl
    gpuMasks.layer = paintedItems
  }, [gl, paintedItems, generation, image])
  useEffect(() => {
    gpuMasks.channels = new Map(layers.map((l, i) => [l.id, i]))
  }, [layers])
  useEffect(() => {
    if (!gl) return
    gl.loadStars(starLayers)
  }, [gl, starLayers, generation, image])

  return useMemo(() => {
    if (!image || layers.length === 0) return null
    const index = selected !== null && show ? layers.findIndex((l) => l.id === selected) : -1
    // The uploaded masks are part of the rendering: when they change, this
    // object changes too and the viewer redraws.
    void paintedItems
    void starLayers
    return { levels: layers, map: mapToSource(geometry), start, show: index }
  }, [image, layers, geometry, start, selected, show, paintedItems, starLayers])
}

/** Notices for the card, for example a star search in progress. */
export const useMaskNotices = create<{ findStars: boolean }>(() => ({ findStars: false }))

/**
 * Hue of the color displayed around image pixel (x, y), for the color mask
 * eyedropper: a 5×5 pixel patch is run through the export chain and
 * averaged. Null if the point is gray (no hue to pick).
 */
export function tintAtPoint(image: ImageData32, x: number, y: number): number | null {
  const w = image.width
  const h = image.height
  const cx = Math.round(x)
  const cy = Math.round(y)
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null
  const side = 5
  const n = w * h
  const channels = image.channels
  const data = new Float32Array(side * side * channels)
  for (let c = 0; c < channels; c++) {
    for (let dy = 0; dy < side; dy++) {
      const yy = Math.min(h - 1, Math.max(0, cy + dy - 2))
      for (let dx = 0; dx < side; dx++) {
        const xx = Math.min(w - 1, Math.max(0, cx + dx - 2))
        data[c * side * side + dy * side + dx] = image.data[c * n + yy * w + xx]
      }
    }
  }
  const s = useApp.getState()
  const r = s.adjustments
  const result = applyCorrections(
    { width: side, height: side, channels: channels, data: data },
    {
      stretch: r.stretch,
      brightness: r.brightness,
      contrast: r.contrast,
      saturation: r.saturation,
      redGain: r.redGain,
      greenGain: r.greenGain,
      blueGain: r.blueGain,
      gamma: r.gamma,
      noiseReduction: 0,
      sharpness: 0,
      backgroundNeutralization: r.backgroundNeutralization,
      skyBackground: imageSkyBackground(image),
      preserveColor: r.preserveColor,
      ghs: r.withGhs ? r.ghs : undefined,
      curves: s.curves,
      filter: effectiveFilter(r.filter, r.filterIntensity, r.vibrance, r.vignette)
    }
  )
  const m = side * side
  let rr = 0
  let gg = 0
  let bb = 0
  for (let i = 0; i < m; i++) {
    rr += result.data[i]
    gg += result.data[m + i]
    bb += result.data[2 * m + i]
  }
  rr /= m
  gg /= m
  bb /= m
  if (Math.max(rr, gg, bb) - Math.min(rr, gg, bb) < 0.01) return null
  return tintOf(rr, gg, bb)
}

/** The layer selected in the card, if it still exists. */
export function chosenLayer(layers: LocalLayer[], id: string | null): LocalLayer | null {
  return layers.find((l) => l.id === id) ?? null
}
