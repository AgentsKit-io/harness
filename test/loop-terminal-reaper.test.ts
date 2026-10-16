import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLoopConfig } from '../src/index.js'
import type { CommandResult, CommandRunner, DispatchRecordFile } from '../src/index.js'
import type { DeliveryState, DeliverOutcome } from '../src/loop/deliver-state.js'
import { activeTerminalCapacityCooldown, isTerminalCapacityError, liveLoopTerminals, markTerminalCapacity, reapWorkerTerminals, type ReapInput } from '../src/loop/terminal-reaper.js'
import type { OrcaWorktree } from '../src/adapters/orca-cli.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const okResult = (result: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '', timedOut: false, durationMs: 1 })
const NOW = new Date('2026-10-16T12:00:00.000Z')
const minutesAgo = (minutes: number): number => NOW.getTime() - minutes * 60_000

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ROOT = 'C:/Users/me/projects/demo'
const WS = 'C:/Users/me/orca/workspaces/demo'
const record = (issue: string, terminal: string | null = `term_${issue}`): DispatchRecordFile => ({ issue, worktreeId: `repo-1::${WS}/${issue.toLowerCase()}`, worktree: issue.toLowerCase(), branch: `person/${issue.toLowerCase()}`, terminal, provider: 'claude', model: 'sonnet', contractDigest: 'abc', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-10-16T08:00:00.000Z', url: '' }) as DispatchRecordFile
const emptyState = (issue: string, over: Partial<DeliveryState> = {}): DeliveryState => ({ issue, prNumber: null, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: null, finishedAt: null, finalOutcome: null, cancelledAt: null, ...over })
const terminal = (handle: string, worktreeId: string, lastOutputMinutesAgo: number | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ handle, worktreeId, worktreePath: worktreeId.slice(worktreeId.indexOf('::') + 2), connected: true, orphaned: false, lastOutputAt: lastOutputMinutesAgo === null ? undefined : minutesAgo(lastOutputMinutesAgo), title: '◑ Ak-loop task brief', ...extra })

const env = (options: { readonly yaml?: (yaml: string) => string; readonly terminals: readonly Record<string, unknown>[]; readonly closeError?: (handle: string) => string | null; readonly listFails?: boolean }) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-reaper-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), (options.yaml ?? ((yaml) => yaml))(exampleYaml))
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  const calls: string[][] = []
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push([...argv])
      const key = argv.join(' ')
      if (key.startsWith('orca terminal list')) return options.listFails ? { code: 1, stdout: '', stderr: 'orca runtime unavailable', timedOut: false, durationMs: 1 } : okResult({ terminals: options.terminals })
      if (key.startsWith('orca terminal close')) {
        const handle = argv[argv.indexOf('--terminal') + 1] as string
        const error = options.closeError?.(handle)
        return error ? { code: 1, stdout: JSON.stringify({ ok: false, error }), stderr: '', timedOut: false, durationMs: 1 } : okResult({ closed: true })
      }
      return { code: 127, stdout: '', stderr: `no fixture for ${key}`, timedOut: false, durationMs: 1 }
    },
  }
  const events: Record<string, unknown>[] = []
  const closedHandles = (): string[] => calls.filter((argv) => argv[1] === 'terminal' && argv[2] === 'close').map((argv) => argv[argv.indexOf('--terminal') + 1] as string)
  const reap = (input: Partial<ReapInput> & { readonly records: readonly DispatchRecordFile[]; readonly states?: Readonly<Record<string, DeliveryState>> }) => reapWorkerTerminals({
    runner, config: loaded.config, root: ROOT, now: NOW, dryRun: false, finishedThisPass: new Map(), results: [], leasedIssues: new Set(input.records.map((item) => item.issue)),
    stateOf: (issue) => input.states?.[issue] ?? emptyState(issue), emit: (payload) => { events.push(payload) }, ...input,
  })
  return { loaded, calls, events, closedHandles, reap }
}

const waiting = (issue: string, outcome: DeliverOutcome = 'waiting', pr: number | null = 42) => ({ issue, outcome, ...(pr === null ? {} : { pr }) })

describe('worker terminal reaper', () => {
  it('closes the terminal of every issue finish() closed out this pass, on any outcome, and records it', async () => {
    const records = [record('ENG-1'), record('ENG-2'), record('ENG-3')]
    const harness = env({ terminals: records.map((item) => terminal(`term_${item.issue}`, item.worktreeId, 1)) })
    const report = await harness.reap({ records, finishedThisPass: new Map([['ENG-1', 'blocked'], ['ENG-2', 'stuck'], ['ENG-3', 'merged']]) })
    expect(harness.closedHandles()).toEqual(['term_ENG-1', 'term_ENG-2', 'term_ENG-3'])
    expect(report.closed.map((item) => item.reason)).toEqual(['finished: blocked', 'finished: stuck', 'finished: merged'])
    expect(harness.events.filter((event) => event['type'] === 'worker.terminal-closed')).toHaveLength(3)
    expect(harness.events.find((event) => event['type'] === 'terminals.reaped')).toMatchObject({ closed: 3, orphaned: 3, idle: 0 })
    // Never a worktree removal: a person may still need it.
    expect(harness.calls.some((argv) => argv[1] === 'worktree')).toBe(false)
  })

  it('tolerates a stale or missing handle as already closed, and never throws on any other close error', async () => {
    const harness = env({ terminals: ['ENG-1', 'ENG-2', 'ENG-3'].map((issue) => terminal(`term_${issue}`, record(issue).worktreeId, 1)), closeError: (handle) => handle === 'term_ENG-1' ? 'terminal_handle_stale' : handle === 'term_ENG-2' ? 'selector_not_found' : 'runtime exploded' })
    const report = await harness.reap({ records: [record('ENG-1'), record('ENG-2'), record('ENG-3')], finishedThisPass: new Map([['ENG-1', 'blocked'], ['ENG-2', 'failed'], ['ENG-3', 'stuck']]) })
    expect(report.closed.map((item) => item.terminal)).toEqual(['term_ENG-1', 'term_ENG-2'])
    expect(report.failed).toBe(1)
    expect(report.notes.some((note) => note.includes('term_ENG-3') && note.includes('runtime exploded'))).toBe(true)
  })

  it('leaves terminals alone when delivery.closeTerminalOnFinish is off', async () => {
    const harness = env({ yaml: (yaml) => yaml.replace('  closeTerminalOnFinish: true ', '  closeTerminalOnFinish: false ').replace('  reapIdleTerminalsMinutes: 90 ', '  reapIdleTerminalsMinutes: 0 '), terminals: [terminal('term_ENG-1', record('ENG-1').worktreeId, 500)] })
    expect(harness.loaded.config.delivery).toMatchObject({ closeTerminalOnFinish: false, reapIdleTerminalsMinutes: 0 })
    const report = await harness.reap({ records: [record('ENG-1')], finishedThisPass: new Map([['ENG-1', 'blocked']]), states: { 'ENG-1': emptyState('ENG-1', { finishedAt: 'x', finalOutcome: 'blocked' }) } })
    expect(report.closed).toEqual([])
    expect(harness.calls).toEqual([])
  })

  it('closes orphaned terminals: finished issues and issues with no active lease', async () => {
    const records = [record('ENG-1'), record('ENG-2'), record('ENG-3')]
    const harness = env({ terminals: [terminal('term_ENG-1', records[0]!.worktreeId, 2), terminal('term_ENG-2', records[1]!.worktreeId, 600), terminal('term_ENG-3', records[2]!.worktreeId, 1)] })
    const report = await harness.reap({ records, leasedIssues: new Set(['ENG-2', 'ENG-3']), states: { 'ENG-2': emptyState('ENG-2', { finishedAt: '2026-10-16T01:00:00.000Z', finalOutcome: 'stuck' }) } })
    // ENG-1: no lease. ENG-2: finished. ENG-3: leased and printing — untouched.
    expect(harness.closedHandles()).toEqual(['term_ENG-1', 'term_ENG-2'])
    expect(report.closed.map((item) => item.reason)).toEqual(['orphaned: no active dispatch lease', 'orphaned: issue finished (stuck)'])
  })

  it('closes a recorded handoff terminal a later worker superseded, once it is quiet', async () => {
    const current = record('ENG-1', 'term_new')
    const harness = env({ terminals: [terminal('term_old', current.worktreeId, 30), terminal('term_older', current.worktreeId, 3), terminal('term_new', current.worktreeId, 1)] })
    const handoff = (terminalHandle: string) => ({ at: 'x', fromProvider: 'a', fromModel: 'a', toProvider: 'b', toModel: 'b', reason: 'r', terminal: terminalHandle })
    await harness.reap({ records: [current], states: { 'ENG-1': emptyState('ENG-1', { handoffs: [handoff('term_old'), handoff('term_older')] }) } })
    expect(harness.closedHandles()).toEqual(['term_old'])
  })

  it('never touches the main checkout, other projects, or a terminal the loop did not open', async () => {
    const own = record('ENG-1')
    const inMain = { ...record('ENG-2'), worktreeId: `repo-1::${ROOT}` } as DispatchRecordFile
    const harness = env({ terminals: [
      // A person's shell in a loop worktree, issue finished.
      terminal('term_human', own.worktreeId, 600),
      // The project's main checkout, even though a (corrupt) record points at it.
      terminal('term_ENG-2', `repo-1::${ROOT}`, 600),
      terminal('term_main_shell', `repo-1::${ROOT}`, 600, { isMainWorktree: true }),
      // Another project's worker, idle for hours.
      terminal('term_other', 'repo-9::C:/Users/me/orca/workspaces/other/eng-1', 600),
    ] })
    const report = await harness.reap({ records: [own, inMain], leasedIssues: new Set(), states: { 'ENG-1': emptyState('ENG-1', { finishedAt: 'x', finalOutcome: 'blocked' }), 'ENG-2': emptyState('ENG-2', { finishedAt: 'x', finalOutcome: 'blocked' }) } })
    expect(report.closed).toEqual([])
    expect(harness.closedHandles()).toEqual([])
  })

  it('a finished-this-pass record never closes a terminal in the main checkout, however the record reads', async () => {
    const inMain = { ...record('ENG-2'), worktreeId: `repo-1::${ROOT}` } as DispatchRecordFile
    const harness = env({ terminals: [terminal('term_ENG-2', `repo-1::${ROOT}`, 1), terminal('term_ENG-3', record('ENG-3').worktreeId, 1, { isMainWorktree: true })] })
    const report = await harness.reap({ records: [inMain, record('ENG-3')], finishedThisPass: new Map([['ENG-2', 'blocked'], ['ENG-3', 'blocked']]) })
    expect(report.closed).toEqual([])
    expect(harness.closedHandles()).toEqual([])
  })

  it('an unparseable timestamp counts as active, not infinitely quiet', async () => {
    const own = record('ENG-1')
    const harness = env({ terminals: [terminal('term_ENG-1', own.worktreeId, 600, { lastOutputAt: 'not-a-date' })] })
    const report = await harness.reap({ records: [own], results: [waiting('ENG-1')] })
    expect(report.closed).toEqual([])
  })

  it('closes an idle worker only when its PR is open, the pass only waited, and nothing was sent to it within the window', async () => {
    const records = ['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4', 'ENG-5', 'ENG-6'].map((issue) => record(issue))
    const harness = env({ terminals: [
      terminal('term_ENG-1', records[0]!.worktreeId, 120), // idle, PR open, waiting → closed
      terminal('term_ENG-2', records[1]!.worktreeId, 30), // PR open but printed 30 min ago → kept
      terminal('term_ENG-3', records[2]!.worktreeId, 120), // just sent a fix round → kept
      terminal('term_ENG-4', records[3]!.worktreeId, 120), // no PR: the no-PR idle/nudge path owns it → kept
      terminal('term_ENG-5', records[4]!.worktreeId, 120), // nudged 20 min ago → kept
      terminal('term_ENG-6', records[5]!.worktreeId, null), // output age unknown → kept
    ] })
    const report = await harness.reap({
      records,
      results: [waiting('ENG-1'), waiting('ENG-2'), waiting('ENG-3', 'fix-round'), waiting('ENG-4', 'waiting', null), waiting('ENG-5'), waiting('ENG-6')],
      states: { 'ENG-5': emptyState('ENG-5', { prNumber: 42, nudges: [{ kind: 'review', at: new Date(minutesAgo(20)).toISOString(), head: 'h' }] }) },
    })
    expect(harness.closedHandles()).toEqual(['term_ENG-1'])
    expect(report.closed[0]?.reason).toMatch(/^idle 120 min with PR open/)
    expect(harness.events.find((event) => event['type'] === 'terminals.reaped')).toMatchObject({ closed: 1, idle: 1, orphaned: 0 })
  })

  it('does not idle-reap when delivery.reapIdleTerminalsMinutes is 0', async () => {
    const own = record('ENG-1')
    const harness = env({ yaml: (yaml) => yaml.replace('  reapIdleTerminalsMinutes: 90 ', '  reapIdleTerminalsMinutes: 0 '), terminals: [terminal('term_ENG-1', own.worktreeId, 600)] })
    expect(harness.loaded.config.delivery.reapIdleTerminalsMinutes).toBe(0)
    expect((await harness.reap({ records: [own], results: [waiting('ENG-1')] })).closed).toEqual([])
  })

  it('dry run only reports what it would close', async () => {
    const own = record('ENG-1')
    const harness = env({ terminals: [terminal('term_ENG-1', own.worktreeId, 600), terminal('term_ENG-2', record('ENG-2').worktreeId, 1)] })
    const report = await harness.reap({ records: [own, record('ENG-2')], dryRun: true, finishedThisPass: new Map([['ENG-2', 'blocked']]), results: [waiting('ENG-1')] })
    expect(report.closed.map((item) => item.terminal)).toEqual(['term_ENG-2', 'term_ENG-1'])
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringContaining('would close worker terminal term_ENG-1'), expect.stringContaining('would close 2 worker terminal(s)')]))
    expect(harness.closedHandles()).toEqual([])
    expect(harness.events).toEqual([])
  })

  it('a failed terminal list skips the reaper pass without throwing', async () => {
    const harness = env({ terminals: [], listFails: true })
    const report = await harness.reap({ records: [record('ENG-1')] })
    expect(report.notes[0]).toMatch(/terminal reaper skipped/)
  })
})

describe('terminal capacity', () => {
  it('classifies an orca terminal create timeout as capacity, and nothing else', () => {
    expect(isTerminalCapacityError(new Error('orca terminal create timed out after 20000ms.'))).toBe(true)
    expect(isTerminalCapacityError(new Error('orca terminal create failed: Timed out waiting for terminal handle after creation'))).toBe(true)
    expect(isTerminalCapacityError(new Error('orca worktree create failed: repo busy'))).toBe(false)
    expect(isTerminalCapacityError(new Error('terminal term_1 did not become tui-idle before the worker prompt deadline'))).toBe(false)
  })

  it('keeps a short cooldown on disk and counts live terminals only in the loop worktrees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-capacity-')); cleanups.push(dir)
    const until = markTerminalCapacity(dir, 'orca terminal create timed out', NOW)
    expect(activeTerminalCapacityCooldown(dir, NOW)).toMatchObject({ until })
    expect(activeTerminalCapacityCooldown(dir, new Date(Date.parse(until) + 1))).toBeNull()
    const worktree = (id: string, live: number, extra: Partial<OrcaWorktree> = {}): OrcaWorktree => ({ id, repoId: 'r', repo: 'r', path: id, branch: 'b', displayName: id, workspaceStatus: 'in-progress', isArchived: false, isMainWorktree: false, liveTerminalCount: live, lastActivityAt: null, linkedLinearIssue: null, linkedPR: null, comment: '', activity: 'unknown', activeAgentCount: null, agentCount: null, ...extra })
    expect(liveLoopTerminals([worktree('a', 2), worktree('b', 3), worktree('main', 4, { isMainWorktree: true }), worktree('other', 9)], new Set(['a', 'b', 'main']))).toBe(5)
  })
})
