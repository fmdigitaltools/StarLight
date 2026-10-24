/*
 * Address of the server for updates and catalogs.
 *
 * The main address uses the StarLight domain and forwards to the Worker that
 * serves the files; if it does not respond (for example because the domain's
 * site is unreachable) the Worker address is used directly, so updates and
 * catalogs keep working. The choice is remembered for a few minutes so the
 * probe is not repeated on every request.
 *
 * The domain's web hosting can also answer with a page of its own (a bot
 * check, a maintenance notice) instead of forwarding: a web page is never a
 * file of the server, so it counts as "not responding" too.
 */
import { UPDATES_URL, FALLBACK_UPDATES_URL } from '@shared/version'
import { writeLog } from './log'

/** How long a choice stays valid, in milliseconds. */
const CHOICE_VALIDITY_MS = 10 * 60 * 1000

/**
 * File asked for to see whether the main address responds: the catalog
 * index is always on the server, whatever the published versions are
 * (a Beta, for example, writes beta.yml but no latest.yml).
 */
const PROBE_FILE = 'catalogs/catalogs.json'

let chosen: string | null = null
let chosenAt = 0

/** True when the response is a web page: the server only serves files (JSON, YAML, archives). */
export function isWebPage(response: Response): boolean {
  return /text\/html/i.test(response.headers.get('content-type') ?? '')
}

/** Address to use now, with the trailing slash. */
export async function serverAddressReachable(): Promise<string> {
  if (chosen !== null && Date.now() - chosenAt < CHOICE_VALIDITY_MS) return chosen
  let mainResponds = false
  try {
    const response = await fetch(UPDATES_URL + PROBE_FILE, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(6000)
    })
    mainResponds = response.ok && !isWebPage(response)
  } catch {
    mainResponds = false
  }
  chosen = mainResponds ? UPDATES_URL : FALLBACK_UPDATES_URL
  chosenAt = Date.now()
  return chosen
}

/**
 * Switches to the Worker address for the next few minutes, after the main
 * address answered with something that is not a server file.
 * Returns false when the Worker address was already in use.
 */
export function useFallbackAddress(reason: string): boolean {
  const wasMain = chosen !== FALLBACK_UPDATES_URL
  chosen = FALLBACK_UPDATES_URL
  chosenAt = Date.now()
  if (wasMain) writeLog('warning', 'main', 'Server: the main address failed (' + reason + '); using the Worker address.')
  return wasMain
}

/**
 * Requests a file from the server (path relative to the address, e.g.
 * "catalogs/catalogs.json"). If the main address fails or answers with a web
 * page, the request is repeated once on the Worker address.
 */
export async function fetchFromServer(path: string, init: RequestInit): Promise<Response> {
  const base = await serverAddressReachable()
  if (base === FALLBACK_UPDATES_URL) return fetch(base + path, init)
  try {
    const response = await fetch(base + path, init)
    if (!isWebPage(response)) return response
    useFallbackAddress('web page instead of ' + path)
  } catch (e) {
    if (init.signal?.aborted) throw e
    useFallbackAddress(e instanceof Error ? e.message : String(e))
  }
  return fetch(FALLBACK_UPDATES_URL + path, init)
}
