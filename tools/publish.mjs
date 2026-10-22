/*
 * Publishes a new StarLight version for automatic updates.
 *
 *   npm run publish                  builds the installer and uploads it to R2
 *   npm run publish -- --dry-run     builds and shows what it would upload, without uploading
 *   npm run publish -- --skip-build  uploads the files already present in dist-build
 *   npm run publish -- --folder=DIR  takes the files from DIR instead of dist-build
 *
 * Environment variables:
 *   STARLIGHT_R2_BUCKET        name of the R2 bucket (required, except with --dry-run)
 *   STARLIGHT_R2_PREFIX        folder inside the bucket, for example "starlight/" (optional)
 *   STARLIGHT_R2_JURISDICTION  "eu" if the bucket is under European jurisdiction (optional)
 *   CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or a "wrangler login" already done
 *
 * Upload order: first the installer and its blockmap, last latest.yml.
 * Anyone checking for updates mid-upload still finds the old latest.yml,
 * which points to a complete installer, and never a new latest.yml pointing
 * to a file that has not arrived yet.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const skipBuild = args.includes('--skip-build')
const folderArg = args.find((a) => a.startsWith('--folder='))
const folder = folderArg ? resolve(folderArg.slice(folderArg.indexOf('=') + 1)) : join(root, 'dist-build')

function stop(message) {
  console.error('\n✖ ' + message + '\n')
  process.exit(1)
}

function run(command, args) {
  console.log('\n> ' + command + ' ' + args.join(' '))
  // On Windows npx is a .cmd file: the shell is required.
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) stop('The command failed: ' + command + ' ' + args.join(' '))
}

/* ---- Checks before starting ---- */

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const version = packageJson.version
const versionText = readFileSync(join(root, 'src/shared/version.ts'), 'utf-8')
const appVersion = /APP_VERSION\s*=\s*'([^']+)'/.exec(versionText)?.[1]
const address = /URL_AGGIORNAMENTI\s*=\s*'([^']+)'/.exec(versionText)?.[1] ?? ''

if (appVersion !== version) {
  stop(
    'The version in package.json (' + version + ') and APP_VERSION in src/shared/version.ts (' +
      appVersion + ') do not match. Fix them before publishing.'
  )
}
if (address.includes('…') || address === '') {
  const text =
    'URL_AGGIORNAMENTI in src/shared/version.ts is still the placeholder: the published version would not ' +
    'know where to look for later updates. Write the Worker address.'
  if (dryRun) console.warn('\n⚠ ' + text + '\n')
  else stop(text)
}

const bucket = process.env.STARLIGHT_R2_BUCKET ?? ''
if (bucket === '' && !dryRun) {
  stop('The bucket name is missing: set the STARLIGHT_R2_BUCKET variable.')
}
// Bucket created under a jurisdiction (for example "eu"): wrangler only
// finds it if told so.
const jurisdiction = process.env.STARLIGHT_R2_JURISDICTION ?? ''
let prefix = process.env.STARLIGHT_R2_PREFIX ?? ''
if (prefix !== '' && !prefix.endsWith('/')) prefix += '/'

if (!existsSync(join(root, 'resources/release-notes.md'))) {
  console.warn(
    '\n⚠ resources/release-notes.md is missing: the update window will not show the release notes.\n' +
      '  Write them there (plain text, one line per item) and rerun, or continue without.\n'
  )
}

/*
 * RAW reader: every version should ship the latest LibRaw, so recently
 * released cameras can be opened. This only warns: updating also means
 * rerunning the RAW tests, and the person publishing decides that.
 */
{
  const name = '@colorhythm/libraw-wasm'
  const installed = (packageJson.dependencies ?? {})[name]
  const latest = spawnSync('npm', ['view', name, 'version'], { cwd: root, encoding: 'utf8', shell: true })
  const available = latest.status === 0 ? latest.stdout.trim() : ''
  if (available === '') {
    console.warn('\n⚠ Could not check the latest version of ' + name + '.\n')
  } else if (installed && installed.replace(/^[\^~]/, '') !== available) {
    console.warn(
      '\n⚠ The RAW reader (' + name + ') is at ' + installed + ', but version ' + available + ' is available.\n' +
        '  Update it before publishing: npm install ' + name + '@' + available + ' --save-exact,\n' +
        '  then npm run test with STARLIGHT_TEST_RAW.\n'
    )
  } else {
    console.log('RAW reader up to date (' + name + ' ' + available + ').')
  }
}

/* ---- Build ---- */

if (!skipBuild) {
  // Fast tests first, as in "npm run dist" (skipped with STARLIGHT_SKIP_TESTS=1).
  run('node', ['tools/run-tests.mjs', '--quick'])
  run('node', ['tools/update-attribution.mjs'])
  run('node', ['tools/write-release-notes.mjs'])
  run('node', ['tools/generate-credits.mjs'])
  run('npx', ['electron-vite', 'build'])
  /*
   * Installer only (not the portable build, which does not update itself).
   * The "publish" section passed here makes electron-builder write
   * latest.yml (and the files of the other channels) and the blockmap;
   * "never" means this script does the uploading, not electron-builder.
   */
  run('npx', [
    'electron-builder',
    '--win',
    'nsis',
    '--publish',
    'never',
    '-c.publish.provider=generic',
    '"-c.publish.url=' + (address.includes('…') ? 'https://example.invalid/' : address) + '"',
    '-c.generateUpdatesFilesForAllChannels=true',
    '"-c.directories.output=' + folder + '"'
  ])
}

/* ---- What to upload ---- */

const channelFiles = ['latest.yml', 'beta.yml', 'alpha.yml'].filter((n) => existsSync(join(folder, n)))
if (channelFiles.length === 0) stop('No latest.yml in ' + folder + ': the build did not produce it.')

const installers = new Set()
for (const name of channelFiles) {
  // electron-builder always writes latest.yml in the same form: a few lines are enough.
  const text = readFileSync(join(folder, name), 'utf-8')
  const fileVersion = /^version:\s*'?([^'\s]+)'?\s*$/m.exec(text)?.[1]
  if (fileVersion !== version) {
    stop(name + ' describes version ' + fileVersion + ', not ' + version + '. Rebuild without --skip-build.')
  }
  for (const m of text.matchAll(/^\s*-?\s*(?:url|path):\s*'?([^'\r\n]+?)'?\s*$/gm)) installers.add(m[1])
}

const uploads = []
for (const installerName of installers) {
  const path = join(folder, installerName)
  if (!existsSync(path)) stop('Missing file ' + path)
  // File names with the version inside: they never change, so they can be cached for a long time.
  uploads.push({ file: path, key: installerName, type: 'application/octet-stream', cache: 'public, max-age=31536000, immutable' })
  const blockmap = path + '.blockmap'
  if (existsSync(blockmap)) {
    uploads.push({ file: blockmap, key: installerName + '.blockmap', type: 'application/octet-stream', cache: 'public, max-age=31536000, immutable' })
  }
}
// Archive copy of the channel files with the version in the name (for
// example latest-0.4.5.yml): used by "npm run withdraw" to put a previous
// version back online. It never changes, like the installers.
for (const name of channelFiles) {
  uploads.push({
    file: join(folder, name),
    key: name.replace(/\.yml$/, '-' + version + '.yml'),
    type: 'text/yaml; charset=utf-8',
    cache: 'public, max-age=31536000, immutable'
  })
}
// Channel files last, since they change with every version: no cache.
for (const name of channelFiles) {
  uploads.push({ file: join(folder, name), key: name, type: 'text/yaml; charset=utf-8', cache: 'no-cache' })
}

console.log('\nVersion ' + version + ', bucket «' + (bucket || '(not specified)') + '»' + (prefix ? ', folder «' + prefix + '»' : '') + ':')
for (const c of uploads) console.log('  ' + prefix + c.key + '   ← ' + c.file)

/* ---- Upload ---- */

for (const c of uploads) {
  const args = [
    'wrangler',
    'r2',
    'object',
    'put',
    '"' + (bucket || '<bucket>') + '/' + prefix + c.key + '"',
    '--file',
    '"' + c.file + '"',
    '--content-type',
    '"' + c.type + '"',
    '--cache-control',
    '"' + c.cache + '"',
    // Without --remote wrangler would write to a fake bucket on the computer.
    '--remote'
  ]
  if (jurisdiction !== '') args.push('--jurisdiction', jurisdiction)
  if (dryRun) console.log('\n(dry run) npx ' + args.join(' '))
  else run('npx', args)
}

console.log(
  dryRun
    ? '\nDry run finished: nothing was uploaded.\n'
    : '\n✔ StarLight ' + version + ' is published. Installed copies will find it at their next check.\n'
)
