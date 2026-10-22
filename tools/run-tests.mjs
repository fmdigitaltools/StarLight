/*
 * Runs all the automatic checks of StarLight together and reports, at the
 * end, which passed, which failed and which were skipped.
 *
 *   npm run test                     all (the type check plus the checks)
 *   npm run test -- --quick          skips the slow checks
 *   npm run test -- --only curves    only the ones listed (also several names: curves,plugin)
 *   npm run test -- --list           shows the list, without running anything
 *   npm run test -- --verbose        also shows everything each check writes
 *
 * (With npm one can also write "npm run test --quick": npm does not pass
 * the option to the script but puts it in a variable, which is read here.)
 *
 * Environment variables:
 *   STARLIGHT_SKIP_TESTS=1        does nothing and exits successfully (for a quick "npm run dist")
 *   STARLIGHT_TEST_DATA           folder of the test files, with test-data.json (see test-files.mjs)
 *   STARLIGHT_TEST_FORMATS        folder of the format test files (with expected.json)
 *   STARLIGHT_TEST_RAW            folder with a few camera RAW files
 *
 * How it works. Each check is a TypeScript script in tools/ that is
 * compiled with esbuild (as run-test.mjs does, but each on a file of its
 * own, so that several compilations do not step on each other) and run
 * with Node. The verdict is the exit code: 0 passed, 77 skipped (for
 * example no network), anything else failed. Checks that need files that
 * are not part of the distributed project (real shots and test frames,
 * see test-files.mjs) are skipped, not failed, if those files are missing.
 *
 * The checks run one at a time: many already use all the processor cores
 * and the measured times would be meaningless if they overlapped. Only the
 * type check (a separate, light process) runs together with the first one.
 *
 * The measurement tools (which produce numbers or images to look at
 * rather than a yes/no) are not here: the commented list is at the end of
 * the file.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testFile } from './test-files.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

if (process.env.STARLIGHT_SKIP_TESTS === '1') {
  console.log('Checks skipped (STARLIGHT_SKIP_TESTS=1).')
  process.exit(0)
}

/* ---- Options ---- */

const args = process.argv.slice(2)
const isSet = (v) => v !== undefined && v !== '' && v !== 'false'
const KNOWN_OPTIONS = ['--quick', '--verbose', '--list', '--only']
const unknownOptions = args.filter((a) => a.startsWith('--') && !KNOWN_OPTIONS.includes(a))
if (unknownOptions.length > 0) {
  console.log('Unknown options: ' + unknownOptions.join(', '))
  console.log('Available: ' + KNOWN_OPTIONS.join(', '))
  process.exit(2)
}
const quick = args.includes('--quick') || isSet(process.env.npm_config_quick)
const verbose = args.includes('--verbose') || isSet(process.env.npm_config_verbose)
const listOnly = args.includes('--list') || isSet(process.env.npm_config_list)
let only = null
const iOnly = args.indexOf('--only')
if (iOnly >= 0) only = args.slice(iOnly + 1).filter((a) => !a.startsWith('--'))
else if (isSet(process.env.npm_config_only)) {
  // "npm run test --only curves": npm removes "--only" and leaves "curves".
  const v = process.env.npm_config_only
  only = v === 'true' ? args.filter((a) => !a.startsWith('--')) : [v]
}
if (only) only = only.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)

/* ---- Folders ---- */

/** Working folder of this run: compiled files and images produced. */
const work = join(tmpdir(), 'starlight-test-all')
mkdirSync(work, { recursive: true })
const outputFolder = (name) => {
  const c = join(work, 'output', name)
  mkdirSync(c, { recursive: true })
  return c
}

/** Expectations file of a format test folder. */
const expectationsIn = (folder) => (existsSync(join(folder, 'expected.json')) ? join(folder, 'expected.json') : null)

const M27 = testFile('m27')
const M33 = testFile('m33')
const NGC7331 = testFile('ngc7331')
const NGC7000 = testFile('ngc7000')
const STACKED_M27 = testFile('m27-stacked')
const NGC7331_WCS = testFile('ngc7331-wcs')
const M16 = testFile('m16-raw')
/** The synthetic frames from generate-test-fits.mjs (no license issues). */
const TEST_FRAME = testFile('synthetic-frame')
/** Test files of the rare compressions, written by tools/generate-rare-samples.py. */
const RARE_FORMATS = testFile('rare-formats')

/**
 * The checks. For each one:
 *  - name: the one to use with --only (the file is tools/test-<name>.ts);
 *  - what: a line saying what it checks;
 *  - requires: files or folders without which it is skipped;
 *  - args: function returning the arguments to pass
 *    (null = skip it, with the reason in "reason");
 *  - slow: skipped with --quick.
 */
const CHECKS = [
  { name: 'curves', what: 'tone curve: monotonicity, points, edge cases' },
  { name: 'levels', what: 'histogram and curve editor: filter included in the final, true curve input' },
  { name: 'gaia-cache', what: 'shared cache of Gaia stars (fake catalog, no network)' },
  { name: 'performance', what: 'startup choices from the file, settings chosen for the computer, space used by a folder' },
  { name: 'memory', what: 'memory estimate before stacking (fits, fewer workers, stop), reduced texture for the viewer, identical in-place computations' },
  { name: 'catalog-names', what: 'catalog search by name, duplicates merged' },
  { name: 'catalogs', what: 'deep sky catalog packages: fingerprints, licenses, merging with the bundled catalog' },
  { name: 'calibration-library', what: 'calibration library: choice of masters by exposure, gain, temperature and filter; storage in the sensor format' },
  {
    name: 'simulated-calibration',
    what: 'calibration on simulated sensors (color and mono): hot pixels, glow, rows, vignetting, dust, expected noise, library, stacking; groups by exposure, temperature, gain, filter and night, right master for each light, identity with a single group'
  },
  { name: 'plugin', what: 'bundled plugins, isolated sandbox, malicious plugins stopped', requires: [M27] },
  {
    name: 'protection',
    what: 'faulty or malicious plugins and catalogs rejected with the right message (archives, manifests, code, images, execution, objects, stars, startup), bundled and published ones accepted, sandbox in Electron'
  },
  { name: 'geometry', what: 'plugins that move pixels carry the astrometric solution with them', requires: [M27] },
  { name: 'dragged-crop', what: 'crop box dragged in the viewer: move, handles, imposed shape, always inside the image' },
  { name: 'framing-geometry', what: 'the export crop follows plugin rotations and flips, also with Undo' },
  { name: 'project', what: '.slight project: round trip, old or damaged files', requires: [M27] },
  { name: 'project-result', what: 'mosaic and drizzle saved in the project and reopened', requires: [M27] },
  { name: 'project-solution', what: 'astrometric solution saved in the project', requires: [M27] },
  { name: 'fits-wcs', what: 'FITS export with crop and resizing keeps the WCS', requires: [M27] },
  { name: 'field-scale', what: 'pixel scale and framed field', requires: [M27, NGC7331, STACKED_M27] },
  { name: 'crowding', what: 'marker anti-crowding filter', requires: [M27, M33, NGC7331] },
  { name: 'languages', what: 'language files: same keys and placeholders in Italian and English, keys used in the code exist, fallback mechanism' },
  { name: 'coordinates', what: 'coordinate grid, orientation and scale bar on rotated and mirrored fields, at the pole and at 0h' },
  { name: 'wcs', what: 'WCS reading, pixel-sky round trip, NGC 7331 at the center', requires: [NGC7331_WCS] },
  { name: 'markers-wcs', what: 'recognition with WCS (smoke test: fails only if it hangs)', requires: [NGC7331_WCS] },
  { name: 'export-markers', what: 'markers in the export (smoke test)', requires: [NGC7331_WCS] },
  { name: 'caption', what: 'export caption: entries only from the data present, display formats yes and FITS no, proportional sizes' },
  { name: 'core', what: 'reading, color, statistics and stretch of a frame (smoke test)', requires: [TEST_FRAME] },
  { name: 'stacking', what: 'stars, alignment and stacking of the test frames', requires: [TEST_FRAME], args: () => [testFile('synthetic-frames')] },
  { name: 'nights', what: 'several nights: recognition from the date, quality per night, weights, normalization without a step, identity with a single night' },
  { name: 'hdr', what: 'HDR merge of different exposures: series per exposure, measured ratio, saturated core rebuilt, faint areas intact' },
  { name: 'hazy', what: 'stars found and alignment on a hazy frame, no hot pixels or fake stars', requires: [TEST_FRAME], args: () => [testFile('synthetic-frames')] },
  {
    // Slow by design: it writes in chunks with pauses and waits for a nonexistent network folder to fail.
    name: 'watcher', what: 'watched folder with slow chunked writing',
    requires: [TEST_FRAME], args: () => [testFile('synthetic-frames')], slow: true
  },
  { name: 'export', what: 'TIFF, BMP, FITS export: round trip', requires: [STACKED_M27] },
  { name: 'background', what: 'sky background removal: reversible, viewer equal to the export', requires: [STACKED_M27] },
  { name: 'vibrance', what: 'vibrance and vignette: sum with the filter, viewer equal to the export', requires: [STACKED_M27] },
  {
    name: 'bands', what: 'banded stacking identical to the whole computation (plus the speedup measurement)',
    requires: [TEST_FRAME], args: () => [testFile('synthetic-frames')], slow: true
  },
  {
    name: 'trails', what: 'whole satellite trails: found and rebuilt, edge-on galaxy and filament left alone',
    requires: [M33], slow: true, args: () => [M33, outputFolder('trails')]
  },
  {
    name: 'partial-trails', what: 'partial, dashed, double and faint trails; no false positives; catalog zones',
    requires: [M33], slow: true, args: () => [M33, outputFolder('partial-trails')]
  },
  {
    // Without arguments it tests all the .fit files of the stacked test images, at three sensitivities.
    name: 'clean-trails', what: 'no trail found on the shots without trails', requires: [M27], slow: true
  },
  { name: 'abracadabra', what: 'Abracadabra on synthetic stacks: core not burned out, background not black, noisy edge cropped, no rings; already stretched data without crescents; wedges equalized without dark disks around bright stars; wedges outside the crop around small objects' },
  { name: 'ghs', what: 'hyperbolic stretch: numerical checks and test on the shots', requires: [M27, M33, NGC7000], slow: true },
  {
    name: 'solver', what: 'field solving compared with the header solution (needs the network the first time)',
    requires: [M27, M33], slow: true, args: () => ['--folder', outputFolder('solver')]
  },
  {
    // The star package is prepared with "npm run prepare-catalogs" (see that tool); without it, the check is skipped.
    name: 'local-stars',
    what: 'field solving with the local stars (UCAC4): package, cone search, comparison with the WCS, narrow field, internet off',
    slow: true,
    args: () =>
      existsSync('dist-catalogs') && readdirSync('dist-catalogs').some((f) => /^ucac4-stars-.*\.zip$/.test(f)) ? [] : null,
    reason: 'the UCAC4 star package is missing in dist-catalogs (prepared by npm run prepare-catalogs)'
  },
  {
    name: 'formats', what: 'compressed FITS, XISF, TIFF, PNG against the source FITS',
    requires: [M27, M16], slow: true,
    args: () => {
      const c = process.env.STARLIGHT_TEST_FORMATS
      return c && expectationsIn(c) ? [c] : null
    },
    reason: 'the format test folder is missing (variable STARLIGHT_TEST_FORMATS, with expected.json)'
  },
  {
    name: 'rare-formats', what: 'HCOMPRESS, PLIO, XISF with Zstandard and other codecs against astropy and the xisf package',
    args: () => (expectationsIn(RARE_FORMATS) ? [RARE_FORMATS] : null),
    reason: 'the rare format files are missing (written by tools/generate-rare-samples.py)'
  },
  {
    name: 'raw', what: 'camera RAW reader', slow: true,
    args: () => {
      const c = process.env.STARLIGHT_TEST_RAW
      return c && existsSync(c) ? [c, outputFolder('raw')] : null
    },
    reason: 'the RAW folder is missing (variable STARLIGHT_TEST_RAW)'
  }
]

/* ---- Running ---- */

function seconds(ms) {
  return ms < 1000 ? ms.toFixed(0) + ' ms' : (ms / 1000).toFixed(1) + ' s'
}

/** Runs a command, collects what it writes and measures the time. */
function run(command, commandArgs, { show = false, limit = 30 * 60 * 1000 } = {}) {
  return new Promise((done) => {
    const start = performance.now()
    const child = spawn(command, commandArgs, { cwd: root, env: process.env })
    let text = ''
    const collect = (d) => {
      text += d
      if (text.length > 2_000_000) text = text.slice(-1_000_000)
      if (show) process.stdout.write(d)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      text += '\n[stopped: over ' + seconds(limit) + ']'
      child.kill()
    }, limit)
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ code: -1, text: text + '\n' + e.message, ms: performance.now() - start })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? -1, text, ms: performance.now() - start })
    })
  })
}

/** Compiles a check with esbuild into a file of its own. */
async function compile(name) {
  const esbuild = await import('esbuild')
  const output = join(work, 'test-' + name + '.mjs')
  await esbuild.build({
    entryPoints: [join('tools', 'test-' + name + '.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@shared': './src/shared', '@core': './src/core' },
    outfile: output,
    logLevel: 'silent',
    // Some dependencies (LibRaw) are CommonJS and use require.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
  })
  return output
}

const lastLines = (text, n = 15) =>
  text.replace(/\s+$/, '').split(/\r?\n/).slice(-n).map((r) => '      ' + r).join('\n')

async function main() {
  const unknown = (only ?? []).filter((s) => s !== 'types' && !CHECKS.some((v) => v.name === s))
  if (unknown.length > 0) {
    console.log('Unknown checks: ' + unknown.join(', '))
    console.log('Available: types, ' + CHECKS.map((v) => v.name).join(', '))
    process.exit(2)
  }

  if (listOnly) {
    console.log('types'.padEnd(24) + 'TypeScript type check (npm run typecheck)')
    for (const v of CHECKS) {
      console.log(v.name.padEnd(24) + v.what + (v.slow ? '  [slow]' : ''))
    }
    return
  }

  const chosen = CHECKS.filter((v) => !only || only.includes(v.name))
  const withTypes = !only || only.includes('types')
  console.log(
    'StarLight: checks' + (quick ? ' (quick)' : '') + (only ? ' (only ' + only.join(', ') + ')' : '') + '\n'
  )

  /** Outcomes: { name, state: 'passed'|'failed'|'skipped', ms, note, tail } */
  const outcomes = []
  const print = (e) => {
    const label = { passed: 'PASSED', failed: 'FAILED', skipped: 'skipped' }[e.state]
    console.log(
      '  ' + label.padEnd(9) + e.name.padEnd(24) + (e.ms !== null ? seconds(e.ms).padStart(9) : ''.padStart(9)) +
        (e.note ? '   ' + e.note : '')
    )
  }

  // The type check starts right away, in a separate process.
  const types = withTypes
    ? run(process.execPath, [join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'])
    : null

  for (const v of chosen) {
    if (quick && v.slow) {
      outcomes.push({ name: v.name, state: 'skipped', ms: null, note: 'slow (--quick)' })
      print(outcomes.at(-1))
      continue
    }
    const missing = (v.requires ?? []).filter((f) => !existsSync(f))
    if (missing.length > 0) {
      outcomes.push({ name: v.name, state: 'skipped', ms: null, note: 'missing ' + missing.join(', ') })
      print(outcomes.at(-1))
      continue
    }
    const checkArgs = v.args ? v.args() : []
    if (checkArgs === null) {
      outcomes.push({ name: v.name, state: 'skipped', ms: null, note: v.reason })
      print(outcomes.at(-1))
      continue
    }
    let file
    try {
      file = await compile(v.name)
    } catch (e) {
      outcomes.push({ name: v.name, state: 'failed', ms: null, note: 'does not compile', tail: lastLines(String(e.message ?? e)) })
      print(outcomes.at(-1))
      continue
    }
    if (verbose) console.log('\n----- ' + v.name + ' -----')
    const r = await run(process.execPath, [file, ...checkArgs], { show: verbose })
    if (verbose) console.log('----- end ' + v.name + ' -----\n')
    const state = r.code === 0 ? 'passed' : r.code === 77 ? 'skipped' : 'failed'
    const note =
      state === 'failed' ? 'exit code ' + r.code : state === 'skipped' ? 'the check says it cannot be tested here' : ''
    outcomes.push({ name: v.name, state, ms: r.ms, note, tail: state !== 'passed' ? lastLines(r.text) : undefined })
    print(outcomes.at(-1))
  }

  if (types) {
    const r = await types
    const errors = (r.text.match(/error TS\d+/g) ?? []).length
    outcomes.unshift({
      name: 'types',
      state: r.code === 0 ? 'passed' : 'failed',
      ms: r.ms,
      note: r.code === 0 ? '' : errors + ' type errors',
      tail: r.code === 0 ? undefined : lastLines(r.text, 25)
    })
    print(outcomes[0])
  }

  /* ---- Summary ---- */
  const passed = outcomes.filter((e) => e.state === 'passed')
  const failed = outcomes.filter((e) => e.state === 'failed')
  const skipped = outcomes.filter((e) => e.state === 'skipped')
  const total = outcomes.reduce((a, e) => a + (e.ms ?? 0), 0)

  console.log('\n================ SUMMARY ================')
  console.log('Passed: ' + passed.length + '   Failed: ' + failed.length + '   Skipped: ' + skipped.length)
  console.log('Total time: ' + seconds(total))
  if (skipped.length > 0) {
    console.log('\nSkipped:')
    for (const e of skipped) console.log('  ' + e.name.padEnd(24) + e.note)
  }
  if (failed.length > 0) {
    console.log('\nFailed (last lines of each; to see everything: --only <name> --verbose):')
    for (const e of failed) {
      console.log('\n  ' + e.name + ' (' + e.note + ')')
      if (e.tail) console.log(e.tail)
    }
    console.log('\nSOMETHING IS WRONG: ' + failed.length + ' checks failed.')
    process.exitCode = 1
  } else {
    console.log('\nAll good.')
  }
  console.log('Compiled files and images produced in ' + work)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

/*
 * ---- The other tools in tools/, which are not included here ----
 *
 * Measurement or by-eye comparison tools (numbers and images to look at,
 * no yes/no; almost all of them need arguments; run them with run-test.mjs):
 *   test-analysis.ts          times and memory of analysis and integration (long)
 *   test-narrowband.ts        HOO palette, before/after images
 *   test-local-contrast.ts    local contrast, images
 *   test-deconvolution.ts     deconvolution, images and times
 *   test-rbf-background.ts    radial basis function background, images
 *   test-photometry.ts        color calibration with Gaia (network), images
 *   test-markers.ts           comparison of recognition with and without dimensions
 *   test-thumbnails.ts        library thumbnails, times and PNG
 *   test-wavelets.ts          wavelets, images
 *   test-star-reduction.ts    star reduction, images
 *   try-abracadabra.ts        Abracadabra as in the app on all the stacks: before/after PNG and measurements
 *   try-real-stacking.ts      complete stacking of a series of real raw frames (about 10 GB for 120 frames)
 *   measure-sensors.ts        memory and times of stacking with large simulated sensors
 *   analyze-distribution.ts, diagnostics.ts, inspect-header.ts
 *                             diagnosis of a single file
 *
 * Work tools (not checks): generate-*.mjs, generate-plugin-previews.ts,
 * generate-rare-samples.py, update-attribution.mjs, draw-icon.mjs, crop.mjs,
 * publish.mjs, run-test.mjs, plugin-node.ts (helper for the plugin checks),
 * simulate-sensor.ts (simulated sensor for the calibration tests),
 * generate-simulated-calibration.ts (writes the simulated frames among the test files),
 * updates-worker.js (the Cloudflare Worker).
 */
