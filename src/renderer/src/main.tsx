// The error log comes first: it must hook in before the rest of the
// interface creates its compute workers (see errorLog.ts).
import './errorLog'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LogWindow, SevereErrorNotice } from './components/LogWindow'
// Notice for plugins and catalogs rejected by the startup checks.
import './plugin/startupNotice'
import './styles/theme.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/guide.css'
import { getLanguage, onLanguageChange } from '@shared/i18n/i18n'

// The page declares the interface language: screen readers, hyphenation and
// spell checking depend on it.
document.documentElement.lang = getLanguage()
onLanguageChange((language) => {
  document.documentElement.lang = language
})

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found.')

/*
 * The log window sits outside the error boundary, so it stays usable even
 * when the interface has crashed and shows the error screen.
 */
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <LogWindow />
    <SevereErrorNotice />
  </React.StrictMode>
)
