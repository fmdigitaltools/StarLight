/**
 * Test of the calibration library: the rules for choosing a master for a
 * frame, storage in the sensor format (the reread master must match the
 * one used in the session), 16-bit precision and replacement of masters
 * with the same conditions.
 *
 *   $env:TEST_SCRIPT='tools/test-calibration-library.ts'; node tools/run-test.mjs
 */
import type { ImageData32 } from '../src/shared/types'
import { debayer } from '../src/core/image/debayer'
import {
  chooseMaster,
  sameConditions,
  unmosaic,
  usableMaster,
  canonicalMaster,
  quantize,
  dequantize,
  correctFlat,
  describeMaster,
  type MasterEntry,
  type FrameConditions
} from '../src/core/stack/calibrationLibrary'

let errors = 0
function check(ok: boolean, what: string): void {
  if (!ok) errors++
  console.log((ok ? 'ok   ' : 'NO   ') + what)
}

const base: Omit<MasterEntry, 'id' | 'type' | 'created'> = {
  width: 100,
  height: 80,
  planes: 1,
  channels: 3,
  bayer: 'RGGB',
  exposure: 10,
  gain: 80,
  temperature: 25,
  instrument: 'Camera X',
  filter: null,
  frame: 20,
  defectivePixels: 0,
  flatCorrection: null,
  minimum: 0,
  max: 1,
  byte: 1000
}
let n = 0
const entry = (type: MasterEntry['type'], extra: Partial<MasterEntry> = {}): MasterEntry => ({
  ...base,
  id: String(++n),
  type,
  created: '2026-10-10T20:00:00Z',
  ...extra
})
const light: FrameConditions = {
  width: 100,
  height: 80,
  channels: 3,
  bayer: 'RGGB',
  exposure: 10,
  gain: 80,
  temperature: 24,
  instrument: 'Camera X',
  filter: 'LP',
  data: '2026-10-18T21:00:00Z'
}

/* ---- Dark ---- */
const dark25 = entry('dark', { temperature: 25 })
const dark20 = entry('dark', { temperature: 20 })
const dark24Old = entry('dark', { temperature: 24, created: '2026-01-01T00:00:00Z' })
const dark24New = entry('dark', { temperature: 24, created: '2026-09-01T00:00:00Z' })
const dark30s = entry('dark', { exposure: 30 })
const darkGain = entry('dark', { gain: 120 })
check(chooseMaster([dark25, dark20], 'dark', light)?.entry === dark25, 'dark: the one within the temperature tolerance is chosen')
check(chooseMaster([dark20], 'dark', light) === null, 'dark: a 4 °C difference is not enough')
check(chooseMaster([dark24Old, dark24New, dark25], 'dark', light)?.entry === dark24New, 'dark: at equal temperature the most recent')
check(chooseMaster([dark30s], 'dark', light) === null, 'dark: different exposure discarded')
check(chooseMaster([darkGain], 'dark', light) === null, 'dark: different gain discarded')
check(chooseMaster([entry('dark', { exposure: 10.04 })], 'dark', light) !== null, 'dark: equal exposure within the header rounding')
check(chooseMaster([entry('dark', { width: 200 })], 'dark', light) === null, 'dark: sensor of other dimensions discarded')
check(chooseMaster([entry('dark', { instrument: 'Camera Y' })], 'dark', light) === null, 'dark: other instrument discarded')
check(chooseMaster([entry('dark', { bayer: 'GBRG' })], 'dark', light) === null, 'dark: other Bayer pattern discarded')
const withoutTemp = chooseMaster([entry('dark', { temperature: null })], 'dark', light)
check(withoutTemp !== null && withoutTemp.note !== '', 'dark: without temperature it is accepted, with a warning')

/* ---- Bias ---- */
check(chooseMaster([entry('bias', { temperature: 5, exposure: 0.001 })], 'bias', light) !== null, 'bias: temperature and exposure do not matter')
check(chooseMaster([entry('bias', { gain: 0 })], 'bias', light) === null, 'bias: different gain discarded')

/* ---- Flat ---- */
check(chooseMaster([entry('flat', { filter: 'LP', exposure: 0.5 })], 'flat', light) !== null, 'flat: different exposure allowed, same filter')
check(chooseMaster([entry('flat', { filter: 'IRCUT' })], 'flat', light) === null, 'flat: other filter discarded')
check(chooseMaster([entry('flat', { filter: 'LP', created: '2026-08-01T00:00:00Z' })], 'flat', light) === null, 'flat: older than 30 days discarded')
// Two nights, each with its own flat: every frame takes the one from its
// night, not the most recent.
const flat12 = entry('flat', { filter: 'LP', created: '2026-10-12T19:30:00Z' })
const flat15 = entry('flat', { filter: 'LP', created: '2026-10-15T19:30:00Z' })
const light12: FrameConditions = { ...light, data: '2026-10-12T22:40:00Z' }
const light15: FrameConditions = { ...light, data: '2026-10-16T01:10:00Z' }
check(chooseMaster([flat12, flat15], 'flat', light12)?.entry === flat12, 'flat: the frame of the 12th takes the flat of the 12th, even if there is a more recent one')
check(chooseMaster([flat15, flat12], 'flat', light15)?.entry === flat15, 'flat: the frame of the night of the 15th takes the flat of the 15th')
check(chooseMaster([flat12, flat15], 'flat', { ...light, data: null }, '2026-10-18T12:00:00Z')?.entry === flat15, 'flat: without a frame date the one closest to today wins')

/* ---- Replacement ---- */
const { id: _a, created: _b, byte: _c, ...newDark } = entry('dark', { temperature: 24.6 })
void _a
void _b
void _c
check(sameConditions(newDark, entry('dark', { temperature: 25.2 })), 'a new dark at 25 °C replaces the one at 25 °C')
check(!sameConditions(newDark, entry('dark', { temperature: 20 })), 'a dark at 20 °C stays alongside')

/* ---- Sensor format ---- */
const w = 64
const h = 48
const raw: ImageData32 = { width: w, height: h, channels: 1, data: new Float32Array(w * h) }
for (let i = 0; i < raw.data.length; i++) raw.data[i] = 0.02 + ((i * 7919) % 1000) / 20000
const colors = debayer(raw, 'RGGB')
const reread = usableMaster(unmosaic(colors, 'RGGB'), 'RGGB')
let rejection = 0
for (let i = 0; i < colors.data.length; i++) rejection = Math.max(rejection, Math.abs(reread.data[i] - colors.data[i]))
check(rejection === 0, 'a master rebuilt from the sensor comes back identical from the sensor format')
// A master composed with the median of color frames is not exactly
// reconstructible: the canonical form makes it so.
const disturbedValue: ImageData32 = { ...colors, data: colors.data.map((v, i) => v + ((i * 31) % 7) * 1e-4) }
const canonical = canonicalMaster(disturbedValue, 'RGGB')
const canonicalReread = usableMaster(unmosaic(canonical, 'RGGB'), 'RGGB')
let rejection2 = 0
for (let i = 0; i < canonical.data.length; i++) rejection2 = Math.max(rejection2, Math.abs(canonicalReread.data[i] - canonical.data[i]))
check(rejection2 === 0, 'the canonical form of a master matches the one reread from the library')
check(unmosaic(colors, 'RGGB').channels === 1, 'a color master is stored in a single plane')

/* ---- 16 bit ---- */
const { values, minimum, max } = quantize(colors.data)
const returnValue = dequantize(values, minimum, max)
let error16 = 0
for (let i = 0; i < returnValue.length; i++) error16 = Math.max(error16, Math.abs(returnValue[i] - colors.data[i]))
check(error16 <= (max - minimum) / 65535, '16-bit storage loses at most one step (' + error16.toExponential(2) + ')')

/* ---- Flat ---- */
const flat: ImageData32 = { width: 2, height: 1, channels: 1, data: new Float32Array([0.5, 0.3]) }
const corr = correctFlat(flat, { width: 2, height: 1, channels: 1, data: new Float32Array([0.05, 0.4]) })
check(Math.abs(corr.data[0] - 0.45) < 1e-6 && corr.data[1] === 0, 'the corrected flat subtracts the master and does not go below zero')

/* ---- Description ---- */
console.log('     ' + describeMaster(dark25) + ' | ' + describeMaster(entry('flat', { filter: 'LP' })))
check(describeMaster(dark25) === 'Dark 10 s, guadagno 80, 25 °C', 'description of a dark')

console.log(errors === 0 ? '\nAll checks passed.' : '\n' + errors + ' checks failed.')
process.exit(errors === 0 ? 0 : 1)
