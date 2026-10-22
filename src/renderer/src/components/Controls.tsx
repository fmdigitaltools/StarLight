import type { JSX, ReactNode } from 'react'
import { formatDecimal } from '@shared/i18n/i18n'

/** Basic controls reused throughout the interface. */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: Variant
  icon?: ReactNode
  disabledValue?: boolean
  fullWidth?: boolean
  title?: string
  data?: string
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  icon,
  disabledValue = false,
  fullWidth = false,
  title,
  data
}: ButtonProps): JSX.Element {
  const classes = ['sl-btn', 'sl-btn-' + variant]
  if (fullWidth) classes.push('sl-btn-filled')
  return (
    <button
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabledValue}
      title={title}
      data-guide={data}
      type="button"
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  /** Formatting of the value shown on the right. */
  format?: (v: number) => string
  hint?: string
  color?: 'cyan' | 'magenta' | 'lime' | 'amber' | 'violet'
  disabledValue?: boolean
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format,
  hint,
  color = 'cyan',
  disabledValue = false
}: SliderProps): JSX.Element {
  const percentage = ((value - min) / (max - min)) * 100
  const text = format ? format(value) : formatDecimal(value, 2)

  return (
    <div className={'sl-slider' + (disabledValue ? ' sl-disabled' : '')} title={hint}>
      <div className="sl-slider-head">
        <span className="sl-slider-label">{label}</span>
        <span className="sl-slider-value sl-mono">{text}</span>
      </div>
      <input
        type="range"
        className={'sl-range sl-range-' + color}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabledValue}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--sl-fill' as string]: percentage + '%' }}
      />
    </div>
  )
}

interface TabProps {
  title: string
  children: ReactNode
  action?: ReactNode
  description?: string
  data?: string
}

export function Tab({ title, children, action, description, data }: TabProps): JSX.Element {
  return (
    <section className="sl-card" data-guide={data}>
      <header className="sl-card-head">
        <h3 className="sl-card-title">{title}</h3>
        {action}
      </header>
      {description ? <p className="sl-card-desc">{description}</p> : null}
      <div className="sl-card-body">{children}</div>
    </section>
  )
}

interface ToggleProps {
  label: string
  active: boolean
  onChange: (v: boolean) => void
  hint?: string
}

export function Toggle({
  label,
  active,
  onChange,
  hint
}: ToggleProps): JSX.Element {
  return (
    <label className="sl-switch" title={hint}>
      <input type="checkbox" checked={active} onChange={(e) => onChange(e.target.checked)} />
      <span className="sl-switch-track">
        <span className="sl-switch-knob" />
      </span>
      <span className="sl-switch-text">{label}</span>
    </label>
  )
}

interface LabelProps {
  children: ReactNode
  color?: 'cyan' | 'magenta' | 'lime' | 'amber' | 'violet' | 'neutral' | 'red'
  title?: string
}

export function Label({ children, color = 'neutral', title }: LabelProps): JSX.Element {
  return (
    <span className={'sl-tag sl-tag-' + color} title={title}>
      {children}
    </span>
  )
}

interface DataEntryProps {
  name: string
  value: ReactNode
  hint?: string
}

/** Name/value row used in information panels. */
export function DataEntry({ name, value, hint }: DataEntryProps): JSX.Element {
  return (
    <div className="sl-data-item" title={hint}>
      <span className="sl-data-name">{name}</span>
      <span className="sl-data-value sl-mono">{value}</span>
    </div>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string; hint?: string; disabledValue?: boolean }[]
  onChange: (v: T) => void
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: SegmentedProps<T>): JSX.Element {
  return (
    <div className="sl-segments" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          title={o.hint}
          className={'sl-segment' + (o.value === value ? ' sl-active' : '')}
          disabled={o.disabledValue}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

interface EmptyProps {
  icon: ReactNode
  title: string
  text: string
  action?: ReactNode
}

/** Empty state: explains what to do when there is no data yet. */
export function Empty({ icon, title, text, action }: EmptyProps): JSX.Element {
  return (
    <div className="sl-empty">
      <div className="sl-empty-icon">{icon}</div>
      <h3 className="sl-empty-title">{title}</h3>
      <p className="sl-empty-text">{text}</p>
      {action ? <div className="sl-empty-action">{action}</div> : null}
    </div>
  )
}
