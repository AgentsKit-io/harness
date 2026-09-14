import { describe, expect, it } from 'vitest'
import { HarnessError, classifyFailure, recoveryDelayMs, runWithRecovery } from '../src/index.js'

describe('resilience', () => {
  it('classifies quota and applies bounded exponential backoff', () => {
    expect(classifyFailure({ code: '429', message: 'rate limit' }).class).toBe('quota')
    expect(recoveryDelayMs(4, { baseDelayMs: 100, maxDelayMs: 500 })).toBe(500)
  })

  it('classifies every failure class from message/code shape', () => {
    expect(classifyFailure(new Error('request timed out')).class).toBe('timeout')
    expect(classifyFailure(new Error('policy denied: forbidden action')).class).toBe('policy')
    expect(classifyFailure(new Error('invalid schema for argument')).class).toBe('validation')
    expect(classifyFailure(new Error('ECONNRESET while calling external service')).class).toBe('external')
    expect(classifyFailure(new Error('something unexpected exploded')).class).toBe('unknown')
    expect(classifyFailure('a plain string error').class).toBe('unknown')
  })

  it('marks timeout/quota/external as retryable and policy/validation/unknown as not', () => {
    expect(classifyFailure(new Error('deadline exceeded')).retryable).toBe(true)
    expect(classifyFailure(new Error('rate limit hit')).retryable).toBe(true)
    expect(classifyFailure(new Error('502 from upstream')).retryable).toBe(true)
    expect(classifyFailure(new Error('permission denied')).retryable).toBe(false)
    expect(classifyFailure(new Error('invalid config')).retryable).toBe(false)
    expect(classifyFailure(new Error('nope')).retryable).toBe(false)
  })

  it('rejects non-positive/non-integer attempt and delay inputs', () => {
    expect(() => recoveryDelayMs(0, { baseDelayMs: 0, maxDelayMs: 0 })).toThrow(HarnessError)
    expect(() => recoveryDelayMs(1.5, { baseDelayMs: 0, maxDelayMs: 0 })).toThrow(HarnessError)
    expect(() => recoveryDelayMs(1, { baseDelayMs: -1, maxDelayMs: 0 })).toThrow(HarnessError)
    expect(() => recoveryDelayMs(1, { baseDelayMs: 100, maxDelayMs: 50 })).toThrow(/maxDelayMs must be greater than or equal to baseDelayMs/)
  })

  it('rejects an invalid recovery policy before running the operation', async () => {
    let called = 0
    const op = async () => { called += 1; return 'ok' }
    await expect(runWithRecovery(op, { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 })).rejects.toThrow(HarnessError)
    await expect(runWithRecovery(op, { maxAttempts: 1, baseDelayMs: -1, maxDelayMs: 0 })).rejects.toThrow(HarnessError)
    await expect(runWithRecovery(op, { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 0 })).rejects.toThrow(/maxDelayMs must be greater than or equal to baseDelayMs/)
    await expect(runWithRecovery(op, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 0 })).rejects.toThrow(HarnessError)
    expect(called).toBe(0)
  })

  it('resumes retryable failures and does not retry policy failures', async () => {
    let attempts = 0
    const result = await runWithRecovery(async () => { attempts += 1; if (attempts < 3) throw new Error('quota exceeded'); return 'ok' }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined })
    expect(result.status).toBe('completed')
    expect(result.attempts).toBe(3)
    const blocked = await runWithRecovery(async () => { throw new Error('policy denied') }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined })
    expect(blocked.status).toBe('failed')
    expect(blocked.attempts).toBe(1)
  })

  it('aborts a hung operation via the AbortController when it exceeds timeoutMs', async () => {
    const observations: Array<{ readonly attempt: number; readonly failure: { readonly class: string } }> = []
    let observedAbort = false
    const result = await runWithRecovery(
      (signal) => new Promise(() => { signal.addEventListener('abort', () => { observedAbort = true }) }),
      { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 5, sleep: async () => undefined, onObservation: (o) => observations.push(o) },
    )
    expect(result.status).toBe('failed')
    expect(result.failure?.class).toBe('timeout')
    expect(observations).toHaveLength(1)
    expect(observedAbort).toBe(true)
  })

  it('completes within the timeout budget without racing when the operation is fast', async () => {
    const result = await runWithRecovery(async () => 'done', { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 1000 })
    expect(result).toMatchObject({ status: 'completed', value: 'done', attempts: 1 })
  })
})
