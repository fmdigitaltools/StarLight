import { useEffect, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { formatBytes } from '@core/memory'
import { frameCache } from '../hooks/useLibrary'
import { t } from '@shared/i18n/i18n'

/**
 * Status bar: always shows the working context, so the essential
 * information never has to be looked up elsewhere.
 */
export function StatusBar(): JSX.Element {
  const frame = useApp((s) => s.frame)
  const activeFrameId = useApp((s) => s.activeFrameId)
  const image = useApp((s) => s.image)
  const zoom = useApp((s) => s.zoom)
  const job = useApp((s) => s.job)
  const objects = useApp((s) => s.objects)

  // GPU name as reported by WebGL; null while detecting, '' when WebGL 2 is
  // missing, 'undeclared' when the driver does not report a name.
  const [gpuName, setGpuName] = useState<string | null>(null)
  const [usage, setUsage] = useState<{ cpu: number; memory: number } | null>(null)
  const [frameMemory, setFrameMemory] = useState<{ usage: string; budget: string } | null>(null)

  const active = frame.find((f) => f.id === activeFrameId) ?? null

  useEffect(() => {
    // The GPU name is read from a WebGL context.
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      setGpuName('')
      return
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    setGpuName(ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'undeclared')
  }, [])

  const fullGraphics =
    gpuName === null || gpuName === ''
      ? ''
      : gpuName === 'undeclared'
        ? t('statusBar.gpu.undeclared')
        : gpuName
  const graphics =
    gpuName === null
      ? t('statusBar.gpu.detecting')
      : gpuName === ''
        ? t('statusBar.gpu.noWebgl')
        : gpuName === 'undeclared'
          ? fullGraphics
          : shortGpuName(gpuName)

  useEffect(() => {
    // Live usage every two seconds: often enough to follow it, and the
    // measurement itself is very cheap.
    let live = true
    function update(): void {
      setFrameMemory({ usage: formatBytes(frameCache.usage), budget: formatBytes(frameCache.budget) })
      window.starlight
        .starLightUsage()
        .then((c) => live && setUsage(c))
        .catch(() => undefined)
    }
    update()
    const timer = window.setInterval(update, 2000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [])

  return (
    <footer className="sl-statusbar">
      <span className="sl-status-item">
        <span className="sl-status-dot sl-dot-lime" />
        {frame.length === 0
          ? t('statusBar.library.empty')
          : frame.length === 1
            ? t('statusBar.library.countOne')
            : t('statusBar.library.countOther', { count: frame.length })}
      </span>

      {active ? (
        <>
          <span className="sl-status-sep" />
          <span className="sl-status-item sl-mono">{active.fileName}</span>
        </>
      ) : null}

      {image ? (
        <>
          <span className="sl-status-sep" />
          <span className="sl-status-item sl-mono">
            {image.width} x {image.height}
          </span>
          <span className="sl-status-sep" />
          <span className="sl-status-item sl-mono">
            {image.channels === 3 ? t('statusBar.color') : t('statusBar.monochrome')}
          </span>
          <span className="sl-status-sep" />
          <span className="sl-status-item sl-mono">
            {zoom === 0
              ? t('statusBar.zoomFit')
              : t('statusBar.zoomPercent', { percent: Math.round(zoom * 100) })}
          </span>
        </>
      ) : null}

      {objects.length > 0 ? (
        <>
          <span className="sl-status-sep" />
          <span className="sl-status-item" style={{ color: 'var(--sl-magenta)' }}>
            {objects[0].object.id} - {objects[0].object.name}
          </span>
        </>
      ) : null}

      <div className="sl-topbar-spacer" />

      {job.active ? (
        <span className="sl-status-item sl-status-job" title={job.label}>
          <span className="sl-status-job-text">{job.label}</span>
          <span className="sl-progress">
            <span
              className="sl-progress-bar"
              style={{ transform: 'scaleX(' + job.progress + ')' }}
            />
          </span>
          <span className="sl-mono">{Math.round(job.progress * 100)}%</span>
        </span>
      ) : null}

      <span className="sl-status-sep" />
      <span
        className="sl-status-item sl-status-pair"
        title={t('statusBar.cpuHint')}
      >
        CPU <span className="sl-mono sl-status-number">{usage ? Math.round(usage.cpu) + '%' : '…'}</span>
      </span>
      <span className="sl-status-sep" />
      <span
        className="sl-status-item sl-status-pair"
        title={t('statusBar.ramHint', {
          usage: frameMemory?.usage ?? '',
          budget: frameMemory?.budget ?? ''
        })}
      >
        RAM <span className="sl-mono sl-status-number">{usage ? formatBytes(usage.memory) : '…'}</span>
      </span>
      <span className="sl-status-sep" />
      <span
        className="sl-status-item sl-status-pair"
        title={t('statusBar.gpuHint', { name: fullGraphics })}
        style={{ color: 'var(--sl-lime)' }}
      >
        GPU <span className="sl-mono">{graphics}</span>
      </span>
    </footer>
  )
}

/**
 * GPU name without the driver's technical details: from
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x…) Direct3D11 vs_5_0 ps_5_0, D3D11)"
 * only "NVIDIA GeForce RTX 4060" is kept. The full name is shown in the
 * tooltip and in the About window.
 */
function shortGpuName(name: string): string {
  const inner = name.replace(/^ANGLE \(/, '').replace(/\)$/, '')
  const parts = inner.split(',').map((p) => p.trim())
  const model = (parts.length > 1 ? parts[1] : parts[0]) ?? name
  return (
    model
      .replace(/\(0x[0-9a-f]+\)/gi, '')
      .replace(/\b(Direct3D\d*|D3D\d+|OpenGL|Vulkan|Metal)\b.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim() || name
  )
}
