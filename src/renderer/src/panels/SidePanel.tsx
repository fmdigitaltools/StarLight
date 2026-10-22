import { useLayoutEffect, useRef, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { STEPS } from '../components/WorkflowBar'
import { ImportPanel } from './ImportPanel'
import { CorrectPanel } from './CorrectPanel'
import { ProcessPanel } from './ProcessPanel'
import { FiltersPanel } from './FiltersPanel'
import { ObjectsPanel } from './ObjectsPanel'
import { ExportPanel } from './ExportPanel'
import { StackPanel } from './StackPanel'
import { CalibratePanel } from './CalibratePanel'

/**
 * Right-hand panel: shows only the tools of the selected step, so that
 * newcomers are not overwhelmed by controls.
 */
export function SidePanel(): JSX.Element {
  const step = useApp((s) => s.step)
  const open = useApp((s) => s.openPanel)
  const description = STEPS.find((p) => p.id === step)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Every step starts at the top of the column: the scroll position of the
  // previous step is unrelated to this one. Done before paint so that the
  // jump is not visible.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [step])

  return (
    <aside className={'sl-panel' + (open ? '' : ' sl-panel--closed')} data-guide="panel">
      <header className="sl-panel-head">
        <h2 className="sl-panel-title">{description?.label ?? ''}</h2>
        <p className="sl-panel-desc">{description?.description ?? ''}</p>
      </header>
      <div className="sl-panel-scroll" ref={scrollRef}>
        {step === 'import' ? <ImportPanel /> : null}
        {step === 'process' ? <ProcessPanel /> : null}
        {step === 'correct' ? <CorrectPanel /> : null}
        {step === 'filters' ? <FiltersPanel /> : null}
        {step === 'objects' ? <ObjectsPanel /> : null}
        {step === 'export' ? <ExportPanel /> : null}
        {step === 'calibrate' ? <CalibratePanel /> : null}
        {step === 'align' ? <StackPanel /> : null}
      </div>
    </aside>
  )
}
