import { useEffect, useRef, useSyncExternalStore, type JSX } from 'react'
import { GalaxyLogo } from './GalaxyLogo'
import {
  cancelPreview,
  readPreview,
  requestPreview,
  subscribePreview
} from '../hooks/framePreviews'
import { t } from '@shared/i18n/i18n'

/**
 * Square thumbnail of a frame in the library.
 *
 * Requests its image only when the row enters the visible part of the list
 * (slightly ahead of time, so it is ready while scrolling), and gives up if
 * the row leaves before its turn comes. While waiting it shows a small
 * StarLight galaxy.
 */
export function FrameThumbnail({ path, fileName }: { path: string; fileName: string }): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useSyncExternalStore(
    (notice) => subscribePreview(path, notice),
    () => readPreview(path)
  )

  useEffect(() => {
    const el = container.current
    if (!el || readPreview(path)) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) requestPreview(path, fileName)
          else cancelPreview(path)
        }
      },
      { root: el.closest('.sl-library'), rootMargin: '160px 0px' }
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      cancelPreview(path)
    }
  }, [path, fileName])

  const pixel = state && 'rgba' in state ? state : null
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !pixel) return
    c.width = pixel.side
    c.height = pixel.side
    c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixel.rgba), pixel.side, pixel.side), 0, 0)
  }, [pixel])

  const error = state && 'error' in state ? state.error : null

  return (
    <div
      ref={container}
      className={'sl-thumbnail' + (pixel ? ' sl-ready' : '') + (error ? ' sl-error' : '')}
      title={error ? t('frameThumbnail.previewUnavailable', { error }) : undefined}
      aria-hidden="true"
    >
      {pixel ? <canvas ref={canvasRef} /> : null}
      {!pixel && !error ? <GalaxyLogo size={22} /> : null}
      {error ? (
        <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.6}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M3.5 4.5l17 15" strokeLinecap="round" />
        </svg>
      ) : null}
    </div>
  )
}
