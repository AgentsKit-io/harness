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

it('omits contextHash entirely when not provided, on both the result and the packet', () => {
  const { contextHash: _contextHash, ...withoutContext } = base
  const result = assessDiscovery({ ...withoutContext, ambiguities: [{ id: 'exposure', question: 'q', material: true, recommendedOptionId: 'a', options: [{ id: 'a', summary: 's', impact: 'i' }, { id: 'b', summary: 's2', impact: 'i2' }] }] })
  expect(result).not.toHaveProperty('contextHash')
  expect(result.packet).not.toHaveProperty('contextHash')
})

it('rejects a blank issueId, sourceRevision, or contractHash', () => {
  expect(() => assessDiscovery({ ...base, issueId: '', ambiguities: [] })).toThrow(/issueId is required/)
  expect(() => assessDiscovery({ ...base, sourceRevision: '', ambiguities: [] })).toThrow(/sourceRevision is required/)
  expect(() => assessDiscovery({ ...base, contractHash: '', ambiguities: [] })).toThrow(/contractHash is required/)
})

it('rejects a non-array ambiguities field and duplicate ambiguity ids', () => {
  expect(() => assessDiscovery({ ...base, ambiguities: 'nope' as never })).toThrow(/ambiguities must be an array/)
  const dup = { id: 'x', question: 'q', material: true, recommendedOptionId: 'a', options: [{ id: 'a', summary: 's', impact: 'i' }, { id: 'b', summary: 's2', impact: 'i2' }] }
  expect(() => assessDiscovery({ ...base, ambiguities: [dup, dup] })).toThrow(/ambiguity ids must be unique/)
})

it('rejects duplicate assumption ids and a blank assumption field', () => {
  const assumption = { id: 'a1', policyId: 'p', resolution: 'r' }
  expect(() => assessDiscovery({ ...base, approvedAssumptions: [assumption, assumption], ambiguities: [] })).toThrow(/assumption ids must be unique/)
  expect(() => assessDiscovery({ ...base, approvedAssumptions: [{ id: 'a1', policyId: '', resolution: 'r' }], ambiguities: [] })).toThrow(/policyId is required/)
})

it('rejects a blank ambiguity question, a non-boolean material flag, and an out-of-range option count', () => {
  const options = [{ id: 'a', summary: 's', impact: 'i' }, { id: 'b', summary: 's2', impact: 'i2' }]
  expect(() => assessDiscovery({ ...base, ambiguities: [{ id: 'x', question: '', material: true, recommendedOptionId: 'a', options }] })).toThrow(/question is required/)
  expect(() => assessDiscovery({ ...base, ambiguities: [{ id: 'x', question: 'q', material: 'yes' as never, recommendedOptionId: 'a', options }] })).toThrow(/material must be boolean/)
  expect(() => assessDiscovery({ ...base, ambiguities: [{ id: 'x', question: 'q', material: true, recommendedOptionId: 'a', options: [options[0]!] }] })).toThrow(/2 to 4 options/)
  expect(() => assessDiscovery({ ...base, ambiguities: [{ id: 'x', question: 'q', material: true, recommendedOptionId: 'a', options: [...options, ...options, options[0]!] }] })).toThrow(/2 to 4 options/)
})

it('rejects duplicate option ids, a blank option field, and an unresolved recommendedOptionId', () => {
  const dupOptions = [{ id: 'a', summary: 's', impact: 'i' }, { id: 'a', summary: 's2', impact: 'i2' }]
  expect(() => assessDiscovery({ ...base, ambiguities: [{ id: 'x', question: 'q', material: true, recommendedOptionId: 'a', options: dupOptions }] })).toThrow(/option ids must be unique/)
  const blankSummary = [{ id: 'a', summary: '', impact: 'i' }, { id: 'b', summary: 's2', impact: 'i2' }]
  expect(() => assessDiscovery({ ...base, ambiguities: [{ id: 'x', question: 'q', material: true, recommendedOptionId: 'a', options: blankSummary }] })).toThrow(/summary is required/)
  const blankImpact = [{ id: 'a', summary: 's', impact: '' }, { id: 'b', summary: 's2', impact: 'i2' }]
  expect(() => assessDiscovery({ ...base, ambiguities: [{ id: 'x', question: 'q', material: true, recommendedOptionId: 'a', options: blankImpact }] })).toThrow(/impact is required/)
  const options = [{ id: 'a', summary: 's', impact: 'i' }, { id: 'b', summary: 's2', impact: 'i2' }]
  expect(() => assessDiscovery({ ...base, ambiguities: [{ id: 'x', question: 'q', material: true, recommendedOptionId: 'not-an-option', options }] })).toThrow(/recommendedOptionId must identify an option/)
})
