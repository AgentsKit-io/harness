import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/index.js'

const node = <T>(id: string, value: T, overrides: Partial<Parameters<typeof runWorkflow>[0][number]> = {}) => ({ id, run: async () => value, ...overrides })

describe('runWorkflow validation', () => {
  it('rejects a blank or non-string node id', () => {
    return expect(runWorkflow([node('  ', 1)], { maxConcurrency: 1 })).rejects.toThrow(/non-empty/)
  })

  it('rejects duplicate node ids', () => {
    return expect(runWorkflow([node('a', 1), node('a', 2)], { maxConcurrency: 1 })).rejects.toThrow(/unique/)
  })

  it('rejects a non-positive-integer maxConcurrency', () => {
    return expect(runWorkflow([node('a', 1)], { maxConcurrency: 0 })).rejects.toThrow(/maxConcurrency must be a positive integer/)
  })

  it('rejects an invalid value returned by currentConcurrency', () => {
    return expect(runWorkflow([node('a', 1)], { maxConcurrency: 4, currentConcurrency: () => 0 })).rejects.toThrow(/currentConcurrency must return a positive integer/)
  })
})

describe('runWorkflow scheduling', () => {
  it('rejects an unknown dependency or a dependency cycle', () => {
    return expect(runWorkflow([node('a', 1, { dependsOn: ['missing'] })], { maxConcurrency: 1 })).rejects.toThrow(/unknown dependency or cycle/)
  })

  it('re-evaluates currentConcurrency per scheduling batch', async () => {
    const seen: number[] = []
    const limits = [1, 1, 2]
    let call = 0
    const result = await runWorkflow([node('a', 'a'), node('b', 'b'), node('c', 'c')], {
      maxConcurrency: 3,
      currentConcurrency: () => { const limit = limits[call] ?? 2; call += 1; seen.push(limit); return limit },
    })
    expect(result.order).toHaveLength(3)
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })

  it('serializes nodes sharing a mutationKey across scheduling batches while running independent nodes in the same batch', async () => {
    let concurrentMutations = 0
    let peakConcurrentMutations = 0
    const mutate = async (value: string) => { concurrentMutations += 1; peakConcurrentMutations = Math.max(peakConcurrentMutations, concurrentMutations); await Promise.resolve(); concurrentMutations -= 1; return value }
    const result = await runWorkflow([
      node('m1', 'm1', { mutationKey: 'shared', run: () => mutate('m1') }),
      node('m2', 'm2', { mutationKey: 'shared', run: () => mutate('m2') }),
      node('independent', 'independent'),
    ], { maxConcurrency: 4 })
    expect(peakConcurrentMutations).toBe(1)
    expect(result.order).toEqual(['independent', 'm1', 'm2'])
    expect(result.peakConcurrency).toBe(2)
  })
})
