import { expect, it } from 'vitest'
import { adaptiveConcurrency, summarizeMachine } from '../src/index.js'

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
