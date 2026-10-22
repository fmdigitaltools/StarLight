import { Fragment, type JSX, type ReactNode } from 'react'
import { AUTHOR, AUTHOR_EMAIL } from '@shared/version'
import { t } from '@shared/i18n/i18n'

/**
 * "Privacy and data" and "Legal notes" sections of the About window.
 *
 * They describe what the program actually does: if an internet connection
 * changes (src/main/updates.ts, catalogs.ts, gaiaCatalog.ts), or the default
 * value of `internet` in src/renderer/src/settings.ts, or the data checkbox in
 * the uninstaller (resources/installer/installer.nsh), or any data written
 * into exported files (core/export/encoding.ts), this text must be updated too.
 */

/** Replaces `{name}` placeholders in a translated sentence with JSX elements. */
function withParts(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/\{(\w+)\}/).map((piece, i) =>
    i % 2 === 1 ? <Fragment key={i}>{parts[piece] ?? '{' + piece + '}'}</Fragment> : piece
  )
}

export function LegalSections({ openLicense }: { openLicense: () => void }): JSX.Element {
  return (
    <>
      <h3 className="sl-guide-section-title">{t('legalSections.privacy.title')}</h3>
      <div className="sl-legal">
        <p>{t('legalSections.privacy.intro')}</p>

        <h4>{t('legalSections.network.title')}</h4>
        <p>{t('legalSections.network.intro')}</p>
        <ul>
          <li>
            <strong>{t('legalSections.network.updatesLabel')}</strong> {t('legalSections.network.updatesText')}
          </li>
          <li>
            <strong>{t('legalSections.network.catalogsLabel')}</strong> {t('legalSections.network.catalogsText')}
          </li>
          <li>
            <strong>{t('legalSections.network.gaiaLabel')}</strong> {t('legalSections.network.gaiaText')}
          </li>
        </ul>
        <p>{t('legalSections.network.donate')}</p>

        <h4>{t('legalSections.transmitted.title')}</h4>
        <p>{t('legalSections.transmitted.ipAddress')}</p>
        <p>{t('legalSections.transmitted.hosting')}</p>

        <h4>{t('legalSections.stored.title')}</h4>
        <p>
          {withParts(t('legalSections.stored.dataFolder'), {
            folder: <span className="sl-legal-code">%APPDATA%\StarLight</span>,
            userProfile: <span className="sl-legal-code">%USERPROFILE%</span>
          })}
        </p>
        <p>{t('legalSections.stored.uninstall')}</p>

        <h4>{t('legalSections.metadata.title')}</h4>
        <p>{t('legalSections.metadata.text')}</p>

        <h4>{t('legalSections.contacts.title')}</h4>
        <p>
          {withParts(t('legalSections.contacts.text'), {
            email: <span className="sl-selectable sl-legal-code">{AUTHOR_EMAIL}</span>
          })}
        </p>
      </div>

      <h3 className="sl-guide-section-title">{t('legalSections.legal.title')}</h3>
      <div className="sl-legal">
        <p>
          {withParts(t('legalSections.legal.freeSoftware', { author: AUTHOR }), {
            license: (
              <button type="button" className="sl-credit-link sl-legal-link" onClick={openLicense}>
                {t('legalSections.legal.licenseLink')}
              </button>
            )
          })}
        </p>
        <p>
          <strong>{t('legalSections.legal.warrantyLabel')}</strong> {t('legalSections.legal.warrantyText')}
        </p>
        <p>
          <strong>{t('legalSections.legal.thirdPartiesLabel')}</strong> {t('legalSections.legal.thirdPartiesText')}
        </p>
      </div>
    </>
  )
}
