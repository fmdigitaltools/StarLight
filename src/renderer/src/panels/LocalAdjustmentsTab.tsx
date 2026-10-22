import { useEffect, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { Tab, Slider, Button, Toggle, Segmented } from '../components/Controls'
import { TrashIcon, EyeIcon, EyeClosedIcon, RestartIcon } from '../components/Icons'
import { useMaskTools, useMaskNotices, chosenLayer, type MaskTool } from '../hooks/viewerMasks'
import { recordStep } from '../hooks/history'
import { displayedAstrometryNow } from '../hooks/displayedAstrometry'
import {
  MAX_LAYERS,
  NEUTRAL_LAYER_ADJUSTMENTS,
  startDimensions,
  mapToSource,
  paintedMeasurements,
  newLayer,
  starsInMemory,
  type LocalLayer,
  type Mask,
  type LayerAdjustments,
  type MaskType
} from '@core/image/masks'
import { applyAffine } from '@core/image/geometry'
import { objectEllipsePixels } from '@core/catalog/crowding'
import { formatDecimal, t } from '@shared/i18n/i18n'
import '../styles/masks.css'

/**
 * "Local adjustments" card of the Correct step.
 *
 * It lives here rather than among the filters because it is a correction
 * like the others in this step (light, contrast, color) restricted to an
 * area: after adjusting the tones of the whole image, the way to touch up
 * one part is right at hand. Filters, instead, set the final look.
 *
 * The flow follows three questions: where to act (the mask), whether to
 * restrict the area by hand (brush), what to change (the adjustments).
 */

/** Mask types; label and hint are language keys under `localAdjustmentsTab.type.<value>`. */
const TYPES: MaskType[] = ['brightness', 'color', 'stars', 'object', 'linear', 'radial', 'whole']

/** Color presets; name and hint are language keys under `localAdjustmentsTab.colorPreset.<id>`. */
const COLORS: { id: string; tint: number; amplitude: number }[] = [
  { id: 'red', tint: 355, amplitude: 22 },
  { id: 'cyan', tint: 170, amplitude: 30 },
  { id: 'blue', tint: 225, amplitude: 25 },
  { id: 'yellow', tint: 45, amplitude: 22 },
  { id: 'magenta', tint: 315, amplitude: 25 },
  { id: 'green', tint: 120, amplitude: 25 }
]

/** Brightness presets; name and hint are language keys under `localAdjustmentsTab.lightPreset.<id>`. */
const LIGHTS: { id: string; from: number; a: number }[] = [
  { id: 'faint', from: 0, a: 0.35 },
  { id: 'midtones', from: 0.25, a: 0.7 },
  { id: 'bright', from: 0.6, a: 1 }
]

/** Painting tools; label and hint are language keys under `localAdjustmentsTab.tool.<value>`. */
const TOOLS: MaskTool[] = ['none', 'brush', 'eraser']

let idCounter = 0

/** First free "Adjustment N" name. */
function freeName(levels: LocalLayer[]): string {
  for (let n = 1; ; n++) {
    const name = t('localAdjustmentsTab.defaultName', { n })
    if (!levels.some((l) => l.name === name)) return name
  }
}

function plusMinus(v: number): string {
  return (v > 0 ? '+' : '') + formatDecimal(v, 2)
}

function percent(v: number): string {
  return Math.round(v * 100) + '%'
}

export function LocalAdjustmentsTab(): JSX.Element {
  const levels = useApp((s) => s.localAdjustments)
  const image = useApp((s) => s.image)
  const geometry = useApp((s) => s.appliedGeometry)
  const notify = useApp((s) => s.notify)
  const tools = useMaskTools()
  const findStars = useMaskNotices((s) => s.findStars)
  const level = chosenLayer(levels, tools.selected)

  // Always keep a layer selected, if there is at least one.
  useEffect(() => {
    if (level === null && levels.length > 0) tools.set({ selected: levels[0].id })
    if (levels.length === 0 && tools.tool !== 'none') tools.set({ tool: 'none' })
  }, [level, levels, tools])

  const replace = (id: string, f: (l: LocalLayer) => LocalLayer): void => {
    const s = useApp.getState()
    s.setLocalAdjustments(s.localAdjustments.map((l) => (l.id === id ? f(l) : l)))
  }
  const updateMask = (patch: Partial<Mask>): void => {
    if (level) replace(level.id, (l) => ({ ...l, mask: { ...l.mask, ...patch } }))
  }
  const updateAdjustments = (patch: Partial<LayerAdjustments>): void => {
    if (level) replace(level.id, (l) => ({ ...l, adjustments: { ...l.adjustments, ...patch } }))
  }

  function add(): void {
    if (!image || levels.length >= MAX_LAYERS) return
    const { width, height } = startDimensions(geometry, image)
    const id = 'locale-' + Date.now().toString(36) + '-' + ++idCounter
    const newValue = newLayer(id, freeName(levels), width, height)
    useApp.getState().setLocalAdjustments([...levels, newValue])
    // Start with the mask visible, so it is immediately clear where it will act.
    tools.set({ selected: id, showMask: true })
  }

  function remove(id: string): void {
    useApp.getState().setLocalAdjustments(levels.filter((l) => l.id !== id))
    if (tools.selected === id) tools.set({ selected: null, tool: 'none' })
  }

  /** Ellipse around the recognized main object, in source pixels; null if there is none. */
  function objectEllipse(): Partial<Mask> | null {
    if (!image) return null
    const a = displayedAstrometryNow()
    const o = a.objects.find((x) => x.position !== null)
    if (!o || !o.position) return null
    const e = objectEllipsePixels(o.object, a.pixelScale, a.wcs)
    const side = Math.min(image.width, image.height)
    // Some margin around the object: the faint halo must be included.
    const halfA = (e?.semiMajor ?? side * 0.15) * 1.3
    const halfB = (e?.semiMinor ?? side * 0.15) * 1.3
    const angle = e?.angle ?? 0
    const map = mapToSource(geometry)
    const cx = o.position.x * image.width - 0.5
    const cy = o.position.y * image.height - 0.5
    const c = applyAffine(map, cx, cy)
    const pa = applyAffine(map, cx + Math.cos(angle) * halfA, cy + Math.sin(angle) * halfA)
    const pb = applyAffine(map, cx - Math.sin(angle) * halfB, cy + Math.cos(angle) * halfB)
    return {
      cx: c.x,
      cy: c.y,
      rx: Math.max(4, Math.hypot(pa.x - c.x, pa.y - c.y)),
      ry: Math.max(4, Math.hypot(pb.x - c.x, pb.y - c.y)),
      angle: Math.atan2(pa.y - c.y, pa.x - c.x)
    }
  }

  function chooseType(type: MaskType): void {
    if (!level) return
    if (type === 'object') {
      const e = objectEllipse()
      if (!e) {
        notify('warning', t('localAdjustmentsTab.noObject'))
        return
      }
      updateMask({ type, ...e, feather: Math.max(level.mask.feather, 0.5) })
      return
    }
    updateMask({ type })
    // Gradients are placed by dragging on the photo.
    if (type === 'linear' || type === 'radial') tools.set({ tool: 'draw', showMask: true })
    else if (tools.tool === 'draw') tools.set({ tool: 'none' })
  }

  function chooseTool(s: MaskTool): void {
    // While painting, show the mask if the layer does nothing yet:
    // otherwise nothing would be visible.
    const neutral = level !== null && Object.values(level.adjustments).every((v) => Math.abs(v) < 0.001)
    tools.set(s !== 'none' && neutral ? { tool: s, showMask: true } : { tool: s })
  }

  function fill(value: number): void {
    if (!level || !image) return
    const measurements = paintedMeasurements(startDimensions(geometry, image))
    const data = new Uint8Array(measurements.width * measurements.height).fill(value)
    const id = level.id
    recordStep(value > 0 ? t('localAdjustmentsTab.history.filled') : t('localAdjustmentsTab.history.cleared'), () =>
      replace(id, (l) => ({ ...l, mask: { ...l.mask, painted: { ...measurements, data } } }))
    )
  }

  const m = level?.mask
  const r = level?.adjustments
  const geometric = m?.type === 'linear' || m?.type === 'radial' || m?.type === 'object'
  const stars = image && m?.type === 'stars' ? starsInMemory(image) : null

  return (
    <Tab
      title={t('localAdjustmentsTab.title')}
      description={t('localAdjustmentsTab.description')}
      action={
        <Button
          variant="ghost"
          onClick={add}
          disabledValue={!image || levels.length >= MAX_LAYERS}
          title={
            levels.length >= MAX_LAYERS
              ? t('localAdjustmentsTab.add.maxHint', { max: MAX_LAYERS })
              : t('localAdjustmentsTab.add.hint')
          }
        >
          {t('localAdjustmentsTab.add.label')}
        </Button>
      }
      data="tab-local-adjustments"
    >
      {levels.length === 0 ? (
        <p className="sl-locals-note">
          {image
            ? t('localAdjustmentsTab.empty', { max: MAX_LAYERS })
            : t('localAdjustmentsTab.noImage')}
        </p>
      ) : (
        <div className="sl-locals-list">
          {levels.map((l) => (
            <div
              key={l.id}
              className={
                'sl-local-row' + (l.id === level?.id ? ' sl-active' : '') + (l.active ? '' : ' sl-local-off')
              }
            >
              <button
                type="button"
                className="sl-local-name"
                onClick={() => tools.set({ selected: l.id })}
                title={t('localAdjustmentsTab.layer.select')}
              >
                {l.name}
                <small>
                  {TYPES.includes(l.mask.type) ? t('localAdjustmentsTab.type.' + l.mask.type + '.label') : ''}
                  {l.mask.painted ? t('localAdjustmentsTab.layer.withBrush') : ''}
                </small>
              </button>
              <button
                type="button"
                className="sl-local-icon"
                onClick={() => replace(l.id, (x) => ({ ...x, active: !x.active }))}
                title={l.active ? t('localAdjustmentsTab.layer.disable') : t('localAdjustmentsTab.layer.enable')}
              >
                {l.active ? <EyeIcon size={15} /> : <EyeClosedIcon size={15} />}
              </button>
              <button
                type="button"
                className="sl-local-icon"
                onClick={() => remove(l.id)}
                title={t('localAdjustmentsTab.layer.remove')}
              >
                <TrashIcon size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {level && m && r ? (
        <>
          <Toggle
            label={t('localAdjustmentsTab.showMask.label')}
            active={tools.showMask}
            onChange={(v) => tools.set({ showMask: v })}
            hint={t('localAdjustmentsTab.showMask.hint')}
          />

          <p className="sl-locals-subtitle">{t('localAdjustmentsTab.where')}</p>
          <div className="sl-locals-choices">
            {TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className={'sl-locals-choice' + (m.type === type ? ' sl-active' : '')}
                title={t('localAdjustmentsTab.type.' + type + '.hint')}
                onClick={() => chooseType(type)}
              >
                {t('localAdjustmentsTab.type.' + type + '.label')}
              </button>
            ))}
          </div>

          {m.type === 'brightness' ? (
            <>
              <div className="sl-locals-choices">
                {LIGHTS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={'sl-locals-choice' + (m.lightFrom === p.from && m.lightTo === p.a ? ' sl-active' : '')}
                    title={t('localAdjustmentsTab.lightPreset.' + p.id + '.hint')}
                    onClick={() => updateMask({ lightFrom: p.from, lightTo: p.a })}
                  >
                    {t('localAdjustmentsTab.lightPreset.' + p.id + '.name')}
                  </button>
                ))}
              </div>
              <Slider
                label={t('localAdjustmentsTab.light.from')}
                value={m.lightFrom}
                min={0}
                max={1}
                step={0.005}
                color="amber"
                format={percent}
                hint={t('localAdjustmentsTab.light.fromHint')}
                onChange={(v) => updateMask({ lightFrom: Math.min(v, m.lightTo) })}
              />
              <Slider
                label={t('localAdjustmentsTab.light.to')}
                value={m.lightTo}
                min={0}
                max={1}
                step={0.005}
                color="amber"
                format={percent}
                hint={t('localAdjustmentsTab.light.toHint')}
                onChange={(v) => updateMask({ lightTo: Math.max(v, m.lightFrom) })}
              />
            </>
          ) : null}

          {m.type === 'color' ? (
            <>
              <div className="sl-locals-choices">
                {COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={'sl-locals-choice' + (Math.abs(m.tint - c.tint) < 0.5 ? ' sl-active' : '')}
                    title={t('localAdjustmentsTab.colorPreset.' + c.id + '.hint')}
                    onClick={() => updateMask({ tint: c.tint, hueWidth: c.amplitude })}
                  >
                    <span className="sl-locals-swatch" style={{ background: `hsl(${c.tint} 85% 55%)` }} />
                    {t('localAdjustmentsTab.colorPreset.' + c.id + '.name')}
                  </button>
                ))}
              </div>
              <Slider
                label={t('localAdjustmentsTab.hue.label')}
                value={m.tint}
                min={0}
                max={360}
                step={1}
                color="magenta"
                format={(v) => Math.round(v) + '°'}
                hint={t('localAdjustmentsTab.hue.hint')}
                onChange={(v) => updateMask({ tint: v })}
              />
              <div className="sl-locals-tints" aria-hidden="true" />
              <Button
                variant={tools.tool === 'eyedropper' ? 'primary' : 'secondary'}
                onClick={() =>
                  tools.set({ tool: tools.tool === 'eyedropper' ? 'none' : 'eyedropper' })
                }
                title={t('localAdjustmentsTab.hue.eyedropperHint')}
              >
                {tools.tool === 'eyedropper' ? t('localAdjustmentsTab.hue.clickPhoto') : t('localAdjustmentsTab.hue.eyedropper')}
              </Button>
              <Slider
                label={t('localAdjustmentsTab.hue.width')}
                value={m.hueWidth}
                min={4}
                max={90}
                step={1}
                color="magenta"
                format={(v) => '±' + Math.round(v) + '°'}
                hint={t('localAdjustmentsTab.hue.widthHint')}
                onChange={(v) => updateMask({ hueWidth: v })}
              />
              <p className="sl-locals-note">{t('localAdjustmentsTab.hue.note')}</p>
            </>
          ) : null}

          {m.type === 'stars' ? (
            <>
              <Slider
                label={t('localAdjustmentsTab.stars.size')}
                value={m.starSize}
                min={0.4}
                max={3}
                step={0.05}
                color="cyan"
                format={(v) => '×' + formatDecimal(v, 2)}
                hint={t('localAdjustmentsTab.stars.sizeHint')}
                onChange={(v) => updateMask({ starSize: v })}
              />
              <p className="sl-locals-note">
                {findStars
                  ? t('localAdjustmentsTab.stars.searching')
                  : stars
                    ? t('localAdjustmentsTab.stars.found', { count: stars.length })
                    : t('localAdjustmentsTab.stars.pending')}
              </p>
            </>
          ) : null}

          {geometric ? (
            <>
              <div className="sl-locals-actions">
                {m.type === 'object' ? (
                  <Button
                    variant="ghost"
                    onClick={() => chooseType('object')}
                    title={t('localAdjustmentsTab.geometry.recenterHint')}
                  >
                    {t('localAdjustmentsTab.geometry.recenter')}
                  </Button>
                ) : null}
                <Button
                  variant={tools.tool === 'draw' ? 'primary' : 'secondary'}
                  onClick={() => chooseTool(tools.tool === 'draw' ? 'none' : 'draw')}
                  title={
                    m.type === 'linear'
                      ? t('localAdjustmentsTab.geometry.drawLinearHint')
                      : t('localAdjustmentsTab.geometry.drawRadialHint')
                  }
                >
                  {tools.tool === 'draw' ? t('localAdjustmentsTab.geometry.drawDone') : t('localAdjustmentsTab.geometry.draw')}
                </Button>
              </div>
              {m.type !== 'linear' ? (
                <>
                  <Slider
                    label={t('localAdjustmentsTab.geometry.radius')}
                    value={m.rx}
                    min={4}
                    max={Math.max(image?.width ?? 1000, image?.height ?? 1000)}
                    step={1}
                    color="cyan"
                    format={(v) => Math.round(v) + ' px'}
                    hint={t('localAdjustmentsTab.geometry.radiusHint')}
                    onChange={(v) => updateMask({ rx: v, ry: m.rx > 0 ? (m.ry / m.rx) * v : v })}
                  />
                  <Slider
                    label={t('localAdjustmentsTab.geometry.elongation')}
                    value={m.rx > 0 ? m.ry / m.rx : 1}
                    min={0.1}
                    max={1}
                    step={0.01}
                    color="cyan"
                    format={(v) => formatDecimal(v, 2)}
                    hint={t('localAdjustmentsTab.geometry.elongationHint')}
                    onChange={(v) => updateMask({ ry: Math.max(2, m.rx * v) })}
                  />
                  <Slider
                    label={t('localAdjustmentsTab.geometry.angle')}
                    value={(m.angle * 180) / Math.PI}
                    min={-180}
                    max={180}
                    step={1}
                    color="cyan"
                    format={(v) => Math.round(v) + '°'}
                    hint={t('localAdjustmentsTab.geometry.angleHint')}
                    onChange={(v) => updateMask({ angle: (v * Math.PI) / 180 })}
                  />
                </>
              ) : (
                <p className="sl-locals-note">
                  {t('localAdjustmentsTab.geometry.linearNote')}
                </p>
              )}
            </>
          ) : null}

          {m.type !== 'linear' && m.type !== 'whole' ? (
            <Slider
              label={t('localAdjustmentsTab.feather.label')}
              value={m.feather}
              min={0}
              max={1}
              color="violet"
              format={percent}
              hint={t('localAdjustmentsTab.feather.hint')}
              onChange={(v) => updateMask({ feather: v })}
            />
          ) : null}
          <Slider
            label={t('localAdjustmentsTab.intensity.label')}
            value={m.intensity}
            min={0}
            max={1}
            color="violet"
            format={percent}
            hint={t('localAdjustmentsTab.intensity.hint')}
            onChange={(v) => updateMask({ intensity: v })}
          />
          <Toggle
            label={t('localAdjustmentsTab.invert.label')}
            active={m.invert}
            onChange={(v) => updateMask({ invert: v })}
            hint={t('localAdjustmentsTab.invert.hint')}
          />

          <p className="sl-locals-subtitle">{t('localAdjustmentsTab.paint.title')}</p>
          <p className="sl-locals-note">
            {m.type === 'whole'
              ? t('localAdjustmentsTab.paint.wholeNote')
              : t('localAdjustmentsTab.paint.optionalNote')}
          </p>
          <Segmented
            value={tools.tool === 'draw' || tools.tool === 'eyedropper' ? 'none' : tools.tool}
            options={TOOLS.map((tool) => ({
              value: tool,
              label: t('localAdjustmentsTab.tool.' + tool + '.label'),
              hint: t('localAdjustmentsTab.tool.' + tool + '.hint')
            }))}
            onChange={chooseTool}
          />
          {tools.tool === 'brush' || tools.tool === 'eraser' ? (
            <>
              <Slider
                label={t('localAdjustmentsTab.paint.size')}
                value={tools.size}
                min={4}
                max={600}
                step={1}
                color="cyan"
                format={(v) => Math.round(v) + ' px'}
                hint={t('localAdjustmentsTab.paint.sizeHint')}
                onChange={(v) => tools.set({ size: v })}
              />
              <Slider
                label={t('localAdjustmentsTab.paint.hardness')}
                value={tools.hardness}
                min={0}
                max={1}
                color="cyan"
                format={percent}
                hint={t('localAdjustmentsTab.paint.hardnessHint')}
                onChange={(v) => tools.set({ hardness: v })}
              />
              <Slider
                label={t('localAdjustmentsTab.paint.opacity')}
                value={tools.opacity}
                min={0.05}
                max={1}
                color="cyan"
                format={percent}
                hint={t('localAdjustmentsTab.paint.opacityHint')}
                onChange={(v) => tools.set({ opacity: v })}
              />
            </>
          ) : null}
          <div className="sl-locals-actions">
            <Button
              variant="ghost"
              onClick={() => fill(255)}
              title={t('localAdjustmentsTab.paint.fillHint')}
            >
              {t('localAdjustmentsTab.paint.fill')}
            </Button>
            <Button variant="ghost" onClick={() => fill(0)} title={t('localAdjustmentsTab.paint.clearHint')}>
              {t('localAdjustmentsTab.paint.clear')}
            </Button>
            {m.painted ? (
              <Button
                variant="ghost"
                onClick={() => {
                  const id = level.id
                  recordStep(t('localAdjustmentsTab.history.paintRemoved'), () =>
                    replace(id, (l) => ({ ...l, mask: { ...l.mask, painted: null } }))
                  )
                }}
                title={t('localAdjustmentsTab.paint.removeHint')}
              >
                {t('localAdjustmentsTab.paint.remove')}
              </Button>
            ) : null}
          </div>

          <p className="sl-locals-subtitle">{t('localAdjustmentsTab.what')}</p>
          <Slider
            label={t('localAdjustmentsTab.adjust.brightness')}
            value={r.brightness}
            min={-0.8}
            max={0.8}
            color="amber"
            format={plusMinus}
            hint={t('localAdjustmentsTab.adjust.brightnessHint')}
            onChange={(v) => updateAdjustments({ brightness: v })}
          />
          <Slider
            label={t('localAdjustmentsTab.adjust.contrast')}
            value={r.contrast}
            min={-1}
            max={1}
            color="amber"
            format={plusMinus}
            hint={t('localAdjustmentsTab.adjust.contrastHint')}
            onChange={(v) => updateAdjustments({ contrast: v })}
          />
          <Slider
            label={t('localAdjustmentsTab.adjust.saturation')}
            value={r.saturation}
            min={-1}
            max={1}
            color="magenta"
            format={plusMinus}
            hint={t('localAdjustmentsTab.adjust.saturationHint')}
            onChange={(v) => updateAdjustments({ saturation: v })}
          />
          <Slider
            label={t('localAdjustmentsTab.adjust.vibrance')}
            value={r.vibrance}
            min={-1}
            max={1}
            color="magenta"
            format={plusMinus}
            hint={t('localAdjustmentsTab.adjust.vibranceHint')}
            onChange={(v) => updateAdjustments({ vibrance: v })}
          />
          <Slider
            label={t('localAdjustmentsTab.adjust.temperature')}
            value={r.temperature}
            min={-1}
            max={1}
            color="amber"
            format={plusMinus}
            hint={t('localAdjustmentsTab.adjust.temperatureHint')}
            onChange={(v) => updateAdjustments({ temperature: v })}
          />
          <Slider
            label={t('localAdjustmentsTab.adjust.tint')}
            value={r.tint}
            min={-1}
            max={1}
            color="lime"
            format={plusMinus}
            hint={t('localAdjustmentsTab.adjust.tintHint')}
            onChange={(v) => updateAdjustments({ tint: v })}
          />
          <Slider
            label={t('localAdjustmentsTab.adjust.sharpness')}
            value={r.sharpness}
            min={0}
            max={1}
            color="violet"
            format={percent}
            hint={t('localAdjustmentsTab.adjust.sharpnessHint')}
            onChange={(v) => updateAdjustments({ sharpness: v })}
          />
          <Slider
            label={t('localAdjustmentsTab.adjust.noiseReduction')}
            value={r.noiseReduction}
            min={0}
            max={1}
            color="violet"
            format={percent}
            hint={t('localAdjustmentsTab.adjust.noiseReductionHint')}
            onChange={(v) => updateAdjustments({ noiseReduction: v })}
          />
          <Button
            variant="ghost"
            icon={<RestartIcon size={15} />}
            onClick={() => updateAdjustments(NEUTRAL_LAYER_ADJUSTMENTS)}
            title={t('localAdjustmentsTab.adjust.resetHint')}
          >
            {t('localAdjustmentsTab.adjust.reset')}
          </Button>
        </>
      ) : null}
    </Tab>
  )
}
