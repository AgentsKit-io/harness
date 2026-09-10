import { fail } from './errors.js'

export const ASSURANCE_LEVELS = ['unverified', 'contract-tested', 'runtime-attested'] as const
export type AssuranceLevel = typeof ASSURANCE_LEVELS[number]

export interface AdapterTelemetry {
  readonly status: 'measured' | 'unknown'
  readonly durationMs?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheHits?: number
  readonly cacheMisses?: number
  readonly memoryReads?: number
  readonly memoryWrites?: number
  readonly memoryRelevantHits?: number
  readonly memoryStaleHits?: number
  readonly contextReferences?: number
  readonly contextCostTokens?: number
  readonly externalMutations?: number
}

export interface AdapterMetadata {
  readonly assurance: AssuranceLevel
  readonly telemetry: AdapterTelemetry
}

const nonNegative = (value: unknown, label: string): number => {
  if (!Number.isFinite(value) || (value as number) < 0) return fail(`${label} must be a non-negative number.`, 'INVALID_INPUT')
  return value as number
}

export const validateAdapterMetadata = (value: unknown): AdapterMetadata => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('Adapter metadata must be an object.', 'INVALID_INPUT')
  const candidate = value as Record<string, unknown>
  if (!ASSURANCE_LEVELS.includes(candidate['assurance'] as AssuranceLevel)) return fail('Adapter assurance is invalid.', 'INVALID_INPUT')
  if (typeof candidate['telemetry'] !== 'object' || candidate['telemetry'] === null || Array.isArray(candidate['telemetry'])) return fail('Adapter telemetry must be an object.', 'INVALID_INPUT')
  const telemetry = candidate['telemetry'] as Record<string, unknown>
  if (telemetry['status'] !== 'measured' && telemetry['status'] !== 'unknown') return fail('Adapter telemetry status is invalid.', 'INVALID_INPUT')
  for (const key of ['durationMs', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheHits', 'cacheMisses', 'memoryReads', 'memoryWrites', 'memoryRelevantHits', 'memoryStaleHits', 'contextReferences', 'contextCostTokens', 'externalMutations']) if (telemetry[key] !== undefined) nonNegative(telemetry[key], `Adapter telemetry ${key}`)
  return value as AdapterMetadata
}

export const unknownTelemetry = (): AdapterTelemetry => ({ status: 'unknown' })
