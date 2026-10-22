import type { ImageData32 } from '@shared/types'
import {
  CAPTION_COLORS,
  blendOntoPhoto,
  layoutCaption,
  type CaptionData,
  type CaptionLayout,
  type TextMeasurer,
  type CaptionChoice
} from '@core/export/caption'
import { t } from '@shared/i18n/i18n'

/**
 * Caption drawing (see core/export/caption.ts): the same function serves the
 * exported file, the Export panel preview and the viewer layer, which scale
 * it down, so what you see before exporting is exactly what ends up in the
 * file.
 *
 * The logo is supplied ready-made from outside (export/starLightLogo.ts):
 * nothing is loaded here, so this module can also be used in tests.
 */

/** 2D context of any canvas (on-screen or offscreen). */
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** The StarLight logo ready to draw, or null if unavailable. */
export type CaptionLogo = CanvasImageSource | null

let measureContext: OffscreenCanvasRenderingContext2D | null = null

/** Measures texts with the canvas engine, using the same fonts as the drawing. */
export const measureWithCanvas: TextMeasurer = (text, font) => {
  measureContext ??= new OffscreenCanvas(1, 1).getContext('2d')
  if (!measureContext) return text.length * 8
  measureContext.font = font
  return measureContext.measureText(text).width
}

/**
 * Gradient of the brand name (see .sl-brand-name in styles/layout.css):
 * cyan, purple at 55%, magenta.
 */
function brandGradient(ctx: Context, x0: number, x1: number): CanvasGradient {
  const g = ctx.createLinearGradient(x0, 0, x1, 0)
  g.addColorStop(0, CAPTION_COLORS.cyan)
  g.addColorStop(0.55, CAPTION_COLORS.purple)
  g.addColorStop(1, CAPTION_COLORS.magenta)
  return g
}

/**
 * Draws the laid-out caption, in final file coordinates. Callers translate
 * or scale the context if they draw only a part of it or at a smaller size.
 */
export function drawCaption(ctx: Context, layout: CaptionLayout, logo: CaptionLogo): void {
  ctx.save()
  const f = layout.background
  if (f) {
    ctx.beginPath()
    if (f.radius > 0) ctx.roundRect(f.x, f.y, f.width, f.height, f.radius)
    else ctx.rect(f.x, f.y, f.width, f.height)
    ctx.fillStyle = f.color
    ctx.fill()
    if (f.edge !== null && f.borderThickness > 0) {
      ctx.lineWidth = f.borderThickness
      ctx.strokeStyle = f.edge
      ctx.stroke()
    }
  }
  if (layout.hairline) {
    // The hairline fades towards the edges: an accent, not a frame.
    const { x, y, width, thickness } = layout.hairline
    const g = ctx.createLinearGradient(x, 0, x + width, 0)
    g.addColorStop(0, 'rgba(34, 232, 255, 0)')
    g.addColorStop(0.18, 'rgba(34, 232, 255, 0.7)')
    g.addColorStop(0.55, 'rgba(157, 123, 255, 0.7)')
    g.addColorStop(0.82, 'rgba(255, 61, 208, 0.7)')
    g.addColorStop(1, 'rgba(255, 61, 208, 0)')
    ctx.fillStyle = g
    ctx.fillRect(x, y, width, thickness)
  }

  if (layout.shadow > 0) {
    ctx.shadowColor = CAPTION_COLORS.shadow
    ctx.shadowBlur = layout.shadow
  }
  if (logo !== null && layout.logo.side > 0) {
    ctx.globalAlpha = layout.logo.opacity
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(logo, layout.logo.x, layout.logo.y, layout.logo.side, layout.logo.side)
    ctx.globalAlpha = 1
  }
  ctx.textBaseline = 'alphabetic'
  for (const t of layout.texts) {
    ctx.font = t.font
    ctx.textAlign = t.alignment
    const x0 = t.alignment === 'right' ? t.x - t.width : t.x
    // The brand name: horizontal gradient across the width of the word, like
    // the gradient of the top bar.
    ctx.fillStyle = t.color === 'brand' ? brandGradient(ctx, x0, x0 + t.width) : t.color
    ctx.globalAlpha = t.opacity ?? 1
    if ('letterSpacing' in ctx) ctx.letterSpacing = (t.spacing ?? 0) + 'px'
    ctx.fillText(t.text, t.x, t.y)
  }
  ctx.globalAlpha = 1
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
  ctx.restore()
}

/** Layout for the final file, measured with the canvas engine. */
export function layoutPerFile(
  data: CaptionData,
  choice: CaptionChoice,
  width: number,
  height: number
): CaptionLayout {
  return layoutCaption(data, choice, width, height, measureWithCanvas)
}

/**
 * Applies the caption to the already cropped and resized image, blending it
 * into the photo (which is modified in place). The dimensions do not change.
 * Only the affected rectangle is drawn, so even a 60-megapixel file does not
 * need a second canvas as large as the photo.
 */
export function applyCaption(
  image: ImageData32,
  data: CaptionData,
  choice: CaptionChoice,
  logo: CaptionLogo
): CaptionLayout {
  const layout = layoutPerFile(data, choice, image.width, image.height)
  const { area } = layout
  if (area.width <= 0 || area.height <= 0) return layout
  const canvas = new OffscreenCanvas(area.width, area.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(t('exportCanvasCaption.canvasFailed'))
  ctx.translate(-area.x, -area.y)
  drawCaption(ctx, layout, logo)
  blendOntoPhoto(image, { area, rgba: ctx.getImageData(0, 0, area.width, area.height).data })
  return layout
}
