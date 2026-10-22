import { useEffect, useMemo, useRef, type JSX } from 'react'
import type { ImageData32 } from '@shared/types'
import type { ViewerGL } from '../gpu/viewerGL'
import { useApp } from '../store/appStore'
import { useViewerCrop } from '../hooks/viewerCrop'
import { useViewerCaption } from '../hooks/viewerCaption'
import { drawCaption, layoutPerFile } from '../export/canvasCaption'
import { useStarLightLogo } from '../export/starLightLogo'

/**
 * Export caption drawn in the viewer exactly as it will appear in the file:
 * inside the exported box, in the chosen corner or strip. It uses the same
 * layout as the file, scaled down to the viewer scale, so it follows zoom,
 * pan and crop. Plugin rotations and mirroring are already baked into the
 * pixels of the displayed image (the box is in their coordinates), and the
 * straighten preview rotation is applied by the viewer container to all
 * layers at once.
 *
 * This is a presentation-only layer: the image data does not change, and
 * the caption enters the file only at export time.
 */

interface ViewState {
  gl: ViewerGL | null
  image: ImageData32 | null
  zoom: number
  pan: { x: number; y: number }
}

export function CaptionLayer({ gl, image, zoom, pan }: ViewState): JSX.Element | null {
  const preview = useViewerCaption((s) => s.preview)
  const framingRequest = useViewerCaption((s) => s.framingRequest)
  const cropStore = useApp((s) => s.crop)
  const cropInProgress = useViewerCrop((s) => s.inProgress)
  const crop = cropInProgress ?? cropStore
  const logo = useStarLightLogo()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Laid out on the shape of the displayed box, not that of the file: if the
  // two differ for a moment (for example when switching from a preset to
  // free aspect ratio) the strip still stays at the bottom of the photo.
  const boxShape =
    image && crop.width > 0 ? (crop.height * image.height) / (crop.width * image.width) : 0
  const layout = useMemo(() => {
    if (!preview || !(boxShape > 0)) return null
    const height = Math.max(1, Math.round(preview.width * boxShape))
    return layoutPerFile(preview.data, preview.choice, preview.width, height)
  }, [preview, boxShape])

  // Apply: frame the exported portion, caption included, in the viewer.
  const lastRequest = useRef(framingRequest)
  useEffect(() => {
    if (framingRequest === lastRequest.current) return
    lastRequest.current = framingRequest
    if (!gl || !image) return
    const displayWidth = gl.screenWidth
    const displayHeight = gl.screenHeight
    if (displayWidth === 0 || displayHeight === 0) return
    const W = image.width
    const H = image.height
    const l = crop.width * W
    const a = crop.height * H
    const eff = 0.94 * Math.min(displayWidth / l, displayHeight / a)
    const state = useApp.getState()
    state.setZoom(eff)
    state.setPan(-(crop.x * W + l / 2 - W / 2) * eff, -(crop.y * H + a / 2 - H / 2) * eff)
  }, [framingRequest, gl, image, crop])

  const displayWidth = gl?.screenWidth ?? 0
  const displayHeight = gl?.screenHeight ?? 0

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !gl || !image || !layout || displayWidth === 0 || displayHeight === 0) return
    const dpr = window.devicePixelRatio || 1
    const lt = Math.round(displayWidth * dpr)
    const at = Math.round(displayHeight * dpr)
    if (canvas.width !== lt) canvas.width = lt
    if (canvas.height !== at) canvas.height = at
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, lt, at)
    // Photo rectangle on screen (as for the markers), then the exported box.
    const eff = zoom === 0 ? gl.fitZoom() : zoom
    const photoX = displayWidth / 2 + pan.x - (image.width * eff) / 2
    const photoY = displayHeight / 2 + pan.y - (image.height * eff) / 2
    const x = photoX + crop.x * image.width * eff
    const y = photoY + crop.y * image.height * eff
    const l = crop.width * image.width * eff
    const a = crop.height * image.height * eff
    const k = l / layout.width
    if (!(k > 0) || !Number.isFinite(k)) return
    // Nothing is drawn outside the exported box, as in the file.
    ctx.save()
    ctx.beginPath()
    ctx.rect(x * dpr, y * dpr, l * dpr, a * dpr)
    ctx.clip()
    ctx.setTransform(k * dpr, 0, 0, k * dpr, x * dpr, y * dpr)
    drawCaption(ctx, layout, logo)
    ctx.restore()
  }, [gl, image, layout, zoom, pan, crop, displayWidth, displayHeight, logo])

  if (!gl || !image || !layout) return null
  return <canvas ref={canvasRef} className="sl-viewer-layer" aria-hidden="true" />
}
