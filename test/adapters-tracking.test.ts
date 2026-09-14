import { describe, expect, it } from 'vitest'
import { createTrackingAdapter, createTrackingTransition } from '../src/index.js'

const base = { tracker: 'linear', issue: 'ENG-1', to: 'qa', reason: 'validated' } as const

describe('createTrackingTransition', () => {
  it('rejects a blank tracker, issue, to, or reason', () => {
    expect(() => createTrackingTransition({ ...base, tracker: '' })).toThrow(/tracker is required/)
    expect(() => createTrackingTransition({ ...base, issue: '' })).toThrow(/issue is required/)
    expect(() => createTrackingTransition({ ...base, to: '' })).toThrow(/to is required/)
    expect(() => createTrackingTransition({ ...base, reason: '' })).toThrow(/reason is required/)
  })

  it('includes an optional from only when it is a non-empty string', () => {
    expect(createTrackingTransition(base)).not.toHaveProperty('from')
    expect(createTrackingTransition({ ...base, from: 'todo' })).toMatchObject({ from: 'todo' })
  })

  it('rejects a from field that is present but whitespace-only', () => {
    expect(() => createTrackingTransition({ ...base, from: '   ' })).toThrow(/from is required/)
  })
})

describe('createTrackingAdapter', () => {
  it('rejects a blank adapter id', () => {
    expect(() => createTrackingAdapter('', async () => {})).toThrow(/id is required/)
  })

  it('deduplicates a repeated transition by idempotencyKey, calling the handler and incrementing telemetry only once', async () => {
    let calls = 0
    const adapter = createTrackingAdapter('linear', () => { calls += 1 })
    await adapter.transition(base)
    await adapter.transition(base)
    expect(calls).toBe(1)
    expect(adapter.telemetry?.()).toMatchObject({ externalMutations: 1 })
  })

  it('supports a synchronous (non-Promise) handler', async () => {
    let called = false
    const adapter = createTrackingAdapter('linear', () => { called = true })
    await adapter.transition(base)
    expect(called).toBe(true)
  })
})
