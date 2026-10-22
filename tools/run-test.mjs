/**
 * Compiles and runs a single test or tool script without an external bundler.
 *
 *   $env:TEST_SCRIPT='tools/test-curves.ts'; node tools/run-test.mjs [arguments of the script]
 *
 * Without TEST_SCRIPT it runs tools/test-core.ts.
 */
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const esbuild = join('node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
const out = join(tmpdir(), 'starlight-test.mjs')

execFileSync(
  esbuild,
  [
    process.env.TEST_SCRIPT ?? 'tools/test-core.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--alias:@shared=./src/shared',
    '--alias:@core=./src/core',
    '--outfile=' + out
  ],
  { stdio: 'inherit' }
)

execFileSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' })
