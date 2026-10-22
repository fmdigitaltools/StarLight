import { recommendedBudget } from './memory'
import type { Gpu } from '@shared/performance'
import { formatNumber, t } from '@shared/i18n/i18n'

/**
 * Performance settings chosen automatically for the computer.
 *
 * On first startup, and whenever "Optimize for this computer" is pressed in
 * the Performance tab, processors, memory and graphics card are measured and
 * the five choices of that tab are derived from them. This module holds only
 * the decision, with no system access: the caller collects the measurements
 * (renderer/src/performance.ts), so the rule can be tested on its own
 * (tools/test-performance.ts).
 *
 * A speed benchmark would not help: none of the choices would depend on its
 * result, which is driven mostly by the user's frames.
 */

const GB = 1073741824

/** What is known about the computer. */
export interface ComputerData {
  logicalProcessors: number
  /** Installed memory, in bytes. */
  totalRam: number
  /** Threads chosen by the automatic rule (automaticWorkers in workers/pool.ts). */
  automaticThreads: number
  /** True if the viewer can create its graphics context (WebGL 2). */
  webgl2: boolean
  /** True if graphics acceleration is enabled in this session. */
  accelerationActive: boolean
  /** Name of the graphics card in use, if the system reports it. */
  gpuName: string | null
  /** Vendors of the graphics cards seen by the system (PCI IDs). */
  vendors: number[]
  /** True if the computer is currently running on battery. */
  onBattery: boolean
}

/** The choices of the Performance tab. */
export interface PerformanceChoices {
  analysisWorkers: number
  frameMemoryGB: number
  gpu: Gpu
  graphicsAcceleration: boolean
  lowPriorityComputation: boolean
}

export type GpuType = 'dedicated' | 'integrated' | 'unknown'

/** Memory each analysis thread must be able to rely on: it holds a whole frame. */
const MEMORY_PER_THREAD = 2 * GB
/** With this many logical processors or fewer, full-load computation stalls the rest of the computer. */
const FEW_PROCESSORS = 4

const NVIDIA_VENDOR = 0x10de
const INTEL_VENDOR = 0x8086

/** True if the name indicates software rendering on the CPU, without graphics acceleration. */
export function softwareRendering(name: string | null): boolean {
  return name !== null && /swiftshader|software|llvmpipe|basic render/i.test(name)
}

/** Dedicated or integrated, from the card name or, failing that, from the vendor. */
export function gpuType(name: string | null, vendors: number[]): GpuType {
  // Without acceleration the name is that of the software renderer, not of a card.
  if (softwareRendering(name)) return 'unknown'
  const n = (name ?? '').toLowerCase()
  if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b|radeon (rx|pro)|\barc\b/.test(n)) return 'dedicated'
  if (/intel|uhd|iris|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|apple m\d/.test(n)) return 'integrated'
  if (vendors.includes(NVIDIA_VENDOR)) return 'dedicated'
  if (vendors.length === 1 && vendors[0] === INTEL_VENDOR) return 'integrated'
  return 'unknown'
}

/** The best choices for the described computer. */
export function choicesForComputer(d: ComputerData): PerformanceChoices {
  const ramGB = d.totalRam / GB
  // Each thread keeps the frame it is analyzing in memory: with little
  // memory fewer threads are used, even if more processors are available.
  const byMemory = Math.max(1, Math.floor(ramGB / (MEMORY_PER_THREAD / GB)))
  const analysisWorkers = Math.max(1, Math.min(d.automaticThreads, byMemory))
  const frameMemoryGB = Math.max(1, Math.floor(recommendedBudget(d.totalRam) / GB))
  return {
    analysisWorkers,
    frameMemoryGB,
    // On computers with a single card the choice changes nothing; with two,
    // the dedicated one keeps the sliders smooth.
    gpu: 'high-performance',
    // If the graphics context cannot be created with acceleration enabled,
    // software rendering on the CPU is the only option that works.
    graphicsAcceleration: d.webgl2 || !d.accelerationActive,
    lowPriorityComputation: d.logicalProcessors <= FEW_PROCESSORS
  }
}

/** Order of the choices and the language keys of their names, as shown in the Performance tab. */
export const PERFORMANCE_ENTRIES: { key: keyof PerformanceChoices; nameKey: string }[] = [
  { key: 'analysisWorkers', nameKey: 'coreAutomaticPerformance.entries.analysisWorkers' },
  { key: 'frameMemoryGB', nameKey: 'coreAutomaticPerformance.entries.frameMemory' },
  { key: 'gpu', nameKey: 'coreAutomaticPerformance.entries.gpu' },
  { key: 'graphicsAcceleration', nameKey: 'coreAutomaticPerformance.entries.graphicsAcceleration' },
  { key: 'lowPriorityComputation', nameKey: 'coreAutomaticPerformance.entries.lowPriority' }
]

/** Decimal number written with the separator of the current language. */
function decimal(value: number): string {
  return formatNumber(value, { useGrouping: false, maximumFractionDigits: 20 })
}

/** A choice's value in words. 0 means "automatic" for threads and memory. */
export function describeChoice<K extends keyof PerformanceChoices>(key: K, value: PerformanceChoices[K]): string {
  switch (key) {
    case 'analysisWorkers':
      if (value === 0) return t('coreAutomaticPerformance.values.threadsAutomatic')
      return value === 1
        ? t('coreAutomaticPerformance.values.threadsOne')
        : t('coreAutomaticPerformance.values.threadsOther', { count: value as number })
    case 'frameMemoryGB':
      return value === 0
        ? t('coreAutomaticPerformance.values.memoryAutomatic')
        : t('coreAutomaticPerformance.values.gigabytes', { value: decimal(value as number) })
    case 'gpu':
      return value === 'low-power'
        ? t('coreAutomaticPerformance.values.gpuLowPower')
        : t('coreAutomaticPerformance.values.gpuHighPerformance')
    default:
      return value ? t('coreAutomaticPerformance.values.on') : t('coreAutomaticPerformance.values.off')
  }
}

/** The choices that would change when going from `current` to `newOnes`. */
export function chosenDifferences(
  current: PerformanceChoices,
  newOnes: PerformanceChoices
): { key: keyof PerformanceChoices; name: string; before: string; after: string }[] {
  return PERFORMANCE_ENTRIES.filter((v) => current[v.key] !== newOnes[v.key]).map((v) => ({
    key: v.key,
    name: t(v.nameKey),
    before: describeChoice(v.key, current[v.key]),
    after: describeChoice(v.key, newOnes[v.key])
  }))
}

/** Readable gigabytes: 31.9 GB installed is reported as 32 GB. */
function gigabytes(byte: number): string {
  const g = byte / GB
  return t('coreAutomaticPerformance.values.gigabytes', {
    value: decimal(g >= 10 ? Math.round(g) : Math.round(g * 10) / 10)
  })
}

/** Language keys of the displayed graphics card type. */
const GPU_TYPE_KEYS: Record<Exclude<GpuType, 'unknown'>, string> = {
  dedicated: 'coreAutomaticPerformance.recap.dedicated',
  integrated: 'coreAutomaticPerformance.recap.integrated'
}

/**
 * One-sentence summary: what the computer is and what was chosen. For
 * example "16 logical processors, 32 GB of memory, NVIDIA GeForce RTX 4060
 * (dedicated): 12 threads, 8 GB for frames, …".
 */
export function choicesRecap(
  d: Pick<ComputerData, 'logicalProcessors' | 'totalRam' | 'gpuName' | 'vendors' | 'webgl2'>,
  s: PerformanceChoices
): string {
  const type = gpuType(d.gpuName, d.vendors)
  const card = softwareRendering(d.gpuName)
    ? t('coreAutomaticPerformance.recap.softwareRendering')
    : (d.gpuName ?? t('coreAutomaticPerformance.recap.gpuUnknown')) +
      (type === 'unknown' ? '' : ' (' + t(GPU_TYPE_KEYS[type]) + ')')
  return t('coreAutomaticPerformance.recap.sentence', {
    processors: d.logicalProcessors,
    memory: gigabytes(d.totalRam),
    card,
    viewer: d.webgl2 ? '' : t('coreAutomaticPerformance.recap.viewerUnavailable'),
    threads: describeChoice('analysisWorkers', s.analysisWorkers),
    frameMemory: describeChoice('frameMemoryGB', s.frameMemoryGB),
    gpu:
      s.gpu === 'high-performance'
        ? t('coreAutomaticPerformance.recap.gpuHighPerformance')
        : t('coreAutomaticPerformance.recap.gpuLowPower'),
    acceleration: describeChoice('graphicsAcceleration', s.graphicsAcceleration),
    priority: s.lowPriorityComputation
      ? t('coreAutomaticPerformance.recap.priorityLow')
      : t('coreAutomaticPerformance.recap.priorityNormal')
  })
}
