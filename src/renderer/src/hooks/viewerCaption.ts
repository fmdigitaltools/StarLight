import { create } from 'zustand'
import type { CaptionData, CaptionChoice } from '@core/export/caption'

/**
 * Caption shown in the viewer while the Export step is open.
 *
 * The Export panel publishes here the caption that will end up in the file
 * (actual data, template, corner, file dimensions); the viewer draws it as a
 * layer over the image (see components/CaptionLayer.tsx). It is presentation
 * only: it never enters the processed image data, and is added to the file
 * only at export time, in display formats.
 */

export interface CaptionPreview {
  data: CaptionData
  choice: CaptionChoice
  /** Dimensions of the exported file, without the caption. */
  width: number
  height: number
}

/** The choices that matter for the "changed since the last Apply" indicator. */
export function captionSignature(a: CaptionPreview | null): string {
  if (a === null) return 'off'
  return JSON.stringify([a.choice.model, a.choice.angle, a.data.entries.map((v) => v.text), a.data.title])
}

interface ViewerCaptionState {
  /** Caption to draw, or null (turned off, data format, different step). */
  preview: CaptionPreview | null
  /** Signature of the choices at the last Apply; null if never applied. */
  applied: string | null
  /** Incremented on every Apply: the viewer frames the whole file, caption included. */
  framingRequest: number
  setPreview: (a: CaptionPreview | null) => void
  apply: () => void
}

export const useViewerCaption = create<ViewerCaptionState>((set, get) => ({
  preview: null,
  applied: null,
  framingRequest: 0,
  setPreview: (preview) => set({ preview }),
  apply: () => set({ applied: captionSignature(get().preview), framingRequest: get().framingRequest + 1 })
}))
