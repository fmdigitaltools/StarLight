/**
 * Lists the complete header of a FITS file using the StarLight reader.
 * It establishes, without hand-made filters, whether the file contains the
 * astrometric solution (WCS) needed to place objects.
 *
 * Usage: TEST_SCRIPT=tools/inspect-header.ts node tools/run-test.mjs [file]
 */
import { readFileSync } from 'node:fs'
import { readFitsHeaderOnly } from '../src/core/fits/reader'
import { testFile } from './test-files.mjs'

const path =
  process.argv[2] ?? testFile('m27-stacked')
const { header } = readFitsHeaderOnly(new Uint8Array(readFileSync(path)))

console.log('File: ' + path.split(/[\/]/).pop())
console.log('Total header cards: ' + header.order.length + '\n')

// The keys a FITS file uses to declare the astrometric solution.
const wcsKeys = [
  'CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2',
  'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2',
  'CDELT1', 'CDELT2', 'CROTA1', 'CROTA2',
  'CTYPE1', 'CTYPE2', 'PC1_1', 'PC1_2', 'PC2_1', 'PC2_2',
  'A_ORDER', 'B_ORDER', 'EQUINOX', 'RADESYS'
]
const presentItems = wcsKeys.filter((k) => k in header.cards)

console.log('--- ASTROMETRIC SOLUTION (WCS) ---')
if (presentItems.length === 0) {
  console.log('NO WCS keys present. The file does not carry the solution.')
} else {
  console.log('Present: ' + presentItems.join(', '))
  for (const k of presentItems) console.log('  ' + k.padEnd(10) + '= ' + header.cards[k])
}

console.log('\n--- FULL HEADER ---')
for (const k of header.order) {
  const v = header.cards[k]
  const comment = header.comments[k] ? '  / ' + header.comments[k] : ''
  console.log('  ' + k.padEnd(10) + '= ' + String(v) + comment)
}
