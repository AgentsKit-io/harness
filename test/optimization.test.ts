import { expect, it } from 'vitest'
import { assessAgentEval, compareOptimization, createLlmCache, createLlmCacheKey, runAgentEval, runWorkflow, validateMemoryRecord, validateOptimizationObservation } from '../src/index.js'

it('runs an eval suite with bounded deterministic batches and blocks regressions', async () => {
  const report = await runAgentEval({ suite: { name: 'fixture', cases: [{ id: 'a', input: 'a', expected: 'A' }, { id: 'b', input: 'b', expected: (value) => value === 'B' }] }, concurrency: 2, agent: async (input) => input.toUpperCase() })
  expect(report).toMatchObject({ total: 2, passed: 2, failed: 0, accuracy: 1 })
  expect(assessAgentEval(report, 1).status).toBe('passed')
})

it('reuses safe cache entries and exposes hit/miss/invalidation counters', async () => {
  const cache = createLlmCache<string>()
  const key = createLlmCacheKey({ sourceRevision: 'rev', contractHash: 'contract', configHash: 'config', provider: 'fixture', model: 'fixed', systemPromptHash: 's', inputHash: 'i', operation: 'read-only' })
  let calls = 0
  expect(await cache.getOrCompute(key, async () => { calls += 1; return 'value' })).toBe('value')
  expect(await cache.getOrCompute(key, async () => { calls += 1; return 'other' })).toBe('value')
  cache.invalidate(key)
  expect(await cache.getOrCompute(key, async () => { calls += 1; return 'fresh' })).toBe('fresh')
  expect({ calls, stats: cache.stats() }).toEqual({ calls: 2, stats: { hits: 1, misses: 2, invalidations: 1 } })
})

it('runs independent workflow nodes in deterministic bounded fan-out/fan-in batches', async () => {
  const result = await runWorkflow([{ id: 'b', run: async () => 'b' }, { id: 'a', run: async () => 'a' }, { id: 'c', dependsOn: ['a', 'b'], run: async () => 'c' }], { maxConcurrency: 2 })
  expect(result).toMatchObject({ order: ['a', 'b', 'c'], peakConcurrency: 2, results: { a: 'a', b: 'b', c: 'c' } })
})

it('serializes independent mutations for the same issue', async () => {
  let active = 0
  let peak = 0
  const mutate = async (value: string) => {
    active += 1
    peak = Math.max(peak, active)
    await Promise.resolve()
    active -= 1
    return value
  }
  const result = await runWorkflow([
    { id: 'mutate-b', mutationKey: 'issue:AGE-10', run: () => mutate('b') },
    { id: 'mutate-a', mutationKey: 'issue:AGE-10', run: () => mutate('a') },
    { id: 'read', run: () => mutate('read') },
  ], { maxConcurrency: 3 })
  expect(result.order).toEqual(['mutate-a', 'read', 'mutate-b'])
  expect(peak).toBe(2)
})

it('rejects cycles and compares only identically bound optimization observations', async () => {
  const base = { sourceRevision: 's', contractHash: 'c', configHash: 'g', provider: 'p', model: 'm', durationMs: 100, accuracy: 0.9, tokens: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, memory: { reads: 2, writes: 1, relevantHits: 1, staleHits: 0 }, cache: { hits: 1, misses: 1, invalidations: 0 }, parallelism: { tasks: 2, peakConcurrency: 2, criticalPathMs: 80 } }
  expect(validateOptimizationObservation(base)).toEqual(base)
  expect(validateMemoryRecord({ id: 'decision-1', scope: 'project', summary: 'Use bounded fan-out.', source: 'linear:AGE-1', sourceRevision: 's', contentHash: 'h', approved: true })).toMatchObject({ id: 'decision-1', approved: true })
  expect(() => validateMemoryRecord({ id: 'draft', scope: 'issue', summary: 'Unapproved', source: 'agent', sourceRevision: 's', contentHash: 'h', approved: false as true })).toThrow(/approved memory/)
  expect(compareOptimization(base, { ...base, durationMs: 90, accuracy: 1 })).toMatchObject({ comparable: true, durationDeltaMs: -10, accuracyDelta: 0.1 })
  expect(compareOptimization(base, { ...base, model: 'other' })).toMatchObject({ comparable: false })
  await expect(runWorkflow([{ id: 'a', dependsOn: ['b'], run: async () => 'a' }, { id: 'b', dependsOn: ['a'], run: async () => 'b' }], { maxConcurrency: 1 })).rejects.toThrow(/cycle/)
})
