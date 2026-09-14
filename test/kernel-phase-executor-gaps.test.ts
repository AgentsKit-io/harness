import { describe, expect, it } from 'vitest'
import { createPhaseProfile, executePhaseProfile, planPhaseProfile } from '../src/index.js'

const single = (overrides: Record<string, unknown> = {}) => ({ id: 'p1', mode: 'yolo' as const, phases: [{ id: 'phase', effect: 'read' as const, ...overrides }] })

describe('createPhaseProfile / normalize validation', () => {
  it('rejects a non-object profile', () => {
    expect(() => createPhaseProfile(null as never)).toThrow(/profile must be an object/)
    expect(() => createPhaseProfile([] as never)).toThrow(/profile must be an object/)
  })

  it('rejects a blank or non-string profile.id', () => {
    expect(() => createPhaseProfile({ id: undefined as never, mode: 'yolo', phases: [{ id: 'a', effect: 'read' }] })).toThrow(/profile.id/)
    expect(() => createPhaseProfile({ id: '  ', mode: 'yolo', phases: [{ id: 'a', effect: 'read' }] })).toThrow(/profile.id/)
  })

  it('rejects an invalid profile.mode', () => {
    expect(() => createPhaseProfile({ id: 'p1', mode: 'fast' as never, phases: [{ id: 'a', effect: 'read' }] })).toThrow(/profile.mode/)
  })

  it('rejects non-array or empty phases', () => {
    expect(() => createPhaseProfile({ id: 'p1', mode: 'yolo', phases: 'nope' as never })).toThrow(/profile.phases must be non-empty/)
    expect(() => createPhaseProfile({ id: 'p1', mode: 'yolo', phases: [] })).toThrow(/profile.phases must be non-empty/)
  })

  it('rejects a non-object phase entry', () => {
    expect(() => createPhaseProfile({ id: 'p1', mode: 'yolo', phases: [null as never] })).toThrow(/phases\[0\] must be an object/)
  })

  it('rejects duplicate phase ids', () => {
    expect(() => createPhaseProfile({ id: 'p1', mode: 'yolo', phases: [{ id: 'a', effect: 'read' }, { id: 'a', effect: 'read' }] })).toThrow(/Phase ids must be unique/)
  })

  it('rejects a blank phase.id', () => {
    expect(() => createPhaseProfile({ id: 'p1', mode: 'yolo', phases: [{ id: '  ', effect: 'read' }] })).toThrow(/phases\[0\].id/)
  })

  it('rejects an invalid phase.effect', () => {
    expect(() => createPhaseProfile(single({ effect: 'compute' }) as never)).toThrow(/phases\[0\].effect is invalid/)
  })

  it('rejects a non-array dependsOn and duplicate dependency names', () => {
    expect(() => createPhaseProfile(single({ dependsOn: 'a' }) as never)).toThrow(/dependsOn must be an array/)
    expect(() => createPhaseProfile({ id: 'p1', mode: 'yolo', phases: [{ id: 'a', effect: 'read' }, { id: 'b', effect: 'read', dependsOn: ['a', 'a'] }] })).toThrow(/dependsOn must contain unique names/)
  })

  it('rejects a phase that depends on itself or an unknown phase', () => {
    expect(() => createPhaseProfile(single({ dependsOn: ['phase'] }))).toThrow(/cannot depend on itself/)
    expect(() => createPhaseProfile(single({ dependsOn: ['missing'] }))).toThrow(/unknown dependency/)
  })

  it('rejects duplicate output ownership across phases', () => {
    expect(() => createPhaseProfile({ id: 'p1', mode: 'yolo', phases: [{ id: 'a', effect: 'read', outputs: ['x'] }, { id: 'b', effect: 'read', outputs: ['x'] }] })).toThrow(/Output x is declared by both/)
  })

  it('rejects duplicate names within inputs, outputs, or gates', () => {
    expect(() => createPhaseProfile(single({ inputs: ['x', 'x'] }))).toThrow(/inputs must contain unique names/)
    expect(() => createPhaseProfile(single({ outputs: ['x', 'x'] }))).toThrow(/outputs must contain unique names/)
    expect(() => createPhaseProfile(single({ gates: ['x', 'x'] }))).toThrow(/gates must contain unique names/)
  })

  it('rejects an invalid budgetMs at the phase or profile level', () => {
    expect(() => createPhaseProfile(single({ budgetMs: 0 }))).toThrow(/budgetMs must be a positive integer/)
    expect(() => createPhaseProfile(single({ budgetMs: 1.5 }))).toThrow(/budgetMs must be a positive integer/)
    expect(() => createPhaseProfile({ ...single(), budgetMs: -1 })).toThrow(/profile.budgetMs must be a positive integer/)
  })

  it('rejects an out-of-range maxConcurrency', () => {
    expect(() => createPhaseProfile({ ...single(), maxConcurrency: 0 })).toThrow(/profile.maxConcurrency must be a bounded positive integer/)
    expect(() => createPhaseProfile({ ...single(), maxConcurrency: 101 })).toThrow(/profile.maxConcurrency must be a bounded positive integer/)
  })

  it('rejects an invalid effectPolicy override', () => {
    expect(() => createPhaseProfile({ ...single(), effectPolicy: { read: 'nope' as never } })).toThrow(/effectPolicy.read is invalid/)
  })

  it('carries an explicit retries/budgetMs through onto the normalized phase', () => {
    const profile = createPhaseProfile(single({ retries: { maxAttempts: 3 }, budgetMs: 500 }))
    expect(profile.phases[0]).toMatchObject({ retries: { maxAttempts: 3 }, budgetMs: 500 })
  })
})

describe('preflight loop edge cases', () => {
  it('blocks a mutating phase whose effect action is "block" in the effectPolicy', async () => {
    const profile = createPhaseProfile({ id: 'p1', mode: 'yolo', effectPolicy: { write: 'block' }, phases: [{ id: 'phase', effect: 'write', outputs: [] }] })
    const report = await executePhaseProfile(profile, { handlers: { phase: async () => ({ decision: 'pass', outputs: {} }) } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'Effect write is blocked by profile policy.' }] })
  })

  it('blocks a mutating "allow" phase when no preflight function is supplied at all', async () => {
    const profile = createPhaseProfile(single({ effect: 'write', outputs: [] }))
    const report = await executePhaseProfile(profile, { handlers: { phase: async () => ({ decision: 'pass', outputs: {} }) } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'Preflight is required before write effects.' }] })
  })

  it('honours an explicit block/escalate decision returned by the preflight function', async () => {
    const blockedProfile = createPhaseProfile(single({ effect: 'write', outputs: [] }))
    const blocked = await executePhaseProfile(blockedProfile, { preflight: async () => ({ decision: 'block', reason: 'not ready' }), handlers: { phase: async () => ({ decision: 'pass', outputs: {} }) } })
    expect(blocked).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'not ready' }] })

    const escalatedProfile = createPhaseProfile(single({ effect: 'write', outputs: [] }))
    const escalated = await executePhaseProfile(escalatedProfile, { preflight: async () => ({ decision: 'escalate', reason: 'needs sign-off' }), handlers: { phase: async () => ({ decision: 'pass', outputs: {} }) } })
    expect(escalated).toMatchObject({ status: 'escalated', phases: [{ decision: 'escalate', reason: 'needs sign-off' }] })
  })

  it('escalates without a decision packet when the preflight escalates without ambiguities', async () => {
    const profile = createPhaseProfile(single({ effect: 'external' }))
    const report = await executePhaseProfile(profile, { preflight: async () => ({ decision: 'escalate' }), handlers: { phase: async () => ({ decision: 'pass' }) } })
    expect(report.status).toBe('escalated')
    expect(report.decisionPacket).toBeUndefined()
  })
})

describe('runtime execution edge cases', () => {
  it('blocks or escalates a read-effect phase at runtime when the effectPolicy overrides it', async () => {
    const blockedProfile = createPhaseProfile({ id: 'p1', mode: 'yolo', effectPolicy: { read: 'block' }, phases: [{ id: 'phase', effect: 'read' }] })
    const blocked = await executePhaseProfile(blockedProfile, { handlers: { phase: async () => ({ decision: 'pass' }) } })
    expect(blocked).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'Effect read is blocked by profile policy.' }] })

    const escalatedProfile = createPhaseProfile({ id: 'p1', mode: 'yolo', effectPolicy: { read: 'escalate' }, phases: [{ id: 'phase', effect: 'read' }] })
    const escalated = await executePhaseProfile(escalatedProfile, { handlers: { phase: async () => ({ decision: 'pass' }) } })
    expect(escalated).toMatchObject({ status: 'escalated', phases: [{ decision: 'escalate', reason: 'Effect read requires escalation in yolo mode.' }] })
  })

  it('blocks when a required phase input is missing at runtime', async () => {
    const profile = createPhaseProfile(single({ inputs: ['missing-value'] }))
    const report = await executePhaseProfile(profile, { handlers: { phase: async () => ({ decision: 'pass' }) } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'Missing phase input: missing-value.' }] })
  })

  it('blocks when no handler is registered for a phase', async () => {
    const report = await executePhaseProfile(createPhaseProfile(single()), {})
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'No handler registered for phase phase.' }] })
  })

  it('blocks when no evaluator is registered for a declared gate', async () => {
    const report = await executePhaseProfile(createPhaseProfile(single({ gates: ['ready'] })), { handlers: { phase: async () => ({ decision: 'pass' }) } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'No evaluator registered for gate ready.' }] })
  })

  it('captures a thrown handler error as a blocking result', async () => {
    const report = await executePhaseProfile(createPhaseProfile(single()), { handlers: { phase: async () => { throw new Error('boom') } } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'boom' }] })
  })

  it('captures a thrown non-Error handler value as a blocking result', async () => {
    const report = await executePhaseProfile(createPhaseProfile(single()), { handlers: { phase: async () => { throw 'string failure' } } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'string failure' }] })
  })

  it('exhausts the retry budget and blocks with the handler-provided reason', async () => {
    const profile = createPhaseProfile(single({ retries: { maxAttempts: 2 } }))
    const report = await executePhaseProfile(profile, { handlers: { phase: async () => ({ decision: 'retry', reason: 'still warming up' }) } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', attempts: 2, reason: 'still warming up' }] })
  })

  it('exhausts the retry budget with a default reason when none is provided', async () => {
    const profile = createPhaseProfile(single({ retries: { maxAttempts: 1 } }))
    const report = await executePhaseProfile(profile, { handlers: { phase: async () => ({ decision: 'retry' }) } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'Phase retry budget exhausted.' }] })
  })

  it('blocks when the handler produces an undeclared output', async () => {
    const profile = createPhaseProfile(single({ outputs: ['expected'] }))
    const report = await executePhaseProfile(profile, { handlers: { phase: async () => ({ decision: 'pass', outputs: { expected: 1, extra: 2 } }) } })
    expect(report).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'Phase returned an undeclared output.' }] })
  })

  it('escalates directly from a runtime handler decision', async () => {
    const profile = createPhaseProfile(single())
    const report = await executePhaseProfile(profile, { handlers: { phase: async () => ({ decision: 'escalate', reason: 'needs a human' }) } })
    expect(report).toMatchObject({ status: 'escalated', phases: [{ decision: 'escalate', reason: 'needs a human' }] })
  })

  it('honours an object-shaped gate decision with a custom reason', async () => {
    const profile = createPhaseProfile(single({ gates: ['ready'] }))
    const report = await executePhaseProfile(profile, { gates: { ready: () => ({ decision: 'escalate', reason: 'needs approval' }) }, handlers: { phase: async () => ({ decision: 'pass' }) } })
    expect(report).toMatchObject({ status: 'escalated', phases: [{ decision: 'escalate', reason: 'needs approval' }] })
  })

  it('blocks execution once the profile budget is exceeded partway through, after a level has already run', async () => {
    let clock = 0
    const profile = createPhaseProfile({ id: 'p1', mode: 'yolo', budgetMs: 10, phases: [{ id: 'first', effect: 'read', outputs: ['x'] }, { id: 'second', effect: 'read', dependsOn: ['first'] }] })
    const report = await executePhaseProfile(profile, {
      now: () => clock,
      handlers: {
        first: async () => { clock = 20; return { decision: 'pass', outputs: { x: 1 } } },
        second: async () => ({ decision: 'pass' }),
      },
    })
    expect(report.status).toBe('blocked')
    expect(report.phases.at(-1)).toMatchObject({ decision: 'block', reason: 'Profile budget exceeded after 10ms.' })
  })
})

describe('planPhaseProfile', () => {
  it('exposes the computed levels and effect policy for a profile with defaults', () => {
    const plan = planPhaseProfile({ id: 'p1', mode: 'safe', phases: [{ id: 'a', effect: 'read' }] })
    expect(plan).toMatchObject({ profileId: 'p1', mode: 'safe', levels: [['a']], effectPolicy: { read: 'allow', write: 'allow', external: 'escalate' } })
  })
})
