import type { SandboxFailed } from '@shared/plugin'
import { EXECUTION } from '@shared/protectionTexts'
import type { IsolatedWorker, PluginRequest, PluginResponse } from '@core/plugin/isolation'

/**
 * Plugin worker in the sandbox, the separate process plugins run in (see
 * src/main/pluginSandbox.ts). Seen from here it is an IsolatedWorker like any
 * other; behind it is a direct channel to the sandbox page, which creates the
 * Web Worker and passes it the source and the image.
 *
 * The channel arrives from the preload through window.postMessage; if it
 * arrives before anyone is waiting for it, it is kept aside until requested.
 */

const PORT_TYPE = 'starlight-plugin-sandbox'
const PORT_WAIT_MS = 10000

const arrived = new Map<number, MessagePort>()
const expected = new Map<number, (p: MessagePort) => void>()
const crashHandlers = new Map<number, (c: SandboxFailed) => void>()

window.addEventListener('message', (event: MessageEvent) => {
  const d = event.data as { type?: string; id?: number } | null
  if (event.source !== window || !d || d.type !== PORT_TYPE || typeof d.id !== 'number') return
  const port = event.ports[0]
  if (!port) return
  const wait = expected.get(d.id)
  if (wait) {
    expected.delete(d.id)
    wait(port)
  } else arrived.set(d.id, port)
})

window.starlight.onSandboxCrashed((c) => crashHandlers.get(c.id)?.(c))

function waitForPort(id: number): Promise<MessagePort | null> {
  const already = arrived.get(id)
  if (already) {
    arrived.delete(id)
    return Promise.resolve(already)
  }
  return new Promise((solve) => {
    const timer = setTimeout(() => {
      expected.delete(id)
      solve(null)
    }, PORT_WAIT_MS)
    expected.set(id, (p) => {
      clearTimeout(timer)
      solve(p)
    })
  })
}

/**
 * Prepares a sandbox worker for the given source (prelude plus plugin code).
 * Null if the sandbox is not available; in that case the plugin is not
 * applied (see execution.ts).
 */
export async function workerInSandbox(source: string, name: string, imageBytes: number): Promise<IsolatedWorker | null> {
  let id: number | null
  try {
    id = await window.starlight.openPluginSandbox(imageBytes)
  } catch {
    return null
  }
  if (id === null) return null
  const port = await waitForPort(id)
  if (!port) {
    void window.starlight.closePluginSandbox(id)
    return null
  }
  const runId = id
  let receive: ((r: PluginResponse) => void) | null = null
  let error: ((m: string, own?: boolean) => void) | null = null
  port.onmessage = (m: MessageEvent): void => {
    const d = m.data as { type?: string; response?: PluginResponse; message?: string } | null
    if (d?.type === 'response') receive?.(d.response as PluginResponse)
    else if (d?.type === 'error') error?.(d.message || EXECUTION.startupFailed)
  }
  port.onmessageerror = (): void => error?.(EXECUTION.unreadableResponse)
  crashHandlers.set(runId, (c) => error?.(c.reason === 'memory' ? EXECUTION.memory(c.limitMB) : EXECUTION.crashed, true))
  return {
    send: (request: PluginRequest, transferables: ArrayBuffer[]) =>
      port.postMessage({ type: 'run', source, name: 'plugin-' + name, request }, transferables),
    onResponse: (f) => {
      receive = f
    },
    onError: (f) => {
      error = f
    },
    terminate: () => {
      try {
        port.postMessage({ type: 'terminate' })
      } catch {
        // Channel already closed.
      }
      port.close()
      crashHandlers.delete(runId)
      void window.starlight.closePluginSandbox(runId)
    }
  }
}
