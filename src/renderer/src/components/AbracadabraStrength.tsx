import { useEffect, useRef, useState, type JSX } from 'react'
import { ABRACADABRA_STRENGTHS } from '@core/image/chain'
import { useSettings, writeSettings } from '../settings'
import { ChevronDownIcon } from './Icons'
import { t } from '@shared/i18n/i18n'
import '../styles/strength.css'

/**
 * Arrow attached to the Abracadabra button, with the menu of the strength
 * (see `STRENGTH_FACTOR` in chain.ts). The choice is a setting: it is
 * remembered and also applies to batch processing, so it can be chosen even
 * before an image is open.
 */
export function AbracadabraStrength(): JSX.Element {
  const strength = useSettings().abracadabraStrength
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)

  // Close on an outside click or Esc, like the history list.
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent): void => {
      if (container.current && !container.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', outside)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', outside)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div className="sl-strength" ref={container}>
      <button
        type="button"
        className={'sl-btn sl-btn-secondary sl-btn-icon sl-strength-button' + (open ? ' sl-btn-on' : '')}
        onClick={() => setOpen((v) => !v)}
        title={t('topBar.strength.title', { level: t(`topBar.strength.${strength}`) })}
        aria-label={t('topBar.strength.menu')}
        aria-expanded={open}
      >
        <ChevronDownIcon size={15} />
      </button>
      {open ? (
        <div className="sl-strength-dropdown" role="dialog" aria-label={t('topBar.strength.menu')}>
          <div className="sl-strength-title">{t('topBar.strength.menu')}</div>
          {ABRACADABRA_STRENGTHS.map((s) => (
            <button
              key={s}
              type="button"
              className={'sl-strength-choice' + (s === strength ? ' sl-strength-choice--current' : '')}
              aria-pressed={s === strength}
              onClick={() => {
                void writeSettings({ abracadabraStrength: s })
                setOpen(false)
              }}
            >
              <span className="sl-strength-name">{t(`topBar.strength.${s}`)}</span>
              <span className="sl-strength-hint">{t(`topBar.strength.${s}Hint`)}</span>
            </button>
          ))}
          <p className="sl-strength-note">{t('topBar.strength.note')}</p>
        </div>
      ) : null}
    </div>
  )
}
