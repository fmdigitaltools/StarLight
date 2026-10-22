/**
 * Writes to disk a simulated session (tools/simulate-sensor.ts) to be
 * dragged into StarLight to try out calibration by eye: lights, darks,
 * flats and biases of a color sensor, plus a set of darks shot at a
 * different temperature to test the choice in the library, and a session
 * with several groups of conditions together (groups folder) to test the
 * automatic grouping of the Calibrate panel.
 *
 *   $env:TEST_SCRIPT='tools/generate-simulated-calibration.ts'; node tools/run-test.mjs [folder] [--only-groups]
 *
 * With --only-groups only the groups folder is written (and the README
 * file): the others are identical on every run.
 *
 * The default folder is the role "simulated-calibration" among the test files (see
 * test-files.mjs). The README.txt explaining what to look at is written next to them.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COLOR_SENSOR, createScene, createSensor, fitsFile, sessionPlan, sessionToGroups } from './simulate-sensor'
import { testFile } from './test-files.mjs'

const args = process.argv.slice(2)
const onlyGroups = args.includes('--only-groups')
const folder = args.find((a) => !a.startsWith('--')) ?? testFile('simulated-calibration')
const p = COLOR_SENSOR
const s = createSensor(p)
const scene = createScene(p.width, p.height)
const plane = sessionPlan(s, scene, {
  lights: 12,
  dark: 10,
  flat: 10,
  bias: 20,
  darkOtherTemperature: 6,
  lightExposure: 60,
  temperature: 18,
  temperatureDeviation: 8,
  flatExposure: 1.5,
  filter: 'LP',
  start: Date.parse('2026-10-12T20:00:00Z'),
  dithering: 6,
  seed: 11
})

const session = join(folder, 'session')
const other = join(folder, 'dark-26C')
mkdirSync(session, { recursive: true })
mkdirSync(other, { recursive: true })
const groups = join(folder, 'groups')
mkdirSync(groups, { recursive: true })

const t0 = performance.now()
let byte = 0
let writtenFiles = 0
if (!onlyGroups) {
  for (const f of plane) {
    const where = /C_\d+\.fit$/.test(f.name) ? other : session
    const file = fitsFile(s, f.produce(), f.data)
    writeFileSync(join(where, f.name), file)
    byte += file.length
    writtenFiles++
  }
}
for (const f of sessionToGroups(s, scene, { lights: 4, lightsWithoutDark: 3 })) {
  const file = fitsFile(s, f.produce(), f.data)
  writeFileSync(join(groups, f.name), file)
  byte += file.length
  writtenFiles++
}

const readme = `StarLight - simulated frames to try out calibration
===================================================

These are not real shots: tools/generate-simulated-calibration.ts produces
them with a simulated sensor (tools/simulate-sensor.ts) that has the
defects of a real sensor, each one known. They serve to see calibration at
work until real darks, flats and biases are available. The final test
remains the one with users' frames.

Test files: they are not part of the distributed project.

The sensor
----------
Color sensor ${p.width} x ${p.height}, Bayer pattern ${p.bayer}, 16 bit, gain ${p.setGain},
offset ${p.configuredOffset}, ${p.electronsPerAdu} electrons per ADU, read noise ${p.readNoise} e-.
Instrument: "${p.instrument}", LP filter, 18 degrees.

Simulated defects:
- bias level (${p.biasLevel} ADU) with a slight fixed pattern of rows and columns;
- dark current that doubles every ${p.doublingDegrees} degrees, with ${s.hotPixels.length} hot pixels
  (some very hot, some saturated);
- amplifier glow in the top right corner;
- non-uniform pixel response (about ${Math.round(p.prnu * 100)} %);
- vignetting: about ${Math.round(p.vignette * 100)} % less light in the corners;
- ${s.dusts.length} donut-shaped dust shadows (dark rings 25-80 pixels in diameter);
- cosmic rays in the lights and in the darks.
The sky has a gradient (brighter on the right), about ${scene.stars.length} stars and a red
nebula with a brighter core, slightly left of center. From one light to the
next the sky shifts by a few pixels (dithering).

Contents
--------
session/   12 lights of 60 s, 10 darks of 60 s at the same temperature, 10 flats
            of 1.5 s (about 42 % of the dynamic range), 20 biases.
dark-26C/   6 darks of 60 s shot at 26 degrees instead of 18: they serve for the
            library test. If you drag them in together with the session, the
            Calibrate panel puts them in a group of their own and the lights
            at 18 degrees keep using the dark at 18 degrees.
groups/     a session with several conditions together, for test 3: two
            nights (October 12 and 14), darks of three exposures and two
            temperatures, biases of two gains, flats of two filters, lights
            of three exposures.

Test 1: with and without calibration
------------------------------------
1. Drag the "session" folder into StarLight.
2. In the Calibrate panel press "Build all masters": it builds bias, dark
   and flat in this order (the flat is corrected with the bias, which must
   already exist). The dark should report a few thousand defective pixels.
3. Stack with calibration turned off and look at the stretched result:
   - hot pixels: scattered colored dots (with dithering stacking already
     removes many of them, but in a single light they are all visible);
   - bright glow in the top right corner;
   - darker corners (vignetting);
   - five dark donuts (the dust shadows);
   - background colors slightly different between center and edges.
4. Stack again with calibration turned on: hot pixels, glow, vignetting
   and donuts must disappear. The background stays brighter on the
   right: that is the sky gradient, which calibration does not touch (it is
   removed by sky background extraction).

Test 2: the library picks the right dark
----------------------------------------
1. After test 1 the masters are in the calibration library.
2. Close the project (the session masters are cleared, the library ones
   remain), drag in only the "dark-26C" folder and build the dark master:
   it enters the library next to the one at 18 degrees.
3. Close the project again, drag in only the lights (Light_*.fit) and
   stack with calibration turned on. The notice must say that the dark at
   18 degrees and the LP flat were used from the library, not the dark at
   26 degrees (8 degrees warmer, outside the tolerance of 3 degrees). The
   library reuse setting must be on, as it is at the start.
4. If the library held only the dark at 26 degrees, StarLight would not
   use it: it would calibrate with bias and flat, and stacking would
   remove the hot pixels thanks to dithering. The glow in the corner and a
   slightly higher background would remain, however. Using it anyway would
   be worse: it would subtract 2.5 times the thermal signal, with a
   background that is too dark, the glow corner zeroed and thousands of
   black pixels.

Test 3: several groups of conditions in the same session
--------------------------------------------------------
"groups" folder: everything together, as happens when several series are
shot and all the calibration files are loaded.
  dark   5 of 60 s at 18 degrees, 1 of 60.3 s at 18 degrees, 5 of 60 s at 26 degrees,
         5 of 30 s at 18 degrees, 3 of 1.5 s (darks of the LP flats),
         only 1 of 60 s at 22 degrees (to be excluded);
  bias   5 at gain 100, 3 at gain 200;
  flat   5 LP of 1.5 s on the night of the 12th, 5 Ha of 4 s on the night of the 14th;
  light  4 LP of 60 s and 4 LP of 30 s at 18 degrees (night of the 12th),
         4 Ha of 60 s at 26 degrees (night of the 14th),
         3 LP of 45 s at 18 degrees: for them there is no suitable dark.

1. Close the project, drag in the "groups" folder and open the Calibrate
   panel. Before building you should see:
   - Master Dark: 4 groups (1.5 s; 30 s at 18 degrees; 60 s at 18 degrees
     with 6 frames, because the 60.3 s dark joins them; 60 s at 26 degrees).
     For each one, what it is for: 4 lights for the three light groups,
     the correction of the LP flats for the 1.5 s one. Below, the note that
     the file Dark_60s_22C_0001.fit is excluded because it is the only one
     in those conditions, and the one that the 3 lights of 45 s have no
     suitable dark (no dark has an exposure of 45 s).
   - Master Flat: 2 groups (LP filter night of the 12th, Ha filter night of the 14th).
   - Master Bias: 2 groups (gain 100 and gain 200): the one at 100 serves
     the 3 lights of 45 s and the correction of the Ha flats, the one at 200
     serves no light.
2. Press "Build all masters". The notices must say: 2 bias masters,
   4 dark masters, 2 flat masters; the LP flat corrected with the dark of
   the same exposure, the Ha flat corrected with the bias (the one at gain
   100); the dark at 22 degrees excluded. In the Calibration library tab
   8 more masters appear, one per group.
3. Stack (the different exposures are merged in HDR; for this test that is
   fine). In the Result tab, the calibration by groups of lights:
   - 4 lights of 60 s, LP filter: dark 60 s at 18 degrees, LP flat;
   - 4 lights of 30 s, LP filter: dark 30 s at 18 degrees, LP flat;
   - 4 lights of 60 s, Ha filter: dark 60 s at 26 degrees, Ha flat;
   - 3 lights of 45 s: no suitable dark (no dark has an exposure of 45 s),
     bias at gain 100 and LP flat.
   A notice explains that the 3 lights of 45 s were calibrated with bias and
   flat, without dark. No light at 18 degrees must use the dark at 26
   degrees, nor the reverse.
4. Also try the library: close the project, drag in only the lights
   (Light_*.fit) of the "groups" folder and stack. Each group of lights
   must find its masters in the library, with the same choices as in
   step 3; the lights of 45 s stay without a dark there too.
`
writeFileSync(join(folder, 'README.txt'), readme.replace(/\n/g, '\r\n'))

console.log(writtenFiles + ' frames written to ' + folder + ' (' + (byte / 1e6).toFixed(0) + ' MB) in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s')
