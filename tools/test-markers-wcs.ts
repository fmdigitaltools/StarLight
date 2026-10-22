/**
 * Test of the complete recognition chain with an astrometric solution, on
 * the real telescope file. Checks that objects receive a position from the
 * WCS and that the target falls at the center.
 *
 * Usage: TEST_SCRIPT=tools/test-markers-wcs.ts node tools/run-test.mjs [file]
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { recognizeObjects } from '../src/core/catalog/recognition'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('ngc7331-wcs')
const { metadata } = readFits(new Uint8Array(readFileSync(path)), path)

console.log('File: ' + path.split(/[\/]/).pop())
console.log('Declared object: ' + metadata.object + ' | WCS present: ' + (metadata.wcs ? 'yes' : 'no') + '\n')

const objects = recognizeObjects(metadata)
console.log('Recognized objects: ' + objects.length + '\n')
console.log('name'.padEnd(12) + 'method'.padEnd(13) + 'position (x% , y%)'.padEnd(22) + 'confidence')
for (const o of objects) {
  const pos = o.position
    ? (o.position.x * 100).toFixed(1).padStart(6) + ' , ' + (o.position.y * 100).toFixed(1).padStart(6)
    : '   (not placed)     '
  console.log(o.object.id.padEnd(12) + o.method.padEnd(13) + pos.padEnd(22) + ' ' + o.confidence.toFixed(2))
}
