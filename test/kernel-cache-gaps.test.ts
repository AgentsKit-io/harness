import { describe, expect, it } from 'vitest'
import { createLlmCache, createLlmCacheKey, validateCacheableOperation } from '../src/index.js'

describe('createLlmCache invalidation and telemetry', () => {
  it('invalidates a specific key, is a no-op for an unknown key, and reports telemetry', async () => {
    const cache = createLlmCache<string>()
    await cache.getOrCompute('a', async () => 'value-a')
    await cache.getOrCompute('b', async () => 'value-b')
    cache.invalidate('unknown-key')
    expect(cache.stats().invalidations).toBe(0)
    cache.invalidate('a')
    expect(cache.stats().invalidations).toBe(1)
    let recomputed = false
    await cache.getOrCompute('a', async () => { recomputed = true; return 'value-a-2' })
    expect(recomputed).toBe(true)
    expect(cache.telemetry?.()).toMatchObject({ status: 'measured', cacheHits: 0, cacheMisses: 3 })
  })

  it('clears every entry when invalidate is called with no key', async () => {
    const cache = createLlmCache<string>()
    await cache.getOrCompute('a', async () => 'value-a')
    await cache.getOrCompute('b', async () => 'value-b')
    cache.invalidate()
    expect(cache.stats().invalidations).toBe(2)
    let recomputed = 0
    await cache.getOrCompute('a', async () => { recomputed += 1; return 'value-a-2' })
    await cache.getOrCompute('b', async () => { recomputed += 1; return 'value-b-2' })
    expect(recomputed).toBe(2)
  })
})

describe('createLlmCacheKey / validateCacheableOperation', () => {
  const base = { sourceRevision: 'rev', contractHash: 'contract', configHash: 'config', provider: 'p', model: 'm', systemPromptHash: 's', inputHash: 'i' }

  it('rejects a non-cacheable operation', () => {
    expect(() => createLlmCacheKey({ ...base, operation: 'mutation' as never })).toThrow(/context and read-only/)
    expect(() => validateCacheableOperation(undefined)).toThrow(/context and read-only/)
  })

  it('produces a stable, distinct key per operation and optional field', () => {
    const contextKey = createLlmCacheKey({ ...base, operation: 'context' })
    const readOnlyKey = createLlmCacheKey({ ...base, operation: 'read-only' })
    const withContextHash = createLlmCacheKey({ ...base, operation: 'context', contextHash: 'ctx' })
    const withToolSchemaHash = createLlmCacheKey({ ...base, operation: 'context', toolSchemaHash: 'tool' })
    expect(new Set([contextKey, readOnlyKey, withContextHash, withToolSchemaHash]).size).toBe(4)
    expect(createLlmCacheKey({ ...base, operation: 'context' })).toBe(contextKey)
  })
})
