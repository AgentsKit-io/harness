import { fail } from './errors.js'
import { hashJson } from './hash.js'

export interface PilotEntry {
  readonly issueId: string
  readonly classification: 'normal' | 'incident' | 'sensitive'
  readonly status: 'included' | 'excluded' | 'aborted'
  readonly reason?: string
}

export interface PilotManifest {
  readonly policyHash: string
  readonly baselineReference: string
  readonly entries: readonly PilotEntry[]
}

export interface PilotAssessment {
  readonly decision: 'ready' | 'blocked'
  readonly included: readonly string[]
  readonly reasons: readonly string[]
  readonly digest: string
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

export const assessPilot = (manifest: PilotManifest): PilotAssessment => {
  required(manifest.policyHash, 'policyHash'); required(manifest.baselineReference, 'baselineReference')
  if (!Array.isArray(manifest.entries)) fail('entries must be an array.', 'INVALID_INPUT')
  const ids = new Set<string>()
  const reasons: string[] = []
  const included: string[] = []
  for (const entry of manifest.entries) {
    const issueId = required(entry.issueId, 'entry.issueId')
    if (ids.has(issueId)) fail('entry issueIds must be unique; an issue cannot be substituted in the same pilot.', 'INVALID_INPUT')
    ids.add(issueId)
    if (!['normal', 'incident', 'sensitive'].includes(entry.classification)) fail('entry.classification is invalid.', 'INVALID_INPUT')
    if (!['included', 'excluded', 'aborted'].includes(entry.status)) fail('entry.status is invalid.', 'INVALID_INPUT')
    if (entry.status !== 'included' && !entry.reason?.trim()) reasons.push(`${issueId} is ${entry.status} without an auditable reason.`)
    if (entry.status === 'included') {
      included.push(issueId)
      if (entry.classification !== 'normal') reasons.push(`${issueId} is ${entry.classification}; only normal issues can enter the pilot.`)
    }
  }
  if (included.length !== 10) reasons.push(`Pilot requires exactly 10 included issues; found ${included.length}.`)
  const base = { decision: reasons.length ? 'blocked' as const : 'ready' as const, included, reasons }
  return { ...base, digest: hashJson({ ...manifest, ...base }) }
}
