import type { JSX } from 'react'
import { usageRow, type CalibratedLightGroup } from '@core/stack/calibrationGroups'
import { t } from '@shared/i18n/i18n'

/**
 * Calibration summary shown after stacking (Result card of the Stack step):
 * for each group of lights, the masters used, where they come from and why,
 * or why no dark was applied.
 */
export function CalibrationSummary({ groups }: { groups: CalibratedLightGroup[] }): JSX.Element {
  return (
    <div className="sl-libcal-groups" aria-label={t('calibrationSummary.ariaLabel')}>
      {groups.map((g, i) => (
        <div key={i} className="sl-libcal-group">
          <div className="sl-libcal-group-title">{g.description.charAt(0).toUpperCase() + g.description.slice(1)}</div>
          <div className="sl-libcal-choice">
            <span className="sl-libcal-type">{t('calibrationSummary.dark')}</span>
            <span>
              {g.dark
                ? usageRow(g.dark)
                : g.withoutDark
                  ? t('calibrationSummary.noSuitableDark', { reason: g.withoutDark })
                  : t('calibrationSummary.none')}
            </span>
          </div>
          <div className="sl-libcal-choice">
            <span className="sl-libcal-type">{t('calibrationSummary.flat')}</span>
            <span>{g.flat ? usageRow(g.flat) : t('calibrationSummary.noneSuitable')}</span>
          </div>
          <div className="sl-libcal-choice">
            <span className="sl-libcal-type">{t('calibrationSummary.bias')}</span>
            <span>
              {g.bias
                ? usageRow(g.bias)
                : g.dark
                  ? t('calibrationSummary.biasNotNeeded')
                  : t('calibrationSummary.noneSuitable')}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
