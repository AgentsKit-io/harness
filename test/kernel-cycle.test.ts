import { describe, expect, it } from 'vitest'
import { IMPROVEMENT_CYCLE_STEPS, assessImprovementCycle } from '../src/index.js'

const steps = (statuses: readonly ('passed' | 'failed' | 'blocked' | 'pending')[]) => IMPROVEMENT_CYCLE_STEPS.map((step, index) => ({ step, status: statuses[index]!, ...(statuses[index] === 'passed' ? {} : { reason: 'needs adjustment' }) }))
const allPassed = steps(['passed', 'passed', 'passed', 'passed', 'passed'])

describe('assessImprovementCycle: input validation', () => {
  it('rejects a non-object input', () => {
    expect(() => assessImprovementCycle(null as never)).toThrow(/cycle input must be an object/)
    expect(() => assessImprovementCycle([] as never)).toThrow(/cycle input must be an object/)
  })

  it('rejects a missing/blank cycleId', () => {
    expect(() => assessImprovementCycle({ cycleId: '', maxIterations: 1, iterations: [{ iteration: 1, steps: allPassed }] })).toThrow(/cycleId must be a non-empty string/)
  })

  it('rejects a non-positive or non-integer maxIterations', () => {
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 0, iterations: [{ iteration: 1, steps: allPassed }] })).toThrow(/maxIterations must be a positive integer/)
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1.5, iterations: [{ iteration: 1, steps: allPassed }] })).toThrow(/maxIterations must be a positive integer/)
  })

  it('rejects empty or non-array iterations', () => {
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [] })).toThrow(/iterations must be non-empty/)
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: 'nope' as never })).toThrow(/iterations must be non-empty/)
  })

  it('rejects more iterations than maxIterations allows', () => {
    const iterations = [{ iteration: 1, steps: steps(['failed', 'passed', 'passed', 'passed', 'passed']), adjustment: 'fix it' }, { iteration: 2, steps: allPassed }]
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations })).toThrow(/iterations cannot exceed maxIterations/)
  })

  it('rejects a non-sequential iteration number', () => {
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 2, iterations: [{ iteration: 2, steps: allPassed }] })).toThrow(/must be sequential and start at 1/)
  })

  it('rejects a later iteration after an already-complete one, even without an adjustment on it', () => {
    const iterations = [{ iteration: 1, steps: allPassed }, { iteration: 2, steps: allPassed }]
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 3, iterations })).toThrow(/a completed cycle cannot have later iterations/)
  })

  it('rejects a later iteration after an already-complete one that also happens to carry an adjustment', () => {
    const iterations = [{ iteration: 1, steps: allPassed, adjustment: 'unnecessary but present' }, { iteration: 2, steps: allPassed }]
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 3, iterations })).toThrow(/a completed cycle cannot have later iterations/)
  })

  it('rejects a non-final iteration missing its adjustment', () => {
    const iterations = [{ iteration: 1, steps: steps(['failed', 'passed', 'passed', 'passed', 'passed']) }, { iteration: 2, steps: allPassed }]
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 3, iterations })).toThrow(/iterations\[0\].adjustment is required before repeating/)
  })

  it('rejects a malformed iteration entry', () => {
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [null as never] })).toThrow(/iterations\[0\] must be an object/)
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [{ iteration: 0, steps: allPassed }] })).toThrow(/iterations\[0\].iteration must be a positive integer/)
  })

  it('rejects a steps array of the wrong length', () => {
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [{ iteration: 1, steps: allPassed.slice(0, 3) }] })).toThrow(/must contain the five cycle steps exactly once, in order/)
  })

  it('rejects a malformed step entry, an invalid status, and a missing reason on a non-passed step', () => {
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [{ iteration: 1, steps: [null, ...allPassed.slice(1)] as never }] })).toThrow(/steps\[0\] must be an object/)
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [{ iteration: 1, steps: [{ step: allPassed[0]!.step, status: 'unknown-status' }, ...allPassed.slice(1)] as never }] })).toThrow(/steps\[0\].status is invalid/)
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [{ iteration: 1, steps: [{ step: allPassed[0]!.step, status: 'failed' }, ...allPassed.slice(1)] as never }] })).toThrow(/steps\[0\].reason is required when the step does not pass/)
  })

  it('rejects a blank adjustment string when provided', () => {
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [{ iteration: 1, steps: allPassed, adjustment: '  ' }] })).toThrow(/adjustment must be a non-empty string/)
  })

  it('rejects a negative or non-finite metrics value', () => {
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [{ iteration: 1, steps: allPassed, metrics: { durationMs: -1 } }] })).toThrow(/metrics.durationMs must be a non-negative number/)
    expect(() => assessImprovementCycle({ cycleId: 'c', maxIterations: 1, iterations: [{ iteration: 1, steps: allPassed, metrics: { durationMs: Number.NaN } }] })).toThrow(/metrics.durationMs must be a non-negative number/)
  })
})
