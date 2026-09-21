import { describe, expect, it } from 'vitest'
import { adaptiveConcurrency, createMachineMonitor, sampleMachine, summarizeMachine } from '../src/index.js'

describe('sampleMachine', () => {
  it('reads real OS metrics into a well-shaped, bounded sample', () => {
    const sample = sampleMachine()
    expect(sample.cpus).toBeGreaterThanOrEqual(1)
    expect(sample.load1).toBeGreaterThanOrEqual(0)
    expect(sample.load1PerCpuPercent).toBeGreaterThanOrEqual(0)
    expect(sample.load1PerCpuPercent).toBeLessThanOrEqual(100)
    expect(sample.memoryUsedPercent).toBeGreaterThanOrEqual(0)
    expect(sample.memoryUsedPercent).toBeLessThanOrEqual(100)
    expect(sample.rssBytes).toBeGreaterThan(0)
    expect(Date.parse(sample.at)).not.toBeNaN()
  })
})

describe('summarizeMachine', () => {
  it('handles an empty sample list without throwing', () => {
    const metrics = summarizeMachine([])
    expect(metrics).toMatchObject({ peakLoad1PerCpuPercent: 0, peakMemoryUsedPercent: 0, peakRssBytes: 0, pressureEvents: 0 })
  })

  it('counts a pressure event from swapUsedPercent or an explicit memoryPressure flag, not just load/memory', () => {
    const bySwap = summarizeMachine([{ at: 't', cpus: 4, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1, swapUsedPercent: 95 }])
    expect(bySwap.pressureEvents).toBe(1)
    const byFlag = summarizeMachine([{ at: 't', cpus: 4, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1, memoryPressure: 'critical' }])
    expect(byFlag.pressureEvents).toBe(1)
  })

  it('applies custom thresholds instead of the 75/90 defaults', () => {
    const metrics = summarizeMachine([{ at: 't', cpus: 4, load1: 0, load1PerCpuPercent: 50, memoryUsedPercent: 0, rssBytes: 1 }], 5_000, { warningPercent: 30, criticalPercent: 40 })
    expect(metrics.pressureEvents).toBe(1)
  })

  it('rejects thresholds outside 0-100 or with warning above critical', () => {
    expect(() => summarizeMachine([], 5_000, { warningPercent: -1 })).toThrow(/Machine thresholds must be between 0 and 100/)
    expect(() => summarizeMachine([], 5_000, { warningPercent: 101 })).toThrow(/Machine thresholds must be between 0 and 100/)
    expect(() => summarizeMachine([], 5_000, { warningPercent: 95, criticalPercent: 90 })).toThrow(/warning must not exceed critical/)
  })
})

describe('adaptiveConcurrency', () => {
  it('rejects a non-positive or non-integer configured concurrency', () => {
    expect(() => adaptiveConcurrency(0, { at: 't', cpus: 1, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1 })).toThrow(/must be a positive integer/)
    expect(() => adaptiveConcurrency(1.5, { at: 't', cpus: 1, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1 })).toThrow(/must be a positive integer/)
  })

  it('treats high swapUsedPercent or an explicit memoryPressure flag as critical/warning too', () => {
    expect(adaptiveConcurrency(4, { at: 't', cpus: 1, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1, swapUsedPercent: 95 })).toBe(1)
    expect(adaptiveConcurrency(4, { at: 't', cpus: 1, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1, swapUsedPercent: 80 })).toBe(2)
    expect(adaptiveConcurrency(4, { at: 't', cpus: 1, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1, memoryPressure: 'critical' })).toBe(1)
    expect(adaptiveConcurrency(4, { at: 't', cpus: 1, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1, memoryPressure: 'warning' })).toBe(2)
  })
})

describe('createMachineMonitor', () => {
  it('takes an initial sample, records more on demand, tracks throttles/concurrency, and summarizes on stop', () => {
    const readings = [
      { at: 't0', cpus: 4, load1: 0, load1PerCpuPercent: 10, memoryUsedPercent: 10, rssBytes: 1 },
      { at: 't1', cpus: 4, load1: 0, load1PerCpuPercent: 95, memoryUsedPercent: 95, rssBytes: 2 },
    ]
    let index = 0
    const monitor = createMachineMonitor(5_000, { sample: () => readings[Math.min(index++, readings.length - 1)]! })
    monitor.observeConcurrency(4)
    monitor.observeConcurrency(1)
    monitor.markThrottle()
    const sampled = monitor.sample()
    expect(sampled).toEqual(readings[1])
    const summary = monitor.stop()
    expect(summary.throttleEvents).toBe(1)
    expect(summary.minimumEffectiveConcurrency).toBe(1)
    expect(summary.pressureEvents).toBeGreaterThan(0) // the 95% reading crosses the default 90% critical threshold
  })

  it('reports zero minimumEffectiveConcurrency when observeConcurrency was never called', () => {
    const monitor = createMachineMonitor(5_000, { sample: () => ({ at: 't', cpus: 1, load1: 0, load1PerCpuPercent: 0, memoryUsedPercent: 0, rssBytes: 1 }) })
    expect(monitor.stop().minimumEffectiveConcurrency).toBe(0)
  })

  it('says whether the load average is a real reading', () => {
    // Windows' `os.loadavg()` returns [0, 0, 0] whatever the machine is doing. Reporting that as 0% would make
    // a busy machine look idle; the sample says the number is not a measurement instead.
    const sample = sampleMachine()
    expect(sample.loadAvailable).toBe(process.platform !== 'win32')
    if (sample.loadAvailable === false) expect(sample.load1).toBe(0)
  })
})
