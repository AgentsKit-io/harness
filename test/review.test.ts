import { expect, it } from 'vitest'
import { assessAcceptance, assessIntegration, assessPreflight, assessQaTransition, assessProduction, composePullRequest, createPullRequestApproval, runAdversarialReview, verifyPullRequestApproval } from '../src/index.js'

const binding = { candidateRevision: 'abc', contractHash: 'contract', configHash: 'config' }
const g2 = assessPreflight({ criteria: [{ id: 'tests', gate: 'G2', status: 'passed' }], implementerId: 'builder', reviewerId: 'reviewer', reviewKind: 'adversarial', reviewApproved: true, binding })

it('runs bounded adversarial lenses in parallel and blocks empty or unsupported verdicts', async () => {
  const order: string[] = []
  const approved = await runAdversarialReview({ lenses: [{ id: 'security', maxAttempts: 2 }, { id: 'correctness' }], binding, maxConcurrency: 2, reviewer: async (lens, attempt) => { order.push(`${lens.id}:${attempt}`); return { status: 'pass' } } })
  expect(approved.decision).toBe('approved')
  expect(approved.peakConcurrency).toBe(2)
  expect(order.sort()).toEqual(['correctness:1', 'security:1'])
  const blocked = await runAdversarialReview({ lenses: [{ id: 'empty' }], binding, reviewer: () => ({ status: 'finding', reason: 'found issue' }) })
  expect(blocked.decision).toBe('blocked')
  expect(blocked.reasons[0]).toContain('unverified')
  const evidenced = await runAdversarialReview({ lenses: [{ id: 'security' }], binding, reviewer: () => ({ status: 'finding', reason: 'unsafe default', reproduction: 'run fixture' }) })
  expect(evidenced.decision).toBe('blocked')
  expect(evidenced.reasons[0]).toContain('found an issue')
})

it('binds approved PR body and metadata and invalidates mutation', () => {
  const draft = { issueId: 'ENG-1', candidateRevision: 'abc', contractHash: 'contract', configHash: 'config', g2Digest: g2.digest, evidence: ['tests: passed'], documentation: ['README'], risk: 'low', rollback: 'revert', pendingCriteria: [] }
  const pr = composePullRequest({ draft, g2 })
  if (pr.body === undefined) throw new Error('expected PR body')
  const metadata = { title: 'ENG-1', labels: ['ready'] }
  const approval = createPullRequestApproval({ body: pr.body, metadata, approvedBy: 'human', candidateRevision: 'abc', contractHash: 'contract', configHash: 'config' })
  expect(verifyPullRequestApproval({ approval, body: pr.body, metadata, candidateRevision: 'abc', contractHash: 'contract', configHash: 'config' })).toEqual(approval)
  expect(() => verifyPullRequestApproval({ approval, body: `${pr.body}\nchanged`, metadata, candidateRevision: 'abc', contractHash: 'contract', configHash: 'config' })).toThrow(/changed/)
})

it('only moves a validated feature to QA and returns failures to verification', () => {
  const g3 = assessIntegration({ g2, candidateRevision: 'abc', evidenceRevision: 'abc', ...binding, ci: 'passed' })
  const profile = { deploy: 'deploy', rollback: 'rollback', urls: ['https://qa.example.test'], featureFlag: 'flag', syntheticTenant: 'tenant', observability: ['logs'], sensitivePaths: ['none'], owners: ['owner'], approvedBy: 'owner' }
  const g4 = assessProduction({ profile, integration: g3, artifact: 'artifact', isolated: true, observationMinutes: 15, technicalPassed: true, evidence: { tenant: 'tenant', realFlow: 'flow', logs: ['log'], metrics: ['metric'] }, containmentPreauthorized: true })
  const g5 = assessAcceptance({ production: g4, acceptanceRequired: false, accepted: false, notApplicableReason: 'internal tool', materialChange: false })
  expect(assessQaTransition({ issue: 'ENG-1', featureValidated: true, g5, qaPassed: true })).toMatchObject({ decision: 'move-to-qa', target: 'qa' })
  expect(assessQaTransition({ issue: 'ENG-1', featureValidated: true, g5, qaPassed: false })).toMatchObject({ decision: 'return-to-verification', invalidatesDownstream: true })
  expect(assessQaTransition({ issue: 'ENG-1', featureValidated: false, g5, qaPassed: true }).decision).toBe('blocked')
})
