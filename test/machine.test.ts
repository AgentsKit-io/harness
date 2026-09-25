import { describe, expect, it } from 'vitest'
import { adaptiveConcurrency, measureCpuBusyPercent, summarizeMachine } from '../src/index.js'

it('summarizes machine pressure without external dependencies', () => {
  const metrics = summarizeMachine([
    { at: '2026-01-01T00:00:00.000Z', cpus: 4, load1: 1, load1PerCpuPercent: 25, memoryUsedPercent: 50, rssBytes: 10 },
    { at: '2026-01-01T00:00:05.000Z', cpus: 4, load1: 4, load1PerCpuPercent: 100, memoryUsedPercent: 91, rssBytes: 20 },
  ])
  expect(metrics.peakLoad1PerCpuPercent).toBe(100)
  expect(metrics.peakMemoryUsedPercent).toBe(91)
  expect(metrics.peakRssBytes).toBe(20)
  expect(metrics.pressureEvents).toBe(1)
  expect(metrics.throttleEvents).toBe(0)
  expect(adaptiveConcurrency(4, { at: '2026-01-01T00:00:00.000Z', cpus: 4, load1: 1, load1PerCpuPercent: 50, memoryUsedPercent: 50, rssBytes: 1 })).toBe(4)
  expect(adaptiveConcurrency(4, { at: '2026-01-01T00:00:00.000Z', cpus: 4, load1: 3, load1PerCpuPercent: 75, memoryUsedPercent: 50, rssBytes: 1 })).toBe(2)
  expect(adaptiveConcurrency(4, { at: '2026-01-01T00:00:00.000Z', cpus: 4, load1: 4, load1PerCpuPercent: 100, memoryUsedPercent: 50, rssBytes: 1 })).toBe(1)
})

describe('pressure from measured CPU busy share', () => {
  it('does not cap concurrency on a high load average when the CPU is mostly idle', () => {
    const idleButLoaded = { at: 't', cpus: 10, load1: 8, load1PerCpuPercent: 80, cpuBusyPercent: 18, memoryUsedPercent: 40, rssBytes: 1 }
    expect(adaptiveConcurrency(4, idleButLoaded)).toBe(4)
    // Without the measurement the load average still decides, as before.
    const { cpuBusyPercent: _unused, ...unmeasured } = idleButLoaded
    expect(adaptiveConcurrency(4, unmeasured)).toBe(2)
    // A genuinely busy CPU still caps.
    expect(adaptiveConcurrency(4, { ...idleButLoaded, cpuBusyPercent: 95 })).toBe(1)
  })

  it('measures a busy share between 0 and 100', () => {
    const busy = measureCpuBusyPercent(50)
    expect(busy === null || (busy >= 0 && busy <= 100)).toBe(true)
  })
})
