import { describe, expect, it } from 'vitest'
import { approvedDecision, assertHuman, transition } from '../src/index.js'
import type { StateTransition, VerificationRun } from '../src/index.js'

const run = (state: VerificationRun['state'], transitions: readonly StateTransition[] = []): Pick<VerificationRun, 'state' | 'transitions'> => ({ state, transitions })

describe('transition', () => {
  it('records a legal transition with the actor, reason, and timestamp', () => {
    const result = transition(run('CLARIFYING'), 'PLANNED', 'scoped', 'human')
    expect(result.state).toBe('PLANNED')
    expect(result.transitions).toEqual([{ from: 'CLARIFYING', to: 'PLANNED', at: expect.any(String), actor: 'human', reason: 'scoped' }])
  })

  it('defaults the actor to "harness" and omits reason when not given', () => {
    const result = transition(run('CLARIFYING'), 'PLANNED')
    expect(result.transitions[0]).toMatchObject({ actor: 'harness' })
    expect(result.transitions[0]).not.toHaveProperty('reason')
  })

  it('allows transitioning to the same state without checking the legal-transition table', () => {
    const result = transition(run('CLARIFYING'), 'CLARIFYING', 'no-op')
    expect(result.state).toBe('CLARIFYING')
    expect(result.transitions).toHaveLength(1)
  })

  it('rejects an unknown target state', () => {
    expect(() => transition(run('CLARIFYING'), 'NOT_A_STATE' as never)).toThrow(/Unknown state/)
  })

  it('rejects an illegal transition', () => {
    expect(() => transition(run('SUPERSEDED'), 'PLANNED')).toThrow(/Illegal transition SUPERSEDED -> PLANNED/)
  })
})

describe('assertHuman', () => {
  it('passes for "human" and fails closed for any other actor', () => {
    expect(() => assertHuman('human')).not.toThrow()
    expect(() => assertHuman('agent')).toThrow(/requires --by human/)
  })
})

describe('approvedDecision', () => {
  it('recognises every approval synonym as true and every rejection synonym as false', () => {
    for (const decision of ['approved', 'approve', 'yes', 'ok']) expect(approvedDecision(decision)).toBe(true)
    for (const decision of ['rejected', 'reject', 'no']) expect(approvedDecision(decision)).toBe(false)
  })

  it('rejects a decision outside the known set', () => {
    expect(() => approvedDecision('maybe')).toThrow(/must be approved or rejected/)
  })
})
