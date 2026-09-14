import { describe, expect, it } from 'vitest'
import { createQualityMatrix, evaluateWatchdog, validatePhaseTelemetry } from '../src/index.js'

describe('validatePhaseTelemetry validation', () => {
  it('rejects a non-object value', () => {
    expect(() => validatePhaseTelemetry(null)).toThrow(/Phase telemetry must be an object/)
    expect(() => validatePhaseTelemetry([])).toThrow(/Phase telemetry must be an object/)
  })

  it('rejects an invalid outcome', () => {
    expect(() => validatePhaseTelemetry({ phaseId: 'x', outcome: 'timeout' })).toThrow(/outcome is invalid/)
  })

  it('rejects a blank phaseId', () => {
    expect(() => validatePhaseTelemetry({ phaseId: '  ', outcome: 'pass' })).toThrow(/phaseId is required/)
  })

  it('rejects a non-integer attempts value', () => {
    expect(() => validatePhaseTelemetry({ phaseId: 'x', outcome: 'pass', attempts: 1.5 })).toThrow(/attempts must be an integer/)
  })

  it('rejects an out-of-range or non-finite token/machine metric', () => {
    expect(() => validatePhaseTelemetry({ phaseId: 'x', outcome: 'pass', tokens: { inputTokens: -1 } })).toThrow(/tokens.inputTokens/)
    expect(() => validatePhaseTelemetry({ phaseId: 'x', outcome: 'pass', machine: { cpuPercent: 150 } })).toThrow(/machine.cpuPercent/)
  })

  it('rejects a blank failureClass and a non-finite durationMs', () => {
    expect(() => validatePhaseTelemetry({ phaseId: 'x', outcome: 'pass', failureClass: '  ' })).toThrow(/phaseId is required/)
    expect(() => validatePhaseTelemetry({ phaseId: 'x', outcome: 'pass', durationMs: -1 })).toThrow(/durationMs/)
  })
})

describe('createQualityMatrix with partial telemetry', () => {
  it('treats speed/cost as unknown when the baseline reports no duration or token telemetry at all', () => {
    const matrix = createQualityMatrix({
      phases: [{ phaseId: 'a', outcome: 'pass', durationMs: 10, tokens: { inputTokens: 1, outputTokens: 1 } }],
      baseline: [{ phaseId: 'a', outcome: 'pass' }],
    })
    expect(matrix.dimensions.speed).toMatchObject({ status: 'unknown', score: null })
    expect(matrix.dimensions.cost).toMatchObject({ status: 'unknown', score: null })
  })

  it('picks up duration/token telemetry from only some current phases when computing the aggregate', () => {
    const matrix = createQualityMatrix({
      phases: [
        { phaseId: 'a', outcome: 'pass', durationMs: 10, tokens: { inputTokens: 1, outputTokens: 1 } },
        { phaseId: 'b', outcome: 'pass' },
      ],
      baseline: [{ phaseId: 'a', outcome: 'pass', durationMs: 20, tokens: { inputTokens: 2, outputTokens: 2 } }],
    })
    expect(matrix.dimensions.speed).toMatchObject({ status: 'measured', score: 100 })
    expect(matrix.dimensions.cost).toMatchObject({ status: 'measured', score: 100 })
  })

  it('scores correctness as 0 for a phase with no evidenceCoverage reported', () => {
    const matrix = createQualityMatrix({ phases: [{ phaseId: 'a', outcome: 'pass' }] })
    expect(matrix.dimensions.correctness).toMatchObject({ status: 'measured', score: 0 })
  })

  it('reports completeness/reliability as unknown for an empty phase list', () => {
    const matrix = createQualityMatrix({ phases: [] })
    expect(matrix.dimensions.completeness).toMatchObject({ status: 'unknown', score: null })
    expect(matrix.dimensions.reliability).toMatchObject({ status: 'unknown', score: null })
    expect(matrix.phaseCount).toBe(0)
  })

  it('reports resource as unknown when no phase carries both cpuPercent and memoryUsedPercent', () => {
    const matrix = createQualityMatrix({ phases: [{ phaseId: 'a', outcome: 'pass', machine: { cpuPercent: 10 } }] })
    expect(matrix.dimensions.resource).toMatchObject({ status: 'unknown', score: null })
  })

  it('omits the baseline entirely when none is supplied', () => {
    const matrix = createQualityMatrix({ phases: [{ phaseId: 'a', outcome: 'pass', durationMs: 10 }] })
    expect(matrix.dimensions.speed).toMatchObject({ status: 'unknown' })
  })
})

describe('evaluateWatchdog with mixed telemetry', () => {
  it('skips the duration and token budgets when any phase is missing that telemetry', () => {
    const result = evaluateWatchdog({
      phases: [{ phaseId: 'a', outcome: 'pass', durationMs: 5000, tokens: { inputTokens: 100, outputTokens: 100 } }, { phaseId: 'b', outcome: 'pass' }],
      budget: { maxDurationMs: 1, maxTotalTokens: 1 },
    })
    expect(result).toEqual({ status: 'ok', blockers: [] })
  })
})
