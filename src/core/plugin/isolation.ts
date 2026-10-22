import type { ImageData32 } from '@shared/types'
import type { PluginGeometry, ParameterValues } from './manifest'
import {
  GEOMETRY_UNCHANGED,
  GEOMETRY_UNKNOWN,
  readAffineMatrix,
  type AppliedGeometry
} from '../image/geometry'
import { EXECUTION } from '@shared/protectionTexts'

/**
 * Isolated execution of plugins.
 *
 * A plugin's code never runs together with StarLight's. It runs in a
 * dedicated Web Worker, created for each execution and closed right after,
 * inside a process separate from the user interface (the sandbox, see
 * src/main/pluginSandbox.ts and resources/sandbox/sandbox.html). The worker:
 *
 * - has no bridge to Node or to the main process: it does not see
 *   `window.starlight`, so it cannot read or write files;
 * - has no network and no devices: before the plugin code is evaluated, the
 *   prelude below removes from the environment `fetch`, `XMLHttpRequest`,
 *   `WebSocket`, `EventSource`, `importScripts`, nested workers,
 *   notifications, browser storage and access to USB, HID, serial ports and
 *   Bluetooth, replacing them with functions that throw. In addition, the
 *   security policy of the sandbox page, which the worker inherits, forbids
 *   any connection, any external module and evaluating text as code
 *   (`eval`);
 * - has a time limit: if the plugin hangs (an infinite loop) the worker is
 *   terminated and the user sees a notice;
 * - has a memory cap: the main process monitors the sandbox and closes it
 *   if it exceeds the cap, and if the plugin exhausts the JavaScript
 *   engine's memory only the sandbox goes down, not StarLight.
 *
 * Dynamic module loading (`import(...)`) is language syntax and cannot be
 * removed from the environment: this is why `checkCode` (manifest.ts)
 * rejects any plugin containing `import`, and the sandbox's security policy
 * blocks it anyway.
 *
 * The result is checked after the worker has been stopped: dimensions,
 * channels, data type and length, non-numeric values (a few are zeroed, too
 * many cause the result to be rejected), out-of-range values and, for
 * plugins that move pixels, the consistency of the declared transformation.
 *
 * The plugin receives a copy of the image (planar linear data, as in the
 * rest of the engine) and returns a new image, which is checked before it
 * enters the processing chain. A plugin that declares
 * `geometry: 'transformed'` also puts `transform` in the result: the 2×3
 * affine matrix from the coordinates of the received pixels to those of the
 * returned pixels (see core/image/geometry.ts), or the word `'unknown'` if
 * it cannot describe it in that case.
 */

/** What the plugin receives as the third argument of `processImage`. */
export interface PluginContext {
  /**
   * Stretch the viewer will apply afterwards, with the same meanings as in
   * the Correct step: values below `black` become black, above `white`
   * white, `midtones` below 0.5 brightens. It serves plugins that want to
   * work on the image as it appears (a negative, a glow) and then bring the
   * result back into linear data.
   */
  stretch: { black: number; midtones: number; white: number }
  starLightVersion: string
}

export interface PluginRequest {
  image: ImageData32
  values: ParameterValues
  context: PluginContext
}

/**
 * Worker response. Inside the worker `transformation` is what the plugin
 * wrote (untrusted data); in the response of `runInSandbox`, after the
 * check, there is `geometry` instead, already verified and always present.
 */
export type PluginResponse =
  | { result: 'ok'; image: ImageData32; transformation?: unknown; geometry?: AppliedGeometry }
  | {
      result: 'error'
      message: string
      /**
       * True if the message is a reason written by StarLight (EXECUTION),
       * already readable; absent or false if it comes from the plugin code,
       * and is then shown in quotes.
       */
      own?: boolean
    }

/** Checked result: the image and the pixel displacement it underwent. */
export interface CheckedResult {
  image: ImageData32
  geometry: AppliedGeometry
}

/**
 * Prelude placed before the plugin code, in the same module: a module's
 * statements run in order, so the sandbox is closed before a single line of
 * the plugin is evaluated. It sits inside a block so that its names do not
 * clash with the plugin's; the `processImage` function, on the other hand,
 * is
 * declared by the plugin at module level and is visible from here.
 *
 * It is built at each call, so the error messages are in the current
 * language.
 */
export function isolationPrelude(): string {
  return `{
  const environment = globalThis;
  const send = environment.postMessage.bind(environment);
  const listen = environment.addEventListener.bind(environment);
  // Reasons written by StarLight, told apart from the plugin's own errors
  // (the class is visible only inside this block).
  class OwnReason extends Error {}
  const forbidden = (name) => function () {
    throw new Error(${JSON.stringify(EXECUTION.forbidden)} + name + ${JSON.stringify(EXECUTION.forbiddenTail)});
  };
  const FORBIDDEN = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
    'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches',
    'FileSystemHandle', 'FileSystemDirectoryHandle', 'FileSystemFileHandle', 'RTCPeerConnection',
    'Notification'
  ];
  for (const name of FORBIDDEN) {
    // Environment functions can live on the global object or on its prototypes.
    for (let o = environment; o; o = Object.getPrototypeOf(o)) {
      try { delete o[name]; } catch (e) { /* not deletable: the definition below covers it */ }
    }
    try {
      Object.defineProperty(environment, name, { value: forbidden(name), writable: false, configurable: false });
    } catch (e) { /* already locked */ }
  }
  // Computer storage and devices (USB, HID, serial ports, Bluetooth): kept outside the sandbox.
  for (const name of ['storage', 'usb', 'hid', 'serial', 'bluetooth', 'locks']) {
    try {
      if (environment.navigator) Object.defineProperty(environment.navigator, name, { value: undefined, configurable: false });
    } catch (e) { /* absent */ }
  }
  listen('message', async (event) => {
    const request = event.data || {};
    try {
      if (typeof processImage !== 'function') throw new OwnReason(${JSON.stringify(EXECUTION.withoutProcess)});
      const r = await processImage(request.image, Object.freeze(Object.assign({}, request.values)), Object.freeze(request.context));
      if (!r || typeof r !== 'object') throw new OwnReason(${JSON.stringify(EXECUTION.noImage)});
      const data = r.data;
      const output = { width: r.width, height: r.height, channels: r.channels, data: data };
      // Only numbers or the agreed word are copied from the transformation:
      // anything else never reaches StarLight.
      const t = r.transform;
      const transformation = typeof t === 'string' ? t
        : Array.isArray(t) ? t.map((row) => Array.isArray(row) ? row.map((x) => typeof x === 'number' ? x : NaN) : null)
        : undefined;
      const transferable = data instanceof Float32Array && data.buffer instanceof ArrayBuffer;
      send({ result: 'ok', image: output, transformation: transformation }, transferable ? [data.buffer] : []);
    } catch (e) {
      send({ result: 'error', message: String((e && e.message) || e), own: e instanceof OwnReason });
    }
  });
}
`
}

/**
 * Complete source of the module to run in the worker. `preamble` is used
 * only by the tests in Node, to simulate a browser worker environment.
 */
export function composeSource(code: string, preamble = ''): string {
  return preamble + isolationPrelude() + '\n' + code + '\n'
}

/**
 * Time granted to a plugin: half a minute plus four seconds per million
 * pixels. For a photo of about 2 million pixels this is just under forty
 * seconds: far more than an honest computation needs, short enough not to
 * keep the user waiting too long if the plugin has hung.
 */
export function maxTimeMs(image: ImageData32): number {
  return 30000 + Math.ceil((image.width * image.height) / 1e6) * 4000
}

/**
 * Checks the image returned by a plugin. Returns the image ready for the
 * chain (non-numeric values become zero) with the geometry it underwent, or
 * the sentence explaining what is wrong.
 *
 * `declared` is the manifest's `geometry` field, `transformation` what the
 * plugin returned next to the image:
 *
 * - an "unchanged" plugin that returns the same dimensions moved nothing;
 *   if the dimensions change it moved pixels without saying so (for example
 *   a version written before the field existed), and the geometry becomes
 *   unknown: better to remove the astrometric solution than to keep a wrong
 *   one;
 * - a "transformed" plugin must return a valid matrix, or the word
 *   "unknown"; otherwise the result is rejected, because
 *   the plugin does not honor what it declared.
 */
export function checkResult(
  r: unknown,
  input: ImageData32,
  declared: PluginGeometry = 'unchanged',
  transformation?: unknown
): CheckedResult | string {
  const image = checkImage(r, input)
  if (typeof image === 'string') return image
  const sameSize = image.width === input.width && image.height === input.height
  if (declared === 'unknown') return { image, geometry: GEOMETRY_UNKNOWN }
  if (declared === 'unchanged') {
    return { image, geometry: sameSize ? GEOMETRY_UNCHANGED : GEOMETRY_UNKNOWN }
  }
  if (transformation === 'unknown') return { image, geometry: GEOMETRY_UNKNOWN }
  const matrix = readAffineMatrix(transformation)
  if (matrix === null) return EXECUTION.withoutTransform
  if (!isCoherentTransformation(matrix, input, image)) return EXECUTION.incoherentTransformation
  const identity =
    matrix[0][0] === 1 && matrix[0][1] === 0 && matrix[0][2] === 0 &&
    matrix[1][0] === 0 && matrix[1][1] === 1 && matrix[1][2] === 0
  if (identity && sameSize) return { image, geometry: GEOMETRY_UNCHANGED }
  return {
    image,
    geometry: {
      type: 'transformed',
      matrix,
      input: { width: input.width, height: input.height },
      output: { width: image.width, height: image.height }
    }
  }
}

/**
 * True if the declared transformation maps at least part of the received
 * image inside the returned one. A matrix that sends every pixel outside
 * (for example a 90° rotation without swapped dimensions, or a wrong
 * offset) does not describe what the plugin did, and the astrometric
 * solution would end up in the wrong place.
 */
function isCoherentTransformation(m: number[][], input: ImageData32, output: ImageData32): boolean {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [0, 0],
    [input.width - 1, 0],
    [0, input.height - 1],
    [input.width - 1, input.height - 1]
  ]) {
    xs.push(m[0][0] * x + m[0][1] * y + m[0][2])
    ys.push(m[1][0] * x + m[1][1] * y + m[1][2])
  }
  const tolerance = 0.5
  return (
    Math.max(...xs) >= -tolerance &&
    Math.min(...xs) <= output.width - 1 + tolerance &&
    Math.max(...ys) >= -tolerance &&
    Math.min(...ys) <= output.height - 1 + tolerance
  )
}

/**
 * Value beyond which a returned sample is certainly wrong: the engine works
 * with values close to the range 0 to 1, and a plugin that returns 65535
 * forgot to normalize.
 */
export const PLUGIN_VALUE_LIMIT = 1000

/**
 * Non-numeric values tolerated: a few isolated points (a division by zero
 * at the edges) become zero; beyond 0.1% of the values, or 16 if that is
 * more, the result is rejected because the image would be corrupt.
 */
export function toleratedNonFinite(values: number): number {
  return Math.max(16, Math.ceil(values * 0.001))
}

/** Checks on the image itself: dimensions, channels, data. */
function checkImage(r: unknown, input: ImageData32): ImageData32 | string {
  if (typeof r !== 'object' || r === null) return EXECUTION.noImage
  const { width, height, channels } = r as Record<string, unknown>
  let data = (r as Record<string, unknown>).data
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) {
    return EXECUTION.dimensions
  }
  if (channels !== 1 && channels !== 3) return EXECUTION.channels
  if (!(data instanceof Float32Array)) return EXECUTION.dataType
  const w = width as number
  const h = height as number
  // A plugin may rotate or crop, but not inflate memory at will.
  if (w * h > Math.max(input.width * input.height * 4, 4096 * 4096)) return EXECUTION.tooLarge
  if (data.length !== w * h * channels) return EXECUTION.length
  // Data in shared memory: the plugin could change it after the check.
  // A private copy is checked and used instead.
  if (!(data.buffer instanceof ArrayBuffer)) data = new Float32Array(data)
  const d = data as Float32Array
  let nonFinite = 0
  let outside: number | null = null
  for (let i = 0; i < d.length; i++) {
    const v = d[i]
    if (!Number.isFinite(v)) {
      nonFinite++
      d[i] = 0
    } else if (outside === null && (v > PLUGIN_VALUE_LIMIT || v < -PLUGIN_VALUE_LIMIT)) outside = v
  }
  if (nonFinite > toleratedNonFinite(d.length)) return EXECUTION.nonFinite(nonFinite, d.length)
  if (outside !== null) return EXECUTION.outOfRange(outside)
  return { width: w, height: h, channels, data: d }
}

/**
 * The worker as seen from here: it only needs to receive, respond and be
 * stopped. In the user interface it is a Web Worker, in the tests a Node
 * thread that imitates one.
 */
export interface IsolatedWorker {
  send: (message: PluginRequest, transferables: ArrayBuffer[]) => void
  onResponse: (receive: (r: PluginResponse) => void) => void
  /** `own` is true when the message is a StarLight reason (see PluginResponse). */
  onError: (receive: (message: string, own?: boolean) => void) => void
  terminate: () => void
}

/**
 * Sends the image to the worker and waits for the result, within the time
 * limit. It never throws: every problem comes back as an "error" outcome,
 * so the caller can show a notice and continue. An "ok" response always
 * carries the checked `geometry` (see `checkResult`); the `geometry`
 * parameter here is the one declared in the manifest.
 */
export function runInSandbox(
  worker: IsolatedWorker,
  request: PluginRequest,
  timeMs: number = maxTimeMs(request.image),
  geometry: PluginGeometry = 'unchanged'
): Promise<PluginResponse> {
  return new Promise((solve) => {
    let finished = false
    let terminated = false
    const stop = (): void => {
      if (terminated) return
      terminated = true
      worker.terminate()
    }
    const finish = (r: PluginResponse): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      stop()
      solve(r)
    }
    const timer = setTimeout(
      () =>
        finish({ result: 'error', message: EXECUTION.time(Math.round(timeMs / 1000)), own: true }),
      timeMs
    )
    worker.onResponse((r) => {
      if (finished) return
      if (r && r.result === 'ok') {
        // Stop the worker first, then check: from here on the plugin can no
        // longer touch what it returned.
        stop()
        const checked = checkResult(r.image, request.image, geometry, r.transformation)
        finish(
          typeof checked === 'string'
            ? { result: 'error', message: checked, own: true }
            : { result: 'ok', image: checked.image, geometry: checked.geometry }
        )
      } else {
        finish({
          result: 'error',
          message: r && r.result === 'error' && typeof r.message === 'string' ? r.message.slice(0, 300) : EXECUTION.invalidResponse,
          own: r !== null && typeof r === 'object' && r.result === 'error' && typeof r.message === 'string' && r.own === true
        })
      }
    })
    worker.onError((m, own) =>
      finish({ result: 'error', message: (m || EXECUTION.startupFailed).slice(0, 300), own: own === true && m !== '' })
    )
    try {
      // A copy is always sent: the source image stays intact whatever the
      // plugin does.
      const copy = request.image.data.slice()
      worker.send({ ...request, image: { ...request.image, data: copy } }, [copy.buffer])
    } catch (e) {
      finish({ result: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  })
}
