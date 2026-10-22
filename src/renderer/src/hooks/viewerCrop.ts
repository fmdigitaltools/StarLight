import { create } from 'zustand'
import type { Crop } from '@core/export/crop'
import { updatePreferences } from '../settings'

/**
 * Crop in the viewer: the «Crop» button in the top bar turns it on and off.
 * When off, the viewer shows nothing of the crop (which is kept and still
 * applies to export); when on, the crop box is visible and can be moved or
 * resized directly on the image.
 *
 * It is a way of looking, like zoom: it is part of neither the history nor
 * the project. The choice is remembered across launches in the preferences
 * file.
 *
 * While dragging, the new box lives here (`inProgress`) rather than in the
 * store: it becomes a history step only on release, so a drag, even a slow
 * one with pauses, is undone with a single Ctrl+Z. The Export step thumbnail
 * also reads this value and stays in sync with the viewer.
 */

const KEY = 'viewerCrop'

interface ViewerCropState {
  on: boolean
  /** Box during a drag in the viewer, or null. */
  inProgress: Crop | null
  toggle: () => void
  setInProgress: (r: Crop | null) => void
}

export const useViewerCrop = create<ViewerCropState>((set, get) => ({
  on: false,
  inProgress: null,
  toggle: () => {
    const on = !get().on
    set({ on, inProgress: null })
    void updatePreferences({ [KEY]: on })
  },
  setInProgress: (inProgress) => set({ inProgress })
}))

// The last choice, read once at startup.
if (typeof window !== 'undefined' && window.starlight) {
  window.starlight
    .readPreferences()
    .then((prefs) => {
      if (prefs[KEY] === true) useViewerCrop.setState({ on: true })
    })
    .catch(() => {
      // Without preferences it stays off.
    })
}
