import { describe, expect, it } from 'vitest'
import { commentWaiting } from '../src/loop/queue-waiting.js'

describe('commentWaiting', () => {
  it('comments on each waiting issue, deduped per issue and label', async () => {
    const calls: { issue: string; body: string; dedupeKey?: string }[] = []
    const notes = await commentWaiting({ comment: async (input) => { calls.push(input) } }, ['acme/app#7', 'acme/app#9'], 'loop:pm-ok')
    expect(notes).toEqual([])
    expect(calls.map((c) => c.dedupeKey)).toEqual(['waiting:acme/app#7:loop:pm-ok', 'waiting:acme/app#9:loop:pm-ok'])
    expect(calls[0]?.body).toContain('PM has not checked')
  })

  it('writes nothing when no issue waits (every issue carries loop:pm-ok)', async () => {
    let called = false
    expect(await commentWaiting({ comment: async () => { called = true } }, [], 'loop:pm-ok')).toEqual([])
    expect(called).toBe(false)
  })

  it('reports a failed comment as a note and keeps going', async () => {
    let n = 0
    const notes = await commentWaiting({ comment: async () => { if (n++ === 0) throw new Error('boom') } }, ['a#1', 'a#2'], 'loop:pm-ok')
    expect(notes).toEqual(['waiting comment for a#1 failed: boom'])
    expect(n).toBe(2)
  })
})
