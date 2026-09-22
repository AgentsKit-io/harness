import { describe, expect, it } from 'vitest'
import {
  compareVersions, orcaAccountList, orcaAgentHooks, orcaAutomationCreateArgv, orcaAutomationEditArgv, orcaAutomationRemove, orcaAutomationRun, orcaAutomationRuns, orcaJson, orcaStatus, orcaTerminalCreate, orcaTerminalList, orcaTerminalScreen,
  orcaRetryRequestId, orcaTerminalSend, orcaTerminalWait, orcaVersion, orcaWorktreeRemove, orcaWorktreeSet, orcaWorktrees, parseOrcaAgentHooks, parseOrcaAutomations, parseOrcaSendReceipt, parseOrcaStatus, parseOrcaTerminals, parseOrcaVersion, parseOrcaWorktreeCreate, parseOrcaWorktrees,
} from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const recorder = (respond: (argv: readonly string[]) => CommandResult): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  return { calls, run: async (argv) => { calls.push([...argv]); return respond(argv) } }
}
const ok = (result: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '', timedOut: false, durationMs: 1 })
const envelopeFail = (error: string): CommandResult => ({ code: 1, stdout: JSON.stringify({ ok: false, error }), stderr: '', timedOut: false, durationMs: 1 })

describe('compareVersions', () => {
  it('compares by numeric segment, treating a missing or non-numeric segment as 0', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0)
  })
})

describe('parseOrcaVersion', () => {
  it('extracts the first semver-shaped substring, or null when absent', () => {
    expect(parseOrcaVersion('orca version 1.4.200 (build x)')).toBe('1.4.200')
    expect(parseOrcaVersion('no version here')).toBeNull()
  })
})

describe('parseOrcaStatus', () => {
  it('defaults every field when the payload is empty or malformed', () => {
    expect(parseOrcaStatus({})).toEqual({ appRunning: false, runtimeReady: false, runtimeState: 'unknown', appVersion: null, runtimeId: null })
    expect(parseOrcaStatus(null)).toMatchObject({ appRunning: false })
  })

  it('requires both state:ready and reachable:true for runtimeReady', () => {
    expect(parseOrcaStatus({ runtime: { state: 'ready', reachable: false } }).runtimeReady).toBe(false)
    expect(parseOrcaStatus({ runtime: { state: 'starting', reachable: true } }).runtimeReady).toBe(false)
    expect(parseOrcaStatus({ runtime: { state: 'ready', reachable: true } }).runtimeReady).toBe(true)
  })
})

describe('parseOrcaWorktrees: linkedLinear and defaults', () => {
  it('reads linkedLinearIssue from a plain string or from identifier/id/url on an object, else null', () => {
    const of = (linkedLinearIssue: unknown) => parseOrcaWorktrees({ worktrees: [{ worktreeId: 'w1', linkedLinearIssue }] })[0]?.linkedLinearIssue
    expect(of('ENG-1')).toBe('ENG-1')
    expect(of({ identifier: 'ENG-2' })).toBe('ENG-2')
    expect(of({ id: 'ENG-3' })).toBe('ENG-3')
    expect(of({ url: 'https://x' })).toBe('https://x')
    expect(of({})).toBeNull()
    expect(of(null)).toBeNull()
  })

  it('strips a refs/heads/ prefix from branch, and drops entries with no id', () => {
    expect(parseOrcaWorktrees({ worktrees: [{ worktreeId: 'w1', branch: 'refs/heads/main' }] })[0]?.branch).toBe('main')
    expect(parseOrcaWorktrees({ worktrees: [{}] })).toEqual([])
  })

  it('accepts a bare array result', () => {
    expect(parseOrcaWorktrees([{ worktreeId: 'w1' }])).toHaveLength(1)
  })
})

describe('parseOrcaAgentHooks', () => {
  it('skips an entry with no agent name, and maps unrecognised states to unknown', () => {
    expect(parseOrcaAgentHooks({ statuses: [{ state: 'installed' }, { agent: 'claude', state: 'weird' }, { agent: 'codex', state: 'not_installed' }] })).toEqual({ claude: 'unknown', codex: 'not_installed' })
  })

  it('returns an empty object when statuses is absent or not an array', () => {
    expect(parseOrcaAgentHooks({})).toEqual({})
    expect(parseOrcaAgentHooks({ statuses: 'nope' })).toEqual({})
  })
})

describe('orcaJson: transport failure classification', () => {
  it('fails closed on timeout, a missing envelope, and an explicit envelope failure', async () => {
    const timedOut: CommandRunner = { run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true, durationMs: 1 }) }
    await expect(orcaJson(timedOut, ['status'])).rejects.toThrow(/timed out after/)
    const noEnvelope: CommandRunner = { run: async () => ({ code: 1, stdout: 'not json', stderr: 'boom', timedOut: false, durationMs: 1 }) }
    await expect(orcaJson(noEnvelope, ['status'])).rejects.toThrow(/without a JSON envelope: boom/)
    const explicitFailure: CommandRunner = { run: async () => envelopeFail('provider unavailable') }
    await expect(orcaJson(explicitFailure, ['status'])).rejects.toThrow(/failed: provider unavailable/)
  })

  it('does not append --json twice when the caller already included it', async () => {
    const runner = recorder(() => ok({}))
    await orcaJson(runner, ['status', '--json'])
    expect(runner.calls[0]?.filter((a) => a === '--json')).toHaveLength(1)
  })
})

describe('orcaVersion', () => {
  it('returns null on a non-zero exit instead of parsing garbage', async () => {
    const runner: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'not found', timedOut: false, durationMs: 1 }) }
    expect(await orcaVersion(runner)).toBeNull()
  })

  it('parses the version on a successful exit', async () => {
    const runner: CommandRunner = { run: async () => ({ code: 0, stdout: '1.4.200', stderr: '', timedOut: false, durationMs: 1 }) }
    expect(await orcaVersion(runner)).toBe('1.4.200')
  })
})

describe('thin orca* wrappers', () => {
  it('orcaStatus/orcaWorktrees/orcaAgentHooks/orcaAccountList call through orcaJson with the right subcommand', async () => {
    const runner = recorder(() => ok({}))
    await orcaStatus(runner)
    await orcaWorktrees(runner)
    await orcaAgentHooks(runner)
    await orcaAccountList(runner)
    expect(runner.calls.map((c) => c.slice(1, -1))).toEqual([['status'], ['worktree', 'ps'], ['agent', 'hooks', 'status'], ['account', 'list']])
  })
})

describe('parseOrcaWorktreeCreate: id/path/branch fallbacks', () => {
  it('derives path from the worktreeId when no explicit path is given', () => {
    const created = parseOrcaWorktreeCreate({ worktreeId: 'repo-1::/absolute/path/eng-1' })
    expect(created.path).toBe('/absolute/path/eng-1')
  })

  it('reads agentTerminalHandle from record, nested worktree, or startupTerminal, in that order', () => {
    expect(parseOrcaWorktreeCreate({ worktreeId: 'w1', agentTerminalHandle: 'top' }).agentTerminalHandle).toBe('top')
    expect(parseOrcaWorktreeCreate({ worktree: { id: 'w1', agentTerminalHandle: 'nested' } }).agentTerminalHandle).toBe('nested')
    expect(parseOrcaWorktreeCreate({ worktreeId: 'w1', startupTerminal: { handle: 'startup' } }).agentTerminalHandle).toBe('startup')
    expect(parseOrcaWorktreeCreate({ worktreeId: 'w1' }).agentTerminalHandle).toBeNull()
  })

  it('fails closed when no worktree id can be found anywhere', () => {
    expect(() => parseOrcaWorktreeCreate({})).toThrow(/no worktree id/)
  })
})

describe('worktree lifecycle writes', () => {
  it('orcaWorktreeSet forwards the built argv (minus bin) to orcaJson', async () => {
    const runner = recorder(() => ok({}))
    await orcaWorktreeSet(runner, { worktree: 'w1', comment: 'note' })
    expect(runner.calls[0]).toEqual(['orca', 'worktree', 'set', '--worktree', 'w1', '--comment', 'note', '--json'])
  })

  it('orcaWorktreeRemove includes --force only when requested', async () => {
    const runner = recorder(() => ok({}))
    await orcaWorktreeRemove(runner, { worktree: 'w1' })
    expect(runner.calls[0]).not.toContain('--force')
    await orcaWorktreeRemove(runner, { worktree: 'w1', force: true })
    expect(runner.calls[1]).toContain('--force')
  })
})

describe('parseOrcaTerminals: status derivation', () => {
  it('prioritises orphaned, then disconnected, then an explicit status/state, then connected inference', () => {
    const of = (item: Record<string, unknown>) => parseOrcaTerminals({ terminals: [{ handle: 'h', ...item }] })[0]?.status
    expect(of({ orphaned: true, connected: false })).toBe('orphaned')
    expect(of({ connected: false })).toBe('disconnected')
    expect(of({ status: 'busy' })).toBe('busy')
    expect(of({ state: 'idle' })).toBe('idle')
    expect(of({ connected: true })).toBe('connected')
    expect(of({})).toBe('unknown')
  })

  it('accepts result.items as an alternate list key, and a bare array', () => {
    expect(parseOrcaTerminals({ items: [{ handle: 'h1' }] })).toHaveLength(1)
    expect(parseOrcaTerminals([{ handle: 'h1' }])).toHaveLength(1)
  })

  it('reads command from item.command or item.agent, and drops entries with no handle', () => {
    expect(parseOrcaTerminals({ terminals: [{ handle: 'h', agent: 'claude' }] })[0]?.command).toBe('claude')
    expect(parseOrcaTerminals({ terminals: [{}] })).toEqual([])
  })
})

describe('orcaTerminalList / orcaTerminalCreate', () => {
  it('includes --worktree and --limit only when provided', async () => {
    const runner = recorder(() => ok({ terminals: [] }))
    await orcaTerminalList(runner)
    expect(runner.calls[0]).not.toContain('--worktree')
    await orcaTerminalList(runner, { worktree: 'w1', limit: 5 })
    expect(runner.calls[1]).toEqual(expect.arrayContaining(['--worktree', 'w1', '--limit', '5']))
  })

  it('reads the handle from a nested terminal object or the top level, and includes --title when given', async () => {
    const nested = recorder(() => ok({ terminal: { handle: 'nested-handle' } }))
    expect((await orcaTerminalCreate(nested, { worktree: 'w1', command: 'claude' })).handle).toBe('nested-handle')
    const flat = recorder(() => ok({ handle: 'flat-handle' }))
    expect((await orcaTerminalCreate(flat, { worktree: 'w1', command: 'claude', title: 'My terminal' })).handle).toBe('flat-handle')
    expect(flat.calls[0]).toContain('--title')
  })

  it('fails closed when the response has no terminal handle', async () => {
    const runner = recorder(() => ok({}))
    await expect(orcaTerminalCreate(runner, { worktree: 'w1', command: 'claude' })).rejects.toThrow(/no terminal handle/)
  })
})

describe('parseOrcaSendReceipt: additional shapes', () => {
  it('treats an explicit accepted:false with a queued stage as still accepted', () => {
    expect(parseOrcaSendReceipt({ accepted: false, stages: [{ stage: 'input_queued' }] }).accepted).toBe(true)
  })

  it('reads warnings as plain strings or {message} objects, from the top level or nested under send', () => {
    expect(parseOrcaSendReceipt({ warnings: ['plain', { message: 'structured' }] }).warnings).toEqual(['plain', 'structured'])
    expect(parseOrcaSendReceipt({ send: { warnings: ['nested'] } }).warnings).toEqual(['nested'])
  })

  it('reads requestId from receipt, prompt, or the top-level record, in that order', () => {
    expect(parseOrcaSendReceipt({ receipt: { requestId: 'r1' } }).requestId).toBe('r1')
    expect(parseOrcaSendReceipt({ send: { prompt: { requestId: 'r2' } } }).requestId).toBe('r2')
    expect(parseOrcaSendReceipt({ requestId: 'r3' }).requestId).toBe('r3')
  })
})

describe('orcaTerminalWait / orcaTerminalScreen', () => {
  it('reads satisfied from a nested wait object or the top level', async () => {
    const nested = recorder(() => ok({ wait: { satisfied: true } }))
    expect((await orcaTerminalWait(nested, { terminal: 't', for: 'exit', timeoutMs: 1000 })).satisfied).toBe(true)
    const flat = recorder(() => ok({ satisfied: false }))
    expect((await orcaTerminalWait(flat, { terminal: 't', for: 'tui-idle', timeoutMs: 1000 })).satisfied).toBe(false)
  })

  it('joins screen lines from objects or strings, unwraps a nested terminal object, and returns "" when absent', async () => {
    const objectLines = recorder(() => ok({ terminal: { tail: [{ text: 'a' }, { line: 'b' }, 'c'] } }))
    expect(await orcaTerminalScreen(objectLines, { terminal: 't' })).toBe('a\nb\nc')
    const stringScreen = recorder(() => ok({ screen: 'raw text' }))
    expect(await orcaTerminalScreen(stringScreen, { terminal: 't' })).toBe('raw text')
    const empty = recorder(() => ok({}))
    expect(await orcaTerminalScreen(empty, { terminal: 't' })).toBe('')
  })
})

describe('parseOrcaAutomations', () => {
  it('reads trigger from rrule, trigger, a string schedule, or a JSON-stringified object schedule', () => {
    expect(parseOrcaAutomations({ automations: [{ id: 'a', rrule: '*/5 * * * *' }] })[0]?.trigger).toBe('*/5 * * * *')
    expect(parseOrcaAutomations({ automations: [{ id: 'a', trigger: 'manual' }] })[0]?.trigger).toBe('manual')
    expect(parseOrcaAutomations({ automations: [{ id: 'a', schedule: 'cron' }] })[0]?.trigger).toBe('cron')
    expect(parseOrcaAutomations({ automations: [{ id: 'a', schedule: { cron: '*/5' } }] })[0]?.trigger).toBe(JSON.stringify({ cron: '*/5' }))
  })

  it('treats enabled:false or disabled:true as disabled, and defaults to enabled otherwise', () => {
    expect(parseOrcaAutomations({ automations: [{ id: 'a', enabled: false }] })[0]?.enabled).toBe(false)
    expect(parseOrcaAutomations({ automations: [{ id: 'a', disabled: true }] })[0]?.enabled).toBe(false)
    expect(parseOrcaAutomations({ automations: [{ id: 'a' }] })[0]?.enabled).toBe(true)
  })

  it('reads provider from agentId, provider, or agent, and accepts an items list', () => {
    expect(parseOrcaAutomations({ items: [{ id: 'a', agent: 'claude' }] })[0]?.provider).toBe('claude')
  })

  it('drops automations with no id', () => {
    expect(parseOrcaAutomations({ automations: [{}] })).toEqual([])
  })
})

describe('orcaAutomation argv builders: repo vs workspace, and reuseSession', () => {
  it('uses --repo when no workspace is set, and omits --reuse-session when it is false', () => {
    const argv = orcaAutomationCreateArgv({ name: 'n', trigger: 't', prompt: 'p', provider: 'claude', repo: 'org/repo', reuseSession: false })
    expect(argv).toContain('--repo')
    expect(argv).not.toContain('--workspace')
    expect(argv).not.toContain('--reuse-session')
  })

  it('includes --host when provided, for both create and edit', () => {
    expect(orcaAutomationCreateArgv({ name: 'n', trigger: 't', prompt: 'p', provider: 'claude', host: 'machine-1' })).toContain('--host')
    expect(orcaAutomationEditArgv('id', { name: 'n', trigger: 't', prompt: 'p', provider: 'claude', host: 'machine-1' })).toContain('--host')
  })
})

describe('orcaAutomationRemove / Run / Runs', () => {
  it('build the expected argv for each lifecycle action', async () => {
    const runner = recorder(() => ok({}))
    await orcaAutomationRemove(runner, 'auto-1')
    await orcaAutomationRun(runner, 'auto-1')
    await orcaAutomationRuns(runner, 'auto-1')
    expect(runner.calls.map((c) => c.slice(1, -1))).toEqual([['automations', 'remove', 'auto-1'], ['automations', 'run', 'auto-1'], ['automations', 'runs', '--id', 'auto-1']])
  })
})

describe('orcaTerminalSend retry by request id', () => {
  it('re-issues an ambiguous agent-prompt send once, with the id Orca named, instead of failing or typing twice', async () => {
    const message = 'agent_session_ownership_unknown Terminal prompt request ID: 80dc20ef-491a-4b54-afd6-31e99a27c533. Re-issue the exact command with --retry-request 80dc20ef-491a-4b54-afd6-31e99a27c533 --wait-submit <seconds>; do not retry it without that ID.'
    expect(orcaRetryRequestId(message)).toBe('80dc20ef-491a-4b54-afd6-31e99a27c533')
    // The race lasts a moment: the first retry can still lose it, so it waits and tries again with the same id.
    let failures = 2
    const runner = recorder(() => failures-- > 0 ? envelopeFail(message) : ok({ send: { accepted: true } }))
    expect((await orcaTerminalSend(runner, { terminal: 't', text: 'brief', enter: true }, { retryDelayMs: 0 })).accepted).toBe(true)
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls[1]).toEqual(expect.arrayContaining(['--retry-request', '80dc20ef-491a-4b54-afd6-31e99a27c533', '--wait-submit']))
    const plain = recorder(() => envelopeFail('terminal_not_found'))
    await expect(orcaTerminalSend(plain, { terminal: 't', text: 'x' }, { retryDelayMs: 0 })).rejects.toThrow(/terminal_not_found/)
    const stuck = recorder(() => envelopeFail(message))
    await expect(orcaTerminalSend(stuck, { terminal: 't', text: 'x' }, { retryDelayMs: 0 })).rejects.toThrow(/ownership_unknown/)
    expect(stuck.calls).toHaveLength(4)
    expect(plain.calls).toHaveLength(1)
  })
})
