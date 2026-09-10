import { fail } from './errors.js'

export interface RuntimeExperimentCandidate {
  readonly runtime: string
  readonly sourceRevision: string
  readonly contractHash: string
  readonly provider: string
  readonly model: string
  readonly configurationHash: string
  readonly hardGatesPassed: boolean
  readonly humanMinutes: number
  readonly durationMs: number
  readonly cost: number
}

export interface RuntimeExperimentResult {
  readonly decision: 'selected' | 'blocked'
  readonly selected?: RuntimeExperimentCandidate
  readonly eligible: readonly RuntimeExperimentCandidate[]
  readonly reason: string
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

const comparable = (candidate: RuntimeExperimentCandidate, baseline: RuntimeExperimentCandidate): void => {
  for (const key of ['sourceRevision', 'contractHash', 'provider', 'model', 'configurationHash'] as const) {
    if (candidate[key] !== baseline[key]) fail(`Candidates must share ${key}.`, 'INVALID_INPUT')
  }
}

export const selectRuntime = (candidates: readonly RuntimeExperimentCandidate[]): RuntimeExperimentResult => {
  if (!Array.isArray(candidates) || candidates.length < 2) fail('At least two runtime candidates are required.', 'INVALID_INPUT')
  const names = new Set<string>()
  for (const candidate of candidates) {
    const runtime = required(candidate.runtime, 'candidate.runtime')
    if (names.has(runtime)) fail('candidate.runtime values must be unique.', 'INVALID_INPUT')
    names.add(runtime)
    for (const key of ['sourceRevision', 'contractHash', 'provider', 'model', 'configurationHash'] as const) required(candidate[key], `candidate.${key}`)
    for (const key of ['humanMinutes', 'durationMs', 'cost'] as const) if (!Number.isFinite(candidate[key]) || candidate[key] < 0) fail(`candidate.${key} must be a non-negative number.`, 'INVALID_INPUT')
    comparable(candidate, candidates[0]!)
  }
  const eligible = candidates.filter((candidate) => candidate.hardGatesPassed)
  if (!eligible.length) return { decision: 'blocked', eligible, reason: 'No runtime passed every hard gate.' }
  const selected = [...eligible].sort((left, right) => left.humanMinutes - right.humanMinutes || left.durationMs - right.durationMs || left.cost - right.cost || (left.runtime === 'orca' ? -1 : right.runtime === 'orca' ? 1 : left.runtime.localeCompare(right.runtime)))[0]
  return { decision: 'selected', selected, eligible, reason: 'Selected by human minutes, duration, cost, then Orca tie-break.' }
}
