import { getLanguage, isLanguage, onLanguageChange, setLanguage } from '@shared/i18n/i18n'

/**
 * Interface language inside the compute workers.
 *
 * The workers translate their own texts (errors of file readers, stacking
 * and mosaic, progress labels): each one is a separate module instance and
 * would otherwise always speak the reference language. The language reaches
 * them in two ways:
 * - at creation, at the end of the worker name (`analysis-1 @en`): every
 *   `new Worker` goes through the wrapper in errorLog.ts, which adds it, so
 *   the worker knows it before its first message;
 * - on every later change, on a BroadcastChannel that all the workers
 *   listen to.
 */

const CHANNEL = 'starlight-language'
const SEPARATOR = ' @'

/** Renderer side: the worker name with the current language appended. */
export function nameWithLanguage(name: string): string {
  return name + SEPARATOR + getLanguage()
}

/** Renderer side: sends every language change to the workers. Call once. */
export function broadcastLanguageChanges(): void {
  if (typeof BroadcastChannel !== 'function') return
  const channel = new BroadcastChannel(CHANNEL)
  onLanguageChange((language) => channel.postMessage(language))
}

/**
 * Worker side: takes the language from the worker name and follows its
 * changes. Called once at the top of every worker.
 */
export function followInterfaceLanguage(): void {
  const scope = globalThis as { name?: unknown }
  const name = typeof scope.name === 'string' ? scope.name : ''
  const i = name.lastIndexOf(SEPARATOR)
  if (i >= 0) {
    const language = name.slice(i + SEPARATOR.length)
    if (isLanguage(language)) setLanguage(language)
  }
  if (typeof BroadcastChannel !== 'function') return
  new BroadcastChannel(CHANNEL).onmessage = (event: MessageEvent<unknown>): void => {
    if (isLanguage(event.data)) setLanguage(event.data)
  }
}
