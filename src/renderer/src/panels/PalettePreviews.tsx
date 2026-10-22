import { useMemo, type JSX } from 'react'
import type { ImageData32 } from '@shared/types'
import { t } from '@shared/i18n/i18n'
import { useApp } from '../store/appStore'
import { Segmented } from '../components/Controls'
import {
  narrowband,
  extractBands,
  reduceForPreview,
  sensorFromMetadata,
  NARROWBAND_NEUTRAL,
  NARROWBAND_PALETTES,
  type NarrowbandPalette
} from '@core/image/narrowband'
import { autoStretch, applyStretch } from '@core/image/stretch'

/** Long side of the thumbnails, in pixels. */
const SIDE = 120

/** Language keys of the palette names, translated at render time. */
const PALETTE_NAME_KEYS: Record<NarrowbandPalette, string> = {
  natural: 'palettePreviews.palette.natural',
  hoo: 'palettePreviews.palette.hoo',
  foraxx: 'palettePreviews.palette.foraxx',
  sho: 'palettePreviews.palette.sho'
}

/** Stretches a thumbnail, boosts its color and converts it into an image for the page. */
function toImage(img: ImageData32, perChannel: boolean): string {
  const w = img.width
  const h = img.height
  const n = w * h
  let stretchedImage: ImageData32
  if (perChannel) {
    // The original does not yet have its background and color corrected:
    // stretching each channel on its own gives a result close to the processed image.
    const data = new Float32Array(3 * n)
    for (let c = 0; c < 3; c++) {
      const plane: ImageData32 = { width: w, height: h, channels: 1, data: img.data.slice(c * n, (c + 1) * n) }
      data.set(applyStretch(plane, autoStretch(plane)).data, c * n)
    }
    stretchedImage = { width: w, height: h, channels: 3, data: data }
  } else {
    stretchedImage = applyStretch(img, autoStretch(img))
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const pixel = ctx.createImageData(w, h)
  const d = stretchedImage.data
  for (let i = 0; i < n; i++) {
    const l = (d[i] + d[n + i] + d[2 * n + i]) / 3
    for (let c = 0; c < 3; c++) {
      const v = l + (d[c * n + i] - l) * 1.6
      pixel.data[i * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, v)))
    }
    pixel.data[i * 4 + 3] = 255
  }
  ctx.putImageData(pixel, 0, 0)
  return canvas.toDataURL()
}

/**
 * Palette picker with thumbnails computed on a downscaled copy of the
 * original image: they take a few milliseconds and show at a glance what
 * changes before Apply is pressed. They are only indicative: the real image
 * first goes through sky background, color and noise reduction.
 */
export function PalettePreviews({
  value,
  onChange
}: {
  value: NarrowbandPalette
  onChange: (v: NarrowbandPalette) => void
}): JSX.Element {
  const original = useApp((s) => s.originalImage ?? s.image)
  const sensor = useApp((s) => sensorFromMetadata(s.frame.find((f) => f.id === s.activeFrameId)?.metadata))

  const previews = useMemo((): Record<NarrowbandPalette, string> | null => {
    if (!original || original.channels !== 3) return null
    try {
      const small = reduceForPreview(original, SIDE)
      const bands = extractBands(small, sensor)
      const result = {} as Record<NarrowbandPalette, string>
      for (const palette of NARROWBAND_PALETTES) {
        result[palette] =
          palette === 'natural'
            ? toImage(small, true)
            : toImage(narrowband(small, { ...NARROWBAND_NEUTRAL, palette, naturalStars: false, sensor }, bands), false)
      }
      return result
    } catch {
      return null
    }
  }, [original, sensor])

  // Without a color image there are no thumbnails: only the buttons remain.
  if (!previews) {
    return (
      <Segmented<NarrowbandPalette>
        value={value}
        options={NARROWBAND_PALETTES.map((p) => ({ value: p, label: t(PALETTE_NAME_KEYS[p]) }))}
        onChange={onChange}
      />
    )
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
      {NARROWBAND_PALETTES.map((palette) => (
        <button
          key={palette}
          type="button"
          onClick={() => onChange(palette)}
          title={t(PALETTE_NAME_KEYS[palette])}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 3,
            padding: 3,
            borderRadius: 4,
            background: palette === value ? 'var(--sl-bg-3)' : 'transparent',
            boxShadow: palette === value ? 'inset 0 0 0 1px rgba(34, 232, 255, 0.45)' : 'none',
            color: palette === value ? 'var(--sl-cyan)' : 'var(--sl-text-3)',
            fontSize: 'var(--sl-fs-xs)',
            minWidth: 0
          }}
        >
          <img
            src={previews[palette]}
            alt={t(PALETTE_NAME_KEYS[palette])}
            style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 3, display: 'block' }}
          />
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
            {t(PALETTE_NAME_KEYS[palette])}
          </span>
        </button>
      ))}
    </div>
  )
}
