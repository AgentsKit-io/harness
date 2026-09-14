import { describe, expect, it } from 'vitest'
import { compareOptimization, validateOptimizationObservation } from '../src/index.js'
import type { OptimizationObservation } from '../src/index.js'

const base: OptimizationObservation = { sourceRevision: 's', contractHash: 'c', configHash: 'g', provider: 'p', model: 'm', durationMs: 100 }

describe('validateOptimizationObservation', () => {
  it('accepts the minimal shape and every optional block fully populated', () => {
    const full: OptimizationObservation = { ...base, accuracy: 0.9, tokens: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 1 }, memory: { reads: 2, writes: 1, relevantHits: 1, staleHits: 0 }, cache: { hits: 1, misses: 1, invalidations: 0, tokensSaved: 10 }, parallelism: { tasks: 2, peakConcurrency: 2, criticalPathMs: 80, queueWaitMs: 5 } }
    expect(validateOptimizationObservation(full)).toEqual(full)
  })

  it('rejects a blank required identity field', () => {
    expect(() => validateOptimizationObservation({ ...base, sourceRevision: '' })).toThrow(/sourceRevision is required/)
    expect(() => validateOptimizationObservation({ ...base, contractHash: '' })).toThrow(/contractHash is required/)
    expect(() => validateOptimizationObservation({ ...base, configHash: '' })).toThrow(/configHash is required/)
    expect(() => validateOptimizationObservation({ ...base, provider: '' })).toThrow(/provider is required/)
    expect(() => validateOptimizationObservation({ ...base, model: '' })).toThrow(/model is required/)
  })

  it('rejects a negative durationMs', () => {
    expect(() => validateOptimizationObservation({ ...base, durationMs: -1 })).toThrow(/durationMs must be a non-negative number/)
  })

  it('rejects an out-of-range accuracy', () => {
    expect(() => validateOptimizationObservation({ ...base, accuracy: -0.1 })).toThrow(/accuracy must be between 0 and 1/)
    expect(() => validateOptimizationObservation({ ...base, accuracy: 1.1 })).toThrow(/accuracy must be between 0 and 1/)
  })

  it('rejects negative or fractional token counts, and a totalTokens mismatch', () => {
    expect(() => validateOptimizationObservation({ ...base, tokens: { inputTokens: -1, outputTokens: 0, totalTokens: -1 } })).toThrow(/tokens.inputTokens must be a non-negative number/)
    expect(() => validateOptimizationObservation({ ...base, tokens: { inputTokens: 1.5, outputTokens: 0, totalTokens: 1.5 } })).toThrow(/tokens.inputTokens must be an integer/)
    expect(() => validateOptimizationObservation({ ...base, tokens: { inputTokens: 2, outputTokens: 3, totalTokens: 999 } })).toThrow(/tokens.totalTokens must equal inputTokens \+ outputTokens/)
    expect(() => validateOptimizationObservation({ ...base, tokens: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadTokens: -1 } })).toThrow(/tokens.cacheReadTokens must be a non-negative number/)
    expect(() => validateOptimizationObservation({ ...base, tokens: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheWriteTokens: -1 } })).toThrow(/tokens.cacheWriteTokens must be a non-negative number/)
  })

  it('rejects a negative memory counter', () => {
    expect(() => validateOptimizationObservation({ ...base, memory: { reads: -1, writes: 0, relevantHits: 0, staleHits: 0 } })).toThrow(/memory.reads must be a non-negative number/)
  })

  it('rejects a negative cache counter, including tokensSaved', () => {
    expect(() => validateOptimizationObservation({ ...base, cache: { hits: -1, misses: 0, invalidations: 0 } })).toThrow(/cache.hits must be a non-negative number/)
    expect(() => validateOptimizationObservation({ ...base, cache: { hits: 0, misses: 0, invalidations: 0, tokensSaved: -1 } })).toThrow(/cache.tokensSaved must be a non-negative number/)
  })

  it('rejects a negative parallelism field and an inconsistent tasks/peakConcurrency pairing', () => {
    expect(() => validateOptimizationObservation({ ...base, parallelism: { tasks: -1, peakConcurrency: 1, criticalPathMs: 0 } })).toThrow(/parallelism.tasks must be a non-negative number/)
    expect(() => validateOptimizationObservation({ ...base, parallelism: { tasks: 1, peakConcurrency: 1, criticalPathMs: -1 } })).toThrow(/parallelism.criticalPathMs must be a non-negative number/)
    expect(() => validateOptimizationObservation({ ...base, parallelism: { tasks: 1, peakConcurrency: 1, criticalPathMs: 0, queueWaitMs: -1 } })).toThrow(/parallelism.queueWaitMs must be a non-negative number/)
    expect(() => validateOptimizationObservation({ ...base, parallelism: { tasks: 2, peakConcurrency: 0, criticalPathMs: 10 } })).toThrow(/peakConcurrency must be positive when tasks exist/)
  })
})

describe('compareOptimization', () => {
  it('computes deltas for every optional block when both sides carry it', () => {
    const baseline: OptimizationObservation = { ...base, tokens: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, memory: { reads: 10, writes: 0, relevantHits: 5, staleHits: 0 }, cache: { hits: 5, misses: 5, invalidations: 0 }, parallelism: { tasks: 2, peakConcurrency: 2, criticalPathMs: 80 } }
    const candidate: OptimizationObservation = { ...baseline, tokens: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, memory: { reads: 10, writes: 0, relevantHits: 8, staleHits: 0 }, cache: { hits: 8, misses: 2, invalidations: 0 }, parallelism: { tasks: 2, peakConcurrency: 4, criticalPathMs: 40 } }
    const comparison = compareOptimization(baseline, candidate)
    expect(comparison).toMatchObject({ comparable: true, tokenDelta: 2, peakConcurrencyDelta: 2 })
    expect(comparison.cacheHitRateDelta).toBeCloseTo(0.3, 4)
    expect(comparison.memoryRelevantHitRateDelta).toBeCloseTo(0.3, 4)
  })

  it('omits a delta field when only one side carries that optional block', () => {
    const withTokens: OptimizationObservation = { ...base, tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    const comparison = compareOptimization(withTokens, base)
    expect(comparison).not.toHaveProperty('tokenDelta')
    expect(comparison).not.toHaveProperty('cacheHitRateDelta')
    expect(comparison).not.toHaveProperty('memoryRelevantHitRateDelta')
    expect(comparison).not.toHaveProperty('peakConcurrencyDelta')
  })

  it('flags every binding mismatch dimension', () => {
    expect(compareOptimization(base, { ...base, sourceRevision: 'other' }).reason).toContain('sourceRevision')
    expect(compareOptimization(base, { ...base, contractHash: 'other' }).reason).toContain('contractHash')
    expect(compareOptimization(base, { ...base, configHash: 'other' }).reason).toContain('configHash')
    expect(compareOptimization(base, { ...base, provider: 'other' }).reason).toContain('provider')
  })
})
