/** Compares object recognition called without image dimensions and with them. */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { recognizeObjects, framedField } from '../src/core/catalog/recognition'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('m27-stacked')
const readResult = readFits(new Uint8Array(readFileSync(path)), path)
const m = readResult.metadata
const w = readResult.image.width
const h = readResult.image.height

console.log('image ' + w + ' x ' + h + ', scale ' + (m.pixelScale ?? 0).toFixed(3) + ' arcsec/px')
const field = framedField(m, w, h)
console.log(
  'actual field: ' +
    (field ? (field.width * 60).toFixed(1) + ' x ' + (field.height * 60).toFixed(1) + ' arcmin' : 'cannot be computed')
)

console.log('\n--- WITHOUT DIMENSIONS ---')
const now = recognizeObjects(m)
console.log('objects found: ' + now.length)
for (const o of now.slice(0, 8)) {
  console.log(
    '  ' + o.object.id.padEnd(10) + o.object.name.slice(0, 26).padEnd(28) +
    'method ' + o.method.padEnd(16) +
    'position ' + (o.position ? o.position.x.toFixed(3) + ', ' + o.position.y.toFixed(3) : 'NOT COMPUTED') +
    '  distance ' + (o.offsetArcmin !== null ? o.offsetArcmin.toFixed(1) + "'" : '-')
  )
}

console.log('\n--- WITH DIMENSIONS ---')
const correctedValue = recognizeObjects(m, w, h)
console.log('objects found: ' + correctedValue.length)
for (const o of correctedValue.slice(0, 8)) {
  const inside =
    o.position !== null && o.position.x >= 0 && o.position.x <= 1 && o.position.y >= 0 && o.position.y <= 1
  console.log(
    '  ' + o.object.id.padEnd(10) + o.object.name.slice(0, 26).padEnd(28) +
    'method ' + o.method.padEnd(16) +
    'position ' + (o.position ? o.position.x.toFixed(3) + ', ' + o.position.y.toFixed(3) : 'NOT COMPUTED') +
    (o.position ? (inside ? '  (inside the frame)' : '  (OUTSIDE the frame)') : '')
  )
}
