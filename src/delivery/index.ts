import { fail } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'

export type CriterionStatus = 'passed' | 'failed' | 'pending' | 'not-applicable'
export interface GateCriterion { readonly id: string; readonly gate: 'G2' | 'G3' | 'G4' | 'G5'; readonly status: CriterionStatus; readonly reason?: string }
export interface GateBinding { readonly candidateRevision: string; readonly contractHash: string; readonly configHash: string }
export interface GateAssessment { readonly gate: 'G2' | 'G3' | 'G4' | 'G5'; readonly decision: 'approved' | 'blocked' | 'awaiting-acceptance'; readonly reasons: readonly string[]; readonly binding: GateBinding; readonly digest: string }

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

const criteriaFor = (criteria: readonly GateCriterion[], gate: GateCriterion['gate']): readonly GateCriterion[] => {
  if (!Array.isArray(criteria)) fail('criteria must be an array.', 'INVALID_INPUT')
  const ids = new Set<string>()
  for (const criterion of criteria) {
    const id = required(criterion.id, 'criterion.id')
    if (ids.has(id)) fail('criterion ids must be unique.', 'INVALID_INPUT')
    ids.add(id)
    if (!['G2', 'G3', 'G4', 'G5'].includes(criterion.gate)) fail('criterion.gate is invalid.', 'INVALID_INPUT')
    if (!['passed', 'failed', 'pending', 'not-applicable'].includes(criterion.status)) fail('criterion.status is invalid.', 'INVALID_INPUT')
    if (criterion.status === 'not-applicable' && !criterion.reason?.trim()) fail('not-applicable criteria require a reason.', 'INVALID_INPUT')
  }
  return criteria.filter((criterion) => criterion.gate === gate)
}

const binding = (value: GateBinding): GateBinding => ({ candidateRevision: required(value.candidateRevision, 'binding.candidateRevision'), contractHash: required(value.contractHash, 'binding.contractHash'), configHash: required(value.configHash, 'binding.configHash') })
const assessed = (gate: GateAssessment['gate'], decision: GateAssessment['decision'], reasons: readonly string[], current: GateBinding): GateAssessment => {
  const base = { gate, decision, reasons, binding: binding(current) }
  return { ...base, digest: hashJson(base) }
}

export const assessPreflight = ({ criteria, repairAttempts = 0, implementerId, reviewerId, reviewKind, reviewApproved, binding: current }: { readonly criteria: readonly GateCriterion[]; readonly repairAttempts?: number; readonly implementerId: string; readonly reviewerId?: string; readonly reviewKind?: 'adversarial'; readonly reviewApproved: boolean; readonly binding: GateBinding }): GateAssessment => {
  required(implementerId, 'implementerId')
  if (!Number.isInteger(repairAttempts) || repairAttempts < 0) fail('repairAttempts must be a non-negative integer.', 'INVALID_INPUT')
  const g2 = criteriaFor(criteria, 'G2')
  const reasons = [
    ...(g2.length ? [] : ['No G2 criteria are defined.']),
    ...g2.filter((criterion) => criterion.status === 'failed' || criterion.status === 'pending').map((criterion) => `${criterion.id} is ${criterion.status}.`),
    ...(reviewApproved && reviewerId && reviewerId !== implementerId && reviewKind === 'adversarial' ? [] : ['An approved adversarial review by a reviewer different from the implementer is required.']),
    ...(repairAttempts <= 2 ? [] : ['The two-repair limit was exceeded; preserve diagnostics and return blocked.']),
  ]
  return assessed('G2', reasons.length ? 'blocked' : 'approved', reasons, current)
}

export interface PullRequestDraft {
  readonly issueId: string
  readonly candidateRevision: string
  readonly contractHash: string
  readonly configHash: string
  readonly g2Digest: string
  readonly evidence: readonly string[]
  readonly documentation: readonly string[]
  readonly risk: string
  readonly rollback: string
  readonly pendingCriteria: readonly string[]
}

export const composePullRequest = ({ draft, g2, remote }: { readonly draft: PullRequestDraft; readonly g2: GateAssessment; readonly remote?: { readonly state: 'missing' | 'confirmed' | 'uncertain'; readonly url?: string; readonly candidateRevision?: string } }): { readonly decision: 'create' | 'reuse' | 'blocked'; readonly body?: string; readonly reason: string; readonly idempotencyKey: string } => {
  for (const [label, value] of Object.entries({ issueId: draft.issueId, candidateRevision: draft.candidateRevision, contractHash: draft.contractHash, configHash: draft.configHash, g2Digest: draft.g2Digest, risk: draft.risk, rollback: draft.rollback })) required(value, `draft.${label}`)
  if (g2.gate !== 'G2' || g2.decision !== 'approved' || g2.digest !== draft.g2Digest || g2.binding.candidateRevision !== draft.candidateRevision || g2.binding.contractHash !== draft.contractHash || g2.binding.configHash !== draft.configHash) return { decision: 'blocked', reason: 'A current approved G2 assessment is required before a PR can be created.', idempotencyKey: hashJson(draft) }
  const idempotencyKey = hashJson({ issueId: draft.issueId, contractHash: draft.contractHash, action: 'pull-request', revision: draft.candidateRevision })
  if (remote?.state === 'uncertain') return { decision: 'blocked', reason: 'Remote PR state is uncertain; reconcile before retrying.', idempotencyKey }
  if (remote?.state === 'confirmed') {
    if (remote.candidateRevision !== draft.candidateRevision || !remote.url) return { decision: 'blocked', reason: 'Confirmed remote PR does not match the candidate revision.', idempotencyKey }
    return { decision: 'reuse', reason: 'The idempotent remote PR already exists for this candidate revision.', idempotencyKey }
  }
  const body = [`## Contract`, `- Issue: ${draft.issueId}`, `- Candidate: ${draft.candidateRevision}`, `- Contract: ${draft.contractHash}`, `- Configuration: ${draft.configHash}`, '', '## G2 evidence', ...draft.evidence.map((item) => `- ${item}`), '', '## Documentation', ...draft.documentation.map((item) => `- ${item}`), '', '## Risk and rollback', `- Risk: ${draft.risk}`, `- Rollback: ${draft.rollback}`, '', '## Later gates', ...(draft.pendingCriteria.length ? draft.pendingCriteria.map((item) => `- Pending: ${item}`) : ['- None.'])].join('\n')
  return { decision: 'create', body, reason: 'G2 is current and the remote PR is absent.', idempotencyKey }
}

export interface PullRequestApproval {
  readonly approvedBy: 'human'
  readonly candidateRevision: string
  readonly contractHash: string
  readonly configHash: string
  readonly bodyHash: string
  readonly metadataHash: string
  readonly digest: string
}

export const createPullRequestApproval = ({ body, metadata, approvedBy, candidateRevision, contractHash, configHash }: { readonly body: string; readonly metadata: Readonly<Record<string, unknown>>; readonly approvedBy: 'human'; readonly candidateRevision: string; readonly contractHash: string; readonly configHash: string }): PullRequestApproval => {
  if (approvedBy !== 'human') fail('Pull request approval requires a human actor.', 'HUMAN_APPROVAL_REQUIRED')
  const normalizedBody = required(body, 'PR body')
  const binding = { approvedBy, candidateRevision: required(candidateRevision, 'candidateRevision'), contractHash: required(contractHash, 'contractHash'), configHash: required(configHash, 'configHash'), bodyHash: hashJson(normalizedBody), metadataHash: hashJson(metadata) }
  return { ...binding, digest: hashJson(binding) }
}

export const verifyPullRequestApproval = ({ approval, body, metadata, candidateRevision, contractHash, configHash }: { readonly approval: PullRequestApproval; readonly body: string; readonly metadata: Readonly<Record<string, unknown>>; readonly candidateRevision: string; readonly contractHash: string; readonly configHash: string }): PullRequestApproval => {
  const expected = createPullRequestApproval({ body, metadata, approvedBy: 'human', candidateRevision, contractHash, configHash })
  if (approval.digest !== expected.digest || approval.bodyHash !== expected.bodyHash || approval.metadataHash !== expected.metadataHash) fail('Approved pull request content or metadata changed.', 'STALE')
  return approval
}

export interface QaTransitionAssessment {
  readonly decision: 'move-to-qa' | 'return-to-verification' | 'blocked'
  readonly target: 'qa' | 'verification'
  readonly invalidatesDownstream: boolean
  readonly reason: string
  readonly idempotencyKey: string
}

export const assessQaTransition = ({ featureValidated, g5, qaPassed, issue }: { readonly featureValidated: boolean; readonly g5: GateAssessment; readonly qaPassed: boolean; readonly issue: string }): QaTransitionAssessment => {
  required(issue, 'issue')
  const base = { issue, featureValidated, g5: g5.digest, qaPassed }
  if (!featureValidated || g5.gate !== 'G5' || g5.decision !== 'approved') return { decision: 'blocked', target: 'verification', invalidatesDownstream: false, reason: 'Feature validation and approved G5 acceptance are required before moving the issue to QA.', idempotencyKey: hashJson(base) }
  if (!qaPassed) return { decision: 'return-to-verification', target: 'verification', invalidatesDownstream: true, reason: 'QA failed; downstream evidence is invalidated and verification must be repeated.', idempotencyKey: hashJson(base) }
  return { decision: 'move-to-qa', target: 'qa', invalidatesDownstream: false, reason: 'Feature validation and G5 acceptance are current.', idempotencyKey: hashJson(base) }
}

export const assessIntegration = ({ g2, candidateRevision, evidenceRevision, contractHash, configHash, ci }: { readonly g2: GateAssessment; readonly candidateRevision: string; readonly evidenceRevision: string; readonly contractHash: string; readonly configHash: string; readonly ci: CriterionStatus }): GateAssessment => {
  required(candidateRevision, 'candidateRevision'); required(evidenceRevision, 'evidenceRevision')
  if (!['passed', 'failed', 'pending', 'not-applicable'].includes(ci)) fail('ci is invalid.', 'INVALID_INPUT')
  const reasons = [
    ...(g2.gate === 'G2' && g2.decision === 'approved' ? [] : ['G2 is not approved.']),
    ...(g2.binding.candidateRevision === candidateRevision && g2.binding.contractHash === contractHash && g2.binding.configHash === configHash ? [] : ['G2 is not bound to the current candidate, contract, and configuration.']),
    ...(candidateRevision === evidenceRevision ? [] : ['Candidate revision changed; G3 evidence must be revalidated.']),
    ...(ci === 'passed' ? [] : [`Integration CI is ${ci}.`]),
  ]
  return assessed('G3', reasons.length ? 'blocked' : 'approved', reasons, { candidateRevision, contractHash, configHash })
}

export const assessWorktreeCleanup = ({ branch, candidateRevision, contractHash, configHash, remoteBranchRevision, remotePr, integration }: { readonly branch: string; readonly candidateRevision: string; readonly contractHash: string; readonly configHash: string; readonly remoteBranchRevision?: string; readonly remotePr: 'confirmed' | 'missing' | 'uncertain'; readonly integration: GateAssessment }): { readonly decision: 'clean' | 'preserve'; readonly reason: string } => {
  required(branch, 'branch'); required(candidateRevision, 'candidateRevision')
  if (remotePr === 'uncertain') return { decision: 'preserve', reason: 'Remote PR state is uncertain; preserve the worktree for reconciliation.' }
  if (remotePr !== 'confirmed') return { decision: 'preserve', reason: 'No confirmed remote PR exists; preserve the worktree.' }
  if (remoteBranchRevision !== candidateRevision) return { decision: 'preserve', reason: 'Remote branch SHA does not match the candidate revision.' }
  if (integration.gate !== 'G3' || integration.decision !== 'approved') return { decision: 'preserve', reason: 'G3 is not approved.' }
  if (integration.binding.candidateRevision !== candidateRevision || integration.binding.contractHash !== contractHash || integration.binding.configHash !== configHash) return { decision: 'preserve', reason: 'G3 is not bound to the current candidate, contract, and configuration.' }
  return { decision: 'clean', reason: 'Remote branch, PR, and G3 evidence are confirmed for the candidate revision.' }
}

export interface RepositoryProfile { readonly deploy: string; readonly rollback: string; readonly urls: readonly string[]; readonly featureFlag: string; readonly syntheticTenant: string; readonly observability: readonly string[]; readonly sensitivePaths: readonly string[]; readonly owners: readonly string[]; readonly approvedBy: string }

const profileReasons = (profile: RepositoryProfile): readonly string[] => Object.entries(profile).flatMap(([key, value]) => Array.isArray(value) ? value.length ? [] : [`RepositoryProfile.${key} is required.`] : typeof value === 'string' && value.trim() ? [] : [`RepositoryProfile.${key} is required.`])

export interface ProductionEvidence { readonly tenant: string; readonly realFlow: string; readonly logs: readonly string[]; readonly metrics: readonly string[] }

export const assessProduction = ({ profile, integration, artifact, isolated, acceptanceArtifact, lowRisk = true, observationMinutes, technicalPassed, evidence, containmentPreauthorized, containmentAction, linkedDefect }: { readonly profile: RepositoryProfile; readonly integration: GateAssessment; readonly artifact: string; readonly isolated: boolean; readonly acceptanceArtifact?: string; readonly lowRisk?: boolean; readonly observationMinutes: number; readonly technicalPassed: boolean; readonly evidence: ProductionEvidence; readonly containmentPreauthorized: boolean; readonly containmentAction?: string; readonly linkedDefect?: string }): GateAssessment => {
  required(artifact, 'artifact')
  if (!Number.isFinite(observationMinutes) || observationMinutes < 0) fail('observationMinutes must be non-negative.', 'INVALID_INPUT')
  const evidenceReasons = [required(evidence.tenant, 'evidence.tenant'), required(evidence.realFlow, 'evidence.realFlow'), ...(Array.isArray(evidence.logs) && evidence.logs.length ? [] : ['Production evidence requires logs.']), ...(Array.isArray(evidence.metrics) && evidence.metrics.length ? [] : ['Production evidence requires metrics.'])].filter((item) => item.startsWith('Production evidence'))
  const reasons = [
    ...profileReasons(profile),
    ...(integration.gate === 'G3' && integration.decision === 'approved' ? [] : ['G3 is not approved.']),
    ...evidenceReasons,
    ...(isolated || acceptanceArtifact === artifact ? [] : ['Exposure requires isolation or acceptance linked to this artifact version.']),
    ...(technicalPassed ? [] : [containmentPreauthorized && containmentAction?.trim() && linkedDefect?.trim() ? 'Technical validation failed; pre-authorized containment and linked defect are recorded.' : containmentPreauthorized ? 'Technical validation failed; containment action and linked defect are required.' : 'Technical validation failed.']),
    ...(lowRisk && observationMinutes < 15 ? ['Low-risk production validation requires a 15-minute observation window.'] : []),
  ]
  return assessed('G4', reasons.length ? 'blocked' : 'approved', reasons, integration.binding)
}

export const assessAcceptance = ({ production, acceptanceRequired, accepted, notApplicableReason, materialChange }: { readonly production: GateAssessment; readonly acceptanceRequired: boolean; readonly accepted: boolean; readonly notApplicableReason?: string; readonly materialChange: boolean }): GateAssessment => {
  const reasons = [
    ...(production.gate === 'G4' && production.decision === 'approved' ? [] : ['G4 is not approved.']),
    ...(materialChange ? ['A material change invalidated acceptance; return to the affected gate.'] : []),
  ]
  if (reasons.length) return assessed('G5', 'blocked', reasons, production.binding)
  if (acceptanceRequired && !accepted) return assessed('G5', 'awaiting-acceptance', ['Business or UX acceptance is still required.'], production.binding)
  if (!acceptanceRequired && !notApplicableReason?.trim()) return assessed('G5', 'blocked', ['Acceptance marked not applicable requires a contractual reason.'], production.binding)
  return assessed('G5', 'approved', acceptanceRequired ? [] : [`Acceptance is not applicable: ${notApplicableReason}.`], production.binding)
}

export { runAdversarialReview } from './review.js'
export type { AdversarialReviewResult, ReviewLens, ReviewVerdict } from './review.js'
