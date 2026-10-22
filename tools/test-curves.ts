/** Tone curve check: monotonicity, passage through the control points, edge cases. */
import { buildLut, evaluateLut, PRESET_CURVES, NEUTRAL_CURVE, sortPoints } from '../src/core/image/curve'

let problems = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  OK   ' : '  ERROR ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) problems++
}

console.log('--- NEUTRAL CURVE ---')
const neutral = buildLut(NEUTRAL_CURVE)
let maxDeviation = 0
for (let i = 0; i < neutral.length; i++) {
  maxDeviation = Math.max(maxDeviation, Math.abs(neutral[i] - i / (neutral.length - 1)))
}
result('matches the diagonal', maxDeviation < 1e-6, 'max deviation ' + maxDeviation.toExponential(2))

console.log('--- PRESET CURVES ---')
for (const c of PRESET_CURVES) {
  const lut = buildLut(c.points)

  // The curve must never go backwards.
  let monotonic = true
  for (let i = 1; i < lut.length; i++) if (lut[i] < lut[i - 1] - 1e-6) monotonic = false
  result(c.name + ': always increasing', monotonic)

  // It must pass through the requested points.
  let rejection = 0
  for (const p of c.points) rejection = Math.max(rejection, Math.abs(evaluateLut(lut, p.x) - p.y))
  result(c.name + ': passes through the points', rejection < 0.004, 'deviation ' + rejection.toFixed(5))

  // It must stay inside the useful range.
  let inside = true
  for (let i = 0; i < lut.length; i++) if (lut[i] < -1e-6 || lut[i] > 1 + 1e-6) inside = false
  result(c.name + ': stays between 0 and 1', inside)
}

console.log('--- EDGE CASES ---')
result('no points', buildLut([]).length === 256)
result('single point', Math.abs(buildLut([{ x: 0.5, y: 0.8 }])[10] - 0.8) < 1e-6)
result('overlapping points', sortPoints([{ x: 0.5, y: 0.2 }, { x: 0.501, y: 0.9 }]).length === 1)
result('unordered points', sortPoints([{ x: 0.8, y: 0.8 }, { x: 0.2, y: 0.2 }])[0].x === 0.2)

const steep = buildLut([
  { x: 0, y: 0 },
  { x: 0.48, y: 0.05 },
  { x: 0.52, y: 0.95 },
  { x: 1, y: 1 }
])
let withoutBumps = true
for (let i = 1; i < steep.length; i++) if (steep[i] < steep[i - 1] - 1e-6) withoutBumps = false
result('steep jump without oscillations', withoutBumps)

console.log(problems === 0 ? '\nALL CHECKS PASSED' : '\nCHECKS FAILED: ' + problems)
// Result for the aggregate runner (npm run test): exit code 1 if anything failed.
if (problems > 0) process.exitCode = 1
