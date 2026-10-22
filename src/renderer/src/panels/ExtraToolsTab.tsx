import type { JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Slider, Toggle, Segmented, Button, Label } from '../components/Controls'
import { ProcessIcon } from '../components/Icons'
import { useProcessing } from '../hooks/useProcessing'
import { completeValues, type SliderFormat, type PluginParameter, type ParameterValues } from '@core/plugin/manifest'
import type { PluginInfo } from '@shared/plugin'
import { usePlugin, enablePlugin, setPluginValue, restorePlugin } from '../plugin/registry'
import { formatDecimal, t } from '@shared/i18n/i18n'
import '../styles/plugin.css'

/**
 * "Extra tools" tab of the Process step: the installed plugins, each with a
 * toggle and the controls declared in its manifest, drawn by StarLight with
 * the same controls as the rest of the panel.
 *
 * Enabled plugins run after all the other tools, in the order in which they
 * were enabled; the number next to the name shows that order. Every enabled
 * (or just disabled) plugin has its own Apply button, like the other tabs of
 * the step: it computes the whole chain with the current values.
 */
export function ExtraToolsTab(): JSX.Element {
  const installedItems = usePlugin((s) => s.installedItems)
  const chosenItems = useApp((s) => s.processing.plugin)
  const update = useApp((s) => s.setProcessing)
  const turnedOn = chosenItems.filter((p) => p.active)
  const missingItems = turnedOn.filter((p) => !installedItems.some((i) => i.manifest.id === p.id))

  return (
    <Tab
      title={t('extraToolsTab.title')}
      description={t('extraToolsTab.description')}
      action={
        <Button variant="ghost" onClick={() => usePlugin.getState().openGallery()} title={t('extraToolsTab.gallery.hint')}>
          {t('extraToolsTab.gallery.label')}
        </Button>
      }
    >
      {installedItems.length === 0 ? (
        <p className="sl-plugin-note">
          {t('extraToolsTab.noPlugins')}
        </p>
      ) : null}
      {installedItems.map((info) => {
        const chosen = chosenItems.find((p) => p.id === info.manifest.id)
        const order = turnedOn.findIndex((p) => p.id === info.manifest.id)
        return (
          <Tool
            key={info.manifest.id}
            info={info}
            active={chosen?.active === true}
            order={order >= 0 && turnedOn.length > 1 ? order + 1 : null}
            values={completeValues(info.manifest, chosen?.values)}
          />
        )
      })}
      {missingItems.map((p) => (
        <div key={p.id} className="sl-plugin-tool">
          <p className="sl-plugin-note">
            {t('extraToolsTab.missing.text', { id: p.id })}
          </p>
          <Button
            variant="ghost"
            onClick={() => update({ plugin: chosenItems.filter((x) => x.id !== p.id) })}
          >
            {t('extraToolsTab.missing.remove')}
          </Button>
        </div>
      ))}
    </Tab>
  )
}

function Tool({
  info,
  active,
  order,
  values
}: {
  info: PluginInfo
  active: boolean
  order: number | null
  values: ParameterValues
}): JSX.Element {
  const m = info.manifest
  const { apply } = useProcessing()
  const busy = useApp((s) => s.job.active)
  // The plugin as currently chosen and as it was in the displayed image.
  const current = useApp((s) => s.processing.plugin.find((p) => p.id === m.id))
  const applied = useApp((s) => s.appliedProcessing?.plugin.find((p) => p.id === m.id))
  const wasActive = applied?.active === true
  const changedValue =
    active !== wasActive || (active && JSON.stringify(current?.values ?? {}) !== JSON.stringify(applied?.values ?? {}))
  return (
    <div className="sl-plugin-tool">
      <div className="sl-plugin-head">
        {info.icon ? <img className="sl-plugin-icon" src={info.icon} alt="" /> : null}
        <Toggle
          label={m.name}
          active={active}
          onChange={(v) => enablePlugin(m.id, v)}
          hint={t('extraToolsTab.tool.hint', { description: m.description, author: m.author, license: m.license })}
        />
        {active && order !== null ? (
          <span className="sl-plugin-order sl-mono" title={t('extraToolsTab.tool.orderHint')}>
            {order}°
          </span>
        ) : null}
      </div>
      {active && m.parameters.length > 0 ? (
        <div className="sl-plugin-params">
          {m.parameters.map((p) => (
            <Parameter key={p.id} parameter={p} value={values[p.id]} onChange={(v) => setPluginValue(m.id, p.id, v)} />
          ))}
          <Button variant="ghost" onClick={() => restorePlugin(m.id)}>
            {t('extraToolsTab.tool.defaults')}
          </Button>
        </div>
      ) : null}
      {active || wasActive ? (
        <div className="sl-card-apply">
          {changedValue ? <Label color="amber">{t('extraToolsTab.tool.pending')}</Label> : null}
          <Button
            variant={changedValue ? 'primary' : 'secondary'}
            icon={<ProcessIcon size={14} />}
            onClick={() => void apply()}
            disabledValue={busy}
            title={t('extraToolsTab.tool.applyHint', { name: m.name })}
          >
            {t('extraToolsTab.tool.apply')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function makeFormatter(format: SliderFormat | undefined, step: number): (v: number) => string {
  switch (format) {
    case 'percent':
      return (v) => Math.round(v * 100) + '%'
    case 'integer':
      return (v) => String(Math.round(v))
    case 'degrees':
      return (v) => Math.round(v) + '°'
    default: {
      // As many decimals as the slider step has, up to three.
      const decimals = Math.min(3, Math.max(0, Math.ceil(-Math.log10(step))))
      return (v) => formatDecimal(v, decimals)
    }
  }
}

function Parameter({
  parameter: p,
  value,
  onChange
}: {
  parameter: PluginParameter
  value: number | boolean | string | undefined
  onChange: (v: number | boolean | string) => void
}): JSX.Element {
  if (p.type === 'slider') {
    return (
      <Slider
        label={p.label}
        value={typeof value === 'number' ? value : p.defaultValue}
        min={p.min}
        max={p.max}
        step={p.step}
        format={makeFormatter(p.format, p.step)}
        hint={p.hint}
        onChange={onChange}
      />
    )
  }
  if (p.type === 'toggle') {
    return (
      <Toggle
        label={p.label}
        active={typeof value === 'boolean' ? value : p.defaultValue}
        onChange={onChange}
        hint={p.hint}
      />
    )
  }
  return (
    <div title={p.hint}>
      <span className="sl-plugin-choice-label">{p.label}</span>
      <Segmented<string>
        value={typeof value === 'string' ? value : p.defaultValue}
        options={p.options}
        onChange={onChange}
      />
    </div>
  )
}
