import { hashJson } from '../kernel/hash.js'
import { fail } from '../kernel/errors.js'
import { runWorkflow } from '../kernel/workflow.js'
import type { GateBinding } from './index.js'

export interface ReviewLens {
  readonly id: string
  readonly maxAttempts?: number
}

export interface ReviewVerdict {
  readonly status: 'pass' | 'finding' | 'unverified'
  readonly reason?: string
  readonly evidence?: string
  readonly reproduction?: string
  readonly retryable?: boolean
}

export interface AdversarialReviewResult {
  readonly decision: 'approved' | 'blocked'
  readonly verdicts: Readonly<Record<string, ReviewVerdict>>
  readonly reasons: readonly string[]
  readonly binding: GateBinding
  readonly digest: string
  readonly peakConcurrency: number
}

export const runAdversarialReview = async ({ lenses, reviewer, binding, maxConcurrency = 3 }: { readonly lenses: readonly ReviewLens[]; readonly reviewer: (lens: ReviewLens, attempt: number) => Promise<ReviewVerdict> | ReviewVerdict; readonly binding: GateBinding; readonly maxConcurrency?: number }): Promise<AdversarialReviewResult> => {
  if (!Array.isArray(lenses) || lenses.length === 0) fail('At least one review lens is required.', 'INVALID_INPUT')
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) fail('maxConcurrency must be a positive integer.', 'INVALID_INPUT')
  const normalized = lenses.map((lens) => {
    if (typeof lens !== 'object' || lens === null || Array.isArray(lens) || typeof lens.id !== 'string' || !lens.id.trim()) fail('Review lens id is required.', 'INVALID_INPUT')
    const maxAttempts = lens.maxAttempts ?? 1
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) fail('Review lens maxAttempts must be between 1 and 3.', 'INVALID_INPUT')
    return { id: lens.id.trim(), maxAttempts }
  })
  if (new Set(normalized.map((lens) => lens.id)).size !== normalized.length) fail('Review lens ids must be unique.', 'INVALID_INPUT')
  const workflow = await runWorkflow(normalized.map((lens) => ({ id: lens.id, run: async (): Promise<ReviewVerdict> => {
    let last: ReviewVerdict = { status: 'unverified', reason: 'Reviewer returned no verdict.' }
    for (let attempt = 1; attempt <= lens.maxAttempts; attempt += 1) {
      try {
        const verdict = await reviewer(lens, attempt)
        if (!verdict || !['pass', 'finding', 'unverified'].includes(verdict.status)) return { status: 'unverified', reason: 'Reviewer returned an invalid verdict.' }
        last = verdict
        if (verdict.status !== 'unverified' || verdict.retryable !== true) return verdict
      } catch (error) { last = { status: 'unverified', reason: error instanceof Error ? error.message : String(error) } }
    }
    return last
  } })), { maxConcurrency })
  const verdicts = Object.fromEntries(Object.entries(workflow.results).sort(([left], [right]) => left.localeCompare(right)))
  const reasons = Object.entries(verdicts).flatMap(([id, verdict]) => verdict.status === 'pass' ? [] : verdict.status === 'finding' && (verdict.evidence?.trim() || verdict.reproduction?.trim()) ? [`${id} found an issue: ${verdict.reason ?? 'evidence recorded'}.`] : [`${id} is unverified or lacks reproducible evidence.`])
  const base = { verdicts, reasons, binding, peakConcurrency: workflow.peakConcurrency }
  return { decision: reasons.length ? 'blocked' : 'approved', ...base, digest: hashJson(base) }
}
