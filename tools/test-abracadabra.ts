/**
 * Check of Abracadabra on a synthetic stack, made like those of an
 * automatic telescope: sky with clumpy grain, a faint galaxy with a bright
 * core, stars (some saturated, with red and blue clipped on a disk wider
 * than green, as in a real sensor), a noisy band on the right edge (few
 * shots, field rotation).
 *
 * It runs the chain like the app (first stage, dosed NL-Bayes, third
 * stage), then `abracadabraFinish` and the export rendering, and checks
 * the thresholds that matter to the eye:
 * - the galaxy core is not burned out (below 0.9) and stays brighter than
 *   the body;
 * - the background is dark gray, not pure black (between 0.05 and 0.15: the finish aims at 0.06);
 * - the galaxy body stands out from the background;
 * - the noisy band on the right is cropped, the clean left side is not;
 * - no colored ring is left around the saturated star;
 * - the linear stack is not mistaken for an already stretched one.
 *
 * Then the same stack already stretched, like the pre-stretched images of
 * automatic telescopes: it must be recognized, the core must not be pushed
 * towards white and no dark crescents must appear next to the stars (star
 * reduction can leave them on the steep profiles of stretched data). Then
 * a stack with a wedge poorly covered by field rotation, diagonal and
 * therefore not cropped: after Abracadabra the sky and grain of the wedge
 * must match those of the neighboring field.
 *
 * Then the wedge equalization on a smooth sky with a very bright star: the
 * halo must remain and not become a dark disk. Finally the crop proposal:
 * around a small galaxy in the center the wedge stays out and the galaxy
 * stays in with its margin; around a large galaxy only the edge crop is kept.
 *
 * Usage: TEST_SCRIPT=tools/test-abracadabra.ts node tools/run-test.mjs
 */
import type { ImageData32 } from '../src/shared/types'
import { firstStage, thirdStage, applyReductionAmount, ABRACADABRA_PROCESSING } from '../src/core/image/chain'
import { nlBayes } from '../src/core/image/nlbayes'
import { computeStats, MAD_TO_SIGMA } from '../src/core/image/stats'
import { abracadabraFinish } from '../src/core/image/abracadabraFinish'
import { applyCorrections } from '../src/core/export/processing'
import { blur } from '../src/core/image/cleanup'
import { mtf } from '../src/core/image/stretch'
import { findWedges, equalizeWedgeBackground, wedgeMap } from '../src/core/image/wedges'
import type { FirstStageMeasurements } from '../src/core/image/chain'

let problems = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? '  OK   ' : '  ERROR ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) problems++
}

/* ---- Synthetic stack ---- */

const W = 640
const H = 1000
const N = W * H
const GX = 300
const GY = 480
/** Saturated star: position. */
const SX = 480
const SY = 800
/** Very bright star with a wide halo (see `smoothSkyWithHalo`). */
const HALO_X = 470
const HALO_Y = 200

/** Repeatable random numbers. */
let seed = 12345
function random(): number {
  seed = (seed * 1103515245 + 12345) >>> 0
  return seed / 4294967296
}
function gauss(): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random())
}

interface SyntheticOptions {
  /** Noisy band on the right edge. */
  strip: boolean
  /** Poorly covered wedge at the bottom left (see `wedge`). */
  wedge: boolean
  /** Light of the galaxy core above the sky (0.05 if missing). */
  nucleusLight?: number
  /** Scale radius of the galaxy disk, in pixels (90 if missing). */
  diskScale?: number
}

/** Positions of the faint and medium stars of the last synthetic stack. */
const stars: [number, number][] = []

/**
 * Field rotation wedge at the bottom left: a triangle with one side on
 * the left edge and one on the bottom, noise three times stronger and
 * sky slightly higher (each shot has its own background). Diagonal and
 * far from the bands along the sides, the crop does not remove it.
 */
function wedge(x: number, y: number): boolean {
  return x / 260 + (H - y) / 420 < 1
}

function synthetic(o: SyntheticOptions = { strip: true, wedge: false }): ImageData32 {
  seed = 12345
  stars.length = 0
  const data = new Float32Array(3 * N)
  // Clumpy grain: blurred white noise, as in aligned stacks.
  const grain = (sigma: number): Float32Array => {
    const p = new Float32Array(N)
    for (let i = 0; i < N; i++) p[i] = gauss()
    const s = blur(p, W, H, 1)
    const st = computeStats(s)
    const k = sigma / Math.max(1e-12, st.mad * MAD_TO_SIGMA)
    for (let i = 0; i < N; i++) s[i] *= k
    return s
  }
  const sky = [0.05, 0.052, 0.049]
  // Galaxy color: bluish body, yellowish core.
  const bodyColor = [0.95, 1, 1.1]
  const nucleusColor = [1.1, 1, 0.85]
  for (let c = 0; c < 3; c++) {
    const g = grain(0.0016)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        // Tilted exponential disk, plus a compact core.
        const dx = x - GX
        const dy = y - GY
        const u = (dx * 0.8 + dy * 0.6) / 1
        const v = (-dx * 0.6 + dy * 0.8) / 0.5
        const r = Math.sqrt(u * u + v * v)
        const body = 0.006 * Math.exp(-r / (o.diskScale ?? 90))
        const nucleus = (o.nucleusLight ?? 0.05) * Math.exp(-(dx * dx + dy * dy) / (2 * 12 * 12))
        // Poorly covered band on the right: noise four times stronger.
        const noisy = o.strip && x >= W - 40 ? 4 : o.wedge && wedge(x, y) ? 3 : 1
        const smoothStep = o.wedge && wedge(x, y) ? 0.0012 : 0
        data[c * N + i] = sky[c] + smoothStep + body * bodyColor[c] + nucleus * nucleusColor[c] + g[i] * noisy
      }
    }
  }
  // Faint and medium stars.
  for (let k = 0; k < 250; k++) {
    const x = 10 + random() * (W - 60)
    const y = 10 + random() * (H - 20)
    const flux = 0.02 + 0.3 * random() ** 3
    star(data, x, y, flux, [1, 1, 1], 1.6)
    stars.push([x, y])
  }
  // Saturated, blue star: red and blue stronger than green, which therefore
  // clips on a narrower disk.
  star(data, SX, SY, 6, [1.3, 0.8, 1.6], 2.2)
  for (let i = 0; i < data.length; i++) data[i] = Math.min(1, Math.max(0, data[i]))
  return { width: W, height: H, channels: 3, data }
}

function star(data: Float32Array, sx: number, sy: number, flux: number, color: number[], sigma: number): void {
  const r = Math.ceil(sigma * 6)
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = Math.round(sx) + dx
      const y = Math.round(sy) + dy
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const d2 = (x - sx) ** 2 + (y - sy) ** 2
      const v = flux * Math.exp(-d2 / (2 * sigma * sigma))
      for (let c = 0; c < 3; c++) data[c * N + y * W + x] += v * color[c]
    }
  }
}

/* ---- Chain as in the app ---- */

function nlBayesLuminance(im: ImageData32): ImageData32 {
  const y = new Float32Array(N)
  for (let c = 0; c < 3; c++) for (let i = 0; i < N; i++) y[i] += im.data[c * N + i] / 3
  // Same sigma as the app's workers (nlbayesParallel.ts).
  const sigma = computeStats(y).mad * MAD_TO_SIGMA * 2.2
  const cleaned = nlBayes(y, W, H, sigma)
  const data = im.data.slice()
  for (let i = 0; i < N; i++) {
    const d = cleaned[i] - y[i]
    for (let c = 0; c < 3; c++) data[c * N + i] += d
  }
  return { ...im, data }
}

/** Chain, finishing and export rendering, like Abracadabra in the app. */
function abracadabra(original: ImageData32): { rendered: ImageData32; fin: ReturnType<typeof abracadabraFinish> } {
  const t0 = Date.now()
  const first = firstStage(original, ABRACADABRA_PROCESSING, true)
  let im = first.image
  if (first.parameters.nlBayes > 0) im = applyReductionAmount(im, nlBayesLuminance(im), first.parameters.nlBayes)
  const third = thirdStage(im, first.parameters, true)
  const fin = abracadabraFinish(third.image, first.measurements)
  const r = fin.adjustments
  const n3 = third.image
  const backgrounds: [number, number, number] = [0, 1, 2].map(
    (c) => computeStats(n3.data.subarray(c * N, (c + 1) * N)).median
  ) as [number, number, number]
  const rendered = applyCorrections(n3, { ...r, skyBackground: backgrounds, ghs: r.withGhs ? r.ghs : undefined })
  console.log('chain and rendering: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s')
  console.log('saturation ' + r.saturation + ', ghs ' + JSON.stringify(r.ghs))
  return { rendered, fin }
}

const original = synthetic()
const { rendered, fin } = abracadabra(original)

/* ---- Measurements ---- */

const light = (x: number, y: number): number => {
  const i = y * W + x
  return (rendered.data[i] + rendered.data[N + i] + rendered.data[2 * N + i]) / 3
}
/** Median of the light over a square. */
function median(x0: number, y0: number, side: number): number {
  const v: number[] = []
  for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) v.push(light(x, y))
  v.sort((a, b) => a - b)
  return v[v.length >> 1]
}

const nucleus = median(GX - 3, GY - 3, 7)
// Body: halfway between the core and the edge of the disk, along the major axis.
const body = median(GX + Math.round(0.8 * 110) - 5, GY + Math.round(0.6 * 110) - 5, 11)
const background = median(60, 60, 60)
result('core not burned out', nucleus < 0.9, nucleus.toFixed(3))
result('core brighter than the body', nucleus > body + 0.15, nucleus.toFixed(3) + ' versus ' + body.toFixed(3))
result('dark gray background, not black', background >= 0.05 && background <= 0.15, background.toFixed(3))
result('body standing out from the background', body > background + 0.04, body.toFixed(3) + ' versus ' + background.toFixed(3))

const crop = fin.crop
const rightSide = crop ? 1 - crop.x - crop.width : 0
result('noisy band on the right cropped', rightSide >= 40 / W - 0.005 && rightSide <= 0.15, (rightSide * 100).toFixed(1) + '%')
result('left side not cropped', !crop || crop.x <= 0.035, crop ? (crop.x * 100).toFixed(1) + '%' : 'no crop')

// Colored ring: chroma (maximum channel minus minimum) on the ring between 3 and
// 9 pixels from the center of the saturated star.
let maxChroma = 0
for (let dy = -9; dy <= 9; dy++) {
  for (let dx = -9; dx <= 9; dx++) {
    const d = Math.hypot(dx, dy)
    if (d < 3 || d > 9) continue
    const i = (SY + dy) * W + SX + dx
    const rgb = [rendered.data[i], rendered.data[N + i], rendered.data[2 * N + i]]
    maxChroma = Math.max(maxChroma, Math.max(...rgb) - Math.min(...rgb))
  }
}
result('no colored ring around the saturated star', maxChroma < 0.07, maxChroma.toFixed(3))

result('linear stack not mistaken for already stretched', !fin.alreadyStretched)

/* ---- Already stretched data (the pre-stretched images of automatic telescopes) ---- */

/** Light of a pixel of a three-channel image. */
function lightOf(im: ImageData32, x: number, y: number): number {
  const i = y * W + x
  return (im.data[i] + im.data[N + i] + im.data[2 * N + i]) / 3
}
function medianOf(im: ImageData32, x0: number, y0: number, width: number, height = width): number {
  const v: number[] = []
  for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) v.push(lightOf(im, x, y))
  v.sort((a, b) => a - b)
  return v[v.length >> 1]
}

/**
 * The same stack already stretched: black point just below the sky and
 * midtones that bring the sky to 0.04. The galaxy core rises towards
 * white and the stars have full disks with a steep edge, as in
 * pre-stretched images.
 */
function syntheticAlreadyStretched(linear: ImageData32): ImageData32 {
  const black = 0.05 - 3 * 0.0016
  const x = (0.05 - black) / (1 - black)
  const t = 0.04
  const m = (x * (1 - t)) / (x - 2 * t * x + t)
  return { ...linear, data: linear.data.map((v) => mtf(Math.max(0, (v - black) / (1 - black)), m)) }
}

const stretched = syntheticAlreadyStretched(synthetic({ strip: false, wedge: false, nucleusLight: 0.15 }))
const stretchedStars = stars.slice()
const stretchedNucleus = medianOf(stretched, GX - 3, GY - 3, 7)
const d = abracadabra(stretched)
result('already stretched data recognized', d.fin.alreadyStretched)
const nucleusD = medianOf(d.rendered, GX - 3, GY - 3, 7)
// Stretched a second time as linear data, the core would rise to 0.83.
result(
  'core of the already stretched data not pushed towards white',
  nucleusD < 0.8,
  nucleusD.toFixed(3) + ' (was ' + stretchedNucleus.toFixed(3) + ')'
)

// Crescents: around each star, the lowest light (smoothed 3 x 3)
// between 3 and 8 pixels from the center must not drop much below the
// nearby sky (darkest quarter of the ring between 10 and 14 pixels). On
// already stretched data star reduction can leave dark crescent-shaped
// dips next to the stars.
function dips(im: ImageData32, list: [number, number][]): { deep: number; worst: number } {
  let deep = 0
  let worst = 0
  for (const [sx, sy] of list) {
    const cx = Math.round(sx)
    const cy = Math.round(sy)
    if (cx < 20 || cy < 20 || cx >= W - 20 || cy >= H - 20) continue
    if (Math.hypot(cx - GX, cy - GY) < 200 || Math.hypot(cx - SX, cy - SY) < 40) continue
    const ring: number[] = []
    let minimum = Infinity
    for (let dy = -14; dy <= 14; dy++) {
      for (let dx = -14; dx <= 14; dx++) {
        const r = Math.hypot(dx, dy)
        if (r >= 10 && r <= 14) ring.push(lightOf(im, cx + dx, cy + dy))
        if (r >= 3 && r <= 8) {
          let s = 0
          for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) s += lightOf(im, cx + dx + ex, cy + dy + ey)
          minimum = Math.min(minimum, s / 9)
        }
      }
    }
    ring.sort((a, b) => a - b)
    const rejection = ring[ring.length >> 2] - minimum
    if (rejection > 0.05) deep++
    worst = Math.max(worst, rejection)
  }
  return { deep, worst }
}
const crescents = dips(d.rendered, stretchedStars)
result(
  'no dark crescents next to the stars (already stretched data)',
  crescents.deep <= 2,
  crescents.deep + ' stars, the worst ' + crescents.worst.toFixed(3)
)

/* ---- Field rotation wedge ---- */

const withWedge = abracadabra(synthetic({ strip: false, wedge: true }))
const sec = withWedge.rendered
// Sky and grain inside the wedge (far from its side) and just outside.
function skyAndGrain(inside: (x: number, y: number) => boolean): { level: number; grain: number } {
  const levels: number[] = []
  const differences: number[] = []
  for (let y = 20; y < H - 20; y++) {
    for (let x = 20; x < W - 20; x++) {
      if (!inside(x, y)) continue
      levels.push(lightOf(sec, x, y))
      differences.push(Math.abs(lightOf(sec, x + 2, y) - lightOf(sec, x, y)))
    }
  }
  levels.sort((a, b) => a - b)
  differences.sort((a, b) => a - b)
  return { level: levels[levels.length >> 1], grain: differences[differences.length >> 1] }
}
const inWedge = skyAndGrain((x, y) => x / 260 + (H - y) / 420 < 0.75)
const outside = skyAndGrain((x, y) => {
  const u = x / 260 + (H - y) / 420
  return u > 1.25 && u < 2 && x < 420 && y > 700
})
result(
  'poorly covered wedge: sky equal to the neighboring field',
  Math.abs(inWedge.level - outside.level) < 0.012,
  inWedge.level.toFixed(3) + ' versus ' + outside.level.toFixed(3)
)
result(
  'poorly covered wedge: grain equal to the neighboring field',
  inWedge.grain < 1.4 * outside.grain,
  inWedge.grain.toFixed(4) + ' versus ' + outside.grain.toFixed(4)
)

/* ---- Dark disk around a very bright star ---- */

/**
 * The wedge equalization, on its own, on a smooth sky like that of
 * pre-stretched images (fine grain, almost all removed by whoever
 * stretched them), with a poorly covered wedge and a very bright star
 * with a wide halo. In the halo the slope inflates the grain measured
 * with the difference between pixels: if it is taken for a wedge and
 * brought to the sky level, a disk darker than the sky remains, about a
 * hundred pixels wide, closed by a step at the rim.
 * The halo must come out of the equalization as it was; the wedge must be equalized.
 */
function smoothSkyWithHalo(): ImageData32 {
  seed = 777
  const data = new Float32Array(3 * N)
  for (let c = 0; c < 3; c++) {
    const p = new Float32Array(N)
    for (let i = 0; i < N; i++) p[i] = gauss()
    const g = blur(p, W, H, 1)
    const k = 0.0003 / Math.max(1e-12, computeStats(g).mad * MAD_TO_SIGMA)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const inside = wedge(x, y)
        data[c * N + i] = 0.1 + (inside ? 0.0006 : 0) + g[i] * k * (inside ? 3 : 1)
      }
    }
  }
  // Exponential halo, like that of a bright star in a
  // pre-stretched image: 0.07 above the sky at 20 pixels, 0.017 at 40, 0.001 at 80.
  star(data, HALO_X, HALO_Y, 0.8, [1, 1, 1], 3)
  for (let y = HALO_Y - 150; y <= HALO_Y + 150; y++) {
    for (let x = HALO_X - 150; x <= HALO_X + 150; x++) {
      const v = 0.3 * Math.exp(-Math.hypot(x - HALO_X, y - HALO_Y) / 14)
      for (let c = 0; c < 3; c++) data[c * N + y * W + x] += v
    }
  }
  return { width: W, height: H, channels: 3, data }
}
{
  const before = smoothSkyWithHalo()
  const foundItems = findWedges(before)
  const after = foundItems ? equalizeWedgeBackground(before, foundItems).image : before
  const ring = (im: ImageData32, from: number, a: number): number => {
    const v: number[] = []
    for (let y = HALO_Y - a; y <= HALO_Y + a; y++) {
      for (let x = HALO_X - a; x <= HALO_X + a; x++) {
        const r = Math.hypot(x - HALO_X, y - HALO_Y)
        if (r >= from && r < a) v.push(lightOf(im, x, y))
      }
    }
    v.sort((p, q) => p - q)
    return v[v.length >> 1]
  }
  // How much of the halo light (above the far sky) remains, ring by ring
  // between 16 and 80 pixels from the center: the worst one.
  const sky = ring(before, 130, 150)
  let minRemaining = Infinity
  for (let r = 16; r < 80; r += 8) {
    const light = ring(before, r, r + 8) - sky
    if (light > 0.001) minRemaining = Math.min(minRemaining, (ring(after, r, r + 8) - sky) / light)
  }
  result('wedge found on the smooth sky', foundItems !== null)
  result(
    'no dark disk around the bright star: the halo remains',
    minRemaining > 0.85,
    'at least ' + (minRemaining * 100).toFixed(0) + '% of its light remains'
  )
  const inWedgeAfter = medianOf(after, 20, H - 120, 60, 60)
  const fieldAfter = medianOf(after, 300, H - 120, 60, 60)
  result(
    'wedge equalized on the smooth sky',
    Math.abs(inWedgeAfter - fieldAfter) < 0.0003,
    inWedgeAfter.toFixed(4) + ' versus ' + fieldAfter.toFixed(4)
  )
}

/* ---- Wedge crop around a small object ---- */

/**
 * The crop proposal, from the finishing alone, with the wedge map
 * measured as in the first stage. Small galaxy in the center (disk with scale radius 40 pixels): the wedge at the
 * bottom left, which leaves thin lines along its boundaries, is left
 * out, and the galaxy stays whole with its margin. Large galaxy
 * (scale radius 450 pixels): only the edge crop is kept,
 * here none.
 */
function cropFor(im: ImageData32): ReturnType<typeof abracadabraFinish>['crop'] {
  const measurements: FirstStageMeasurements = {
    correctedPixels: 0,
    edges: { left: 0, rightSide: 0, top: 0, bottom: 0 },
    starGains: [1, 1, 1],
    hfr: 0,
    backgroundUnevenness: 0,
    trails: 0,
    wedges: wedgeMap(im)
  }
  return abracadabraFinish(im, measurements).crop
}
{
  const r = cropFor(synthetic({ strip: false, wedge: true, diskScale: 40 }))
  let inside = 0
  let allItems = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!wedge(x, y)) continue
      allItems++
      if (r && x >= r.x * W && x < (r.x + r.width) * W && y >= r.y * H && y < (r.y + r.height) * H) inside++
    }
  }
  const share = r ? inside / allItems : 1
  result(
    'small object: the wedge stays out of the proposed crop',
    share < 0.1,
    r ? 'inside ' + (share * 100).toFixed(0) + '% of the wedge' : 'no crop'
  )
  // Whole galaxy: the disk out to 150 pixels from the center along the
  // major axis (light by then at a three-hundredth of the sky), plus 30 of margin.
  const margin = 180
  const whole =
    r !== null &&
    r.x * W <= GX - margin * 0.8 &&
    (r.x + r.width) * W >= GX + margin * 0.8 &&
    r.y * H <= GY - margin * 0.6 &&
    (r.y + r.height) * H >= GY + margin * 0.6
  result(
    'small object: the galaxy stays whole with its margin',
    whole,
    r ? [r.x, r.y, r.width, r.height].map((v) => v.toFixed(3)).join(', ') : 'no crop'
  )
  const large = cropFor(synthetic({ strip: false, wedge: true, diskScale: 450 }))
  result(
    'large object: no wedge crop',
    large === null,
    large ? [large.x, large.y, large.width, large.height].map((v) => v.toFixed(3)).join(', ') : ''
  )
}

console.log(problems === 0 ? 'All good.' : problems + ' problems.')
if (problems > 0) process.exitCode = 1
