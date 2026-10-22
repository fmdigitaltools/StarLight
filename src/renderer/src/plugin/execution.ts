import type { ImageData32 } from '@shared/types'
import { APP_VERSION } from '@shared/version'
import { pluginsToRun, type ProcessingParams } from '@core/image/chain'
import { completeValues } from '@core/plugin/manifest'
import {
  GEOMETRY_UNCHANGED,
  composeGeometry,
  type AppliedGeometry
} from '@core/image/geometry'
import {
  composeSource,
  runInSandbox,
  type IsolatedWorker,
  type PluginRequest,
  type PluginResponse
} from '@core/plugin/isolation'
import type { StretchParams } from '@core/image/stretch'
import { useApp, type NoticeAction } from '../store/appStore'
import {
  EXECUTION,
  GALLERY,
  pluginStopped,
  pluginStoppedAgain,
  suspendedPluginSkipped
} from '@shared/protectionTexts'
import { PLUGIN_CODE_CHANGED } from '@shared/plugin'
import { codeOf, disablePermanently, infoOf, suspend, suspended } from './registry'
import { workerInSandbox } from './sandbox'
import { t } from '@shared/i18n/i18n'

/**
 * Execution of the active plugins, at the end of the processing chain.
 *
 * For each plugin a new worker is created from a blob containing the
 * isolation prelude followed by the plugin code (see
 * core/plugin/isolation.ts), inside the sandbox, the separate plugin process
 * (see sandbox.ts); it is used once and then closed. If the sandbox is not
 * available, the plugin is not applied and the user is notified.
 *
 * A plugin that fails, hangs, runs out of memory or returns something odd is
 * stopped: the image continues unchanged, the plugin stays suspended until
 * StarLight is next opened, and the user gets a notice. If the same version
 * had already stopped in a previous session, the notice offers to disable it
 * permanently.
 *
 * Geometry is accumulated alongside the image: if a plugin moves pixels
 * (rotates, mirrors), its transformation is composed with those of the
 * previous plugins, so the code that shows markers or writes the FITS file
 * knows how to transform the astrometric solution.
 */

/** Final image of the plugins and the overall displacement of its pixels. */
export interface PluginResult {
  image: ImageData32
  geometry: AppliedGeometry
}

/**
 * Where plugins report progress and notices, and the stretch they receive in
 * their context. Usually the app state; batch processing passes its own, so
 * as not to touch the status bar and the history.
 */
export interface PluginEnvironment {
  progress: (label: string, fraction: number) => void
  notify: (type: 'warning', text: string, action?: NoticeAction) => void
  /** Read when the plugins start, that is at the end of the chain. */
  stretch: () => StretchParams
}

/** The plugin environment taken from the current app state. */
export function pluginEnvironmentFromState(): PluginEnvironment {
  const app = useApp.getState()
  return {
    progress: app.setJob,
    notify: app.notify,
    stretch: () => useApp.getState().adjustments.stretch
  }
}

/**
 * Runs the active plugins in list order. Returns the final image with the
 * accumulated geometry, or null if another frame has been opened in the
 * meantime. Never throws because of a plugin.
 */
export async function runActivePlugins(
  image: ImageData32,
  parameters: ProcessingParams,
  label: string,
  start: number,
  stillValid: () => boolean,
  environment?: PluginEnvironment
): Promise<PluginResult | null> {
  const list = pluginsToRun(parameters)
  if (list.length === 0) return { image, geometry: GEOMETRY_UNCHANGED }
  const { progress, notify, stretch } = environment ?? pluginEnvironmentFromState()
  const d = stretch()
  let current = image
  let geometry: AppliedGeometry = GEOMETRY_UNCHANGED
  const withoutGeometry: string[] = []

  for (let i = 0; i < list.length; i++) {
    const chosen = list[i]
    const info = infoOf(chosen.id)
    if (info && suspended(chosen.id)) {
      notify('warning', suspendedPluginSkipped(info.manifest.name))
      continue
    }
    if (!info) {
      notify('warning', t('pluginExecution.notInstalled', { name: chosen.id }))
      continue
    }
    const name = info.manifest.name
    progress(label + ': ' + name + '…', start + ((1 - start) * i) / list.length)
    let response: PluginResponse
    try {
      const code = await codeOf(chosen.id)
      // A plugin runs only in the sandbox, with its memory and network
      // limits: if the sandbox does not respond, the plugin is not applied.
      const worker = await workerInSandbox(composeSource(code), chosen.id, current.data.byteLength)
      if (!worker) {
        notify('warning', t('pluginExecution.sandboxUnavailable', { name }))
        continue
      }
      response = await runInSandbox(worker, {
        image: current,
        values: completeValues(info.manifest, chosen.values),
        context: {
          stretch: { black: d.shadows, midtones: d.midtones, white: d.highlights },
          starLightVersion: APP_VERSION
        }
      }, undefined, info.manifest.geometry)
    } catch (e) {
      const message = withoutIpcPrefix(e instanceof Error ? e.message : String(e))
      response =
        message === PLUGIN_CODE_CHANGED
          ? { result: 'error', message: EXECUTION.codeChanged, own: true }
          : { result: 'error', message }
    }
    if (!stillValid()) return null
    if (response.result === 'ok') {
      current = response.image
      const step = response.geometry ?? GEOMETRY_UNCHANGED
      if (step.type === 'unknown') withoutGeometry.push(name)
      geometry = composeGeometry(geometry, step)
    } else {
      await reportStopped(chosen.id, info.manifest.version, name, readableReason(response), notify)
    }
  }
  if (withoutGeometry.length > 0) {
    // A plugin that cannot say how it moved the pixels makes the astrometric
    // solution unusable: better to say so than to show wrong markers.
    notify(
      'warning',
      withoutGeometry.length === 1
        ? t('pluginExecution.withoutGeometryOne', { name: withoutGeometry[0] })
        : t('pluginExecution.withoutGeometryOther', { names: withoutGeometry.join(t('pluginExecution.nameSeparator')) })
    )
  }
  return { image: current, geometry }
}

/** Removes the prefix Electron adds to errors coming from the main process. */
function withoutIpcPrefix(m: string): string {
  return m.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}

/**
 * The reasons written by StarLight (shared/protectionTexts.ts) are marked
 * `own` and shown as they are; anything else is the message of the error
 * thrown by the plugin code, which is shown in quotes.
 */
function readableReason(response: { message: string; own?: boolean }): string {
  return response.own === true ? response.message : EXECUTION.error(response.message)
}

/** Suspends the plugin, records the failure and notifies, offering to disable it if it happens again. */
async function reportStopped(
  id: string,
  version: string,
  name: string,
  reason: string,
  notify: PluginEnvironment['notify']
): Promise<void> {
  suspend(id, reason)
  let sessions = 1
  try {
    sessions = (await window.starlight.reportPluginFailure(id, version)).sessions
  } catch {
    // Without the failure record, the notice for this session remains.
  }
  if (sessions >= 2) {
    notify('warning', pluginStoppedAgain(name, reason, sessions), {
      label: GALLERY.actionDisablePlugin,
      run: () => void disablePermanently(id)
    })
  } else notify('warning', pluginStopped(name, reason))
}
