import { describe, expect, it } from 'vitest'
import { classifyFailure, recoveryDelayMs, runWithRecovery } from '../src/index.js'

describe('resilience', () => {
  it('classifies quota and applies bounded exponential backoff', () => {
    expect(classifyFailure({ code: '429', message: 'rate limit' }).class).toBe('quota')
    expect(recoveryDelayMs(4, { baseDelayMs: 100, maxDelayMs: 500 })).toBe(500)
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
})
