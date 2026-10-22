import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Slider, Button, DataEntry, Label, Toggle, Segmented } from '../components/Controls'
import { ProcessIcon, ExportIcon } from '../components/Icons'
import { RESOLUTIONS, proportionalHeight, type UpscalingMethod } from '@core/export/resize'
import { FORMATS } from '@core/export/encoding'
import { formatBytes } from '@core/memory'
import { filterById } from '@core/image/photoFilters'
import {
  PRESETS,
  ASPECT_RATIOS,
  FULL_CROP,
  cropDimensions,
  centeredCrop,
  fullCrop,
  cropScale
} from '@core/export/crop'
import { Framing } from '../components/Framing'
import { produceExport } from '../export/exportImage'
import { workFolderOf, writeSettings, useSettings } from '../settings'
import {
  captionAllowed,
  collectCaptionData,
  type CaptionCorner,
  type CaptionTemplate,
  type CaptionChoice
} from '@core/export/caption'
import { layoutPerFile } from '../export/canvasCaption'
import { integrationShown, shownResult } from '../hooks/temporaryResult'
import { captionSignature, useViewerCaption } from '../hooks/viewerCaption'
import { loadLogo } from '../export/starLightLogo'
import { useDisplayedAstrometry } from '../hooks/displayedAstrometry'
import { noCoordinates } from '@core/astrometry/imageCoordinates'
import { formatDecimal, t } from '@shared/i18n/i18n'

type Format = keyof typeof FORMATS

/** Upscaling methods; label and hint are under exportPanel.upscaling.<method>. */
const UPSCALING_METHODS: UpscalingMethod[] = ['edge-directed', 'lanczos']

/** Language key segment of each upscaling method. */
const UPSCALING_KEYS: Record<UpscalingMethod, string> = {
  'edge-directed': 'edgeDirected',
  lanczos: 'lanczos'
}

/** Caption templates; label, hint and description are under exportPanel.caption.templates.<template>. */
const CAPTION_TEMPLATES: CaptionTemplate[] = ['minimal', 'banner', 'card']

/** Language key of the title shown for each group of presets. */
const GROUP_LABEL_KEYS: Record<'Social' | 'Screens' | 'Print', string> = {
  Social: 'exportPanel.presets.groups.social',
  Screens: 'exportPanel.presets.groups.screens',
  Print: 'exportPanel.presets.groups.print'
}

export function ExportPanel(): JSX.Element {
  const image = useApp((s) => s.image)
  const adjustments = useApp((s) => s.adjustments)
  const curves = useApp((s) => s.curves)
  const frame = useApp((s) => s.frame)
  const activeFrameId = useApp((s) => s.activeFrameId)
  const notify = useApp((s) => s.notify)
  const setJob = useApp((s) => s.setJob)
  const finishJob = useApp((s) => s.finishJob)

  const crop = useApp((s) => s.crop)
  const aspectRatio = useApp((s) => s.aspectRatio)
  const preset = useApp((s) => s.preset)
  const setCrop = useApp((s) => s.setCrop)
  const setAspectRatio = useApp((s) => s.setAspectRatio)
  const setPreset = useApp((s) => s.setPreset)

  const [format, setFormat] = useState<Format>('png')
  const [narrowness, setTightness] = useState(1)
  const [quality, setQuality] = useState(92)
  const [chosenWidth, setChosenWidth] = useState(0)
  const [upscalingMethod, setUpscalingMethod] = useState<UpscalingMethod>('edge-directed')
  const [keepMetadata, setKeepMetadata] = useState(true)
  const [withMarkers, setWithMarkers] = useState(false)
  // Coordinates are turned on in the Objects step: here the only choice is
  // whether to include them in the file, which is the default.
  const [withCoordinates, setWithCoordinates] = useState(true)
  // Solution and objects of the displayed image: if a plugin rotated or
  // mirrored it, they have already been moved along with the pixels.
  const astrometry = useDisplayedAstrometry()
  const objects = astrometry.objects
  const [inProgress, setInProgress] = useState(false)
  // Export uses the job progress indicator: during another job it would turn
  // the indicator off too early, so it waits.
  const otherJob = useApp((s) => s.job.active) && !inProgress

  // Caption: the choices are stored in the settings, so they persist between
  // sessions and also apply to batch processing.
  const settings = useSettings()
  const [author, setAuthor] = useState(settings.captionAuthor)
  const authorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setAuthor(settings.captionAuthor), [settings.captionAuthor])
  useEffect(
    () => () => {
      if (authorTimer.current) clearTimeout(authorTimer.current)
    },
    []
  )
  function changeAuthor(value: string): void {
    setAuthor(value)
    // Saved when typing stops, not on every keystroke.
    if (authorTimer.current) clearTimeout(authorTimer.current)
    authorTimer.current = setTimeout(() => void writeSettings({ captionAuthor: value }), 400)
  }

  const active = frame.find((f) => f.id === activeFrameId) ?? null
  const info = FORMATS[format]
  // Formats that support overlays drawn on the photo (markers and coordinates).
  const withDrawings = format !== 'tiff' && format !== 'bmp' && format !== 'fits'
  const coordChoice = {
    grid: settings.coordinatesGrid,
    orientation: settings.coordinatesOrientation,
    scale: settings.coordinatesScale
  }
  const availableCoordinates = astrometry.wcs !== null && !noCoordinates(coordChoice)
  const coordinatesInFile = withDrawings && availableCoordinates && withCoordinates ? coordChoice : null

  /** Size of the selected area, in pixels of the original. */
  const cropMeasurements = useMemo(() => {
    if (!image) return null
    return cropDimensions(crop, image.width, image.height)
  }, [image, crop])

  /**
   * Size of the output file. A preset imposes its own dimensions; otherwise
   * the crop is used as the starting point and rescaled.
   */
  const dimensions = useMemo(() => {
    if (!image || !cropMeasurements) return null

    if (preset !== null) {
      const chosen = PRESETS.find((p) => p.id === preset)
      if (chosen) return { width: chosen.width, height: chosen.height }
    }

    if (chosenWidth === 0) return cropMeasurements

    return {
      width: chosenWidth,
      height: proportionalHeight(cropMeasurements.width, cropMeasurements.height, chosenWidth)
    }
  }, [image, cropMeasurements, chosenWidth, preset])

  /** Caption data: only what is present in the file or in the stacking result. */
  const captionData = useMemo(
    () =>
      active
        ? collectCaptionData({
            metadata: active.metadata,
            header: active.header.cards as Record<string, string | number | boolean | null>,
            objects,
            crop,
            integration: integrationShown(),
            result: shownResult() !== null,
            author,
            place: settings.captionLocation
          })
        : null,
    // The open image determines whether the remembered stacking result still applies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, objects, crop, author, settings.captionLocation, image]
  )
  const withCaption = settings.caption && captionAllowed(format) && captionData !== null
  const caption = useMemo(
    () =>
      withCaption && captionData
        ? {
            data: captionData,
            choice: {
              model: settings.captionModel,
              angle: settings.captionCorner
            } as CaptionChoice
          }
        : null,
    [withCaption, captionData, settings.captionModel, settings.captionCorner]
  )
  /** Layout at the output size: added rows and the entries that fit. */
  const layout = useMemo(
    () =>
      caption && dimensions
        ? layoutPerFile(caption.data, caption.choice, dimensions.width, dimensions.height)
        : null,
    [caption, dimensions]
  )

  // The viewer shows the same caption, updated on every choice (a lightweight
  // overlay on the image, not a recomputation). It disappears when leaving
  // the Export step and never becomes part of the image data.
  const viewerPreview = useMemo(
    () =>
      caption && dimensions
        ? {
            ...caption,
            width: dimensions.width,
            height: dimensions.height
          }
        : null,
    [caption, dimensions]
  )
  useEffect(() => {
    useViewerCaption.getState().setPreview(viewerPreview)
  }, [viewerPreview])
  useEffect(() => () => useViewerCaption.getState().setPreview(null), [])
  const signatureApplied = useViewerCaption((s) => s.applied)
  const captionChanged = signatureApplied !== null && signatureApplied !== captionSignature(viewerPreview)

  /** Applies an aspect ratio, centering the crop box on the image. */
  function changeAspectRatio(id: string): void {
    if (!image) return
    const choice = ASPECT_RATIOS.find((p) => p.id === id)
    if (!choice) return
    setAspectRatio(id)
    setTightness(1)
    setCrop(centeredCrop(image.width, image.height, choice.ratio))
  }

  /** Selects a preset, fitting the crop to its shape. */
  function changePreset(id: string | null): void {
    setPreset(id)
    if (id === null || !image) return
    const chosen = PRESETS.find((p) => p.id === id)
    if (!chosen) return
    setTightness(1)
    setAspectRatio('custom')
    setCrop(centeredCrop(image.width, image.height, chosen.width / chosen.height))
  }

  /** Shrinks or enlarges the crop box while keeping its shape. */
  function changeTightness(value: number): void {
    if (!image) return
    const choice = ASPECT_RATIOS.find((p) => p.id === aspectRatio)
    const base = centeredCrop(
      image.width,
      image.height,
      preset !== null
        ? (() => {
            const p = PRESETS.find((x) => x.id === preset)
            return p ? p.width / p.height : null
          })()
        : (choice?.ratio ?? null)
    )
    setTightness(value)
    const narrow = cropScale(base, value, choice?.ratio ?? null)
    // The center chosen by the user is preserved.
    const centerX = crop.x + crop.width / 2
    const centerY = crop.y + crop.height / 2
    setCrop({
      width: narrow.width,
      height: narrow.height,
      x: Math.min(1 - narrow.width, Math.max(0, centerX - narrow.width / 2)),
      y: Math.min(1 - narrow.height, Math.max(0, centerY - narrow.height / 2))
    })
  }

  async function doExport(): Promise<void> {
    if (!image || !dimensions || inProgress) return
    if (useApp.getState().job.active) {
      notify('warning', t('exportPanel.waitForJob'))
      return
    }
    setInProgress(true)
    try {
      // Same path as batch processing (see export/exportImage.ts).
      const data = await produceExport(
        image,
        adjustments,
        curves,
        {
          format,
          quality,
          crop,
          width: dimensions.width,
          height: dimensions.height,
          upscalingMethod,
          header:
            keepMetadata && active ? (active.header.cards as Record<string, string | number | boolean | null>) : {},
          // Solution and objects of the displayed image: if a plugin rotated
          // or mirrored it, they have already been moved along with the pixels.
          wcs: astrometry.wcs,
          markers: withMarkers ? { objects, pixelScale: astrometry.pixelScale } : null,
          coordinates: coordinatesInFile,
          // Local adjustments, with the same masks shown in the viewer.
          locals: {
            levels: useApp.getState().localAdjustments,
            geometry: useApp.getState().appliedGeometry
          },
          caption: caption ? { ...caption, logo: await loadLogo() } : null
        },
        setJob
      )

      const baseName = (active?.fileName ?? 'starlight').replace(/\.[^.]+$/, '')
      const object = active?.metadata.object?.replace(/\s+/g, '') ?? ''
      const formatLabel =
        preset !== null ? '_' + (PRESETS.find((p) => p.id === preset)?.id ?? '') : ''
      const suggested =
        (object !== '' ? object + '_' : '') +
        baseName +
        formatLabel +
        '_' +
        dimensions.width +
        'x' +
        dimensions.height +
        '.' +
        info.extension

      // The save dialog opens in the Exports folder (Settings, General tab).
      const path = await window.starlight.chooseDestination(
        suggested,
        format,
        await workFolderOf('exports')
      )
      if (path === null) {
        finishJob()
        return
      }

      await window.starlight.writeFile(path, data)
      finishJob()
      notify('ok', t('exportPanel.exported', { size: formatBytes(data.byteLength) }))
      await window.starlight.showInFolder(path)
    } catch (e) {
      finishJob()
      notify('error', t('exportPanel.exportFailed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setInProgress(false)
    }
  }

  if (!image || !dimensions) {
    return (
      <Tab title={t('exportPanel.noImage.title')}>
        <p className="sl-note">{t('exportPanel.noImage.text')}</p>
      </Tab>
    )
  }

  return (
    <>
      <Tab
        title={t('exportPanel.format.title')}
        description={t('exportPanel.format.description')}
        data="tab-format"
      >
        <div className="sl-format-grid">
          {(Object.keys(FORMATS) as Format[]).map((f) => (
            <button
              key={f}
              type="button"
              className={'sl-format' + (f === format ? ' sl-active' : '')}
              onClick={() => setFormat(f)}
              title={
                FORMATS[f].loss
                  ? t('exportPanel.format.lossy')
                  : t('exportPanel.format.lossless', { bits: FORMATS[f].bit })
              }
            >
              <span className="sl-format-name">{FORMATS[f].name}</span>
              <span className="sl-format-bit">{t('exportPanel.format.bits', { bits: FORMATS[f].bit })}</span>
            </button>
          ))}
        </div>
        {info.loss ? (
          <Slider
            label={t('exportPanel.format.quality.label')}
            value={quality}
            min={40}
            max={100}
            step={1}
            color="amber"
            format={(v) => v + '%'}
            hint={t('exportPanel.format.quality.hint')}
            onChange={setQuality}
          />
        ) : null}
        {format === 'fits' ? (
          <Toggle
            label={t('exportPanel.format.keepMetadata.label')}
            active={keepMetadata}
            onChange={setKeepMetadata}
            hint={t('exportPanel.format.keepMetadata.hint')}
          />
        ) : null}
        {withDrawings ? (
          <Toggle
            label={t('exportPanel.format.markers.label')}
            active={withMarkers}
            onChange={setWithMarkers}
            hint={t('exportPanel.format.markers.hint')}
          />
        ) : null}
        {withDrawings && availableCoordinates ? (
          <Toggle
            label={t('exportPanel.format.coordinates.label')}
            active={withCoordinates}
            onChange={setWithCoordinates}
            hint={t('exportPanel.format.coordinates.hint')}
          />
        ) : null}
      </Tab>

      <Tab
        title={t('exportPanel.framing.title')}
        action={
          !fullCrop(crop) ? (
            <Button
              variant="ghost"
              onClick={() => {
                setCrop(FULL_CROP)
                setAspectRatio('original')
                setPreset(null)
                setTightness(1)
              }}
              title={t('exportPanel.framing.full.title')}
            >
              {t('exportPanel.framing.full.label')}
            </Button>
          ) : undefined
        }
        description={t('exportPanel.framing.description')}
        data="tab-framing"
      >
        <Framing
          showMarkers={withMarkers && withDrawings}
          coordinates={coordinatesInFile}
          caption={caption}
          finalDimensions={dimensions}
        />
        <div className="sl-ratios">
          {ASPECT_RATIOS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={'sl-ratio' + (p.id === aspectRatio ? ' sl-active' : '')}
              onClick={() => changeAspectRatio(p.id)}
              title={p.description}
            >
              {p.name}
            </button>
          ))}
        </div>
        <Slider
          label={t('exportPanel.framing.size.label')}
          value={narrowness}
          min={0.25}
          max={1}
          step={0.01}
          color="cyan"
          format={(v) => Math.round(v * 100) + '%'}
          hint={t('exportPanel.framing.size.hint')}
          onChange={changeTightness}
        />
        {cropMeasurements !== null ? (
          <DataEntry
            name={t('exportPanel.framing.selection.name')}
            value={cropMeasurements.width + ' x ' + cropMeasurements.height + ' px'}
            hint={t('exportPanel.framing.selection.hint')}
          />
        ) : null}
      </Tab>

      <Tab
        title={t('exportPanel.presets.title')}
        action={
          preset !== null ? (
            <Button variant="ghost" onClick={() => changePreset(null)}>
              {t('exportPanel.presets.free')}
            </Button>
          ) : undefined
        }
        description={t('exportPanel.presets.description')}
        data="tab-presets"
      >
        {/* One group per type, collapsed by default: the title still shows which preset is selected. */}
        {(['Social', 'Screens', 'Print'] as const).map((group) => {
          const formats = PRESETS.filter((p) => p.group === group)
          const chosen = formats.find((p) => p.id === preset)
          return (
            <details className="sl-format-group" key={group}>
              <summary className="sl-group-title">
                <span>{t(GROUP_LABEL_KEYS[group])}</span>
                <span className="sl-group-count">
                  {chosen ? chosen.name : t('exportPanel.presets.count', { count: formats.length })}
                </span>
              </summary>
              {formats.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={'sl-format-preset' + (p.id === preset ? ' sl-active' : '')}
                  onClick={() => changePreset(p.id)}
                  title={p.description}
                >
                  <span className="sl-format-preset-name">{p.name}</span>
                  <span className="sl-format-preset-size">
                    {p.width} x {p.height}
                  </span>
                </button>
              ))}
            </details>
          )
        })}
      </Tab>

      <Tab title={t('exportPanel.resolution.title')} data="tab-resolution">
        {preset !== null ? (
          <p className="sl-note">{t('exportPanel.resolution.presetNote')}</p>
        ) : (
          <div className="sl-format-grid">
            {RESOLUTIONS.map((r) => (
              <button
                key={r.name}
                type="button"
                className={'sl-format' + (r.width === chosenWidth ? ' sl-active' : '')}
                onClick={() => setChosenWidth(r.width)}
                title={r.description}
              >
                <span className="sl-format-name">{r.name}</span>
                <span className="sl-format-bit">
                  {r.width === 0
                    ? (cropMeasurements?.width ?? image.width) + ' px'
                    : r.width +
                      ' x ' +
                      proportionalHeight(
                        cropMeasurements?.width ?? image.width,
                        cropMeasurements?.height ?? image.height,
                        r.width
                      )}
                </span>
              </button>
            ))}
          </div>
        )}
        <DataEntry name={t('exportPanel.resolution.finalFile')} value={dimensions.width + ' x ' + dimensions.height + ' px'} />
        <DataEntry
          name={t('exportPanel.resolution.upscaling.name')}
          value={
            cropMeasurements !== null
              ? t('exportPanel.resolution.upscaling.value', { value: formatDecimal(dimensions.width / cropMeasurements.width, 2) })
              : '-'
          }
          hint={t('exportPanel.resolution.upscaling.hint')}
        />
        {cropMeasurements !== null && dimensions.width > cropMeasurements.width ? (
          // Placed right below the "Upscaling" entry, which acts as its title.
          <Segmented
            value={upscalingMethod}
            options={UPSCALING_METHODS.map((value) => ({
              value,
              label: t('exportPanel.upscaling.' + UPSCALING_KEYS[value] + '.label'),
              hint: t('exportPanel.upscaling.' + UPSCALING_KEYS[value] + '.hint')
            }))}
            onChange={setUpscalingMethod}
          />
        ) : null}
        {cropMeasurements !== null && dimensions.width > cropMeasurements.width * 2 ? (
          <p className="sl-note">
            {upscalingMethod === 'edge-directed'
              ? t('exportPanel.upscaling.edgeDirected.over2x')
              : t('exportPanel.upscaling.lanczos.over2x')}
          </p>
        ) : null}
      </Tab>

      <Tab
        title={t('exportPanel.caption.title')}
        description={t('exportPanel.caption.description')}
        data="tab-caption"
      >
        <Toggle
          label={t('exportPanel.caption.add.label')}
          active={settings.caption}
          onChange={(v) => void writeSettings({ caption: v })}
          hint={t('exportPanel.caption.add.hint')}
        />
        {!captionAllowed(format) ? (
          <p className="sl-note">{t('exportPanel.caption.notAllowed', { format: info.name })}</p>
        ) : null}
        {settings.caption ? (
          <>
            <Segmented
              value={settings.captionModel}
              options={CAPTION_TEMPLATES.map((value) => ({
                value,
                label: t('exportPanel.caption.templates.' + value + '.label'),
                hint: t('exportPanel.caption.templates.' + value + '.hint')
              }))}
              onChange={(v) => void writeSettings({ captionModel: v })}
            />
            <p className="sl-note">{t('exportPanel.caption.templates.' + settings.captionModel + '.description')}</p>
            {settings.captionModel !== 'banner' ? (
              <>
                <Segmented
                  value={settings.captionCorner.startsWith('top') ? 'top' : 'bottom'}
                  options={[
                    { value: 'bottom', label: t('exportPanel.caption.position.bottom') },
                    { value: 'top', label: t('exportPanel.caption.position.top') }
                  ]}
                  onChange={(v) =>
                    void writeSettings({
                      captionCorner: (v +
                        '-' +
                        (settings.captionCorner.endsWith('left')
                          ? 'left'
                          : 'right')) as CaptionCorner
                    })
                  }
                />
                <Segmented
                  value={settings.captionCorner.endsWith('left') ? 'left' : 'right'}
                  options={[
                    { value: 'left', label: t('exportPanel.caption.position.left') },
                    { value: 'right', label: t('exportPanel.caption.position.right') }
                  ]}
                  onChange={(v) =>
                    void writeSettings({
                      captionCorner: ((settings.captionCorner.startsWith('top') ? 'top' : 'bottom') +
                        '-' +
                        v) as CaptionCorner
                    })
                  }
                />
              </>
            ) : null}
            <div className="sl-batch-field">
              <label className="sl-settings-label" htmlFor="sl-caption-author">
                {t('exportPanel.caption.author.label')}
              </label>
              <input
                id="sl-caption-author"
                className="sl-settings-field"
                type="text"
                value={author}
                maxLength={80}
                placeholder={t('exportPanel.caption.author.placeholder')}
                spellCheck={false}
                onChange={(e) => changeAuthor(e.target.value)}
              />
            </div>
            <Toggle
              label={t('exportPanel.caption.location.label')}
              active={settings.captionLocation}
              onChange={(v) => void writeSettings({ captionLocation: v })}
              hint={t('exportPanel.caption.location.hint')}
            />
            {captionData !== null ? (
              <p className="sl-note">
                {captionData.entries.length === 0
                  ? t('exportPanel.caption.data.none')
                  : t(
                      layout !== null && layout.displayedEntries.length < captionData.entries.length
                        ? 'exportPanel.caption.data.foundSomeOmitted'
                        : 'exportPanel.caption.data.found',
                      { entries: captionData.entries.map((v) => v.text).join(' · ') }
                    )}
              </p>
            ) : null}
            {viewerPreview !== null ? (
              <div className="sl-card-apply">
                {captionChanged ? (
                  <Label color="amber" title={t('exportPanel.caption.changed.title')}>
                    {t('exportPanel.caption.changed.label')}
                  </Label>
                ) : null}
                <Button
                  variant={signatureApplied === null || captionChanged ? 'primary' : 'secondary'}
                  icon={<ProcessIcon size={14} />}
                  onClick={() => useViewerCaption.getState().apply()}
                  title={t('exportPanel.caption.apply.title')}
                >
                  {t('exportPanel.caption.apply.label')}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Tab>

      <Tab title={t('exportPanel.summary.title')}>
        <DataEntry name={t('exportPanel.summary.format')} value={info.name} />
        <DataEntry name={t('exportPanel.summary.bitDepth')} value={t('exportPanel.summary.bitsPerChannel', { bits: info.bit === 16 ? 16 : 8 })} />
        <DataEntry
          name={t('exportPanel.summary.compression')}
          value={info.loss ? t('exportPanel.summary.lossy', { quality }) : t('exportPanel.summary.lossless')}
        />
        <DataEntry
          name={t('exportPanel.summary.filter')}
          value={
            adjustments.filter === 'none'
              ? t('exportPanel.summary.noFilter')
              : t('exportPanel.summary.filterAt', {
                  filter: filterById(adjustments.filter).name,
                  percent: Math.round(adjustments.filterIntensity * 100)
                })
          }
        />
      </Tab>

      <Button
        variant="primary"
        fullWidth
        icon={<ExportIcon size={17} />}
        onClick={() => void doExport()}
        disabledValue={inProgress || otherJob}
        data="export-button"
      >
        {inProgress ? t('exportPanel.exporting') : t('exportPanel.export')}
      </Button>
      {inProgress ? <Label color="cyan">{t('exportPanel.fullResolution')}</Label> : null}
    </>
  )
}
