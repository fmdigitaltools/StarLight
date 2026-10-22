/*
 * Withdraws a faulty StarLight release: puts a previous version back online
 * as the current update.
 *
 *   npm run withdraw -- 0.4.4            restores 0.4.4 in place of the one currently published
 *   npm run withdraw -- 0.4.4 --dry-run   shows what it would do, without touching the server
 *
 * Uses the archive copies of the channel files (latest-0.4.4.yml and the
 * like) that "npm run publish" uploads for every version, and the same
 * environment variables (STARLIGHT_R2_BUCKET, STARLIGHT_R2_PREFIX,
 * STARLIGHT_R2_JURISDICTION, CLOUDFLARE_ACCOUNT_ID or a "wrangler login"
 * already done). Installers are never deleted, so the one for the restored
 * version is still on the server: it is checked anyway before anything is
 * changed.
 *
 * Note: anyone who has already updated to the faulty version stays on it
 * (an update never goes backwards on its own). Withdrawing only stops the
 * distribution; to fix those who already installed it, publish a new
 * version straight away, with a higher number, containing the fix.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const version = args.find((a) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(a))

function stop(message) {
  console.error('\n✖ ' + message + '\n')
  process.exit(1)
}

if (!version) stop('Specify the version to put back online, for example: npm run withdraw -- 0.4.4')

const bucket = process.env.STARLIGHT_R2_BUCKET ?? ''
if (bucket === '') stop('The bucket name is missing: set the STARLIGHT_R2_BUCKET variable.')
const jurisdiction = process.env.STARLIGHT_R2_JURISDICTION ?? ''
let prefix = process.env.STARLIGHT_R2_PREFIX ?? ''
if (prefix !== '' && !prefix.endsWith('/')) prefix += '/'

const versionSource = readFileSync(join(root, 'src/shared/version.ts'), 'utf-8')
const updatesUrl = /UPDATES_URL\s*=\s*'([^']+)'/.exec(versionSource)?.[1] ?? ''

function wrangler(args, quiet = false) {
  const all = ['wrangler', 'r2', 'object', ...args, '--remote']
  if (jurisdiction !== '') all.push('--jurisdiction', jurisdiction)
  if (!quiet) console.log('\n> npx ' + all.join(' '))
  return spawnSync('npx', all, { cwd: root, stdio: quiet ? 'pipe' : 'inherit', shell: true })
}

const tempDir = mkdtempSync(join(tmpdir(), 'starlight-withdraw-'))
try {
  // The archive copies of this version, channel by channel.
  const found = []
  for (const channel of ['latest', 'beta', 'alpha']) {
    const localFile = join(tempDir, channel + '.yml')
    const key = '"' + bucket + '/' + prefix + channel + '-' + version + '.yml"'
    const result = wrangler(['get', key, '--file', '"' + localFile + '"'], true)
    if (result.status === 0 && existsSync(localFile)) found.push({ channel, localFile })
  }
  if (found.length === 0) {
    stop(
      'The archive copy of version ' + version + ' (latest-' + version + '.yml) is not on the server. ' +
        'Copies exist only for versions published with the current script.'
    )
  }

  for (const t of found) {
    const text = readFileSync(t.localFile, 'utf-8')
    const fileVersion = /^version:\s*'?([^'\s]+)'?\s*$/m.exec(text)?.[1]
    if (fileVersion !== version) stop(t.channel + '-' + version + '.yml describes version ' + fileVersion + '.')
    // The installer it points to must still be reachable.
    const installer = /^path:\s*'?([^'\r\n]+?)'?\s*$/m.exec(text)?.[1]
    if (!installer) stop(t.channel + '-' + version + '.yml does not name the installer.')
    if (updatesUrl !== '' && !updatesUrl.includes('…')) {
      const response = await fetch(updatesUrl + installer, { method: 'HEAD' })
      if (!response.ok) stop('The installer ' + installer + ' does not respond from the server (' + response.status + ').')
      console.log('Installer ' + installer + ' reachable.')
    }
  }

  for (const t of found) {
    const args = [
      'put',
      '"' + bucket + '/' + prefix + t.channel + '.yml"',
      '--file',
      '"' + t.localFile + '"',
      '--content-type',
      '"text/yaml; charset=utf-8"',
      '--cache-control',
      '"no-cache"'
    ]
    if (dryRun) console.log('\n(simulation) npx wrangler r2 object ' + args.join(' ') + ' --remote')
    else if (wrangler(args).status !== 0) stop('Uploading ' + t.channel + '.yml failed.')
  }

  console.log(
    dryRun
      ? '\nSimulation finished: nothing was changed.\n'
      : '\n✔ Version ' + version + ' is again the one offered as an update.\n' +
          '  Anyone who had already installed the withdrawn version stays on it: publish as soon as possible\n' +
          '  a new version with the fix and a higher number.\n'
  )
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
