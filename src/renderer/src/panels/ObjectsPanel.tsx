import type { JSX } from 'react'
import type { LoadedFrame, ObjectType } from '@shared/types'
import { useApp } from '../store/appStore'
import { Tab, DataEntry, Label, Toggle, Empty, Button, Segmented } from '../components/Controls'
import { MARKER_GROUPS, type MarkerDensity } from '@core/catalog/crowding'
import { writeSettings, useSettings } from '../settings'
import { ObjectsIcon, StarIcon } from '../components/Icons'
import { usePlateSolve, unsolvableReason } from '../hooks/usePlateSolve'
import { framedField, formatRightAscension, formatDeclination } from '@core/catalog/recognition'
import { objectCount } from '@core/catalog/catalog'
import { useCatalogs } from '../catalogs/registry'
import { useDisplayedAstrometry } from '../hooks/displayedAstrometry'
import { formatDecimal, t } from '@shared/i18n/i18n'

/** Badge color by object type. */
function typeColor(type: ObjectType): 'magenta' | 'cyan' | 'lime' | 'amber' | 'violet' | 'neutral' {
  if (type === 'galaxy') return 'violet'
  if (type === 'planetary-nebula') return 'lime'
  if (type === 'nebula' || type === 'dark-nebula') return 'magenta'
  if (type === 'supernova-remnant') return 'amber'
  if (type === 'open-cluster' || type === 'globular-cluster') return 'cyan'
  return 'neutral'
}

/** Language keys of the displayed object type names; translated at render time. */
const TYPE_LABEL_KEYS: Partial<Record<ObjectType, string>> = {
  galaxy: 'objectsPanel.type.galaxy',
  star: 'objectsPanel.type.star',
  planet: 'objectsPanel.type.planet',
  moon: 'objectsPanel.type.moon',
  sun: 'objectsPanel.type.sun',
  nebula: 'objectsPanel.type.nebula',
  'planetary-nebula': 'objectsPanel.type.planetaryNebula',
  'supernova-remnant': 'objectsPanel.type.supernovaRemnant',
  'open-cluster': 'objectsPanel.type.openCluster',
  'globular-cluster': 'objectsPanel.type.globularCluster',
  'dark-nebula': 'objectsPanel.type.darkNebula',
  'double-star': 'objectsPanel.type.doubleStar',
  'galaxy-group': 'objectsPanel.type.galaxyGroup',
  other: 'objectsPanel.type.other'
}

function typeLabel(type: ObjectType): string {
  const key = TYPE_LABEL_KEYS[type]
  return key ? t(key) : type
}

/** Language keys explaining the method by which the object was identified. */
const EXPLAIN_METHOD_KEYS: Record<string, string> = {
  'header-name': 'objectsPanel.method.headerName',
  coordinates: 'objectsPanel.method.coordinates',
  'solved-field': 'objectsPanel.method.solvedField'
}

/**
 * Card for solving the field from the stars, shown only when the file has
 * no astrometric solution: without one, objects can be recognized but their
 * position in the image is unknown.
 */
function PlateSolveTab({ frame }: { frame: LoadedFrame }): JSX.Element {
  const { solve, inProgress } = usePlateSolve()
  const activeJob = useApp((s) => s.job.active)
  const reason = unsolvableReason(frame)
  const localStars = useCatalogs((s) => s.installedItems.some((c) => c.manifest.type === 'stars' && c.active && !c.problems))
  return (
    <Tab
      title={t('objectsPanel.plateSolve.title')}
      description={t(localStars ? 'objectsPanel.plateSolve.descriptionLocal' : 'objectsPanel.plateSolve.descriptionOnline')}
    >
      {reason !== null ? (
        <p className="sl-card-desc">{reason}</p>
      ) : (
        <Button
          fullWidth
          variant="primary"
          icon={<StarIcon size={16} />}
          disabledValue={inProgress || activeJob}
          onClick={() => void solve()}
          data="solve-field"
        >
          {inProgress ? t('objectsPanel.plateSolve.solving') : t('objectsPanel.plateSolve.solve')}
        </Button>
      )}
    </Tab>
  )
}

export function ObjectsPanel(): JSX.Element {
  const objects = useApp((s) => s.objects)
  const frame = useApp((s) => s.frame)
  const activeFrameId = useApp((s) => s.activeFrameId)
  const adjustments = useApp((s) => s.adjustments)
  const update = useApp((s) => s.updateAdjustments)

  const active = frame.find((f) => f.id === activeFrameId) ?? null
  const field =
    active !== null ? framedField(active.metadata, active.width, active.height) : null
  const plateSolveSection =
    active !== null && active.metadata.wcs === null ? <PlateSolveTab frame={active} /> : null

  if (objects.length === 0) {
    return (
      <>
        <Empty
          icon={<ObjectsIcon size={30} />}
          title={t('objectsPanel.empty.title')}
          text={
            active === null
              ? t('objectsPanel.empty.noFrame')
              : t('objectsPanel.empty.notRecognized', { count: objectCount() })
          }
        />
        {plateSolveSection}
        <CoordinatesTab />
      </>
    )
  }

  const main = objects[0]
  const others = objects.slice(1)

  return (
    <>
      <Tab
        title={t('objectsPanel.main.title')}
        action={<Label color={typeColor(main.object.type)}>{typeLabel(main.object.type)}</Label>}
        data="tab-object"
      >
        <div className="sl-object-name">{main.object.name}</div>
        <div className="sl-object-id sl-mono">
          {main.object.id}
          {main.object.aliases.length > 0 ? ' - ' + main.object.aliases.join(' - ') : ''}
        </div>
        <p className="sl-object-desc">{main.object.description}</p>

        <DataEntry name={t('objectsPanel.main.constellation')} value={main.object.constellation} />
        {main.object.magnitude !== null ? (
          <DataEntry
            name={t('objectsPanel.main.magnitude')}
            value={formatDecimal(main.object.magnitude, 1)}
            hint={t('objectsPanel.main.magnitudeHint')}
          />
        ) : null}
        {main.object.sizeArcmin !== null ? (
          <DataEntry
            name={t('objectsPanel.main.size')}
            value={main.object.sizeArcmin + " '"}
            hint={t('objectsPanel.main.sizeHint')}
          />
        ) : null}
        <DataEntry name={t('objectsPanel.main.rightAscension')} value={formatRightAscension(main.object.ra)} />
        <DataEntry name={t('objectsPanel.main.declination')} value={formatDeclination(main.object.dec)} />
        <DataEntry
          name={t('objectsPanel.main.recognition')}
          value={Math.round(main.confidence * 100) + '%'}
          hint={EXPLAIN_METHOD_KEYS[main.method] ? t(EXPLAIN_METHOD_KEYS[main.method]) : main.method}
        />
        {main.offsetArcmin !== null && main.offsetArcmin > 1 ? (
          <DataEntry
            name={t('objectsPanel.main.offset')}
            value={formatDecimal(main.offsetArcmin, 1) + " '"}
          />
        ) : null}
      </Tab>

      {plateSolveSection}

      {field !== null ? (
        <Tab title={t('objectsPanel.field.title')}>
          <DataEntry
            name={t('objectsPanel.field.size')}
            value={
              formatDecimal(field.width * 60, 1) + " ' x " + formatDecimal(field.height * 60, 1) + " '"
            }
            hint={t('objectsPanel.field.sizeHint')}
          />
          <DataEntry
            name={t('objectsPanel.field.degrees')}
            value={formatDecimal(field.width, 2) + ' x ' + formatDecimal(field.height, 2)}
          />
        </Tab>
      ) : null}

      {others.length > 0 ? (
        <Tab
          title={t('objectsPanel.others.title')}
          action={<Label color="neutral">{others.length}</Label>}
          description={t('objectsPanel.others.description')}
        >
          {others.map((o) => (
            <div key={o.object.id} className="sl-object-row">
              <div>
                <div className="sl-object-row-name">{o.object.name}</div>
                <div className="sl-object-row-id sl-mono">
                  {o.object.id}
                  {o.offsetArcmin !== null ? t('objectsPanel.others.offset', { arcmin: formatDecimal(o.offsetArcmin, 0) }) : ''}
                </div>
              </div>
              <Label color={typeColor(o.object.type)}>{typeLabel(o.object.type)}</Label>
            </div>
          ))}
        </Tab>
      ) : null}

      <Tab
        title={t('objectsPanel.overlay.title')}
        description={t('objectsPanel.overlay.description')}
      >
        <Toggle
          label={t('objectsPanel.overlay.showMarkers')}
          active={adjustments.showStars}
          onChange={(v) => update({ showStars: v })}
        />
        <MarkersChoice />
      </Tab>

      <CoordinatesTab />
    </>
  )
}

/**
 * Coordinate grid, orientation and scale bar: they are turned on here and
 * apply to the viewer and, if chosen in the Export step, to the file. The
 * choices are saved. They require the astrometric solution.
 */
function CoordinatesTab(): JSX.Element | null {
  const { wcs } = useDisplayedAstrometry()
  const { coordinatesGrid, coordinatesOrientation, coordinatesScale } = useSettings()
  if (wcs === null) return null
  return (
    <Tab
      title={t('objectsPanel.coordinates.title')}
      description={t('objectsPanel.coordinates.description')}
    >
      <Toggle
        label={t('objectsPanel.coordinates.grid')}
        active={coordinatesGrid}
        onChange={(v) => void writeSettings({ coordinatesGrid: v })}
        hint={t('objectsPanel.coordinates.gridHint')}
      />
      <Toggle
        label={t('objectsPanel.coordinates.orientation')}
        active={coordinatesOrientation}
        onChange={(v) => void writeSettings({ coordinatesOrientation: v })}
        hint={t('objectsPanel.coordinates.orientationHint')}
      />
      <Toggle
        label={t('objectsPanel.coordinates.scaleBar')}
        active={coordinatesScale}
        onChange={(v) => void writeSettings({ coordinatesScale: v })}
        hint={t('objectsPanel.coordinates.scaleBarHint')}
      />
    </Tab>
  )
}

/** Marker density and object types to show; the choices are saved. */
function MarkersChoice(): JSX.Element {
  const { markerDensity, hiddenMarkerTypes } = useSettings()
  const toggle = (id: string): void => {
    const hidden = hiddenMarkerTypes.includes(id)
      ? hiddenMarkerTypes.filter((x) => x !== id)
      : [...hiddenMarkerTypes, id]
    void writeSettings({ hiddenMarkerTypes: hidden })
  }
  return (
    <>
      <Segmented<MarkerDensity>
        value={markerDensity}
        options={[
          { value: 'essential', label: t('objectsPanel.density.essential'), hint: t('objectsPanel.density.essentialHint') },
          { value: 'normal', label: t('objectsPanel.density.normal'), hint: t('objectsPanel.density.normalHint') },
          { value: 'rich', label: t('objectsPanel.density.rich'), hint: t('objectsPanel.density.richHint') }
        ]}
        onChange={(v) => void writeSettings({ markerDensity: v })}
      />
      <div className="sl-marker-types" role="group" aria-label={t('objectsPanel.markerTypes.label')}>
        {MARKER_GROUPS.map((g) => {
          const visible = !hiddenMarkerTypes.includes(g.id)
          return (
            <button
              key={g.id}
              type="button"
              className={'sl-marker-type' + (visible ? ' sl-marker-type--active' : '')}
              aria-pressed={visible}
              onClick={() => toggle(g.id)}
              title={visible ? t('objectsPanel.markerTypes.hide') : t('objectsPanel.markerTypes.show')}
            >
              {g.name}
            </button>
          )
        })}
      </div>
    </>
  )
}
