/*
 * Publishes a new StarLight version: uploads it to R2 for automatic updates
 * and creates the GitHub release with the installer, for first downloads.
 *
 *   npm run publish                  builds the installer, uploads it to R2 and creates the release
 *   npm run publish -- --dry-run     builds and shows what it would do, without uploading
 *   npm run publish -- --skip-build  publishes the files already present in dist-build
 *   npm run publish -- --folder=DIR  takes the files from DIR instead of dist-build
 *
 * Published versions are built on GitHub Actions (.github/workflows/build.yml):
 * download the run's artifact into a folder and use --skip-build --folder=DIR.
 * The artifact contains build-commit.txt, the commit the installer was built
 * from: the release tag is placed exactly there.
 *
 * Environment variables:
 *   STARLIGHT_R2_BUCKET        name of the R2 bucket (required, except with --dry-run)
 *   STARLIGHT_R2_PREFIX        folder inside the bucket, for example "starlight/" (optional)
 *   STARLIGHT_R2_JURISDICTION  "eu" if the bucket is under European jurisdiction (optional)
 *   CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or a "wrangler login" already done
 * The GitHub CLI (gh) must be logged in to the account that owns the repository.
 *
 * Upload order: first the installer and its blockmap, last latest.yml.
 * Anyone checking for updates mid-upload still finds the old latest.yml,
 * which points to a complete installer, and never a new latest.yml pointing
 * to a file that has not arrived yet. The GitHub release comes after R2:
 * rerunning the script after a failure overwrites the R2 files and adds the
 * installer to the release if it already exists.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const address = /UPDATES_URL\s*=\s*'([^']+)'/.exec(versionText)?.[1] ?? ''
const codename = /APP_CODENAME\s*=\s*'([^']+)'/.exec(versionText)?.[1] ?? ''

if (appVersion !== version) {
  stop(
    'The version in package.json (' + version + ') and APP_VERSION in src/shared/version.ts (' +
      appVersion + ') do not match. Fix them before publishing.'
  )
}
if (address.includes('…') || address === '') {
  const text =
    'UPDATES_URL in src/shared/version.ts is still the placeholder: the published version would not ' +
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

/* ---- GitHub release: checked before uploading anything ---- */

const tag = 'v' + version
// The commit the installer was built from: written by the GitHub build, else the local one.
const commitFile = join(folder, 'build-commit.txt')
const commit = existsSync(commitFile)
  ? readFileSync(commitFile, 'utf-8').trim()
  : spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
if (!/^[0-9a-f]{40}$/.test(commit)) stop('Could not tell which commit the installer was built from.')

if (!dryRun) {
  if (spawnSync('gh', ['auth', 'status'], { cwd: root, stdio: 'ignore', shell: true }).status !== 0) {
    stop('The GitHub CLI is not logged in: run "gh auth login" and retry.')
  }
  // The tag goes on this commit: GitHub must already have it, otherwise the
  // release would point to code nobody can see.
  const known = spawnSync('gh', ['api', 'repos/{owner}/{repo}/commits/' + commit, '--silent'], { cwd: root, stdio: 'ignore', shell: true })
  if (known.status !== 0) stop('Commit ' + commit + ' is not on GitHub: push it before publishing.')
}

/** Release page text: the release notes, English first, then Italian. */
function releaseBody() {
  const path = join(root, 'resources/release-notes.md')
  const notes = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  const section = (language) =>
    (new RegExp('<!-- lang:' + language + ' -->([\\s\\S]*?)(?=<!-- lang:|$)').exec(notes)?.[1] ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => '- ' + line)
      .join('\n')
  return [
    "## What's new",
    section('en'),
    '## Novità',
    section('it'),
    '---',
    // Relative links do not work on release pages: full address of the file in the tagged version.
    'Download **' + installerName + '** below and run it. Full history in [CHANGELOG.md](' + changelogUrl + ').',
    'Scarica **' + installerName + '** qui sotto e avvialo. Storia completa in [CHANGELOG.md](' + changelogUrl + ').'
  ].join('\n\n') + '\n'
}

// All the channel files name the same installer: only that one goes in the release.
const installerName = [...installers][0]
const installerList = [...installers].map((name) => join(folder, name))
const repositoryUrl = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
  .stdout.trim()
  .replace(/\.git$/, '')
const changelogUrl = repositoryUrl + '/blob/' + tag + '/CHANGELOG.md'
const releaseTitle = 'StarLight ' + version + (codename ? ' «' + codename + '»' : '')
const notesFile = join(tmpdir(), 'starlight-release-' + version + '.md')
writeFileSync(notesFile, releaseBody())
console.log('\nGitHub release ' + tag + ' «' + releaseTitle + '» on commit ' + commit + ', with:')
for (const file of installerList) console.log('  ' + file)

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

/* ---- GitHub release ---- */

const quoted = installerList.map((file) => '"' + file + '"')
const exists = !dryRun && spawnSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore', shell: true }).status === 0
// Rerun after a failure: the release is already there, only the installer is replaced.
const releaseArgs = exists
  ? ['release', 'upload', tag, ...quoted, '--clobber']
  : [
      'release', 'create', tag, ...quoted,
      '--target', commit,
      '--title', '"' + releaseTitle + '"',
      '--notes-file', '"' + notesFile + '"',
      // Versions with a pre-release tag (1.0.0-beta.1) are not offered as the latest stable one.
      ...(version.includes('-') ? ['--prerelease'] : [])
    ]
if (dryRun) {
  console.log('\n(dry run) gh ' + releaseArgs.join(' '))
  console.log('\nRelease text (' + notesFile + '):\n\n' + readFileSync(notesFile, 'utf-8'))
} else {
  run('gh', releaseArgs)
}

console.log(
  dryRun
    ? '\nDry run finished: nothing was uploaded.\n'
    : '\n✔ StarLight ' + version + ' is published: installed copies will find it at their next check, ' +
        'and the installer is on the GitHub release ' + tag + '.\n'
)
