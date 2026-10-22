import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { Button } from './Controls'
import { RestartIcon } from './Icons'
import { useLogWindow } from './LogWindow'
import { writeLog, errorText } from '../errorLog'
import { t } from '@shared/i18n/i18n'

/**
 * Error boundary around the interface. If a component throws while
 * rendering, a friendly screen with "Reload" and "Open log" appears instead
 * of a blank window; the error is written to the program log and flagged as
 * severe, so that the user is offered to look at it on the next start.
 *
 * On reload, if there was unsaved work of which StarLight had kept a copy,
 * the user is offered to recover it (hooks/recovery.ts).
 */

interface Props {
  children: ReactNode
}

interface State {
  error: unknown
  /** Development builds only: makes the interface fail on purpose for testing. */
  test: boolean
}

/** Event that, in development builds, triggers an interface error to test this screen. */
export const TEST_ERROR_EVENT = 'starlight:test-interface-error'

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, test: false }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('error without description') }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const components = (info.componentStack ?? '').trim().split('\n').slice(0, 12).join('\n')
    writeLog(
      'error',
      'ui',
      'The interface crashed: ' + errorText(error) + (components ? '\nComponents:\n' + components : ''),
      true
    )
  }

  private triggerTestError = (): void => this.setState({ test: true })

  componentDidMount(): void {
    if (import.meta.env.DEV) window.addEventListener(TEST_ERROR_EVENT, this.triggerTestError)
  }

  componentWillUnmount(): void {
    window.removeEventListener(TEST_ERROR_EVENT, this.triggerTestError)
  }

  render(): ReactNode {
    if (this.state.error !== null) return <ErrorScreen error={this.state.error} />
    return (
      <>
        {this.props.children}
        {this.state.test ? <TestError /> : null}
      </>
    )
  }
}

function TestError(): JSX.Element {
  throw new Error('Test: interface error triggered on purpose')
}

function ErrorScreen({ error }: { error: unknown }): JSX.Element {
  const message = errorText(error).split('\n')[0]
  return (
    <div className="sl-error-screen" role="alert" data-guide="error-screen">
      {/* Strip at the top for moving the window: the title bar is drawn by the app. */}
      <div className="sl-error-drag" />
      <div className="sl-error-card">
        <svg
          width={40}
          height={40}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="sl-error-icon"
        >
          <path d="M12 3l9.5 16.5h-19z" />
          <path d="M12 10v4" />
          <path d="M12 17.2v.1" />
        </svg>
        <h1 className="sl-error-title">{t('errorBoundary.title')}</h1>
        <p className="sl-error-text">{t('errorBoundary.text')}</p>
        <p className="sl-error-detail sl-mono sl-selectable">{message}</p>
        <p className="sl-error-text sl-error-text--small">{t('errorBoundary.logNote')}</p>
        <div className="sl-error-commands">
          <Button onClick={() => useLogWindow.getState().open()} data="error-log">
            {t('errorBoundary.openLog')}
          </Button>
          <Button
            variant="primary"
            icon={<RestartIcon size={15} />}
            onClick={() => window.location.reload()}
            data="error-reload"
          >
            {t('errorBoundary.reload')}
          </Button>
        </div>
      </div>
    </div>
  )
}
