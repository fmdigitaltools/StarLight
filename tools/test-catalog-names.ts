/**
 * Checks catalog name search: names shared by several objects must lead
 * to the right one (curated first, then Messier, NGC, IC), and duplicates
 * between curated entries and OpenNGC must be merged.
 *
 *   $env:TEST_SCRIPT='tools/test-catalog-names.ts'; node tools/run-test.mjs
 */
import { CATALOG } from '../src/core/catalog/catalog'
import { OPENNGC_DATA } from '../src/core/catalog/openNgcData'
import { searchByName } from '../src/core/catalog/recognition'

let errors = 0
function wait(name: string, id: string): void {
  const found = searchByName(name)
  const ok = found !== null && found.id === id
  if (!ok) errors++
  console.log((ok ? 'ok   ' : 'NO   ') + JSON.stringify(name).padEnd(26) + '-> ' + (found?.id ?? 'nothing') + (ok ? '' : '  (expected ' + id + ')'))
}

wait('Eagle Nebula', 'M 16')
wait('Nebulosa Aquila', 'M 16')
wait('IC 4703', 'IC 4703')
wait('NGC 6611', 'M 16')
wait('Flame Nebula', 'NGC 2024')
wait('Nebulosa Fiamma', 'NGC 2024')
wait('Horsehead', 'IC 434')
wait('Horsehead Nebula', 'IC 434')
wait('Barnard 33', 'IC 434')
wait('B033', 'IC 434')
wait('B 33', 'IC 434')
wait('IC 434', 'IC 434')
wait('M27', 'M 27')
wait('Messier 27', 'M 27')
wait('NGC 6853', 'M 27')
wait('m 31', 'M 31')
wait('NGC 7331', 'NGC 7331')
wait('IC 5', 'IC 5')

// Only one object named "Testa di Cavallo" (IC 4592, the "Testa
// di Cavallo Blu", is a different target).
const heads = CATALOG.filter((o) => o.name === 'Nebulosa Testa di Cavallo')
console.log('objects named Testa di Cavallo: ' + heads.map((o) => o.id).join(', '))
if (heads.length !== 1) errors++

// No duplicate identifiers in the catalog.
const seenItems = new Set<string>()
for (const o of CATALOG) {
  if (seenItems.has(o.id)) {
    console.log('NO   duplicate identifier: ' + o.id)
    errors++
  }
  seenItems.add(o.id)
}
console.log('objects in the catalog: ' + CATALOG.length)

// OpenNGC entries merged into a curated one: they must be true duplicates only.
const presentItems = new Set(CATALOG.map((o) => o.id))
const mergedSeries = OPENNGC_DATA.split('\n')
  .map((r) => r.split('\t'))
  // c[8] is the Messier number (columns described at the top of openNgcData.ts): an entry
  // that has one enters under the name "M n" and must not be counted here.
  .filter((c) => c[0] && !c[8] && !presentItems.has(c[0]))
  .map((c) => c[0])
console.log('OpenNGC entries merged into a curated one: ' + (mergedSeries.join(', ') || 'none'))
// Expected: B033 (Horsehead, curated as IC 434) and NGC 2238 (the
// Rosette, curated as NGC 2237). Any new merge must be inspected by hand.
if (mergedSeries.sort().join(',') !== 'B033,NGC 2238') {
  console.log('NO   the merged entries have changed: check that they are true duplicates')
  errors++
}

console.log(errors === 0 ? '\nALL OK' : '\nERRORS: ' + errors)
if (errors > 0) process.exitCode = 1
