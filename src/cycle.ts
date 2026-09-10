import { createHash } from 'node:crypto'
import { fail } from './errors.js'

export const IMPROVEMENT_CYCLE_STEPS = ['adversarial-review', 'g2-preflight', 'baseline-record', 'pilot-execution', 'comparison'] as const
export type ImprovementCycleStep = typeof IMPROVEMENT_CYCLE_STEPS[number]
export type CycleStepStatus = 'passed' | 'failed' | 'blocked' | 'pending'

export interface CycleStepResult {
  readonly step: ImprovementCycleStep
  readonly status: CycleStepStatus
  readonly reason?: string
}

export interface CycleIterationMetrics {
  readonly durationMs?: number
  readonly humanMinutes?: number
  readonly attempts?: number
  readonly escapedIncomplete?: number
}

export interface ImprovementCycleIteration {
  readonly iteration: number
  readonly steps: readonly CycleStepResult[]
  readonly adjustment?: string
  readonly metrics?: CycleIterationMetrics
}

export interface ImprovementCycleInput {
  readonly cycleId: string
  readonly maxIterations: number
  readonly iterations: readonly ImprovementCycleIteration[]
}

export interface CycleMatrixRow {
  readonly iteration: number
  readonly passedSteps: number
  readonly totalSteps: number
  readonly passRate: number
  readonly statuses: Readonly<Record<ImprovementCycleStep, CycleStepStatus>>
  readonly adjustment?: string
  readonly metrics?: CycleIterationMetrics
}

export interface ImprovementCycleAssessment {
  readonly type: 'agentskit-harness-improvement-cycle'
  readonly cycleId: string
  readonly decision: 'complete' | 'repeat' | 'blocked'
  readonly nextIteration?: number
  readonly reasons: readonly string[]
  readonly matrix: readonly CycleMatrixRow[]
  readonly digest: string
}

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) return fail(`${label} must be a non-empty string.`, 'INVALID_INPUT')
  return value.trim()
}

const validateMetrics = (metrics: CycleIterationMetrics | undefined, index: number): CycleIterationMetrics | undefined => {
  if (metrics === undefined) return undefined
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return fail(`iterations[${index}].metrics.${key} must be a non-negative number.`, 'INVALID_INPUT')
  }
  return metrics
}

const validateIteration = (iteration: ImprovementCycleIteration, index: number): ImprovementCycleIteration => {
  if (typeof iteration !== 'object' || iteration === null || Array.isArray(iteration)) return fail(`iterations[${index}] must be an object.`, 'INVALID_INPUT')
  if (!Number.isInteger(iteration.iteration) || iteration.iteration < 1) return fail(`iterations[${index}].iteration must be a positive integer.`, 'INVALID_INPUT')
  if (!Array.isArray(iteration.steps) || iteration.steps.length !== IMPROVEMENT_CYCLE_STEPS.length) return fail(`iterations[${index}].steps must contain the five cycle steps exactly once, in order.`, 'INVALID_INPUT')
  iteration.steps.forEach((result, stepIndex) => {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return fail(`iterations[${index}].steps[${stepIndex}] must be an object.`, 'INVALID_INPUT')
    if (result.step !== IMPROVEMENT_CYCLE_STEPS[stepIndex]) return fail(`iterations[${index}].steps[${stepIndex}] must be ${IMPROVEMENT_CYCLE_STEPS[stepIndex]}.`, 'INVALID_INPUT')
    if (!['passed', 'failed', 'blocked', 'pending'].includes(result.status)) return fail(`iterations[${index}].steps[${stepIndex}].status is invalid.`, 'INVALID_INPUT')
    if (result.status !== 'passed' && !nonEmpty(result.reason, `iterations[${index}].steps[${stepIndex}].reason`)) return fail(`iterations[${index}].steps[${stepIndex}].reason is required when the step does not pass.`, 'INVALID_INPUT')
  })
  if (iteration.adjustment !== undefined) nonEmpty(iteration.adjustment, `iterations[${index}].adjustment`)
  return { ...iteration, metrics: validateMetrics(iteration.metrics, index) }
}

export const assessImprovementCycle = (input: ImprovementCycleInput): ImprovementCycleAssessment => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('cycle input must be an object.', 'INVALID_INPUT')
  const cycleId = nonEmpty(input.cycleId, 'cycleId')
  if (!Number.isInteger(input.maxIterations) || input.maxIterations < 1) return fail('maxIterations must be a positive integer.', 'INVALID_INPUT')
  if (!Array.isArray(input.iterations) || input.iterations.length < 1) return fail('iterations must be non-empty.', 'INVALID_INPUT')
  if (input.iterations.length > input.maxIterations) return fail('iterations cannot exceed maxIterations.', 'INVALID_INPUT')
  const iterations = input.iterations.map(validateIteration)
  iterations.forEach((iteration, index) => {
    if (iteration.iteration !== index + 1) return fail('iterations must be sequential and start at 1.', 'INVALID_INPUT')
    if (index > 0 && iterations[index - 1]?.steps.every((step) => step.status === 'passed')) return fail('a completed cycle cannot have later iterations.', 'INVALID_INPUT')
    if (index < iterations.length - 1 && !iteration.adjustment) return fail(`iterations[${index}].adjustment is required before repeating.`, 'INVALID_INPUT')
  })
  const matrix = iterations.map((iteration): CycleMatrixRow => {
    const statuses = Object.fromEntries(iteration.steps.map((step) => [step.step, step.status])) as Record<ImprovementCycleStep, CycleStepStatus>
    const passedSteps = iteration.steps.filter((step) => step.status === 'passed').length
    return { iteration: iteration.iteration, passedSteps, totalSteps: IMPROVEMENT_CYCLE_STEPS.length, passRate: Number((passedSteps / IMPROVEMENT_CYCLE_STEPS.length).toFixed(4)), statuses, ...(iteration.adjustment ? { adjustment: iteration.adjustment } : {}), ...(iteration.metrics ? { metrics: iteration.metrics } : {}) }
  })
  const latest = iterations[iterations.length - 1]!
  const complete = latest.steps.every((step) => step.status === 'passed')
  const reasons = complete ? ['All five cycle steps passed.'] : iterations.length >= input.maxIterations ? ['Maximum cycle iterations reached; human adjustment is required.'] : latest.adjustment ? ['A failed or blocked step remains; repeat with the recorded adjustment.'] : ['A failed or blocked step remains; an explicit adjustment is required before repeating.']
  const decision: ImprovementCycleAssessment['decision'] = complete ? 'complete' : iterations.length >= input.maxIterations || !latest.adjustment ? 'blocked' : 'repeat'
  const result = { type: 'agentskit-harness-improvement-cycle' as const, cycleId, decision, ...(decision === 'repeat' ? { nextIteration: latest.iteration + 1 } : {}), reasons, matrix }
  const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  return { ...result, digest }
}
