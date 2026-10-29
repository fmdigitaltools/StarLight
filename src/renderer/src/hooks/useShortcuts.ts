import { useEffect, useRef } from 'react'
import { useApp } from '../store/appStore'
import {
  openProject,
  closeProject,
  newProject,
  saveProject,
  saveProjectAs,
  useProjectDialogs
} from './useProject'
import { useSettingsWindow } from '../components/SettingsWindow'
import { useShortcutsWindow } from '../components/ShortcutsWindow'
import { useDetectedStars } from '../components/DetectedStars'
import { STEPS } from '../components/WorkflowBar'
import { useLibrary } from './useLibrary'
import { undo, repeat } from './history'
import { setComparison } from './comparison'
import { toggleClippingWarning } from './clippingWarning'
import { shortcutFor, type ShortcutId } from '../shortcuts'
import { useMaskTools, type MaskTool } from './viewerMasks'
import { useViewerCrop } from './viewerCrop'
import { t } from '@shared/i18n/i18n'

/**
 * Effective viewer zoom. Zoom 0 means "fit to window" and must be converted
 * to the corresponding factor, otherwise zooming in from there would
 * multiply zero.
 */
export function effectiveZoom(): number {
  const s = useApp.getState()
  if (s.zoom > 0) return s.zoom
  const canvas = document.querySelector<HTMLCanvasElement>('.sl-viewer canvas')
  if (!s.image || !canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) return 1
  // Same measure as ViewerGL.fitZoom.
  return Math.min(canvas.clientWidth / s.image.width, canvas.clientHeight / s.image.height) * 0.96
}

/** Event used by shortcuts to open and close the history (see HistoryControls). */
export const HISTORY_EVENT = 'starlight:commuta-cronologia'

/**
 * True if the key must be left to a text input field. Sliders, checkboxes
 * and buttons do not count: shortcuts work there, and arrow keys stay with
 * the sliders because no shortcut uses them.
 */
function inField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button'].includes(target.type)) ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/** Is a window covering the application (help, about, dialogs)? */
function windowOpen(): boolean {
  return document.querySelector('.sl-overlay, [aria-modal="true"]') !== null
}

/** Full screen through the browser API: Esc exits it on its own. */
export function toggleFullscreen(): void {
  const notify = useApp.getState().notify
  const done = document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen()
  done.catch((error: unknown) =>
    notify(
      'error',
      t('hooksUseShortcuts.fullScreenFailed', { message: error instanceof Error ? error.message : String(error) })
    )
  )
}

/**
 * Keyboard shortcuts. Keys and descriptions live in `shortcuts.ts` (the same
 * source used by the menus, the help center and the shortcuts window); this
 * module only defines what each one does.
 */
export function useShortcuts(): void {
  // The library commands change identity on re-render: the handler,
  // registered only once, always reads the latest ones.
  const library = useLibrary()
  const commands = useRef(library)
  commands.current = library

  useEffect(() => {
    function run(id: ShortcutId): void {
      const state = useApp.getState()
      const lib = commands.current
      const withImage = state.image !== null
      switch (id) {
        case 'new':
          if (state.frame.length > 0 || withImage) newProject()
          return
        case 'close':
          if (state.frame.length > 0 || withImage) closeProject()
          return
        case 'import':
          void lib.importFile()
          return
        case 'export':
          if (withImage) state.setStep('export')
          return
        case 'history':
          window.dispatchEvent(new Event(HISTORY_EVENT))
          return
        case 'fit':
          state.fitView()
          return
        case 'actualSize':
          state.setZoom(1)
          return
        case 'zoomIn':
          state.setZoom(effectiveZoom() * 1.25)
          return
        case 'zoomOut':
          state.setZoom(effectiveZoom() / 1.25)
          return
        case 'compare':
          if (withImage) setComparison(true)
          return
        case 'markers':
          if (withImage) state.updateAdjustments({ showStars: !state.adjustments.showStars })
          return
        case 'stars':
          if (withImage) useDetectedStars.getState().toggle()
          return
        case 'crop':
          if (withImage) useViewerCrop.getState().toggle()
          return
        case 'clipping':
          if (withImage) toggleClippingWarning()
          return
        case 'panel':
          state.togglePanel()
          return
        case 'fullScreen':
          toggleFullscreen()
          return
        case 'abracadabra':
          void lib.magicWand()
          return
        case 'stretch':
          lib.applyAutostretch()
          return
        case 'reset':
          lib.resetView()
          return
        case 'brush':
        case 'eraser':
          maskTool(id)
          return
        case 'showMask': {
          const m = useMaskTools.getState()
          if (m.selected === null) return notifyNoLayerSelected()
          m.set({ showMask: !m.showMask })
          return
        }
        case 'biggerBrush':
        case 'smallerBrush': {
          const m = useMaskTools.getState()
          const factor = id === 'biggerBrush' ? 1.2 : 1 / 1.2
          m.set({ size: Math.round(Math.min(800, Math.max(4, m.size * factor))) })
          return
        }
        case 'help':
          useShortcutsWindow.getState().close()
          state.setHelpOpen(!state.helpOpenActive)
          return
        case 'shortcutList':
          useShortcutsWindow.getState().toggle()
          return
        default:
          if (id.startsWith('step')) goToStep(Number(id.slice(4)) - 1)
          return
      }
    }

    /** Brush and eraser work on the local adjustment selected in the Correct step. */
    function maskTool(chosen: MaskTool): void {
      const m = useMaskTools.getState()
      if (m.selected === null) return notifyNoLayerSelected()
      // Pressing the same key again returns to panning the image.
      m.set({ tool: m.tool === chosen ? 'none' : chosen })
    }

    function notifyNoLayerSelected(): void {
      useApp
        .getState()
        .notify('info', t('hooksUseShortcuts.noLayerSelected'))
    }

    /** Same as clicking the step in the workflow bar, with a notice if it is not available yet. */
    function goToStep(index: number): void {
      const p = STEPS[index]
      if (!p) return
      const state = useApp.getState()
      const noFrame = p.requiresFrame && state.frame.length === 0
      const noImage = p.requiresImage && state.image === null
      if (noFrame || noImage) {
        state.notify(
          'info',
          noFrame
            ? t('hooksUseShortcuts.stepNeedsFrame', { step: p.label })
            : t('hooksUseShortcuts.stepNeedsImage', { step: p.label })
        )
        return
      }
      state.setStep(p.id)
      if (p.id === 'import' && state.frame.length === 0) void commands.current.importFile()
    }

    function handle(e: KeyboardEvent): void {
      const state = useApp.getState()
      const field = inField(e.target)
      const s = shortcutFor(e)

      // Undo and redo: in text fields they stay with the field.
      if (s && (s.id === 'undo' || s.id === 'redo')) {
        if (field) return
        e.preventDefault()
        if (s.id === 'redo') repeat()
        else undo()
        return
      }

      // Projects: these work everywhere, even while typing in a field, but
      // not when a project dialog is already open.
      if (s && (s.id === 'open' || s.id === 'save' || s.id === 'saveAs')) {
        e.preventDefault()
        if (useProjectDialogs.getState().dialog !== null || e.repeat) return
        if (s.id === 'open') void openProject()
        else if (s.id === 'saveAs') saveProjectAs()
        else void saveProject()
        return
      }

      // Ctrl+comma opens the settings, a common convention.
      if (s?.id === 'settings') {
        e.preventDefault()
        useSettingsWindow.getState().open()
        return
      }

      // With the settings open, viewer keys do not apply: Esc closes them,
      // F1 closes them and opens the help.
      if (useSettingsWindow.getState().isOpen) {
        if (e.key === 'Escape' || e.key === 'F1') useSettingsWindow.getState().close()
        if (e.key !== 'F1') return
      }

      // In text fields the keyboard stays with the focused element.
      if (field && !(s?.alsoInFields ?? false)) return

      if (e.key === 'Escape') {
        if (state.infoOpen) state.setInfo(false)
        else if (state.helpOpenActive) state.setHelpOpen(false)
        else if (state.onboardingActive) state.setOnboarding(false)
        return
      }

      if (!s) return

      // With a window open over the application (help, about, confirmations)
      // only the keys concerning those windows apply.
      if (windowOpen() && !['help', 'shortcutList', 'fullScreen'].includes(s.id)) return

      // Inside menus, letters and Tab belong to the menus themselves.
      const inMenu = document.activeElement?.closest('[role="menubar"]') != null
      if (inMenu && !e.ctrlKey && !e.altKey && !e.key.startsWith('F')) return

      // Tab shows and hides the panel, but keyboard navigation between
      // controls (focus ring visible) still moves to the next one.
      if (s.id === 'panel') {
        const active = document.activeElement
        if (active && active !== document.body && active.matches(':focus-visible')) return
      }

      e.preventDefault()
      if (e.repeat && !s.repeatable) return
      run(s.id)
    }

    // The before/after comparison lasts while the key is held down.
    function release(e: KeyboardEvent): void {
      if (e.key === '\\') setComparison(false)
    }
    // If the window loses focus while the key is held, the release never arrives.
    function losesFocus(): void {
      setComparison(false)
    }

    window.addEventListener('keydown', handle)
    window.addEventListener('keyup', release)
    window.addEventListener('blur', losesFocus)
    return () => {
      window.removeEventListener('keydown', handle)
      window.removeEventListener('keyup', release)
      window.removeEventListener('blur', losesFocus)
    }
  }, [])
}
