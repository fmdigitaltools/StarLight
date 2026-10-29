import { create } from 'zustand'

/**
 * Clipping warning: while on, the viewer paints the pixels shown as pure
 * black in blue and those shown as pure white in magenta. Like the
 * before/after comparison it is only a way of looking: it is not saved in
 * the project, it is not part of the history and it never reaches an
 * export. It starts off at every launch, so nobody mistakes the colors for
 * a change to the image.
 */
export const useClippingWarning = create<{ on: boolean }>(() => ({ on: false }))

export function toggleClippingWarning(): void {
  useClippingWarning.setState((s) => ({ on: !s.on }))
}
