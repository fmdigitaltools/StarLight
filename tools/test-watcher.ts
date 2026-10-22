/**
 * Check of the watched folder (main process part).
 *
 * Copies the test frames one at a time into a temporary folder, writing
 * them in chunks with pauses in between to imitate a slow write (also over
 * a network), and checks that each frame is reported exactly once and only
 * when complete. It also tests a file already present at startup, a write
 * pause longer than the stability wait, a file that is not FITS, and the
 * scan-only mode used for network shares.
 *
 * Usage: TEST_SCRIPT=tools/test-watcher.ts node tools/run-test.mjs [folder]
 * or compiling with esbuild to a dedicated output file.
 * With a second argument (UNC path of a writable temporary folder,
 * e.g. \127.0.0.1\C$\Temp\test) the test is repeated over the network.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Watcher } from '../src/main/watcher'
import type { WatcherEvent } from '../src/shared/watcher'
import { testFile } from './test-files.mjs'

const source = process.argv[2] ?? testFile('synthetic-frames')
const networkFolder = process.argv[3]
const frame = readdirSync(source)
  .filter((f) => f.toLowerCase().endsWith('.fit'))
  .sort()

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let errors = 0
function check(condition: boolean, text: string): void {
  console.log((condition ? '  ok      ' : '  ERROR   ') + text)
  if (!condition) errors++
}

/** Writes a file in `pieces` parts, with a pause after each one. */
async function writeInChunks(
  destination: string,
  data: Buffer,
  pieces: number,
  pauseMs: number,
  longPauseAfter = -1,
  longPauseMs = 0
): Promise<void> {
  const file = await open(destination, 'w')
  try {
    const step = Math.ceil(data.length / pieces)
    for (let i = 0; i < pieces; i++) {
      await file.write(data, i * step, Math.min(step, data.length - i * step), i * step)
      await file.sync()
      await wait(i === longPauseAfter ? longPauseMs : pauseMs)
    }
  } finally {
    await file.close()
  }
}

async function test(folder: string, onlyScan: boolean): Promise<void> {
  console.log('\n--- ' + folder + (onlyScan ? ' (scan only, as over a network)' : ' (notifications + scan)') + ' ---')
  const completedItems = new Map<string, number>()
  const reports: { name: string; when: number; size: number }[] = []
  const unreadableFiles: string[] = []
  const start = Date.now()

  // One frame is already in the folder before startup.
  const first = readFileSync(join(source, frame[0]))
  writeFileSync(join(folder, frame[0]), first)
  completedItems.set(frame[0], Date.now())

  const watcher = new Watcher(
    folder,
    (e: WatcherEvent) => {
      if (e.type === 'ready') {
        reports.push({ name: e.fileName, when: Date.now(), size: e.size })
        console.log('  [' + ((Date.now() - start) / 1000).toFixed(1) + ' s] ready: ' + e.fileName)
      } else if (e.type === 'unreadable') {
        unreadableFiles.push(e.fileName)
        console.log('  unreadable: ' + e.fileName + ' (' + e.reason + ')')
      }
    },
    { stabilityMs: 800, scanIntervalMs: 600, checkIntervalMs: 200, maxWaitMs: 4000, onlyScan }
  )
  const result = await watcher.start()
  check(result.ok, 'startup succeeded, mode ' + result.mode)

  for (let i = 1; i < frame.length; i++) {
    const data = readFileSync(join(source, frame[i]))
    const destination = join(folder, frame[i])
    // The third frame stops halfway for 2 seconds, longer than the stability
    // wait: it must still be waited for, because the header declares more data.
    if (i === 2) await writeInChunks(destination, data, 10, 150, 4, 2000)
    else await writeInChunks(destination, data, 8, 250)
    completedItems.set(frame[i], Date.now())
    await wait(300)
  }

  // A file with a FITS name that is not a FITS.
  writeFileSync(join(folder, 'corrupt.fit'), Buffer.alloc(5760, 65))
  // A truncated, never finished FITS: it must be reported only after the maximum wait.
  writeFileSync(join(folder, 'truncated.fit'), first.subarray(0, Math.floor(first.length / 2)))

  await wait(6000)
  watcher.stop()

  for (const name of frame) {
    const times = reports.filter((s) => s.name === name)
    check(times.length === 1, name + ' reported ' + times.length + ' time(s)')
    if (times.length > 0) {
      const finished = completedItems.get(name) ?? 0
      check(times[0].when >= finished, '  reported only after the write finished')
      check(times[0].size === first.length, '  full size (' + times[0].size + ' bytes)')
    }
  }
  check(unreadableFiles.includes('corrupt.fit'), 'the non-FITS file is reported as unreadable')
  check(unreadableFiles.includes('truncated.fit'), 'the truncated file is reported as unreadable after the wait')
  check(!reports.some((s) => s.name === 'truncated.fit' || s.name === 'corrupt.fit'), 'no broken file reported as ready')
}

async function main(): Promise<void> {
  const locale = mkdtempSync(join(tmpdir(), 'starlight-watcher-'))
  try {
    await test(locale, false)
  } finally {
    rmSync(locale, { recursive: true, force: true })
  }
  const locale2 = mkdtempSync(join(tmpdir(), 'starlight-watcher-'))
  try {
    await test(locale2, true)
  } finally {
    rmSync(locale2, { recursive: true, force: true })
  }
  if (networkFolder) {
    mkdirSync(networkFolder, { recursive: true })
    try {
      await test(networkFolder, false)
    } finally {
      rmSync(networkFolder, { recursive: true, force: true })
    }
  }

  // Nonexistent folder: it must fail with an understandable sentence.
  const absent = await new Watcher('\\\\192.0.2.1\\EMMC Images\\MyWorks\\M 27', () => {}).start()
  console.log('\nMissing network folder: ' + absent.message)
  check(!absent.ok, 'an unreachable folder does not start the watcher')

  console.log(errors === 0 ? '\nAll good.' : '\n' + errors + ' checks failed.')
  process.exit(errors === 0 ? 0 : 1)
}

void main()
