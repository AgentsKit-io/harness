import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { advanceQueueOwner, countRotationBlockingLeases, queueOwner, rotationStatePath, validateLoopConfig } from '../src/index.js'
import type { LoadedLoopConfig, LoopConfig } from '../src/index.js'

const dir = () => mkdtempSync(join(tmpdir(), 'agentskit-rotation-gaps-'))

const config = (overrides: Partial<LoopConfig['linear']['rotation']> = {}): LoopConfig => validateLoopConfig({
  project: { name: 'demo', repo: 'org/demo' },
  linear: { workspaceId: 'ws-1', teamKey: 'ENG', person: 'person', rotation: { enabled: true, advanceWhenEmpty: true, owners: ['person', 'teammate'], ...overrides } },
  models: {
    orchestrator: [['codex/gpt-5.6-sol', 'claude/opus'], ['opencode/opencode-go/glm-5.3'], ['grok/grok-4-fast']],
    reviewer: [['codex/gpt-5.6-sol', 'claude/opus'], ['grok/grok-4-fast']],
    builder: [['codex/gpt-5.6-luna', 'claude/sonnet'], ['opencode/opencode-go/glm-5.3-flash'], ['grok/grok-4-fast']],
    watcher: [['claude/haiku']],
    providers: {
      claude: { bin: 'claude', auth: 'subscription', envKeys: ['ANTHROPIC_API_KEY'], tui: 'claude --model {model} --permission-mode auto' },
      codex: { bin: 'codex', auth: 'subscription', tui: 'codex -m {model} --full-auto' },
      opencode: { bin: 'opencode', orcaUsageKey: 'opencodeGo', tui: 'opencode -m {model}' },
      grok: { bin: 'grok', auth: 'subscription', tui: 'grok -m {model}' },
    },
  },
  delivery: { verifyCommand: 'pnpm test' },
})

const loaded = (stateDir: string, loopConfig: LoopConfig): LoadedLoopConfig => ({ path: join(stateDir, 'loop.config.yaml'), root: stateDir, stateDir, config: loopConfig, configHash: 'x'.repeat(64) })

describe('countRotationBlockingLeases', () => {
  it('blocks when the delivery record is missing entirely', () => {
    const stateDir = dir()
    const state = loaded(stateDir, config())
    const lease = { key: 'k', tracker: 'linear', repository: 'org/demo', issue: 'ENG-1', worktree: 'eng-1', branch: 'b', owner: 'o', claimedAt: '2026-01-01T00:00:00.000Z' } as never
    expect(countRotationBlockingLeases(state, [lease])).toBe(1)
  })

  it('blocks fail-closed when the delivery record is corrupt JSON', () => {
    const stateDir = dir()
    const state = loaded(stateDir, config())
    mkdirSync(join(stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(stateDir, 'issues', 'ENG-1', 'delivery.json'), 'not-json', 'utf8')
    const lease = { key: 'k', tracker: 'linear', repository: 'org/demo', issue: 'ENG-1', worktree: 'eng-1', branch: 'b', owner: 'o', claimedAt: '2026-01-01T00:00:00.000Z' } as never
    expect(countRotationBlockingLeases(state, [lease])).toBe(1)
  })

  it('blocks when the delivery record has a held reason but no PR yet', () => {
    const stateDir = dir()
    const state = loaded(stateDir, config())
    mkdirSync(join(stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(stateDir, 'issues', 'ENG-1', 'delivery.json'), JSON.stringify({ prNumber: null, heldFor: 'protected-paths', finalOutcome: null }))
    const lease = { key: 'k', tracker: 'linear', repository: 'org/demo', issue: 'ENG-1', worktree: 'eng-1', branch: 'b', owner: 'o', claimedAt: '2026-01-01T00:00:00.000Z' } as never
    expect(countRotationBlockingLeases(state, [lease])).toBe(0)
  })
})

describe('queueOwner', () => {
  it('falls back to the configured person when the rotation state file is corrupt', () => {
    const stateDir = dir()
    const state = loaded(stateDir, config())
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(rotationStatePath(stateDir), 'not-json', 'utf8')
    expect(queueOwner(state)).toBe('person')
  })

  it('falls back to the configured person when the recorded owner is not a current rotation member', () => {
    const stateDir = dir()
    const state = loaded(stateDir, config())
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(rotationStatePath(stateDir), JSON.stringify({ owner: 'former-teammate', advancedAt: '2026-01-01T00:00:00.000Z' }))
    expect(queueOwner(state)).toBe('person')
  })
})

describe('advanceQueueOwner', () => {
  it('does not advance when rotation is disabled or has no owners', () => {
    const stateDir = dir()
    expect(advanceQueueOwner(loaded(stateDir, config({ enabled: false })), { queueEmpty: true, activeLeases: 0 }).advanced).toBe(false)
    expect(advanceQueueOwner(loaded(dir(), config({ owners: [] })), { queueEmpty: true, activeLeases: 0 }).advanced).toBe(false)
  })

  it('does not advance past the last owner in the rotation', () => {
    const stateDir = dir()
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(rotationStatePath(stateDir), JSON.stringify({ owner: 'teammate', advancedAt: '2026-01-01T00:00:00.000Z' }))
    const result = advanceQueueOwner(loaded(stateDir, config()), { queueEmpty: true, activeLeases: 0 })
    expect(result).toMatchObject({ owner: 'teammate', advanced: false })
  })

  it('does not advance when the current owner is not itself a rotation member', () => {
    const stateDir = dir()
    const result = advanceQueueOwner(loaded(stateDir, config({ owners: ['someone-else'] })), { queueEmpty: true, activeLeases: 0 })
    expect(result).toMatchObject({ owner: 'person', advanced: false })
  })
})
