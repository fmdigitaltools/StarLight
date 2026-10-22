# Running the tests

StarLight has a set of automatic checks in `tools/`. Each check is a TypeScript script (`tools/test-<name>.ts`) that is
compiled with esbuild and run with Node; its exit code is the verdict: `0` passed, `77` skipped (for example when the
network is not available), anything else failed.

## All the checks

```
npm run test                      type check plus all the checks
npm run test -- --quick           skips the slow checks (this is what npm run dist runs)
npm run test -- --list            lists the checks, with a line on what each one verifies
npm run test -- --only curves     runs only the named checks (several: --only curves,plugin)
npm run test -- --verbose         also prints everything each check writes
```

The name `types` stands for the TypeScript type check (`npm run typecheck`) and can be used with `--only` like the
others. The checks run one at a time, because many of them already use all the processor cores. At the end a summary
lists the checks that passed, failed and were skipped, with the reason for each skip and the last lines written by
each failed check. Compiled files and the images produced are left in the `starlight-test-all` folder of the system
temporary directory.

Setting `STARLIGHT_SKIP_TESTS=1` makes `npm run test` exit successfully without running anything (useful for a quick
`npm run dist` during development).

## A single script

Any script in `tools/`, including the measurement tools that are not part of `npm run test`, can be compiled and run
on its own:

```powershell
$env:TEST_SCRIPT = 'tools/test-curves.ts'; node tools/run-test.mjs [arguments of the script]
```

Without `TEST_SCRIPT`, `tools/run-test.mjs` runs `tools/test-core.ts`. The usage of each script, with its arguments
and options, is described in the comment at the top of the file.

## Synthetic data and real shots

Most checks build their own synthetic images in memory and need nothing else: for example `curves`, `levels`,
`memory`, `simulated-calibration`, `nights`, `hdr`, `abracadabra`, `coordinates`, `caption`, `languages`,
`protection`. The others need files that are not part of the project:

| Data | Checks | Where it comes from |
|---|---|---|
| Real stacked shots (FITS) | `plugin`, `geometry`, `project`, `project-result`, `project-solution`, `fits-wcs`, `field-scale`, `crowding`, `wcs`, `markers-wcs`, `export-markers`, `export`, `background`, `vibrance`, `trails`, `partial-trails`, `clean-trails`, `ghs`, `solver` | own shots, listed in the test data folder |
| Synthetic test frames | `core`, `stacking`, `hazy`, `watcher`, `bands` | written by `node tools/generate-test-fits.mjs` |
| Rare compressions (HCOMPRESS, PLIO, XISF codecs) | `rare-formats` | written by `tools/generate-rare-samples.py` (Python with astropy and the xisf package) |
| Compressed versions of the real shots | `formats` | a folder indicated by `STARLIGHT_TEST_FORMATS`, with `expected.json` |
| Camera RAW files | `raw` | a folder indicated by `STARLIGHT_TEST_RAW` |
| Local star package (UCAC4) | `local-stars` | prepared with `npm run prepare-catalogs` in `dist-catalogs` |

`solver` also needs the network the first time, to download the Gaia stars; without the network it is skipped.

**When the data of a check is missing, the check is skipped, not failed**: the summary lists it among the skipped ones
with the missing file or variable. A clone of the repository without any test data therefore runs only the synthetic
checks, and they must all pass.

## Indicating a folder with own shots

The environment variable `STARLIGHT_TEST_DATA` points to a folder with the test files. The folder contains a
`test-data.json` file that maps each role used by the checks to the path of a file or folder, relative to the
folder itself:

```json
{
  "m27": "shots/M27_stacked.fit",
  "m33": "shots/M33_stacked.fit",
  "ngc7331": "shots/NGC7331_stacked.fit",
  "ngc7000": "shots/NGC7000_stacked.fit",
  "m27-stacked": "shots/M27_drizzle.fit",
  "ngc7331-wcs": "shots/NGC7331_with_wcs.fit",
  "m16-raw": "shots/M16_single_frame.fit",
  "stacks": "shots",
  "synthetic-frames": "frames",
  "synthetic-frame": "frames/Light_M42_10.0s_IRCUT_0001.fit",
  "rare-formats": "rare-formats",
  "simulated-calibration": "simulated-calibration",
  "samples": "samples",
  "preview-crops": "preview-crops.json"
}
```

A role that is not listed resolves to a file or folder with the same name as the role inside the test data folder.
The shots used for a role should be real stacked images of that object with the usual header keywords (exposure,
focal length, pixel size); `ngc7331-wcs` must carry an astrometric solution in the header, `m16-raw` is a single,
not stacked frame, and `stacks` is a folder of stacked `.fit` images.

In PowerShell, for the current session:

```powershell
$env:STARLIGHT_TEST_DATA = 'D:\StarLight test data'
npm run test
```

To keep it for the following sessions, the variable can be set among the user environment variables of Windows
(System, Advanced system settings, Environment Variables), or with:

```powershell
[Environment]::SetEnvironmentVariable('STARLIGHT_TEST_DATA', 'D:\StarLight test data', 'User')
```
