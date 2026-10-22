import { useEffect, useRef, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Slider, Button, Label } from '../components/Controls'
import { RestartIcon } from '../components/Icons'
import { FILTERS, FILTER_COUNT, filterById, type PhotoFilter } from '@core/image/photoFilters'
import { useFilterPreviews, type FilterPreviews } from '../hooks/filterPreviews'
import { t } from '@shared/i18n/i18n'

/**
 * Spatial filters. They are computed on the GPU while the slider moves, so
 * the result is immediate and nothing is written to the original file.
 */
export function FiltersPanel(): JSX.Element {
  const adjustments = useApp((s) => s.adjustments)
  const update = useApp((s) => s.updateAdjustments)

  const chosenFilter = filterById(adjustments.filter)
  const previews = useFilterPreviews()
  const openImage = useApp((s) => s.image !== null)
  const percent = (v: number): string => Math.round(v * 100) + '%'

  return (
    <>
      <Tab
        title={t('filtersPanel.photoFilters.title')}
        action={<Label color="magenta">{FILTER_COUNT}</Label>}
        description={t('filtersPanel.photoFilters.description')}
        data="tab-filters"
      >
        <div className="sl-filter-grid">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={'sl-filter' + (filter.id === adjustments.filter ? ' sl-active' : '')}
              aria-pressed={filter.id === adjustments.filter}
              onClick={() => update({ filter: filter.id })}
              title={filter.description}
            >
              <FilterPreview filter={filter} previews={previews} openImage={openImage} />
              <span className="sl-filter-name">{filter.name}</span>
            </button>
          ))}
        </div>

        <p className="sl-note">{chosenFilter.description}</p>

        <Slider
          label={t('filtersPanel.photoFilters.intensity.label')}
          value={adjustments.filterIntensity}
          min={0}
          max={1}
          color="magenta"
          format={percent}
          hint={t('filtersPanel.photoFilters.intensity.hint')}
          disabledValue={adjustments.filter === 'none'}
          onChange={(v) => update({ filterIntensity: v })}
        />
      </Tab>

      <Tab
        title={t('filtersPanel.noise.title')}
        description={t('filtersPanel.noise.description')}
        data="tab-noise"
      >
        <Slider
          label={t('filtersPanel.noise.intensity.label')}
          value={adjustments.noiseReduction}
          min={0}
          max={1}
          color="cyan"
          format={percent}
          hint={t('filtersPanel.noise.intensity.hint')}
          onChange={(v) => update({ noiseReduction: v })}
        />
      </Tab>

      <Tab
        title={t('filtersPanel.detail.title')}
        description={t('filtersPanel.detail.description')}
        data="tab-sharpness"
      >
        <Slider
          label={t('filtersPanel.detail.sharpness.label')}
          value={adjustments.sharpness}
          min={0}
          max={1}
          color="amber"
          format={percent}
          hint={t('filtersPanel.detail.sharpness.hint')}
          onChange={(v) => update({ sharpness: v })}
        />
      </Tab>

      <Tab
        title={t('filtersPanel.vignette.title')}
        description={t('filtersPanel.vignette.description')}
        data="tab-vignetting"
      >
        <Slider
          label={t('filtersPanel.vignette.intensity.label')}
          value={adjustments.vignette}
          min={0}
          max={1}
          color="amber"
          format={percent}
          hint={t('filtersPanel.vignette.intensity.hint')}
          onChange={(v) => update({ vignette: v })}
        />
      </Tab>

      <Tab
        title={t('filtersPanel.lightPollution.title')}
        description={t('filtersPanel.lightPollution.description')}
        data="tab-gradient"
      >
        <Slider
          label={t('filtersPanel.lightPollution.removal.label')}
          value={adjustments.backgroundNeutralization}
          min={0}
          max={1}
          color="violet"
          format={percent}
          hint={t('filtersPanel.lightPollution.removal.hint')}
          onChange={(v) => update({ backgroundNeutralization: v })}
        />
      </Tab>

      <Button
        fullWidth
        icon={<RestartIcon size={17} />}
        title={t('filtersPanel.reset.title')}
        onClick={() =>
          update({
            noiseReduction: 0,
            sharpness: 0,
            vignette: 0,
            backgroundNeutralization: 0,
            filter: 'none'
          })
        }
      >
        {t('filtersPanel.reset.label')}
      </Button>
    </>
  )
}

/**
 * Tile of a filter in the grid. With an image open it shows the subject
 * through that filter, computed with the same pipeline as the export (see
 * hooks/filterPreviews); until the first computation is ready it stays a dark
 * square. Without an image, it shows a small nebula drawn with the colors of
 * the filter applied to three reference tints.
 */
function FilterPreview({
  filter,
  previews,
  openImage
}: {
  filter: PhotoFilter
  previews: FilterPreviews | null
  openImage: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pixel = previews?.pixel.get(filter.id) ?? null
  const side = previews?.side ?? 0

  useEffect(() => {
    const node = canvasRef.current
    if (!node) return
    if (!pixel || side === 0) {
      // New image, thumbnails still being computed: clear any leftovers of the previous one.
      node.getContext('2d')?.clearRect(0, 0, node.width, node.height)
      return
    }
    if (node.width !== side) node.width = side
    if (node.height !== side) node.height = side
    const ctx = node.getContext('2d')
    if (!ctx) return
    ctx.putImageData(new ImageData(pixel as Uint8ClampedArray<ArrayBuffer>, side, side), 0, 0)
  }, [pixel, side])

  if (!openImage) {
    return (
      <span
        className="sl-filter-preview"
        aria-hidden="true"
        style={{
          // A small "nebula" seen through the filter: core at the center,
          // sky background at the corners (where any vignette also shows).
          // The colors are computed from the filter, not hand-picked.
          background:
            'radial-gradient(ellipse farthest-corner at 50% 50%, ' +
            filter.preview[0] + ' 0%, ' +
            filter.preview[1] + ' 50%, ' +
            filter.preview[2] + ' 100%)'
        }}
      />
    )
  }
  return <canvas ref={canvasRef} className="sl-filter-preview sl-filter-image" aria-hidden="true" />
}
