import { fail } from './errors.js'
import { hashJson } from './hash.js'

export interface DiscoveryOption {
  readonly id: string
  readonly summary: string
  readonly impact: string
}

export interface DiscoveryAmbiguity {
  readonly id: string
  readonly question: string
  readonly material: boolean
  readonly options: readonly DiscoveryOption[]
  readonly recommendedOptionId: string
  readonly assumptionId?: string
}

export interface ApprovedAssumption {
  readonly id: string
  readonly policyId: string
  readonly resolution: string
}

export interface DiscoveryInput {
  readonly issueId: string
  readonly sourceRevision: string
  readonly contractHash: string
  readonly contextHash?: string
  readonly ambiguities: readonly DiscoveryAmbiguity[]
  readonly approvedAssumptions?: readonly ApprovedAssumption[]
}

export interface DecisionPacket {
  readonly issueId: string
  readonly contractHash: string
  readonly sourceRevision: string
  readonly contextHash?: string
  readonly decisions: readonly {
    readonly id: string
    readonly question: string
    readonly options: readonly DiscoveryOption[]
    readonly recommendedOptionId: string
  }[]
}

export interface DiscoveryDecisionLogEntry {
  readonly ambiguityId: string
  readonly kind: 'human-decision-required' | 'approved-assumption'
  readonly detail: string
  readonly policyId?: string
}

export interface DiscoveryResult {
  readonly version: 1
  readonly issueId: string
  readonly sourceRevision: string
  readonly contractHash: string
  readonly contextHash?: string
  readonly status: 'ready' | 'awaiting-decision'
  readonly packet?: DecisionPacket
  readonly decisionLog: readonly DiscoveryDecisionLogEntry[]
  readonly digest: string
}

export interface DiscoveryCurrentInput {
  readonly sourceRevision: string
  readonly contractHash: string
  readonly contextHash?: string
}

export interface DiscoveryCurrentResult {
  readonly current: boolean
  readonly reasons: readonly ('source' | 'contract' | 'context')[]
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

const unique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) fail(`${label} must be unique.`, 'INVALID_INPUT')
}

const validate = (input: DiscoveryInput): { readonly assumptions: Map<string, ApprovedAssumption> } => {
  required(input.issueId, 'issueId')
  required(input.sourceRevision, 'sourceRevision')
  required(input.contractHash, 'contractHash')
  if (!Array.isArray(input.ambiguities)) fail('ambiguities must be an array.', 'INVALID_INPUT')
  unique(input.ambiguities.map((item) => required(item.id, 'ambiguity.id')), 'ambiguity ids')
  const assumptions = new Map<string, ApprovedAssumption>()
  for (const assumption of input.approvedAssumptions ?? []) {
    const id = required(assumption.id, 'assumption.id')
    if (assumptions.has(id)) fail('assumption ids must be unique.', 'INVALID_INPUT')
    assumptions.set(id, { id, policyId: required(assumption.policyId, 'assumption.policyId'), resolution: required(assumption.resolution, 'assumption.resolution') })
  }
  for (const ambiguity of input.ambiguities) {
    required(ambiguity.question, 'ambiguity.question')
    if (typeof ambiguity.material !== 'boolean') fail('ambiguity.material must be boolean.', 'INVALID_INPUT')
    if (!Array.isArray(ambiguity.options) || ambiguity.options.length < 2 || ambiguity.options.length > 4) fail('ambiguity.options must contain 2 to 4 options.', 'INVALID_INPUT')
    unique(ambiguity.options.map((option) => required(option.id, 'option.id')), 'option ids')
    for (const option of ambiguity.options) {
      required(option.summary, 'option.summary')
      required(option.impact, 'option.impact')
    }
    if (!ambiguity.options.some((option) => option.id === ambiguity.recommendedOptionId)) fail('recommendedOptionId must identify an option.', 'INVALID_INPUT')
    if (!ambiguity.material && (!ambiguity.assumptionId || !assumptions.has(ambiguity.assumptionId))) fail('non-material ambiguity requires an approved assumption.', 'INVALID_INPUT')
  }
  return { assumptions }
}

const digest = (result: Omit<DiscoveryResult, 'digest'>): string => hashJson(result)

export const assessDiscovery = (input: DiscoveryInput): DiscoveryResult => {
  const { assumptions } = validate(input)
  const human = input.ambiguities.filter((ambiguity) => ambiguity.material)
  const decisionLog: DiscoveryDecisionLogEntry[] = input.ambiguities.map((ambiguity) => {
    if (ambiguity.material) return { ambiguityId: ambiguity.id, kind: 'human-decision-required', detail: `Recommendation: ${ambiguity.recommendedOptionId}.` }
    const assumption = assumptions.get(ambiguity.assumptionId as string)!
    return { ambiguityId: ambiguity.id, kind: 'approved-assumption', detail: assumption.resolution, policyId: assumption.policyId }
  })
  const base = {
    version: 1 as const,
    issueId: input.issueId,
    sourceRevision: input.sourceRevision,
    contractHash: input.contractHash,
    ...(input.contextHash ? { contextHash: input.contextHash } : {}),
    status: human.length ? 'awaiting-decision' as const : 'ready' as const,
    ...(human.length ? { packet: {
      issueId: input.issueId,
      contractHash: input.contractHash,
      sourceRevision: input.sourceRevision,
      ...(input.contextHash ? { contextHash: input.contextHash } : {}),
      decisions: human.map((ambiguity) => ({ id: ambiguity.id, question: ambiguity.question, options: ambiguity.options, recommendedOptionId: ambiguity.recommendedOptionId })),
    } } : {}),
    decisionLog,
  }
  return { ...base, digest: digest(base) }
}

export const isDiscoveryCurrent = (result: DiscoveryResult, current: DiscoveryCurrentInput): DiscoveryCurrentResult => {
  const reasons: ('source' | 'contract' | 'context')[] = []
  if (result.sourceRevision !== current.sourceRevision) reasons.push('source')
  if (result.contractHash !== current.contractHash) reasons.push('contract')
  if ((result.contextHash ?? '') !== (current.contextHash ?? '')) reasons.push('context')
  return { current: reasons.length === 0, reasons }
}
