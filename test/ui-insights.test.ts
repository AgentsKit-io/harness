import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/adapters/command.js'
import type { LoadedLoopConfig } from '../src/loop/config.js'
import { buildRetroReport, type LoopEvent } from '../src/loop/retro.js'
import type { IssueBoardCache } from '../src/ui/api/board.js'
import { buildMetrics, loadMetrics } from '../src/ui/api/metrics.js'
import { search } from '../src/ui/api/search.js'
import { startUiServer, type UiServerHandle } from '../src/ui/api/server.js'

const NOW = new Date('2026-01-15T12:00:00.000Z')
const H = 3_600_000
const D = 24 * H
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()
const ev = (msAgo: number, type: string, fields: Record<string, unknown> = {}): LoopEvent => ({ at: ago(msAgo), type, ...fields })

const cleanups: string[] = []
const servers: UiServerHandle[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})
const tempState = (): { root: string; stateDir: string } => {
  const root = mkdtempSync(join(tmpdir(), 'harness-ui-insights-')); cleanups.push(root)
  const stateDir = join(root, '.ak-loop'); mkdirSync(stateDir, { recursive: true })
  return { root, stateDir }
}
const writeEvents = (stateDir: string, events: readonly LoopEvent[]): void => writeFileSync(join(stateDir, 'events.ndjson'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
const writeIssueFile = (stateDir: string, issue: string, name: string, value: unknown): string => {
  const dir = join(stateDir, 'issues', issue); mkdirSync(dir, { recursive: true })
  const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path
}
const loadedFor = (root: string, stateDir: string): LoadedLoopConfig => ({
  root, stateDir, path: join(root, 'loop.config.yaml'), configHash: 'hash', unknownKeys: [],
  config: {
    connectors: { tracker: 'github' }, project: { name: 'app', repo: 'example/app', baseBranch: 'main' },
    delivery: { returnState: 'Todo', maxFixRounds: 3 }, budget: { perIssueTokens: 50_000 }, resilience: { pausedLabel: 'loop:paused' },
    orca: { bin: 'orca' }, machine: { ceiling: 4, floor: 1 }, flows: { profiles: {}, default: null }, schedule: { stageTimeoutSec: 60 },
    linear: { doneState: 'Done', person: 'someone', rotation: { enabled: false, owners: [] } }, models: { builder: [['codex/gpt-5']], providers: { codex: {} } },
    dod: { items: [], evidenceFile: '.ak-loop/dod.json' },
  },
} as unknown as LoadedLoopConfig)

/** Two merged runs (one with two fix rounds), a merge in the previous window, a failure, a cap, reviews, tokens, usage. */
const fixture = (): LoopEvent[] => [
  // previous window: ISSUE-9 queued → merged in 10h
  ev(9 * D, 'ui.run-enqueued', { issue: 'ISSUE-9' }),
  ev(9 * D - 10 * H, 'pr.merged', { issue: 'ISSUE-9', pr: 9 }),
  // ISSUE-1: queued, dispatched, first review clean, merged 2h later
  ev(3 * D, 'ui.run-enqueued', { issue: 'ISSUE-1' }),
  ev(3 * D - 10 * 60_000, 'worker.dispatched', { issue: 'ISSUE-1', provider: 'codex', model: 'gpt-5' }),
  ev(3 * D - H, 'pr.reviewed', { issue: 'ISSUE-1', pr: 1, status: 'clean', provider: 'claude', inputTokens: 1000, outputTokens: 200 }),
  ev(3 * D - H + 1, 'dod.assessed', { issue: 'ISSUE-1', pr: 1, complete: true, proven: 4, missing: 0, failed: 0 }),
  ev(3 * D - 2 * H, 'pr.merged', { issue: 'ISSUE-1', pr: 1 }),
  // ISSUE-2: dispatched, first review with findings, two fix rounds, merged with one missing DoD line after 4h
  ev(2 * D, 'worker.dispatched', { issue: 'ISSUE-2', provider: 'codex', model: 'gpt-5' }),
  ev(2 * D - H, 'pr.reviewed', { issue: 'ISSUE-2', pr: 2, status: 'findings', provider: 'claude', totalTokens: 3000 }),
  ev(2 * D - H - 1, 'worker.review-round', { issue: 'ISSUE-2', pr: 2, round: 1 }),
  ev(2 * D - 2 * H, 'worker.ci-round', { issue: 'ISSUE-2', pr: 2, round: 2 }),
  ev(2 * D - 2 * H - 1, 'worker.conflict-round', { issue: 'ISSUE-2', pr: 2, round: 1 }),
  ev(2 * D - 3 * H, 'pr.reviewed', { issue: 'ISSUE-2', pr: 2, status: 'clean', provider: 'claude', totalTokens: 1000 }),
  ev(2 * D - 3 * H - 1, 'dod.assessed', { issue: 'ISSUE-2', pr: 2, complete: false, proven: 3, missing: 1, failed: 0 }),
  ev(2 * D - 4 * H, 'pr.merged', { issue: 'ISSUE-2', pr: 2 }),
  // ISSUE-3 fails, ISSUE-4 hits the fix-round cap, ISSUE-5 is held with two unproven lines
  ev(5 * H, 'worker.failed', { issue: 'ISSUE-3', reason: 'tool error: exit 2' }),
  ev(4 * H, 'worker.blocked', { issue: 'ISSUE-4', reason: 'fix rounds exhausted: 3 of 3' }),
  ev(3 * H, 'dod.assessed', { issue: 'ISSUE-5', pr: 5, complete: false, proven: 1, missing: 1, failed: 1 }),
  ev(3 * H - 1, 'worker.held', { issue: 'ISSUE-5', reason: 'protected paths: infra/' }),
  // escalations
  ev(4 * D, 'contract.escalated', { issue: 'ISSUE-6', reasons: ['1 blocking ambiguity: which page?'] }),
  ev(1 * D, 'contract.escalated', { issue: 'ISSUE-7', reasons: ['1 blocking ambiguity: which page?'] }),
  // tokens by role, cache hits on one call
  ev(2 * H, 'provider.call', { role: 'orchestrator', provider: 'codex', issue: 'ISSUE-1', inputTokens: 400, outputTokens: 100, cacheReadTokens: 200 }),
  // usage falling 80 → 60 over 10h (after a reset from 30), cooldown ahead
  ev(20 * H, 'provider.usage-observed', { issue: 'ISSUE-2', provider: 'codex', currentRemainingPercent: 30 }),
  ev(12 * H, 'provider.usage-observed', { issue: 'ISSUE-2', provider: 'codex', currentRemainingPercent: 80 }),
  ev(2 * H, 'provider.usage-observed', { issue: 'ISSUE-2', provider: 'codex', currentRemainingPercent: 60 }),
  ev(H, 'provider.cooldown', { provider: 'claude', kind: 'quota', until: new Date(NOW.getTime() + 2 * H).toISOString() }),
  ev(30 * 60_000, 'memory.recalled', { issue: 'ISSUE-1', approxCharsSaved: 1200 }),
]

describe('buildMetrics', () => {
  const report = buildMetrics({ events: fixture() }, '7d', NOW)

  it('buckets throughput by day over the window', () => {
    expect(report.bucket).toBe('day')
    expect(report.throughput).toHaveLength(7)
    expect(report.throughput.reduce((sum, row) => sum + row.merged, 0)).toBe(2)
    expect(report.throughput.reduce((sum, row) => sum + row.failed, 0)).toBe(2)
    expect(report.totals).toEqual({ merged: 2, failed: 2, escalated: 2 })
    expect(buildMetrics({ events: fixture() }, '24h', NOW).throughput).toHaveLength(24)
  })

  it('measures lead time from the first queue/dispatch to merge, and the previous window', () => {
    expect(report.leadTime.medianMs).toBe(3 * H)
    expect(report.leadTime.p90Ms).toBe(4 * H)
    expect(report.leadTime.previousMedianMs).toBe(10 * H)
  })

  it('counts fix rounds per merged issue, conflicts excluded, and the cap separately', () => {
    expect(Object.fromEntries(report.fixRounds.map((row) => [row.label, row.count]))).toEqual({ '0': 1, '1': 0, '2': 1, '3+': 0, cap: 1 })
  })

  it('rates first reviews and splits DoD lines at merge', () => {
    expect(report.firstReviewApprovalRate).toBe(0.5)
    expect(report.criteriaAtMerge).toEqual({ proven: 7, waived: 1, held: 2 })
  })

  it('normalizes stop reasons', () => {
    const reasons = Object.fromEntries(report.stopReasons.map((row) => [row.reason, row.count]))
    expect(reasons['blocking ambiguity: which page?']).toBe(2)
    expect(reasons['fix rounds exhausted: 3 of 3']).toBe(1)
  })

  it('sums tokens by role, cache hit rate and per-issue spend', () => {
    expect(report.tokens.total).toBe(1200 + 3000 + 1000 + 500)
    expect(report.tokens.byRole).toEqual({ reviewer: 5200, orchestrator: 500 })
    expect(report.tokens.cacheHitRate).toBe(0.5)
    expect(report.tokens.perIssue.map((row) => row.issue)).toEqual(['ISSUE-2', 'ISSUE-1'])
    expect(report.tokens.medianPerMergedIssue).toBe((4000 + 1700) / 2)
    expect(report.tokens.series.reduce((sum, row) => sum + Object.values(row.byRole).reduce((a, b) => a + b, 0), 0)).toBe(report.tokens.total)
  })

  it('projects provider usage to zero after the last reset and keeps a cooldown still ahead', () => {
    const codex = report.providers.find((row) => row.provider === 'codex')!
    expect(codex.remainingPercent).toBe(60)
    expect(codex.projectedZeroAt).toBe(new Date(NOW.getTime() - 2 * H + 30 * H).toISOString())
    expect(report.providers.find((row) => row.provider === 'claude')!.cooldownUntil).toBe(new Date(NOW.getTime() + 2 * H).toISOString())
    expect(report.memorySavedChars).toBe(1200)
  })

  it('fills 12 two-hour sparks for the last day', () => {
    expect(report.sparks.failed).toHaveLength(12)
    expect(report.sparks.failed.reduce((a, b) => a + b, 0)).toBe(2)
    expect(report.sparks.tokens[11]).toBe(500)
  })

  it('agrees with buildRetroReport on merges and escalations for the same state', async () => {
    const { root, stateDir } = tempState()
    writeEvents(stateDir, fixture())
    for (const [issue, dispatchedAt, finishedAt] of [['ISSUE-1', ago(3 * D), ago(3 * D - 2 * H)], ['ISSUE-2', ago(2 * D), ago(2 * D - 4 * H)], ['ISSUE-9', ago(9 * D), ago(9 * D - 10 * H)]] as const) {
      writeIssueFile(stateDir, issue, 'dispatch.json', { issue, worktreeId: `wt-${issue}`, branch: issue, provider: 'codex', model: 'gpt-5', dispatchedAt })
      writeIssueFile(stateDir, issue, 'delivery.json', { issue, prNumber: 1, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: null, finishedAt, finalOutcome: 'merged' })
    }
    const loaded = loadedFor(root, stateDir)
    const retro = await buildRetroReport({ loaded, since: '7d', now: () => NOW, skipOrca: true })
    const metrics = loadMetrics(stateDir, loaded.config, '7d', NOW)
    expect(metrics.totals?.merged).toBe(retro.delivery.merged)
    expect(metrics.totals?.escalated).toBe(retro.escalations.total)
    expect(metrics.tokens.perIssue.find((row) => row.issue === 'ISSUE-1')?.cap).toBe(50_000)
  })
})

describe('search', () => {
  it('matches events, contracts, evidence, reviews and learnings with relative sources', () => {
    const { root, stateDir } = tempState()
    writeEvents(stateDir, [...fixture(), ev(H, 'worker.nudged', { issue: 'ISSUE-1', reason: 'idle for a while: widget pending' })])
    writeIssueFile(stateDir, 'ISSUE-1', 'contract.json', {
      schemaVersion: 1, issue: 'ISSUE-1', issueUpdatedAt: ago(4 * D), generatedAt: ago(4 * D), provider: 'codex', model: 'gpt-5', digest: 'abc', source: 'llm',
      assessment: { dispatchable: true, reasons: [] },
      contract: { intent: 'Render the widget list', scope: { inScope: ['widget page'], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'Widget shows', check: { kind: 'test', command: 'pnpm test' } }], ambiguities: [], hitl: [], touchpoints: [], risks: [] },
    })
    writeIssueFile(stateDir, 'ISSUE-1', 'review-abcdef123456.json', { status: 'findings', findings: [{ severity: 'major', text: 'Widget label is not escaped' }] })
    const worktree = join(root, 'wt-1'); mkdirSync(join(worktree, '.ak-loop'), { recursive: true })
    writeFileSync(join(worktree, '.ak-loop', 'dod.json'), JSON.stringify({ project: [], outcomes: [{ id: 'o1', status: 'passed', evidence: 'widget test passed' }] }))
    writeIssueFile(stateDir, 'ISSUE-1', 'dispatch.json', { issue: 'ISSUE-1', worktreeId: 'wt-1', branch: 'b', provider: 'codex', model: 'gpt-5', dispatchedAt: ago(3 * D), worktreePath: worktree })
    writeFileSync(join(stateDir, 'learnings.json'), JSON.stringify({ records: [{ id: 'l1', source: 'retro', category: 'problem', text: 'Widget tests flake on slow CI', status: 'proposed', recordedAt: ago(D) }] }))
    const loaded = loadedFor(root, stateDir)

    const result = search(stateDir, 'WIDGET', { config: loaded.config, window: '7d' }, NOW)
    expect(result.counts).toEqual({ event: 1, contract: 1, evidence: 1, review: 1, learning: 1 })
    expect(result.truncated).toBe(false)
    for (const hit of result.hits) {
      expect(hit.snippet.hit.toLowerCase()).toBe('widget')
      expect(hit.source).not.toContain(root)
      expect(hit.snippet.pre.length).toBeLessThanOrEqual(60)
    }
    expect(result.hits.map((hit) => hit.source).sort()).toEqual(['events.ndjson', 'issues/ISSUE-1/contract.json', 'issues/ISSUE-1/review-abcdef123456.json', 'learnings.json', 'worktree:ISSUE-1/.ak-loop/dod.json'])
    expect(search(stateDir, 'widget', { types: ['review'], config: loaded.config }, NOW).hits.map((hit) => hit.type)).toEqual(['review'])
    expect(search(stateDir, 'widget', { issue: 'ISSUE-2' }, NOW).hits).toEqual([])
    // the 24h window drops the contract, generated four days ago
    expect(search(stateDir, 'widget', { window: '24h' }, NOW).counts.contract).toBe(0)
  })

  it('sees a changed file on the next search (mtime/size cache)', () => {
    const { stateDir } = tempState()
    const path = writeIssueFile(stateDir, 'ISSUE-1', 'review-aaaa.json', { text: 'first' })
    expect(search(stateDir, 'second', {}, NOW).hits).toHaveLength(0)
    writeFileSync(path, JSON.stringify({ text: 'second pass' }))
    utimesSync(path, NOW, new Date(Date.now() + 1000))
    expect(search(stateDir, 'second', {}, NOW).hits).toHaveLength(1)
  })

  it('caps hits and searches a 30-day, 20k-event log in under 500 ms', () => {
    const { stateDir } = tempState()
    const events: LoopEvent[] = []
    for (let index = 0; index < 20_000; index += 1) events.push(ev(Math.floor((index / 20_000) * 30 * D), index % 7 ? 'provider.call' : 'worker.nudged', { issue: `ISSUE-${index % 300}`, role: 'reviewer', reason: index % 50 ? 'idle' : 'needle in the log', durationMs: index }))
    writeEvents(stateDir, events.reverse())
    const started = performance.now()
    const result = search(stateDir, 'needle', { window: '30d' }, NOW)
    expect(performance.now() - started).toBeLessThan(500)
    expect(result.counts.event).toBe(400)
    expect(result.hits).toHaveLength(200)
    expect(result.truncated).toBe(true)
    expect(result.hits[0]!.at! >= result.hits[1]!.at!).toBe(true)
    const again = performance.now()
    search(stateDir, 'needle', { window: '7d' }, NOW)
    expect(performance.now() - again).toBeLessThan(100)
  })
})

describe('insights routes', () => {
  const board: IssueBoardCache = { read: async () => ({ provider: 'github', repo: 'example/app', status: 'fresh', fetchedAt: NOW.toISOString(), issues: [], truncated: false, error: null }) }
  const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) }

  it('serves metrics and search, rejecting bad windows, short queries and unsafe issues', async () => {
    const { root, stateDir } = tempState()
    writeEvents(stateDir, [{ at: new Date().toISOString(), type: 'worker.failed', issue: 'ISSUE-1', reason: 'boom happened' }])
    const server = await startUiServer({ loaded: loadedFor(root, stateDir), runner, port: 0, board })
    servers.push(server)
    const get = (path: string): Promise<Response> => fetch(`${server.url}${path}`, { headers: { 'x-harness-session': server.token } })
    const metrics = await get('api/v1/metrics')
    expect(metrics.status).toBe(200)
    expect(await metrics.json()).toMatchObject({ window: '7d', totals: { failed: 1 } })
    expect((await get('api/v1/metrics?window=90d')).status).toBe(400)
    expect((await get('api/v1/search?q=b')).status).toBe(400)
    expect((await get('api/v1/search?q=boom&window=60d')).status).toBe(400)
    expect((await get('api/v1/search?q=boom&types=event,nope')).status).toBe(400)
    expect((await get('api/v1/search?q=boom&issue=a/../../x')).status).toBe(400)
    const found = await (await get('api/v1/search?q=boom&types=event&issue=ISSUE-1')).json() as { hits: readonly { issue: string }[] }
    expect(found.hits.map((hit) => hit.issue)).toEqual(['ISSUE-1'])
  })
})
