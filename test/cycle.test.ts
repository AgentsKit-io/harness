import { expect, it } from 'vitest'
import { IMPROVEMENT_CYCLE_STEPS, assessImprovementCycle } from '../src/index.js'

const steps = (statuses: readonly ('passed' | 'failed' | 'blocked' | 'pending')[]) => IMPROVEMENT_CYCLE_STEPS.map((step, index) => ({ step, status: statuses[index]!, ...(statuses[index] === 'passed' ? {} : { reason: 'needs adjustment' }) }))

it('completes when all five steps pass and emits a matrix', () => {
  const result = assessImprovementCycle({ cycleId: 'pilot-1', maxIterations: 3, iterations: [{ iteration: 1, steps: steps(['passed', 'passed', 'passed', 'passed', 'passed']), metrics: { humanMinutes: 4 } }] })
  expect(result).toMatchObject({ decision: 'complete', matrix: [{ passRate: 1, passedSteps: 5, metrics: { humanMinutes: 4 } }] })
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
})

it('repeats only with an explicit adjustment and stops at the budget', () => {
  const first = { iteration: 1, steps: steps(['passed', 'failed', 'passed', 'passed', 'blocked']), adjustment: 'tighten G2 review evidence' }
  expect(assessImprovementCycle({ cycleId: 'pilot-1', maxIterations: 2, iterations: [first] })).toMatchObject({ decision: 'repeat', nextIteration: 2, matrix: [{ passRate: 0.6 }] })
  expect(assessImprovementCycle({ cycleId: 'pilot-1', maxIterations: 1, iterations: [first] })).toMatchObject({ decision: 'blocked' })
})

it('rejects malformed or ambiguous cycles', () => {
  expect(assessImprovementCycle({ cycleId: 'pilot-1', maxIterations: 2, iterations: [{ iteration: 1, steps: steps(['passed', 'failed', 'passed', 'passed', 'blocked']) }] })).toMatchObject({ decision: 'blocked', reasons: ['A failed or blocked step remains; an explicit adjustment is required before repeating.'] })
  expect(() => assessImprovementCycle({ cycleId: 'pilot-1', maxIterations: 2, iterations: [{ iteration: 1, steps: [...steps(['passed', 'passed', 'passed', 'passed', 'passed'])].reverse() }] })).toThrow(/must be adversarial-review/)
})
