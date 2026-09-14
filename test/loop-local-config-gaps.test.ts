import { describe, expect, it } from 'vitest'
import { parseTeamMembers, promptLocalConfig, validateLoopConfig } from '../src/index.js'
import type { CommandResult, CommandRunner, LoadedLoopConfig, LocalConfigPrompter } from '../src/index.js'

const config = validateLoopConfig({
  project: { name: 'demo', repo: 'org/demo' },
  linear: { workspaceId: 'ws-1', teamKey: 'ENG', person: 'person' },
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

const loaded: LoadedLoopConfig = { path: '/tmp/loop.config.yaml', root: '/tmp', stateDir: '/tmp/state', config, configHash: 'x'.repeat(64) }

const nullRunner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: JSON.stringify({ ok: true, result: { members: [] } }), stderr: '', timedOut: false, durationMs: 1 }) }
const failingRunner: CommandRunner = { run: async (): Promise<CommandResult> => { throw new Error('orca not found') } }

const prompter = (overrides: Partial<LocalConfigPrompter> = {}): LocalConfigPrompter & { readonly lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    select: async () => 'person',
    text: async (_question, fallback) => fallback,
    confirm: async (_question, fallback) => fallback,
    write: (line) => { lines.push(line) },
    ...overrides,
  }
}

describe('parseTeamMembers', () => {
  it('reads a bare array result and falls back to an empty list for non-array/non-record input', () => {
    expect(parseTeamMembers([{ id: 'a', displayName: 'x' }])).toEqual([{ id: 'a', displayName: 'x' }])
    expect(parseTeamMembers('not-a-list')).toEqual([])
    expect(parseTeamMembers(null)).toEqual([])
  })

  it('reads a "users" key when "members" is absent, and yields [] when neither is present', () => {
    expect(parseTeamMembers({ users: [{ id: 'a', name: 'x' }] })).toEqual([{ id: 'a', displayName: 'x' }])
    expect(parseTeamMembers({})).toEqual([])
  })
})

describe('promptLocalConfig', () => {
  it('warns and falls back to typing a name when the team-member listing fails', async () => {
    const io = prompter()
    const result = await promptLocalConfig(failingRunner, loaded, io)
    expect(result).toEqual({ person: 'person' })
    expect(io.lines.some((line) => line.includes('could not list team members'))).toBe(true)
  })

  it('warns with a stringified reason when the team-member listing throws a non-Error value', async () => {
    const throwingRunner: CommandRunner = { run: async (): Promise<CommandResult> => { throw 'orca crashed' } }
    const io = prompter()
    await promptLocalConfig(throwingRunner, loaded, io)
    expect(io.lines.some((line) => line.includes('orca crashed'))).toBe(true)
  })

  it('goes straight to a free-text prompt when there are no known or fetched names', async () => {
    const io = prompter()
    const result = await promptLocalConfig(nullRunner, loaded, io)
    expect(result).toEqual({ person: 'person' })
  })

  it('returns null when the free-text person prompt is cancelled', async () => {
    const io = prompter({ text: async () => null })
    expect(await promptLocalConfig(nullRunner, loaded, io)).toBeNull()
  })

  it('returns just the person when the user declines to tune machine settings', async () => {
    const io = prompter({ confirm: async () => false })
    expect(await promptLocalConfig(nullRunner, loaded, io)).toEqual({ person: 'person' })
  })

  it('returns null when the RAM prompt is cancelled', async () => {
    const io = prompter({ confirm: async () => true, text: async (question, fallback) => question.startsWith('GB of RAM') ? null : fallback })
    expect(await promptLocalConfig(nullRunner, loaded, io)).toBeNull()
  })

  it('returns null when the ceiling prompt is cancelled', async () => {
    const io = prompter({ confirm: async () => true, text: async (question, fallback) => question.startsWith('Maximum concurrent') ? null : fallback })
    expect(await promptLocalConfig(nullRunner, loaded, io)).toBeNull()
  })

  it('accepts tuned RAM and ceiling values, and omits ceiling when left blank', async () => {
    const io = prompter({ confirm: async () => true, text: async (question, fallback) => question.startsWith('GB of RAM') ? '4' : question.startsWith('Maximum concurrent') ? '' : fallback })
    expect(await promptLocalConfig(nullRunner, loaded, io)).toEqual({ person: 'person', minFreeRamGb: 4 })
  })

  it('rejects a non-positive or non-numeric RAM/ceiling answer via the validate callback', async () => {
    const io = prompter({
      confirm: async () => true,
      text: async (question, fallback, validate) => {
        if (question.startsWith('GB of RAM')) {
          expect(validate?.('0')).toMatch(/positive number/)
          expect(validate?.('not-a-number')).toMatch(/positive number/)
          expect(validate?.('2')).toBeNull()
          return '2'
        }
        if (question.startsWith('Maximum concurrent')) {
          expect(validate?.('')).toBeNull()
          expect(validate?.('0')).toMatch(/positive number/)
          return '3'
        }
        return fallback
      },
    })
    expect(await promptLocalConfig(nullRunner, loaded, io)).toEqual({ person: 'person', minFreeRamGb: 2, ceiling: 3 })
  })

  it('falls through to a typed name when the user picks "someone else…" from the list', async () => {
    const withPeople = validateLoopConfig({ ...config, linear: { ...config.linear, people: { person: 'u1', teammate: 'u2' } } })
    const withPeopleLoaded: LoadedLoopConfig = { ...loaded, config: withPeople }
    const io = prompter({ select: async () => '__other__', text: async (_question, fallback) => fallback === 'person' ? 'someone-typed' : fallback })
    const result = await promptLocalConfig(nullRunner, withPeopleLoaded, io)
    expect(result).toEqual({ person: 'someone-typed' })
  })

  it('prefers the currentUserHint when present among known names', async () => {
    const withPeople = validateLoopConfig({ ...config, linear: { ...config.linear, people: { person: 'u1', teammate: 'u2' } } })
    const withPeopleLoaded: LoadedLoopConfig = { ...loaded, config: withPeople }
    let seenInitial: number | undefined
    const io = prompter({ select: async (_question, options, initial) => { seenInitial = initial; return options[initial ?? 0]?.value ?? null } })
    const result = await promptLocalConfig(nullRunner, withPeopleLoaded, io, { currentUserHint: 'teammate' })
    expect(result).toEqual({ person: 'teammate' })
    expect(seenInitial).toBe(1)
  })
})
