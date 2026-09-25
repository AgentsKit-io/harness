import { describe, expect, it } from 'vitest'
import { assessWip } from '../src/index.js'

describe('assessWip validation', () => {
  it('rejects a non-array entries', () => {
    expect(() => assessWip({ entries: 'nope' as never, candidate: { issueId: 'ABC-1', kind: 'new' } })).toThrow(/entries must be an array/)
  })

  it('rejects a non-integer or non-positive maxInFlight', () => {
    expect(() => assessWip({ entries: [], candidate: { issueId: 'ABC-1', kind: 'new' }, maxInFlight: 1.5 })).toThrow(/positive integer/)
    expect(() => assessWip({ entries: [], candidate: { issueId: 'ABC-1', kind: 'new' }, maxInFlight: -1 })).toThrow(/positive integer/)
  })

  it('rejects a blank candidate.issueId', () => {
    expect(() => assessWip({ entries: [], candidate: { issueId: '  ', kind: 'new' } })).toThrow(/candidate.issueId/)
  })

  it('rejects an invalid candidate.kind', () => {
    expect(() => assessWip({ entries: [], candidate: { issueId: 'ABC-1', kind: 'restart' as never } })).toThrow(/candidate.kind must be new or resume/)
  })

  it('rejects a blank entry.issueId', () => {
    expect(() => assessWip({ entries: [{ issueId: '  ', state: 'ready' }], candidate: { issueId: 'ABC-1', kind: 'new' } })).toThrow(/entry.issueId/)
  })

  it('rejects an unknown entry.state', () => {
    expect(() => assessWip({ entries: [{ issueId: 'ABC-1', state: 'archived' as never }], candidate: { issueId: 'ABC-2', kind: 'new' } })).toThrow(/Unknown WIP state: archived/)
  })
})

describe('assessWip decisions', () => {
  it('holds a resume against a terminal existing issue', () => {
    const result = assessWip({ entries: [{ issueId: 'ABC-1', state: 'done' }], candidate: { issueId: 'ABC-1', kind: 'resume' } })
    expect(result).toMatchObject({ decision: 'hold', reason: 'A resume requires an existing non-terminal issue.' })
  })

  it('holds a new admission that reuses an existing issue id', () => {
    const result = assessWip({ entries: [{ issueId: 'ABC-1', state: 'implementing' }], candidate: { issueId: 'ABC-1', kind: 'new' } })
    expect(result).toMatchObject({ decision: 'hold', reason: 'A new admission cannot reuse an existing issue id.' })
  })

  it('reports the available-slot reason and count on admission', () => {
    const result = assessWip({ entries: [{ issueId: 'ABC-1', state: 'implementing' }], candidate: { issueId: 'ABC-2', kind: 'new' } })
    expect(result.reason).toBe('WIP slot available (1/3).')
  })
})
