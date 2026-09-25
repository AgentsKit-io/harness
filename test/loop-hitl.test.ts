import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { allHitlOptions, createHitlStore, HITL_ANCHOR_ID } from '../src/loop/hitl.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const request = () => ({ issue: 'ENG-10', role: 'orchestrator' as const, stage: 'contract', question: 'Which rollout?', context: 'The issue has two valid rollout paths.', options: [{ id: 'small', title: 'Small rollout', description: 'Ship to a small cohort first.' }, { id: 'full', title: 'Full rollout', description: 'Ship to every customer.' }, { id: 'canary', title: 'Canary', description: 'Use a time-bounded canary.' }], recommendedOptionId: 'canary', digest: 'contract-digest' })

describe('durable HITL seam', () => {
  it('validates the 3–4 suggested options and exposes the fixed anchor last', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-hitl-')); roots.push(root)
    const store = createHitlStore(root)
    const created = store.create(request())
    expect(allHitlOptions(created).map((option) => option.id)).toEqual(['small', 'full', 'canary', HITL_ANCHOR_ID])
    expect(store.list({ status: 'open' })).toHaveLength(1)
  })

  it('requires free text only for None of the above and is idempotent for the same answer', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-hitl-')); roots.push(root)
    const store = createHitlStore(root)
    const created = store.create(request())
    expect(() => store.answer(created.requestId, { optionId: HITL_ANCHOR_ID, actor: 'alice', expectedDigest: created.digest })).toThrow(/requires/)
    const answered = store.answer(created.requestId, { optionId: HITL_ANCHOR_ID, freeText: 'Use a staged rollout after the migration.', actor: 'alice', expectedDigest: created.digest })
    expect(store.answer(created.requestId, { optionId: HITL_ANCHOR_ID, freeText: 'Use a staged rollout after the migration.', actor: 'alice', expectedDigest: created.digest })).toEqual(answered)
    expect(() => store.answer(created.requestId, { optionId: 'small', actor: 'bob', expectedDigest: created.digest })).toThrow(/another answer/)
  })

  it('rejects stale requests and only reports a batch ready after every answer', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-hitl-')); roots.push(root)
    const store = createHitlStore(root)
    const first = store.create({ ...request(), batchId: 'batch-1', requestId: 'q-1' })
    const second = store.create({ ...request(), batchId: 'batch-1', requestId: 'q-2', question: 'Which owner?', digest: 'owner-digest' })
    expect(store.batchReady('batch-1')).toBe(false)
    store.answer(first.requestId, { optionId: 'canary', actor: 'alice', expectedDigest: first.digest })
    expect(store.batchReady('batch-1')).toBe(false)
    store.answer(second.requestId, { optionId: 'small', actor: 'alice', expectedDigest: second.digest })
    expect(store.batchReady('batch-1')).toBe(true)
    expect(() => store.answer(first.requestId, { optionId: 'small', actor: 'alice', expectedDigest: 'old-digest' })).toThrow(/stale/)
  })
})
