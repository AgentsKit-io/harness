import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeCooldowns, clearProviderCooldown, cooldownPath, markProviderExhausted, readCooldowns } from '../src/index.js'

const dir = () => mkdtempSync(join(tmpdir(), 'agentskit-cooldown-gaps-'))

describe('readCooldowns resilience', () => {
  it('returns an empty state when the file does not exist', () => {
    expect(readCooldowns(dir())).toEqual({})
  })

  it('returns an empty state for malformed JSON', () => {
    const stateDir = dir()
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(cooldownPath(stateDir), 'not-json', 'utf8')
    expect(readCooldowns(stateDir)).toEqual({})
  })

  it('returns an empty state when the stored content is an array or a primitive', () => {
    const stateDir = dir()
    writeFileSync(cooldownPath(stateDir), '[]', 'utf8')
    expect(readCooldowns(stateDir)).toEqual({})
    writeFileSync(cooldownPath(stateDir), '"not-an-object"', 'utf8')
    expect(readCooldowns(stateDir)).toEqual({})
  })
})

describe('markProviderExhausted attempt tracking', () => {
  it('resets attempts to 0 once the prior cooldown window has fully elapsed beyond maxMin', () => {
    const stateDir = dir()
    const first = markProviderExhausted(stateDir, 'codex', { initialMin: 30, maxMin: 60, reason: 'first', now: new Date('2026-09-11T12:00:00.000Z') })
    expect(first.attempts).toBe(0)
    const second = markProviderExhausted(stateDir, 'codex', { initialMin: 30, maxMin: 60, reason: 'second', now: new Date('2026-09-11T14:00:00.000Z') })
    expect(second.attempts).toBe(0)
  })
})

describe('clearProviderCooldown', () => {
  it('is a no-op when the provider has no recorded cooldown', () => {
    const stateDir = dir()
    expect(() => clearProviderCooldown(stateDir, 'codex')).not.toThrow()
    expect(readCooldowns(stateDir)).toEqual({})
  })

  it('removes only the targeted provider from the state', () => {
    const stateDir = dir()
    markProviderExhausted(stateDir, 'codex', { initialMin: 30, maxMin: 240, reason: 'x', now: new Date('2026-09-11T12:00:00.000Z') })
    markProviderExhausted(stateDir, 'claude', { initialMin: 30, maxMin: 240, reason: 'y', now: new Date('2026-09-11T12:00:00.000Z') })
    clearProviderCooldown(stateDir, 'codex')
    const state = readCooldowns(stateDir)
    expect(Object.keys(state)).toEqual(['claude'])
    expect(activeCooldowns(state, new Date('2026-09-11T12:01:00.000Z'))).toEqual({ claude: state.claude!.until })
  })
})
