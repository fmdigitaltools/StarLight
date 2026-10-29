import { useCallback } from 'react'
import type { FileHandleInfo, LoadedFrame, ImageData32 } from '@shared/types'
import { readFits, FitsError } from '@core/fits/reader'
import { debayer } from '@core/image/debayer'
import { computeImageStats } from '@core/image/stats'
import { autoStretch } from '@core/image/stretch'
import { ImageCache, recommendedBudget } from '@core/memory'
import { useApp } from '../store/appStore'
import { recognizeObjects } from '@core/catalog/recognition'
import { abracadabraFinish, knownLinear, openingStretch } from '@core/image/abracadabraFinish'
import { abracadabraProcessing } from '@core/image/chain'
import { dualBandFile } from '@core/image/narrowband'
import { runProcessing } from './useProcessing'
import { readSettings, subscribeSettings } from '../settings'
import { previewFromImage } from './framePreviews'
import { readHeaders } from './fileHeader'
import { hasRawExtension } from '@core/raw/rawFormats'
import { analysisWorkerPool } from '../workers/pool'
import { useViewerCrop } from './viewerCrop'
import { keysOf } from '../shortcuts'
import { confirmImageChange } from './useProject'
import { t, formatDecimal, formatNumber } from '@shared/i18n/i18n'

/** The notice about Abracadabra's edge crop is shown once per session. */
let cropDataNotice = false

/**
 * Cache of decoded frames, shared by the whole application.
 * The budget is adjusted to the installed memory at first startup.
 */
export const frameCache = new ImageCache(recommendedBudget(8 * 1073741824))

/** Automatic budget, recomputed once the installed memory is known. */
let automaticBudget = recommendedBudget(8 * 1073741824)

/** Applies the budget chosen in the settings, or the automatic one. */
function applyFrameBudget(): void {
  const gb = readSettings().frameMemoryGB
  frameCache.setBudget(gb > 0 ? gb * 1073741824 : automaticBudget)
}

void window.starlight.systemInfo().then((info) => {
  const ram = Number(info['totalRam'])
  if (Number.isFinite(ram) && ram > 0) automaticBudget = recommendedBudget(ram)
  applyFrameBudget()
})
subscribeSettings(applyFrameBudget)

/*
 * A frame that leaves the library (removed, library emptied, project closed)
 * leaves the cache too: otherwise its pixels would stay in memory until the
 * budget filled up, gigabytes on a large RAW.
 */
useApp.subscribe((s, before) => {
  if (s.frame === before.frame) return
  frameCache.keepOnly(new Set(s.frame.map((f) => f.path)))
})

/** Enough bytes to hold the header even of the most verbose files. */
const HEAD_BYTES = 64800

let idCounter = 0

/**
 * Incremented on every frame open: if another frame was requested in the
 * meantime, the older open discards its result, so the viewer keeps the last
 * frame chosen even if the first one is slower.
 */
let openGeneration = 0
/** True while the progress indicator belongs to a frame being opened. */
let opening = false

/*
 * There is a single progress indicator: opening, importing or exporting
 * during a long job (stacking, processing, saving) would turn it off too
 * early and unlock the commands. Until that job finishes, these operations
 * are refused with a notice.
 */
export function jobInProgress(): boolean {
  const s = useApp.getState()
  if (!s.job.active) return false
  s.notify('warning', t('hooksUseLibrary.busy'))
  return true
}

/** Empty initial statistics, used until the frame is opened. */
const EMPTY_STATISTICS = {
  min: 0,
  max: 0,
  mean: 0,
  median: 0,
  stdDev: 0,
  mad: 0,
  saturatedPct: 0
}

export function useLibrary(): {
  importFile: () => Promise<void>
  importFolder: () => Promise<void>
  importTelescope: () => Promise<void>
  importList: (file: FileHandleInfo[]) => Promise<void>
  /** False if opening did not start (job in progress or confirmation cancelled). */
  openFrame: (id: string) => Promise<boolean>
  applyAutostretch: () => void
  magicWand: () => Promise<void>
  resetView: () => void
} {
  const addFrame = useApp((s) => s.addFrame)
  const setActiveFrame = useApp((s) => s.setActiveFrame)
  const notify = useApp((s) => s.notify)
  const setJob = useApp((s) => s.setJob)
  const finishJob = useApp((s) => s.finishJob)
  const updateAdjustments = useApp((s) => s.updateAdjustments)
  const setObjects = useApp((s) => s.setObjects)

  /** Reads the metadata of a list of files and adds them to the library. */
  const loadList = useCallback(
    async (file: FileHandleInfo[]): Promise<void> => {
      if (file.length === 0) return
      if (jobInProgress()) return

      const newOnes: LoadedFrame[] = []
      const errors: string[] = []

      // Several files at a time: RAW files, which must be read in full, go
      // through a small worker pool (see readHeaders).
      setJob(t('hooksUseLibrary.job.readingMetadata', { count: file.length }), 0)
      const results = await readHeaders(file, HEAD_BYTES, (finished) =>
        setJob(
          t('hooksUseLibrary.job.readingMetadataProgress', { done: finished, total: file.length }),
          finished / file.length
        )
      )
      for (let i = 0; i < file.length; i++) {
        const f = file[i]
        const result = results[i]
        if ('error' in result) {
          errors.push(f.fileName + ': ' + result.error)
          continue
        }
        const info = result.info
        newOnes.push({
          id: 'f' + ++idCounter,
          path: f.path,
          fileName: f.fileName,
          sizeBytes: f.sizeBytes,
          width: info.width,
          height: info.height,
          channels: (info.header.cards['NAXIS3'] === 3 ? 3 : 1) as 1 | 3,
          bitpix: info.bitpix,
          metadata: info.metadata,
          header: info.header,
          stats: EMPTY_STATISTICS,
          quality: null,
          excluded: false
        })
      }

      finishJob()
      addFrame(newOnes)

      if (newOnes.length > 0) {
        notify(
          'ok',
          newOnes.length === 1
            ? t('hooksUseLibrary.importedOne')
            : t('hooksUseLibrary.importedOther', { count: newOnes.length })
        )
        // The first frame is opened right away, so the viewer is not left empty.
        const alreadyOpen = useApp.getState().activeFrameId !== null
        if (!alreadyOpen) await openFrameInternal(newOnes[0])
      }

      if (errors.length > 0) {
        notify('warning', t('hooksUseLibrary.unreadableFiles', { count: errors.length, error: errors[0] }))
      }
    },
    [addFrame, notify, setJob, finishJob]
  )

  /** Decodes and displays a frame, using the cache when possible. */
  const openFrameInternal = useCallback(
    async (frame: LoadedFrame): Promise<void> => {
      const ownGeneration = ++openGeneration
      const exceeded = (): boolean => ownGeneration !== openGeneration
      try {
        let image: ImageData32 | null = frameCache.read(frame.path)

        if (!image) {
          opening = true
          setJob(t('hooksUseLibrary.job.opening', { file: frame.fileName }), 0.35)
          const buffer = await window.starlight.readFile(frame.path)
          // An open requested after this one takes precedence: it shows its
          // own frame and turns off the indicator.
          if (exceeded()) return
          if (hasRawExtension(frame.fileName)) {
            // A RAW file takes LibRaw half a second to two seconds: an analysis
            // worker decodes it, so the window does not freeze.
            const r = await analysisWorkerPool().analyze({
              id: frame.id,
              path: frame.path,
              buffer,
              withStars: false,
              fileName: frame.fileName
            })
            if (exceeded()) return
            if (r.result === 'error' || !r.data) throw new Error(r.message ?? t('hooksUseLibrary.rawReadFailed'))
            image = {
              width: r.width as number,
              height: r.height as number,
              channels: r.channels as 1 | 3,
              data: new Float32Array(r.data)
            }
          } else {
            const result = readFits(new Uint8Array(buffer), frame.fileName)
            setJob(t('hooksUseLibrary.job.debayer'), 0.7)
            image = debayer(result.image, result.metadata.bayer)
          }
          frameCache.write(frame.path, image)
        }

        setActiveFrame(frame.id, image)
        // The pixels are already in memory: the library thumbnail is derived
        // from them without rereading the file.
        previewFromImage(frame.path, image, frame.metadata.frameType !== 'stacked')

        // Statistics and automatic stretch on first open (none for files
        // that arrive already stretched).
        const stats = computeImageStats(image)
        const stretch = openingStretch(image, frame.metadata, frame.bitpix)
        updateAdjustments({ stretch })

        // Update the frame statistics in the library.
        useApp.setState((s) => ({
          frame: s.frame.map((f) => (f.id === frame.id ? { ...f, stats } : f))
        }))

        setObjects(recognizeObjects(frame.metadata))
        opening = false
        finishJob()
      } catch (e) {
        if (exceeded()) return
        opening = false
        finishJob()
        const message = e instanceof FitsError || e instanceof Error ? e.message : String(e)
        notify('error', t('hooksUseLibrary.openFailed', { message }))
      }
    },
    [setActiveFrame, updateAdjustments, setJob, finishJob, notify, setObjects]
  )

  /** Notice for a file picker that failed. */
  const choiceFailed = useCallback(
    (e: unknown): void => {
      notify('error', t('hooksUseLibrary.importFailed', { message: e instanceof Error ? e.message : String(e) }))
    },
    [notify]
  )

  const importFile = useCallback(async (): Promise<void> => {
    if (jobInProgress()) return
    let file: FileHandleInfo[]
    try {
      file = await window.starlight.openFile()
    } catch (e) {
      choiceFailed(e)
      return
    }
    await loadList(file)
  }, [loadList, choiceFailed])

  const importTelescope = useCallback(async (): Promise<void> => {
    const folder = readSettings().telescopeFolder.trim().replace(/^"(.*)"$/, '$1')
    if (folder === '') return
    if (jobInProgress()) return
    let result: Awaited<ReturnType<typeof window.starlight.openTelescopeFile>>
    try {
      result = await window.starlight.openTelescopeFile(folder)
    } catch (e) {
      choiceFailed(e)
      return
    }
    if (!result.reachable) {
      notify('warning', t('hooksUseLibrary.telescopeUnreachable'))
      return
    }
    await loadList(result.file)
  }, [loadList, notify, choiceFailed])

  const importFolder = useCallback(async (): Promise<void> => {
    if (jobInProgress()) return
    let file: FileHandleInfo[] | null
    try {
      file = await window.starlight.openFolder()
    } catch (e) {
      choiceFailed(e)
      return
    }
    // Selection cancelled: no notice.
    if (file === null) return
    if (file.length === 0) {
      notify('warning', t('hooksUseLibrary.noImagesInFolder'))
      return
    }
    await loadList(file)
  }, [loadList, notify, choiceFailed])

  const openFrame = useCallback(
    async (id: string): Promise<boolean> => {
      // During another open a different frame can be chosen (the last one
      // wins); during a long job it cannot.
      if (!opening && jobInProgress()) return false
      if (!useApp.getState().frame.some((f) => f.id === id)) return false
      // The frame is reread from its file: an unsaved result or unsaved
      // processing would be lost, so the user is asked first.
      if (!(await confirmImageChange())) return false
      const frame = useApp.getState().frame.find((f) => f.id === id)
      if (!frame) return false
      await openFrameInternal(frame)
      return true
    },
    [openFrameInternal]
  )

  /**
   * Restores the image as it was when opened: removes the magic wand
   * cleanup, resets the adjustments and recomputes the automatic stretch,
   * that is, the starting point.
   */
  const resetView = useCallback((): void => {
    const state = useApp.getState()
    const image = state.originalImage ?? state.image
    if (!image) return
    const opened = state.frame.find((f) => f.id === state.activeFrameId)
    state.resetView(openingStretch(image, opened?.metadata, opened?.bitpix ?? 16))
    notify('info', t('hooksUseLibrary.viewReset'))
  }, [notify])

  const applyAutostretch = useCallback((): void => {
    const image = useApp.getState().image
    if (!image) return
    updateAdjustments({ stretch: autoStretch(image) })
    notify('ok', t('hooksUseLibrary.autostretchApplied'))
  }, [updateAdjustments, notify])

  /**
   * Abracadabra (the "magic wand"): prepares the image in one click.
   *
   * Runs the same chain as the Process step, with every tool tuned by
   * measuring the image (hot pixels, sky background, color, deconvolution,
   * NL-Bayes, wavelets, stars, local contrast), then sets stretch and color
   * on the processed image and suggests cropping the noisy edges. The chosen
   * values stay visible and editable in the Process and Correct panels. It
   * always starts from the original image, and Reset returns to the image as
   * opened.
   */
  const magicWand = useCallback(async (): Promise<void> => {
    const state = useApp.getState()
    if (!(state.originalImage ?? state.image) || state.job.active) return
    const strength = readSettings().abracadabraStrength

    let result
    try {
      result = await runProcessing(abracadabraProcessing(strength), true, 'Abracadabra')
    } catch (error) {
      notify(
        'error',
        t('hooksUseLibrary.abracadabra.failed', { message: error instanceof Error ? error.message : String(error) })
      )
      return
    }
    if (!result) return
    const now = useApp.getState()
    now.setProcessedImage(result.image, result.parameters, result.geometry)
    now.setProcessing(result.parameters)

    // Stretch, color and edge crop measured on the processed image: the same
    // computation as batch processing.
    const shown = now.frame.find((f) => f.id === now.activeFrameId)
    const finish = abracadabraFinish(result.image, result.measurements, knownLinear(shown?.metadata), shown?.bitpix, strength)
    now.resetCurves()
    updateAdjustments(finish.adjustments)

    const m = result.measurements
    const doneItems: string[] = []
    const cropRegion = finish.crop !== null
    if (finish.crop) now.setCrop(finish.crop)
    if (m) {
      if (m.correctedPixels > 0) {
        const count = formatNumber(m.correctedPixels)
        doneItems.push(t('hooksUseLibrary.abracadabra.hotPixels', { count }))
      }
      if (m.trails > 0) {
        doneItems.push(
          m.trails === 1
            ? t('hooksUseLibrary.abracadabra.trailsOne')
            : t('hooksUseLibrary.abracadabra.trailsOther', { count: m.trails })
        )
      }
      if (m.backgroundUnevenness > 3) {
        doneItems.push(
          t('hooksUseLibrary.abracadabra.background', { percent: formatDecimal(m.backgroundUnevenness, 0) })
        )
      }
      const [gr, , gb] = m.starGains
      if (Math.abs(gr - gb) > 0.03) doneItems.push(t('hooksUseLibrary.abracadabra.starColor'))
      if (cropRegion) doneItems.push(t('hooksUseLibrary.abracadabra.crop'))
    }
    doneItems.push(t('hooksUseLibrary.abracadabra.noiseAndDetail'))
    // Narrowband palettes alter colors unfaithfully: it is only suggested.
    if (dualBandFile(now.frame.find((f) => f.id === now.activeFrameId)?.metadata.filter)) {
      doneItems.push(t('hooksUseLibrary.abracadabra.dualBand'))
    }
    notify('ok', t('hooksUseLibrary.abracadabra.done', { items: doneItems.join('; ') }))
    // With the Crop button off, the edge crop is not visible in the viewer:
    // this is pointed out once, the first time it happens.
    if (cropRegion && !cropDataNotice && !useViewerCrop.getState().on) {
      cropDataNotice = true
      notify('info', t('hooksUseLibrary.abracadabra.cropNotice', { key: keysOf('crop') }))
    }
  }, [updateAdjustments, notify])

  return {
    importFile,
    importFolder,
    importTelescope,
    importList: loadList,
    openFrame,
    applyAutostretch,
    magicWand,
    resetView
  }
}

/**
 * Files passed at startup, if any: the FITS files to import and the project
 * to open. Used when a file is opened by double-clicking it in Windows.
 */
export async function fileFromCommandLine(): Promise<{ fits: FileHandleInfo[]; project: string | null }> {
  try {
    return await window.starlight.initialFiles()
  } catch {
    return { fits: [], project: null }
  }
}
