import { useMemo, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Button, Slider, Segmented, Toggle, DataEntry, Label } from '../components/Controls'
import { AlignIcon } from '../components/Icons'
import { useStacking, frameReasonText } from '../hooks/useStacking'
import type { StackingMethod } from '@core/stack/stacking'
import { LiveSessionSection } from './LiveSessionSection'
import { MosaicSection } from './MosaicSection'
import { useSession } from '../hooks/useSession'
import { originalFrame } from '../hooks/temporaryResult'
import { drizzleMemory } from '@core/stack/drizzle'
import { formatBytes } from '@core/memory'
import { DEFAULT_MIN_QUALITY } from '@core/stars/detection'
import type { CometMode } from '@core/stack/comet'
import { CometSection, CometSummary, cometOptions, type NucleusMode } from './CometSection'
import { useCometNucleus } from '../hooks/cometNucleus'
import { NightsSection, NightsSummary } from './NightsSection'
import { CalibrationSummary } from './CalibrationSummary'
import type { NightsChoice } from '@core/stack/nights'
import { seriesToMerge, seriesPerExposure } from '@core/stack/hdr'
import { formatDecimal, formatNumber, t } from '@shared/i18n/i18n'

/** Stacking methods; label and hint are language keys under `stackPanel.method.<value>`. */
const METHODS: StackingMethod[] = ['rejection', 'mean', 'median']

/** Drizzle factors; the hint is a language key under `stackPanel.drizzle.factor<value>Hint`. */
const DRIZZLE_FACTORS: ('1' | '2')[] = ['1', '2']

export function StackPanel(): JSX.Element {
  const frame = useApp((s) => s.frame)
  const { inProgress, summary, start } = useStacking()

  const [method, setMethod] = useState<StackingMethod>('rejection')
  const [rejectionThreshold, setRejectionThreshold] = useState(3)
  const [minQuality, setMinQuality] = useState(DEFAULT_MIN_QUALITY)
  const [alignment, setAlignment] = useState(true)
  const [edgeTrim, setEdgeTrim] = useState(true)
  const [drizzleFactor, setDrizzleFactor] = useState<'1' | '2'>('1')
  const [pixfrac, setPixfrac] = useState(0.8)
  const [bayerDrizzle, setBayerDrizzle] = useState(false)
  const [cometMode, setCometMode] = useState<CometMode>('stars')
  const [nucleusMode, setNucleusMode] = useState<NucleusMode>('automatic')
  // Manual weights and exclusions per night; empty means fully automatic.
  const [nightsChoice, setNightsChoice] = useState<NightsChoice>({})
  const [hdrMerge, setHdrMerge] = useState(true)
  const firstNucleus = useCometNucleus((s) => s.first)
  const lastNucleus = useCometNucleus((s) => s.last)
  const activeSession = useSession((s) => s.active)
  const options = useMemo(
    () => ({ method, rejectionThreshold, minQuality, alignment, edgeTrim }),
    [method, rejectionThreshold, minQuality, alignment, edgeTrim]
  )
  // Drizzle applies only to the full stack: the live session re-stacks at
  // every shot and would be too slow on a doubled grid.
  const lights = frame.filter(
    (f) =>
      !f.excluded &&
      f.metadata.frameType !== 'dark' &&
      f.metadata.frameType !== 'flat' &&
      f.metadata.frameType !== 'bias'
  )

  // Bayer drizzle only makes sense with raw frames from a color sensor: a
  // file with a single plane and a Bayer pattern in the header. Stacked
  // files are already in color and no longer hold the per-pixel measured
  // data. The frame is checked as it is in the file, because a result shown
  // in the viewer temporarily replaces its dimensions.
  const rawBayer =
    lights.length > 0 &&
    lights.every((f) => {
      const o = originalFrame(f)
      return o.channels === 1 && o.metadata.bayer !== 'NONE'
    })
  const bayerActive = bayerDrizzle && rawBayer
  const drizzleOn = drizzleFactor === '2' || bayerActive

  const stackOptions = useMemo(
    () => ({
      ...options,
      drizzle: {
        factor: drizzleFactor === '2' ? (2 as const) : (1 as const),
        pixfrac,
        bayer: bayerActive
      }
    }),
    [options, drizzleFactor, pixfrac, bayerActive]
  )

  // The comet mode applies only to the full stack, like drizzle.
  const comet = cometOptions(lights, cometMode, nucleusMode, { first: firstNucleus, last: lastNucleus })

  // Memory that drizzle needs on top of the frames: the same estimate that
  // stacking uses to decide whether to fall back to the normal sum.
  const firstLight = lights.length > 0 ? originalFrame(lights[0]) : null
  const estimatedMemory =
    drizzleOn && firstLight
      ? drizzleMemory(
          firstLight.width,
          firstLight.height,
          3,
          drizzleFactor === '2' ? 2 : 1,
          method !== 'mean'
        )
      : 0

  // Series with different exposures: HDR merge is offered only if there are any.
  const hdrSeries = seriesToMerge(seriesPerExposure(lights.map((f) => ({ id: f.id, exposure: f.metadata.exposure }))))

  const totalExposure = lights.reduce((sum, f) => sum + (f.metadata.exposure ?? 0), 0)

  return (
    <>
      <Tab
        title={t('stackPanel.frames.title')}
        action={<Label color="cyan">{lights.length}</Label>}
        description={t('stackPanel.frames.description')}
        data="tab-stack"
      >
        <DataEntry name={t('stackPanel.frames.lights')} value={lights.length} />
        <DataEntry
          name={t('stackPanel.frames.totalExposure')}
          value={
            totalExposure >= 60
              ? Math.floor(totalExposure / 60) + ' min ' + Math.round(totalExposure % 60) + ' s'
              : Math.round(totalExposure) + ' s'
          }
        />
        <DataEntry
          name={t('stackPanel.frames.expectedNoise')}
          value={lights.length > 0 ? t('stackPanel.times', { times: formatDecimal(Math.sqrt(lights.length), 2) }) : '-'}
          hint={t('stackPanel.frames.expectedNoiseHint')}
        />
      </Tab>

      <Tab title={t('stackPanel.alignment.title')}>
        <Toggle
          label={t('stackPanel.alignment.align')}
          active={alignment}
          onChange={setAlignment}
          hint={t('stackPanel.alignment.alignHint')}
        />
        <Slider
          label={t('stackPanel.alignment.minQuality')}
          value={minQuality}
          min={0}
          max={90}
          step={1}
          color="lime"
          format={(v) => (v === 0 ? t('stackPanel.alignment.all') : v + '%')}
          hint={t('stackPanel.alignment.minQualityHint')}
          disabledValue={!alignment}
          onChange={setMinQuality}
        />
        <Toggle
          label={t('stackPanel.alignment.edgeTrim')}
          active={edgeTrim}
          onChange={setEdgeTrim}
          hint={t('stackPanel.alignment.edgeTrimHint')}
        />
      </Tab>

      <CometSection
        lights={lights}
        mode={cometMode}
        onMode={setCometMode}
        nucleus={nucleusMode}
        onNucleus={setNucleusMode}
        disabledValue={inProgress || activeSession}
      />

      {hdrSeries && cometMode === 'stars' ? (
        <Tab
          title={t('stackPanel.hdr.title')}
          description={t('stackPanel.hdr.description', {
            series: hdrSeries
              .map((x) => t('stackPanel.hdr.series', { count: x.ids.length, exposure: formatNumber(x.exposure) }))
              .join(', ')
          })}
        >
          <Toggle
            label={t('stackPanel.hdr.merge')}
            active={hdrMerge}
            onChange={setHdrMerge}
            hint={t('stackPanel.hdr.mergeHint')}
          />
        </Tab>
      ) : null}

      <NightsSection lights={lights} choice={nightsChoice} onChoice={setNightsChoice} measurements={summary?.nights} />

      <Tab title={t('stackPanel.combination.title')}>
        <Segmented
          value={method}
          options={METHODS.map((m) => ({
            value: m,
            label: t('stackPanel.method.' + m + '.label'),
            hint: t('stackPanel.method.' + m + '.hint')
          }))}
          onChange={setMethod}
        />
        <Slider
          label={t('stackPanel.combination.threshold')}
          value={rejectionThreshold}
          min={1}
          max={5}
          step={0.1}
          color="amber"
          format={(v) => t('stackPanel.combination.thresholdValue', { value: formatDecimal(v, 1) })}
          hint={t('stackPanel.combination.thresholdHint')}
          disabledValue={method !== 'rejection'}
          onChange={setRejectionThreshold}
        />
      </Tab>

      <Tab
        title={t('stackPanel.drizzle.title')}
        description={t('stackPanel.drizzle.description')}
      >
        <Segmented
          value={drizzleFactor}
          options={DRIZZLE_FACTORS.map((f) => ({
            value: f,
            label: f + '×',
            hint: t('stackPanel.drizzle.factor' + f + 'Hint')
          }))}
          onChange={setDrizzleFactor}
        />
        {rawBayer ? (
          <Toggle
            label={t('stackPanel.drizzle.bayer')}
            active={bayerDrizzle}
            onChange={setBayerDrizzle}
            hint={t('stackPanel.drizzle.bayerHint')}
          />
        ) : (
          <DataEntry
            name={t('stackPanel.drizzle.bayerName')}
            value={t('stackPanel.drizzle.unavailable')}
            hint={t('stackPanel.drizzle.unavailableHint')}
          />
        )}
        <Slider
          label={t('stackPanel.drizzle.dropSize')}
          value={pixfrac}
          min={0.5}
          max={1}
          step={0.05}
          color="violet"
          format={(v) => formatDecimal(v, 2)}
          hint={t('stackPanel.drizzle.dropSizeHint')}
          disabledValue={!drizzleOn}
          onChange={setPixfrac}
        />
        {estimatedMemory > 0 ? (
          <DataEntry
            name={t('stackPanel.drizzle.memory')}
            value={t('stackPanel.drizzle.memoryValue', { size: formatBytes(estimatedMemory) })}
            hint={t('stackPanel.drizzle.memoryHint')}
          />
        ) : null}
      </Tab>

      <Button
        variant="primary"
        fullWidth
        icon={<AlignIcon size={17} />}
        disabledValue={inProgress || activeSession || lights.length < 2 || comet.isMissing !== undefined}
        onClick={() => void start({ ...stackOptions, comet: comet.options, nights: nightsChoice, hdr: hdrMerge })}
        data="stack-button"
      >
        {inProgress ? t('stackPanel.processing') : t('stackPanel.stack')}
      </Button>
      {comet.isMissing ? <p className="sl-card-desc">{comet.isMissing}</p> : null}

      <LiveSessionSection options={options} />

      <MosaicSection />

      {summary !== null ? (
        <>
          <Tab
            title={t('stackPanel.result.title')}
            action={
              <Label color="lime">
                {summary.usedFrames} / {summary.totalFrames}
              </Label>
            }
          >
            <DataEntry name={t('stackPanel.result.stacked')} value={summary.usedFrames} />
            <DataEntry name={t('stackPanel.result.method')} value={summary.method} />
            {summary.nights ? <NightsSummary nights={summary.nights} /> : null}
            {summary.hdr ? (
              <DataEntry
                name={t('stackPanel.hdr.title')}
                value={t('stackPanel.result.hdrValue', {
                  share: Math.round(summary.hdr.replacedShare * 100),
                  ratio: formatNumber(summary.hdr.ratio, { maximumFractionDigits: 1 })
                })}
              />
            ) : null}
            {summary.calibration && summary.calibration.length > 0 ? (
              <CalibrationSummary groups={summary.calibration} />
            ) : null}
            {summary.comet ? <CometSummary comet={summary.comet} /> : null}
            {summary.drizzle ? (
              <>
                <DataEntry
                  name={t('stackPanel.drizzle.title')}
                  value={t(summary.drizzle.bayer ? 'stackPanel.result.drizzleBayerValue' : 'stackPanel.result.drizzleValue', {
                    factor: summary.drizzle.factor,
                    drop: formatDecimal(summary.drizzle.pixfrac, 2)
                  })}
                />
                <DataEntry
                  name={t('stackPanel.result.coverage')}
                  value={t('stackPanel.result.coverageValue', { frames: formatDecimal(summary.drizzle.meanCoverage, 1) })}
                  hint={t('stackPanel.result.coverageHint')}
                />
                {summary.drizzle.emptyFraction > 0 ? (
                  <DataEntry
                    name={t('stackPanel.result.empty')}
                    value={formatDecimal(summary.drizzle.emptyFraction * 100, 2) + '%'}
                    hint={t('stackPanel.result.emptyHint')}
                  />
                ) : null}
              </>
            ) : null}
            {summary.crop ? (
              <DataEntry
                name={t('stackPanel.result.edges')}
                value={t('stackPanel.result.edgesValue')}
                hint={t('stackPanel.result.edgesHint', {
                  kept: Math.round(summary.crop.keptArea * 100),
                  coverage: Math.round(summary.crop.minCoverage * 100)
                })}
              />
            ) : null}
            <DataEntry name={t('stackPanel.result.time')} value={formatDecimal(summary.timeSeconds, 1) + ' s'} />
            <DataEntry
              name={t('stackPanel.result.noiseReduced')}
              value={
                summary.noiseAfter > 0
                  ? t('stackPanel.times', { times: formatDecimal(summary.noiseBefore / summary.noiseAfter, 2) })
                  : t('stackPanel.result.notMeasurable')
              }
              hint={t('stackPanel.result.noiseReducedHint')}
            />
            <DataEntry
              name={t('stackPanel.result.theory')}
              value={t('stackPanel.times', { times: formatDecimal(Math.sqrt(summary.usedFrames), 2) })}
              hint={t('stackPanel.result.theoryHint')}
            />
            {summary.rejectedValues > 0 ? (
              <DataEntry
                name={t('stackPanel.result.rejected')}
                value={formatNumber(summary.rejectedValues)}
                hint={t('stackPanel.result.rejectedHint')}
              />
            ) : null}
          </Tab>

          <Tab
            title={t('stackPanel.details.title')}
            description={t('stackPanel.details.description')}
          >
            <div className="sl-library">
              {summary.results.map((e) => (
                <div key={e.id} className={'sl-frame' + (e.isUsed ? '' : ' sl-excluded')}>
                  <div className="sl-frame-open">
                    <span className="sl-frame-name">{e.fileName}</span>
                    <span className="sl-frame-meta">
                      {t('stackPanel.details.meta', { stars: e.stars, hfr: formatDecimal(e.hfr, 2) })}
                      {e.shift > 0.01
                        ? t('stackPanel.details.shifted', { px: formatDecimal(e.shift, 1) })
                        : ''}
                      {Math.abs(e.rotation) > 0.01
                        ? t('stackPanel.details.rotated', { degrees: formatDecimal(e.rotation, 2) })
                        : ''}
                    </span>
                  </div>
                  <div className="sl-frame-actions">
                    <Label
                      color={e.isUsed ? (e.quality >= 70 ? 'lime' : 'amber') : 'red'}
                      title={frameReasonText(e.reason)}
                    >
                      {e.isUsed
                        ? e.quality + '%'
                        : e.reason === 'excluded-night'
                          ? t('stackPanel.details.excluded')
                          : t('stackPanel.details.rejected')}
                    </Label>
                  </div>
                </div>
              ))}
            </div>
          </Tab>
        </>
      ) : null}
    </>
  )
}
