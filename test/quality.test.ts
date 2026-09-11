import { expect, it } from 'vitest'
import { createQualityMatrix, evaluateWatchdog, validatePhaseTelemetry } from '../src/index.js'

const phase = (id: string, durationMs: number, outcome: 'pass' | 'block' = 'pass') => ({ phaseId: id, durationMs, attempts: 1, outcome, evidenceCoverage: outcome === 'pass' ? 1 : 0, tokens: { inputTokens: 10, outputTokens: 5 }, machine: { cpuPercent: 40, memoryUsedPercent: 50, peakConcurrency: 2, saturationPercent: 30 } })

it('validates phase telemetry and produces 0-100 matrix scores with baseline deltas', () => {
  const current = [phase('discover', 80), phase('implement', 120)]
  const baseline = [phase('discover', 100), phase('implement', 200)]
  const matrix = createQualityMatrix({ phases: current, baseline })
  expect(matrix.overall.score).toBeGreaterThanOrEqual(0)
  expect(matrix.overall.score).toBeLessThanOrEqual(100)
  expect(matrix.dimensions.speed).toMatchObject({ status: 'measured', score: 100, baselineDelta: 50 })
  expect(matrix.dimensions.cost).toMatchObject({ status: 'measured', score: 100, baselineDelta: 0 })
  expect(matrix.digest).toHaveLength(64)
  expect(validatePhaseTelemetry({ phaseId: 'x', outcome: 'unknown' })).toMatchObject({ phaseId: 'x', outcome: 'unknown' })
  expect(() => validatePhaseTelemetry({ phaseId: 'x', outcome: 'pass', evidenceCoverage: 2 })).toThrow(/evidenceCoverage/)
})

it('keeps missing telemetry unknown instead of scoring it as an improvement', () => {
  const matrix = createQualityMatrix({ phases: [{ phaseId: 'phase', outcome: 'pass', evidenceCoverage: 1 }] })
  expect(matrix.dimensions.speed).toMatchObject({ status: 'unknown', score: null, baselineDelta: null })
  expect(matrix.dimensions.cost).toMatchObject({ status: 'unknown', score: null, baselineDelta: null })
  expect(matrix.unknownMetricCount).toBeGreaterThan(0)
})

it('classifies watchdog duration, token, memory, and saturation breaches', () => {
  const result = evaluateWatchdog({ phases: [{ ...phase('hot', 1200), machine: { cpuPercent: 40, memoryUsedPercent: 90, peakConcurrency: 2, saturationPercent: 30 } }], budget: { maxDurationMs: 1000, maxTotalTokens: 10, maxMemoryUsedPercent: 80, maxSaturationPercent: 20 } })
  expect(result.status).toBe('blocked')
  expect(result.blockers.map((blocker) => blocker.class)).toEqual(expect.arrayContaining(['budget', 'resource', 'contention']))
  expect(evaluateWatchdog({ phases: [phase('ok', 10)], budget: { maxDurationMs: 1000, maxTotalTokens: 1000, maxMemoryUsedPercent: 80, maxSaturationPercent: 80 } })).toMatchObject({ status: 'ok', blockers: [] })
})
