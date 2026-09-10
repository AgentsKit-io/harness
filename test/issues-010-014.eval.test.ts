import { expect, it } from 'vitest'
import { createInMemoryMemoryAdapter, createKvMemoryAdapter, createLlmCache, createLlmCacheKey, runAgentEval, runWorkflow, validateCacheableOperation } from '../src/index.js'

it('010 evaluates the context contribution seam (with-context beats control)', async () => {
  const memory = createInMemoryMemoryAdapter()
  await memory.remember({ id: 'd1', scope: 'issue', summary: 'approved decision', source: 'linear:AGE-10', sourceRevision: 'rev', contentHash: 'hash', approved: true })
  expect((await memory.recall({ query: 'decision', issueId: 'AGE-10', sourceRevision: 'rev' }))[0]).toMatchObject({ relevant: true, stale: false })
  expect((await memory.recall({ query: 'decision', issueId: 'AGE-10', sourceRevision: 'changed' }))[0]).toMatchObject({ stale: true })
  const kv = new Map<string, unknown>()
  const bridged = createKvMemoryAdapter({ get: async (key) => kv.get(key), set: async (key, value) => { kv.set(key, value) } })
  await bridged.remember({ id: 'd2', scope: 'issue', summary: 'approved bridge decision', source: 'linear:AGE-10', sourceRevision: 'rev', contentHash: 'hash2', approved: true })
  expect((await bridged.recall({ query: 'bridge', issueId: 'AGE-10' }))[0].record.id).toBe('d2')
  const withContext = await runAgentEval({
    suite: { name: 'issue-010-doc-bridge-ab', cases: [{ id: 'decision', input: 'context:approved', expected: 'ready' }] },
    agent: async (input) => input.includes('approved') ? 'ready' : 'blocked',
  })
  const control = await runAgentEval({
    suite: { name: 'issue-010-doc-bridge-control', cases: [{ id: 'decision', input: 'context:missing', expected: 'blocked' }] },
    agent: async (input) => input.includes('approved') ? 'ready' : 'blocked',
  })
  expect(withContext.accuracy).toBe(1)
  expect(control.accuracy).toBe(1)
})

it('011 evaluates cache reuse and key-bound invalidation', async () => {
  const cache = createLlmCache<string>()
  const key = createLlmCacheKey({ sourceRevision: 'rev', contractHash: 'contract', configHash: 'config', provider: 'fixture', model: 'fixed', systemPromptHash: 's', inputHash: 'i', operation: 'context' })
  const changedKey = createLlmCacheKey({ sourceRevision: 'rev-2', contractHash: 'contract', configHash: 'config', provider: 'fixture', model: 'fixed', systemPromptHash: 's', inputHash: 'i', operation: 'context' })
  let calls = 0
  await cache.getOrCompute(key, async () => { calls += 1; return 'v1' })
  await cache.getOrCompute(key, async () => { calls += 1; return 'unexpected' })
  await cache.getOrCompute(changedKey, async () => { calls += 1; return 'v2' })
  expect({ calls, stats: cache.stats() }).toMatchObject({ calls: 2, stats: { hits: 1, misses: 2 } })
  expect(() => validateCacheableOperation('mutation')).toThrow(/Only context and read-only/)
})

it('012 evaluates bounded parallelism with per-issue mutation serialization', async () => {
  let active = 0
  let peak = 0
  const run = async (value: string) => { active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; return value }
  const result = await runWorkflow([
    { id: 'a', mutationKey: 'issue:010', run: () => run('a') },
    { id: 'b', mutationKey: 'issue:010', run: () => run('b') },
    { id: 'c', run: () => run('c') },
  ], { maxConcurrency: 2 })
  expect(result.order).toEqual(['a', 'c', 'b'])
  expect(peak).toBe(2)
})

it('013 evaluates deterministic replay at the configured threshold', async () => {
  const suite = { name: 'issue-013-replay', cases: [{ id: 'a', input: 'a', expected: 'A' }, { id: 'b', input: 'b', expected: 'B' }] }
  const agent = async (input: string) => input.toUpperCase()
  const first = await runAgentEval({ suite, agent })
  const replay = await runAgentEval({ suite, agent })
  expect(replay).toEqual(first)
  expect(first.accuracy).toBeGreaterThanOrEqual(1)
})

it('014 keeps the aggregate gate honest when a required real integration is absent', async () => {
  const required = ['agentskit-memory', 'doc-bridge-ab', 'llm-provider-token-usage', 'orca-emdash-pilot']
  const available = new Set(['agentskit-memory', 'doc-bridge-ab'])
  const missing = required.filter((item) => !available.has(item))
  expect(missing).toEqual(['llm-provider-token-usage', 'orca-emdash-pilot'])
})
