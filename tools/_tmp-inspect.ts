import { inspectCatalog, fileFromCatalogZip } from '../src/main/catalogInspection'
const base = 'https://starlight-updates.fm-digitals.workers.dev/catalogs/'
for (const id of process.argv.slice(2)) {
  const buf = Buffer.from(await (await fetch(base + id + '-2.0.0.zip')).arrayBuffer())
  try {
    const files = fileFromCatalogZip(buf)
    const r = inspectCatalog(files, true)
    console.log(id, buf.length, JSON.stringify(r).slice(0, 400))
  } catch (e) { console.log(id, 'THROW', (e as Error).message) }
}
