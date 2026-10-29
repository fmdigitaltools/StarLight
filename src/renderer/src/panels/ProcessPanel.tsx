import type { JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Slider, Button, Toggle, Segmented, Label } from '../components/Controls'
import { RestartIcon, ProcessIcon } from '../components/Icons'
import { useProcessing } from '../hooks/useProcessing'
import { usePhotometry } from '../hooks/usePhotometry'
import {
  NEUTRAL_PROCESSING,
  type BalanceMode,
  type BackgroundMode,
  type ProcessingParams
} from '@core/image/chain'
import { WAVELET_LAYERS } from '@core/image/wavelets'
import { ExtraToolsTab } from './ExtraToolsTab'
import { PalettePreviews } from './PalettePreviews'
import { describeSensor, dualBandFile, sensorFromMetadata } from '@core/image/narrowband'
import { formatDecimal, t } from '@shared/i18n/i18n'

/** Scale of the five wavelet layers, from the finest detail. */
const WAVELET_SCALES = ['1 px', '2 px', '4 px', '8 px', '16 px']

const percent = (v: number): string => Math.round(v * 100) + '%'

/**
 * Process step: the tools that transform the data, one per card.
 *
 * Each tool is adjusted on its own; nothing changes until Apply is pressed,
 * because the computation takes a few seconds. Every card has its own Apply
 * button at the bottom, highlighted when that card's values have changed,
 * so the effect is visible without scrolling back up the column. There is
 * still a single computation with all the tools, because the chain is a
 * sequence: the "Apply all" button at the bottom of the column does the
 * same thing. Processing always restarts from the original image, so it can
 * be re-applied any number of times. Abracadabra fills in these same values
 * by measuring the image, and they can be fine-tuned from there.
 */
export function ProcessPanel(): JSX.Element {
  const p = useApp((s) => s.processing)
  const applied = useApp((s) => s.appliedProcessing)
  const update = useApp((s) => s.setProcessing)
  const job = useApp((s) => s.job)
  const dualBand = useApp((s) =>
    dualBandFile(s.frame.find((f) => f.id === s.activeFrameId)?.metadata.filter)
  )
  // Sensor of the active file: narrowband separates the two lines using its response.
  const sensor = useApp((s) => sensorFromMetadata(s.frame.find((f) => f.id === s.activeFrameId)?.metadata))
  const { apply } = useProcessing()
  const { compute: computePhotometry, inProgress: photometryRunning } = usePhotometry()

  const toApply = JSON.stringify(p) !== JSON.stringify(applied ?? NEUTRAL_PROCESSING)

  const updateInside = <K extends keyof ProcessingParams>(
    key: K,
    patch: Partial<ProcessingParams[K]>
  ): void => {
    update({ [key]: { ...(p[key] as object), ...patch } } as Partial<ProcessingParams>)
  }

  const updateLayer = (field: 'noiseReduction' | 'sharpness', i: number, v: number): void => {
    const values = [...p.wavelets[field]]
    values[i] = v
    updateInside('wavelets', { [field]: values })
  }

  return (
    <>
      <Tab
        title={t('processPanel.defects.title')}
        description={t('processPanel.defects.description')}
      >
        <Toggle
          label={t('processPanel.defects.hotPixels')}
          active={p.hotPixels}
          onChange={(v) => update({ hotPixels: v })}
          hint={t('processPanel.defects.hotPixelsHint')}
        />
        <Segmented<BackgroundMode>
          value={p.background}
          options={[
            { value: 'none', label: t('processPanel.none') },
            {
              value: 'simple',
              label: t('processPanel.defects.simple'),
              hint: t('processPanel.defects.simpleHint')
            },
            {
              value: 'rbf',
              label: t('processPanel.defects.advanced'),
              hint: t('processPanel.defects.advancedHint')
            }
          ]}
          onChange={(v) => update({ background: v })}
        />
        {p.background === 'rbf' ? (
          <>
            <Slider
              label={t('processPanel.defects.samples')}
              value={p.rbfBackground.samplesPerSide}
              min={8}
              max={40}
              step={1}
              format={(v) => String(Math.round(v))}
              hint={t('processPanel.defects.samplesHint')}
              onChange={(v) => updateInside('rbfBackground', { samplesPerSide: Math.round(v) })}
            />
            <Slider
              label={t('processPanel.defects.smoothness')}
              value={p.rbfBackground.smoothness}
              min={0}
              max={1}
              format={percent}
              hint={t('processPanel.defects.smoothnessHint')}
              onChange={(v) => updateInside('rbfBackground', { smoothness: v })}
            />
            <Slider
              label={t('processPanel.defects.tolerance')}
              value={p.rbfBackground.tolerance}
              min={1}
              max={5}
              format={(v) => formatDecimal(v, 1)}
              hint={t('processPanel.defects.toleranceHint')}
              onChange={(v) => updateInside('rbfBackground', { tolerance: v })}
            />
          </>
        ) : null}
        {p.background !== 'none' ? (
          <Toggle
            label={t('processPanel.defects.wedges')}
            active={p.wedgeEqualization}
            onChange={(v) => update({ wedgeEqualization: v })}
            hint={t('processPanel.defects.wedgesHint')}
          />
        ) : null}
        <ApplyCard keys={['hotPixels', 'background', 'rbfBackground', 'wedgeEqualization']} apply={apply} />
      </Tab>

      <Tab
        title={t('processPanel.trails.title')}
        description={t('processPanel.trails.description')}
      >
        <Toggle
          label={t('processPanel.trails.remove')}
          active={p.trails.active}
          onChange={(v) => updateInside('trails', { active: v })}
          hint={t('processPanel.trails.removeHint')}
        />
        {p.trails.active ? (
          <Slider
            label={t('processPanel.trails.sensitivity')}
            value={p.trails.sensitivity}
            min={0}
            max={1}
            format={percent}
            hint={t('processPanel.trails.sensitivityHint')}
            onChange={(v) => updateInside('trails', { sensitivity: v })}
          />
        ) : null}
        <ApplyCard keys={['trails']} apply={apply} />
      </Tab>

      <Tab
        title={t('processPanel.color.title')}
        description={t('processPanel.color.description')}
      >
        <Segmented<BalanceMode>
          value={p.balance}
          options={[
            { value: 'none', label: t('processPanel.none') },
            { value: 'stars', label: t('processPanel.color.stars') },
            { value: 'photometric', label: t('processPanel.color.photometric') }
          ]}
          onChange={(v) => update({ balance: v })}
        />
        {p.balance === 'photometric' ? (
          <div className="sl-process-row">
            <Button
              variant="secondary"
              onClick={() => void computePhotometry()}
              disabledValue={photometryRunning || job.active}
            >
              {p.photometricGains ? t('processPanel.color.recompute') : t('processPanel.color.compute')}
            </Button>
            <span className="sl-note sl-mono">
              {p.photometricGains
                ? 'R ' +
                  formatDecimal(p.photometricGains[0], 3) +
                  '  G ' +
                  formatDecimal(p.photometricGains[1], 3) +
                  '  B ' +
                  formatDecimal(p.photometricGains[2], 3)
                : t('processPanel.color.notComputed')}
            </span>
          </div>
        ) : null}
        <Slider
          label={t('processPanel.color.colorNoise')}
          value={p.colorNoise}
          min={0}
          max={1}
          color="magenta"
          format={percent}
          hint={
            p.narrowband.palette !== 'natural'
              ? t('processPanel.color.colorNoiseNarrowbandHint')
              : t('processPanel.color.colorNoiseHint')
          }
          onChange={(v) => update({ colorNoise: v })}
        />
        <ApplyCard keys={['balance', 'photometricGains', 'colorNoise']} apply={apply} />
      </Tab>

      <Tab
        title={t('processPanel.deconvolution.title')}
        description={t('processPanel.deconvolution.description')}
      >
        <Slider
          label={t('processPanel.deconvolution.iterations')}
          value={p.deconvolution.iterations}
          min={0}
          max={50}
          step={1}
          format={(v) => (v === 0 ? t('processPanel.deconvolution.off') : String(Math.round(v)))}
          hint={t('processPanel.deconvolution.iterationsHint')}
          onChange={(v) => updateInside('deconvolution', { iterations: Math.round(v) })}
        />
        <Slider
          label={t('processPanel.deconvolution.psfRadius')}
          value={p.deconvolution.psfRadius}
          min={0}
          max={5}
          format={(v) => (v === 0 ? t('processPanel.deconvolution.automatic') : formatDecimal(v, 2) + ' px')}
          hint={t('processPanel.deconvolution.psfRadiusHint')}
          onChange={(v) => updateInside('deconvolution', { psfRadius: v })}
        />
        <Slider
          label={t('processPanel.deconvolution.regularization')}
          value={p.deconvolution.regularization}
          min={0}
          max={1}
          format={percent}
          hint={t('processPanel.deconvolution.regularizationHint')}
          onChange={(v) => updateInside('deconvolution', { regularization: v })}
        />
        <ApplyCard keys={['deconvolution']} apply={apply} />
      </Tab>

      <Tab
        title={t('processPanel.noise.title')}
        description={t('processPanel.noise.description')}
      >
        <Slider
          label="NL-Bayes"
          value={p.nlBayes}
          min={0}
          max={1}
          color="lime"
          format={(v) => (v === 0 ? t('processPanel.off') : percent(v))}
          onChange={(v) => update({ nlBayes: v })}
        />
        {Array.from({ length: WAVELET_LAYERS }, (_, i) => (
          <Slider
            key={'r' + i}
            label={t('processPanel.noise.waveletScale', { scale: WAVELET_SCALES[i] })}
            value={p.wavelets.noiseReduction[i] ?? 0}
            min={0}
            max={1}
            color="lime"
            format={percent}
            onChange={(v) => updateLayer('noiseReduction', i, v)}
          />
        ))}
        <ApplyCard keys={['nlBayes', 'wavelets.noiseReduction']} apply={apply} />
      </Tab>

      <Tab
        title={t('processPanel.detail.title')}
        description={t('processPanel.detail.description')}
      >
        {Array.from({ length: WAVELET_LAYERS }, (_, i) => (
          <Slider
            key={'n' + i}
            label={t('processPanel.detail.scale', { scale: WAVELET_SCALES[i] })}
            value={p.wavelets.sharpness[i] ?? 0}
            min={-1}
            max={2}
            color="cyan"
            format={(v) => (v > 0 ? '+' : '') + formatDecimal(v, 2)}
            onChange={(v) => updateLayer('sharpness', i, v)}
          />
        ))}
        <ApplyCard keys={['wavelets.sharpness']} apply={apply} />
      </Tab>

      <Tab
        title={t('processPanel.narrowband.title')}
        description={t('processPanel.narrowband.description')}
      >
        {dualBand ? (
          <p className="sl-note">
            {t('processPanel.narrowband.dualBand')}
          </p>
        ) : (
          <p className="sl-note">
            {t('processPanel.narrowband.notDualBand')}
          </p>
        )}
        <PalettePreviews
          value={p.narrowband.palette}
          onChange={(v) => updateInside('narrowband', { palette: v, sensor })}
        />
        {p.narrowband.palette !== 'natural' ? (
          <p className="sl-note">{describeSensor(p.narrowband.sensor)}</p>
        ) : null}
        {p.narrowband.palette === 'hoo' ? (
          <p className="sl-note">{t('processPanel.narrowband.hoo')}</p>
        ) : p.narrowband.palette === 'foraxx' ? (
          <p className="sl-note">
            {t('processPanel.narrowband.foraxx')}
          </p>
        ) : p.narrowband.palette === 'sho' ? (
          <p className="sl-note">
            {t('processPanel.narrowband.sho')}
          </p>
        ) : null}
        {p.narrowband.palette !== 'natural' ? (
          <>
            <Slider
              label={t('processPanel.narrowband.balance')}
              value={p.narrowband.balance}
              min={-1}
              max={1}
              color="magenta"
              format={(v) =>
                Math.abs(v) < 0.005
                  ? t('processPanel.narrowband.measured')
                  : t(v > 0 ? 'processPanel.narrowband.moreOiii' : 'processPanel.narrowband.moreHalpha', {
                      value: percent(Math.abs(v))
                    })
              }
              hint={t('processPanel.narrowband.balanceHint')}
              onChange={(v) => updateInside('narrowband', { balance: v })}
            />
            <Slider
              label={t('processPanel.narrowband.oiii')}
              value={p.narrowband.oiiiIntensity}
              min={0}
              max={2}
              color="cyan"
              format={percent}
              hint={t('processPanel.narrowband.oiiiHint')}
              onChange={(v) => updateInside('narrowband', { oiiiIntensity: v })}
            />
            <Toggle
              label={t('processPanel.narrowband.naturalStars')}
              active={p.narrowband.naturalStars}
              onChange={(v) => updateInside('narrowband', { naturalStars: v })}
              hint={t('processPanel.narrowband.naturalStarsHint')}
            />
          </>
        ) : null}
        <ApplyCard keys={['narrowband']} apply={apply} />
      </Tab>

      <Tab
        title={t('processPanel.starReduction.title')}
        description={t('processPanel.starReduction.description')}
      >
        <Slider
          label={t('processPanel.starReduction.size')}
          value={p.starReduction.quantity}
          min={0}
          max={1}
          color="violet"
          format={percent}
          onChange={(v) => updateInside('starReduction', { quantity: v })}
        />
        <Slider
          label={t('processPanel.starReduction.brightness')}
          value={p.starReduction.attenuation}
          min={0}
          max={1}
          color="violet"
          format={percent}
          hint={t('processPanel.starReduction.brightnessHint')}
          onChange={(v) => updateInside('starReduction', { attenuation: v })}
        />
        <ApplyCard keys={['starReduction']} apply={apply} />
      </Tab>

      <Tab
        title={t('processPanel.localContrast.title')}
        description={t('processPanel.localContrast.description')}
      >
        <Slider
          label={t('processPanel.localContrast.strength')}
          value={p.localContrast.strength}
          min={0}
          max={1}
          color="amber"
          format={(v) => (v === 0 ? t('processPanel.off') : percent(v))}
          onChange={(v) => updateInside('localContrast', { strength: v })}
        />
        <Slider
          label={t('processPanel.localContrast.limit')}
          value={p.localContrast.limit}
          min={1}
          max={4}
          color="amber"
          format={(v) => formatDecimal(v, 1)}
          hint={t('processPanel.localContrast.limitHint')}
          onChange={(v) => updateInside('localContrast', { limit: v })}
        />
        <Slider
          label={t('processPanel.localContrast.boxes')}
          value={p.localContrast.boxes}
          min={4}
          max={16}
          step={1}
          color="amber"
          format={(v) => String(Math.round(v))}
          hint={t('processPanel.localContrast.boxesHint')}
          onChange={(v) => updateInside('localContrast', { boxes: Math.round(v) })}
        />
        <ApplyCard keys={['localContrast']} apply={apply} />
      </Tab>

      <ExtraToolsTab />

      <div className="sl-process-actions sl-process-actions--bottom">
        {toApply ? (
          <Label color="amber" title={t('processPanel.pendingHint')}>
            {t('processPanel.pending')}
          </Label>
        ) : null}
        <Button
          variant="primary"
          icon={<ProcessIcon size={15} />}
          onClick={() => void apply()}
          disabledValue={job.active}
          fullWidth
          title={t('processPanel.applyAllHint')}
        >
          {t('processPanel.applyAll')}
        </Button>
      </div>

      <Button
        variant="ghost"
        icon={<RestartIcon size={15} />}
        // Plugins are disabled but keep their chosen values.
        onClick={() => update({ ...NEUTRAL_PROCESSING, plugin: p.plugin.map((x) => ({ ...x, active: false })) })}
        fullWidth
        title={t('processPanel.resetHint')}
      >
        {t('processPanel.reset')}
      </Button>
    </>
  )
}

/** Value of a parameter, possibly nested: "wavelets.sharpness". */
function valueFor(p: ProcessingParams, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], p)
}

/**
 * Apply button at the bottom of a card. It is highlighted when the values
 * of this card differ from those of the displayed image. It still computes
 * the whole chain, like "Apply all".
 */
function ApplyCard({ keys, apply }: { keys: string[]; apply: () => Promise<void> }): JSX.Element {
  const changed = useApp((s) => {
    const applied = s.appliedProcessing ?? NEUTRAL_PROCESSING
    return keys.some((k) => JSON.stringify(valueFor(s.processing, k)) !== JSON.stringify(valueFor(applied, k)))
  })
  const busy = useApp((s) => s.job.active)
  return (
    <div className="sl-card-apply">
      {changed ? <Label color="amber">{t('processPanel.pending')}</Label> : null}
      <Button
        variant={changed ? 'primary' : 'secondary'}
        icon={<ProcessIcon size={14} />}
        onClick={() => void apply()}
        disabledValue={busy}
        title={t('processPanel.applyHint')}
      >
        {t('processPanel.apply')}
      </Button>
    </div>
  )
}
