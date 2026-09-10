import { expect, it } from 'vitest'
import { assessDiscovery, isDiscoveryCurrent } from '../src/index.js'

const base = {
  issueId: 'AGE-123',
  sourceRevision: 'source-a',
  contractHash: 'contract-a',
  contextHash: 'context-a',
  approvedAssumptions: [{ id: 'internal-copy', policyId: 'docs-v1', resolution: 'Update factual internal documentation.' }],
}

it('moves a clear issue to ready and records approved reversible assumptions', () => {
  const result = assessDiscovery({
    ...base,
    ambiguities: [{ id: 'docs', question: 'Should factual internal documentation reflect the approved behavior?', material: false, assumptionId: 'internal-copy', recommendedOptionId: 'update', options: [{ id: 'update', summary: 'Update the document.', impact: 'Keeps context current.' }, { id: 'defer', summary: 'Defer the update.', impact: 'Leaves context stale.' }] }],
  })
  expect(result.status).toBe('ready')
  expect(result.packet).toBeUndefined()
  expect(result.decisionLog).toEqual([{ ambiguityId: 'docs', kind: 'approved-assumption', detail: 'Update factual internal documentation.', policyId: 'docs-v1' }])
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
})

it('produces one decision packet for material ambiguity without selecting for the human', () => {
  const result = assessDiscovery({
    ...base,
    ambiguities: [{ id: 'exposure', question: 'Should the behavior be exposed to customers?', material: true, recommendedOptionId: 'flag', options: [{ id: 'flag', summary: 'Expose behind a flag.', impact: 'Allows controlled validation.' }, { id: 'release', summary: 'Expose immediately.', impact: 'Changes customer behavior.' }] }],
  })
  expect(result.status).toBe('awaiting-decision')
  expect(result.packet?.decisions).toHaveLength(1)
  expect(result.packet?.decisions[0]?.recommendedOptionId).toBe('flag')
  expect(result.decisionLog[0]?.kind).toBe('human-decision-required')
})

it('rejects non-material ambiguity not covered by policy', () => {
  expect(() => assessDiscovery({
    ...base,
    ambiguities: [{ id: 'unknown', question: 'Which price should apply?', material: false, assumptionId: 'missing', recommendedOptionId: 'a', options: [{ id: 'a', summary: 'A.', impact: 'A.' }, { id: 'b', summary: 'B.', impact: 'B.' }] }],
  })).toThrow(/approved assumption/)
})

it('invalidates discovery when source, contract, or context changes', () => {
  const result = assessDiscovery({ ...base, ambiguities: [] })
  expect(isDiscoveryCurrent(result, { sourceRevision: 'source-a', contractHash: 'contract-a', contextHash: 'context-a' })).toEqual({ current: true, reasons: [] })
  expect(isDiscoveryCurrent(result, { sourceRevision: 'source-b', contractHash: 'contract-b', contextHash: 'context-b' })).toEqual({ current: false, reasons: ['source', 'contract', 'context'] })
})
