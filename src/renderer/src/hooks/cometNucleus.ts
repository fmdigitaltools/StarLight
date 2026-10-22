import { create } from 'zustand'

/**
 * Comet nucleus marked by hand, with a click on the first and on the last
 * frame of the sequence.
 *
 * The Stack panel opens the frame in the viewer and waits; on the first click
 * (not a drag) the viewer hands over the point here, in pixels of the
 * displayed image. Stacking then interpolates between the two points over
 * time and refines the position in every frame.
 */

/** A marked point, in pixels of the frame as it was displayed. */
export interface NucleusPoint {
  frameId: string
  x: number
  y: number
  /** Dimensions of the displayed image at the time of the click. */
  width: number
  height: number
}

export type WhichNucleus = 'first' | 'last'

interface NucleusState {
  first: NucleusPoint | null
  last: NucleusPoint | null
  /** Which point the next click in the viewer is expected to set, and on which frame. */
  wait: { which: WhichNucleus; frameId: string } | null
  ask: (which: WhichNucleus, frameId: string) => void
  /** Hands over the click; ignored if the displayed frame is not the expected one. */
  recordClick: (frameId: string | null, x: number, y: number, width: number, height: number) => void
  cancelWait: () => void
  reset: () => void
}

export const useCometNucleus = create<NucleusState>((set, get) => ({
  first: null,
  last: null,
  wait: null,
  ask: (which, frameId) => set({ wait: { which, frameId } }),
  recordClick: (frameId, x, y, width, height) => {
    const wait = get().wait
    if (!wait || frameId !== wait.frameId) return
    const point: NucleusPoint = { frameId, x, y, width, height }
    set(wait.which === 'first' ? { first: point, wait: null } : { last: point, wait: null })
  },
  cancelWait: () => set({ wait: null }),
  reset: () => set({ first: null, last: null, wait: null })
}))
