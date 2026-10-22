import { useEffect, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { CloseIcon } from './Icons'
import { t } from '@shared/i18n/i18n'

/**
 * Temporary messages in the bottom-left corner that disappear on their own.
 * A notice can carry a button (for example to re-enable internet access):
 * the action runs only when the button is clicked, and such a notice stays
 * on screen longer.
 */
export function Notices(): JSX.Element | null {
  const notices = useApp((s) => s.notices)
  const closeNotice = useApp((s) => s.closeNotice)

  useEffect(() => {
    if (notices.length === 0) return
    const last = notices[notices.length - 1]
    // Short-lived so they inform without getting in the way; errors stay a little longer so they can be read.
    const duration = last.action ? 30000 : last.type === 'error' ? 10000 : 3000
    const timer = window.setTimeout(() => closeNotice(last.id), duration)
    return () => window.clearTimeout(timer)
  }, [notices, closeNotice])

  if (notices.length === 0) return null

  return (
    <div className="sl-notices" role="status" aria-live="polite">
      {notices.map((a) => (
        <div key={a.id} className={'sl-notice sl-notice-' + a.type}>
          <div className="sl-notice-body">
            <span>{a.text}</span>
            {a.action ? (
              <button
                type="button"
                className="sl-notice-action"
                onClick={() => {
                  closeNotice(a.id)
                  a.action!.run()
                }}
              >
                {a.action.label}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="sl-notice-close"
            onClick={() => closeNotice(a.id)}
            title={t('notices.close')}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
