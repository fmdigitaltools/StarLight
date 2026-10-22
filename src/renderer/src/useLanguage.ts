import { useSyncExternalStore } from 'react'
import { getLanguage, onLanguageChange, type Language } from '@shared/i18n/i18n'

/** Current interface language inside a React component; re-renders when it changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(onLanguageChange, getLanguage)
}
