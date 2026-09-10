import { cpus as cpuInfo, freemem, loadavg, totalmem } from 'node:os'
import type { MachineMetrics, MachineSample } from './types.js'

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

export const summarizeMachine = (samples: readonly MachineSample[], sampleIntervalMs = 5_000): MachineMetrics => {
  const load = samples.map((sample) => sample.load1PerCpuPercent)
  const memory = samples.map((sample) => sample.memoryUsedPercent)
  const rss = samples.map((sample) => sample.rssBytes)
  return {
    sampleIntervalMs,
    samples,
    peakLoad1PerCpuPercent: Number(Math.max(...load, 0).toFixed(2)),
    peakMemoryUsedPercent: Number(Math.max(...memory, 0).toFixed(2)),
    peakRssBytes: Math.max(...rss, 0),
    pressureEvents: samples.filter((sample) => sample.load1PerCpuPercent >= 90 || sample.memoryUsedPercent >= 90).length,
    throttleEvents: 0,
    minimumEffectiveConcurrency: 0,
  }
}

export const adaptiveConcurrency = (configured: number, sample: MachineSample): number => {
  if (sample.load1PerCpuPercent >= 90 || sample.memoryUsedPercent >= 90) return 1
  if (sample.load1PerCpuPercent >= 75 || sample.memoryUsedPercent >= 75) return Math.min(configured, 2)
  return configured
}

export const createMachineMonitor = (sampleIntervalMs = 5_000): { readonly sample: () => MachineSample; readonly observeConcurrency: (value: number) => void; readonly markThrottle: () => void; readonly stop: () => MachineMetrics } => {
  const samples: MachineSample[] = [sampleMachine()]
  let throttleEvents = 0
  const effectiveConcurrency: number[] = []
  const record = (): MachineSample => { const sample = sampleMachine(); samples.push(sample); return sample }
  const timer = setInterval(record, sampleIntervalMs)
  timer.unref()
  return {
    sample: record,
    observeConcurrency: (value) => effectiveConcurrency.push(value),
    markThrottle: () => { throttleEvents += 1 },
    stop: () => {
      clearInterval(timer)
      record()
      const summary = summarizeMachine(samples, sampleIntervalMs)
      return { ...summary, throttleEvents, minimumEffectiveConcurrency: effectiveConcurrency.length ? Math.min(...effectiveConcurrency) : 0 }
    },
  }
}
