import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRetroReport, buildSuggestions, loadLoopConfig, normalizeReason, parseSince, readLoopEvents, renderRetroMarkdown, retroLearnings } from '../src/index.js'
import type { CommandResult, CommandRunner, RetroReport } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const NOW = new Date('2026-09-12T12:00:00.000Z')
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-retro-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  const state = loaded.stateDir
  mkdirSync(state, { recursive: true })
  const event = (at: string, type: string, extra: Record<string, unknown> = {}): void => appendFileSync(join(state, 'events.ndjson'), `${JSON.stringify({ at, type, ...extra })}\n`)
  const issue = (id: string, files: Record<string, unknown>): void => { mkdirSync(join(state, 'issues', id), { recursive: true }); for (const [name, value] of Object.entries(files)) writeFileSync(join(state, 'issues', id, name), JSON.stringify(value)) }
  return { dir, loaded, state, event, issue }
}

const contract = (dispatchable: boolean, generatedAt: string) => ({ schemaVersion: 1, issue: 'x', issueUpdatedAt: 'u', generatedAt, provider: 'claude', model: 'opus', contract: { intent: 'i', scope: { inScope: ['a'], outOfScope: [] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] }, digest: 'd', assessment: { dispatchable, reasons: dispatchable ? [] : ['no outcome maps to an executable check (command or test)'] }, source: 'llm' })

describe('loop retro', () => {
  it('parses windows and normalises escalation reasons', () => {
    expect(parseSince('7d', NOW).toISOString()).toBe('2026-09-05T12:00:00.000Z')
    expect(parseSince('12h', NOW).toISOString()).toBe('2026-09-12T00:00:00.000Z')
    expect(parseSince('2026-09-10T00:00:00Z', NOW).toISOString()).toBe('2026-09-10T00:00:00.000Z')
    expect(() => parseSince('yesterday', NOW)).toThrow(/Unrecognised/)
    expect(normalizeReason('2 blocking ambiguities: The audit registry (.codex/x) is missing | Are the blockers merged?')).toBe('blocking ambiguity: The audit registry (.codex/x) is missing')
    expect(normalizeReason('no outcome maps to an executable check (command or test)')).toBe('no outcome maps to an executable check (command or test)')
    expect(readLoopEvents('/nonexistent/dir')).toEqual([])
  })

  it('aggregates events, per-issue state, cooldowns and Orca runs into one report with suggestions', async () => {
    const env = setup()
    const t = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
    for (const [issue, hours] of [['ENG-1', 30], ['ENG-2', 29], ['ENG-3', 28], ['ENG-4', 27]] as const) { env.event(t(hours), 'contract.escalated', { issue, reasons: ['1 blocking ambiguity: Which app serves the demo?'] }); env.issue(issue, { 'contract.json': { ...contract(false, t(hours)), issue } }) }
    env.event(t(26), 'worker.dispatched', { issue: 'ENG-10', provider: 'claude', model: 'sonnet' })
    env.issue('ENG-10', { 'contract.json': { ...contract(true, t(26)), issue: 'ENG-10' }, 'dispatch.json': { issue: 'ENG-10', worktreeId: 'w', worktree: 'w', branch: 'b', terminal: 't', provider: 'claude', model: 'sonnet', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: t(26), url: 'u' }, 'delivery.json': { issue: 'ENG-10', prNumber: 7, reviews: { aaa: { status: 'findings', at: t(24), provider: 'codex-cli', model: 'm', blocking: 2, attempts: 1 }, bbb: { status: 'clean', at: t(22), provider: 'codex-cli', model: 'm', blocking: 0, attempts: 1 } }, fixRounds: 1, nudges: [{ kind: 'review', at: t(24), head: 'aaa' }], heldFor: null, finishedAt: t(21), finalOutcome: 'merged' } })
    env.event(t(21), 'pr.merged', { issue: 'ENG-10', pr: 7 })
    env.event(t(20), 'worker.dispatched', { issue: 'ENG-11', provider: 'claude', model: 'sonnet' })
    env.issue('ENG-11', { 'dispatch.json': { issue: 'ENG-11', worktreeId: 'w2', worktree: 'w2', branch: 'b2', terminal: 't2', provider: 'claude', model: 'sonnet', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: t(20), url: 'u' } })
    env.event(t(19), 'provider.cooldown', { provider: 'codex', kind: 'quota', until: t(-2) })
    env.event(t(300), 'worker.dispatched', { issue: 'OLD-1', provider: 'grok', model: 'g' })
    env.event(t(18), 'worker.relaunched', { issue: 'ENG-11', reason: 'orca --agent claude started in bypass-permissions mode' })
    env.event(t(17), 'contract.failed', { issue: 'ENG-12', error: 'Contract block is not valid JSON' })
    env.event(t(16), 'worker.dispatch-failed', { issue: 'ENG-13', error: 'orca worktree create failed: repo busy' })
    writeFileSync(join(env.state, 'provider-cooldowns.json'), JSON.stringify({ codex: { attempts: 0, until: t(-2), reason: 'quota: weekly 100%', markedAt: t(19) } }))
    const runner: CommandRunner = { run: async (argv) => argv[1] === 'automations' && argv[2] === 'list' ? ok({ ok: true, result: { automations: [{ id: 'a1', name: 'loop-tick', enabled: true, rrule: '*/5 * * * *', agentId: 'claude' }] } }) : ok({ ok: true, result: { runs: [{ startedAt: NOW.getTime() - 3_600_000, status: 'skipped_precheck', precheckResult: { durationMs: 2000, timedOut: false, stdout: JSON.stringify({ status: 'idle' }) } }, { startedAt: NOW.getTime() - 7_200_000, status: 'skipped_precheck', precheckResult: { durationMs: 480_000, timedOut: false, stdout: JSON.stringify({ status: 'ok', results: [{}] }) } }, { startedAt: NOW.getTime() - 10 * 86_400_000, status: 'skipped_precheck', precheckResult: { durationMs: 1, stdout: '{"status":"idle"}' } }] } }) }
    const report = await buildRetroReport({ loaded: env.loaded, runner, since: '7d', now: () => NOW })
    expect(report.window.days).toBe(7)
    expect(report.escalations).toMatchObject({ total: 4, issues: ['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4'] })
    expect(report.escalations.reasons[0]).toEqual({ reason: 'blocking ambiguity: Which app serves the demo?', count: 4 })
    expect(report.dispatches).toMatchObject({ total: 2, failed: 0, byProvider: { 'claude/sonnet': 2 } })
    expect(report.delivery).toMatchObject({ merged: 1, inFlight: 1, fixRounds: 1, reviewsClean: 1, reviewsFindings: 1, reviewsIncomplete: 0, medianLeadTimeMin: 300 })
    expect(report.providers).toMatchObject({ cooldownEvents: 1 })
    expect(report.providers.cooldowns[0]).toMatchObject({ provider: 'codex' })
    expect(report.orca).toEqual({ runs: 2, idle: 1, work: 1, timedOut: 0, avgDurationSec: 241, maxDurationSec: 480 })
    expect(report.issues.map((row) => row.issue)).toEqual(['ENG-11', 'ENG-10', 'ENG-1', 'ENG-2', 'ENG-3', 'ENG-4'])
    expect(report.issues.find((row) => row.issue === 'ENG-10')).toMatchObject({ outcome: 'merged', leadTimeMin: 300, pr: 7, reviews: 2 })
    expect(report.suggestions.map((item) => item.id)).toContain('escalation-rate')
    expect(report.harness).toEqual({ relaunches: 1, dispatchFailures: ['ENG-13: orca worktree create failed: repo busy'], contractFailures: ['ENG-12: Contract block is not valid JSON'], mergeRefusals: 0, reviewToolErrors: 0 })
    expect(report.suggestions.filter((item) => item.target === 'harness').map((item) => item.id)).toEqual(['worker-relaunch', 'dispatch-failures', 'contract-failures'])
    expect(report.suggestions.filter((item) => item.target === 'project').map((item) => item.id)).toEqual(['escalation-rate'])
    expect(report.suggestions.find((item) => item.id === 'escalation-rate')?.severity).toBe('act')
    const markdown = renderRetroMarkdown(report)
    expect(markdown).toContain('# Loop retro — my-org/my-project · person')
    expect(markdown).toContain('| Escalated (needs-info) | 4 (67%) |')
    expect(markdown).toContain('## Problems')
    expect(markdown).toContain('## What worked')
    expect(markdown).toContain('ENG-10 merged (PR #7) by claude/sonnet in 300 min')
    expect(markdown).toContain('## Adjustments — project')
    expect(markdown).toContain('## Adjustments — harness')
    expect(markdown).toContain('https://github.com/AgentsKit-io/harness/issues')
    expect(markdown).toContain('### Harness signals')
    const learnings = retroLearnings(report, markdown)
    expect(learnings.some((record) => record.category === 'adjustment' && record.text.includes('escalated'))).toBe(true)
    expect(learnings.every((record) => record.status === 'proposed')).toBe(true)
    expect(learnings.some((record) => record.category === 'worked')).toBe(true)
    const offline = await buildRetroReport({ loaded: env.loaded, since: '7d', now: () => NOW, skipOrca: true })
    expect(offline.orca).toBeNull()
    expect(offline.digest).not.toBe(report.digest)
  })

  it('emits the steady suggestion when nothing signals, and specific ones when thresholds trip', () => {
    const env = setup()
    const base: Omit<RetroReport, 'suggestions' | 'digest'> = { generatedAt: NOW.toISOString(), window: { since: 's', until: 'u', days: 7 }, project: 'p', person: 'x', counts: {}, escalations: { total: 0, issues: [], reasons: [] }, dispatches: { total: 0, failed: 0, byProvider: {} }, delivery: { merged: 0, blocked: 0, stuck: 0, abandoned: 0, inFlight: 0, fixRounds: 0, reviewsClean: 0, reviewsFindings: 0, reviewsIncomplete: 0, medianLeadTimeMin: null }, providers: { cooldowns: [], cooldownEvents: 0 }, harness: { relaunches: 0, dispatchFailures: [], contractFailures: [], mergeRefusals: 0, reviewToolErrors: 0 }, orca: null, issues: [] }
    expect(buildSuggestions({ config: env.loaded.config, report: base }).map((item) => item.id)).toEqual(['steady'])
    const noisy = { ...base, delivery: { ...base.delivery, blocked: 3, merged: 1, stuck: 2, reviewsIncomplete: 2, reviewsClean: 6 }, providers: { cooldowns: [], cooldownEvents: 4 }, orca: { runs: 10, idle: 10, work: 0, timedOut: 1, avgDurationSec: 1, maxDurationSec: 610 } }
    const ids = buildSuggestions({ config: env.loaded.config, report: noisy }).map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['fix-rounds', 'stuck-workers', 'review-incomplete', 'provider-cooldowns', 'stage-timeout', 'review-floor']))
    const harnessy = { ...base, harness: { relaunches: 0, dispatchFailures: [], contractFailures: [], mergeRefusals: 3, reviewToolErrors: 2 } }
    const hs = buildSuggestions({ config: env.loaded.config, report: harnessy })
    expect(hs.map((item) => item.id)).toEqual(['merge-refusals', 'review-tool-errors'])
    expect(hs.every((item) => item.target === 'harness')).toBe(true)
    expect(ids).not.toContain('steady')
    expect(ids).toContain('idle-loop')
    const busy = { ...noisy, dispatches: { total: 3, failed: 0, byProvider: {} } }
    expect(buildSuggestions({ config: env.loaded.config, report: busy }).map((item) => item.id)).not.toContain('idle-loop')
  })
})
