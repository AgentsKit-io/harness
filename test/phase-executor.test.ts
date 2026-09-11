import { expect, it } from 'vitest'
import { createPhaseProfile, executePhaseProfile, planPhaseProfile } from '../src/index.js'

const base = (mode: 'safe' | 'yolo' | 'dry-run' = 'yolo') => createPhaseProfile({
  id: 'reference',
  mode,
  phases: [
    { id: 'discover', outputs: ['plan'], effect: 'read' },
    { id: 'implement', inputs: ['plan'], outputs: ['change'], dependsOn: ['discover'], effect: 'write' },
    { id: 'publish', inputs: ['change'], dependsOn: ['implement'], effect: 'external' },
  ],
})

it('creates a deterministic route and rejects cycles and unbounded retry budgets', () => {
  const profile = createPhaseProfile({
    id: 'ordered',
    mode: 'safe',
    maxConcurrency: 2,
    phases: [
      { id: 'b', dependsOn: ['a'], effect: 'read' },
      { id: 'a', outputs: ['a'], effect: 'read', retries: { maxAttempts: 2 } },
      { id: 'c', dependsOn: ['a'], effect: 'read', gates: ['ready'], budgetMs: 100 },
    ],
  })
  const firstPlan = planPhaseProfile(profile)
  expect(firstPlan).toMatchObject({ levels: [['a'], ['b', 'c']], maxConcurrency: 2 })
  expect(planPhaseProfile(profile)).toEqual(firstPlan)
  expect(() => createPhaseProfile({ id: 'cycle', mode: 'safe', phases: [{ id: 'a', dependsOn: ['b'], effect: 'read' }, { id: 'b', dependsOn: ['a'], effect: 'read' }] })).toThrow(/cycle/)
  expect(() => createPhaseProfile({ id: 'unbounded', mode: 'safe', phases: [{ id: 'a', effect: 'read', retries: { maxAttempts: Number.POSITIVE_INFINITY } }] })).toThrow(/bounded/)
})

it('aggregates preflight ambiguities before invoking any mutating phase', async () => {
  let writes = 0
  const report = await executePhaseProfile(base(), {
    handlers: {
      discover: async () => ({ decision: 'pass', outputs: { plan: 'defined' } }),
      implement: async () => { writes += 1; return { decision: 'pass', outputs: { change: 'done' } } },
      publish: async () => { writes += 1; return { decision: 'pass' } },
    },
    preflight: async ({ phase }) => phase.id === 'implement'
      ? { decision: 'pass', ambiguities: [{ id: 'scope', question: 'Which scope is intended?', options: ['A', 'B'], suggestion: 'A' }] }
      : phase.id === 'publish'
        ? { decision: 'pass', ambiguities: [{ id: 'target', question: 'Which target is intended?', options: ['staging', 'production'], suggestion: 'staging' }] }
        : { decision: 'pass' },
  })
  expect(report.status).toBe('escalated')
  expect(report.decisionPacket).toMatchObject({ id: 'phase-preflight', phaseIds: ['implement', 'publish'], ambiguities: [{ id: 'scope' }, { id: 'target' }] })
  expect(writes).toBe(0)
})

it('uses the same engine for safe, yolo, and dry-run effect policies', async () => {
  const run = async (mode: 'safe' | 'yolo' | 'dry-run') => {
    let effects = 0
    const report = await executePhaseProfile(base(mode), {
      handlers: {
        discover: async () => ({ decision: 'pass', outputs: { plan: 'defined' } }),
        implement: async () => { effects += 1; return { decision: 'pass', outputs: { change: 'done' } } },
        publish: async () => { effects += 1; return { decision: 'pass' } },
      },
      preflight: async () => ({ decision: 'pass' }),
    })
    return { report, effects }
  }
  await expect(run('safe')).resolves.toMatchObject({ report: { status: 'escalated' }, effects: 0 })
  await expect(run('yolo')).resolves.toMatchObject({ report: { status: 'passed' }, effects: 2 })
  await expect(run('dry-run')).resolves.toMatchObject({ report: { status: 'dry-run' }, effects: 0 })
})

it('supports gates, bounded retry, cancel, and resume decisions deterministically', async () => {
  let attempts = 0
  const retried = await executePhaseProfile(createPhaseProfile({ id: 'retry', mode: 'yolo', phases: [{ id: 'phase', outputs: ['value'], retries: { maxAttempts: 2 }, gates: ['ready'], effect: 'write' }] }), {
    gates: { ready: () => true },
    preflight: async () => ({ decision: 'pass' }),
    handlers: { phase: async () => { attempts += 1; return attempts === 1 ? { decision: 'retry' } : { decision: 'pass', outputs: { value: 1 } } } },
  })
  expect(retried).toMatchObject({ status: 'passed', phases: [{ id: 'phase', decision: 'pass', attempts: 2, outputs: { value: 1 } }] })
  const blocked = await executePhaseProfile(createPhaseProfile({ id: 'gate', mode: 'yolo', phases: [{ id: 'phase', gates: ['ready'], effect: 'read' }] }), { gates: { ready: () => false }, handlers: { phase: async () => ({ decision: 'pass' }) } })
  expect(blocked).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'Gate ready did not pass.' }] })
  const cancelled = await executePhaseProfile(createPhaseProfile({ id: 'cancel', mode: 'yolo', phases: [{ id: 'phase', effect: 'read' }] }), { handlers: { phase: async () => ({ decision: 'cancel', reason: 'operator stopped' }) } })
  expect(cancelled).toMatchObject({ status: 'cancelled', phases: [{ decision: 'cancel' }] })
  const resumed = await executePhaseProfile(base(), {
    resume: { completed: { discover: { decision: 'pass', outputs: { plan: 'restored' } } }, outputs: { plan: 'restored' } },
    handlers: { implement: async ({ inputs }) => ({ decision: 'pass', outputs: { change: inputs.plan === 'restored' ? 'done' : 'wrong' } }), publish: async () => ({ decision: 'pass' }) },
    preflight: async () => ({ decision: 'pass' }),
  })
  expect(resumed).toMatchObject({ status: 'passed', resumed: true, phases: [{ id: 'discover', decision: 'resume' }, { id: 'implement', decision: 'pass' }, { id: 'publish', decision: 'pass' }], outputs: { plan: 'restored', change: 'done' } })
})

it('never invokes a dry-run effect and fails closed on missing inputs or outputs', async () => {
  let invoked = false
  const dryRun = await executePhaseProfile(createPhaseProfile({ id: 'dry', mode: 'dry-run', phases: [{ id: 'write', inputs: ['missing'], effect: 'write' }] }), { handlers: { write: async () => { invoked = true; return { decision: 'pass' } } } })
  expect(dryRun.status).toBe('dry-run')
  expect(invoked).toBe(false)
  const missingOutput = await executePhaseProfile(createPhaseProfile({ id: 'output', mode: 'yolo', phases: [{ id: 'write', outputs: ['required'], effect: 'write' }] }), { preflight: async () => ({ decision: 'pass' }), handlers: { write: async () => ({ decision: 'pass', outputs: {} }) } })
  expect(missingOutput).toMatchObject({ status: 'blocked', phases: [{ reason: 'Phase did not produce every declared output.' }] })
  let clock = 0
  const budget = await executePhaseProfile(createPhaseProfile({ id: 'budget', mode: 'yolo', budgetMs: 1, phases: [{ id: 'phase', effect: 'read' }] }), { now: () => clock, handlers: { phase: async () => { clock = 2; return { decision: 'pass' } } } })
  expect(budget).toMatchObject({ status: 'blocked', phases: [{ decision: 'block', reason: 'Profile budget exceeded after 1ms.' }] })
})
