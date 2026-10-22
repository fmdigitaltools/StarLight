import type { FrameStats, ObjectType, RecognizedObject, Wcs } from '@shared/types'
import type { Curves, CurvePoint } from '@core/image/curve'
import { NEUTRAL_CURVES } from '@core/image/curve'
import type { Crop } from '@core/export/crop'
import { FULL_CROP, clampCrop } from '@core/export/crop'
import { NEUTRAL_PROCESSING, type ProcessingParams, type BackgroundMode, type BalanceMode } from '@core/image/chain'
import { NARROWBAND_NEUTRAL, NARROWBAND_PALETTES, type NarrowbandPalette } from '@core/image/narrowband'
import { readEnabledPlugins } from '@core/plugin/manifest'
import {
  GEOMETRY_UNKNOWN,
  readAppliedGeometry,
  type AppliedGeometry
} from '@core/image/geometry'
import { readSavedLayers, type SavedLayer } from '@core/image/masks'
import { t } from '@shared/i18n/i18n'

/**
 * Projects: saving work and resuming it.
 *
 * A project is a folder containing the `project.slight` file (JSON text
 * with the processing state) and the displayed image saved as 32-bit FITS,
 * so that on reopening the result is ready without redoing stacking and
 * processing. The original frames are not copied: the file remembers their
 * paths.
 *
 * This module holds only the pure part (from state to text and back, names
 * and paths), so it can be tested without the user interface.
 */

/**
 * File format version. It must be increased when the meaning of a field
 * changes; new fields do not require it, because missing fields take their
 * neutral value when read.
 */
export const FORMAT_VERSION = 1

/** Signature that distinguishes a StarLight project from any other JSON. */
export const PROJECT_SIGNATURE = 'StarLight project'

export const PROJECT_FILE_NAME = 'project.slight'
export const IMAGE_NAME = 'image.fit'
export const ORIGINAL_NAME = 'original.fit'

/** A library frame as remembered in the project. */
export interface ProjectFrame {
  path: string
  excluded: boolean
  /** Measurements already computed, so they need not be redone on reopening. */
  statistics: FrameStats | null
  quality: number | null
  /**
   * Astrometric solution found by plate solving, for files that do not
   * carry one in the header: without it, it would have to be redone on
   * reopening. Absent in older projects.
   */
  solution?: SavedWcs | null
}

/**
 * Astrometric solution in a JSON-serializable form: the distortion
 * coefficients, held in maps in memory, become pairs.
 */
export interface SavedWcs {
  crval: [number, number]
  crpix: [number, number]
  cd: [[number, number], [number, number]]
  cdInverse: [[number, number], [number, number]]
  a: [string, number][]
  b: [string, number][]
  ap: [string, number][]
  bp: [string, number][]
  naxis1: number
  naxis2: number
}

/** From the in-memory solution to the form to save. */
export function wcsToSave(wcs: Wcs): SavedWcs {
  return {
    crval: [wcs.crval[0], wcs.crval[1]],
    crpix: [wcs.crpix[0], wcs.crpix[1]],
    cd: [[wcs.cd[0][0], wcs.cd[0][1]], [wcs.cd[1][0], wcs.cd[1][1]]],
    cdInverse: [[wcs.cdInverse[0][0], wcs.cdInverse[0][1]], [wcs.cdInverse[1][0], wcs.cdInverse[1][1]]],
    a: [...wcs.a],
    b: [...wcs.b],
    ap: [...wcs.ap],
    bp: [...wcs.bp],
    naxis1: wcs.naxis1,
    naxis2: wcs.naxis2
  }
}

/**
 * From the saved form to the in-memory solution; null if the data is
 * missing or corrupt (a wrong solution would misplace every marker: better
 * none, and it can be found again by plate solving).
 */
export function wcsFromProject(v: unknown): Wcs | null {
  if (!object(v)) return null
  const finished = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  const pair = (x: unknown): [number, number] | null =>
    Array.isArray(x) && x.length === 2 && finished(x[0]) && finished(x[1]) ? [x[0], x[1]] : null
  const matrix = (x: unknown): [[number, number], [number, number]] | null => {
    if (!Array.isArray(x) || x.length !== 2) return null
    const r0 = pair(x[0])
    const r1 = pair(x[1])
    return r0 && r1 ? [r0, r1] : null
  }
  const map = (x: unknown): Map<string, number> | null => {
    if (x === undefined) return new Map()
    if (!Array.isArray(x)) return null
    const m = new Map<string, number>()
    for (const e of x) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !finished(e[1])) return null
      m.set(e[0], e[1])
    }
    return m
  }
  const crval = pair(v['crval'])
  const crpix = pair(v['crpix'])
  const cd = matrix(v['cd'])
  const cdInverse = matrix(v['cdInverse'])
  const a = map(v['a'])
  const b = map(v['b'])
  const ap = map(v['ap'])
  const bp = map(v['bp'])
  if (!crval || !crpix || !cd || !cdInverse || !a || !b || !ap || !bp) return null
  if (cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0] === 0) return null
  return {
    crval,
    crpix,
    cd,
    cdInverse,
    a,
    b,
    ap,
    bp,
    naxis1: finished(v['naxis1']) ? v['naxis1'] : 0,
    naxis2: finished(v['naxis2']) ? v['naxis2'] : 0
  }
}

/**
 * Where the displayed image comes from, when it is not simply the open
 * frame: a regular stack, a drizzle (pixels smaller than the frame's) or a
 * mosaic (a wider field).
 */
export type ResultType = 'stacked' | 'drizzle' | 'mosaic'

const RESULT_TYPES: ResultType[] = ['stacked', 'drizzle', 'mosaic']

/**
 * Geometry of the displayed result. Drizzle and mosaic do not share the
 * scale and astrometric solution of the frame they replace: without this
 * data, on reopening markers, field scale and photometry would use the
 * file's values and be wrong.
 */
export interface SavedResult {
  type: ResultType
  /** Dimensions of the source image (the one processing starts from). */
  width: number
  height: number
  /** Scale in arcseconds per pixel. */
  pixelScale: number | null
  wcs: SavedWcs | null
  /** Field center in degrees (a mosaic moves it). */
  ra: number | null
  dec: number | null
  /** Paths of the frames used as mosaic panels. */
  panels: string[]
}

/**
 * Reads the result geometry; null if it is missing (older projects, or an
 * image that is the frame as it is) or corrupt. The solution is kept as
 * written: `wcsFromProject` validates it.
 */
export function readResult(v: unknown): SavedResult | null {
  if (!object(v)) return null
  const type = v['type']
  if (typeof type !== 'string' || !RESULT_TYPES.includes(type as ResultType)) return null
  const whole = (x: unknown): number | null =>
    typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : null
  const number = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const width = whole(v['width'])
  const height = whole(v['height'])
  if (width === null || height === null) return null
  const scale = number(v['pixelScale'])
  return {
    type: type as ResultType,
    width,
    height,
    pixelScale: scale !== null && scale > 0 ? scale : null,
    wcs: object(v['wcs']) ? (v['wcs'] as unknown as SavedWcs) : null,
    ra: number(v['ra']),
    dec: number(v['dec']),
    panels: Array.isArray(v['panels'])
      ? v['panels'].filter((x): x is string => typeof x === 'string' && x !== '')
      : []
  }
}

/** The result geometry as held in memory, with the actual solution. */
export interface InMemoryResult extends Omit<SavedResult, 'wcs'> {
  wcs: Wcs | null
}

/** From the in-memory geometry to the form to save. */
export function resultToSave(r: InMemoryResult): SavedResult {
  return { ...r, panels: [...r.panels], wcs: r.wcs !== null ? wcsToSave(r.wcs) : null }
}

/** From the saved form to the in-memory geometry (validated solution). */
export function resultFromProject(r: SavedResult): InMemoryResult {
  return { ...r, panels: [...r.panels], wcs: wcsFromProject(r.wcs) }
}

/** Everything the project stores. */
export interface ProjectState<R extends object> {
  name: string
  frame: ProjectFrame[]
  /** Path of the active frame, or null. */
  activeFrame: string | null
  /** File name of the displayed image, inside the project folder. */
  image: string | null
  /** File name of the source image, if different from the displayed one. */
  originalImage: string | null
  /**
   * Image geometry if it is a result (stack, drizzle, mosaic); null if it is
   * the frame as it is. Absent in older projects.
   */
  result: SavedResult | null
  adjustments: R
  /**
   * Local adjustments with their masks. Painted masks are stored in
   * separate files in the project folder (in the recovery copy, inside the
   * text). Absent in older projects.
   */
  localAdjustments?: SavedLayer[]
  curves: Curves
  processing: ProcessingParams
  appliedProcessing: ProcessingParams | null
  /**
   * How the applied plugins moved the pixels of the saved image (rotated,
   * mirrored). Absent in older projects: the caller decides what to assume.
   */
  appliedGeometry?: AppliedGeometry
  /** Quarter turns requested with the rotation buttons; absent = 0. */
  rotation?: number
  /**
   * Left-to-right mirroring requested with the Mirror buttons, applied
   * before the quarter turns (canonical order: mirror, quarter turns, free
   * rotation); absent = none.
   */
  mirrored?: boolean
  /** Free rotation in degrees requested with Straighten; absent = 0. */
  freeRotation?: number
  crop: Crop
  aspectRatio: string
  preset: string | null
  objects: RecognizedObject[]
  withCalibration: boolean
  step: string
  /**
   * Read-only, never saved: things to tell whoever opens the project (for
   * example a plugin that no longer exists, converted or ignored).
   */
  notices?: string[]
}

/** Read error with a message ready to show. */
export class ProjectError extends Error {}

/** Turns the state into the text to write to the file. */
export function serializeProject<R extends object>(
  state: ProjectState<R>,
  appVersion: string,
  now: Date = new Date()
): string {
  return JSON.stringify(
    {
      format: PROJECT_SIGNATURE,
      version: FORMAT_VERSION,
      appVersion,
      savedAt: now.toISOString(),
      ...state,
      notices: undefined
    },
    null,
    2
  )
}

/**
 * Reads the text of a project file. Missing or invalid fields take their
 * neutral value: a file written by an earlier version, which did not know a
 * setting, still opens.
 */
export function readProject<R extends object>(text: string, neutralAdjustments: R): ProjectState<R> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ProjectError(t('coreProject.errors.corrupt'))
  }
  if (!object(raw) || raw['format'] !== PROJECT_SIGNATURE) {
    throw new ProjectError(t('coreProject.errors.notProject'))
  }
  const version = raw['version']
  if (typeof version !== 'number' || version > FORMAT_VERSION) {
    throw new ProjectError(t('coreProject.errors.newerVersion'))
  }

  const frame: ProjectFrame[] = []
  if (Array.isArray(raw['frame'])) {
    for (const f of raw['frame']) {
      if (!object(f) || typeof f['path'] !== 'string' || f['path'] === '') continue
      frame.push({
        path: f['path'],
        excluded: f['excluded'] === true,
        statistics: object(f['statistics']) ? (f['statistics'] as unknown as FrameStats) : null,
        quality: typeof f['quality'] === 'number' ? f['quality'] : null,
        // Kept as written: `wcsFromProject` validates it on opening, so a
        // missing frame writes it back intact.
        ...(object(f['solution']) ? { solution: f['solution'] as unknown as SavedWcs } : {})
      })
    }
  }

  const applied = raw['appliedProcessing']
  const crop = merge(FULL_CROP, raw['crop'])

  return {
    name: textOr(raw['name'], t('coreProject.defaultName')),
    frame,
    activeFrame: textOrNull(raw['activeFrame']),
    image: textOrNull(raw['image']),
    originalImage: textOrNull(raw['originalImage']),
    result: readResult(raw['result']),
    adjustments: merge(neutralAdjustments, raw['adjustments']),
    localAdjustments: readSavedLayers(raw['localAdjustments']),
    curves: readCurves(raw['curves']),
    processing: readProcessing(raw['processing']),
    appliedProcessing: object(applied) ? readProcessing(applied) : null,
    ...(raw['appliedGeometry'] !== undefined
      ? { appliedGeometry: readAppliedGeometry(raw['appliedGeometry']) }
      : {}),
    ...(Number.isInteger(raw['rotation']) ? { rotation: (((raw['rotation'] as number) % 4) + 4) % 4 } : {}),
    ...(typeof raw['mirrored'] === 'boolean' ? { mirrored: raw['mirrored'] } : {}),
    ...(typeof raw['freeRotation'] === 'number' && Number.isFinite(raw['freeRotation'])
      ? { freeRotation: raw['freeRotation'] as number }
      : {}),
    crop: clampCrop(crop),
    aspectRatio: textOr(raw['aspectRatio'], 'original'),
    preset: textOrNull(raw['preset']),
    objects: Array.isArray(raw['objects']) ? (raw['objects'] as RecognizedObject[]) : [],
    withCalibration: raw['withCalibration'] !== false,
    step: textOr(raw['step'], 'import')
  }
}


/**
 * Cleans the name typed by the user so it can become a Windows folder
 * name. Returns an empty string if nothing usable is left.
 */
export function cleanName(name: string): string {
  let cleaned = name
    // Characters forbidden in file names, and control characters.
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows does not accept names ending with a dot or a space.
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  // Names reserved by Windows, also with an extension (e.g. "con.txt").
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(cleaned)) cleaned = cleaned + reservedNameSuffix()
  return cleaned
}

/** Suffix added to names reserved by Windows: " (project)". */
export function reservedNameSuffix(): string {
  return ' (' + t('coreProject.reservedNameSuffix') + ')'
}

/** Joins folder and name using the same separator as the folder. */
export function joinPath(folder: string, name: string): string {
  const separator = folder.includes('\\') ? '\\' : '/'
  const base = folder.endsWith('/') || folder.endsWith('\\') ? folder.slice(0, -1) : folder
  return base + separator + name
}

/** Folder containing a file. */
export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i <= 0 ? path : path.slice(0, i)
}

/** Last element of a path: the file or folder name. */
export function nameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(i + 1)
}

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function textOr(v: unknown, defaultValue: string): string {
  return typeof v === 'string' && v !== '' ? v : defaultValue
}

/**
 * Overlays the saved values onto the neutral ones, field by field and also
 * inside nested objects. A saved value of a type other than the expected
 * one is discarded. Unknown fields are ignored.
 */
export function merge<T>(neutral: T, saved: unknown): T {
  if (saved === undefined) return neutral
  if (object(neutral)) {
    if (!object(saved)) return neutral
    const result: Record<string, unknown> = { ...neutral }
    for (const key of Object.keys(neutral)) result[key] = merge(neutral[key], saved[key])
    return result as T
  }
  // A null neutral value (e.g. gains not yet computed) accepts any saved
  // value that is not a plain object.
  if (neutral === null) return (saved ?? null) as T
  if (Array.isArray(neutral)) return (Array.isArray(saved) ? saved : neutral) as T
  return (typeof saved === typeof neutral ? saved : neutral) as T
}

/**
 * Processing chain parameters. Plugins are a list of objects that `merge`
 * cannot check: they are read separately, discarding corrupt entries. A
 * project without the field gets an empty list. Tools missing from older
 * projects, such as satellite trails (`trails`), get their neutral value
 * (off) from `merge`. The same goes for narrowband, for which it is also
 * checked that the palette is a known one.
 */
export function readProcessing(v: unknown): ProcessingParams {
  const m = merge(NEUTRAL_PROCESSING, v)
  const e: ProcessingParams = m
  const narrowband = NARROWBAND_PALETTES.includes(e.narrowband.palette)
    ? e.narrowband
    : NARROWBAND_NEUTRAL
  return { ...e, narrowband, plugin: readEnabledPlugins(object(v) ? v['plugin'] : undefined) }
}

export function readCurves(v: unknown): Curves {
  if (!object(v)) return NEUTRAL_CURVES
  const channel = (points: unknown, neutral: CurvePoint[]): CurvePoint[] => {
    if (!Array.isArray(points) || points.length < 2) return neutral
    const validItems = points.filter(
      (p): p is CurvePoint => object(p) && typeof p['x'] === 'number' && typeof p['y'] === 'number'
    )
    return validItems.length >= 2 ? validItems.map((p) => ({ x: p.x, y: p.y })) : neutral
  }
  return {
    light: channel(v['light'], NEUTRAL_CURVES.light),
    red: channel(v['red'], NEUTRAL_CURVES.red),
    green: channel(v['green'], NEUTRAL_CURVES.green),
    blue: channel(v['blue'], NEUTRAL_CURVES.blue)
  }
}
