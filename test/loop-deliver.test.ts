import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atLeast, buildReviewArgv, createDispatchLedger, dispatchRecordPath, listDispatched, loadLoopConfig, parseReviewResult, precheckDeliver, readDeliveryState, renderFindingsForWorker, runCodeReview, runDeliver } from '../src/index.js'
import type { CommandResult, CommandRunner, DispatchRecordFile } from '../src/index.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/loop', `${name}.json`), 'utf8')) as unknown
const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const okResult = (result: unknown): CommandResult => ok({ ok: true, result })
const NOW = new Date('2026-09-11T12:00:00.000Z')

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

interface Scenario {
  readonly pr?: Record<string, unknown> | null
  readonly mergedPr?: Record<string, unknown>
  readonly closedPr?: Record<string, unknown>
  readonly terminals?: readonly Record<string, unknown>[]
  readonly review?: { readonly code: number; readonly findings?: readonly Record<string, unknown>[]; readonly incomplete?: boolean }
  readonly mergeRefused?: boolean
  readonly dispatchedAt?: string
  readonly reviewerAvailable?: boolean
  /** PR whose head is Orca's `<git user>/<worktree>` branch, only visible through the open-PR listing. */
  readonly orcaBranchPr?: Record<string, unknown>
}

const basePr = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...(fixture('gh-pr-view') as Record<string, unknown>), headRefName: 'person/eng-10-demo', files: [{ path: 'packages/demo/src/index.ts' }], statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN', number: 42, url: 'https://github.com/o/r/pull/42', ...over })

const setup = (initial: Scenario = {}) => {
  const scenario: { -readonly [K in keyof Scenario]: Scenario[K] } = { ...initial }
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-deliver-')); cleanups.push(dir)
  const bin = mkdtempSync(join(tmpdir(), 'agentskit-loop-deliver-bin-')); cleanups.push(bin)
  for (const name of ['claude', 'codex', 'opencode', 'grok']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  const ledger = createDispatchLedger(loaded.stateDir)
  const claim = ledger.claim({ tracker: 'linear', repository: 'org/demo', issue: 'ENG-10', worktree: 'eng-10-demo', branch: 'person/eng-10-demo', owner: 'test' })
  const record: DispatchRecordFile = { issue: 'ENG-10', worktreeId: 'repo-1::/w/eng-10-demo', worktree: 'eng-10-demo', branch: 'person/eng-10-demo', terminal: 'term_w', provider: 'claude', model: 'sonnet', contractDigest: 'abc', leaseKey: claim.lease.key, leaseId: claim.lease.leaseId, dispatchedAt: scenario.dispatchedAt ?? '2026-09-11T10:00:00.000Z', url: 'https://linear.app/x/issue/ENG-10' }
  mkdirSync(join(loaded.stateDir, 'issues', 'ENG-10'), { recursive: true })
  writeFileSync(dispatchRecordPath(loaded.stateDir, 'ENG-10'), JSON.stringify(record))
  const account = JSON.parse(JSON.stringify((fixture('account-list') as { result: unknown }).result)) as { rateLimits: Record<string, { weekly?: { usedPercent: number } }> }
  if (account.rateLimits['codex']?.weekly) account.rateLimits['codex'].weekly.usedPercent = scenario.reviewerAvailable === false ? 100 : 10
  const calls: string[][] = []
  const runner: CommandRunner & { readonly calls: string[][] } = {
    calls,
    run: async (argv, options) => {
      calls.push([...argv])
      const key = argv.join(' ')
      if (key.startsWith('orca account list')) return okResult(account)
      if (key.startsWith('orca agent hooks status')) return ok(fixture('agent-hooks'))
      if (key === 'gh auth token') return { code: 0, stdout: 'ghp_test\n', stderr: '', timedOut: false, durationMs: 1 }
      if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'list') {
        const state = argv[argv.indexOf('--state') + 1]
        const byHead = argv.includes('--head')
        if (state === 'open' && scenario.orcaBranchPr) return ok(byHead ? [] : [scenario.orcaBranchPr])
        if (state === 'open') return ok(scenario.pr === null || scenario.pr === undefined && (scenario.mergedPr || scenario.closedPr) ? [] : [scenario.pr ?? basePr()])
        return ok([scenario.mergedPr, scenario.closedPr].filter(Boolean))
      }
      if (key.startsWith('orca terminal list')) return okResult({ terminals: scenario.terminals ?? [{ handle: 'term_w', connected: true, orphaned: false, lastOutputAt: Date.parse('2026-09-11T10:30:00.000Z'), worktreeId: 'repo-1::/w/eng-10-demo' }] })
      if (key.startsWith('orca terminal wait')) return okResult({ satisfied: true })
      if (key.startsWith('orca terminal send')) return okResult({ accepted: true, requestId: 'r' })
      if (key.startsWith('orca linear') || key.startsWith('orca worktree set') || key.startsWith('orca worktree rm')) return okResult({ ok: true })
      if (argv[0] === 'agentskit-review') {
        const resultFile = argv[argv.indexOf('--result') + 1]
        if (resultFile && scenario.review) writeFileSync(resultFile, JSON.stringify({ blocking: scenario.review.code === 1, incomplete: scenario.review.incomplete ?? false, findings: scenario.review.findings ?? [] }))
        return { code: scenario.review?.code ?? 0, stdout: '## Code review — done', stderr: '', timedOut: false, durationMs: 1 }
      }
      if (argv[0] === 'gh' && argv[1] === 'api' && argv.includes('--method')) return scenario.mergeRefused ? { code: 1, stdout: JSON.stringify({ message: 'Head branch was modified.' }), stderr: '', timedOut: false, durationMs: 1 } : ok({ merged: true, sha: 'deadbeef', message: 'merged' })
      if (argv[0] === 'gh' && argv[1] === 'api') return ok([])
      if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'comment') return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
      return { code: 127, stdout: '', stderr: `no fixture for ${key} ${options?.cwd ?? ''}`, timedOut: false, durationMs: 1 }
    },
  }
  return { dir, bin, loaded, runner, record, ledger, scenario }
}

const deliver = (env: ReturnType<typeof setup>, extra: Partial<Parameters<typeof runDeliver>[0]> = {}) => runDeliver({ configPath: env.loaded.path, runner: env.runner, env: { PATH: env.bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => NOW, ...extra })

describe('code review adapter', () => {
  it('builds argv with the severity floor, parses findings from the result file, and classifies exit codes', async () => {
    const argv = buildReviewArgv({ cli: 'agentskit-review', repo: 'o/r', number: 7, provider: 'codex-cli', model: 'gpt-5.6-sol', profile: 'full', votes: 3, minSeverity: 'med', deadlineMs: 1000, maxCalls: 50, post: true, resultFile: '/tmp/r.json' })
    expect(argv).toEqual(['agentskit-review', '--pr', 'o/r#7', '--provider', 'codex-cli', '--model', 'gpt-5.6-sol', '--profile', 'full', '--votes', '3', '--min-severity', 'nit', '--block', 'med', '--max-calls', '50', '--deadline-ms', '1000', '--result', '/tmp/r.json', '--post'])
    const parsed = parseReviewResult({ blocking: true, incomplete: false, findings: [{ file: 'a.ts', line: 3, severity: 'high', category: 'correctness', title: 'Null deref', rationale: 'x may be null', suggestion: 'guard it' }, { file: 'b.ts', line: 9, severity: 'nit', title: 'typo' }] })
    expect(parsed.findings[0]).toMatchObject({ severity: 'high', file: 'a.ts', line: 3, title: 'Null deref', category: 'correctness' })
    expect(parsed.findings[0]?.detail).toContain('Suggestion: guard it')
    expect(atLeast('nit', 'med')).toBe(false)
    expect(atLeast('blocker', 'med')).toBe(true)
    expect(renderFindingsForWorker(parsed.findings)).toContain('1. [high] a.ts:3 — Null deref')
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-review-')); cleanups.push(dir)
    const resultFile = join(dir, 'r.json')
    const runner: CommandRunner = { run: async (argv) => { writeFileSync(argv[argv.indexOf('--result') + 1] ?? resultFile, JSON.stringify({ blocking: false, incomplete: false, findings: [{ severity: 'nit', title: 't', file: 'x', line: 1 }] })); return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 } } }
    const clean = await runCodeReview(runner, { cli: 'agentskit-review', repo: 'o/r', number: 1, provider: 'codex-cli', profile: 'full', votes: 1, minSeverity: 'med', deadlineMs: 100, maxCalls: 1, post: false, resultFile })
    expect(clean).toMatchObject({ status: 'clean', resultParsed: true })
    const incomplete = await runCodeReview({ run: async () => ({ code: 2, stdout: '', stderr: 'BLOCKED_AUTH', timedOut: false, durationMs: 1 }) }, { cli: 'agentskit-review', repo: 'o/r', number: 1, provider: 'codex-cli', profile: 'full', votes: 1, minSeverity: 'med', deadlineMs: 100, maxCalls: 1, post: false, resultFile: join(dir, 'none.json') })
    expect(incomplete).toMatchObject({ status: 'incomplete', resultParsed: false })
    expect(incomplete.summary).toContain('BLOCKED_AUTH')
  })
})

describe('deliver', () => {
  it('reviews a green PR, squash-merges on a clean review, completes Linear, and releases the lease', async () => {
    const env = setup({ review: { code: 0, findings: [{ severity: 'nit', title: 'style', file: 'x', line: 1 }] } })
    const report = await deliver(env)
    expect(report.reviewer).toBe('codex/gpt-5.6-sol')
    expect(report.results[0]).toMatchObject({ outcome: 'merged', pr: 42 })
    const reviewCall = env.runner.calls.find((argv) => argv[0] === 'agentskit-review')
    expect(reviewCall).toContain('codex-cli')
    expect(reviewCall).toContain('--post')
    const merge = env.runner.calls.find((argv) => argv[0] === 'gh' && argv[1] === 'api' && argv.includes('--method'))
    expect(merge).toContain('merge_method=squash')
    expect(merge?.some((arg) => arg.startsWith('sha=c74d687e'))).toBe(true)
    expect(env.runner.calls.find((argv) => argv[1] === 'linear' && argv[2] === 'status')).toContain('Done')
    expect(env.runner.calls.some((argv) => argv[1] === 'linear' && argv[2] === 'attach')).toBe(true)
    expect(env.runner.calls.some((argv) => argv[1] === 'worktree' && argv[2] === 'rm')).toBe(true)
    expect(env.ledger.active()).toEqual([])
    expect(readDeliveryState(env.loaded.stateDir, 'ENG-10')).toMatchObject({ finalOutcome: 'merged', prNumber: 42 })
    expect(precheckDeliver(env.loaded.stateDir).work).toBe(false)
    const again = await deliver(env)
    expect(again.results).toEqual([])
  })

  it('sends review findings to the worker as a fix round, never re-reviews the same head, and blocks after the budget', async () => {
    const env = setup({ review: { code: 1, findings: [{ severity: 'high', title: 'Bug', file: 'a.ts', line: 2, rationale: 'wrong' }] } })
    const first = await deliver(env)
    expect(first.results[0]).toMatchObject({ outcome: 'fix-round', head: 'c74d687ee59927dbbe2972649d7b58dbad16bcd0' })
    const send = env.runner.calls.find((argv) => argv[1] === 'terminal' && argv[2] === 'send')
    expect(send?.[send.indexOf('--text') + 1]).toContain('[high] a.ts:2 — Bug')
    expect(readDeliveryState(env.loaded.stateDir, 'ENG-10').fixRounds).toBe(1)
    const second = await deliver(env)
    expect(second.results[0]).toMatchObject({ outcome: 'waiting' })
    expect(env.runner.calls.filter((argv) => argv[0] === 'agentskit-review')).toHaveLength(1)
    // new head → another review → second round (budget 2); a third head with findings exhausts it → blocked
    env.scenario.pr = basePr({ headRefOid: '1111111111111111111111111111111111111111' })
    const third = await deliver(env)
    expect(third.results[0]).toMatchObject({ outcome: 'fix-round', head: '1111111111111111111111111111111111111111' })
    expect(readDeliveryState(env.loaded.stateDir, 'ENG-10').fixRounds).toBe(2)
    env.scenario.pr = basePr({ headRefOid: '2222222222222222222222222222222222222222' })
    const fourth = await deliver(env)
    expect(fourth.results[0]).toMatchObject({ outcome: 'blocked' })
    expect(env.runner.calls.filter((argv) => argv[0] === 'agentskit-review')).toHaveLength(3)
    expect(env.runner.calls.find((argv) => argv[1] === 'linear' && argv[2] === 'label')).toContain('blocked')
    expect(env.runner.calls.find((argv) => argv[1] === 'linear' && argv[2] === 'status')).toContain('Todo')
    expect(env.ledger.active()).toEqual([])
    expect(env.runner.calls.some((argv) => argv[1] === 'worktree' && argv[2] === 'rm')).toBe(false)
  })

  it('holds PRs touching protected paths, waits on pending checks, and asks the worker to fix red CI', async () => {
    const held = setup({ pr: basePr({ files: [{ path: '.github/workflows/ci.yml' }] }) })
    expect((await deliver(held)).results[0]).toMatchObject({ outcome: 'held' })
    expect(held.runner.calls.some((argv) => argv[0] === 'agentskit-review')).toBe(false)
    expect(held.runner.calls.some((argv) => argv[1] === 'pr' && argv[2] === 'comment')).toBe(true)
    const pending = setup({ pr: basePr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' }] }) })
    expect((await deliver(pending)).results[0]).toMatchObject({ outcome: 'waiting', reason: expect.stringContaining('pending') })
    const red = setup({ pr: basePr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED' }] }) })
    const result = (await deliver(red)).results[0]
    expect(result).toMatchObject({ outcome: 'fix-round', reason: 'CI red: lint' })
    expect(red.runner.calls.some((argv) => argv[0] === 'agentskit-review')).toBe(false)
    const conflict = setup({ pr: basePr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) })
    const conflictResult = (await deliver(conflict)).results[0]
    expect(conflictResult).toMatchObject({ outcome: 'fix-round', reason: expect.stringContaining('conflicts') })
    expect(readDeliveryState(conflict.loaded.stateDir, 'ENG-10').fixRounds).toBe(0)
  })

  it('finds the PR on the branch Orca assigned and rewrites the dispatch record', async () => {
    const env = setup({ review: { code: 0 }, orcaBranchPr: basePr({ headRefName: 'GitUser/eng-10-demo' }) })
    const report = await deliver(env)
    expect(report.results[0]).toMatchObject({ outcome: 'merged', pr: 42 })
    expect(report.notes[0]).toContain('PR found on branch GitUser/eng-10-demo')
    expect(JSON.parse(readFileSync(dispatchRecordPath(env.loaded.stateDir, 'ENG-10'), 'utf8')).branch).toBe('GitUser/eng-10-demo')
  })

  it('handles merge refusal, externally merged PRs, and closed PRs', async () => {
    const refused = setup({ review: { code: 0 }, mergeRefused: true })
    expect((await deliver(refused)).results[0]).toMatchObject({ outcome: 'waiting', reason: expect.stringContaining('Head branch was modified') })
    expect(refused.ledger.active()).toHaveLength(1)
    const merged = setup({ pr: null, mergedPr: basePr({ state: 'MERGED' }) })
    expect((await deliver(merged)).results[0]).toMatchObject({ outcome: 'merged' })
    const closed = setup({ pr: null, closedPr: basePr({ state: 'CLOSED' }) })
    expect((await deliver(closed)).results[0]).toMatchObject({ outcome: 'abandoned' })
    expect(closed.runner.calls.find((argv) => argv[1] === 'linear' && argv[2] === 'status')).toContain('Todo')
    expect(closed.runner.calls.some((argv) => argv[1] === 'worktree' && argv[2] === 'rm')).toBe(false)
  })

  it('nudges an idle worker without a PR once, then marks it stuck and frees the slot while keeping the worktree', async () => {
    const env = setup({ pr: null, dispatchedAt: '2026-09-11T09:00:00.000Z' })
    const first = await deliver(env, { assumeIdle: true })
    expect(first.results[0]).toMatchObject({ outcome: 'nudged' })
    const second = await deliver(env, { assumeIdle: true })
    expect(second.results[0]).toMatchObject({ outcome: 'waiting' })
    const later = await deliver(env, { assumeIdle: true, now: () => new Date('2026-09-11T13:00:00.000Z') })
    expect(later.results[0]).toMatchObject({ outcome: 'stuck' })
    expect(env.ledger.active()).toEqual([])
    expect(env.runner.calls.some((argv) => argv[1] === 'worktree' && argv[2] === 'rm')).toBe(false)
    expect(env.runner.calls.find((argv) => argv[1] === 'linear' && argv[2] === 'label')).toContain('blocked')
    const busy = setup({ pr: null })
    expect((await deliver(busy, { assumeIdle: false })).results[0]).toMatchObject({ outcome: 'waiting', reason: 'worker active' })
    const gone = setup({ pr: null, terminals: [] })
    expect((await deliver(gone)).results[0]).toMatchObject({ outcome: 'stuck', reason: expect.stringContaining('terminal gone') })
  })

  it('dry-run decides without side effects and reports missing reviewer', async () => {
    const env = setup({ review: { code: 0 } })
    const report = await deliver(env, { dryRun: true })
    expect(report.results[0]).toMatchObject({ outcome: 'dry-run' })
    expect(env.runner.calls.some((argv) => argv[0] === 'agentskit-review' || (argv[0] === 'gh' && argv[1] === 'api' && argv.includes('--method')))).toBe(false)
    expect(env.ledger.active()).toHaveLength(1)
    expect(existsSync(join(env.loaded.stateDir, 'issues', 'ENG-10', 'delivery.json'))).toBe(false)
    const noReviewer = setup({ reviewerAvailable: false })
    writeFileSync(join(noReviewer.dir, 'loop.config.local.yaml'), 'models:\n  reviewer: [[codex/gpt-5.6-sol]]\n')
    const result = (await deliver(noReviewer)).results[0]
    expect(result).toMatchObject({ outcome: 'waiting', reason: 'no reviewer provider available' })
    expect(listDispatched(noReviewer.loaded.stateDir)).toHaveLength(1)
  })
})
