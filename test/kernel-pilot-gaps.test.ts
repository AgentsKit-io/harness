import { describe, expect, it } from 'vitest'
import { assessPilot } from '../src/index.js'

const base = { policyHash: 'policy-v1', baselineReference: 'baseline-2026-09-08' }
const tenNormal = Array.from({ length: 10 }, (_, index) => ({ issueId: `AGE-${index}`, classification: 'normal' as const, status: 'included' as const }))

describe('assessPilot validation', () => {
  it('rejects a blank policyHash or baselineReference', () => {
    expect(() => assessPilot({ ...base, policyHash: '  ', entries: [] })).toThrow(/policyHash/)
    expect(() => assessPilot({ ...base, baselineReference: '  ', entries: [] })).toThrow(/baselineReference/)
  })

  it('rejects entries that are not an array', () => {
    expect(() => assessPilot({ ...base, entries: 'nope' as never })).toThrow(/entries must be an array/)
  })

  it('rejects a blank entry.issueId', () => {
    expect(() => assessPilot({ ...base, entries: [{ issueId: '  ', classification: 'normal', status: 'included' }] })).toThrow(/entry.issueId/)
  })

  it('rejects a duplicate entry issueId', () => {
    expect(() => assessPilot({ ...base, entries: [{ issueId: 'ABC-1', classification: 'normal', status: 'excluded', reason: 'dup' }, { issueId: 'ABC-1', classification: 'normal', status: 'excluded', reason: 'dup' }] })).toThrow(/must be unique/)
  })

  it('rejects an invalid classification or status', () => {
    expect(() => assessPilot({ ...base, entries: [{ issueId: 'ABC-1', classification: 'urgent', status: 'included' }] })).toThrow(/classification is invalid/)
    expect(() => assessPilot({ ...base, entries: [{ issueId: 'ABC-1', classification: 'normal', status: 'pending' }] })).toThrow(/status is invalid/)
  })
})

describe('assessPilot decisions', () => {
  it('does not flag an excluded or aborted entry that carries an auditable reason', () => {
    const entries = [...tenNormal.slice(0, 9), { issueId: 'AGE-excluded', classification: 'normal' as const, status: 'excluded' as const, reason: 'scope changed' }]
    expect(assessPilot({ ...base, entries })).toMatchObject({ decision: 'blocked', reasons: [expect.stringContaining('exactly 10 included')] })
  })

  it('flags an aborted entry without an auditable reason', () => {
    const entries = [...tenNormal.slice(0, 9), { issueId: 'AGE-aborted', classification: 'normal' as const, status: 'aborted' as const }]
    expect(assessPilot({ ...base, entries })).toMatchObject({ decision: 'blocked', reasons: expect.arrayContaining(['AGE-aborted is aborted without an auditable reason.']) })
  })

  it('produces a stable digest for the same manifest', () => {
    const first = assessPilot({ ...base, entries: tenNormal })
    const second = assessPilot({ ...base, entries: tenNormal })
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
  })
})
