import { ipcRenderer } from 'electron'

/**
 * Preload of the plugin sandbox (resources/sandbox/sandbox.html). It exposes
 * nothing to the page: it only forwards to the page the per-run message
 * channels sent here by the main process, because a MessagePort cannot cross
 * the boundary between preload and page any other way.
 */
ipcRenderer.on('sandbox:port', (event, data: { id: number }) => {
  const port = event.ports[0]
  if (port) window.postMessage({ type: 'starlight-plugin-sandbox', id: data.id }, '*', [port])
})
