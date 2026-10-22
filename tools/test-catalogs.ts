/**
 * Test of the catalog packages prepared in dist-catalogs/ (see
 * tools/prepare-catalogs.mjs): consistent list and hashes, manifests with
 * an open license, readable objects, and the entry into the StarLight
 * catalog (searchable designations, duplicates merged with the entries
 * already present, catalog back to its original state after uninstall),
 * and the texts in both languages: manifests, object descriptions that
 * follow the language change, English descriptions of the bundled OpenNGC
 * objects.
 *
 *   $env:TEST_SCRIPT='tools/test-catalogs.ts'; node tools/run-test.mjs
 *
 * Without dist-catalogs/ the test is skipped.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readZip } from '../src/main/zip'
import {
  readCatalogsIndex,
  analyzeCatalogObjects,
  checkCatalogManifest,
  catalogText,
  CATALOG_MANIFEST_FILE,
  OBJECTS_FILE,
  PACKAGE_LIMIT_BYTES
} from '../src/core/catalog/package'
import { STARS_FILE } from '../src/core/astrometry/localStars'
import { OPENNGC_DATA } from '../src/core/catalog/openNgcData'
import { setLanguage } from '../src/shared/i18n/i18n'
import { CATALOG, OBJECT_COUNT, objectCount, registerCatalog, removeCatalog, searchCatalog } from '../src/core/catalog/catalog'

const folder = join(process.cwd(), 'dist-catalogs')
if (!existsSync(join(folder, 'catalogs.json'))) {
  console.log('dist-catalogs/ is missing: test skipped (prepare the packages with npm run prepare-catalogs).')
  process.exit(77)
}

let errors = 0
function check(ok: boolean, what: string): void {
  if (!ok) errors++
  console.log((ok ? 'ok   ' : 'NO   ') + what)
}

const raw = JSON.parse(readFileSync(join(folder, 'catalogs.json'), 'utf-8'))
const index = readCatalogsIndex(raw)
check(index.catalogs.length === raw.catalogs.length, 'all entries of the list are valid (' + index.catalogs.length + ')')

for (const entry of index.catalogs) {
  const data = readFileSync(join(folder, entry.file))
  check(data.length === entry.byte && data.length <= PACKAGE_LIMIT_BYTES, entry.id + ': size as in the list')
  check(createHash('sha256').update(data).digest('hex') === entry.sha256, entry.id + ': SHA-256 hash as in the list')
  const file = new Map(readZip(data, { file: 20, total: PACKAGE_LIMIT_BYTES * 4, what: 'a catalog' }).map((v) => [v.name, v.data]))
  const m = checkCatalogManifest(JSON.parse(file.get(CATALOG_MANIFEST_FILE)!.toString('utf-8')))
  check(m.ok, entry.id + ': valid manifest, open license')
  check(file.has('LICENSE.txt') && file.has('ATTRIBUTION.md'), entry.id + ': license and credits in the package')
  // Texts in English, with the Italian translation of the name and description.
  check(
    entry.translations.it?.name !== undefined || catalogText(entry, 'name', 'it') === entry.name,
    entry.id + ': name in English and Italian («' + entry.name + '» / «' + catalogText(entry, 'name', 'it') + '»)'
  )
  check(
    !!entry.translations.it?.description && entry.translations.it.description !== entry.description,
    entry.id + ': description in English and Italian'
  )
  // The star package carries no objects: test-local-stars.ts checks it.
  if (entry.type === 'stars') {
    check(file.has(STARS_FILE) && !file.has(OBJECTS_FILE), entry.id + ': star package, with ' + STARS_FILE + ' and without objects')
    continue
  }
  const analysis = analyzeCatalogObjects(file.get(OBJECTS_FILE)!.toString('utf-8'), entry)
  const objects = analysis.objects
  check(objects.length === entry.objects, entry.id + ': ' + objects.length + ' objects read out of ' + entry.objects)
  // Every object has a description in both languages, and they differ.
  const withoutText = objects.filter((o) => !analysis.describe(o, 'en') || !analysis.describe(o, 'it'))
  const sameText = objects.filter((o) => analysis.describe(o, 'en') === analysis.describe(o, 'it'))
  check(
    withoutText.length === 0 && sameText.length === 0,
    entry.id + ': descriptions in English and Italian («' + analysis.describe(objects[0], 'en') + '» / «' + analysis.describe(objects[0], 'it') + '»)'
  )
  registerCatalog(entry.id, objects, analysis.describe)
}

// Descriptions of the installed catalogs' objects follow the language.
{
  const o = searchCatalog('LDN 1622')
  setLanguage('en')
  const en = o?.description ?? ''
  setLanguage('it')
  const it = o?.description ?? ''
  check(o !== null && en.startsWith('Position from Wikidata') && it.startsWith('Posizione da Wikidata'), 'package descriptions follow the language: «' + en + '» / «' + it + '»')
}

// Bundled OpenNGC objects: every Italian description has its English one.
{
  const rows = OPENNGC_DATA.split('\n').map((r) => r.split('\t'))
  const missing = rows.filter((c) => (c[13] ?? '') !== '' && (c[14] ?? '') === '').map((c) => c[0])
  check(missing.length === 0, 'OpenNGC: English description for every Italian one' + (missing.length ? ' (missing: ' + missing.slice(0, 10).join(', ') + ')' : ''))
  const m51 = searchCatalog('NGC 7331')
  setLanguage('en')
  const en = m51?.description ?? ''
  setLanguage('it')
  check(en !== '' && en !== m51?.description, 'OpenNGC descriptions follow the language: «' + en + '»')
}

console.log('\nCatalog: ' + OBJECT_COUNT + ' bundled, ' + objectCount() + ' with the packages.')
check(objectCount() > OBJECT_COUNT, 'the packages add objects')

function find(name: string, expected: string | null, what: string): void {
  const o = searchCatalog(name)
  const ok = expected === null ? o !== null : o !== null && o.id === expected
  check(ok, what + ': «' + name + '» → ' + (o?.id ?? 'nothing') + (expected && !ok ? ' (expected ' + expected + ')' : ''))
}

// New designations, searchable.
find('Sh2-155', null, 'Sharpless')
find('LDN 1622', null, 'Lynds dark')
find('Arp 273', null, 'Arp')
find('HCG 92', null, 'Hickson')
find('Collinder 69', null, 'Gaia clusters')
find('Palomar 5', null, 'globular')
// Duplicates: objects already included stay those, with the new designation as an alternative name.
find('B 33', 'IC 434', 'Horsehead, Barnard merged with the curated one')
find('Melotte 22', 'M 45', 'Pleiades, Gaia cluster merged with the Messier one')
find('NGC 104', 'NGC 104', '47 Tucanae stays a single entry')
const pleiadesDuplicates = CATALOG.filter((o) => Math.abs(o.ra - 56.75) < 0.5 && Math.abs(o.dec - 24.12) < 0.5 && o.type === 'open-cluster')
check(pleiadesDuplicates.length === 1, 'a single open cluster on the Pleiades (' + pleiadesDuplicates.map((o) => o.id).join(', ') + ')')

for (const entry of index.catalogs) removeCatalog(entry.id)
check(objectCount() === OBJECT_COUNT, 'after uninstall the catalog returns to how it was')
find('Melotte 22', 'M 45', 'the Pleiades can still be found by name')
check(searchCatalog('Sh2-155') === null || searchCatalog('Sh2-155')!.id.startsWith('NGC') || searchCatalog('Sh2-155')!.id.startsWith('IC'), 'removed designations do not lead to removed entries')

console.log(errors === 0 ? '\nAll checks passed.' : '\n' + errors + ' checks failed.')
process.exit(errors === 0 ? 0 : 1)
