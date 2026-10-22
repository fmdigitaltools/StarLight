/**
 * Plugin check: manifests of the bundled gallery, execution of the five
 * plugins in the isolated sandbox with verification of the results, and
 * tests with malicious or faulty plugins (network, infinite loop,
 * exceptions, wrong results), which must be stopped without consequences.
 *
 * In Node the browser worker is simulated by a thread (see
 * tools/plugin-node.ts): prelude, time limit and checks are those of the app.
 *
 * Usage (compiling to a dedicated output file):
 *   node_modules/@esbuild/win32-x64/esbuild.exe tools/test-plugin.ts --bundle --platform=node
 *     --format=esm --alias:@shared=./src/shared --alias:@core=./src/core --outfile=<temporary>/test-plugin.mjs
 *   node <temporary>/test-plugin.mjs
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { ImageData32 } from '../src/shared/types'
import { APP_VERSION } from '../src/shared/version'
import {
  checkManifest,
  checkCode,
  defaultValues,
  completeValues,
  isOpenSourceLicense,
  readEnabledPlugins,
  localizeManifest,
  type PluginManifest,
  type ParameterValues
} from '../src/core/plugin/manifest'
import { runInSandbox, type PluginContext, type PluginResponse } from '../src/core/plugin/isolation'
import { NEUTRAL_PROCESSING, neutralProcessing } from '../src/core/image/chain'
import { readProject, serializeProject, type ProjectState } from '../src/core/project'
import { NEUTRAL_CURVES } from '../src/core/image/curve'
import { FULL_CROP } from '../src/core/export/crop'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { autoStretch, applyStretchValue } from '../src/core/image/stretch'
import { readZip } from '../src/main/zip'
import { nodeWorker } from './plugin-node'
import { testFile } from './test-files.mjs'

let problems = 0
function check(condition: boolean, description: string): void {
  if (condition) console.log('  ok   ' + description)
  else {
    problems++
    console.log('  NO   ' + description)
  }
}

const FOLDER = 'resources/plugin'
const NEUTRAL: PluginContext = { stretch: { black: 0, midtones: 0.5, white: 1 }, starLightVersion: APP_VERSION }

function run(code: string, image: ImageData32, values: ParameterValues, context = NEUTRAL, time?: number): Promise<PluginResponse> {
  return runInSandbox(nodeWorker(code), { image, values, context }, time)
}

/** Test image with repeatable pseudo-random values, and a little excess green. */
function sampleImage(w: number, h: number): ImageData32 {
  const n = w * h
  const data = new Float32Array(3 * n)
  let s = 12345
  const testCase = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = 0; i < n; i++) {
    data[i] = 0.05 + testCase() * 0.4
    data[n + i] = 0.08 + testCase() * 0.5
    data[2 * n + i] = 0.04 + testCase() * 0.4
  }
  return { width: w, height: h, channels: 3, data }
}

function equal(a: Float32Array, b: Float32Array, tolerance = 0): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tolerance) return false
  return true
}

function ok(r: PluginResponse): ImageData32 {
  if (r.result !== 'ok') throw new Error('execution failed: ' + r.message)
  return r.image
}

async function main(): Promise<void> {
  /* ---- Manifests and files of the bundled gallery ---- */
  console.log('--- BUNDLED GALLERY ---')
  const plugin = new Map<string, { manifest: PluginManifest; code: string }>()
  for (const id of readdirSync(FOLDER).filter((n) => existsSync(join(FOLDER, n, 'plugin.json')))) {
    const result = checkManifest(JSON.parse(readFileSync(join(FOLDER, id, 'plugin.json'), 'utf-8')), APP_VERSION)
    check(result.ok, id + ': valid manifest' + (result.ok ? '' : ' — ' + result.errors.join(' ')))
    if (!result.ok) continue
    const m = result.manifest
    check(m.id === id, id + ': the folder is named after the id')
    const code = readFileSync(join(FOLDER, id, 'plugin.js'), 'utf-8')
    const errors = checkCode(code)
    check(errors.length === 0, id + ': code accepted' + (errors.length ? ' — ' + errors.join(' ') : ''))
    for (const f of [m.icon, m.previews.before, m.previews.after]) {
      const data = existsSync(join(FOLDER, id, f)) ? readFileSync(join(FOLDER, id, f)) : null
      check(data !== null && data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG', id + ': image ' + f + ' present and PNG')
    }
    plugin.set(id, { manifest: m, code })
  }
  // "Rotate and mirror" is not in the gallery: mirror and rotation are in the top bar.
  check(
    plugin.size > 0 && !plugin.has('rotate-mirror'),
    plugin.size + ' plugins in the gallery, without "Rotate and mirror" (' + [...plugin.keys()].join(', ') + ')'
  )
  const p = (id: string): { manifest: PluginManifest; code: string } => {
    const x = plugin.get(id)
    if (!x) throw new Error('missing ' + id)
    return x
  }

  /* ---- Execution in the sandbox and results ---- */
  console.log('--- PLUGIN RESULTS ---')
  const test = sampleImage(64, 48)
  const n = 64 * 48

  {
    const { manifest, code } = p('green-removal')
    const mean = ok(await run(code, test, defaultValues(manifest)))
    let respected = true
    let intactItems = true
    for (let i = 0; i < n; i++) {
      const r = test.data[i]
      const b = test.data[2 * n + i]
      if (mean.data[n + i] > (r + b) / 2 + 1e-6) respected = false
      if (test.data[n + i] <= (r + b) / 2 && mean.data[n + i] !== test.data[n + i]) intactItems = false
    }
    check(respected, 'SCNR neutral average: green does not exceed the average of red and blue')
    check(intactItems, 'SCNR: pixels without excess green stay identical')
    check(equal(mean.data.subarray(0, n), test.data.subarray(0, n)), 'SCNR: red does not change')
    const max = ok(await run(code, test, { ...defaultValues(manifest), method: 'maximum' }))
    let rispMax = true
    let belowMean = true
    for (let i = 0; i < n; i++) {
      if (max.data[n + i] > Math.max(test.data[i], test.data[2 * n + i]) + 1e-6) rispMax = false
      if (max.data[n + i] < mean.data[n + i] - 1e-6) belowMean = false
    }
    check(rispMax && belowMean, 'SCNR neutral maximum: green within the maximum, removes less than the average')
    const zero = ok(await run(code, test, { ...defaultValues(manifest), amount: 0 }))
    check(equal(zero.data, test.data), 'SCNR with amount zero changes nothing')
  }

  {
    const { manifest, code } = p('negative')
    const d = { black: 0.02, midtones: 0.12, white: 0.9 }
    const context = { ...NEUTRAL, stretch: d }
    const oneItem = ok(await run(code, test, defaultValues(manifest), context))
    const two = ok(await run(code, oneItem, defaultValues(manifest), context))
    const st = { shadows: d.black, midtones: d.midtones, highlights: d.white }
    let inverse = true
    for (let i = 0; i < test.data.length; i++) {
      const before = applyStretchValue(test.data[i], st)
      const after = applyStretchValue(oneItem.data[i], st)
      if (Math.abs(before + after - 1) > 2e-3) inverse = false
    }
    check(inverse, 'Negative: on screen every value becomes its complement (with the viewer stretch)')
    let returnValue = true
    for (let i = 0; i < test.data.length; i++) {
      if (Math.abs(applyStretchValue(two.data[i], st) - applyStretchValue(test.data[i], st)) > 2e-3) returnValue = false
    }
    check(returnValue, 'Negative applied twice returns to the starting image')
    const light = ok(await run(code, test, { mode: 'luminance' }, context))
    check(light.channels === 3 && Array.from(light.data).every(Number.isFinite), 'Negative "light only": valid result')
  }

  {
    const { manifest, code } = p('channel-mixer-bw')
    const r = ok(await run(code, test, defaultValues(manifest)))
    let grays = true
    for (let i = 0; i < n; i++) if (r.data[i] !== r.data[n + i] || r.data[i] !== r.data[2 * n + i]) grays = false
    check(grays, 'Black and white: the three channels are equal')
    const gray: ImageData32 = { width: 2, height: 1, channels: 3, data: new Float32Array([0.3, 0.6, 0.3, 0.6, 0.3, 0.6]) }
    const g = ok(await run(code, gray, { red: 0.9, green: 0.1, blue: 0.4, normalize: true }))
    check(equal(g.data, gray.data, 1e-6), 'Normalized black and white: a gray stays the same gray')
    const only = ok(await run(code, test, { red: 1, green: 0, blue: 0, normalize: true }))
    check(equal(only.data.subarray(0, n), test.data.subarray(0, n), 1e-7), 'Black and white with red only: the result is the red channel')
  }

  {
    const { manifest, code } = p('orton-effect')
    const d = { black: 0.03, midtones: 0.2, white: 1 }
    const st = { shadows: d.black, midtones: d.midtones, highlights: d.white }
    const r = ok(await run(code, test, defaultValues(manifest), { ...NEUTRAL, stretch: d }))
    let neverDarker = true
    let changedValue = false
    for (let i = 0; i < test.data.length; i++) {
      const a = applyStretchValue(test.data[i], st)
      const b = applyStretchValue(r.data[i], st)
      if (b < a - 2e-3) neverDarker = false
      if (b > a + 1e-3) changedValue = true
    }
    check(neverDarker && changedValue, 'Orton: the glow brightens and never darkens')
    const off = ok(await run(code, test, { ...defaultValues(manifest), strength: 0 }, { ...NEUTRAL, stretch: d }))
    let identicalValue = true
    for (let i = 0; i < test.data.length; i++) {
      if (Math.abs(applyStretchValue(off.data[i], st) - applyStretchValue(test.data[i], st)) > 2e-3) identicalValue = false
    }
    check(identicalValue, 'Orton with intensity zero leaves the image as it was')
  }

  {
    // HDR: a bright core with a fine structure, which the stretch brings
    // beyond white, on a faint background.
    const { manifest, code } = p('hdr-highlights')
    const w = 160
    const nn = w * w
    const im: ImageData32 = { width: w, height: w, channels: 3, data: new Float32Array(nn * 3) }
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const r2 = (x - 80) ** 2 + (y - 80) ** 2
        const nucleus = 0.9 * Math.exp(-r2 / (2 * 18 * 18)) * (1 + 0.15 * Math.sin(x / 2.5))
        const v = 0.02 + 0.001 * ((x * 7 + y * 13) % 5) + nucleus
        im.data[y * w + x] = v
        im.data[nn + y * w + x] = v * 0.9
        im.data[2 * nn + y * w + x] = v * 0.8
      }
    }
    const d = { black: 0.015, midtones: 0.1, white: 0.4 }
    const st = { shadows: d.black, midtones: d.midtones, highlights: d.white }
    const r = ok(await run(code, im, defaultValues(manifest), { ...NEUTRAL, stretch: d }))
    let identicalBackground = true
    for (let y = 0; y < 12; y++) for (let x = 0; x < w; x++) if (r.data[y * w + x] !== im.data[y * w + x]) identicalBackground = false
    check(identicalBackground, 'HDR: the faint background stays identical')
    // Structure in the core: difference between maxima and minima of the wave, as it appears on screen.
    const range = (data: Float32Array): number => {
      let min = Infinity
      let max = -Infinity
      for (let x = 70; x < 90; x++) {
        const v = Math.min(1, applyStretchValue(data[80 * w + x], st))
        min = Math.min(min, v)
        max = Math.max(max, v)
      }
      return max - min
    }
    check(
      range(im.data) < 0.01 && range(r.data) > 0.02,
      'HDR: the core structure, burned out before, becomes visible again (' +
        range(im.data).toFixed(3) + ' → ' + range(r.data).toFixed(3) + ')'
    )
    const ratio = r.data[nn + 80 * w + 80] / r.data[80 * w + 80]
    check(Math.abs(ratio - 0.9) < 1e-3, 'HDR: the colors keep their proportions')
  }

  {
    // Separation: a wide nebula, a small star on top and some noise.
    const { manifest, code } = p('star-separation')
    const w = 160
    const nn = w * w
    const im: ImageData32 = { width: w, height: w, channels: 3, data: new Float32Array(nn * 3) }
    let seed = 7
    const testCase = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 0.004
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const nebula = 0.08 * Math.exp(-((x - 80) ** 2 + (y - 80) ** 2) / (2 * 40 * 40))
        const star = 0.6 * Math.exp(-((x - 100) ** 2 + (y - 70) ** 2) / (2 * 1.5 * 1.5))
        const v = 0.02 + nebula + star + testCase()
        for (let c = 0; c < 3; c++) im.data[c * nn + y * w + x] = v
      }
    }
    const d = { black: 0.015, midtones: 0.15, white: 0.7 }
    const neutrals = {
      ...defaultValues(manifest),
      nebulaBrightness: 1,
      nebulaSaturation: 1,
      starBrightness: 1,
      starReduction: 0,
      starSaturation: 1
    }
    const recomposed = ok(await run(code, im, neutrals, { ...NEUTRAL, stretch: d }))
    let rejection = 0
    for (let i = 0; i < im.data.length; i++) rejection = Math.max(rejection, Math.abs(recomposed.data[i] - im.data[i]))
    check(rejection < 1e-5, 'Separation: with neutral values the recomposition is identical to the original')
    const without = ok(await run(code, im, { ...neutrals, output: 'nebula' }, { ...NEUTRAL, stretch: d }))
    const expectedNebula = 0.02 + 0.08 * Math.exp(-(20 ** 2 + 10 ** 2) / (2 * 40 * 40))
    check(
      Math.abs(without.data[70 * w + 100] - expectedNebula) < 0.01,
      'Separation: in place of the star the nebula remains (' + without.data[70 * w + 100].toFixed(3) + ', expected ' + expectedNebula.toFixed(3) + ')'
    )
    check(Math.abs(without.data[80 * w + 80] - im.data[80 * w + 80]) < 1e-6, 'Separation: the nebula far from the stars stays identical')
  }

  {
    // Violet and blue halos: a star with blue more blurred than the other
    // channels (the fringe), a truly blue star without fringe and a red
    // nebula, on a noisy background.
    const { manifest, code } = p('purple-fringe-removal')
    const w = 200
    const nn = w * w
    const im: ImageData32 = { width: w, height: w, channels: 3, data: new Float32Array(nn * 3) }
    let seed = 11
    const testCase = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 0.002
    const gauss = (r2: number, s: number): number => Math.exp(-r2 / (2 * s * s)) / (2 * Math.PI * s * s)
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const a = (x - 100) ** 2 + (y - 100) ** 2
        const b = (x - 50) ** 2 + (y - 150) ** 2
        const neb = 0.04 * Math.exp(-((x - 170) ** 2 + (y - 40) ** 2) / (2 * 15 * 15))
        im.data[i] = 0.05 + neb + 8 * 0.9 * gauss(a, 1.6) + 4 * 0.7 * gauss(b, 1.6) + testCase()
        im.data[nn + i] = 0.055 + 0.3 * neb + 8 * gauss(a, 1.6) + 4 * gauss(b, 1.6) + testCase()
        im.data[2 * nn + i] = 0.06 + 0.3 * neb + 8 * 0.8 * (0.5 * gauss(a, 1.6) + 0.5 * gauss(a, 4)) + 4 * 1.4 * gauss(b, 1.6) + testCase()
      }
    }
    const r = ok(await run(code, im, { ...defaultValues(manifest), strength: 1 }))
    // Blue/green ratio of the star light in a ring.
    const ratio = (data: Float32Array, cx: number, cy: number, r0: number, r1: number): number => {
      let sb = 0
      let sg = 0
      for (let y = cy - r1; y <= cy + r1; y++) {
        for (let x = cx - r1; x <= cx + r1; x++) {
          const d = Math.hypot(x - cx, y - cy)
          if (d < r0 || d > r1) continue
          sb += data[2 * nn + y * w + x] - 0.06
          sg += data[nn + y * w + x] - 0.055
        }
      }
      return sb / Math.max(1e-9, sg)
    }
    const before = ratio(im.data, 100, 100, 4, 9)
    const after = ratio(r.data, 100, 100, 4, 9)
    check(
      before > 2 && after < 0.5 * before,
      'Violet halos: the excess blue around the star is reduced (blue/green in the ring ' + before.toFixed(2) + ' → ' + after.toFixed(2) + ')'
    )
    const center = 100 * w + 100
    check(
      Math.abs(r.data[2 * nn + center] - im.data[2 * nn + center]) < 1e-6 && Math.abs(r.data[center] - im.data[center]) < 1e-6,
      'Violet halos: the center of the star keeps its color'
    )
    const blueBefore = ratio(im.data, 50, 150, 2, 4)
    const blueAfter = ratio(r.data, 50, 150, 2, 4)
    check(
      Math.abs(blueAfter / blueBefore - 1) < 0.03,
      'Violet halos: a truly blue star, without fringe, stays blue (' + blueBefore.toFixed(2) + ' → ' + blueAfter.toFixed(2) + ')'
    )
    let distant = true
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 100, y - 100) < 30 || Math.hypot(x - 50, y - 150) < 30) continue
        for (let c = 0; c < 3; c++) if (r.data[c * nn + y * w + x] !== im.data[c * nn + y * w + x]) distant = false
      }
    }
    check(distant, 'Violet halos: nebula and background far from the stars stay identical')
  }

  {
    // Halos of bright stars: a bright star with a wide halo, a small star
    // inside the halo and a distant one.
    const { manifest, code } = p('star-halo-reduction')
    const w = 260
    const nn = w * w
    const im: ImageData32 = { width: w, height: w, channels: 3, data: new Float32Array(nn * 3) }
    let seed = 5
    const testCase = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 0.002
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const nucleus = 0.9 * Math.exp(-((x - 130) ** 2 + (y - 130) ** 2) / (2 * 2.5 * 2.5))
        const halo = 0.03 * Math.exp(-Math.hypot(x - 130, y - 130) / 15)
        const near = 0.15 * Math.exp(-((x - 152) ** 2 + (y - 130) ** 2) / (2 * 1.3 * 1.3))
        const distant = 0.1 * Math.exp(-((x - 20) ** 2 + (y - 20) ** 2) / (2 * 1.3 * 1.3))
        const v = 0.05 + nucleus + halo + near + distant + testCase()
        for (let c = 0; c < 3; c++) im.data[c * nn + y * w + x] = v
      }
    }
    const d = { black: 0.045, midtones: 0.08, white: 1 }
    const r = ok(await run(code, im, defaultValues(manifest), { ...NEUTRAL, stretch: d }))
    // Light above the background in a ring between 20 and 40 pixels, on the side opposite the nearby star.
    const excess = (data: Float32Array): number => {
      let s = 0
      let k = 0
      for (let y = 90; y <= 170; y++) {
        for (let x = 90; x <= 130; x++) {
          const dd = Math.hypot(x - 130, y - 130)
          if (dd < 20 || dd > 40) continue
          s += data[nn + y * w + x] - 0.05
          k++
        }
      }
      return s / k
    }
    const before = excess(im.data)
    const after = excess(r.data)
    check(after < 0.4 * before, 'Bright halos: the halo is reduced (' + (before * 1000).toFixed(2) + ' → ' + (after * 1000).toFixed(2) + ' thousandths)')
    let nucleus = true
    for (let y = 128; y <= 132; y++) for (let x = 128; x <= 132; x++) if (Math.hypot(x - 130, y - 130) <= 2 && r.data[y * w + x] !== im.data[y * w + x]) nucleus = false
    check(nucleus, 'Bright halos: the star core stays identical (flux preserved)')
    let distant = true
    for (let y = 10; y <= 30; y++) for (let x = 10; x <= 30; x++) if (r.data[y * w + x] !== im.data[y * w + x]) distant = false
    check(distant, 'Bright halos: the distant small star stays identical')
    const relief = (data: Float32Array): number => data[130 * w + 152] - 0.5 * (data[130 * w + 146] + data[130 * w + 158])
    check(
      Math.abs(relief(r.data) / relief(im.data) - 1) < 0.1,
      'Bright halos: the small star inside the halo keeps its relief (' + relief(im.data).toFixed(3) + ' → ' + relief(r.data).toFixed(3) + ')'
    )

    // Profile continuity: a star with a wide saturated core and a halo.
    // After the reduction the radial profile, as it appears on screen, must
    // fall without steps or corners: the change of slope from one pixel to
    // the next (the strongest curvature of the profile) must not exceed by
    // more than 60% that of the original profile, which sits at the edge
    // of the saturated core, and the profile must stay decreasing.
    // A full subtraction just outside the disk gives a jump four times
    // larger.
    const sat: ImageData32 = { width: w, height: w, channels: 3, data: new Float32Array(nn * 3) }
    seed = 5
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const rr = Math.hypot(x - 130, y - 130)
        const v = Math.min(1, 0.05 + 3 * Math.exp(-(rr * rr) / (2 * 36)) + 0.06 * Math.exp(-rr / 15)) + testCase()
        for (let c = 0; c < 3; c++) sat.data[c * nn + y * w + x] = v
      }
    }
    const rs = ok(await run(code, sat, defaultValues(manifest), { ...NEUTRAL, stretch: d }))
    const stS = { shadows: d.black, midtones: d.midtones, highlights: d.white }
    const profile = (data: Float32Array): number[] => {
      const sum = new Array(100).fill(0)
      const tally = new Array(100).fill(0)
      for (let y = 0; y < w; y++) {
        for (let x = 0; x < w; x++) {
          const b = Math.round(Math.hypot(x - 130, y - 130))
          if (b >= 100) continue
          sum[b] += Math.min(1, applyStretchValue(data[nn + y * w + x], stS))
          tally[b]++
        }
      }
      return sum.map((s, k) => s / tally[k])
    }
    const jump = (pr: number[]): number => {
      let m = 0
      for (let k = 1; k < 80; k++) m = Math.max(m, Math.abs(pr[k + 1] - 2 * pr[k] + pr[k - 1]))
      return m
    }
    const pBefore = profile(sat.data)
    const pAfter = profile(rs.data)
    let descending = true
    for (let k = 1; k < 60; k++) if (pAfter[k] > pAfter[k - 1] + 0.004) descending = false
    check(
      jump(pAfter) <= 1.6 * jump(pBefore) && descending,
      'Bright halos: the profile stays continuous and decreasing, without steps or corners (slope jump ' +
        jump(pBefore).toFixed(4) + ' → ' + jump(pAfter).toFixed(4) + ')'
    )
    check(
      pAfter[25] < pBefore[25] - 0.03 && Math.abs(pAfter[8] - pBefore[8]) < 1e-6,
      'Bright halos: around the saturated core the halo goes down (' + pBefore[25].toFixed(3) + ' → ' + pAfter[25].toFixed(3) + ') and the core stays identical'
    )
  }

  {
    // Star color: an orange star that the stretch brings to white, next to
    // a red nebula.
    const { manifest, code } = p('star-color')
    const w = 160
    const nn = w * w
    const im: ImageData32 = { width: w, height: w, channels: 3, data: new Float32Array(nn * 3) }
    let seed = 3
    const testCase = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 0.001
    const color = [1, 0.75, 0.45]
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const star = 2 * Math.exp(-((x - 80) ** 2 + (y - 80) ** 2) / (2 * 2.5 * 2.5))
        const neb = 0.06 * Math.exp(-((x - 25) ** 2 + (y - 130) ** 2) / (2 * 12 * 12))
        for (let c = 0; c < 3; c++) im.data[c * nn + y * w + x] = 0.05 + star * color[c] + neb * (c === 0 ? 1 : 0.25) + testCase()
      }
    }
    const d = { black: 0.045, midtones: 0.12, white: 0.6 }
    const st = { shadows: d.black, midtones: d.midtones, highlights: d.white }
    const r = ok(await run(code, im, defaultValues(manifest), { ...NEUTRAL, stretch: d }))
    // On-screen saturation (maximum minus minimum of the channels) in a pixel.
    const saturation = (data: Float32Array, i: number): number => {
      const v = [0, 1, 2].map((c) => Math.min(1, applyStretchValue(data[c * nn + i], st)))
      return Math.max(...v) - Math.min(...v)
    }
    const i = 80 * w + 81
    check(
      saturation(im.data, i) < 0.05 && saturation(r.data, i) > 0.2,
      'Star color: the white center regains color (' + saturation(im.data, i).toFixed(2) + ' → ' + saturation(r.data, i).toFixed(2) + ')'
    )
    const sr = applyStretchValue(r.data[i], st)
    const sg = applyStretchValue(r.data[nn + i], st)
    const sb = applyStretchValue(r.data[2 * nn + i], st)
    check(sr >= sg && sg >= sb, 'Star color: the hue is that of the star (red ≥ green ≥ blue)')
    let remainder = true
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 80, y - 80) < 12) continue
        for (let c = 0; c < 3; c++) if (r.data[c * nn + y * w + x] !== im.data[c * nn + y * w + x]) remainder = false
      }
    }
    check(remainder, 'Star color: nebula and background stay identical')

    // Stars of known color, from blue to orange: the ratios between the
    // channels are those of a black body (Planck's law at 610, 540 and
    // 460 nm) from 30000 to 3200 K. For each temperature a medium star and
    // one with a saturated core in the data, on a warm-tinted background.
    // The color reconstructed at the center must match the true one.
    const planck = (l: number, T: number): number => 1 / (l ** 5 * (Math.exp(1.4388e-2 / (l * T)) - 1))
    const temperatures = [30000, 10000, 6500, 4500, 3200]
    const wc = 400
    const hc = 120
    const nc = wc * hc
    const field: ImageData32 = { width: wc, height: hc, channels: 3, data: new Float32Array(nc * 3) }
    for (let k = 0; k < nc; k++) for (let c = 0; c < 3; c++) field.data[c * nc + k] = [0.07, 0.055, 0.04][c] + testCase()
    const note: { cx: number; cy: number; normalized: number[]; T: number }[] = []
    temperatures.forEach((T, k) => {
      const v = [610e-9, 540e-9, 460e-9].map((l) => planck(l, T))
      const normalized = v.map((x) => x / Math.max(...v))
      for (const [amplitude, cy] of [[1.5, 35], [6, 85]]) {
        const cx = 40 + k * 80
        note.push({ cx, cy, normalized, T })
        for (let y = 0; y < hc; y++) {
          for (let x = 0; x < wc; x++) {
            const g = amplitude * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 2.2 * 2.2))
            for (let c = 0; c < 3; c++) field.data[c * nc + y * wc + x] += g * normalized[c]
          }
        }
      }
    })
    for (let k = 0; k < field.data.length; k++) field.data[k] = Math.min(2, field.data[k])
    const dc = { black: 0.045, midtones: 0.1, white: 0.5 }
    const stc = { shadows: dc.black, midtones: dc.midtones, highlights: dc.white }
    const rc = ok(await run(code, field, { ...defaultValues(manifest), strength: 1, coreProtection: 0 }, { ...NEUTRAL, stretch: dc }))
    let maxResidual = 0
    let whiteBefore = true
    for (const s of note) {
      const k = s.cy * wc + s.cx
      const tint = (data: Float32Array): number[] => {
        const v = [0, 1, 2].map((c) => Math.min(1, applyStretchValue(data[c * nc + k], stc)))
        return v.map((x) => x / Math.max(...v))
      }
      if (Math.min(...tint(field.data)) < 0.97) whiteBefore = false
      const after = tint(rc.data)
      for (let c = 0; c < 3; c++) maxResidual = Math.max(maxResidual, Math.abs(after[c] - s.normalized[c]))
    }
    check(
      whiteBefore && maxResidual < 0.06,
      'Star color: stars from 30000 to 3200 K, white on screen, regain their true color, blue ones included (maximum deviation ' +
        maxResidual.toFixed(3) + ')'
    )

    // Stars already colored on screen (not burned out), among them a very
    // strongly red one with a hint of magenta: the plugin must not fade them.
    // In no pixel may the on-screen saturation drop.
    const wg = 300
    const hg = 80
    const ng = wg * hg
    const alreadyColored: ImageData32 = { width: wg, height: hg, channels: 3, data: new Float32Array(ng * 3) }
    for (let k = 0; k < ng; k++) for (let c = 0; c < 3; c++) alreadyColored.data[c * ng + k] = 0.05 + testCase()
    const tints = [
      [1, 0.33, 0.23],
      [1, 0.7, 0.35],
      [0.45, 0.65, 1],
      [1, 0.5, 0.6]
    ]
    tints.forEach((tint, k) => {
      for (const [amplitude, cx] of [[0.25, 30 + k * 70], [0.9, 60 + k * 70]]) {
        for (let y = 0; y < hg; y++) {
          for (let x = 0; x < wg; x++) {
            const g = amplitude * Math.exp(-((x - cx) ** 2 + (y - 40) ** 2) / (2 * 2.2 * 2.2))
            for (let c = 0; c < 3; c++) alreadyColored.data[c * ng + y * wg + x] += g * tint[c]
          }
        }
      }
    })
    const dg = { black: 0.045, midtones: 0.25, white: 1 }
    const stg = { shadows: dg.black, midtones: dg.midtones, highlights: dg.white }
    const rg = ok(await run(code, alreadyColored, defaultValues(manifest), { ...NEUTRAL, stretch: dg }))
    let worst = 0
    for (let k = 0; k < ng; k++) {
      const sat = (data: Float32Array): number => {
        const v = [0, 1, 2].map((c) => Math.min(1, applyStretchValue(data[c * ng + k], stg)))
        const m = Math.max(...v)
        return m > 0.05 ? (m - Math.min(...v)) / m : 0
      }
      worst = Math.max(worst, sat(alreadyColored.data) - sat(rg.data))
    }
    check(worst < 0.01, 'Star color: already colored stars do not fade (maximum saturation drop ' + worst.toFixed(3) + ')')
  }

  /* ---- Spikes, coloring, toning, false color ---- */
  {
    // Diffraction spikes: two bright stars (A brighter than B) and a faint
    // one (C) below the threshold, on a background with a little noise.
    const { manifest, code } = p('diffraction-spikes')
    const w = 200
    const nn = w * w
    let seed = 3
    const testCase = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 0.004
    const sky = (stars: [number, number, number, number][]): ImageData32 => {
      const im: ImageData32 = { width: w, height: w, channels: 3, data: new Float32Array(nn * 3) }
      for (let y = 0; y < w; y++) {
        for (let x = 0; x < w; x++) {
          let v = 0.05 + testCase()
          for (const [sx, sy, peak, sg] of stars) v += peak * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * sg * sg))
          for (let c = 0; c < 3; c++) im.data[c * nn + y * w + x] = Math.min(1, v)
        }
      }
      return im
    }
    const A: [number, number, number, number] = [60, 60, 1.6, 3]
    const B: [number, number, number, number] = [140, 130, 1.2, 2.2]
    const C: [number, number, number, number] = [30, 170, 0.45, 1.5]
    const three = sky([A, B, C])
    const base = { ...defaultValues(manifest), spectrum: false, starColor: false }
    const r = ok(await run(code, three, base))
    const changedAround = (im: ImageData32, cx: number, cy: number, radius: number): number => {
      let changedItems = 0
      for (let y = cy - radius; y <= cy + radius; y++)
        for (let x = cx - radius; x <= cx + radius; x++)
          for (let c = 0; c < 3; c++) if (im.data[c * nn + y * w + x] !== three.data[c * nn + y * w + x]) changedItems++
      return changedItems
    }
    check(changedAround(r, C[0], C[1], 8) === 0, 'Spikes: the star below the threshold stays identical')
    check(changedAround(r, A[0], A[1], 20) > 0 && changedAround(r, B[0], B[1], 15) > 0, 'Spikes: the two stars above the threshold get the spikes')
    let distant = 0
    for (let y = 0; y < 30; y++) for (let x = 170; x < w; x++) if (r.data[y * w + x] !== three.data[y * w + x]) distant++
    check(distant === 0, 'Spikes: the sky far from the spikes stays identical')
    const single = ok(await run(code, three, { ...base, maxStars: 1 }))
    check(
      changedAround(single, A[0], A[1], 20) > 0 && changedAround(single, B[0], B[1], 15) === 0,
      'Spikes: with one star at most, the spikes go only to the brightest'
    )

    // Number of spikes: on the circle of radius 25 around star A alone, the
    // maxima of the added light are counted.
    const onlyOne = sky([A, C])
    const countSpikes = (im: ImageData32): number => {
      const samples = 720
      const added: number[] = []
      for (let k = 0; k < samples; k++) {
        const a = (2 * Math.PI * k) / samples
        const x = Math.round(A[0] + 25 * Math.cos(a))
        const y = Math.round(A[1] - 25 * Math.sin(a))
        added.push(im.data[y * w + x] - onlyOne.data[y * w + x])
      }
      const max = Math.max(...added)
      let peaks = 0
      let above = false
      for (let k = 0; k <= samples; k++) {
        const v = added[k % samples] > max / 2
        if (v && !above && k < samples) peaks++
        above = v
      }
      // A peak straddling the start of the circle is counted twice.
      if (added[0] > max / 2 && added[samples - 1] > max / 2) peaks--
      return peaks
    }
    for (const [tips, angle] of [['4', 0], ['6', 10], ['8', 20]] as const) {
      const im = ok(await run(code, onlyOne, { ...base, spikes: tips, angle: angle }))
      const counted = countSpikes(im)
      check(counted === Number(tips), 'Spikes: ' + tips + ' spikes requested, ' + counted + ' found around the star')
    }

    // Profile: along the horizontal spike to the right the added light
    // falls off continuously and fades out before the edge, without a sharp cut.
    const horizontal = ok(await run(code, onlyOne, base))
    const long: number[] = []
    for (let x = A[0] + 8; x < w; x++) long.push(horizontal.data[A[1] * w + x] - onlyOne.data[A[1] * w + x])
    let monotonic = true
    for (let k = 1; k < long.length; k++) if (long[k] > long[k - 1] + 1e-4) monotonic = false
    const end = long.findIndex((v) => v < 1e-5)
    check(monotonic && end > 10, 'Spikes: the spike fades toward the tip (' + (end + 8) + ' pixels long)')
    check(end > 0 && long[end - 1] < 0.02 * long[0], 'Spikes: at the tip the spike fades without a sharp cut')

    // Dispersion: toward the tip red reaches farther than blue.
    const spectrum = ok(await run(code, onlyOne, { ...base, spectrum: true }))
    const extension = (c: number): number => {
      let last = 0
      for (let x = A[0] + 8; x < w; x++) if (spectrum.data[c * nn + A[1] * w + x] - onlyOne.data[c * nn + A[1] * w + x] > 1e-5) last = x
      return last - A[0]
    }
    check(extension(0) > extension(2), 'Spikes: with dispersion red extends more than blue (' + extension(0) + ' and ' + extension(2) + ' pixels)')
  }

  {
    // Coloring: the on-screen luminosity stays the starting one.
    const { manifest, code } = p('mono-colorize')
    const mono: ImageData32 = { width: 64, height: 48, channels: 1, data: test.data.slice(0, n) }
    const d = { black: 0.02, midtones: 0.12, white: 0.9 }
    const st = { shadows: d.black, midtones: d.midtones, highlights: d.white }
    const context = { ...NEUTRAL, stretch: d }
    for (const tint of ['hAlpha', 'hBeta', 'oIII', 'custom']) {
      for (const saturation of [0.5, 1]) {
        const r = ok(await run(code, mono, { ...defaultValues(manifest), tint: tint, saturation: saturation, customHue: 250 }, context))
        let rejection = 0
        for (let i = 0; i < n; i++) {
          const luma =
            0.2126 * applyStretchValue(r.data[i], st) + 0.7152 * applyStretchValue(r.data[n + i], st) + 0.0722 * applyStretchValue(r.data[2 * n + i], st)
          rejection = Math.max(rejection, Math.abs(luma - applyStretchValue(mono.data[i], st)))
        }
        check(r.channels === 3 && rejection < 2e-3, 'Coloring ' + tint + ' at ' + saturation * 100 + '%: luminosity preserved (deviation ' + rejection.toExponential(1) + ')')
      }
    }
    const red = ok(await run(code, mono, defaultValues(manifest), context))
    let redTint = true
    for (let i = 0; i < n; i++) if (!(red.data[i] >= red.data[n + i] && red.data[i] >= red.data[2 * n + i])) redTint = false
    check(redTint, 'Coloring H-alpha: red prevails in every pixel')
    const grayImage = ok(await run(code, mono, { ...defaultValues(manifest), saturation: 0 }, context))
    let neutral = true
    for (let i = 0; i < n; i++) if (Math.abs(grayImage.data[i] - grayImage.data[n + i]) > 1e-6 || Math.abs(grayImage.data[i] - grayImage.data[2 * n + i]) > 1e-6) neutral = false
    check(neutral, 'Coloring with saturation zero: the image stays black and white')
  }

  {
    // Toning: background with noise, a wide nebula and a star.
    const { manifest, code } = p('split-toning')
    const w = 160
    const nn = w * w
    const im: ImageData32 = { width: w, height: w, channels: 3, data: new Float32Array(nn * 3) }
    let seed = 11
    const testCase = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 0.02
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const nebula = 0.6 * Math.exp(-((x - 90) ** 2 + (y - 90) ** 2) / (2 * 25 * 25))
        const star = 0.9 * Math.exp(-((x - 120) ** 2 + (y - 40) ** 2) / (2 * 1.5 * 1.5))
        const v = 0.08 + nebula + star + testCase()
        im.data[y * w + x] = v
        im.data[nn + y * w + x] = v * 0.98
        im.data[2 * nn + y * w + x] = v * 1.01
      }
    }
    const r = ok(await run(code, im, defaultValues(manifest)))
    let identicalBackground = true
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) for (let c = 0; c < 3; c++) if (r.data[c * nn + y * w + x] !== im.data[c * nn + y * w + x]) identicalBackground = false
    check(identicalBackground, 'Toning: with protection the sky background stays identical')
    let rejection = 0
    for (let i = 0; i < nn; i++) {
      const before = 0.2126 * im.data[i] + 0.7152 * im.data[nn + i] + 0.0722 * im.data[2 * nn + i]
      const after = 0.2126 * r.data[i] + 0.7152 * r.data[nn + i] + 0.0722 * r.data[2 * nn + i]
      if (before <= 1) rejection = Math.max(rejection, Math.abs(before - after))
    }
    check(rejection < 1e-5, 'Toning: the luminosity of every pixel stays unchanged (deviation ' + rejection.toExponential(1) + ')')
    // Edge of the nebula (shadow): cold tint, blue rises above red.
    const shadow = 90 * w + 90 + 45
    const center = 90 * w + 90
    check(
      r.data[2 * nn + shadow] - r.data[shadow] > im.data[2 * nn + shadow] - im.data[shadow] + 0.005 &&
        r.data[center] - r.data[2 * nn + center] > im.data[center] - im.data[2 * nn + center] + 0.005,
      'Toning: shadows toward blue and highlights toward orange, as set'
    )
    const without = ok(await run(code, im, { ...defaultValues(manifest), protectBackground: false }))
    let backgroundChanged = false
    for (let i = 0; i < 20; i++) if (without.data[2 * nn + i] !== im.data[2 * nn + i]) backgroundChanged = true
    check(backgroundChanged, 'Toning: without protection the background also receives the tint')
  }

  {
    // False color: a luminosity ramp must give ever lighter colors.
    const { manifest, code } = p('false-color')
    const w = 512
    const h = 4
    const nn = w * h
    const ramp: ImageData32 = { width: w, height: h, channels: 3, data: new Float32Array(nn * 3) }
    // Flat background in the first half (scales on linear data need a
    // background to start from), then a rise up to 0.9.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < w / 2 ? 0.05 : 0.05 + (0.85 * (x - w / 2)) / (w / 2 - 1)
        for (let c = 0; c < 3; c++) ramp.data[c * nn + y * w + x] = v
      }
    }
    const d = { black: 0.01, midtones: 0.2, white: 1 }
    const st = { shadows: d.black, midtones: d.midtones, highlights: d.white }
    for (const palette of ['viridis', 'magma', 'inferno', 'plasma']) {
      for (const scale of ['screen', 'linear', 'logarithmic']) {
        const r = ok(await run(code, ramp, { ...defaultValues(manifest), palette: palette, scale: scale }, { ...NEUTRAL, stretch: d }))
        let monotonic = true
        let previous = -1
        for (let x = 0; x < w; x++) {
          const i = w + x
          const luma =
            0.2126 * applyStretchValue(r.data[i], st) + 0.7152 * applyStretchValue(r.data[nn + i], st) + 0.0722 * applyStretchValue(r.data[2 * nn + i], st)
          if (luma < previous - 1e-6) monotonic = false
          previous = luma
        }
        const initial = applyStretchValue(r.data[w], st)
        check(monotonic && previous > initial + 0.3, 'False color ' + palette + ', scale ' + scale + ': colors ever lighter with luminosity')
      }
    }
    // Logarithmic scale: halfway up the ramp the level is higher than with the linear one.
    const lin = ok(await run(code, ramp, { ...defaultValues(manifest), scale: 'linear' }))
    const log = ok(await run(code, ramp, { ...defaultValues(manifest), scale: 'logarithmic' }))
    const midpoint = w + Math.round(w * 0.6)
    const lumaOf = (im: ImageData32, i: number): number => 0.2126 * im.data[i] + 0.7152 * im.data[nn + i] + 0.0722 * im.data[2 * nn + i]
    check(lumaOf(log, midpoint) > lumaOf(lin, midpoint) + 0.1, 'False color: the logarithmic scale lightens the faint parts more than the linear one')
    // Black and white stars: a star on a wide nebula.
    const ws = 120
    const ns = ws * ws
    const sky: ImageData32 = { width: ws, height: ws, channels: 3, data: new Float32Array(ns * 3) }
    for (let y = 0; y < ws; y++) {
      for (let x = 0; x < ws; x++) {
        const v = 0.1 + 0.3 * Math.exp(-((x - 60) ** 2 + (y - 60) ** 2) / (2 * 30 * 30)) + 0.6 * Math.exp(-((x - 40) ** 2 + (y - 70) ** 2) / (2 * 1.5 * 1.5))
        for (let c = 0; c < 3; c++) sky.data[c * ns + y * ws + x] = v
      }
    }
    const grayList = ok(await run(code, sky, { ...defaultValues(manifest), grayStars: true }))
    const star = 70 * ws + 40
    const nebula = 60 * ws + 60
    const gray = (i: number): boolean => Math.abs(grayList.data[i] - grayList.data[ns + i]) < 1e-3 && Math.abs(grayList.data[i] - grayList.data[2 * ns + i]) < 1e-3
    check(gray(star) && !gray(nebula), 'False color: the star stays gray, the nebula takes the false colors')
  }

  /* ---- On a real shot ---- */
  console.log('--- ON A REAL SHOT (crop of M 27) ---')
  {
    const readResult = readFits(new Uint8Array(readFileSync(testFile('m27'))), 'M_27.fit')
    const whole = debayer(readResult.image, readResult.metadata.bayer)
    const side = 600
    const x0 = 1085 - side / 2
    const y0 = 1915 - side / 2
    const nn = side * side
    const data = new Float32Array(3 * nn)
    const nIn = whole.width * whole.height
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < side; y++)
        for (let x = 0; x < side; x++) data[c * nn + y * side + x] = whole.data[c * nIn + (y0 + y) * whole.width + x0 + x]
    const piece: ImageData32 = { width: side, height: side, channels: 3, data }
    const s = autoStretch(whole)
    const context = { ...NEUTRAL, stretch: { black: s.shadows, midtones: s.midtones, white: s.highlights } }
    for (const [id, { manifest, code }] of plugin) {
      const t0 = performance.now()
      const r = await run(code, piece, defaultValues(manifest), context)
      const ms = performance.now() - t0
      check(r.result === 'ok' && Array.from(r.image.data).every(Number.isFinite), id + ': run on 600 x 600 pixels in ' + ms.toFixed(0) + ' ms')
    }
    check(equal(piece.data, data) && piece.data === data, 'the starting image stays intact (the plugin gets a copy)')
  }

  /* ---- Malicious or faulty plugins ---- */
  console.log('--- SANDBOX: MALICIOUS OR FAULTY PLUGINS ---')
  const small = sampleImage(8, 8)
  const malicious = async (code: string, time = 4000): Promise<PluginResponse> => run(code, small, {}, NEUTRAL, time)

  const network = await malicious(`export async function processImage(im) { await fetch('https://example.com/ruba?x=1'); return im }`)
  check(network.result === 'error' && /non possono usare fetch/.test(network.message), 'fetch blocked: ' + (network.result === 'error' ? network.message : 'NOT blocked'))

  const proto = await malicious(
    `export function processImage(im) { let o = globalThis; while (o) { const f = Object.getOwnPropertyDescriptor(o, 'fetch'); if (f && typeof f.value === 'function' && !String(f.value).includes('non possono')) throw new Error('fetch found again'); o = Object.getPrototypeOf(o) } return im }`
  )
  check(proto.result === 'ok', 'fetch cannot be found by climbing the environment prototypes')

  const overwrite = await malicious(`globalThis.fetch = () => 1; export function processImage(im) { return im }`)
  check(overwrite.result === 'error', 'the plugin cannot put fetch back in its place (error at load)')

  const others = await malicious(
    `export function processImage(im) { const reached = []; for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker']) { try { new globalThis[name]('x'); reached.push(name) } catch (e) { if (!/non possono/.test(e.message)) reached.push(name) } } if (reached.length) throw new Error('reachable: ' + reached.join(', ')); return im }`
  )
  check(others.result === 'ok', 'XMLHttpRequest, WebSocket, EventSource, importScripts and Worker blocked' + (others.result === 'error' ? ' — ' + others.message : ''))

  const t0 = performance.now()
  const cycle = await malicious(`export function processImage(im) { while (true) {} }`, 1500)
  const duration = performance.now() - t0
  check(cycle.result === 'error' && /fermato/.test(cycle.message) && duration < 4000, 'infinite loop stopped after ' + duration.toFixed(0) + ' ms')

  const cycleOnTop = await malicious(`for (;;) {} export function processImage(im) { return im }`, 1500)
  check(cycleOnTop.result === 'error', 'infinite loop during loading stopped')

  const exception = await malicious(`export function processImage() { throw new Error('intended failure') }`)
  check(exception.result === 'error' && /intended failure/.test(exception.message), 'an exception in the plugin becomes a notice')

  const syntax = await malicious(`export function processImage( {`)
  check(syntax.result === 'error', 'a syntax error becomes a notice')

  const without = await malicious(`export function altro(im) { return im }`)
  check(without.result === 'error' && /processImage/.test(without.message), 'plugin without "processImage" rejected')

  const measurements = await malicious(`export function processImage(im) { return { width: 9, height: 8, channels: 3, data: im.data } }`)
  check(measurements.result === 'error', 'sizes inconsistent with the data rejected')

  const type = await malicious(`export function processImage(im) { return { ...im, data: Array.from(im.data) } }`)
  check(type.result === 'error', 'data that is not Float32Array rejected')

  const huge = await malicious(`export function processImage(im) { return { width: 100000, height: 100000, channels: 3, data: new Float32Array(3) } }`)
  check(huge.result === 'error', 'oversized image rejected')

  const nan = await malicious(`export function processImage(im) { const d = new Float32Array(im.data); d[0] = NaN; d[1] = Infinity; return { ...im, data: d } }`)
  check(nan.result === 'ok' && nan.image.data[0] === 0 && nan.image.data[1] === 0, 'non-numeric values zeroed')

  check(checkCode(`import fs from 'node:fs'\nexport function processImage(im) { return im }`).length > 0, 'installation: static import rejected')
  check(checkCode(`export async function processImage(im) { await import('https://x.y/z.js'); return im }`).length > 0, 'installation: dynamic import rejected')
  check(checkCode(`// commented import\nexport function processImage(im) { return im }`).length === 0, 'installation: an import in comments does not count')
  check(checkCode(`export function altro() {}`).length > 0, 'installation: without "processImage" rejected')

  /* ---- Manifests and licenses ---- */
  console.log('--- MANIFESTS AND LICENSES ---')
  const good = JSON.parse(readFileSync(join(FOLDER, 'negative', 'plugin.json'), 'utf-8'))
  check(isOpenSourceLicense('MIT') && isOpenSourceLicense('gpl-3.0-or-later') && isOpenSourceLicense('MIT OR Apache-2.0'), 'open source licenses accepted (also OR expressions)')
  check(!isOpenSourceLicense('Proprietary') && !isOpenSourceLicense('') && !isOpenSourceLicense('MIT OR Commerciale'), 'non-free licenses rejected')
  check(!checkManifest({ ...good, license: 'All rights reserved' }, APP_VERSION).ok, 'manifest with a non-free license rejected')
  const withoutLicense = { ...good }
  delete withoutLicense.license
  check(!checkManifest(withoutLicense, APP_VERSION).ok, 'manifest without a license rejected')
  check(!checkManifest({ ...good, minimumStarLightVersion: '9.0.0' }, APP_VERSION).ok, 'plugin for a newer StarLight rejected')
  check(!checkManifest({ ...good, id: '../fuori' }, APP_VERSION).ok, 'id with a path rejected')
  check(!checkManifest({ ...good, icon: '../../icon.png' }, APP_VERSION).ok, 'icon outside the folder rejected')
  check(!checkManifest({ ...good, category: 'games' }, APP_VERSION).ok, 'unknown category rejected')
  check(
    !checkManifest({ ...good, parameters: [{ type: 'slider', id: 'x', label: 'X', min: 0, max: 1, step: 0.1, default: 5 }] }, APP_VERSION).ok,
    'slider with default out of range rejected'
  )
  const scnr = p('green-removal').manifest
  const completeOnes = completeValues(scnr, { amount: 7, method: 'unknown', extraneous: 1 })
  check(completeOnes['amount'] === 1 && completeOnes['method'] === 'average' && !('extraneous' in completeOnes), 'saved values out of range brought back within the limits')

  /* ---- Translations of the manifest texts ---- */
  console.log('--- TRANSLATIONS ---')
  const oldItalian = JSON.parse(readFileSync(join(FOLDER, 'green-removal', 'plugin.json'), 'utf-8')).translations.it
  const it = localizeManifest(scnr, 'it')
  const method = it.parameters.find((x) => x.id === 'method')
  check(
    it.name === oldItalian.name && it.description === oldItalian.description && it.name !== scnr.name,
    'Italian: name and description from translations.it (' + it.name + ')'
  )
  check(
    method?.type === 'choice' && method.label === oldItalian.parameters.method.label && method.options[0].label === oldItalian.parameters.method.options.average.label,
    'Italian: parameter and option labels translated, values unchanged (' + (method?.type === 'choice' ? method.options.map((o) => o.value).join(', ') : '') + ')'
  )
  check(JSON.stringify(localizeManifest(scnr, 'de')) === JSON.stringify(scnr), 'language without a translation: the English texts of the manifest')
  check(localizeManifest(scnr, 'it-CH').name === it.name, 'regional code (it-CH): the base language translation')
  const partial = checkManifest(
    { ...good, translations: { fr: { name: 'Négatif', parameters: { mode: { options: { luminance: 'Lumière' } } } } } },
    APP_VERSION
  )
  const fr = partial.ok ? localizeManifest(partial.manifest, 'fr') : null
  const mode = fr?.parameters.find((x) => x.id === 'mode')
  const englishMode = partial.ok ? partial.manifest.parameters.find((x) => x.id === 'mode') : undefined
  check(
    fr !== null && fr.name === 'Négatif' && fr.description === good.description && mode?.type === 'choice' && englishMode?.type === 'choice' &&
      mode.label === englishMode.label && mode.options.find((o) => o.value === 'luminance')?.label === 'Lumière' &&
      mode.options.find((o) => o.value === 'colors')?.label === englishMode.options.find((o) => o.value === 'colors')?.label,
    'partial translation: missing texts fall back to English, text by text'
  )
  let complete = true
  for (const [id, { manifest }] of plugin) {
    const tr = manifest.translations?.it
    if (!tr?.name || !tr.description) complete = false
    for (const par of manifest.parameters) {
      if (!tr?.parameters?.[par.id]?.label) complete = false
      if (par.type === 'choice' && par.options.some((o) => !tr?.parameters?.[par.id]?.options?.[o.value]?.label)) complete = false
    }
    if (!complete) {
      check(false, id + ': complete Italian translation')
      break
    }
  }
  if (complete) check(true, 'every bundled plugin has a complete Italian translation')

  /* ---- Projects ---- */
  console.log('--- PROJECTS ---')
  const adjustments = { a: 1 }
  const state: ProjectState<typeof adjustments> = {
    name: 'Test',
    frame: [],
    activeFrame: null,
    image: null,
    originalImage: null,
    result: null,
    adjustments,
    curves: NEUTRAL_CURVES,
    processing: {
      ...NEUTRAL_PROCESSING,
      plugin: [{ id: 'negative', active: true, values: { mode: 'luminance' } }, { id: 'orton-effect', active: false, values: {} }]
    },
    appliedProcessing: null,
    crop: FULL_CROP,
    aspectRatio: 'original',
    preset: null,
    objects: [],
    withCalibration: true,
    step: 'process'
  }
  const reread = readProject(serializeProject(state, APP_VERSION), adjustments)
  check(JSON.stringify(reread.processing.plugin) === JSON.stringify(state.processing.plugin), 'plugins and values saved and re-read from the project')
  const old = JSON.parse(serializeProject(state, APP_VERSION))
  delete old.processing.plugin
  check(readProject(JSON.stringify(old), adjustments).processing.plugin.length === 0, 'project from a previous version: empty plugin list')
  old.processing.plugin = [{ id: 'buono', active: true, values: { a: 1, b: { x: 1 } } }, 'rotto', { id: '../x' }, { id: 'buono' }]
  const cleaned = readEnabledPlugins(old.processing.plugin)
  check(cleaned.length === 1 && cleaned[0].id === 'buono' && !('b' in cleaned[0].values), 'damaged plugin entries discarded on reading')
  check(neutralProcessing({ ...NEUTRAL_PROCESSING, plugin: [{ id: 'x', active: false, values: {} }] }), 'plugins turned off: processing still neutral')
  check(!neutralProcessing({ ...NEUTRAL_PROCESSING, plugin: [{ id: 'x', active: true, values: {} }] }), 'plugin turned on: processing not neutral')

  /* ---- ZIP archive ---- */
  console.log('--- ZIP ARCHIVE ---')
  try {
    const dir = mkdtempSync(join(tmpdir(), 'starlight-zip-'))
    const source = join(dir, 'negative')
    mkdirSync(source)
    for (const f of readdirSync(join(FOLDER, 'negative'))) writeFileSync(join(source, f), readFileSync(join(FOLDER, 'negative', f)))
    const zip = join(dir, 'negative.zip')
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${source}' -DestinationPath '${zip}'`])
    const entries = readZip(readFileSync(zip))
    const manifest = entries.find((v) => v.name.endsWith('plugin.json'))
    check(
      manifest !== undefined && manifest.data.equals(readFileSync(join(FOLDER, 'negative', 'plugin.json'))),
      'ZIP archive read (' + entries.length + ' files, identical contents)'
    )
  } catch (e) {
    console.log('  --   ZIP test skipped: ' + (e instanceof Error ? e.message : String(e)))
  }
  let rejected = false
  try {
    readZip(Buffer.from('not a zip'))
  } catch {
    rejected = true
  }
  check(rejected, 'a file that is not a ZIP is rejected')

  console.log(problems === 0 ? '\nAll good.' : '\nProblems: ' + problems)
  process.exit(problems === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
