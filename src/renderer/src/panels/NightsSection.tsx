import { useMemo, type JSX } from 'react'
import type { LoadedFrame } from '@shared/types'
import { formatWeight, groupByNight, type NightResult, type NightsChoice } from '@core/stack/nights'
import { Tab, Slider, Toggle, DataEntry, Label, Button } from '../components/Controls'
import { formatDecimal, t } from '@shared/i18n/i18n'

/**
 * List of imaging nights in the Stack step.
 *
 * Shown only when the light frames come from more than one night: with a
 * single night there is nothing to choose and stacking proceeds normally.
 * Each night can be excluded with a toggle and has its own weight, either the
 * one proposed by StarLight (computed during stacking, see `weighNights`) or
 * one set by hand. Measurements and the weight explanation come from the
 * last stacking run.
 */
export function NightsSection({
  lights,
  choice,
  onChoice,
  measurements
}: {
  lights: LoadedFrame[]
  choice: NightsChoice
  onChoice: (s: NightsChoice) => void
  /** Per-night result of the last stacking run, if any. */
  measurements: NightResult[] | undefined
}): JSX.Element | null {
  const nights = useMemo(
    () =>
      groupByNight(
        lights.map((f) => ({
          id: f.id,
          path: f.path,
          dateObs: f.metadata.dateObs,
          longitude: f.metadata.instrumentInfo?.siteLongitude ?? null
        }))
      ),
    [lights]
  )
  if (nights.length <= 1) return null

  const excludedNights = new Set(choice.excludedNights ?? [])
  const weights = choice.weights ?? {}
  const measurementOf = new Map((measurements ?? []).map((m) => [m.key, m]))
  // Noise of the cleanest night, used to express the other nights as a multiple of it.
  const minNoise = Math.min(...(measurements ?? []).filter((m) => m.noise > 0).map((m) => m.noise))

  const include = (key: string, active: boolean): void => {
    const newOnes = new Set(excludedNights)
    if (active) newOnes.delete(key)
    else newOnes.add(key)
    onChoice({ ...choice, excludedNights: [...newOnes] })
  }
  const setWeight = (key: string, weight: number | null): void => {
    const newOnes = { ...weights }
    if (weight === null) delete newOnes[key]
    else newOnes[key] = weight
    onChoice({ ...choice, weights: newOnes })
  }

  const activeCount = nights.filter((n) => !excludedNights.has(n.key) && weights[n.key] !== 0).length

  return (
    <Tab
      title={t('nightsSection.title')}
      action={<Label color="cyan">{activeCount + ' / ' + nights.length}</Label>}
      description={t('nightsSection.description')}
      data="tab-nights"
    >
      {nights.map((n) => {
        const m = measurementOf.get(n.key)
        const manual = weights[n.key]
        const active = !excludedNights.has(n.key)
        const value = manual ?? m?.proposedWeight ?? 1
        return (
          <div key={n.key} className="sl-night">
            <Toggle
              label={t(n.frame.length === 1 ? 'nightsSection.nightLabelOne' : 'nightsSection.nightLabelOther', {
                night: n.label,
                count: n.frame.length
              })}
              active={active}
              onChange={(v) => include(n.key, v)}
              hint={active ? t('nightsSection.toggleHintActive') : t('nightsSection.toggleHintExcluded')}
            />
            {active ? (
              <>
                {m ? (
                  <>
                    {m.hfr > 0 ? (
                      <DataEntry
                        name={t('nightsSection.hfr.name')}
                        value={t('nightsSection.hfr.value', { value: formatDecimal(m.hfr, 2) })}
                        hint={t('nightsSection.hfr.hint')}
                      />
                    ) : null}
                    {Number.isFinite(minNoise) && m.noise > 0 ? (
                      <DataEntry
                        name={t('nightsSection.noise.name')}
                        value={
                          m.noise / minNoise < 1.005
                            ? t('nightsSection.noise.lowest')
                            : t('nightsSection.noise.timesLowest', {
                                value: formatDecimal(m.noise / minNoise, 1)
                              })
                        }
                        hint={t('nightsSection.noise.hint')}
                      />
                    ) : null}
                  </>
                ) : null}
                <Slider
                  label={t('nightsSection.weight.label')}
                  value={value}
                  min={0}
                  max={1}
                  step={0.01}
                  color="lime"
                  format={(v) =>
                    v === 0
                      ? t('nightsSection.weight.excluded')
                      : manual !== undefined
                        ? t('nightsSection.weight.manual', { weight: formatWeight(v) })
                        : m
                          ? t('nightsSection.weight.automaticValue', { weight: formatWeight(v) })
                          : t('nightsSection.weight.automatic')
                  }
                  hint={t('nightsSection.weight.hint')}
                  onChange={(v) => setWeight(n.key, v)}
                />
                {manual !== undefined ? (
                  <Button variant="ghost" onClick={() => setWeight(n.key, null)}>
                    {t('nightsSection.weight.resetToAutomatic')}
                  </Button>
                ) : null}
                {m ? <p className="sl-card-desc">{m.explanation}</p> : null}
              </>
            ) : null}
          </div>
        )
      })}
    </Tab>
  )
}

/** Summary row: number of nights and their weights. */
export function NightsSummary({ nights }: { nights: NightResult[] }): JSX.Element {
  return (
    <DataEntry
      name={t('nightsSection.summary.name')}
      value={t('nightsSection.summary.value', {
        count: nights.length,
        weights: nights.map((n) => formatWeight(n.weight)).join(' · ')
      })}
      hint={nights.map((n) => n.explanation).join('\n')}
    />
  )
}
