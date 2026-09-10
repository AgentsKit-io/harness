import { hashJson } from './hash.js'
import { fail } from './errors.js'

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export interface MemoryUsage {
  readonly reads: number
  readonly writes: number
  readonly relevantHits: number
  readonly staleHits: number
}

export interface CacheUsage {
  readonly hits: number
  readonly misses: number
  readonly invalidations: number
  readonly tokensSaved?: number
}

export interface ParallelismUsage {
  readonly tasks: number
  readonly peakConcurrency: number
  readonly criticalPathMs: number
  readonly queueWaitMs?: number
}

export interface OptimizationObservation {
  readonly sourceRevision: string
  readonly contractHash: string
  readonly configHash: string
  readonly provider: string
  readonly model: string
  readonly durationMs: number
  readonly accuracy?: number
  readonly tokens?: TokenUsage
  readonly memory?: MemoryUsage
  readonly cache?: CacheUsage
  readonly parallelism?: ParallelismUsage
}

const nonNegative = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative number.`, 'INVALID_INPUT')
  return value
}

const nonNegativeInteger = (value: number, label: string): number => {
  nonNegative(value, label)
  if (!Number.isInteger(value)) fail(`${label} must be an integer.`, 'INVALID_INPUT')
  return value
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

export const validateOptimizationObservation = (observation: OptimizationObservation): OptimizationObservation => {
  required(observation.sourceRevision, 'sourceRevision')
  required(observation.contractHash, 'contractHash')
  required(observation.configHash, 'configHash')
  required(observation.provider, 'provider')
  required(observation.model, 'model')
  nonNegative(observation.durationMs, 'durationMs')
  if (observation.accuracy !== undefined && (!Number.isFinite(observation.accuracy) || observation.accuracy < 0 || observation.accuracy > 1)) fail('accuracy must be between 0 and 1.', 'INVALID_INPUT')
  if (observation.tokens) {
    const tokens = observation.tokens
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) nonNegativeInteger(tokens[key], `tokens.${key}`)
    if (tokens.totalTokens !== tokens.inputTokens + tokens.outputTokens) fail('tokens.totalTokens must equal inputTokens + outputTokens.', 'INVALID_INPUT')
    for (const key of ['cacheReadTokens', 'cacheWriteTokens'] as const) if (tokens[key] !== undefined) nonNegativeInteger(tokens[key]!, `tokens.${key}`)
  }
  if (observation.memory) for (const key of ['reads', 'writes', 'relevantHits', 'staleHits'] as const) nonNegativeInteger(observation.memory[key], `memory.${key}`)
  if (observation.cache) {
    for (const key of ['hits', 'misses', 'invalidations'] as const) nonNegativeInteger(observation.cache[key], `cache.${key}`)
    if (observation.cache.tokensSaved !== undefined) nonNegativeInteger(observation.cache.tokensSaved, 'cache.tokensSaved')
  }
  if (observation.parallelism) {
    for (const key of ['tasks', 'peakConcurrency'] as const) nonNegativeInteger(observation.parallelism[key], `parallelism.${key}`)
    nonNegative(observation.parallelism.criticalPathMs, 'parallelism.criticalPathMs')
    if (observation.parallelism.queueWaitMs !== undefined) nonNegative(observation.parallelism.queueWaitMs, 'parallelism.queueWaitMs')
    if (observation.parallelism.tasks > 0 && observation.parallelism.peakConcurrency < 1) fail('parallelism.peakConcurrency must be positive when tasks exist.', 'INVALID_INPUT')
  }
  return observation
}

export interface OptimizationComparison {
  readonly comparable: boolean
  readonly reason: string
  readonly digest: string
  readonly durationDeltaMs?: number
  readonly tokenDelta?: number
  readonly accuracyDelta?: number
  readonly cacheHitRateDelta?: number
  readonly memoryRelevantHitRateDelta?: number
  readonly peakConcurrencyDelta?: number
}

const rate = (hits: number, total: number): number | undefined => total ? Number((hits / total).toFixed(4)) : undefined

export const compareOptimization = (baseline: OptimizationObservation, candidate: OptimizationObservation): OptimizationComparison => {
  validateOptimizationObservation(baseline)
  validateOptimizationObservation(candidate)
  for (const key of ['sourceRevision', 'contractHash', 'configHash', 'provider', 'model'] as const) if (baseline[key] !== candidate[key]) return { comparable: false, reason: `Bindings differ: ${key}.`, digest: hashJson({ baseline, candidate }) }
  const result: OptimizationComparison = {
    comparable: true,
    reason: 'Observations share source, contract, configuration, provider, and model bindings.',
    digest: hashJson({ baseline, candidate }),
    durationDeltaMs: candidate.durationMs - baseline.durationMs,
    ...(baseline.accuracy !== undefined && candidate.accuracy !== undefined ? { accuracyDelta: Number((candidate.accuracy - baseline.accuracy).toFixed(4)) } : {}),
    ...(baseline.tokens && candidate.tokens ? { tokenDelta: candidate.tokens.totalTokens - baseline.tokens.totalTokens } : {}),
    ...(baseline.cache && candidate.cache ? { cacheHitRateDelta: (rate(candidate.cache.hits, candidate.cache.hits + candidate.cache.misses) ?? 0) - (rate(baseline.cache.hits, baseline.cache.hits + baseline.cache.misses) ?? 0) } : {}),
    ...(baseline.memory && candidate.memory ? { memoryRelevantHitRateDelta: (rate(candidate.memory.relevantHits, candidate.memory.reads) ?? 0) - (rate(baseline.memory.relevantHits, baseline.memory.reads) ?? 0) } : {}),
    ...(baseline.parallelism && candidate.parallelism ? { peakConcurrencyDelta: candidate.parallelism.peakConcurrency - baseline.parallelism.peakConcurrency } : {}),
  }
  return result
}
