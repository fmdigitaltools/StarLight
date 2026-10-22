/**
 * Test of the marker anti-crowding filter.
 *
 * On real files (NGC 7331, M 27, M 33) it rebuilds the marker geometry as
 * the viewer and the export compute it, at various scales, and prints which
 * names remain, which groups form and how many circles are left without a
 * name. A synthetic case checks the rules: cap respected, no overlapping
 * names, target always present, group with a common name.
 *
 * Usage: TEST_SCRIPT=tools/test-crowding.ts node tools/run-test.mjs
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { recognizeObjects } from '../src/core/catalog/recognition'
import {
  chooseMarkers,
  filterMarkerTypes,
  namesCap,
  type MarkerCandidate,
  type MarkersChoice
} from '../src/core/catalog/crowding'
import type { RecognizedObject } from '../src/shared/types'
import { testFile } from './test-files.mjs'

let errors = 0
function check(condition: boolean, message: string): void {
  if (!condition) {
    errors++
    console.log('  ERROR: ' + message)
  }
}

/** Drawing scale: like the viewer (font size 13) or the export (font size 13·k). */
interface Scale {
  name: string
  /** Drawing pixels per image pixel. */
  eff: number
  /** Visible area in drawing pixels (the view or the final image). */
  width: number
  height: number
  /** Position of the photo's corner in the view. */
  photoX: number
  photoY: number
  body: number
  /** Unit of the fixed distances (1 on screen, k in export). */
  k: number
  maxRadius: number
}

/** Marker geometry, recomputed as in Viewer.tsx / canvasMarkers.ts. */
function candidates(
  objects: RecognizedObject[],
  W: number,
  H: number,
  pixelScale: number,
  s: Scale
): MarkerCandidate[] {
  const photoW = W * s.eff
  const photoH = H * s.eff
  const lim = {
    x0: Math.max(0, s.photoX),
    y0: Math.max(0, s.photoY),
    x1: Math.min(s.width, s.photoX + photoW),
    y1: Math.min(s.height, s.photoY + photoH)
  }
  const result: MarkerCandidate[] = []
  for (const o of objects) {
    if (!o.position) continue
    const cx = s.photoX + o.position.x * photoW
    const cy = s.photoY + o.position.y * photoH
    if (cx < lim.x0 || cx > lim.x1 || cy < lim.y0 || cy > lim.y1) continue
    const radius =
      o.object.sizeArcmin !== null
        ? Math.min(
            s.maxRadius,
            Math.max(16 * s.k, ((o.object.sizeArcmin * 60) / pixelScale / 2) * s.eff * 1.5 + 6 * s.k)
          )
        : 16 * s.k
    const dash = 15 * s.k
    const above = cy - radius - dash - s.body > lim.y0
    const yOuter = above ? cy - radius - dash : cy + radius + dash
    const yText = above ? yOuter - 5 * s.k : yOuter + s.body
    const halfSize = measurement(o.object.id, s.body) / 2 + 3
    const nameInside =
      cx - halfSize >= lim.x0 && cx + halfSize <= lim.x1 && yText - s.body >= lim.y0 && yText <= lim.y1
    result.push({ object: o, cx, cy, radius, yText, nameInside })
  }
  return result
}

function measurement(text: string, body: number): number {
  return text.length * body * 0.6
}

function print(choice: MarkersChoice, cap: number): void {
  const names = choice.withName.map((m) => m.text)
  console.log('    names (' + names.length + ', cap ' + cap + '): ' + names.join(' · '))
  if (choice.unnamed.length > 0) {
    console.log(
      '    unnamed circles (' + choice.unnamed.length + '): ' +
        choice.unnamed.map((c) => c.object.object.id).join(', ')
    )
  }
}

/** Common checks: no overlapping names, cap, target present. */
function checkRules(c: MarkerCandidate[], choice: MarkersChoice, cap: number, body: number): void {
  const boxes = choice.withName.map((m) => {
    const halfSize = measurement(m.text, body) / 2
    const y = m.candidate.yText
    return { x0: m.candidate.cx - halfSize, x1: m.candidate.cx + halfSize, y0: y - body, y1: y + body * 0.3 }
  })
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const touches = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
      check(!touches, 'overlapping names: ' + choice.withName[i].text + ' / ' + choice.withName[j].text)
    }
  }
  const nonTargets = choice.withName.filter((m) => m.candidate.object.confidence < 0.98).length
  check(nonTargets <= cap, 'cap exceeded: ' + nonTargets + ' > ' + cap)
  const target = c.find((x) => x.object.confidence >= 0.98 && x.nameInside)
  if (target) {
    check(
      choice.withName.some((m) => m.candidate === target),
      'the target ' + target.object.object.id + ' lost its name'
    )
  }
  // Every candidate ends up in one and only one place.
  const countedItems =
    choice.withName.length +
    choice.withName.reduce((n, m) => n + m.grouped.length, 0) +
    choice.unnamed.length
  check(countedItems === c.length, 'lost or duplicated candidates: ' + countedItems + ' of ' + c.length)
}

function test(objects: RecognizedObject[], W: number, H: number, ps: number, s: Scale): MarkersChoice {
  const c = candidates(objects, W, H, ps, s)
  // The cap is computed on the visible part of the photo, not on the whole view.
  const lim = {
    x0: Math.max(0, s.photoX),
    y0: Math.max(0, s.photoY),
    x1: Math.min(s.width, s.photoX + W * s.eff),
    y1: Math.min(s.height, s.photoY + H * s.eff)
  }
  const cap = namesCap(lim.x1 - lim.x0, lim.y1 - lim.y0, s.body)
  const choice = chooseMarkers(c, lim.x1 - lim.x0, lim.y1 - lim.y0, {
    limits: lim,
    textBody: s.body,
    textMeasurer: (t) => measurement(t, s.body)
  })
  console.log('  ' + s.name + ' — candidates ' + c.length)
  print(choice, cap)
  checkRules(c, choice, cap, s.body)
  return choice
}

/** 1000 × 900 viewer view with zoom `factor` relative to fit, centered on (px, py). */
function screen(W: number, H: number, factor: number, px = 0.5, py = 0.5): Scale {
  const viewL = 1000
  const viewA = 900
  const eff = Math.min(viewL / W, viewA / H) * factor
  return {
    name: 'screen, zoom ×' + factor + (factor > 1 ? ' at (' + px + ', ' + py + ')' : ''),
    eff,
    width: viewL,
    height: viewA,
    photoX: viewL / 2 - px * W * eff,
    photoY: viewA / 2 - py * H * eff,
    body: 13,
    k: 1,
    maxRadius: 340
  }
}

function exportSettings(W: number, H: number, width: number): Scale {
  const k = width / 1000
  const height = Math.round((width * H) / W)
  return {
    name: 'export ' + width + '×' + height,
    eff: width / W,
    width,
    height,
    photoX: 0,
    photoY: 0,
    body: Math.max(11, Math.round(13 * k)),
    k,
    maxRadius: width * 0.3
  }
}

// --- Real files ---
for (const name of ['ngc7331', 'm27', 'm33']) {
  const path = testFile(name)
  const { image, metadata } = readFits(new Uint8Array(readFileSync(path)), path)
  const objects = recognizeObjects(metadata)
  const ps = metadata.pixelScale ?? 2.39
  const W = image.width
  const H = image.height
  console.log('\n' + name + ': ' + objects.length + ' objects recognized')
  const whole = test(objects, W, H, ps, screen(W, H, 1))
  test(objects, W, H, ps, screen(W, H, 2))
  test(objects, W, H, ps, exportSettings(W, H, 1080))
  test(objects, W, H, ps, exportSettings(W, H, W))

  if (name === 'ngc7331') {
    // Zooming on the Quintet must reveal more names than the whole field.
    const quintet = test(objects, W, H, ps, screen(W, H, 6, 0.36, 0.89))
    const quintetNames = quintet.withName.length
    check(quintetNames >= 4, 'zooming on the Quintet shows only ' + quintetNames + ' names')
    check(
      whole.withName.some((m) => m.text.startsWith('Quintetto di Stephan e altri')),
      'in the whole field the Quintet is not grouped under its common name'
    )
    check(whole.withName.length <= 10, 'more than ten names in the whole field')
  }
  if (name === 'm27') {
    check(whole.withName.length === 1 && whole.unnamed.length === 0, 'M 27 must have only its name')
  }
}

// --- Synthetic case ---
// One target, a cluster of 25 small objects around a group with a
// common name, and 20 scattered objects: more than the cap.
console.log('\nSynthetic case')
function makeFake(
  id: string,
  x: number,
  y: number,
  options: Partial<RecognizedObject['object']> & { target?: boolean } = {}
): RecognizedObject {
  return {
    object: {
      id,
      name: options.name ?? id,
      aliases: [],
      type: options.type ?? 'galaxy',
      ra: 0,
      dec: 0,
      magnitude: options.magnitude ?? 14,
      sizeArcmin: options.sizeArcmin ?? 0.8,
      constellation: '',
      description: ''
    },
    confidence: options.target ? 0.99 : 0.9,
    method: 'wcs',
    offsetArcmin: null,
    position: { x, y }
  }
}
const synthetics: RecognizedObject[] = [
  makeFake('NGC 1000', 0.5, 0.5, { target: true, sizeArcmin: 8, magnitude: 10 }),
  makeFake('HCG 999', 0.3, 0.8, { name: 'Test Group', type: 'galaxy-group', sizeArcmin: 3 })
]
for (let i = 0; i < 25; i++) {
  const a = (i / 25) * Math.PI * 2
  synthetics.push(makeFake('IC ' + (2000 + i), 0.3 + Math.cos(a) * 0.02, 0.8 + Math.sin(a) * 0.012))
}
for (let i = 0; i < 20; i++) {
  synthetics.push(
    makeFake('NGC ' + (3000 + i), 0.1 + ((i * 0.37) % 0.8), 0.1 + ((i * 0.53) % 0.6), {
      magnitude: 12 + (i % 5)
    })
  )
}
const synth = test(synthetics, 2160, 3840, 2.39, screen(2160, 3840, 1))
check(
  synth.withName.some((m) => m.text.startsWith('Test Group e altri')),
  'the synthetic cluster is not grouped under the common name'
)
// The target must not absorb groups.
const syntheticTarget = synth.withName.find((m) => m.candidate.object.object.id === 'NGC 1000')
check(syntheticTarget !== undefined && syntheticTarget.grouped.length === 0, 'the target has a group')
test(synthetics, 2160, 3840, 2.39, exportSettings(2160, 3840, 2160))

// Circles, density and hidden types: a field with 400 small scattered objects.
{
  const many: RecognizedObject[] = [makeFake('NGC 1000', 0.5, 0.5, { target: true, sizeArcmin: 8, magnitude: 10 })]
  for (let i = 0; i < 400; i++) {
    many.push(
      makeFake('PGC ' + (1000 + i), ((i * 0.6180339) % 1) * 0.96 + 0.02, ((i * 0.4142) % 1) * 0.96 + 0.02, {
        magnitude: 14 + (i % 7) * 0.3,
        sizeArcmin: 0.3
      })
    )
  }
  const place = (list: RecognizedObject[]): MarkerCandidate[] =>
    list.map((o) => ({
      object: o,
      cx: o.position!.x * 500,
      cy: o.position!.y * 900,
      radius: 3,
      yText: o.position!.y * 900 - 6,
      nameInside: true
    }))
  const parameters = (density: number): Parameters<typeof chooseMarkers>[3] => ({
    limits: { x0: 0, y0: 0, x1: 500, y1: 900 },
    textBody: 13,
    textMeasurer: (t: string) => t.length * 7.8,
    density
  })
  const normal = chooseMarkers(place(many), 500, 900, parameters(1))
  const essential = chooseMarkers(place(many), 500, 900, parameters(0.5))
  const rich = chooseMarkers(place(many), 500, 900, parameters(2))
  const total = (x: MarkersChoice): number => x.withName.length + x.unnamed.length
  console.log('     400 objects: essential ' + total(essential) + ', normal ' + total(normal) + ', rich ' + total(rich) + ' markers')
  check(normal.unnamed.length <= namesCap(500, 900, 13) * 3, 'unnamed circles have a cap (' + normal.unnamed.length + ')')
  check(total(essential) < total(normal) && total(normal) < total(rich), 'density changes the number of markers')
  check(normal.withName.some((m) => m.candidate.object.object.id === 'NGC 1000'), 'the target always has its name')
  const withoutGalaxies = filterMarkerTypes(many, ['galaxies'])
  check(withoutGalaxies.length === 1 && withoutGalaxies[0].object.id === 'NGC 1000', 'hiding galaxies leaves only the target')
  check(filterMarkerTypes(many, []).length === many.length, 'with no hidden types nothing is removed')
}

console.log('\n' + (errors === 0 ? 'All checks passed.' : errors + ' errors.'))
if (errors > 0) process.exit(1)
