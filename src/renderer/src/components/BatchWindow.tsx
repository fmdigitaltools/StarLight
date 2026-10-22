import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import type { FileHandleInfo } from '@shared/types'
import { APP_VERSION } from '@shared/version'
import { Slider, Toggle, Button, Segmented } from './Controls'
import { FolderIcon, CloseIcon, ProcessIcon, ExportIcon, TrashIcon } from './Icons'
import { useApp, NEUTRAL_ADJUSTMENTS, type Adjustments } from '../store/appStore'
import { NEUTRAL_PROCESSING, pluginsToRun, type ProcessingParams } from '@core/image/chain'
import { neutralCurves } from '@core/image/curve'
import { FORMATS } from '@core/export/encoding'
import { RESOLUTIONS } from '@core/export/resize'
import { ASPECT_RATIOS, fullCrop } from '@core/export/crop'
import { filterById } from '@core/image/photoFilters'
import { formatBytes } from '@core/memory'
import { joinPath } from '@core/project'
import {
  RecipeError,
  MODEL_NAME,
  allowedBits,
  validBits,
  readRecipe,
  outputName,
  defaultRecipe,
  serializeRecipe,
  batchSubfolder,
  timeText,
  type RecipeFormat,
  type FramingMode,
  type Recipe
} from '@core/recipe'
import { runBatch, type BatchProgress, type BatchControl, type BatchResult } from '../batch/runBatch'
import { workFolderOf, writeSettings, useSettings } from '../settings'
import { captionAllowed } from '@core/export/caption'
import { t } from '@shared/i18n/i18n'
import '../styles/batch.css'

/**
 * Batch processing window, opened from the File menu: the same recipe
 * applied to several images, each exported to its own file.
 *
 * Three phases: files, recipe and destination are prepared; the batch is
 * started and its progress followed (with the option to stop it); at the
 * end a summary reports which files succeeded and why the others did not.
 * The actual work is done by batch/runBatch.ts.
 */

type AppRecipe = Recipe<Adjustments>

interface BatchWindowState {
  isOpen: boolean
  /** Images to process, in the order they will be processed. */
  file: FileHandleInfo[]
  recipe: AppRecipe
  /** Destination folder; empty until the default one is known. */
  folder: string
  model: string
  open: () => void
  close: () => void
}

/**
 * The state persists between openings of the window: closing it to check
 * something leaves files and recipe exactly as they were.
 */
export const useBatchWindow = create<BatchWindowState>((set) => ({
  isOpen: false,
  file: [],
  recipe: defaultRecipe(NEUTRAL_ADJUSTMENTS),
  folder: '',
  model: MODEL_NAME,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false })
}))

export function BatchWindow(): JSX.Element | null {
  const open = useBatchWindow((s) => s.isOpen)
  if (!open) return null
  return createPortal(<ModalWindow />, document.body)
}

type Phase = 'setup' | 'in-progress' | 'done'

function ModalWindow(): JSX.Element {
  const close = useBatchWindow((s) => s.close)
  const [phase, setPhase] = useState<Phase>('setup')
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [result, setResult] = useState<BatchResult | null>(null)
  const [interrupting, setInterrupting] = useState(false)
  const control = useRef<BatchControl>({ interrupted: false })
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => before?.focus?.()
  }, [])

  // Default folder: the exports folder, in a subfolder named after the day.
  useEffect(() => {
    if (useBatchWindow.getState().folder !== '') return
    void workFolderOf('exports').then((c) =>
      useBatchWindow.setState({ folder: joinPath(c, batchSubfolder()) })
    )
  }, [])

  const closeIfPossible = (): void => {
    if (phase !== 'in-progress') close()
  }

  async function start(): Promise<void> {
    const { file, recipe, folder, model } = useBatchWindow.getState()
    if (file.length === 0 || folder === '') return
    control.current = { interrupted: false }
    setInterrupting(false)
    setProgress(null)
    setPhase('in-progress')
    try {
      const r = await runBatch(file, recipe, { folder, model }, setProgress, control.current)
      setResult(r)
    } catch (e) {
      // An error outside the individual files (rare) is shown as the summary.
      setResult({
        file: [],
        interrupted: true,
        skipped: file.length,
        seconds: 0,
        error: e instanceof Error ? e.message : String(e)
      } as BatchResult & { error: string })
    }
    setPhase('done')
  }

  return (
    <div className="sl-overlay" onClick={closeIfPossible}>
      <div
        ref={dialog}
        tabIndex={-1}
        className="sl-dialog sl-batch"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-batch-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            closeIfPossible()
          }
          // Keys stay in the window and never reach the viewer shortcuts.
          if (e.key !== 'F1') e.stopPropagation()
        }}
      >
        <header className="sl-dialog-head">
          <ProcessIcon size={22} />
          <div>
            <h2 className="sl-dialog-title" id="sl-batch-title">
              {t('batchWindow.title')}
            </h2>
            <p className="sl-dialog-subtitle">
              {t('batchWindow.subtitle')}
            </p>
          </div>
        </header>

        <div className="sl-dialog-body sl-batch-body">
          {phase === 'setup' ? <Preparation /> : null}
          {phase === 'in-progress' ? <InProgress progress={progress} interrupting={interrupting} /> : null}
          {phase === 'done' && result ? <Summary result={result} /> : null}
        </div>

        <footer className="sl-dialog-footer">
          {phase === 'setup' ? <PreparationFooter onStart={() => void start()} /> : null}
          {phase === 'in-progress' ? (
            <>
              <span className="sl-batch-note">
                {interrupting
                  ? t('batchWindow.progress.stoppingNote')
                  : t('batchWindow.progress.stopNote')}
              </span>
              <Button
                variant="danger"
                disabledValue={interrupting}
                onClick={() => {
                  control.current.interrupted = true
                  setInterrupting(true)
                }}
              >
                {t('batchWindow.progress.stop')}
              </Button>
            </>
          ) : null}
          {phase === 'done' ? (
            <>
              <Button variant="ghost" onClick={() => setPhase('setup')}>
                {t('batchWindow.summary.backToSetup')}
              </Button>
              <div className="sl-batch-actions">
                {result && result.file.some((f) => f.path) ? (
                  <Button
                    icon={<FolderIcon size={16} />}
                    onClick={() => {
                      const first = result.file.find((f) => f.path)?.path
                      if (first) void window.starlight.showInFolder(first)
                    }}
                  >
                    {t('batchWindow.summary.openFolder')}
                  </Button>
                ) : null}
                <Button variant="primary" icon={<CloseIcon size={15} />} onClick={close}>
                  {t('batchWindow.close')}
                </Button>
              </div>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  )
}

/* ---- Setup ---- */

function Section({ title, explanation, action, children }: {
  title: string
  explanation?: ReactNode
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="sl-batch-section">
      <header className="sl-batch-section-head">
        <h3 className="sl-guide-section-title">{title}</h3>
        {action}
      </header>
      {explanation ? <p className="sl-batch-explanation">{explanation}</p> : null}
      {children}
    </section>
  )
}

function Preparation(): JSX.Element {
  return (
    <>
      <FilesSection />
      <RecipeSection />
      <FramingSection />
      <FormatSection />
      <DestinationSection />
    </>
  )
}

/** Adds files to the list, without duplicates. */
function addFile(newOnes: FileHandleInfo[]): void {
  useBatchWindow.setState((s) => {
    const presentItems = new Set(s.file.map((f) => f.path))
    return { file: [...s.file, ...newOnes.filter((f) => !presentItems.has(f.path))] }
  })
}

function FilesSection(): JSX.Element {
  const file = useBatchWindow((s) => s.file)
  const [note, setNote] = useState<string | null>(null)

  async function fromFolder(): Promise<void> {
    const folder = await window.starlight.chooseFolder(t('batchWindow.files.chooseFolderTitle'), null)
    if (!folder) return
    const foundItems = await window.starlight.listFolder(folder)
    setNote(foundItems.length === 0 ? t('batchWindow.files.noImagesInFolder') : null)
    addFile(foundItems)
  }

  const total = file.reduce((sum, f) => sum + f.sizeBytes, 0)
  return (
    <Section
      title={t('batchWindow.files.title')}
      explanation={t('batchWindow.files.explanation')}
      action={
        file.length > 0 ? (
          <Button variant="ghost" onClick={() => useBatchWindow.setState({ file: [] })}>
            {t('batchWindow.files.clear')}
          </Button>
        ) : undefined
      }
    >
      <div className="sl-batch-row">
        <Button onClick={() => void window.starlight.chooseBatchFiles().then(addFile)}>{t('batchWindow.files.addFiles')}</Button>
        <Button icon={<FolderIcon size={16} />} onClick={() => void fromFolder()}>
          {t('batchWindow.files.addFolder')}
        </Button>
        {file.length > 0 ? (
          <span className="sl-batch-note">
            {t('batchWindow.files.summary', { images: imageCount(file.length), size: formatBytes(total) })}
          </span>
        ) : null}
      </div>
      {note ? <p className="sl-batch-notice">{note}</p> : null}
      {file.length > 0 ? (
        <ul className="sl-batch-list">
          {file.map((f) => (
            <li key={f.path} className="sl-batch-item" title={f.path}>
              <span className="sl-batch-item-name">{f.fileName}</span>
              <span className="sl-batch-item-data">{formatBytes(f.sizeBytes)}</span>
              <button
                type="button"
                className="sl-batch-remove"
                title={t('batchWindow.files.remove')}
                onClick={() => useBatchWindow.setState((s) => ({ file: s.file.filter((x) => x.path !== f.path) }))}
              >
                <TrashIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  )
}

/** "1 image" / "N images", for the file counts. */
function imageCount(n: number): string {
  return n === 1 ? t('batchWindow.imagesOne') : t('batchWindow.imagesOther', { count: n })
}

/** Language-file keys of the Process tools, for the recipe summary. */
const TOOL_NAMES: Partial<Record<keyof ProcessingParams, string>> = {
  hotPixels: 'batchWindow.tools.hotPixels',
  trails: 'batchWindow.tools.trails',
  background: 'batchWindow.tools.background',
  balance: 'batchWindow.tools.balance',
  colorNoise: 'batchWindow.tools.colorNoise',
  deconvolution: 'batchWindow.tools.deconvolution',
  nlBayes: 'batchWindow.tools.nlBayes',
  wavelets: 'batchWindow.tools.wavelets',
  narrowband: 'batchWindow.tools.narrowband',
  starReduction: 'batchWindow.tools.starReduction',
  localContrast: 'batchWindow.tools.localContrast'
}

/** Process tools turned on in the recipe, in words. */
function enabledTools(p: ProcessingParams): string[] {
  const turnedOn: string[] = []
  for (const [key, name] of Object.entries(TOOL_NAMES) as [keyof ProcessingParams, string][]) {
    // RBF background and trails have parameters even when off: they count only if they change something.
    if (key === 'trails' && !p.trails.active) continue
    if (key === 'background' && p.background === 'none') continue
    if (JSON.stringify(p[key]) !== JSON.stringify(NEUTRAL_PROCESSING[key])) turnedOn.push(t(name))
  }
  const plugin = pluginsToRun(p).length
  if (plugin > 0) turnedOn.push(plugin === 1 ? t('batchWindow.tools.pluginOne') : t('batchWindow.tools.pluginOther', { count: plugin }))
  return turnedOn
}

function changeRecipe(patch: Partial<AppRecipe>): void {
  useBatchWindow.setState((s) => ({ recipe: { ...s.recipe, ...patch } }))
}

/** The recipe taken from the open image: the fixed values currently shown. */
export function recipeFromOpenImage(): AppRecipe | null {
  const s = useApp.getState()
  if (!s.image) return null
  const current = useBatchWindow.getState().recipe
  const aspectRatio = ASPECT_RATIOS.find((p) => p.id === s.aspectRatio && p.ratio !== null)
  const active = s.frame.find((f) => f.id === s.activeFrameId)
  return {
    name: active ? t('batchWindow.recipe.likeFile', { name: active.fileName }) : t('batchWindow.recipe.likeOpenImage'),
    abracadabra: false,
    // What is actually applied to the displayed image, not the Process
    // sliders, which may not have been applied yet.
    processing: s.appliedProcessing ?? NEUTRAL_PROCESSING,
    adjustments: s.adjustments,
    // The hyperbolic stretch chosen by Abracadabra is tuned to those black
    // and white points: with GHS they are kept fixed.
    stretchPerFile: !s.adjustments.withGhs,
    curves: s.curves,
    framing: {
      // A manual crop only fits that framing: the full image is proposed,
      // but the crop remains available as an option.
      mode: aspectRatio ? 'aspect-ratio' : 'full',
      aspectRatio: aspectRatio?.id ?? 'original',
      crop: s.crop
    },
    exportSettings: current.exportSettings
  }
}

function RecipeSection(): JSX.Element {
  const recipe = useBatchWindow((s) => s.recipe)
  const withImage = useApp((s) => s.image !== null)
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  async function open(): Promise<void> {
    try {
      const readResult = await window.starlight.openRecipe(await workFolderOf('exports'))
      if (!readResult) return
      const r = readRecipe(readResult.text, NEUTRAL_ADJUSTMENTS)
      useBatchWindow.setState({ recipe: r })
      setMessage({ type: 'ok', text: t('batchWindow.recipe.opened', { name: r.name }) })
    } catch (e) {
      setMessage({
        type: 'error',
        text: e instanceof RecipeError ? e.message : t('batchWindow.recipe.openFailed', { error: String(e) })
      })
    }
  }

  async function save(): Promise<void> {
    try {
      const name = recipe.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim() || t('batchWindow.recipe.defaultFileName')
      const path = await window.starlight.saveRecipe(
        name + '.recipe',
        serializeRecipe(recipe, APP_VERSION),
        await workFolderOf('exports')
      )
      if (path) setMessage({ type: 'ok', text: t('batchWindow.recipe.saved') })
    } catch (e) {
      setMessage({ type: 'error', text: t('batchWindow.recipe.saveFailed', { error: String(e) }) })
    }
  }

  const tools = enabledTools(recipe.processing)
  const r = recipe.adjustments
  const filter =
    r.filter === 'none'
      ? null
      : t('batchWindow.recipe.filterValue', {
          name: filterById(r.filter).name,
          percent: Math.round(r.filterIntensity * 100)
        })

  return (
    <Section
      title={t('batchWindow.recipe.title')}
      explanation={t('batchWindow.recipe.explanation')}
    >
      <div className="sl-batch-row">
        <Button
          disabledValue={!withImage}
          title={withImage ? undefined : t('batchWindow.recipe.openImageFirst')}
          onClick={() => {
            const grip = recipeFromOpenImage()
            if (grip) {
              useBatchWindow.setState({ recipe: grip })
              setMessage({ type: 'ok', text: t('batchWindow.recipe.takenFromImage') })
            }
          }}
        >
          {t('batchWindow.recipe.useOpenImage')}
        </Button>
        <Button variant="ghost" onClick={() => void open()}>
          {t('batchWindow.recipe.open')}
        </Button>
        <Button variant="ghost" onClick={() => void save()}>
          {t('batchWindow.recipe.save')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            useBatchWindow.setState((s) => ({
              recipe: { ...defaultRecipe(NEUTRAL_ADJUSTMENTS), exportSettings: s.recipe.exportSettings }
            }))
            setMessage(null)
          }}
          title={t('batchWindow.recipe.restartHint')}
        >
          {t('batchWindow.recipe.restart')}
        </Button>
      </div>
      {message ? (
        <p className={message.type === 'error' ? 'sl-batch-notice' : 'sl-batch-note'}>{message.text}</p>
      ) : null}

      <div className="sl-batch-field">
        <label className="sl-settings-label" htmlFor="sl-batch-recipe-name">
          {t('batchWindow.recipe.name')}
        </label>
        <input
          id="sl-batch-recipe-name"
          className="sl-settings-field"
          type="text"
          value={recipe.name}
          spellCheck={false}
          onChange={(e) => changeRecipe({ name: e.target.value })}
        />
      </div>

      <Toggle
        label={t('batchWindow.recipe.abracadabra')}
        active={recipe.abracadabra}
        onChange={(v) => changeRecipe({ abracadabra: v })}
        hint={t('batchWindow.recipe.abracadabraHint')}
      />
      <p className="sl-batch-explanation">
        {recipe.abracadabra
          ? t('batchWindow.recipe.abracadabraOn')
          : t('batchWindow.recipe.abracadabraOff')}
      </p>

      {!recipe.abracadabra ? (
        <>
          <Toggle
            label={t('batchWindow.recipe.stretchPerFile')}
            active={recipe.stretchPerFile}
            onChange={(v) => changeRecipe({ stretchPerFile: v })}
            hint={t('batchWindow.recipe.stretchPerFileHint')}
          />
          <p className="sl-batch-explanation">
            {recipe.stretchPerFile
              ? t('batchWindow.recipe.stretchPerFileOn')
              : t('batchWindow.recipe.stretchPerFileOff')}
          </p>
        </>
      ) : null}

      <dl className="sl-batch-summary">
        <dt>{t('batchWindow.summaryList.process')}</dt>
        <dd>
          {recipe.abracadabra
            ? t('batchWindow.summaryList.processAbracadabra')
            : tools.length === 0
              ? t('batchWindow.summaryList.noTools')
              : tools.join(', ')}
        </dd>
        <dt>{t('batchWindow.summaryList.tones')}</dt>
        <dd>
          {recipe.abracadabra
            ? t('batchWindow.summaryList.tonesAbracadabra')
            : [
                r.withGhs ? t('batchWindow.summaryList.hyperbolicStretch') : t('batchWindow.summaryList.classicStretch'),
                r.saturation !== 0 ? t('batchWindow.summaryList.saturation', { value: signedPercent(r.saturation) }) : null,
                r.contrast !== 0 ? t('batchWindow.summaryList.contrast', { value: signedPercent(r.contrast) }) : null,
                r.brightness !== 0 ? t('batchWindow.summaryList.brightness', { value: signedPercent(r.brightness) }) : null
              ]
                .filter((x) => x !== null)
                .join(', ')}
        </dd>
        <dt>{t('batchWindow.summaryList.curves')}</dt>
        <dd>{neutralCurves(recipe.curves) ? t('batchWindow.summaryList.curvesNone') : t('batchWindow.summaryList.curvesModified')}</dd>
        <dt>{t('batchWindow.summaryList.filter')}</dt>
        <dd>{filter ?? t('batchWindow.summaryList.filterNone')}</dd>
      </dl>
    </Section>
  )
}

/** A fraction as a signed percentage: 0.15 → "+15%". */
function signedPercent(v: number): string {
  return (v > 0 ? '+' : '') + Math.round(v * 100) + '%'
}

function FramingSection(): JSX.Element {
  const recipe = useBatchWindow((s) => s.recipe)
  const framingSpec = recipe.framing
  const withCrop = !fullCrop(framingSpec.crop)

  const options: { value: FramingMode; label: string; hint: string }[] = [
    { value: 'full', label: t('batchWindow.framing.full'), hint: t('batchWindow.framing.fullHint') },
    {
      value: 'edges',
      label: t('batchWindow.framing.edges'),
      hint: t('batchWindow.framing.edgesHint')
    },
    { value: 'aspect-ratio', label: t('batchWindow.framing.aspectRatio'), hint: t('batchWindow.framing.aspectRatioHint') }
  ]
  if (withCrop || framingSpec.mode === 'fixed') {
    options.push({
      value: 'fixed',
      label: t('batchWindow.framing.fixed'),
      hint: t('batchWindow.framing.fixedHint')
    })
  }

  return (
    <Section title={t('batchWindow.framing.title')}>
      <Segmented<FramingMode>
        value={framingSpec.mode}
        options={options}
        onChange={(mode) => changeRecipe({ framing: { ...framingSpec, mode } })}
      />
      {framingSpec.mode === 'aspect-ratio' ? (
        <select
          className="sl-settings-select"
          value={framingSpec.aspectRatio}
          onChange={(e) => changeRecipe({ framing: { ...framingSpec, aspectRatio: e.target.value } })}
        >
          {ASPECT_RATIOS.filter((p) => p.ratio !== null).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.description}
            </option>
          ))}
        </select>
      ) : null}
      {framingSpec.mode === 'fixed' ? (
        <p className="sl-batch-explanation">
          {t('batchWindow.framing.fixedExplanation', {
            width: Math.round(framingSpec.crop.width * 100),
            height: Math.round(framingSpec.crop.height * 100)
          })}
        </p>
      ) : null}
    </Section>
  )
}

function FormatSection(): JSX.Element {
  const exportSpec = useBatchWindow((s) => s.recipe.exportSettings)
  const change = (patch: Partial<AppRecipe['exportSettings']>): void =>
    useBatchWindow.setState((s) => ({
      recipe: { ...s.recipe, exportSettings: { ...s.recipe.exportSettings, ...patch } }
    }))
  const info = FORMATS[exportSpec.format]
  const bit = allowedBits(exportSpec.format)
  const settings = useSettings()

  return (
    <Section title={t('batchWindow.format.title')}>
      <Segmented<RecipeFormat>
        value={exportSpec.format}
        options={(Object.keys(FORMATS) as RecipeFormat[]).map((f) => ({
          value: f,
          label: FORMATS[f].name,
          hint: FORMATS[f].loss ? t('batchWindow.format.lossy') : t('batchWindow.format.lossless')
        }))}
        onChange={(format) => change({ format, bit: validBits(format, exportSpec.bit) })}
      />
      {bit.length > 1 ? (
        <Segmented<string>
          value={String(exportSpec.bit)}
          options={bit.map((b) => ({
            value: String(b),
            label: b === 32 ? t('batchWindow.format.bits32') : t('batchWindow.format.bits', { bits: b }),
            hint:
              b === 32
                ? t('batchWindow.format.bits32Hint')
                : b === 8
                  ? t('batchWindow.format.bits8Hint')
                  : t('batchWindow.format.bits16Hint')
          }))}
          onChange={(v) => change({ bit: validBits(exportSpec.format, Number(v)) })}
        />
      ) : null}
      {info.loss ? (
        <Slider
          label={t('batchWindow.format.quality')}
          value={exportSpec.quality}
          min={40}
          max={100}
          step={1}
          color="amber"
          format={(v) => v + '%'}
          hint={t('batchWindow.format.qualityHint')}
          onChange={(quality) => change({ quality })}
        />
      ) : null}
      <div className="sl-batch-field">
        <label className="sl-settings-label" htmlFor="sl-batch-width">
          {t('batchWindow.format.resolution')}
        </label>
        <select
          id="sl-batch-width"
          className="sl-settings-select"
          value={exportSpec.width}
          onChange={(e) => change({ width: Number(e.target.value) })}
        >
          {RESOLUTIONS.map((r) => (
            <option key={r.name} value={r.width}>
              {r.name} · {r.description}
            </option>
          ))}
        </select>
      </div>
      {exportSpec.format === 'fits' ? (
        <Toggle
          label={t('batchWindow.format.keepMetadata')}
          active={exportSpec.keepMetadata}
          onChange={(keepMetadata) => change({ keepMetadata })}
          hint={t('batchWindow.format.keepMetadataHint')}
        />
      ) : null}
      {exportSpec.format === 'png' || exportSpec.format === 'jpeg' || exportSpec.format === 'webp' ? (
        <Toggle
          label={t('batchWindow.format.markers')}
          active={exportSpec.withMarkers}
          onChange={(withMarkers) => change({ withMarkers })}
          hint={t('batchWindow.format.markersHint')}
        />
      ) : null}
      {captionAllowed(exportSpec.format) ? (
        <Toggle
          label={t('batchWindow.format.caption')}
          active={settings.caption}
          onChange={(caption) => void writeSettings({ caption })}
          hint={t('batchWindow.format.captionHint')}
        />
      ) : null}
    </Section>
  )
}

function DestinationSection(): JSX.Element {
  const folder = useBatchWindow((s) => s.folder)
  const model = useBatchWindow((s) => s.model)
  const first = useBatchWindow((s) => s.file[0] ?? null)
  const format = useBatchWindow((s) => s.recipe.exportSettings.format)
  const example = outputName(model, first?.fileName ?? 'M_27.fit', null, 1) + '.' + FORMATS[format].extension
  // The template tokens stay as the recipe reads them; the example file name goes in its own span.
  const exampleParts = t('batchWindow.destination.tokens', {
    nameToken: '{nome}',
    objectToken: '{oggetto}',
    numberToken: '{n}'
  }).split('{example}')

  return (
    <Section title={t('batchWindow.destination.title')}>
      <div className="sl-batch-row">
        <span className="sl-settings-path" title={folder}>
          {folder || '…'}
        </span>
        <Button
          icon={<FolderIcon size={16} />}
          onClick={() =>
            void window.starlight
              .chooseFolder(t('batchWindow.destination.chooseFolderTitle'), folder)
              .then((c) => {
                if (c) useBatchWindow.setState({ folder: c })
              })
          }
        >
          {t('batchWindow.destination.change')}
        </Button>
      </div>
      <div className="sl-batch-field">
        <label className="sl-settings-label" htmlFor="sl-batch-template">
          {t('batchWindow.destination.fileName')}
        </label>
        <input
          id="sl-batch-template"
          className="sl-settings-field"
          type="text"
          value={model}
          spellCheck={false}
          onChange={(e) => useBatchWindow.setState({ model: e.target.value })}
        />
      </div>
      <p className="sl-batch-explanation">
        {exampleParts[0]}
        <span className="sl-mono">{example}</span>
        {exampleParts.slice(1).join(example)}
      </p>
    </Section>
  )
}

function PreparationFooter({ onStart }: { onStart: () => void }): JSX.Element {
  const close = useBatchWindow((s) => s.close)
  const n = useBatchWindow((s) => s.file.length)
  const folder = useBatchWindow((s) => s.folder)
  // A stacking or processing job in progress already uses all the cores.
  const busy = useApp((s) => s.job.active)
  return (
    <>
      <span className="sl-batch-note">
        {busy
          ? t('batchWindow.setup.waitForJob')
          : n === 0
            ? t('batchWindow.setup.addImage')
            : t('batchWindow.setup.ready', { images: imageCount(n) })}
      </span>
      <div className="sl-batch-actions">
        <Button variant="ghost" onClick={close}>
          {t('batchWindow.close')}
        </Button>
        <Button
          variant="primary"
          icon={<ExportIcon size={16} />}
          disabledValue={n === 0 || folder === '' || busy}
          onClick={onStart}
          data="batch-start"
        >
          {t('batchWindow.setup.start')}
        </Button>
      </div>
    </>
  )
}

/* ---- Progress ---- */

function InProgress({ progress, interrupting }: { progress: BatchProgress | null; interrupting: boolean }): JSX.Element {
  const a = progress
  const total = a ? (a.index + a.fileFraction) / a.total : 0
  return (
    <div className="sl-batch-running" aria-live="polite">
      <p className="sl-batch-running-title">
        {a
          ? t('batchWindow.progress.image', { index: a.index + 1, total: a.total, name: a.fileName })
          : t('batchWindow.progress.preparing')}
      </p>
      <div className="sl-batch-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(total * 100)}>
        <div className="sl-batch-bar-fill" style={{ width: Math.round(total * 100) + '%' }} />
      </div>
      <p className="sl-batch-note">
        {a ? a.phase.charAt(0).toUpperCase() + a.phase.slice(1).replace(/…$/, '') + '…' : ''}
      </p>
      <p className="sl-batch-note">
        {interrupting
          ? t('batchWindow.progress.stopping')
          : a && a.secondsRemaining !== null
            ? t('batchWindow.progress.remaining', { time: timeText(a.secondsRemaining) })
            : t('batchWindow.progress.remainingUnknown')}
      </p>
    </div>
  )
}

/* ---- Summary ---- */

function Summary({ result }: { result: BatchResult & { error?: string } }): JSX.Element {
  const succeeded = result.file.filter((f) => f.result === 'succeeded')
  const failedItems = result.file.filter((f) => f.result === 'failed')
  const counts = [
    succeeded.length === 1
      ? t('batchWindow.summary.writtenOne')
      : t('batchWindow.summary.writtenOther', { count: succeeded.length })
  ]
  if (failedItems.length > 0)
    counts.push(
      failedItems.length === 1
        ? t('batchWindow.summary.failedOne')
        : t('batchWindow.summary.failedOther', { count: failedItems.length })
    )
  if (result.interrupted && result.skipped > 0)
    counts.push(
      result.skipped === 1
        ? t('batchWindow.summary.skippedOne')
        : t('batchWindow.summary.skippedOther', { count: result.skipped })
    )
  const status = result.interrupted ? t('batchWindow.summary.interrupted') : t('batchWindow.summary.completed')
  return (
    <div className="sl-batch-report">
      <p className="sl-batch-running-title">
        {result.seconds > 0
          ? t('batchWindow.summary.lineWithTime', { status, counts: counts.join(', '), time: elapsedTime(result.seconds) })
          : t('batchWindow.summary.line', { status, counts: counts.join(', ') })}
      </p>
      {result.error ? <p className="sl-batch-notice">{t('batchWindow.summary.error', { error: result.error })}</p> : null}
      <ul className="sl-batch-list">
        {result.file.map((f) => (
          <li key={f.sourcePath} className="sl-batch-item sl-batch-item-result">
            <span className={'sl-batch-mark ' + (f.result === 'succeeded' ? 'sl-batch-ok' : 'sl-batch-ko')}>
              {f.result === 'succeeded' ? t('batchWindow.summary.fileDone') : t('batchWindow.summary.fileFailed')}
            </span>
            <span className="sl-batch-item-name" title={f.sourcePath}>
              {f.fileName}
            </span>
            <span className="sl-batch-item-data sl-selectable" title={f.path ?? f.reason}>
              {f.result === 'succeeded' ? '→ ' + (f.path ?? '').split(/[\\/]/).pop() : f.reason}
            </span>
            {f.notices.length > 0 ? <span className="sl-batch-item-warnings sl-selectable">{f.notices.join(' ')}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function elapsedTime(seconds: number): string {
  const secondsText = (n: number): string =>
    n === 1 ? t('batchWindow.time.secondsOne') : t('batchWindow.time.secondsOther', { count: n })
  if (seconds < 60) return secondsText(Math.max(1, Math.round(seconds)))
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  const minutes = m === 1 ? t('batchWindow.time.minutesOne') : t('batchWindow.time.minutesOther', { count: m })
  return s > 0 ? t('batchWindow.time.minutesAndSeconds', { minutes, seconds: secondsText(s) }) : minutes
}
