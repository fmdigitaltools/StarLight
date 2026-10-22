import type { FrameMetadata, ImageData32, RecognizedObject } from '@shared/types'
import type { Crop } from './crop'
import { getLanguage } from '@shared/i18n/i18n'
import {
  formatDate,
  formatFocalLength,
  formatExposure,
  captionTexts,
  type CaptionLanguage
} from './captionTexts'

/**
 * Caption of the exported image: the acquisition data and the StarLight
 * brand (the logo followed by the name, as in the top bar), in three
 * templates. All three sit inside the photo, overlaid on the image, so the
 * file dimensions never change. Users who do not want to cover the photo
 * turn the caption off.
 *
 *  - Minimal: a small, semi-transparent line in a corner of the photo.
 *  - Banner: a thin full-width strip at the bottom, on a semi-transparent
 *    dark background, with the data on one line and the brand on the right.
 *  - Card: a semi-transparent dark box with rounded corners, in the chosen
 *    corner, with the object name as title and the data on two lines.
 *
 * Only display formats receive it (PNG, JPEG, WebP, TIFF, BMP). Data
 * formats (FITS) keep the scientific image untouched: the program name is
 * already in their header (CREATOR).
 *
 * An entry appears only when the data is actually available: no
 * placeholders, no guessed values. Site coordinates are never written
 * (they are personal data); the site name only when the user asks for it.
 *
 * Labels, words, dates and numbers come from captionTexts.ts, which takes
 * the language as a parameter (default: the current interface language).
 *
 * This module does not draw: it collects the data and computes where each
 * text goes, with sizes proportional to the final file. Drawing on the
 * canvas is in renderer/src/export/canvasCaption.ts; this module also
 * blends the drawn pixels with the photo, which the formats encoded by
 * hand (TIFF, BMP) need.
 */

export type CaptionTemplate = 'minimal' | 'banner' | 'card'
export type CaptionCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface CaptionChoice {
  model: CaptionTemplate
  /** Corner of the Minimal template. */
  angle: CaptionCorner
}

/** Formats that receive the caption: only those meant for viewing. */
const FORMATS_TO_SHOW = new Set(['png', 'jpeg', 'webp', 'tiff', 'bmp'])

/** True if the format receives the caption (never FITS or XISF). */
export function captionAllowed(format: string): boolean {
  return FORMATS_TO_SHOW.has(format)
}

/* ---- Data ---- */

export type EntryKey = 'object' | 'date' | 'instrument' | 'camera' | 'exposure' | 'filter' | 'location' | 'author'

export interface CaptionEntry {
  key: EntryKey
  /** Short label, used by the Card ("Total exposure", "Date"…). */
  label: string
  text: string
  /** Shorter form of the same data, used when space runs out. */
  short: string
  /** The higher it is, the later the entry is dropped when space runs out. */
  priority: number
  /** Value next to the label in the Card, when different from the text ("LP" rather than "LP filter"). */
  card?: string
}

export interface CaptionData {
  /** Card title: the name of the main object. */
  title: string | null
  /** Catalog code next to the title, when different from the title. */
  code: string | null
  /** Entries in reading order. */
  entries: CaptionEntry[]
}

/** Frames and exposures of the stacking done in StarLight, when the image is its result. */
export interface CaptionIntegration {
  /** Number of frames (single exposures) combined. */
  frame: number
  /** Total exposure in seconds; null if the exposure of any frame is missing. */
  seconds: number | null
  /** Exposure of each frame, when the same for all. */
  exposure: number | null
  /** Date of the first and last acquisition (ISO), when known. */
  before: string | null
  last: string | null
}

export interface CaptionSource {
  metadata: FrameMetadata | null
  /** Header keywords of the source file. */
  header: Record<string, string | number | boolean | null>
  /** Recognized objects, main one first. */
  objects: RecognizedObject[]
  /** Exported region: the main object must lie inside it. */
  crop: Crop
  /** Data of the stacking done in StarLight, when the image is its result. */
  integration: CaptionIntegration | null
  /**
   * True if the image is a result (stacking, drizzle, mosaic) rather than
   * the file as loaded: without `integration`, the header exposure would be
   * that of a single frame, so it is not written.
   */
  result: boolean
  author: string
  /** Writes the site name, if the file contains it. */
  place: boolean
  /** Language of labels, dates and numbers; defaults to the current interface language. */
  language?: CaptionLanguage
}

/** Trimmed header text; null if empty. */
function paperText(header: CaptionSource['header'], ...keys: string[]): string | null {
  for (const k of keys) {
    const v = header[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

/**
 * Instrument name without the identifier of the individual unit
 * (TELESCOP = "MODEL_xxxxxxxx" becomes "MODEL"): it is a serial number,
 * of no use to whoever looks at the photo.
 */
function cleanName(name: string | null): string | null {
  if (!name) return null
  const cleaned = name.replace(/_[0-9a-f]{4,}$/i, '').replace(/\s+/g, ' ').trim()
  return cleaned !== '' ? cleaned : null
}

/** Declared filter values that mean "no filter". */
const NO_FILTER = /^(none|no|nessuno|open|empty|n\/a|-+)$/i

/** Main object inside the exported region. */
function mainObject(objects: RecognizedObject[], r: Crop): RecognizedObject | null {
  for (const o of objects) {
    if (!o.position) return o
    const inside =
      o.position.x >= r.x && o.position.x <= r.x + r.width && o.position.y >= r.y && o.position.y <= r.y + r.height
    if (inside) return o
  }
  return null
}

/** Collects the caption entries, only those available. */
export function collectCaptionData(f: CaptionSource): CaptionData {
  const language = f.language ?? getLanguage()
  const t = captionTexts(language)
  const m = f.metadata
  const entries: CaptionEntry[] = []
  let title: string | null = null
  let code: string | null = null

  // Object: the recognized one, otherwise the name written in the file.
  const main = mainObject(f.objects, f.crop)
  if (main) {
    const id = main.object.id.trim()
    const name = main.object.name.trim()
    if (name !== '' && name.toLowerCase() !== id.toLowerCase()) {
      title = name
      code = id
      entries.push({ key: 'object', label: t.labels.object, text: id + t.union + name, short: id, priority: 10 })
    } else {
      title = id
      entries.push({ key: 'object', label: t.labels.object, text: id, short: id, priority: 10 })
    }
  } else {
    const written = m?.object?.trim() || paperText(f.header, 'OBJECT', 'OBJCTNAM', 'TARGET')
    if (written) {
      title = written
      entries.push({ key: 'object', label: t.labels.object, text: written, short: written, priority: 10 })
    }
  }

  // Date: the stacking nights, otherwise the file date.
  const data = f.integration?.before
    ? formatDate(f.integration.before, f.integration.last, language)
    : formatDate(m?.dateObs ?? paperText(f.header, 'DATE-OBS', 'DATE_OBS'), null, language)
  if (data) entries.push({ key: 'date', label: t.labels.data, text: data.text, short: data.short, priority: 6 })

  // Instrument and camera; if one contains the other (the model code and the
  // full name with the make), only the more complete one is kept, once.
  let telescope = cleanName(m?.telescope ?? paperText(f.header, 'TELESCOP', 'TELESCOPE'))
  let camera = cleanName(m?.instrument ?? paperText(f.header, 'INSTRUME', 'CAMERA', 'DETECTOR'))
  if (telescope && camera) {
    const a = telescope.toLowerCase()
    const b = camera.toLowerCase()
    if (b.includes(a)) {
      telescope = camera
      camera = null
    } else if (a.includes(b)) camera = null
  }
  const focalLength = m?.focalLength ?? null
  const focalLengthText = focalLength !== null && focalLength > 0 ? formatFocalLength(focalLength, language) : null
  if (telescope || focalLengthText) {
    const text = telescope
      ? telescope + (focalLengthText ? t.union + focalLengthText : '')
      : t.onlyFocalLength(focalLengthText as string)
    entries.push({
      key: 'instrument',
      label: t.labels.instrument,
      text,
      short: telescope ?? t.onlyFocalLength(focalLengthText as string),
      priority: 7
    })
  }
  if (camera) {
    entries.push({ key: 'camera', label: t.labels.camera, text: camera, short: camera, priority: 4 })
  }

  // Filter, only if there really is one.
  const filter = m?.filter?.trim() || paperText(f.header, 'FILTER')
  if (filter && !NO_FILTER.test(filter)) {
    entries.push({ key: 'filter', label: t.labels.filter, text: t.filter(filter), short: filter, priority: 5, card: filter })
  }

  // Exposure: from the stacking, otherwise from the header of the file as loaded.
  const exposure = captionExposure(f, language)
  if (exposure) entries.push(exposure)

  if (f.place) {
    const place = paperText(f.header, 'SITENAME', 'OBSERVAT', 'SITE', 'LOCATION')
    if (place) entries.push({ key: 'location', label: t.labels.place, text: place, short: place, priority: 3 })
  }

  const author = f.author.replace(/\s+/g, ' ').trim()
  if (author !== '') {
    entries.push({ key: 'author', label: t.labels.author, text: t.author(author), short: t.author(author), priority: 9, card: author })
  }

  return { title, code, entries }
}

function captionExposure(f: CaptionSource, language: CaptionLanguage): CaptionEntry | null {
  const entry = (total: number, frame: number | null, single: number | null): CaptionEntry => {
    const p = formatExposure(total, frame, single, language)
    return { key: 'exposure', label: p.label, text: p.text, short: p.short, priority: 8 }
  }
  const i = f.integration
  if (i) return i.seconds !== null && i.seconds > 0 ? entry(i.seconds, i.frame, i.exposure) : null
  if (f.result) return null

  const m = f.metadata
  const cardNumber = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = f.header[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    }
    return null
  }
  const single = m?.exposure ?? cardNumber('EXPTIME', 'EXPOSURE')
  const frame = m?.stackCount ?? cardNumber('STACKCNT', 'NCOMBINE')
  const total = m?.totalExposure ?? cardNumber('TOTALEXP', 'LIVETIME', 'EXPTOTAL')
  if (total !== null && total > 0) {
    // The "frames × exposure" detail only if it matches the declared total.
    const consistent = frame !== null && single !== null && Math.abs(frame * single - total) <= Math.max(1, total * 0.02)
    return entry(total, consistent ? frame : null, consistent ? single : null)
  }
  if (single !== null && single > 0) {
    if (frame !== null && frame > 1) return entry(frame * single, frame, single)
    return entry(single, 1, single)
  }
  return null
}

/* ---- Layout ---- */

/** StarLight interface fonts (see styles/theme.css). */
export const TEXT_FONT = '"Segoe UI Variable Text", "Segoe UI", Inter, system-ui, -apple-system, sans-serif'
export const TITLE_FONT = '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif'

/** Brand colors, the same as the interface. */
export const CAPTION_COLORS = {
  stripBackground: 'rgba(5, 8, 15, 0.62)',
  cardBackground: 'rgba(7, 11, 20, 0.7)',
  cardBorder: 'rgba(34, 232, 255, 0.16)',
  text: '#eaf1ff',
  secondary: '#a9b8d4',
  label: '#7d8db0',
  separator: '#55657f',
  cyan: '#22e8ff',
  purple: '#9d7bff',
  magenta: '#ff3dd0',
  minimum: 'rgba(234, 241, 255, 0.62)',
  shadow: 'rgba(0, 0, 0, 0.7)'
}

export function font(px: number, weight = 400, title = false): string {
  return (weight !== 400 ? weight + ' ' : '') + px + 'px ' + (title ? TITLE_FONT : TEXT_FONT)
}

/** Measures the width of a text in a given font (from the canvas, or a fake one in tests). */
export type TextMeasurer = (text: string, font: string) => number

export interface CaptionText {
  text: string
  x: number
  /** Baseline. */
  y: number
  font: string
  /** Color, or 'brand' for the cyan-violet-magenta gradient of the brand name. */
  color: string
  alignment: 'left' | 'right'
  width: number
  /** Letter spacing in pixels (brand name). */
  spacing?: number
  /** Opacity of the text only; opaque when omitted. */
  opacity?: number
}

export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

/** Slot of the StarLight logo: a square, with its opacity. */
export interface LogoSlot {
  x: number
  y: number
  side: number
  opacity: number
}

export interface CaptionLayout {
  model: CaptionTemplate
  /** File dimensions, equal to those of the photo: the caption sits inside. */
  width: number
  height: number
  /** Part of the photo touched by the drawing. */
  area: Rectangle
  /** Semi-transparent dark background of the Banner or the Card. */
  background: (Rectangle & { radius: number; color: string; edge: string | null; borderThickness: number }) | null
  /** Thin line in the brand colors along the top edge of the Banner. */
  hairline: (Rectangle & { thickness: number }) | null
  /** The StarLight logo. */
  logo: LogoSlot
  /** Shadow behind the Minimal texts, in pixels; 0 = none. */
  shadow: number
  texts: CaptionText[]
  /** Entries kept (the others did not fit). */
  displayedEntries: EntryKey[]
  /** Font size of the main text, in pixels. */
  body: number
}

/**
 * Caption unit: thousandths of the usable side. It follows the width, but
 * no more than one and a half times the height, so a very wide panorama
 * does not get huge text.
 */
export function captionUnit(width: number, height: number): number {
  return Math.min(width, height * 1.5) / 1000
}

const minBody = (s: number): number => Math.max(8, Math.round(11.5 * s))
const bandBody = (s: number): number => Math.max(8, Math.round(13 * s))
const cardBody = (s: number): number => Math.max(8, Math.round(12.5 * s))
const cardTitle = (s: number): number => Math.max(11, Math.round(23 * s))
const photoMargin = (s: number): number => Math.max(6, Math.round(20 * s))

/** Program name in the brand: a proper name, never translated. */
export const BRAND_NAME = 'StarLight'

/**
 * The StarLight brand as in the top bar: the logo followed by the name, in
 * the title font, weight 700, slightly spaced letters and the
 * cyan-violet-magenta gradient. When space runs out only the logo remains
 * (entries are dropped first).
 */
interface Brand {
  width: number
  side: number
  gap: number
  /** Brand name, or null when only the logo remains. */
  name: { font: string; spacing: number; width: number; body: number } | null
}

function measureBrand(nameBody: number, side: number, measurement: TextMeasurer, withName = true): Brand {
  if (!withName) return { width: side, side, gap: 0, name: null }
  const f = font(nameBody, 700, true)
  const spacing = nameBody * 0.02
  const lName = measurement(BRAND_NAME, f) + spacing * BRAND_NAME.length
  // The logo already has some room around the galaxy, so a small gap is enough.
  const gap = Math.round(side * 0.1)
  return { width: side + gap + lName, side, gap, name: { font: f, spacing, width: lName, body: nameBody } }
}

/** The brand that fits in `space`: with the name if it fits, otherwise the logo only. */
function brandFor(space: number, nameBody: number, side: number, measurement: TextMeasurer): Brand {
  const whole = measureBrand(nameBody, side, measurement)
  return whole.width <= space ? whole : measureBrand(nameBody, side, measurement, false)
}

/** Places the brand with its left edge at `x`, vertically centered on `center`. */
function placeBrand(m: Brand, x: number, center: number, opacity: number): { logo: LogoSlot; texts: CaptionText[] } {
  const logo: LogoSlot = { x, y: Math.round(center - m.side / 2), side: m.side, opacity }
  if (m.name === null) return { logo, texts: [] }
  return {
    logo,
    texts: [
      {
        text: BRAND_NAME,
        x: x + m.side + m.gap,
        y: Math.round(center + m.name.body * 0.36),
        font: m.name.font,
        color: 'brand',
        alignment: 'left',
        width: m.name.width,
        spacing: m.name.spacing,
        opacity
      }
    ]
  }
}

interface ChoiceEntry {
  entry: CaptionEntry
  text: string
}

/**
 * Chooses how many entries to keep so that the line fits in `space`: full
 * forms first, then short forms, then drops the lowest-priority entries.
 */
function fit(
  entries: CaptionEntry[],
  space: number,
  widthOf: (choices: ChoiceEntry[]) => number
): ChoiceEntry[] {
  let remaining = [...entries]
  for (;;) {
    const wholeValues = remaining.map((v) => ({ entry: v, text: v.text }))
    if (widthOf(wholeValues) <= space) return wholeValues
    const choices = remaining.map((v) => ({ entry: v, text: v.short }))
    if (widthOf(choices) <= space) {
      // Full forms for as many entries as possible, starting from the most important.
      const order = [...choices].sort((a, b) => b.entry.priority - a.entry.priority)
      for (const s of order) {
        const i = choices.indexOf(s)
        const test = choices.map((x, j) => (j === i ? { entry: x.entry, text: x.entry.text } : x))
        if (widthOf(test) <= space) choices[i] = test[i]
      }
      return choices
    }
    if (remaining.length === 0) return []
    let worst = remaining[0]
    for (const v of remaining) if (v.priority < worst.priority) worst = v
    remaining = remaining.filter((v) => v !== worst)
  }
}

/**
 * Computes positions, font sizes and colors of the caption for a file of
 * `width` × `height` pixels. Every template sits inside the photo: the file
 * dimensions never change.
 */
export function layoutCaption(
  data: CaptionData,
  choice: CaptionChoice,
  width: number,
  height: number,
  measurement: TextMeasurer,
  language: CaptionLanguage = getLanguage()
): CaptionLayout {
  const separator = '  ' + captionTexts(language).union.trim() + '  '
  if (choice.model === 'banner') return layoutBand(data, width, height, measurement, separator)
  if (choice.model === 'card') return layoutCard(data, choice.angle, width, height, measurement)
  return layoutMinimal(data, choice.angle, width, height, measurement, separator)
}

/** Minimal template entries: few, to stay unobtrusive. */
const MIN_ENTRIES: EntryKey[] = ['object', 'instrument', 'exposure', 'author']

function clampRect(r: Rectangle, W: number, H: number): Rectangle {
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(W, Math.ceil(r.x + r.width))
  const y1 = Math.min(H, Math.ceil(r.y + r.height))
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}

function layoutMinimal(
  data: CaptionData,
  angle: CaptionCorner,
  W: number,
  H: number,
  measurement: TextMeasurer,
  separator: string
): CaptionLayout {
  const s = captionUnit(W, H)
  const body = minBody(s)
  const margin = photoMargin(s)
  const side = Math.round(body * 2.1)
  const gap = Math.round(body * 0.7)
  const f = font(body)
  // The brand comes first; its name stays if it fits in the photo.
  const brand = brandFor(W - 2 * margin, body, side, measurement)
  // At most two thirds of the width, so it stays a side note.
  const space = Math.min(W - 2 * margin, W * 0.66) - brand.width - gap
  const entries = data.entries.filter((v) => MIN_ENTRIES.includes(v.key))
  const widthOf = (choices: ChoiceEntry[]): number => measurement(choices.map((x) => x.text).join(separator), f)
  const choices = space > 0 ? fit(entries, space, widthOf) : []
  const text = choices.map((x) => x.text).join(separator)
  const textWidth = text !== '' ? measurement(text, f) : 0

  const right = angle.endsWith('right')
  const bottom = angle.startsWith('bottom')
  // The brand sits toward the corner, the data line beside it at the same height.
  const center = bottom ? H - margin - side / 2 : margin + side / 2
  const xBrand = right ? W - margin - brand.width : margin
  const slot = placeBrand(brand, xBrand, center, 0.85)
  const texts: CaptionText[] = [...slot.texts]
  if (text !== '') {
    texts.push({
      text,
      x: right ? xBrand - gap : xBrand + brand.width + gap,
      y: Math.round(center + body * 0.36),
      font: f,
      color: CAPTION_COLORS.minimum,
      alignment: right ? 'right' : 'left',
      width: textWidth
    })
  }
  const shadow = Math.max(1, Math.round(body * 0.35))
  const edge = shadow * 2 + 2
  const wide = textWidth + (text !== '' ? gap : 0) + brand.width
  const left = right ? W - margin - wide : margin
  return {
    model: 'minimal',
    width: W,
    height: H,
    area: clampRect({ x: left - edge, y: slot.logo.y - edge, width: wide + 2 * edge, height: side + 2 * edge }, W, H),
    background: null,
    hairline: null,
    logo: slot.logo,
    shadow,
    texts,
    displayedEntries: choices.map((x) => x.entry.key),
    body
  }
}

function layoutBand(
  data: CaptionData,
  W: number,
  H: number,
  measurement: TextMeasurer,
  separator: string
): CaptionLayout {
  const s = captionUnit(W, H)
  const body = bandBody(s)
  // Full-width strip at the bottom, inside the photo.
  const blockHeight = Math.min(Math.round(body * 2.7), Math.round(H * 0.25))
  const y0 = H - blockHeight
  const margin = Math.max(Math.round(body * 1.1), Math.round(22 * s))
  const side = Math.round(blockHeight * 0.85)
  const y = Math.round(y0 + blockHeight / 2 + body * 0.36)
  // Brand on the right; its name stays if it fits in the strip.
  const brand = brandFor(W - 2 * margin, Math.round(body * 1.05), side, measurement)
  const slot = placeBrand(brand, W - margin - brand.width, y0 + blockHeight / 2, 1)
  const space = W - 2 * margin - brand.width - body * 2

  const fFirst = font(body, 600)
  const fOther = font(body)
  const fontOf = (v: CaptionEntry): string => (v.key === 'object' ? fFirst : fOther)
  const lSep = measurement(separator, fOther)
  const widthOf = (choices: ChoiceEntry[]): number =>
    choices.reduce((t, x, i) => t + measurement(x.text, fontOf(x.entry)) + (i > 0 ? lSep : 0), 0)
  const choices = space > 0 ? fit(data.entries, space, widthOf) : []

  const texts: CaptionText[] = []
  let x = margin
  choices.forEach((sc, i) => {
    if (i > 0) {
      texts.push({ text: separator, x, y, font: fOther, color: CAPTION_COLORS.separator, alignment: 'left', width: lSep })
      x += lSep
    }
    const l = measurement(sc.text, fontOf(sc.entry))
    texts.push({
      text: sc.text,
      x,
      y,
      font: fontOf(sc.entry),
      color: sc.entry.key === 'object' ? CAPTION_COLORS.text : CAPTION_COLORS.secondary,
      alignment: 'left',
      width: l
    })
    x += l
  })
  texts.push(...slot.texts)

  return {
    model: 'banner',
    width: W,
    height: H,
    area: { x: 0, y: y0, width: W, height: blockHeight },
    background: { x: 0, y: y0, width: W, height: blockHeight, radius: 0, color: CAPTION_COLORS.stripBackground, edge: null, borderThickness: 0 },
    hairline: { x: 0, y: y0, width: W, height: Math.max(1, Math.round(1.5 * s)), thickness: Math.max(1, Math.round(1.5 * s)) },
    logo: slot.logo,
    shadow: 0,
    texts,
    displayedEntries: choices.map((x) => x.entry.key),
    body
  }
}

function layoutCard(
  data: CaptionData,
  angle: CaptionCorner,
  W: number,
  H: number,
  measurement: TextMeasurer
): CaptionLayout {
  const s = captionUnit(W, H)
  const body = cardBody(s)
  const titleBody = cardTitle(s)
  const margin = photoMargin(s)
  const inner = Math.max(6, Math.round(body * 1.3))
  const fLabel = font(Math.max(5, Math.round(body * 0.74)), 600)
  const fValue = font(body)
  const gap = body * 2
  const side = Math.round(titleBody * 1.5)
  // The card never exceeds 90% of the photo width.
  const maxWidth = Math.min(W - 2 * margin, W * 0.9)
  const lineSpacing = maxWidth - 2 * inner
  // Brand on the title line; its name stays if it fits in the card.
  const brand = brandFor(lineSpacing, Math.round(body * 1.15), side, measurement)

  // Entries as "LABEL value" pairs; the object is already in the title.
  const pairs = data.entries
    .filter((v) => v.key !== 'object' || data.title === null)
    .map((v) => (v.card !== undefined ? { ...v, text: v.card, short: v.card } : v))
  const pairWidth = (x: ChoiceEntry): number =>
    measurement(x.entry.label.toUpperCase(), fLabel) + body * 0.5 + measurement(x.text, fValue)
  /**
   * Splits the pairs over at most two balanced lines: it tries a break after
   * each pair and keeps the split whose longest line is shortest.
   */
  const rowWidth = (line: ChoiceEntry[]): number =>
    line.reduce((t, sc, i) => t + pairWidth(sc) + (i > 0 ? gap : 0), 0)
  const linesOf = (choices: ChoiceEntry[]): ChoiceEntry[][] | null => {
    if (choices.length === 0) return []
    let best: ChoiceEntry[][] | null = null
    let longestLine = Infinity
    for (let k = 1; k <= choices.length; k++) {
      const lines = k === choices.length ? [choices] : [choices.slice(0, k), choices.slice(k)]
      const l = Math.max(...lines.map(rowWidth))
      if (l <= lineSpacing && l < longestLine) {
        best = lines
        longestLine = l
      }
    }
    return best
  }
  const choices = fit(pairs, 1, (sc) => (linesOf(sc) === null ? 2 : 0))
  const lines = linesOf(choices) ?? []

  // Title, shortened if needed, with the catalog code beside it.
  const titleSpacing = lineSpacing - brand.width - body
  let title: string | null = null
  let fTitle = font(titleBody, 600, true)
  const fAbbreviation = font(Math.max(6, Math.round(titleBody * 0.6)), 600)
  let lTitle = 0
  let lCode = 0
  if (data.title !== null && titleSpacing > body * 3) {
    lCode = data.code ? measurement(data.code, fAbbreviation) + titleBody * 0.5 : 0
    let c = titleBody
    while (c > body && measurement(data.title, fTitle) + lCode > titleSpacing) {
      c--
      fTitle = font(c, 600, true)
    }
    if (measurement(data.title, fTitle) + lCode > titleSpacing) lCode = 0
    title = data.title
    while (title.length > 1 && measurement(title + '…', fTitle) + lCode > titleSpacing) title = title.slice(0, -1)
    if (title !== data.title) title = title.trimEnd() + '…'
    lTitle = measurement(title, fTitle)
  }

  // Card size: as wide as the content, as tall as the lines.
  const step = Math.round(body * 1.7)
  const linesWidth = lines.length > 0 ? Math.max(...lines.map(rowWidth)) : 0
  const titleWidth = lTitle + lCode + body + brand.width
  const wide = Math.ceil(Math.min(maxWidth, Math.max(titleWidth, linesWidth) + 2 * inner))
  const titleHeight = Math.max(side, titleBody * 1.1)
  const blockHeight = Math.ceil(inner + titleHeight + (lines.length > 0 ? body * 0.5 + step * lines.length - body * 0.35 : 0) + inner * 0.9)

  const right = angle.endsWith('right')
  const bottom = angle.startsWith('bottom')
  const x0 = right ? W - margin - wide : margin
  const y0 = bottom ? H - margin - blockHeight : margin

  const titleCenter = y0 + inner + titleHeight / 2
  const slot = placeBrand(brand, x0 + wide - inner - brand.width, titleCenter, 1)
  const texts: CaptionText[] = [...slot.texts]
  const yTitle = Math.round(titleCenter + titleBody * 0.34)
  if (title !== null) {
    texts.push({ text: title, x: x0 + inner, y: yTitle, font: fTitle, color: CAPTION_COLORS.text, alignment: 'left', width: lTitle })
    if (data.code && lCode > 0) {
      texts.push({
        text: data.code,
        x: x0 + inner + lTitle + titleBody * 0.5,
        y: yTitle,
        font: fAbbreviation,
        color: CAPTION_COLORS.cyan,
        alignment: 'left',
        width: lCode - titleBody * 0.5
      })
    }
  }
  let y = Math.round(y0 + inner + titleHeight + body * 0.5 + body)
  for (const line of lines) {
    let x = x0 + inner
    for (const sc of line) {
      const label = sc.entry.label.toUpperCase()
      const lE = measurement(label, fLabel)
      texts.push({ text: label, x, y, font: fLabel, color: CAPTION_COLORS.label, alignment: 'left', width: lE })
      x += lE + body * 0.5
      const lV = measurement(sc.text, fValue)
      texts.push({ text: sc.text, x, y, font: fValue, color: CAPTION_COLORS.secondary, alignment: 'left', width: lV })
      x += lV + gap
    }
    y += step
  }

  const borderThickness = Math.max(1, Math.round(1 * s))
  return {
    model: 'card',
    width: W,
    height: H,
    area: clampRect({ x: x0 - 1, y: y0 - 1, width: wide + 2, height: blockHeight + 2 }, W, H),
    background: {
      x: x0,
      y: y0,
      width: wide,
      height: blockHeight,
      radius: Math.max(3, Math.round(body * 0.7)),
      color: CAPTION_COLORS.cardBackground,
      edge: CAPTION_COLORS.cardBorder,
      borderThickness
    },
    hairline: null,
    logo: slot.logo,
    shadow: 0,
    texts,
    displayedEntries: [
      ...(title !== null && data.entries.some((v) => v.key === 'object') ? (['object'] as EntryKey[]) : []),
      ...lines.flat().map((x) => x.entry.key)
    ],
    body
  }
}

/* ---- Blending with the photo ---- */

/**
 * Drawn caption pixels, 8-bit non-premultiplied RGBA, for the `area`
 * rectangle of the final file.
 */
export interface CaptionLayer {
  area: Rectangle
  rgba: Uint8ClampedArray
}

/**
 * Blends onto the photo (in place) the part of the layer that falls on it,
 * as in the Minimal template. Export images always have three channels
 * (the adjustments produce them); with a single channel the luminance is
 * used.
 */
export function blendOntoPhoto(image: ImageData32, layer: CaptionLayer): void {
  const W = image.width
  const H = image.height
  const n = W * H
  const { area, rgba } = layer
  for (let y = 0; y < area.height; y++) {
    const yy = area.y + y
    if (yy < 0 || yy >= H) continue
    for (let x = 0; x < area.width; x++) {
      const xx = area.x + x
      if (xx < 0 || xx >= W) continue
      const k = (y * area.width + x) * 4
      const a = rgba[k + 3] / 255
      if (a === 0) continue
      const i = yy * W + xx
      const r = rgba[k] / 255
      const g = rgba[k + 1] / 255
      const b = rgba[k + 2] / 255
      if (image.channels === 3) {
        image.data[i] = image.data[i] * (1 - a) + r * a
        image.data[n + i] = image.data[n + i] * (1 - a) + g * a
        image.data[2 * n + i] = image.data[2 * n + i] * (1 - a) + b * a
      } else {
        image.data[i] = image.data[i] * (1 - a) + (0.2126 * r + 0.7152 * g + 0.0722 * b) * a
      }
    }
  }
}
