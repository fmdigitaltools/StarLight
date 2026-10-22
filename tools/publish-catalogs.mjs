/*
 * Uploads the deep sky catalogs to the R2 bucket, in the catalogs/ folder.
 *
 *   npm run publish-catalogs                 uploads the packages prepared in dist-catalogs
 *   npm run publish-catalogs -- --dry-run    shows what would be uploaded, without uploading
 *
 * The packages are prepared first with "npm run prepare-catalogs".
 *
 * Environment variables (the same as "npm run publish"):
 *   STARLIGHT_R2_BUCKET        name of the R2 bucket (required, except with --dry-run)
 *   STARLIGHT_R2_PREFIX        folder inside the bucket (optional)
 *   STARLIGHT_R2_JURISDICTION  "eu" if the bucket is under European jurisdiction
 *   CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or a "wrangler login" already done
 *
 * Upload order: the .zip packages first, catalogs.json last. Anyone
 * opening the gallery halfway through the upload still finds the old list,
 * which points to complete packages. Packages carry the version in their
 * name and never change afterwards: the cache can keep them for a year;
 * the list, however, must not be cached.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const folder = join(root, 'dist-catalogs')

function stop(message) {
  console.error('\n✖ ' + message + '\n')
  process.exit(1)
}

function run(command, commandArgs) {
  console.log('\n> ' + command + ' ' + commandArgs.join(' '))
  // On Windows npx is a .cmd file: it needs the shell.
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) stop('The command failed: ' + command + ' ' + commandArgs.join(' '))
}

const bucket = process.env.STARLIGHT_R2_BUCKET ?? ''
let prefix = process.env.STARLIGHT_R2_PREFIX ?? ''
if (prefix !== '' && !prefix.endsWith('/')) prefix += '/'
const jurisdiction = process.env.STARLIGHT_R2_JURISDICTION ?? ''
if (!dryRun && bucket === '') stop('STARLIGHT_R2_BUCKET is missing: the name of the R2 bucket.')

const indexFile = join(folder, 'catalogs.json')
if (!existsSync(indexFile)) stop('dist-catalogs/catalogs.json is missing: prepare the packages first with "npm run prepare-catalogs".')
const index = JSON.parse(readFileSync(indexFile, 'utf-8'))

const uploads = []
for (const c of index.catalogs) {
  const file = join(folder, c.file)
  if (!existsSync(file)) stop('The package ' + c.file + ' listed in the index is missing.')
  uploads.push({ file, key: 'catalogs/' + c.file, type: 'application/zip', cache: 'public, max-age=31536000, immutable' })
}
uploads.push({ file: indexFile, key: 'catalogs/catalogs.json', type: 'application/json; charset=utf-8', cache: 'no-cache' })

console.log('\n' + index.catalogs.length + ' catalogs, bucket "' + (bucket || '(not specified)') + '":')
for (const u of uploads) console.log('  ' + prefix + u.key + '   ← ' + u.file)

for (const u of uploads) {
  const wranglerArgs = [
    'wrangler',
    'r2',
    'object',
    'put',
    '"' + (bucket || '<bucket>') + '/' + prefix + u.key + '"',
    '--file',
    '"' + u.file + '"',
    '--content-type',
    '"' + u.type + '"',
    '--cache-control',
    '"' + u.cache + '"',
    // Without --remote wrangler would write to a fake bucket on this computer.
    '--remote'
  ]
  if (jurisdiction !== '') wranglerArgs.push('--jurisdiction', jurisdiction)
  if (dryRun) console.log('\n(dry run) npx ' + wranglerArgs.join(' '))
  else run('npx', wranglerArgs)
}

console.log(dryRun ? '\nDry run finished: nothing was uploaded.\n' : '\n✔ Catalogs published: the gallery shows them right away.\n')
