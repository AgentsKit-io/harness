import { fail } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'
import type { AdapterTelemetry, AssuranceLevel } from '../kernel/adapter-contract.js'

export interface TrackingTransition {
  readonly tracker: string
  readonly issue: string
  readonly from?: string
  readonly to: string
  readonly reason: string
  readonly idempotencyKey: string
}

export interface TrackingAdapter {
  readonly id: string
  readonly assurance?: AssuranceLevel
  readonly telemetry?: () => AdapterTelemetry
  transition(input: Omit<TrackingTransition, 'idempotencyKey'>): Promise<TrackingTransition>
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

export const createTrackingTransition = (input: Omit<TrackingTransition, 'idempotencyKey'>): TrackingTransition => {
  const transition = { tracker: required(input.tracker, 'tracker'), issue: required(input.issue, 'issue'), ...(input.from ? { from: required(input.from, 'from') } : {}), to: required(input.to, 'to'), reason: required(input.reason, 'reason') }
  return { ...transition, idempotencyKey: hashJson(transition) }
}

export const createTrackingAdapter = (id: string, handler: (input: TrackingTransition) => Promise<void> | void, options: { readonly dryRun?: boolean } = {}): TrackingAdapter => {
  const adapterId = required(id, 'id')
  const completed = new Set<string>()
  let writes = 0
  return {
    id: adapterId,
    assurance: 'contract-tested',
    telemetry: () => ({ status: 'measured', externalMutations: writes }),
    transition: async (input) => {
      const transition = createTrackingTransition(input)
      if (!completed.has(transition.idempotencyKey)) {
        if (!options.dryRun) { await handler(transition); writes += 1 }
        completed.add(transition.idempotencyKey)
      }
      return transition
    },
  }
}
