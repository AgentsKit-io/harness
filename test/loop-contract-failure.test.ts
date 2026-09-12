import { describe, expect, it } from 'vitest'
import { classifyProviderFailure, extractResetsAt } from '../src/index.js'

describe('classifyProviderFailure', () => {
  it('classifies real CLI usage-limit phrasing as quota, not "other" (regression: 2026-09-11 pilot — 19 unclassified contract failures)', () => {
    expect(classifyProviderFailure("You've hit your session limit · resets 10:40pm (America/Sao_Paulo)")).toBe('quota')
    expect(classifyProviderFailure('usage limit reached')).toBe('quota')
    expect(classifyProviderFailure("You've hit your weekly limit · resets in 3h")).toBe('quota')
    expect(classifyProviderFailure('Your credit balance is too low to access the Anthropic API')).toBe('quota')
    expect(classifyProviderFailure('spend limit reached for this organization')).toBe('quota')
    expect(classifyProviderFailure('Overloaded')).toBe('quota')
    expect(classifyProviderFailure('Server is temporarily limiting requests')).toBe('quota')
  })

  it('still classifies auth and generic rate-limit failures correctly', () => {
    expect(classifyProviderFailure('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe('auth')
    expect(classifyProviderFailure('Not logged in · Please run /login')).toBe('auth')
    expect(classifyProviderFailure('429 Too Many Requests')).toBe('quota')
    expect(classifyProviderFailure('rate limit exceeded, please retry')).toBe('quota')
  })

  it('falls back to timeout/other when nothing matches', () => {
    expect(classifyProviderFailure('anything', true)).toBe('timeout')
    expect(classifyProviderFailure('exit 1: no such file or directory')).toBe('other')
  })
})

describe('extractResetsAt', () => {
  it('parses a relative reset ("resets in 3h")', () => {
    const now = new Date('2026-09-11T22:00:00.000Z')
    const resetsAt = extractResetsAt("You've hit your weekly limit · resets in 3h", now)
    expect(resetsAt).toBe('2026-09-12T01:00:00.000Z')
  })

  it('parses a relative reset in minutes', () => {
    const now = new Date('2026-09-11T22:00:00.000Z')
    expect(extractResetsAt('resets in 45 minutes', now)).toBe('2026-09-11T22:45:00.000Z')
  })

  it('parses a clock-time reset, rolling to tomorrow when already past', () => {
    const now = new Date('2026-09-11T22:00:00.000Z') // arbitrary UTC instant
    const resetsAt = extractResetsAt('resets 10:40pm', now)
    expect(resetsAt).not.toBeNull()
    const parsed = new Date(resetsAt as string)
    expect(parsed.getHours()).toBe(22)
    expect(parsed.getMinutes()).toBe(40)
  })

  it('returns null when no reset instant can be parsed', () => {
    expect(extractResetsAt('usage limit reached', new Date())).toBeNull()
    expect(extractResetsAt('', new Date())).toBeNull()
  })
})
