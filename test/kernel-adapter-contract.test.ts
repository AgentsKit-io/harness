import { describe, expect, it } from 'vitest'
import { HarnessError, unknownTelemetry, validateAdapterMetadata } from '../src/index.js'

describe('validateAdapterMetadata', () => {
  it('accepts valid metadata with every optional telemetry field present', () => {
    const metadata = validateAdapterMetadata({
      assurance: 'runtime-attested',
      telemetry: { status: 'measured', durationMs: 10, inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheHits: 0, cacheMisses: 0, memoryReads: 0, memoryWrites: 0, memoryRelevantHits: 0, memoryStaleHits: 0, contextReferences: 0, contextCostTokens: 0, externalMutations: 0 },
    })
    expect(metadata.assurance).toBe('runtime-attested')
  })

  it('rejects a non-object value', () => {
    expect(() => validateAdapterMetadata(null)).toThrow(HarnessError)
    expect(() => validateAdapterMetadata('nope')).toThrow(HarnessError)
    expect(() => validateAdapterMetadata([])).toThrow(HarnessError)
  })

  it('rejects an invalid assurance level', () => {
    expect(() => validateAdapterMetadata({ assurance: 'trust-me', telemetry: { status: 'measured' } })).toThrow(/assurance is invalid/)
  })

  it('rejects a missing or malformed telemetry object', () => {
    expect(() => validateAdapterMetadata({ assurance: 'unverified' })).toThrow(/telemetry must be an object/)
    expect(() => validateAdapterMetadata({ assurance: 'unverified', telemetry: null })).toThrow(/telemetry must be an object/)
    expect(() => validateAdapterMetadata({ assurance: 'unverified', telemetry: [] })).toThrow(/telemetry must be an object/)
  })

  it('rejects an invalid telemetry status', () => {
    expect(() => validateAdapterMetadata({ assurance: 'unverified', telemetry: { status: 'guessing' } })).toThrow(/telemetry status is invalid/)
  })

  it('rejects a negative or non-finite numeric telemetry field', () => {
    expect(() => validateAdapterMetadata({ assurance: 'unverified', telemetry: { status: 'measured', durationMs: -1 } })).toThrow(/durationMs must be a non-negative number/)
    expect(() => validateAdapterMetadata({ assurance: 'unverified', telemetry: { status: 'measured', totalTokens: Number.NaN } })).toThrow(/totalTokens must be a non-negative number/)
    expect(() => validateAdapterMetadata({ assurance: 'unverified', telemetry: { status: 'measured', cacheHits: Number.POSITIVE_INFINITY } })).toThrow(/cacheHits must be a non-negative number/)
  })

  it('unknownTelemetry returns a fixed unmeasured shape', () => {
    expect(unknownTelemetry()).toEqual({ status: 'unknown' })
  })
})
