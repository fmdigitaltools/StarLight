import { useEffect, useState } from 'react'
import galaxy from '../assets/galaxy.svg?raw'

/**
 * The StarLight logo (the galaxy, without the icon background) ready to draw
 * on the canvas, for the export caption.
 *
 * It is prepared only once, at a generous size (1024 pixels per side), so it
 * stays sharp even in the largest exports; for small sizes the canvas scales
 * it down.
 */

const SIDE = 1024

let promise: Promise<ImageBitmap | null> | null = null
let ready: ImageBitmap | null = null

/** The logo, prepared on first request; null if the system cannot read it. */
export function loadLogo(): Promise<ImageBitmap | null> {
  promise ??= (async () => {
    try {
      const svg = galaxy.replace(/width="512" height="512"/, 'width="' + SIDE + '" height="' + SIDE + '"')
      const img = new Image(SIDE, SIDE)
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
      await img.decode()
      ready = await createImageBitmap(img)
      return ready
    } catch {
      return null
    }
  })()
  return promise
}

/** The logo inside a component: null until ready, then the component re-renders. */
export function useStarLightLogo(): ImageBitmap | null {
  const [logo, setLogo] = useState<ImageBitmap | null>(ready)
  useEffect(() => {
    if (logo !== null) return
    let live = true
    void loadLogo().then((l) => {
      if (live) setLogo(l)
    })
    return () => {
      live = false
    }
  }, [logo])
  return logo
}
