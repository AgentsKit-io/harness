import { hashJson } from './hash.js'
import { fail } from './errors.js'

export interface LlmCacheKeyInput {
  readonly sourceRevision: string
  readonly contractHash: string
  readonly configHash: string
  readonly provider: string
  readonly model: string
  readonly systemPromptHash: string
  readonly inputHash: string
  readonly contextHash?: string
  readonly toolSchemaHash?: string
  readonly operation: 'context' | 'read-only'
}

export interface LlmCacheStats {
  readonly hits: number
  readonly misses: number
  readonly invalidations: number
}

export const validateCacheableOperation = (operation: unknown): 'context' | 'read-only' => {
  if (operation !== 'context' && operation !== 'read-only') fail('Only context and read-only operations may use the LLM cache.', 'POLICY_BLOCKED')
  return operation as 'context' | 'read-only'
}

export const createLlmCacheKey = (input: LlmCacheKeyInput): string => {
  validateCacheableOperation(input.operation)
  return hashJson(input)
}

export interface LlmCache<T> {
  getOrCompute(key: string, compute: () => Promise<T>): Promise<T>
  invalidate(key?: string): void
  stats(): LlmCacheStats
}

export const createLlmCache = <T>(): LlmCache<T> => {
  const values = new Map<string, T>()
  let hits = 0
  let misses = 0
  let invalidations = 0
  return {
    async getOrCompute(key, compute) {
      const cached = values.get(key)
      if (cached !== undefined) { hits += 1; return cached }
      misses += 1
      const value = await compute()
      values.set(key, value)
      return value
    },
    invalidate(key) {
      if (key === undefined) { invalidations += values.size; values.clear(); return }
      if (values.delete(key)) invalidations += 1
    },
    stats: () => ({ hits, misses, invalidations }),
  }
}
