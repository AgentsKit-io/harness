import { expect, it } from 'vitest'
import { assessAcceptance, assessIntegration, assessPreflight, assessProduction, assessWorktreeCleanup, composePullRequest } from '../src/index.js'

const criteria = [
  { id: 'tests', gate: 'G2', status: 'passed' },
  { id: 'docs', gate: 'G2', status: 'passed' },
  { id: 'production-flow', gate: 'G4', status: 'pending' },
] as const

const current = { candidateRevision: 'abc', contractHash: 'contract', configHash: 'config' }
const productionEvidence = { tenant: 'synthetic-tenant', realFlow: 'create flow', logs: ['log://run'], metrics: ['metric://run'] }
const preflight = () => assessPreflight({ criteria, implementerId: 'agent-a', reviewerId: 'agent-b', reviewKind: 'adversarial', reviewApproved: true, binding: current })

it('approves G2 while later production criteria remain pending', () => {
  expect(preflight()).toMatchObject({ gate: 'G2', decision: 'approved' })
})

it('blocks preflight on failed evidence, self-review, or more than two repairs', () => {
  expect(assessPreflight({ criteria: [{ id: 'tests', gate: 'G2', status: 'failed' }], implementerId: 'agent-a', reviewerId: 'agent-a', reviewApproved: true, repairAttempts: 3, binding: current })).toMatchObject({ decision: 'blocked', reasons: expect.arrayContaining(['tests is failed.']) })
})

it('creates a structured PR once and blocks uncertain or mismatched remote state', () => {
  const draft = { issueId: 'AGE-1', candidateRevision: 'abc', contractHash: 'contract', configHash: 'config', g2Digest: preflight().digest, evidence: ['tests: passed'], documentation: ['README'], risk: 'low', rollback: 'revert', pendingCriteria: ['G4 production-flow'] }
  expect(composePullRequest({ draft, g2: preflight() })).toMatchObject({ decision: 'create', body: expect.stringContaining('## G2 evidence') })
  expect(composePullRequest({ draft: { ...draft, candidateRevision: 'changed' }, g2: preflight() })).toMatchObject({ decision: 'blocked' })
  expect(composePullRequest({ draft, g2: preflight(), remote: { state: 'confirmed', url: 'https://example.test/pr/1', candidateRevision: 'abc' } })).toMatchObject({ decision: 'reuse' })
  expect(composePullRequest({ draft, g2: preflight(), remote: { state: 'uncertain' } })).toMatchObject({ decision: 'blocked' })
})

it('requires current candidate CI before G3', () => {
  expect(assessIntegration({ g2: preflight(), candidateRevision: 'abc', evidenceRevision: 'old', ...current, ci: 'passed' })).toMatchObject({ decision: 'blocked' })
  expect(assessIntegration({ g2: preflight(), candidateRevision: 'abc', evidenceRevision: 'abc', ...current, ci: 'passed' })).toMatchObject({ decision: 'approved' })
})

it('preserves worktree state until remote branch SHA, PR, and G3 agree', () => {
  const g3 = assessIntegration({ g2: preflight(), candidateRevision: 'abc', evidenceRevision: 'abc', ...current, ci: 'passed' })
  expect(assessWorktreeCleanup({ branch: 'age-1', ...current, remoteBranchRevision: 'old', remotePr: 'confirmed', integration: g3 })).toMatchObject({ decision: 'preserve' })
  expect(assessWorktreeCleanup({ branch: 'age-1', ...current, remoteBranchRevision: 'abc', remotePr: 'confirmed', integration: g3 })).toMatchObject({ decision: 'clean' })
})

it('denies unisolated production exposure and keeps G5 awaiting acceptance', () => {
  const g3 = assessIntegration({ g2: preflight(), candidateRevision: 'abc', evidenceRevision: 'abc', ...current, ci: 'passed' })
  const profile = { deploy: 'deploy', rollback: 'rollback', urls: ['https://qa.example.test'], featureFlag: 'feature', syntheticTenant: 'tenant', observability: ['logs'], sensitivePaths: ['billing'], owners: ['ops'], approvedBy: 'ops-owner' }
  expect(assessProduction({ profile, integration: g3, artifact: 'sha256:artifact', isolated: false, observationMinutes: 15, technicalPassed: true, evidence: productionEvidence, containmentPreauthorized: true })).toMatchObject({ decision: 'blocked' })
  const g4 = assessProduction({ profile, integration: g3, artifact: 'sha256:artifact', isolated: true, observationMinutes: 15, technicalPassed: true, evidence: productionEvidence, containmentPreauthorized: true })
  expect(assessAcceptance({ production: g4, acceptanceRequired: true, accepted: false, materialChange: false })).toMatchObject({ decision: 'awaiting-acceptance' })
  expect(assessAcceptance({ production: g4, acceptanceRequired: true, accepted: true, materialChange: true })).toMatchObject({ decision: 'blocked' })
  expect(assessAcceptance({ production: g4, acceptanceRequired: false, accepted: false, materialChange: false })).toMatchObject({ decision: 'blocked' })
})
