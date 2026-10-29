import type { JSX } from 'react'
import { useApp } from '../store/appStore'
import { Button } from './Controls'
import {
  ImportIcon,
  FolderIcon,
  TelescopeIcon,
  WandIcon,
  FitIcon,
  RestartIcon,
  CropIcon
} from './Icons'
import { useLibrary } from '../hooks/useLibrary'
import { GalaxyLogo } from './GalaxyLogo'
import { VERSION_LABEL } from '@shared/version'
import { MenuBar } from './MenuBar'
import { AbracadabraStrength } from './AbracadabraStrength'
import { WhatsNewButton } from './WhatsNewButton'
import { ProjectDialogs } from './ProjectDialogs'
import { HistoryControls } from './HistoryControls'
import { useViewerCrop } from '../hooks/viewerCrop'
import { keysOf } from '../shortcuts'
import { useSettings } from '../settings'
import { effectiveZoom } from '../hooks/useShortcuts'
import { rotateImage, mirrorImage } from '../hooks/viewerRotation'
import {
  RotateCounterclockwiseIcon,
  RotateClockwiseIcon,
  StraightenIcon,
  MirrorHorizontalIcon,
  MirrorVerticalIcon
} from './Icons'
import { openStraighten, closeStraighten, useStraighten } from '../hooks/straighten'
import { t } from '@shared/i18n/i18n'

export function TopBar(): JSX.Element {
  const image = useApp((s) => s.image)
  const fitView = useApp((s) => s.fitView)
  const { importFile, importFolder, importTelescope, magicWand, resetView } = useLibrary()
  const telescopeFolder = useSettings().telescopeFolder.trim()
  const cropEnabled = useViewerCrop((s) => s.on)
  const toggleCrop = useViewerCrop((s) => s.toggle)
  const straightenOpen = useStraighten((s) => s.open)

  const noImage = image === null

  return (
    <header className="sl-topbar">
      {/* First, thin row: brand and menus. It acts as the window drag area;
          the system window controls stay on the right. */}
      <div className="sl-topbar-menu">
        <div className="sl-brand" data-guide="brand">
          <GalaxyLogo size={20} />
          <span className="sl-brand-name">StarLight</span>
          <span className="sl-brand-version">{VERSION_LABEL}</span>
          <WhatsNewButton />
        </div>
        <MenuBar />
      </div>

      {/* Second row: the buttons for the most used commands. */}
      <div className="sl-topbar-commands">
        <div className="sl-topbar-actions" data-guide="import-actions">
          <Button
            variant="primary"
            icon={<ImportIcon size={17} />}
            onClick={importFile}
            title={t('topBar.import.filesTitle')}
          >
            {t('topBar.import.files')}
          </Button>
          <Button
            icon={<FolderIcon size={17} />}
            onClick={importFolder}
            title={t('topBar.import.folderTitle')}
          >
            {t('topBar.import.folder')}
          </Button>
          <Button
            icon={<TelescopeIcon size={17} />}
            onClick={importTelescope}
            disabledValue={telescopeFolder === ''}
            title={
              telescopeFolder === ''
                ? t('topBar.import.telescopeTitleUnset')
                : t('topBar.import.telescopeTitle', { folder: telescopeFolder })
            }
          >
            {t('topBar.import.telescope')}
          </Button>
        </div>

        {/* Center: Back, Forward, Reset, History, rotation ⟲ ⟳, horizontal and vertical Mirror, Straighten, zoom + and −, Fit, Crop. */}
        <div className="sl-topbar-spacer" />
        <HistoryControls
          afterRedo={
            <Button
              icon={<RestartIcon size={17} />}
              onClick={resetView}
              disabledValue={noImage}
              title={t('topBar.reset.title')}
            >
              {t('topBar.reset.label')}
            </Button>
          }
          afterHistory={
            <>
              <Button
                onClick={() => rotateImage(-1)}
                disabledValue={noImage}
                title={t('topBar.rotateCounterclockwise')}
              >
                <RotateCounterclockwiseIcon size={17} />
              </Button>
              <Button
                onClick={() => rotateImage(1)}
                disabledValue={noImage}
                title={t('topBar.rotateClockwise')}
              >
                <RotateClockwiseIcon size={17} />
              </Button>
              <Button
                onClick={() => mirrorImage('horizontal')}
                disabledValue={noImage}
                title={t('topBar.mirrorHorizontal')}
              >
                <MirrorHorizontalIcon size={17} />
              </Button>
              <Button
                onClick={() => mirrorImage('vertical')}
                disabledValue={noImage}
                title={t('topBar.mirrorVertical')}
              >
                <MirrorVerticalIcon size={17} />
              </Button>
              <button
                type="button"
                className={'sl-btn sl-btn-secondary' + (straightenOpen ? ' sl-btn-on' : '')}
                onClick={() => (straightenOpen ? closeStraighten() : openStraighten())}
                disabled={noImage}
                aria-pressed={straightenOpen}
                title={t('topBar.straighten')}
              >
                <StraightenIcon size={17} />
              </button>
              {/* Same step as the + and − keys. */}
              <Button
                onClick={() => useApp.getState().setZoom(effectiveZoom() * 1.25)}
                disabledValue={noImage}
                title={t('topBar.zoomIn', { key: keysOf('zoomIn') })}
              >
                +
              </Button>
              <Button
                onClick={() => useApp.getState().setZoom(effectiveZoom() / 1.25)}
                disabledValue={noImage}
                title={t('topBar.zoomOut', { key: keysOf('zoomOut') })}
              >
                −
              </Button>
              <Button
                icon={<FitIcon size={17} />}
                onClick={fitView}
                disabledValue={noImage}
                title={t('topBar.fit.title')}
              >
                {t('topBar.fit.label')}
              </Button>
              {/* When on, it shows the cyan highlight, like Straighten and History when open. */}
              <button
                type="button"
                className={'sl-btn sl-btn-secondary' + (cropEnabled ? ' sl-btn-on' : '')}
                onClick={toggleCrop}
                disabled={noImage}
                aria-pressed={cropEnabled}
                title={
                  cropEnabled
                    ? t('topBar.crop.hideTitle', { key: keysOf('crop') })
                    : t('topBar.crop.showTitle', { key: keysOf('crop') })
                }
              >
                <CropIcon size={17} />
                <span>{t('topBar.crop.label')}</span>
              </button>
            </>
          }
        />
        <div className="sl-topbar-spacer" />

        {/* Far right, on its own: Abracadabra. */}
        <div className="sl-topbar-actions" data-guide="image-actions">
          <button
            type="button"
            className="sl-abracadabra"
            onClick={magicWand}
            disabled={noImage}
            title={t('topBar.magicWand.title')}
          >
            {/* Halo rotating behind the button and sparkles around the wand.
              Decoration only. */}
            <span className="sl-abracadabra-halo" aria-hidden="true" />
            <span className="sl-abracadabra-icon" aria-hidden="true">
              <WandIcon size={17} />
              <span className="sl-sparkle sl-sparkle-1" />
              <span className="sl-sparkle sl-sparkle-2" />
              <span className="sl-sparkle sl-sparkle-3" />
            </span>
            <span className="sl-abracadabra-text">{t('topBar.magicWand.label')}</span>
          </button>
          <AbracadabraStrength />
        </div>

      </div>

      {/* The project dialogs cover the whole screen: they live here only
          because the commands that open them are in this bar. */}
      <ProjectDialogs />
    </header>
  )
}
