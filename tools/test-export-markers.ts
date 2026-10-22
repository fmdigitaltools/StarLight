/**
 * Tests the drawing of markers for the export, without a real canvas: a
 * fake context records the circles and names drawn. Checks the position
 * mapping (with and without crop) and the rule that hides the marker if
 * its name would run off the edge.
 *
 * Usage: TEST_SCRIPT=tools/test-export-markers.ts node tools/run-test.mjs
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { recognizeObjects } from '../src/core/catalog/recognition'
import { FULL_CROP } from '../src/core/export/crop'
import { drawMarkers } from '../src/renderer/src/export/canvasMarkers'
import { testFile } from './test-files.mjs'

const path = testFile('ngc7331-wcs')
const { metadata } = readFits(new Uint8Array(readFileSync(path)), path)
const objects = recognizeObjects(metadata)
console.log('Recognized objects: ' + objects.length + ', with position: ' +
  objects.filter((o) => o.position).length + '\n')

function fakeCanvas() {
  const circles: { id: string; cx: number; cy: number; r: number }[] = []
  const names: { text: string; x: number; y: number }[] = []
  let lastText = ''
  const ctx: Record<string, unknown> = {
    font: '', textAlign: '', textBaseline: '', lineWidth: 1, strokeStyle: '', fillStyle: '',
    measureText: (t: string) => { lastText = t; return { width: t.length * 7 } },
    beginPath() {}, arc(cx: number, cy: number, r: number) { circles.push({ id: '?', cx, cy, r }) },
    ellipse(cx: number, cy: number, r: number) { circles.push({ id: '?', cx, cy, r }) },
    stroke() {}, moveTo() {}, lineTo() {},
    strokeText() {}, fillText(t: string, x: number, y: number) { names.push({ text: t, x, y }) }
  }
  return { ctx, circles, names }
}

const W = metadata.wcs ? metadata.wcs.naxis1 : 0
const H = metadata.wcs ? metadata.wcs.naxis2 : 0
const scale = metadata.pixelScale

console.log('--- FULL-RESOLUTION EXPORT (' + W + 'x' + H + '), no crop ---')
let t = fakeCanvas()
drawMarkers(t.ctx as never, W, H, objects, FULL_CROP, scale, W)
console.log('Markers drawn: ' + t.names.length)
for (const n of t.names.slice(0, 4)) {
  console.log('  ' + n.text.padEnd(10) + ' at ' + (n.x / W * 100).toFixed(1) + '% , ' + (n.y / H * 100).toFixed(1) + '%')
}

console.log('\n--- RESIZED to 1080 width ---')
const fW = 1080, fH = Math.round((H / W) * 1080)
t = fakeCanvas()
drawMarkers(t.ctx as never, fW, fH, objects, FULL_CROP, scale, W)
console.log('Markers drawn: ' + t.names.length + ' (expected to be similar to the case above, the name takes more relative space)')

console.log('\n--- CENTRAL 50% CROP ---')
const halfSize = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
t = fakeCanvas()
drawMarkers(t.ctx as never, W, H, objects, halfSize, scale, W)
console.log('Markers drawn: ' + t.names.length + ' (only those inside the central crop)')
const ngc = t.names.find((n) => n.text === 'NGC 7331')
if (ngc) console.log('  NGC 7331 now at ' + (ngc.x / W * 100).toFixed(1) + '% , ' + (ngc.y / H * 100).toFixed(1) +
  '% (at the center of the crop it must be ~50%)')
