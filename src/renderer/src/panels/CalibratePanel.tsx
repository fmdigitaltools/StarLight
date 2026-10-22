import { useMemo, useState, type JSX } from 'react'
import { useApp, type SessionMaster } from '../store/appStore'
import { Tab, Button, Label, Toggle } from '../components/Controls'
import { CalibrateIcon } from '../components/Icons'
import { createMaster, countDefectivePixels, type MasterType } from '@core/stack/calibration'
import { sharedImage } from '@shared/sharedMemory'
import { correctFlat, canonicalMaster, type MasterEntry } from '@core/stack/calibrationLibrary'
import { expand, type KeptMaster } from '@core/stack/compactFrame'
import {
  masterConditions,
  describeGroup,
  lightResult,
  groupCalibration,
  summarizeCalibration,
  flatCorrectionChoice,
  chooseForLight,
  sessionEntry,
  type CalibrationFrame,
  type RejectedFrame,
  type CalibrationGroup,
  type ChosenMaster
} from '@core/stack/calibrationGroups'
import { hasRawExtension } from '@core/raw/rawFormats'
import { loadMaster, conditionsOf, saveToLibrary, useCalibrationLibrary } from '../calibration/library'
import { useSettings } from '../settings'
import { CalibrationLibraryTab } from './CalibrationLibraryTab'
import { analysisWorkerPool } from '../workers/pool'
import type { FrameMetadata, ImageData32, LoadedFrame } from '@shared/types'
import { formatNumber, t } from '@shared/i18n/i18n'

/** The three types of calibration frames; name and explanation are under calibratePanel.types.<type>. */
const TYPES: MasterType[] = ['dark', 'flat', 'bias']

/** Biases and darks are used to correct the flats, so they are built first. */
const ORDER: MasterType[] = ['bias', 'dark', 'flat']

/** Channels of the reconstructed image: raw frames from a color sensor become RGB. */
function rebuiltChannels(f: LoadedFrame): 1 | 3 {
  return f.channels === 3 || f.metadata.bayer !== 'NONE' || hasRawExtension(f.fileName) ? 3 : 1
}

function asCalibrationFrame(f: LoadedFrame): CalibrationFrame | null {
  const type = f.metadata.frameType
  if (f.excluded || (type !== 'dark' && type !== 'flat' && type !== 'bias')) return null
  return { id: f.id, name: f.fileName, path: f.path, type, width: f.width, height: f.height, channels: rebuiltChannels(f), meta: f.metadata }
}

/** Text for `count` items, choosing between the `<key>One` and `<key>Other` language keys. */
function plural(count: number, key: string, params: Record<string, string | number> = {}): string {
  return t(key + (count === 1 ? 'One' : 'Other'), { count, ...params })
}


/** Suffix describing how a flat master was corrected, if it was. */
function correctionSuffix(correction: 'dark' | 'bias' | null | undefined): string {
  return correction === 'dark'
    ? t('calibratePanel.correctedWithDark')
    : correction === 'bias'
      ? t('calibratePanel.correctedWithBias')
      : ''
}

/** Text of the notice about the rejected frames of one type. */
function rejectedText(type: MasterType, rejected: RejectedFrame[]): string {
  const first = rejected[0]
  return plural(rejected.length, 'calibratePanel.rejected', {
    type,
    name: first.frame.name,
    reason: first.reason,
    others: rejected.slice(1).map((s) => s.frame.name).join(', ')
  })
}

export function CalibratePanel(): JSX.Element {
  const frame = useApp((s) => s.frame)
  const master = useApp((s) => s.master)
  const withCalibration = useApp((s) => s.withCalibration)
  const setMaster = useApp((s) => s.setMaster)
  const setUseCalibration = useApp((s) => s.setUseCalibration)
  const setJob = useApp((s) => s.setJob)
  const finishJob = useApp((s) => s.finishJob)
  const notify = useApp((s) => s.notify)
  const libraryEntries = useCalibrationLibrary((s) => s.entries)
  const settings = useSettings()

  const [inProgress, setInProgress] = useState<MasterType | 'all' | null>(null)

  // Groups by capture conditions, recomputed when the frames change.
  const grouping = useMemo(
    () => groupCalibration(frame.map(asCalibrationFrame).filter((f): f is CalibrationFrame => f !== null)),
    [frame]
  )
  const lightConditions = useMemo(
    () =>
      frame
        .filter((f) => !f.excluded && f.metadata.frameType === 'light')
        .map((f) => conditionsOf(f.metadata, f.width, f.height, rebuiltChannels(f))),
    [frame]
  )

  // How the groups will be used: the entries they will have once built (the
  // conditions come from the headers), evaluated with the stacking rules.
  const expectedItems = useMemo(() => grouping.groups.map((g) => sessionEntry(g.key, g.conditions)), [grouping])
  const libraryForLights = useMemo(() => (settings.calibrationLibrary ? libraryEntries : []), [settings.calibrationLibrary, libraryEntries])
  const uses = useMemo(() => {
    // For flats: the filter of each flat group corrected by this master (null when not declared).
    const perGroup = new Map<string, { lights: number; flat: (string | null)[] }>()
    for (const v of expectedItems) perGroup.set(v.id, { lights: 0, flat: [] })
    for (const c of lightConditions) {
      const s = chooseForLight(expectedItems, libraryForLights, c)
      for (const m of [s.dark, s.flat, s.bias]) {
        const u = m && m.origin === 'session' ? perGroup.get(m.entry.id) : undefined
        if (u) u.lights++
      }
    }
    for (const g of grouping.groups) {
      if (g.type !== 'flat') continue
      const corr = flatCorrectionChoice(expectedItems, libraryEntries, g.conditions)
      const u = corr && corr.choice.origin === 'session' ? perGroup.get(corr.choice.entry.id) : undefined
      if (u) u.flat.push(g.conditions.filter || null)
    }
    // Lights that will be left without a suitable dark, grouped.
    const withoutDark = summarizeCalibration(
      lightConditions.map((c) => lightResult(chooseForLight(expectedItems, libraryForLights, c), c, [...expectedItems, ...libraryForLights]))
    ).filter((g) => !g.dark && g.withoutDark)
    return { perGroup, withoutDark }
  }, [expectedItems, lightConditions, libraryForLights, libraryEntries, grouping])

  /** Reads the frames of a group and combines them into a master; for flats, also applies the correction. */
  async function composeGroup(
    g: CalibrationGroup,
    advance: (readCount: number) => void
  ): Promise<{ composedValue: SessionMaster; correction: 'dark' | 'bias' | null; kept: boolean }> {
    const workerPool = analysisWorkerPool()
    const images: ImageData32[] = []
    const meta: FrameMetadata[] = []
    let readCount = 0
    await Promise.all(
      g.frame.map(async (f) => {
        const buffer = await window.starlight.readFile(f.path)
        // Calibration frames contain no stars to detect.
        const response = await workerPool.analyze({ id: f.id, path: f.path, buffer, withStars: false, fileName: f.name })
        if (response.result === 'ok' && response.data) {
          images.push({
            width: response.width as number,
            height: response.height as number,
            channels: response.channels as 1 | 3,
            data: new Float32Array(response.data)
          })
          meta.push(f.meta)
        }
        advance(++readCount)
      })
    )
    if (images.length === 0) throw new Error(t('calibratePanel.noReadableFrames'))

    // Canonical form: the same master that will later be read back from the library.
    let result = canonicalMaster(createMaster(images), g.frame[0].meta.bayer)
    const conditions = masterConditions(g.type, result.width, result.height, result.channels, meta)

    // The flat is corrected for the readout level before normalization: with
    // the dark matching the flats' exposure or, failing that, with the bias
    // of their gain. Masters built in this session first, then the library.
    let correction: 'dark' | 'bias' | null = null
    if (g.type === 'flat') {
      const session = useApp.getState().master.groups
      const choice = flatCorrectionChoice(
        session.map((m) => m.entry),
        useCalibrationLibrary.getState().entries,
        conditions
      )
      if (choice) {
        const imageOf = (m: ChosenMaster): Promise<KeptMaster> | KeptMaster | undefined =>
          m.origin === 'session' ? session.find((s) => s.entry.id === m.entry.id)?.image : loadMaster(m.entry)
        const toSubtract = await imageOf(choice.choice)
        if (toSubtract) {
          // A library master is stored compact: it is expanded in full only
          // for this subtraction.
          result = correctFlat(result, expand(toSubtract))
          correction = choice.type
        }
      }
    }

    // Shared memory: the master travels with the compact frames to the
    // stacking workers, which therefore do not receive copies of it.
    result = sharedImage(result)
    const defective = g.type === 'dark' ? countDefectivePixels(result) : 0
    const entry: MasterEntry = sessionEntry(g.key, conditions, { defectivePixels: defective, flatCorrection: correction })

    // Each group is stored in the library as a master of its own.
    let kept = true
    try {
      await saveToLibrary(g.type, result, meta, defective, correction)
    } catch {
      kept = false
    }
    return { composedValue: { entry, image: result }, correction, kept }
  }

  /** Builds one master per group of the given type, replacing the previous ones. */
  async function composeType(type: MasterType): Promise<void> {
    const groups = grouping.groups.filter((g) => g.type === type)
    const rejected = grouping.rejected.filter((s) => s.frame.type === type)
    if (groups.length === 0) {
      notify('warning', rejected.length > 0 ? rejectedText(type, rejected) : t('calibratePanel.noFramesOfType', { type }))
      return
    }

    const total = groups.reduce((sum, g) => sum + g.frame.length, 0)
    let doneItems = 0
    const composedItems: SessionMaster[] = []
    const lines: string[] = []
    const failedItems: string[] = []
    let notKept = 0
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k]
      const name = describeGroup(g.conditions, g.night)
      const base = doneItems
      setJob(
        groups.length > 1
          ? t('calibratePanel.job.masterOfMany', { index: k + 1, total: groups.length, name })
          : t('calibratePanel.job.master', { name }),
        0.05 + (base / total) * 0.9
      )
      try {
        const result = await composeGroup(g, (readCount) =>
          setJob(
            t('calibratePanel.job.reading', { name, read: readCount, total: g.frame.length }),
            0.05 + ((base + readCount) / total) * 0.9
          )
        )
        composedItems.push(result.composedValue)
        if (!result.kept) notKept++
        lines.push(
          t('calibratePanel.composedLine', {
            group: describeGroup(result.composedValue.entry, g.night),
            frames: plural(result.composedValue.entry.frame, 'calibratePanel.frames'),
            correction: correctionSuffix(result.correction)
          })
        )
      } catch (e) {
        failedItems.push(name + ': ' + (e instanceof Error ? e.message : String(e)))
      }
      doneItems += g.frame.length
    }

    // Masters of this type replace those built before.
    const others = useApp.getState().master.groups.filter((m) => m.entry.type !== type)
    setMaster({ groups: [...others, ...composedItems] })
    finishJob()

    if (composedItems.length > 0) {
      const keptItems =
        notKept === 0
          ? t(composedItems.length === 1 ? 'calibratePanel.keptOne' : 'calibratePanel.keptOther')
          : plural(notKept, 'calibratePanel.notKept')
      notify(
        notKept === 0 ? 'ok' : 'warning',
        plural(composedItems.length, 'calibratePanel.composed', { type, lines: lines.join('; '), kept: keptItems })
      )
    }
    if (failedItems.length > 0) {
      notify('error', plural(failedItems.length, 'calibratePanel.failed', { details: failedItems.join('; ') }))
    }
    if (rejected.length > 0) notify('warning', rejectedText(type, rejected))
  }

  async function compose(whichItems: MasterType | 'all'): Promise<void> {
    setInProgress(whichItems)
    try {
      for (const type of whichItems === 'all' ? ORDER : [whichItems]) {
        if (whichItems === 'all' && !grouping.groups.some((g) => g.type === type) && !grouping.rejected.some((s) => s.frame.type === type)) continue
        await composeType(type)
      }
    } catch (e) {
      finishJob()
      notify('error', t('calibratePanel.masterNotCreated', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setInProgress(null)
    }
  }

  const composedItems = new Map(master.groups.map((m) => [m.entry.id, m]))
  const hasSomething = master.groups.length > 0
  const hasFrame = grouping.groups.length > 0 || grouping.rejected.length > 0

  const usageOf = (g: CalibrationGroup, id: string): string => {
    const u = uses.perGroup.get(id)
    const lights = u && u.lights > 0 ? plural(u.lights, 'calibratePanel.usage.lights') : null
    const flats =
      u && u.flat.length > 0
        ? t('calibratePanel.usage.flatCorrection', {
            filters: [...new Set(u.flat)]
              .map((f) => (f !== null ? t('calibratePanel.usage.filter', { filter: f }) : t('calibratePanel.usage.noFilter')))
              .join(', ')
          })
        : null
    if (lights && flats) return t('calibratePanel.usage.both', { lights, flats })
    if (lights || flats) return (lights ?? flats) as string
    if (lightConditions.length === 0) return t('calibratePanel.usage.noLightsLoaded')
    if (g.type === 'bias') return t('calibratePanel.usage.biasNotUsed')
    return t('calibratePanel.usage.noMatchingLights')
  }

  return (
    <>
      <Tab
        title={t('calibratePanel.intro.title')}
        description={t('calibratePanel.intro.description')}
        data="tab-calibrate"
      >
        <Toggle
          label={t('calibratePanel.intro.apply.label')}
          active={withCalibration}
          onChange={setUseCalibration}
          hint={t('calibratePanel.intro.apply.hint')}
        />
        {hasFrame ? (
          <Button
            fullWidth
            variant="primary"
            icon={<CalibrateIcon size={16} />}
            disabledValue={inProgress !== null}
            onClick={() => void compose('all')}
            title={t('calibratePanel.intro.composeAll.title')}
          >
            {inProgress === 'all' ? t('calibratePanel.composing') : t('calibratePanel.intro.composeAll.label')}
          </Button>
        ) : null}
      </Tab>

      {TYPES.map((type) => {
        const typeName = t('calibratePanel.types.' + type + '.name')
        const groups = grouping.groups.filter((g) => g.type === type)
        const rejected = grouping.rejected.filter((s) => s.frame.type === type)
        const frameType = groups.reduce((n, g) => n + g.frame.length, 0) + rejected.length
        const ready = groups.filter((g) => composedItems.has('sessione:' + g.key)).length
        const otherComposites = master.groups.filter((m) => m.entry.type === type && !groups.some((g) => 'sessione:' + g.key === m.entry.id))

        return (
          <Tab
            key={type}
            title={t('calibratePanel.masterTitle', { type: typeName })}
            action={
              ready > 0 ? (
                <Label color="lime">
                  {ready === groups.length
                    ? ready === 1
                      ? t('calibratePanel.readyOne')
                      : t('calibratePanel.readyAll', { count: ready })
                    : t('calibratePanel.readyPartial', { ready, total: groups.length })}
                </Label>
              ) : (
                <Label color="neutral">{plural(frameType, 'calibratePanel.frames')}</Label>
              )
            }
            description={t('calibratePanel.types.' + type + '.explanation')}
          >
            {frameType === 0 ? (
              <p className="sl-note">
                {t(type === 'dark' ? 'calibratePanel.noFramesDark' : 'calibratePanel.noFramesOther', {
                  type: typeName.toLowerCase()
                })}
              </p>
            ) : null}

            {groups.length > 0 ? (
              <div className="sl-libcal-groups">
                {groups.map((g) => {
                  const id = 'sessione:' + g.key
                  const done = composedItems.get(id)
                  return (
                    <div key={g.key} className="sl-libcal-group">
                      <div className="sl-libcal-group-title">{describeGroup(g.conditions, g.night)}</div>
                      <div className="sl-libcal-choice">
                        <span className="sl-libcal-type">{t('calibratePanel.group.frames')}</span>
                        <span>
                          {g.frame.length === 1
                            ? t('calibratePanel.group.singleFrame')
                            : t('calibratePanel.group.multipleFrames', { count: g.frame.length })}
                        </span>
                      </div>
                      <div className="sl-libcal-choice">
                        <span className="sl-libcal-type">{t('calibratePanel.group.for')}</span>
                        <span>{usageOf(g, id)}</span>
                      </div>
                      <div className="sl-libcal-choice">
                        <span className="sl-libcal-type">{t('calibratePanel.group.status')}</span>
                        <span>
                          {done
                            ? t('calibratePanel.group.ready') +
                              (type === 'dark'
                                ? t('calibratePanel.group.defectivePixels', {
                                    count: formatNumber(done.entry.defectivePixels)
                                  })
                                : '') +
                              correctionSuffix(done.entry.flatCorrection)
                            : t('calibratePanel.group.toCompose')}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}

            {groups.length > 1 ? (
              <p className="sl-note">{t('calibratePanel.differentConditions', { count: groups.length })}</p>
            ) : null}

            {rejected.length > 0 ? (
              <p className="sl-note">
                {rejected.map((s) => t('calibratePanel.excludedFrame', { name: s.frame.name, reason: s.reason })).join(' ')}
              </p>
            ) : null}

            {type === 'dark' && uses.withoutDark.length > 0 && withCalibration ? (
              <p className="sl-note">
                {uses.withoutDark
                  .map((g) =>
                    t(g.lights === 1 ? 'calibratePanel.withoutDarkOne' : 'calibratePanel.withoutDarkOther', {
                      group: g.description.charAt(0).toUpperCase() + g.description.slice(1),
                      reason: g.withoutDark ?? ''
                    })
                  )
                  .join(' ')}
              </p>
            ) : null}

            {otherComposites.length > 0 ? (
              <p className="sl-note">
                {plural(otherComposites.length, 'calibratePanel.stale', {
                  list: otherComposites.map((m) => describeGroup(m.entry, null)).join('; ')
                })}
              </p>
            ) : null}

            <Button
              fullWidth
              icon={<CalibrateIcon size={16} />}
              disabledValue={groups.length === 0 || inProgress !== null}
              onClick={() => void compose(type)}
            >
              {inProgress === type
                ? t('calibratePanel.composing')
                : groups.length === 0
                  ? t('calibratePanel.button.noGroups')
                  : ready > 0
                  ? groups.length === 1
                    ? t('calibratePanel.button.recomposeOne')
                    : t('calibratePanel.button.recomposeMany', { count: groups.length })
                  : groups.length > 1
                    ? t('calibratePanel.button.composeMany', { count: groups.length })
                    : groups.length === 1 && groups[0].frame.length === 1
                      ? t('calibratePanel.button.useSingle', { type: typeName })
                      : t('calibratePanel.button.combine', { count: groups[0]?.frame.length ?? 0 })}
            </Button>
          </Tab>
        )
      })}

      <CalibrationLibraryTab />

      {hasSomething ? (
        <Tab title={t('calibratePanel.applied.title')}>
          <p className="sl-note">{t('calibratePanel.applied.text')}</p>
        </Tab>
      ) : null}
    </>
  )
}
