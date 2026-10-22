import type { JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Slider, Button, Segmented, Toggle } from '../components/Controls'
import { WandIcon, RestartIcon } from '../components/Icons'
import { Histogram } from '../components/Histogram'
import { useLibrary } from '../hooks/useLibrary'
import { autoStretch, NEUTRAL_STRETCH } from '@core/image/stretch'
import { CurveEditor } from '../components/CurveEditor'
import { PRESET_CURVES, neutralCurves, type CurveChannel } from '@core/image/curve'
import { useState as useChannelState } from 'react'
import { automaticGhs, type GhsParams } from '@core/image/ghs'
import { LocalAdjustmentsTab } from './LocalAdjustmentsTab'
import { formatDecimal, t } from '@shared/i18n/i18n'

/** Preset strengths of the automatic stretch (language keys under correctPanel.intensity). */
const INTENSITIES = ['gentle', 'medium', 'strong'] as const

/*
 * Sky background level for each strength. High values brighten faint signal
 * but bring out the noise, so the balanced choice is deliberately dark.
 */
const PARAMETERS_BY_STRENGTH = {
  // Besides the target background, the black point also changes: on very
  // dark images the midtones hit their minimum and on their own would not be
  // enough to tell the three levels apart.
  gentle: { targetBackground: 0.08, shadowsClipping: -2.0 },
  medium: { targetBackground: 0.15, shadowsClipping: -2.8 },
  // Above 0.2 the background turns gray and the grain becomes visible.
  strong: { targetBackground: 0.2, shadowsClipping: -3.2 }
}

type Intensity = 'gentle' | 'medium' | 'strong'

/** Curve channels (language keys under correctPanel.channel). */
const CHANNELS: CurveChannel[] = ['light', 'red', 'green', 'blue']

export function CorrectPanel(): JSX.Element {
  const adjustments = useApp((s) => s.adjustments)
  const update = useApp((s) => s.updateAdjustments)
  const { applyAutostretch, resetView } = useLibrary()
  const curves = useApp((s) => s.curves)
  const setCurve = useApp((s) => s.setCurve)
  const resetCurves = useApp((s) => s.resetCurves)
  const [channel, setChannel] = useChannelState<CurveChannel>('light')
  // Channel curves have no effect when the stretch preserves color.
  const shownChannel: CurveChannel = adjustments.preserveColor ? 'light' : channel
  const [intensity, setIntensity] = useChannelState<Intensity>('medium')
  const image = useApp((s) => s.image)
  const notify = useApp((s) => s.notify)

  function applyIntensity(level: Intensity): void {
    if (!image) return
    setIntensity(level)
    update({ stretch: autoStretch(image, PARAMETERS_BY_STRENGTH[level]) })
    notify('ok', t('correctPanel.intensity.' + level + '.applied'))
  }

  const updateGhs = (patch: Partial<GhsParams>): void =>
    update({ ghs: { ...adjustments.ghs, ...patch } })

  return (
    <>
      <Tab
        title={t('correctPanel.stretch.title')}
        description={t('correctPanel.stretch.description')}
        action={
          <Button
            variant="ghost"
            icon={<WandIcon size={15} />}
            onClick={applyAutostretch}
            title={t('correctPanel.stretch.auto.title')}
          >
            {t('correctPanel.stretch.auto.label')}
          </Button>
        }
        data="tab-stretch"
      >
        <Segmented
          value={intensity}
          options={INTENSITIES.map((value) => ({
            value,
            label: t('correctPanel.intensity.' + value + '.label'),
            hint: t('correctPanel.intensity.' + value + '.hint')
          }))}
          onChange={applyIntensity}
        />
        <Histogram />
        <Slider
          label={t('correctPanel.stretch.blackPoint.label')}
          value={adjustments.stretch.shadows}
          min={0}
          max={Math.min(0.5, adjustments.stretch.highlights - 0.002)}
          step={0.0005}
          color="cyan"
          format={(v) => formatDecimal(v, 4)}
          hint={t('correctPanel.stretch.blackPoint.hint')}
          onChange={(v) => update({ stretch: { ...adjustments.stretch, shadows: v } })}
        />
        <Segmented<'midtones' | 'ghs'>
          value={adjustments.withGhs ? 'ghs' : 'midtones'}
          options={[
            {
              value: 'midtones',
              label: t('correctPanel.stretch.mode.midtones.label'),
              hint: t('correctPanel.stretch.mode.midtones.hint')
            },
            {
              value: 'ghs',
              label: t('correctPanel.stretch.mode.ghs.label'),
              hint: t('correctPanel.stretch.mode.ghs.hint')
            }
          ]}
          onChange={(v) => {
            if (v === 'midtones') {
              update({ withGhs: false })
              return
            }
            const image = useApp.getState().image
            const ghs =
              adjustments.ghs.strength > 0 || !image
                ? adjustments.ghs
                : automaticGhs(image, adjustments.stretch.shadows, adjustments.stretch.highlights)
            update({ withGhs: true, ghs })
          }}
        />
        {adjustments.withGhs ? (
          <>
            <Slider
              label={t('correctPanel.ghs.strength.label')}
              value={adjustments.ghs.strength}
              min={0}
              max={10}
              color="magenta"
              format={(v) => formatDecimal(v, 2)}
              hint={t('correctPanel.ghs.strength.hint')}
              onChange={(v) => updateGhs({ strength: v })}
            />
            <Slider
              label={t('correctPanel.ghs.localIntensity.label')}
              value={adjustments.ghs.localIntensity}
              min={-5}
              max={15}
              color="magenta"
              format={(v) => formatDecimal(v, 1)}
              hint={t('correctPanel.ghs.localIntensity.hint')}
              onChange={(v) => updateGhs({ localIntensity: v })}
            />
            <Slider
              label={t('correctPanel.ghs.symmetryPoint.label')}
              value={adjustments.ghs.symmetryPoint}
              min={0}
              max={1}
              step={0.001}
              color="magenta"
              format={(v) => formatDecimal(v, 3)}
              hint={t('correctPanel.ghs.symmetryPoint.hint')}
              onChange={(v) =>
                updateGhs({
                  symmetryPoint: v,
                  shadowProtection: Math.min(adjustments.ghs.shadowProtection, v),
                  highlightProtection: Math.max(adjustments.ghs.highlightProtection, v)
                })
              }
            />
            <Slider
              label={t('correctPanel.ghs.shadowProtection.label')}
              value={adjustments.ghs.shadowProtection}
              min={0}
              max={adjustments.ghs.symmetryPoint}
              step={0.001}
              color="magenta"
              format={(v) => formatDecimal(v, 3)}
              hint={t('correctPanel.ghs.shadowProtection.hint')}
              onChange={(v) => updateGhs({ shadowProtection: v })}
            />
            <Slider
              label={t('correctPanel.ghs.highlightProtection.label')}
              value={adjustments.ghs.highlightProtection}
              min={adjustments.ghs.symmetryPoint}
              max={1}
              step={0.001}
              color="magenta"
              format={(v) => formatDecimal(v, 3)}
              hint={t('correctPanel.ghs.highlightProtection.hint')}
              onChange={(v) => updateGhs({ highlightProtection: v })}
            />
          </>
        ) : null}
        <Slider
          label={t('correctPanel.stretch.midtones.label')}
          disabledValue={adjustments.withGhs}
          value={adjustments.stretch.midtones}
          min={0.0005}
          max={0.95}
          step={0.0005}
          color="magenta"
          format={(v) => formatDecimal(v, 4)}
          hint={t('correctPanel.stretch.midtones.hint')}
          onChange={(v) => update({ stretch: { ...adjustments.stretch, midtones: v } })}
        />
        <Slider
          label={t('correctPanel.stretch.whitePoint.label')}
          value={adjustments.stretch.highlights}
          // Abracadabra measures the white point on the object and,
          // on faint nebulae, picks very low values (down to 0.05): the slider
          // must reach them, or after the first move it could never go back.
          // Both limits depend on the other point, which does not move while
          // this one is dragged, so black and white never cross.
          min={Math.max(0.01, adjustments.stretch.shadows + 0.002)}
          max={1}
          step={0.001}
          color="lime"
          format={(v) => formatDecimal(v, 3)}
          hint={t('correctPanel.stretch.whitePoint.hint')}
          onChange={(v) => update({ stretch: { ...adjustments.stretch, highlights: v } })}
        />
        <Toggle
          label={t('correctPanel.stretch.preserveColor.label')}
          active={adjustments.preserveColor}
          onChange={(preserveColor) => update({ preserveColor })}
          hint={t('correctPanel.stretch.preserveColor.hint')}
        />
      </Tab>

      <Tab
        title={t('correctPanel.curves.title')}
        action={
          !neutralCurves(curves) ? (
            <Button variant="ghost" icon={<RestartIcon size={15} />} onClick={resetCurves}>
              {t('correctPanel.curves.reset')}
            </Button>
          ) : undefined
        }
        description={t('correctPanel.curves.description')}
        data="tab-curves"
      >
        {/* With "preserve color" the pipeline uses only the light curve
            (see core/export/processing.ts): channel curves would have no
            effect, so they are not offered. */}
        <Segmented
          value={shownChannel}
          options={CHANNELS.map((value) => ({
            value,
            label: t('correctPanel.channel.' + value + '.label'),
            hint: t('correctPanel.channel.' + value + '.hint'),
            disabledValue: adjustments.preserveColor && value !== 'light'
          }))}
          onChange={setChannel}
        />
        {adjustments.preserveColor ? (
          <p className="sl-note">{t('correctPanel.curves.preserveColorNote')}</p>
        ) : null}
        <CurveEditor channel={shownChannel} />
        <div className="sl-curve-presets">
          {PRESET_CURVES.map((c) => (
            <button
              key={c.id}
              type="button"
              className="sl-curve-preset"
              onClick={() => setCurve(shownChannel, c.points)}
              title={c.description}
            >
              {c.name}
            </button>
          ))}
        </div>
      </Tab>

      <Tab title={t('correctPanel.tones.title')} data="tab-tones">
        <Slider
          label={t('correctPanel.tones.brightness')}
          value={adjustments.brightness}
          min={-0.5}
          max={0.5}
          color="amber"
          format={(v) => (v > 0 ? '+' : '') + formatDecimal(v, 2)}
          onChange={(v) => update({ brightness: v })}
        />
        <Slider
          label={t('correctPanel.tones.contrast')}
          value={adjustments.contrast}
          min={-0.8}
          max={1.5}
          color="amber"
          format={(v) => (v > 0 ? '+' : '') + formatDecimal(v, 2)}
          onChange={(v) => update({ contrast: v })}
        />
        <Slider
          label={t('correctPanel.tones.gamma.label')}
          value={adjustments.gamma}
          min={0.3}
          max={3}
          step={0.01}
          color="violet"
          format={(v) => formatDecimal(v, 2)}
          hint={t('correctPanel.tones.gamma.hint')}
          onChange={(v) => update({ gamma: v })}
        />
      </Tab>

      <Tab
        title={t('correctPanel.color.title')}
        description={t('correctPanel.color.description')}
        action={
          <Button
            variant="ghost"
            icon={<RestartIcon size={15} />}
            onClick={() => update({ redGain: 1, greenGain: 1, blueGain: 1 })}
            title={t('correctPanel.color.neutral.title')}
          >
            {t('correctPanel.color.neutral.label')}
          </Button>
        }
        data="tab-color"
      >
        <Slider
          label={t('correctPanel.color.saturation.label')}
          value={adjustments.saturation}
          min={-1}
          max={1.5}
          color="magenta"
          format={(v) => (v > 0 ? '+' : '') + formatDecimal(v, 2)}
          hint={t('correctPanel.color.saturation.hint')}
          onChange={(v) => update({ saturation: v })}
        />
        <Slider
          label={t('correctPanel.color.vibrance.label')}
          value={adjustments.vibrance}
          min={-1}
          max={1}
          color="magenta"
          format={(v) => (v > 0 ? '+' : '') + formatDecimal(v, 2)}
          hint={t('correctPanel.color.vibrance.hint')}
          onChange={(v) => update({ vibrance: v })}
        />
        <Slider
          label={t('correctPanel.color.redGain')}
          value={adjustments.redGain}
          min={0.5}
          max={1.8}
          color="magenta"
          format={(v) => formatDecimal(v, 3)}
          onChange={(v) => update({ redGain: v })}
        />
        <Slider
          label={t('correctPanel.color.greenGain')}
          value={adjustments.greenGain}
          min={0.5}
          max={1.8}
          color="lime"
          format={(v) => formatDecimal(v, 3)}
          onChange={(v) => update({ greenGain: v })}
        />
        <Slider
          label={t('correctPanel.color.blueGain')}
          value={adjustments.blueGain}
          min={0.5}
          max={1.8}
          color="cyan"
          format={(v) => formatDecimal(v, 3)}
          onChange={(v) => update({ blueGain: v })}
        />
      </Tab>

      <LocalAdjustmentsTab />

      <Button
        fullWidth
        icon={<RestartIcon size={17} />}
        onClick={resetView}
        title={t('correctPanel.resetView.title')}
      >
        {t('correctPanel.resetView.label')}
      </Button>
    </>
  )
}
