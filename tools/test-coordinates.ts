/**
 * Check: coordinates over the image (core/astrometry/imageCoordinates.ts).
 *
 * On synthetic astrometric solutions (rotated field, mirrored field,
 * north pole in the field, field straddling 0h):
 * - every point of a grid line really has that declination or right
 *   ascension, the lines are a reasonable number and without duplicates;
 * - the north and east arrows point where declination and right
 *   ascension increase, and are perpendicular;
 * - the scale bar measures what it says and does not exceed a fifth of
 *   the width;
 * - in the scene the labels stay inside the visible part and no grid label
 *   ends up on top of the orientation arrows and the scale;
 * - the texts have the expected form.
 *
 * Non servono file esterni.
 */
import { buildWcs, pixelToSky, skyToPixel, scaleArcsec } from '../src/core/astrometry/wcs'
import {
  coordinateGrid,
  northEastDirections,
  scaleBar,
  coordinatesScene,
  toolsCorner,
  declinationText,
  rightAscensionText,
  scaleText
} from '../src/core/astrometry/imageCoordinates'
import type { Wcs } from '../src/shared/types'

let problems = 0
function check(condition: boolean, description: string): void {
  if (condition) console.log('  ok   ' + description)
  else {
    problems++
    console.log('  NO   ' + description)
  }
}

const DEG_TO_RAD = Math.PI / 180

/** TAN solution with scale in arcsec/px, rotation in degrees and, optionally, mirrored. */
function field(ra: number, dec: number, scale: number, rotation: number, mirror: boolean, W: number, H: number): Wcs {
  const s = scale / 3600
  const c = Math.cos(rotation * DEG_TO_RAD)
  const n = Math.sin(rotation * DEG_TO_RAD)
  // Without mirroring: east on the left with north up (rows going down).
  const sx = mirror ? 1 : -1
  const w = buildWcs({
    crval: [ra, dec],
    crpix: [W / 2 + 0.5, H / 2 + 0.5],
    cd: [
      [sx * s * c, s * n],
      [sx * s * n, -s * c]
    ],
    naxis1: W,
    naxis2: H
  })
  if (!w) throw new Error('invalid solution')
  return w
}

const whole = { x0: 0, y0: 0, x1: 1, y1: 1 }
const rejection = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180)

function checkGrid(name: string, wcs: Wcs): void {
  console.log('Grid: ' + name)
  const lines = coordinateGrid(wcs, whole)
  const ra = lines.filter((l) => l.type === 'ra')
  const dec = lines.filter((l) => l.type === 'dec')
  check(ra.length >= 2 && ra.length <= 14, 'right ascension lines: ' + ra.length)
  check(dec.length >= 2 && dec.length <= 14, 'declination lines: ' + dec.length)
  let worstDec = 0
  let worstRa = 0
  for (const l of lines) {
    for (const t of l.segments) {
      for (const p of t) {
        const c = pixelToSky(wcs, p.x * wcs.naxis1 + 0.5, p.y * wcs.naxis2 + 0.5)
        if (l.type === 'dec') worstDec = Math.max(worstDec, Math.abs(c.dec - l.value))
        // Near the pole right ascension loses meaning: only look far from it.
        else if (Math.abs(c.dec) < 89.5) worstRa = Math.max(worstRa, rejection(c.ra, l.value) * Math.cos(c.dec * DEG_TO_RAD))
      }
    }
  }
  check(worstDec < 1e-6, 'the points of the declination lines have that declination (deviation ' + worstDec.toExponential(1) + '°)')
  check(worstRa < 1e-6, 'the points of the meridians have that right ascension (deviation ' + worstRa.toExponential(1) + '°)')
  const raValues = ra.map((l) => Math.round(l.value * 1e6))
  check(new Set(raValues).size === raValues.length, 'no duplicate meridian')
  check(dec.every((l) => Math.abs(l.value) < 90), 'no line on the pole')
  const visibleItems = lines.filter((l) => l.segments.some((t) => t.some((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)))
  check(visibleItems.length === lines.length, 'every line crosses the image')
}

function checkOrientation(name: string, wcs: Wcs): void {
  console.log('Orientation: ' + name)
  for (const [nx, ny] of [
    [0.5, 0.5],
    [0.1, 0.9],
    [0.85, 0.15]
  ]) {
    const d = northEastDirections(wcs, nx, ny)
    if (!d) {
      check(false, 'directions computed at ' + nx + ',' + ny)
      continue
    }
    const px = nx * wcs.naxis1 + 0.5
    const py = ny * wcs.naxis2 + 0.5
    const c = pixelToSky(wcs, px, py)
    const step = 30
    const towardN = pixelToSky(wcs, px + d.north.x * step, py + d.north.y * step)
    const towardE = pixelToSky(wcs, px + d.east.x * step, py + d.east.y * step)
    check(towardN.dec > c.dec, 'following N the declination increases (' + nx + ',' + ny + ')')
    check(rejection(towardE.ra, c.ra) > 0 && ((towardE.ra - c.ra + 540) % 360) - 180 > 0, 'following E the right ascension increases (' + nx + ',' + ny + ')')
    const product = d.north.x * d.east.x + d.north.y * d.east.y
    check(Math.abs(product) < 0.02, 'N and E perpendicular (product ' + product.toFixed(4) + ')')
  }
}

// Test fields.
const rotatedImage = field(10.6847, 41.2689, 2.1, 30, false, 3000, 2000)
const mirrored = field(83.82, -5.39, 1.2, -50, true, 4000, 3000)
const pole = field(30, 89.7, 9, 10, false, 3000, 2000)
const zeroH = field(0.05, 20, 3.5, 0, false, 3000, 2000)

checkGrid('M 31, field rotated by 30°', rotatedImage)
checkGrid('Orion, mirrored field', mirrored)
checkGrid('north pole in the field', pole)
checkGrid('field straddling 0h', zeroH)
{
  const texts = coordinateGrid(zeroH, whole).filter((l) => l.type === 'ra').map((l) => l.text)
  check(texts.some((t) => t.startsWith('0h')) && texts.some((t) => t.startsWith('23h')), 'straddling 0h both 23h and 0h appear: ' + texts.join(' '))
}
{
  const p = skyToPixel(pole, 0, 90)
  check(p !== null && p.x > 0 && p.x < 3000 && p.y > 0 && p.y < 2000, 'in the test field the pole really falls inside the image')
}

checkOrientation('rotated field', rotatedImage)
checkOrientation('mirrored field', mirrored)
checkOrientation('field straddling 0h', zeroH)

console.log('Scale bar')
for (const [name, w] of [
  ['rotated', rotatedImage],
  ['mirrored', mirrored],
  ['pole', pole]
] as const) {
  const b = scaleBar(w, w.naxis1)
  check(b !== null && Math.abs(b.pixel * scaleArcsec(w) - b.arcsec) < 1e-6, name + ': the length matches the measurement (' + (b?.text ?? '-') + ')')
  check(b !== null && b.pixel <= 0.2 * w.naxis1 + 1e-9 && b.pixel >= 0.04 * w.naxis1, name + ': between a twenty-fifth and a fifth of the width')
}

console.log('Scene')
for (const angle of ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const) {
  const view = { ox: 0, oy: 0, width: 1500, height: 1000, region: whole, body: 14, angle }
  const marks = coordinatesScene(rotatedImage, view, { grid: true, orientation: true, scale: true })
  const texts = marks.filter((s) => s.type === 'text')
  const inside = texts.every((s) => s.type === 'text' && s.x >= 0 && s.x <= 1500 && s.y >= 0 && s.y <= 1000)
  check(inside, angle + ': all labels are inside the image')
  const filledItems = texts.filter((s) => s.type === 'text' && !s.faint).map((s) => (s.type === 'text' ? s.text : ''))
  check(filledItems.includes('N') && filledItems.includes('E') && filledItems.length === 3, angle + ': N, E and the scale measurement')
  // The tools sit in the chosen corner.
  const filledX = marks.filter((s) => !s.faint).flatMap((s) => (s.type === 'segment' ? s.points.map((p) => p.x) : [s.x]))
  const filledY = marks.filter((s) => !s.faint).flatMap((s) => (s.type === 'segment' ? s.points.map((p) => p.y) : [s.y]))
  const meanX = filledX.reduce((a, b) => a + b, 0) / filledX.length
  const meanY = filledY.reduce((a, b) => a + b, 0) / filledY.length
  check((meanX > 750) === angle.endsWith('right') && (meanY > 500) === angle.startsWith('bottom'), angle + ': orientation and scale in the right corner')
  const x0 = Math.min(...filledX) - 4
  const x1 = Math.max(...filledX) + 4
  const y0 = Math.min(...filledY) - 4
  const y1 = Math.max(...filledY) + 4
  const above = texts.filter((s) => s.type === 'text' && s.faint && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1)
  check(above.length === 0, angle + ': no grid label over the orientation and scale')
}
{
  const blank = coordinatesScene(rotatedImage, { ox: 0, oy: 0, width: 1500, height: 1000, region: whole, body: 14, angle: 'bottom-right' }, { grid: false, orientation: false, scale: false })
  check(blank.length === 0, 'with no choices the scene is empty')
  const cropped = coordinatesScene(
    rotatedImage,
    { ox: -500, oy: -300, width: 2000, height: 1333, region: { x0: 0.25, y0: 0.225, x1: 0.75, y1: 0.775 }, body: 14, angle: 'bottom-right' },
    { grid: true, orientation: false, scale: false }
  )
  const cropTexts = cropped.filter((s) => s.type === 'text')
  check(cropTexts.length > 0 && cropTexts.every((s) => s.type === 'text' && s.x >= 0 && s.x <= 1000 && s.y >= 0 && s.y <= 733), 'with a crop the labels stay inside the visible part')
}
{
  // The case of a vertical export (2160 × 3840, field rotated by 40°)
  // with the Minimal template at bottom right: without a reserved zone a
  // right ascension label falls right there; with the zone, no grid label
  // goes over it, not even partly.
  const body = 28
  const vertical = field(339.27, 34.42, 1.2, 40, false, 2160, 3840)
  const zone = { x0: 1100, y0: 3760, x1: 2160, y1: 3840 }
  const view = { ox: 0, oy: 0, width: 2160, height: 3840, region: whole, body, angle: 'bottom-left' as const }
  const footprint = (s: (typeof marks)[number]): boolean => {
    if (s.type !== 'text' || !s.faint) return false
    const wide = s.text.length * body * 0.9 * 0.6
    const top = body * 0.9
    const x0 = s.align === 'start' ? s.x : s.align === 'end' ? s.x - wide : s.x - wide / 2
    const y0 = s.base === 'top' ? s.y : s.base === 'bottom' ? s.y - top : s.y - top / 2
    return x0 < zone.x1 && x0 + wide > zone.x0 && y0 < zone.y1 && y0 + top > zone.y0
  }
  const all = { grid: true, orientation: true, scale: true }
  const without = coordinatesScene(vertical, view, all)
  const marks = coordinatesScene(vertical, { ...view, reserved: [zone] }, all)
  check(without.filter(footprint).length > 0, 'without a reserved zone a label falls on the caption: the check is meaningful')
  check(marks.filter(footprint).length === 0, 'with the reserved zone no grid label over the caption')
  // A caption set slightly apart from the edge: no label slips into the
  // gap between it and the edge either.
  const detached = { x0: 1100, y0: 3730, x1: 2120, y1: 3790 }
  const slit = coordinatesScene(vertical, { ...view, reserved: [detached] }, all).filter(
    (s) => s.type === 'text' && s.faint && s.x > detached.x0 - body && s.y > detached.y0
  )
  check(slit.length === 0, 'no label between the caption and the nearby edge')
}
check(toolsCorner(null) === 'bottom-right', 'without a caption: bottom right')
check(toolsCorner({ model: 'banner', angle: 'bottom-right' }) === 'top-right', 'with the Banner template: top right')
check(toolsCorner({ model: 'minimal', angle: 'bottom-right' }) === 'bottom-left', 'with the Minimal template at bottom right: bottom left')

console.log('Texts')
check(declinationText(41.5, 1800) === '+41°30′', 'declination +41°30′: ' + declinationText(41.5, 1800))
check(declinationText(-0.5, 60) === '−0°30′', 'declination −0°30′: ' + declinationText(-0.5, 60))
check(declinationText(-5, 3600) === '−5°', 'declination −5°: ' + declinationText(-5, 3600))
check(declinationText(12 + 1 / 60 + 15 / 3600, 15) === '+12°01′15″', 'declination with seconds: ' + declinationText(12 + 1 / 60 + 15 / 3600, 15))
check(rightAscensionText(10.6833, 60) === '0h43m', 'right ascension 0h43m: ' + rightAscensionText(10.6833, 60))
check(rightAscensionText(90, 3600) === '6h', 'right ascension 6h: ' + rightAscensionText(90, 3600))
check(rightAscensionText(359.999, 60) === '0h00m', 'right ascension close to 24h becomes 0h00m: ' + rightAscensionText(359.999, 60))
check(rightAscensionText(83.8125, 15) === '5h35m15s', 'right ascension with seconds: ' + rightAscensionText(83.8125, 15))
check(scaleText(30) === '30″' && scaleText(600) === '10′' && scaleText(7200) === '2°', 'scale measurements: 30″, 10′, 2°')

if (problems > 0) {
  console.log('\n' + problems + ' checks failed.')
  process.exit(1)
}
console.log('\nAll checks passed.')
