import { describe, expect, it } from 'vitest'
import { assessBlock, createModelPolicy, createOrcaDispatchPlan, createStatusSnapshot, createTrackingAdapter, createTrackingTransition, modelFor, parseRetro, promoteLearnings, validateStatusSnapshot } from '../src/index.js'

describe('portable orchestration records', () => {
  it('assesses dependencies and model bindings deterministically', () => {
    const block = { schemaVersion: 1 as const, id: 'B-1', title: 'Build', tracker: 'linear', repository: 'org/repo', acceptanceCriteria: ['tests pass'], dependencies: ['B-0'], wave: 1, status: 'todo' as const }
    expect(assessBlock(block, []).status).toBe('blocked')
    expect(assessBlock(block, ['B-0']).status).toBe('ready')
    const policy = createModelPolicy([{ role: 'builder', provider: 'agentskit', model: 'luna' }])
    expect(modelFor(policy, 'builder').model).toBe('luna')
  })

  it('parses and promotes retro learnings only with human approval', () => {
    const records = parseRetro('## Problems\n- Tests were too broad\n## Adjustments\n- Narrow by changed file', 'B-1')
    expect(records).toHaveLength(2)
    expect(() => promoteLearnings(records, { actor: 'agent', ids: [records[0]!.id] })).toThrow(/human actor/)
    expect(promoteLearnings(records, { actor: 'human', ids: [records[0]!.id] })[0]!.status).toBe('promoted')
  })

  it('creates and verifies status and Orca dispatch projections', () => {
    const snapshot = createStatusSnapshot({ generatedAt: '2026-01-01T00:00:00.000Z', sourceRevision: 'abc', blocks: [{ id: 'B-1', status: 'todo' }] })
    expect(validateStatusSnapshot(snapshot).digest).toBe(snapshot.digest)
    const plan = createOrcaDispatchPlan({ repository: 'org/repo', worktree: 'b-1', branch: 'codex/b-1', baseBranch: 'main', goalFile: 'GOAL.md' })
    expect(plan.argv[0]).toBe('orca')
    expect(plan.idempotencyKey).toHaveLength(64)
    const transition = createTrackingTransition({ tracker: 'linear', issue: 'ENG-1', to: 'validation', reason: 'checks passed' })
    expect(transition.idempotencyKey).toHaveLength(64)
    expect(createTrackingAdapter('linear', () => undefined).id).toBe('linear')
  })
})
