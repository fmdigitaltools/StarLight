/**
 * Checks the export caption (core/export/caption.ts and
 * renderer/src/export/canvasCaption.ts), without a real canvas: a fake
 * canvas measures texts approximately and "draws" test pixels.
 *
 * It verifies that:
 *  - entries come only from the data present, with no placeholders;
 *  - the caption is present in the display formats (PNG, JPEG, WebP, TIFF,
 *    BMP) and absent in FITS, whose file stays byte-for-byte identical;
 *    XISF is not an output format and would not receive it anyway;
 *  - no template changes the file dimensions: all of them fit inside the
 *    photo, in the chosen corner, with texts and logo inside their
 *    background;
 *  - the sizes follow the final file proportionally, from thumbnails to
 *    enlarged files;
 *  - of the program only the brand appears (logo and name "StarLight"),
 *    without overlapping the entries; with little space the entries are
 *    dropped first.
 *
 * Usage: TEST_SCRIPT=tools/test-caption.ts node tools/run-test.mjs
 */
import type { FrameMetadata, ImageData32, RecognizedObject } from '../src/shared/types'
import {
  captionAllowed,
  layoutCaption,
  collectCaptionData,
  captionUnit,
  BRAND_NAME,
  type CaptionCorner,
  type CaptionData,
  type CaptionSource,
  type CaptionTemplate
} from '../src/core/export/caption'
import { FORMATS } from '../src/core/export/encoding'
import { FULL_CROP } from '../src/core/export/crop'

let errors = 0
function check(condition: boolean, description: string): void {
  console.log((condition ? '  ok   ' : '  NO   ') + description)
  if (!condition) errors++
}

/* ---- Fake canvas ---- */

/** Approximate width: 0.55 of the font size per character (600 weight slightly more). */
function fakeMeasure(text: string, font: string): number {
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10)
  return text.length * px * (font.startsWith('600') ? 0.6 : 0.55)
}

const tele: { width: number; height: number; pixel: Uint8ClampedArray | null }[] = []
class FakeCanvas {
  width: number
  height: number
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
  }
  getContext(): unknown {
    const log: (typeof tele)[number] = { width: this.width, height: this.height, pixel: null }
    tele.push(log)
    const gradient = { addColorStop() {} }
    const ctx: Record<string, unknown> = {
      font: '10px sans-serif',
      globalAlpha: 1, shadowColor: '', shadowBlur: 0, imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
      save() {}, restore() {}, translate() {}, setTransform() {}, scale() {}, rect() {}, roundRect() {}, clip() {}, drawImage() {},
      beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {},
      arc() {}, ellipse() {}, fillRect() {}, clearRect() {}, fillText() {}, strokeText() {},
      createLinearGradient: () => gradient,
      measureText: (t: string) => ({ width: fakeMeasure(t, ctx.font as string) }),
      // The whole "drawn" layer is an opaque bluish gray.
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4)
        for (let i = 0; i < w * h; i++) data.set([200, 210, 230, 255], i * 4)
        return { data, width: w, height: h }
      },
      putImageData: (d: { data: Uint8ClampedArray }) => {
        log.pixel = new Uint8ClampedArray(d.data)
      }
    }
    return ctx
  }
  async convertToBlob(): Promise<Blob> {
    return new Blob([JSON.stringify({ width: this.width, height: this.height })])
  }
}
class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray, w: number, h: number) {
    this.data = data
    this.width = w
    this.height = h
  }
}
;(globalThis as Record<string, unknown>).OffscreenCanvas = FakeCanvas
;(globalThis as Record<string, unknown>).ImageData = FakeImageData

/* ---- Data ---- */

const META_S50: FrameMetadata = {
  object: 'NGC 7331', ra: 339.27, dec: 34.42, exposure: 20, gain: 80, sensorTemp: 20,
  dateObs: '2025-03-14T22:15:30.000', instrument: 'Seestar S50', telescope: 'S50_0a1b2c3d',
  filter: 'IRCUT', focalLength: 250, pixelSize: 2.9, bayer: 'GRBG', pixelScale: 2.4,
  frameType: 'stacked', stackCount: 23, totalExposure: 460, instrumentInfo: null, wcs: null
}
const EMPTY_META: FrameMetadata = {
  object: null, ra: null, dec: null, exposure: null, gain: null, sensorTemp: null, dateObs: null,
  instrument: null, telescope: null, filter: null, focalLength: null, pixelSize: null, bayer: null,
  pixelScale: null, frameType: 'unknown', stackCount: null, totalExposure: null, instrumentInfo: null, wcs: null
} as unknown as FrameMetadata

const RECOGNIZED: RecognizedObject = {
  object: {
    id: 'M 27', name: 'Nebulosa Manubrio', aliases: ['NGC 6853'], type: 'Nebulosa planetaria' as never,
    ra: 299.9, dec: 22.7, magnitude: 7.5, sizeArcmin: 8, constellation: 'Vul', description: ''
  } as never,
  confidence: 1, method: 'wcs', offsetArcmin: 0, position: { x: 0.5, y: 0.5 }
}

function source(partial: Partial<CaptionSource>): CaptionSource {
  return {
    metadata: META_S50, header: {}, objects: [], crop: FULL_CROP, integration: null,
    result: false, author: '', place: false, ...partial
  }
}

const DIRTY = /null|undefined|NaN|\?|^\s*$|—|-{2}/

console.log('--- Caption entries ---')
const complete = collectCaptionData(source({ author: '  Anna  ' }))
const texts = Object.fromEntries(complete.entries.map((v) => [v.key, v.text]))
console.log('  ' + complete.entries.map((v) => v.text).join(' · '))
check(texts.object === 'NGC 7331', 'object from the header (OBJECT) with no recognized objects')
check(texts.date === '14 marzo 2025', 'date in Italian: ' + texts.date)
check(texts.instrument === 'Seestar S50 · 250 mm', 'instrument without serial number, only once, with the focal length: ' + texts.instrument)
check(texts.camera === undefined, 'no duplicate camera when it matches the instrument')
check(texts.exposure === '7 min 40 s (23 × 20 s)', 'total exposure from the header: ' + texts.exposure)
check(texts.filter === 'filtro IRCUT', 'filter: ' + texts.filter)
check(texts.author === '© Anna', 'author trimmed of spaces')
check(texts.location === undefined, 'location absent: the file has only coordinates, which are never written')

const empty = collectCaptionData(source({ metadata: EMPTY_META }))
check(empty.entries.length === 0 && empty.title === null, 'file without data: no entries, no title')
const partial = collectCaptionData(source({ metadata: { ...EMPTY_META, exposure: 30, filter: 'None' } }))
check(
  partial.entries.length === 1 && partial.entries[0].text === '30 s',
  'only the exposure of one frame: one entry, "None" is not a filter (' + partial.entries.map((v) => v.text).join(' · ') + ')'
)
const all = [complete, empty, partial].flatMap((d) => d.entries.flatMap((v) => [v.text, v.short, v.label]))
check(all.every((t) => !DIRTY.test(t)), 'no placeholders (null, undefined, NaN, ?, dashes, empty)')

const resultWithoutData = collectCaptionData(source({ result: true, metadata: { ...META_S50, frameType: 'light', stackCount: null, totalExposure: null } }))
check(!resultWithoutData.entries.some((v) => v.key === 'exposure'), 'stack without frame data: the exposure of a single frame is not written')
const stacked = collectCaptionData(
  source({
    result: true,
    objects: [RECOGNIZED],
    integration: { frame: 260, seconds: 7800, exposure: 30, before: '2026-09-12T21:00:00', last: '2026-09-14T02:00:00' }
  })
)
const ti = Object.fromEntries(stacked.entries.map((v) => [v.key, v.text]))
check(ti.exposure === '2 h 10 min (260 × 30 s)', 'exposure from the StarLight stack: ' + ti.exposure)
check(ti.date === '12–14 settembre 2026', 'several nights: ' + ti.date)
check(stacked.title === 'Nebulosa Manubrio' && stacked.code === 'M 27', 'title from the recognized object, with its designation')
const outside = collectCaptionData(
  source({ objects: [RECOGNIZED], crop: { x: 0, y: 0, width: 0.3, height: 0.3 } })
)
check(outside.title === 'NGC 7331', 'recognized object outside the crop: the header name remains')
const withPlace = collectCaptionData(source({ place: true, header: { SITENAME: 'Campo dei Fiori' } }))
check(withPlace.entries.some((v) => v.text === 'Campo dei Fiori'), 'location written only if requested and if the file has its name')

console.log('\n--- Proportions and position inside the photo ---')
const MEASUREMENTS: [string, number, number][] = [
  ['thumbnail', 268, 179],
  ['social', 1080, 1350],
  ['4K', 3840, 2160],
  ['24 MP', 6000, 4000],
  ['61 MP', 9568, 6380],
  ['enlarged', 19136, 12760],
  ['panorama', 12000, 2000],
  ['vertical', 2000, 9000]
]
const MODELS: CaptionTemplate[] = ['minimal', 'banner', 'card']
const ANGLES: CaptionCorner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left']
const richData: CaptionData = collectCaptionData(
  source({
    objects: [RECOGNIZED],
    author: 'Anna Rossi',
    integration: { frame: 260, seconds: 7800, exposure: 30, before: '2026-09-12', last: '2026-09-12' }
  })
)
const inside = (r: { x: number; y: number; width: number; height: number }, W: number, H: number): boolean =>
  r.x >= 0 && r.y >= 0 && r.x + r.width <= W + 0.5 && r.y + r.height <= H + 0.5
for (const model of MODELS) {
  const ratios: number[] = []
  let outside = 0
  for (const [name, W, H] of MEASUREMENTS) {
    for (const angle of model === 'banner' ? (['bottom-right'] as CaptionCorner[]) : ANGLES) {
      const imp = layoutCaption(richData, { model, angle }, W, H, fakeMeasure)
      const s = captionUnit(W, H)
      const insideTexts = imp.texts.every((t) => {
        const x0 = t.alignment === 'right' ? t.x - t.width : t.x
        return x0 >= 0 && x0 + t.width <= W + 0.5 && t.y - t.width * 0 > 0 && t.y <= H
      })
      const allInside =
        imp.width === W &&
        imp.height === H &&
        inside(imp.area, W, H) &&
        inside({ x: imp.logo.x, y: imp.logo.y, width: imp.logo.side, height: imp.logo.side }, W, H) &&
        (imp.background === null || inside(imp.background, W, H)) &&
        insideTexts
      // Texts and logo inside the background of the card or band.
      const inBackground =
        imp.background === null ||
        (imp.texts.every((t) => {
          const x0 = t.alignment === 'right' ? t.x - t.width : t.x
          const f = imp.background as NonNullable<typeof imp.background>
          return x0 >= f.x - 0.5 && x0 + t.width <= f.x + f.width + 0.5 && t.y > f.y && t.y < f.y + f.height
        }) &&
          imp.logo.x >= imp.background.x &&
          imp.logo.x + imp.logo.side <= imp.background.x + imp.background.width + 0.5)
      // The chosen corner: the caption sits in the correct half of the photo.
      const a = imp.area
      const correctAngle =
        model === 'banner'
          ? a.y + a.height === H && a.width === W
          : (a.x + a.width / 2 > W / 2) === angle.endsWith('right') && (a.y + a.height / 2 > H / 2) === angle.startsWith('bottom')
      if (!allInside || !inBackground || !correctAngle) {
        outside++
        check(false, model + ' ' + name + ' ' + angle + ': inside the photo ' + allInside + ', in the background ' + inBackground + ', corner ' + correctAngle)
      }
      if (angle === 'bottom-right' && s >= 1) ratios.push(imp.body / s)
      if (angle === 'bottom-right') {
        console.log(
          '  ' + model.padEnd(7) + name.padEnd(11) + (W + 'x' + H).padEnd(12) +
          'body ' + String(imp.body).padStart(4) + ' px  area ' + a.width + 'x' + a.height +
          ' (' + (((a.width * a.height) / (W * H)) * 100).toFixed(1) + '% of the photo)  entries ' + imp.displayedEntries.length
        )
      }
    }
  }
  const min = Math.min(...ratios)
  const max = Math.max(...ratios)
  check(max / min < 1.08, model + ': body in proportion to the file (difference ' + ((max / min - 1) * 100).toFixed(1) + '%)')
  check(outside === 0, model + ': everything inside the photo, at its corner, at all sizes; the file does not change size')
}
const small = layoutCaption(richData, { model: 'banner', angle: 'bottom-right' }, 268, 179, fakeMeasure)
const large = layoutCaption(richData, { model: 'banner', angle: 'bottom-right' }, 6000, 4000, fakeMeasure)
check(
  small.displayedEntries.length <= large.displayedEntries.length && small.displayedEntries.length < richData.entries.length,
  'in thumbnails only the most important entries remain (' + small.displayedEntries.join(', ') + ')'
)
for (const model of MODELS) {
  for (const [name, W, H] of MEASUREMENTS) {
    const imp = layoutCaption(richData, { model, angle: 'bottom-right' }, W, H, fakeMeasure)
    const brands = imp.texts.filter((t) => t.color === 'brand')
    // Of the program only the brand name appears, once, never other wording.
    const onlyName =
      brands.every((t) => t.text === BRAND_NAME) &&
      brands.length <= 1 &&
      !imp.texts.some((t) => t.color !== 'brand' && /StarLight|Elaborato/i.test(t.text))
    // No text overlaps another on the same line, nor the logo.
    const box = (t: (typeof imp.texts)[number]): [number, number] => {
      const x0 = t.alignment === 'right' ? t.x - t.width : t.x
      return [x0, x0 + t.width]
    }
    const logo: [number, number, number, number] = [imp.logo.x, imp.logo.x + imp.logo.side, imp.logo.y, imp.logo.y + imp.logo.side]
    const overlapping = imp.texts.some((a, i) =>
      imp.texts.some((b, j) => {
        if (j <= i || Math.abs(a.y - b.y) > 1) return false
        const [a0, a1] = box(a)
        const [b0, b1] = box(b)
        return a0 < b1 - 0.5 && b0 < a1 - 0.5
      })
    ) || imp.texts.some((t) => {
      const [x0, x1] = box(t)
      return t.y > logo[2] && t.y - imp.body * 0.7 < logo[3] && x0 < logo[1] - 0.5 && logo[0] < x1 - 0.5
    })
    // At normal sizes the name is there; if missing, it is because the entries have run out.
    const namePresent = brands.length === 1 || W < 600 || imp.displayedEntries.length === 0
    if (!onlyName || overlapping || !namePresent) {
      check(false, model + ' ' + name + ': brand (name only ' + onlyName + ', overlaps ' + overlapping + ', name present ' + namePresent + ')')
    }
  }
  check(true, model + ': brand with the name "StarLight" only, not overlapping the entries, at all sizes')
}
const tinyCaption = layoutCaption(richData, { model: 'banner', angle: 'bottom-right' }, 160, 107, fakeMeasure)
check(
  tinyCaption.texts.some((t) => t.color === 'brand') || tinyCaption.displayedEntries.length === 0,
  'with little space the entries are dropped first, then the brand name (' + tinyCaption.displayedEntries.length + ' entries left)'
)

console.log('\n--- Output formats ---')
const { produceExport } = await import('../src/renderer/src/export/exportImage')
const { NEUTRAL_ADJUSTMENTS } = await import('../src/renderer/src/store/appStore')
const { NEUTRAL_CURVES } = await import('../src/core/image/curve')

const W = 320
const H = 200
function sampleImage(): ImageData32 {
  const data = new Float32Array(W * H * 3)
  for (let i = 0; i < data.length; i++) data[i] = 0.1 + (0.3 * ((i * 7919) % 101)) / 101
  return { width: W, height: H, channels: 3, data }
}
async function doExport(format: keyof typeof FORMATS, model: CaptionTemplate | null, bit?: 8 | 16): Promise<Uint8Array> {
  const b = await produceExport(sampleImage(), NEUTRAL_ADJUSTMENTS, NEUTRAL_CURVES, {
    format,
    quality: 90,
    bit,
    crop: FULL_CROP,
    width: W,
    height: H,
    upscalingMethod: 'lanczos',
    header: { OBJECT: 'NGC 7331' },
    wcs: null,
    markers: null,
    caption: model ? { data: richData, choice: { model, angle: 'bottom-right' }, logo: null } : null
  })
  return new Uint8Array(b)
}
const differences = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let n = Math.abs(a.length - b.length)
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++
  return n
}
const tiffHeight = (b: Uint8Array): number => {
  const v = new DataView(b.buffer)
  const ifd = v.getUint32(4, true)
  const n = v.getUint16(ifd, true)
  for (let i = 0; i < n; i++) if (v.getUint16(ifd + 2 + i * 12, true) === 257) return v.getUint16(ifd + 2 + i * 12 + 8, true)
  return -1
}
const bmpHeight = (b: Uint8Array): number => new DataView(b.buffer).getInt32(22, true)

// Canvas formats: the fake canvas records the pixels drawn; the caption changes them.
for (const format of ['png', 'jpeg', 'webp'] as const) {
  for (const model of MODELS) {
    tele.length = 0
    await doExport(format, model)
    const final = tele.find((t) => t.width === W && t.height === H && t.pixel !== null)
    tele.length = 0
    await doExport(format, null)
    const without = tele.find((t) => t.width === W && t.height === H && t.pixel !== null)
    const changedItems = final && without ? differences(final.pixel as Uint8ClampedArray, without.pixel as Uint8ClampedArray) : 0
    check(
      final !== undefined && changedItems > 0 && changedItems < W * H * 4 * 0.4,
      format + ' ' + model + ': same size ' + W + 'x' + H + ', caption present (' + changedItems + ' bytes changed)'
    )
  }
}
for (const bit of [8, 16] as const) {
  const without = await doExport('tiff', null, bit)
  for (const model of MODELS) {
    const combined = await doExport('tiff', model, bit)
    const d = differences(combined, without)
    check(
      tiffHeight(combined) === H && combined.length === without.length && d > 0,
      'TIFF ' + bit + ' bit ' + model + ': same size, caption present (' + d + ' bytes changed)'
    )
  }
}
const bmpWithout = await doExport('bmp', null)
const bmpCard = await doExport('bmp', 'card')
check(bmpHeight(bmpCard) === H && differences(bmpCard, bmpWithout) > 0, 'BMP card: same size, caption present')

const fitsWithout = await doExport('fits', null)
for (const model of MODELS) {
  const fits = await doExport('fits', model)
  const naxis2 = /NAXIS2\s*=\s*(\d+)/.exec(new TextDecoder().decode(fits.subarray(0, 2880)))?.[1]
  check(
    differences(fits, fitsWithout) === 0 && Number(naxis2) === H,
    'FITS with ' + model + ': file identical to the one without caption, ' + naxis2 + ' rows'
  )
}
check(!captionAllowed('fits') && !captionAllowed('xisf'), 'FITS and XISF never receive the caption')
check(['png', 'jpeg', 'webp', 'tiff', 'bmp'].every(captionAllowed), 'PNG, JPEG, WebP, TIFF and BMP receive it')
check(
  (Object.keys(FORMATS) as string[]).every((f) => captionAllowed(f) === (f !== 'fits')),
  'every output format is classified (a new data format must be excluded by hand)'
)

console.log('\n' + (errors === 0 ? 'Caption: all good.' : 'Caption: ' + errors + ' checks failed.'))
process.exit(errors === 0 ? 0 : 1)
