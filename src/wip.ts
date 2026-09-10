import { fail } from './errors.js'

export const WIP_STATES = ['ready', 'implementing', 'blocked', 'awaiting-decision', 'awaiting-acceptance', 'done', 'cancelled'] as const
export type WipState = typeof WIP_STATES[number]

export interface WipEntry {
  readonly issueId: string
  readonly state: WipState
}

export interface WipAssessmentInput {
  readonly entries: readonly WipEntry[]
  readonly candidate: { readonly issueId: string; readonly kind: 'new' | 'resume' }
  readonly maxInFlight?: number
}

export interface WipAssessment {
  readonly decision: 'admit' | 'hold'
  readonly inFlight: readonly WipEntry[]
  readonly counts: Readonly<Record<WipState, number>>
  readonly reason: string
}

const terminal = new Set<WipState>(['done', 'cancelled'])

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

export const assessWip = ({ entries, candidate, maxInFlight = 3 }: WipAssessmentInput): WipAssessment => {
  if (!Array.isArray(entries)) fail('entries must be an array.', 'INVALID_INPUT')
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) fail('maxInFlight must be a positive integer.', 'INVALID_INPUT')
  const candidateId = required(candidate.issueId, 'candidate.issueId')
  if (candidate.kind !== 'new' && candidate.kind !== 'resume') fail('candidate.kind must be new or resume.', 'INVALID_INPUT')
  const ids = new Set<string>()
  const counts = Object.fromEntries(WIP_STATES.map((state) => [state, 0])) as Record<WipState, number>
  for (const entry of entries) {
    const id = required(entry.issueId, 'entry.issueId')
    if (ids.has(id)) fail('entry issueIds must be unique.', 'INVALID_INPUT')
    ids.add(id)
    if (!WIP_STATES.includes(entry.state)) fail(`Unknown WIP state: ${entry.state}.`, 'INVALID_INPUT')
    counts[entry.state] += 1
  }
  const inFlight = entries.filter((entry) => !terminal.has(entry.state))
  const existing = entries.find((entry) => entry.issueId === candidateId)
  if (candidate.kind === 'resume') {
    if (!existing || terminal.has(existing.state)) return { decision: 'hold', inFlight, counts, reason: 'A resume requires an existing non-terminal issue.' }
    return { decision: 'admit', inFlight, counts, reason: 'A resume keeps its existing WIP reservation and takes priority over new work.' }
  }
  if (existing) return { decision: 'hold', inFlight, counts, reason: 'A new admission cannot reuse an existing issue id.' }
  if (inFlight.length >= maxInFlight) return { decision: 'hold', inFlight, counts, reason: `WIP limit ${maxInFlight} reached; blocked and awaiting-human work still count.` }
  return { decision: 'admit', inFlight, counts, reason: `WIP slot available (${inFlight.length}/${maxInFlight}).` }
}
