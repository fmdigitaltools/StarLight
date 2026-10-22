/**
 * Check of the Performance tab, in the parts that do not need Electron:
 * reading the startup choices from the preferences file, automatic choice
 * of the settings for the computer, space used by a folder.
 *
 *   node tools/run-tests.mjs --only performance
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startupChoices, DEFAULT_STARTUP_CHOICES } from '../src/shared/performance'
import {
  chosenDifferences,
  choicesRecap,
  choicesForComputer,
  gpuType,
  type ComputerData
} from '../src/core/automaticPerformance'
import { folderSize } from '../src/main/folderSize'

let errors = 0
function result(name: string, ok: boolean, detail = ''): void {
  console.log((ok ? 'ok   ' : 'NO   ') + name + (detail && !ok ? '  (' + detail + ')' : ''))
  if (!ok) errors++
}

const GB = 1073741824

function testStartupChoices(): void {
  const p = DEFAULT_STARTUP_CHOICES
  const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  result('missing file: default values', equal(startupChoices(undefined), p))
  result('settings not an object: default values', equal(startupChoices('rotto'), p))
  result('null: default values', equal(startupChoices(null), p))
  result('defaults: high performance, acceleration on, normal priority',
    p.gpu === 'high-performance' && p.graphicsAcceleration && !p.lowPriorityComputation)
  const choices = startupChoices({ gpu: 'low-power', graphicsAcceleration: false, lowPriorityComputation: true, other: 3 })
  result('valid values read', equal(choices, { gpu: 'low-power', graphicsAcceleration: false, lowPriorityComputation: true }))
  const distorted = startupChoices({ gpu: 'turbo', graphicsAcceleration: 'no', lowPriorityComputation: 1 })
  result('values of the wrong type: defaults', equal(distorted, p))
}

const base: ComputerData = {
  logicalProcessors: 16,
  totalRam: 32 * GB,
  automaticThreads: 12,
  webgl2: true,
  accelerationActive: true,
  gpuName: 'NVIDIA GeForce RTX 4060',
  vendors: [0x10de, 0x8086],
  onBattery: false
}

function testAutoChoice(): void {
  const strong = choicesForComputer(base)
  result('powerful computer: 12 threads', strong.analysisWorkers === 12, String(strong.analysisWorkers))
  result('powerful computer: whole memory in GB, at least 1', Number.isInteger(strong.frameMemoryGB) && strong.frameMemoryGB >= 1, String(strong.frameMemoryGB))
  result('powerful computer: 14 GB for frames (24 GB free × 0.6)', strong.frameMemoryGB === 14, String(strong.frameMemoryGB))
  result('high performance, acceleration on, normal priority',
    strong.gpu === 'high-performance' && strong.graphicsAcceleration && !strong.lowPriorityComputation)

  const lowRam = choicesForComputer({ ...base, totalRam: 8 * GB })
  result('8 GB: threads limited by memory (4)', lowRam.analysisWorkers === 4, String(lowRam.analysisWorkers))
  result('8 GB: frame memory 2 GB', lowRam.frameMemoryGB === 2, String(lowRam.frameMemoryGB))

  const tiny = choicesForComputer({ ...base, logicalProcessors: 4, automaticThreads: 2, totalRam: 4 * GB })
  result('4 processors: low priority', tiny.lowPriorityComputation)
  result('4 GB: at least 1 thread and 1 GB', tiny.analysisWorkers >= 1 && tiny.frameMemoryGB >= 1)
  result('5 processors: normal priority', !choicesForComputer({ ...base, logicalProcessors: 5 }).lowPriorityComputation)

  result('WebGL 2 failed with acceleration on: acceleration off',
    !choicesForComputer({ ...base, webgl2: false }).graphicsAcceleration)
  result('WebGL 2 failed even with acceleration off: back to on',
    choicesForComputer({ ...base, webgl2: false, accelerationActive: false }).graphicsAcceleration)
  result('acceleration turned off by hand but WebGL 2 works: on is recommended',
    choicesForComputer({ ...base, accelerationActive: false }).graphicsAcceleration)

  result('dedicated card from its name', gpuType('NVIDIA GeForce RTX 4060', []) === 'dedicated')
  result('integrated card from its name', gpuType('Intel(R) UHD Graphics 770', [0x8086]) === 'integrated')
  result('integrated Radeon', gpuType('AMD Radeon(TM) Graphics', [0x1002]) === 'integrated')
  result('dedicated Radeon RX', gpuType('AMD Radeon RX 7800 XT', [0x1002]) === 'dedicated')
  result('no name: from the vendor', gpuType(null, [0x10de]) === 'dedicated' && gpuType(null, [0x8086]) === 'integrated')
  result('no name and no vendor: unknown', gpuType(null, []) === 'unknown')
  const software = 'Vulkan 1.3.0 (SwiftShader Device (Subzero))'
  result('software rendering: neither dedicated nor integrated', gpuType(software, [0x10de]) === 'unknown')
  result('software rendering in the summary', choicesRecap({ ...base, gpuName: software }, choicesForComputer(base)).includes('disegno affidato al processore'))

  const diff = chosenDifferences(strong, { ...strong, analysisWorkers: 0, lowPriorityComputation: true })
  result('differences: two entries', diff.length === 2, JSON.stringify(diff))
  result('differences in words', diff[0]?.before === '12 threads' && diff[0]?.after === 'automatico' && diff[1]?.after === 'accesa',
    JSON.stringify(diff))
  result('no difference with itself', chosenDifferences(strong, strong).length === 0)

  const text = choicesRecap(base, strong)
  console.log('     ' + text)
  result('readable summary', text.startsWith('16 processori logici, 32 GB di memoria, NVIDIA GeForce RTX 4060 (dedicata): 12 threads, 14 GB per i frame'), text)
}

async function testSize(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'starlight-size-'))
  try {
    result('missing folder: zero', (await folderSize(join(root, 'does-not-exist'))).byte === 0)
    const blank = join(root, 'empty')
    mkdirSync(blank)
    const v = await folderSize(blank)
    result('empty folder: zero bytes, zero files', v.byte === 0 && v.file === 0)
    const full = join(root, 'full')
    mkdirSync(join(full, 'a', 'b'), { recursive: true })
    writeFileSync(join(full, 'one.bin'), Buffer.alloc(1000))
    writeFileSync(join(full, 'a', 'two.bin'), Buffer.alloc(2500))
    writeFileSync(join(full, 'a', 'b', 'three.bin'), Buffer.alloc(7))
    const m = await folderSize(full)
    result('folder with subfolders: 3507 bytes in 3 files', m.byte === 3507 && m.file === 3, JSON.stringify(m))
    const f = await folderSize(join(full, 'one.bin'))
    result('a single file', f.byte === 1000 && f.file === 1, JSON.stringify(f))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  testStartupChoices()
  testAutoChoice()
  await testSize()
  console.log(errors === 0 ? '\nAll good.' : '\n' + errors + ' checks failed.')
  process.exit(errors === 0 ? 0 : 1)
}

void main()
