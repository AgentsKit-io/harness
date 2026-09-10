import { expect, it } from 'vitest'
import { assessWip } from '../src/index.js'

it('admits new work below the limit and keeps terminal work out of WIP', () => {
  const result = assessWip({ entries: [{ issueId: 'AGE-1', state: 'implementing' }, { issueId: 'AGE-2', state: 'done' }], candidate: { issueId: 'AGE-3', kind: 'new' } })
  expect(result).toMatchObject({ decision: 'admit', counts: { implementing: 1, done: 1 } })
  expect(result.inFlight.map((entry) => entry.issueId)).toEqual(['AGE-1'])
})

it('holds new work when blocked and awaiting-human deliveries fill WIP', () => {
  const result = assessWip({ entries: [{ issueId: 'AGE-1', state: 'blocked' }, { issueId: 'AGE-2', state: 'awaiting-decision' }, { issueId: 'AGE-3', state: 'awaiting-acceptance' }], candidate: { issueId: 'AGE-4', kind: 'new' } })
  expect(result.decision).toBe('hold')
  expect(result.reason).toContain('blocked and awaiting-human')
})

it('admits an existing resume at capacity and rejects an unknown resume', () => {
  const entries = [{ issueId: 'AGE-1', state: 'implementing' }, { issueId: 'AGE-2', state: 'blocked' }, { issueId: 'AGE-3', state: 'awaiting-decision' }] as const
  expect(assessWip({ entries, candidate: { issueId: 'AGE-2', kind: 'resume' } }).decision).toBe('admit')
  expect(assessWip({ entries, candidate: { issueId: 'AGE-4', kind: 'resume' } }).decision).toBe('hold')
})

it('rejects duplicate issue ids and invalid limits', () => {
  expect(() => assessWip({ entries: [{ issueId: 'AGE-1', state: 'ready' }, { issueId: 'AGE-1', state: 'blocked' }], candidate: { issueId: 'AGE-2', kind: 'new' } })).toThrow(/unique/)
  expect(() => assessWip({ entries: [], candidate: { issueId: 'AGE-2', kind: 'new' }, maxInFlight: 0 })).toThrow(/positive integer/)
})
