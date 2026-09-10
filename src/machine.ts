import { cpus as cpuInfo, freemem, loadavg, totalmem } from 'node:os'
import type { MachineMetrics, MachineSample } from './types.js'
import { fail } from './errors.js'

export interface MachineThresholds {
  readonly warningPercent: number
  readonly criticalPercent: number
}

const thresholds = (value: Partial<MachineThresholds> = {}): MachineThresholds => {
  const result = { warningPercent: value.warningPercent ?? 75, criticalPercent: value.criticalPercent ?? 90 }
  if (![result.warningPercent, result.criticalPercent].every((item) => Number.isFinite(item) && item >= 0 && item <= 100) || result.warningPercent > result.criticalPercent) fail('Machine thresholds must be between 0 and 100 and warning must not exceed critical.', 'INVALID_INPUT')
  return result
}

const percentile95 = (values: readonly number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

export const sampleMachine = (): MachineSample => {
  const cpus = Math.max(1, cpuInfo().length)
  const load1 = Math.max(0, loadavg()[0] ?? 0)
  const memory = Math.max(0, Math.min(100, (1 - freemem() / Math.max(1, totalmem())) * 100))
  return {
    at: new Date().toISOString(),
    cpus,
    load1: Number(load1.toFixed(4)),
    load1PerCpuPercent: Number(Math.min(100, (load1 / cpus) * 100).toFixed(2)),
    memoryUsedPercent: Number(memory.toFixed(2)),
    rssBytes: process.memoryUsage().rss,
  }
}

export const summarizeMachine = (samples: readonly MachineSample[], sampleIntervalMs = 5_000, limits: Partial<MachineThresholds> = {}): MachineMetrics => {
  const limit = thresholds(limits)
  const load = samples.map((sample) => sample.load1PerCpuPercent)
  const memory = samples.map((sample) => sample.memoryUsedPercent)
  const rss = samples.map((sample) => sample.rssBytes)
  return {
    sampleIntervalMs,
    samples,
    peakLoad1PerCpuPercent: Number(Math.max(...load, 0).toFixed(2)),
    peakMemoryUsedPercent: Number(Math.max(...memory, 0).toFixed(2)),
    peakRssBytes: Math.max(...rss, 0),
    pressureEvents: samples.filter((sample) => sample.load1PerCpuPercent >= limit.criticalPercent || sample.memoryUsedPercent >= limit.criticalPercent || (sample.swapUsedPercent ?? 0) >= limit.criticalPercent || sample.memoryPressure === 'critical').length,
    throttleEvents: 0,
    minimumEffectiveConcurrency: 0,
  }
}

export const adaptiveConcurrency = (configured: number, sample: MachineSample, limits: Partial<MachineThresholds> = {}): number => {
  if (!Number.isInteger(configured) || configured < 1) throw new Error('configured concurrency must be a positive integer.')
  const limit = thresholds(limits)
  const critical = sample.load1PerCpuPercent >= limit.criticalPercent || sample.memoryUsedPercent >= limit.criticalPercent || (sample.swapUsedPercent ?? 0) >= limit.criticalPercent || sample.memoryPressure === 'critical'
  const warning = sample.load1PerCpuPercent >= limit.warningPercent || sample.memoryUsedPercent >= limit.warningPercent || (sample.swapUsedPercent ?? 0) >= limit.warningPercent || sample.memoryPressure === 'warning'
  if (critical) return 1
  if (warning) return Math.min(configured, 2)
  return configured
}

export const createMachineMonitor = (sampleIntervalMs = 5_000, options: { readonly sample?: () => MachineSample; readonly thresholds?: Partial<MachineThresholds> } = {}): { readonly sample: () => MachineSample; readonly observeConcurrency: (value: number) => void; readonly markThrottle: () => void; readonly stop: () => MachineMetrics } => {
  const sampler = options.sample ?? sampleMachine
  const limits = thresholds(options.thresholds)
  const samples: MachineSample[] = [sampler()]
  let throttleEvents = 0
  const effectiveConcurrency: number[] = []
  const record = (): MachineSample => { const sample = sampler(); samples.push(sample); return sample }
  const timer = setInterval(record, sampleIntervalMs)
  timer.unref()
  return {
    sample: record,
    observeConcurrency: (value) => effectiveConcurrency.push(value),
    markThrottle: () => { throttleEvents += 1 },
    stop: () => {
      clearInterval(timer)
      record()
      const summary = summarizeMachine(samples, sampleIntervalMs, limits)
      return { ...summary, throttleEvents, minimumEffectiveConcurrency: effectiveConcurrency.length ? Math.min(...effectiveConcurrency) : 0 }
    },
  }
}
