import { create } from 'zustand'

/**
 * Before/after comparison: while the key is held down, the viewer shows the
 * image as it was when opened (the original data with only the automatic
 * stretch) instead of the processed one. It changes nothing in the image or
 * in the history: it is only a way of looking.
 */
export const useComparison = create<{ active: boolean }>(() => ({ active: false }))

export function setComparison(active: boolean): void {
  if (useComparison.getState().active !== active) useComparison.setState({ active })
}
