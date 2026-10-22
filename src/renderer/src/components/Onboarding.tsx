import { useEffect, useLayoutEffect, useState, type JSX } from 'react'
import { useApp } from '../store/appStore'
import { Button } from './Controls'
import { ForwardIcon, BackIcon, CloseIcon } from './Icons'
import { APP_CODENAME, APP_VERSION } from '@shared/version'
import { updatePreferences } from '../settings'
import { t, byLanguage, format } from '@shared/i18n/i18n'
import { ONBOARDING_STEPS_IT, type GuideStep } from './onboardingSteps.it'
import { ONBOARDING_STEPS_EN } from './onboardingSteps.en'

/**
 * Quick tour: shown at first startup, it walks the user through the actual
 * interface elements, highlighting them one at a time. It can be replayed at
 * any time from the help center.
 */

/** Tour steps in the current language. */
function guideSteps(): GuideStep[] {
  return byLanguage({ it: ONBOARDING_STEPS_IT, en: ONBOARDING_STEPS_EN })
}

interface Box {
  top: number
  left: number
  width: number
  height: number
}

export function Onboarding(): JSX.Element {
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const setOnboarding = useApp((s) => s.setOnboarding)
  const setStep = useApp((s) => s.setStep)

  const steps = guideSteps()
  const step = steps[index]
  const last = index === steps.length - 1

  // Some bubbles explain tools of a specific workflow step: that step is
  // selected first, so the element to highlight actually exists.
  useEffect(() => {
    if (step.workflowStep) setStep(step.workflowStep)
  }, [step, setStep])

  useLayoutEffect(() => {
    if (step.target === null) {
      setBox(null)
      return
    }

    function measurement(): void {
      const element = document.querySelector('[data-guide="' + step.target + '"]')
      if (!element) {
        setBox(null)
        return
      }
      const r = element.getBoundingClientRect()
      const margin = 6
      setBox({
        top: r.top - margin,
        left: r.left - margin,
        width: r.width + margin * 2,
        height: r.height + margin * 2
      })
    }

    // A highlighted workflow button also lights up its icon and label.
    let on: Element | null = null
    function turnOn(): void {
      if (!step.target?.startsWith('step-')) return
      on = document.querySelector('[data-guide="' + step.target + '"]')
      on?.classList.add('sl-tour-active')
    }

    // A short delay lets the panel switch complete before measuring.
    const timer = window.setTimeout(() => {
      measurement()
      turnOn()
    }, 60)
    window.addEventListener('resize', measurement)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', measurement)
      on?.classList.remove('sl-tour-active')
    }
  }, [step])

  function close(): void {
    // Merges into the existing preferences instead of replacing them, so the
    // other saved preferences are kept.
    void updatePreferences({ onboardingCompleted: true })
    setOnboarding(false)
  }

  function next(): void {
    if (last) close()
    else setIndex(index + 1)
  }

  /*
   * Bubble position.
   *
   * The side with the most free space around the highlighted element is
   * chosen. Wide elements, or elements resting on the top edge such as the
   * command bars, need the bubble below them: placing it alongside would
   * cover the rest of the bar, i.e. the very commands the user is learning
   * to recognize.
   */
  const bubbleWidth = 406
  const estimatedHeight = 250
  const margin = 16
  let bubbleStyle: React.CSSProperties

  if (box === null) {
    bubbleStyle = {
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: bubbleWidth
    }
  } else {
    const spaceRight = window.innerWidth - (box.left + box.width)
    const spaceLeft = box.left
    const spaceBottom = window.innerHeight - (box.top + box.height)
    const spaceTop = box.top

    // An element spanning a large part of the width leaves no usable space
    // at its sides, whatever the remaining margin.
    const wideElement = box.width > window.innerWidth * 0.3

    /*
     * A horizontal command bar is short and rests on the top edge: the
     * bubble goes below it, because alongside it would cover the nearby
     * buttons, the very ones the user is learning to tell apart. Height is
     * checked together with position: the workflow column also starts at
     * the top, but since it is as tall as the window the bubble goes beside it.
     */
    const inTopBar = box.top < 90 && box.height < 120

    const isBeside =
      !wideElement &&
      !inTopBar &&
      (spaceRight > bubbleWidth + margin * 2 ||
        spaceLeft > bubbleWidth + margin * 2)

    if (isBeside) {
      const toRight = spaceRight > bubbleWidth + margin * 2
      const left = toRight
        ? box.left + box.width + margin
        : box.left - bubbleWidth - margin
      // For a very tall element the bubble is aligned with its center
      // rather than its top edge.
      const verticalReference =
        box.height > estimatedHeight * 1.5
          ? box.top + box.height / 2 - estimatedHeight / 2
          : box.top
      const top = Math.min(
        Math.max(margin, verticalReference),
        Math.max(margin, window.innerHeight - estimatedHeight - margin)
      )
      bubbleStyle = { top, left, width: bubbleWidth }
    } else {
      // Above or below, centered on the element but always within the
      // window edges.
      const below = spaceBottom >= spaceTop
      const top = below
        ? box.top + box.height + margin
        : Math.max(margin, box.top - estimatedHeight - margin)
      const center = box.left + box.width / 2 - bubbleWidth / 2
      const left = Math.min(
        Math.max(margin, center),
        window.innerWidth - bubbleWidth - margin
      )
      bubbleStyle = { top, left, width: bubbleWidth }
    }
  }

  return (
    <>
      <div className={"sl-tour-veil" + (box !== null ? " sl-with-spotlight" : "")} />
      {box !== null ? (
        <div
          className="sl-tour-spotlight"
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height
          }}
        />
      ) : null}

      <div className="sl-tour-bubble" style={bubbleStyle}>
        <div className="sl-tour-step">
          <span>{t('onboarding.stepCounter', { current: index + 1, total: steps.length })}</span>
        </div>
        <h3 className="sl-tour-title">{step.title}</h3>
        <p className="sl-tour-text">
          {format(step.text, { version: APP_VERSION, codename: APP_CODENAME })}
        </p>
        <div className="sl-tour-actions">
          <div className="sl-tour-dots">
            {steps.map((p, i) => (
              <span
                key={p.title}
                className={'sl-tour-dot' + (i === index ? ' sl-active' : '')}
              />
            ))}
          </div>
          {index > 0 ? (
            <Button
              variant="ghost"
              icon={<BackIcon size={15} />}
              onClick={() => setIndex(index - 1)}
            >
              {t('onboarding.back')}
            </Button>
          ) : null}
          <Button variant="ghost" icon={<CloseIcon size={15} />} onClick={close}>
            {t('onboarding.exit')}
          </Button>
          <Button
            variant="primary"
            icon={last ? undefined : <ForwardIcon size={15} />}
            onClick={next}
            data="tour-next"
          >
            {last ? t('onboarding.start') : t('onboarding.next')}
          </Button>
        </div>
      </div>
    </>
  )
}
