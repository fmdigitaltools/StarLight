/**
 * Check of the HDR merge of series with different exposures (src/core/stack/hdr.ts).
 *
 * Checks, on synthetic data and without files:
 *   - grouping by exposure and the choice of series to merge;
 *   - the measured brightness ratio, with gain and background different
 *     from the ratio of the declared times;
 *   - the saturated core in the long series comes back with its true shape;
 *   - faint areas stay those of the long series;
 *   - the result stays between 0 and 1 and linear.
 *
 *   $env:TEST_SCRIPT='tools/test-hdr.ts'; node tools/run-test.mjs
 */
import type { ImageData32 } from '../src/shared/types'
import { mergeHdr, seriesToMerge, seriesPerExposure } from '../src/core/stack/hdr'

let errors = 0
function check(condition: boolean, message: string): void {
  console.log((condition ? '  ok  ' : '  NO  ') + message)
  if (!condition) errors++
}

// Grouping.
const series = seriesPerExposure([
  { id: 'a', exposure: 10 }, { id: 'b', exposure: 10.1 }, { id: 'c', exposure: 2 }, { id: 'd', exposure: 2 }, { id: 'e', exposure: null }, { id: 'f', exposure: 9.9 }
])
check(series.length === 2 && series[0].exposure === 10 && series[0].ids.length === 3 && series[1].ids.length === 2, '10 s series (3 frames) and 2 s series (2 frames)')
check(seriesToMerge(series)?.length === 2, 'two series to merge')
check(seriesToMerge(seriesPerExposure([{ id: 'a', exposure: 10 }, { id: 'b', exposure: 10 }, { id: 'c', exposure: 8 }, { id: 'd', exposure: 8 }])) === null, 'exposures too similar: no merge')
check(seriesToMerge(seriesPerExposure([{ id: 'a', exposure: 10 }, { id: 'b', exposure: 10 }, { id: 'c', exposure: 2 }])) === null, 'short series with a single frame: no merge')

// Sky: background, a wide nebula and a very bright core.
const W = 200
const H = 160
function sky(x: number, y: number): number {
  const r2 = (x - 100) ** 2 + (y - 80) ** 2
  return 0.02 * Math.exp(-r2 / (2 * 50 * 50)) + 3 * Math.exp(-r2 / (2 * 6 * 6))
}
let seed = 7
function noise(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648 - 0.5
}
// Long: factor 5 relative to the sky, background 0.05, saturates at 1.
// Short: exposure 5 times shorter but gain 1.2 times: true ratio 5/1.2.
function shot(scale: number, background: number, noiseAmp: number): ImageData32 {
  const d = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = Math.min(1, background + scale * sky(x, y) + noiseAmp * noise())
  return { width: W, height: H, channels: 1, data: d }
}
const long = shot(1, 0.05, 0.001)
const short = shot(1.2 / 5, 0.03, 0.001)
const result = mergeHdr(long, short)
const trueRatio = 5 / 1.2
console.log('     measured ratio ' + result.ratio.toFixed(3) + ' (true ' + trueRatio.toFixed(3) + '), divisor ' + result.divisor.toFixed(2) + ', short in ' + (result.replacedShare * 100).toFixed(1) + '%')
check(Math.abs(result.ratio / trueRatio - 1) < 0.05, 'measured ratio within 5%')

const v = (x: number, y: number): number => result.image.data[y * W + x] * result.divisor
// At the center the long frame is saturated (1); the true value is 0.05 + 3.02.
const trueCenter = 0.05 + sky(100, 80)
check(long.data[80 * W + 100] === 1, 'core is saturated in the long series')
check(Math.abs(v(100, 80) / trueCenter - 1) < 0.05, 'reconstructed core: ' + v(100, 80).toFixed(2) + ' versus ' + trueCenter.toFixed(2))
// Profile: from the center outwards the value must always decrease.
let monotonic = true
for (let x = 100; x < 120; x++) if (v(x + 1, 80) > v(x, 80) + 0.01) monotonic = false
check(monotonic, 'core profile without steps or rises')
// Faint areas: identical to the long series.
check(Math.abs(v(20, 20) - long.data[20 * W + 20]) < 1e-6 && Math.abs(v(160, 40) - long.data[40 * W + 160]) < 1e-6, 'faint areas identical to the long series')
let max = 0
let minimum = 1
for (const x of result.image.data) {
  max = Math.max(max, x)
  minimum = Math.min(minimum, x)
}
check(max <= 1 && minimum >= 0, 'result between 0 and 1')

let launched = false
try {
  mergeHdr(long, { ...short, width: 100 })
} catch {
  launched = true
}
check(launched, 'different sizes: clear error')

console.log('\n' + (errors === 0 ? 'All good.' : errors + ' errors.'))
if (errors > 0) process.exit(1)
