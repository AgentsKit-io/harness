import { describe, expect, it } from 'vitest'
import { buildAttention, classifyIssue, latestStops, type AttentionInput } from '../src/ui/api/attention.js'
import type { Decision, IssueRecord, RunRecord } from '../src/ui/api/projection.js'

const NOW = new Date('2026-01-10T12:00:00.000Z')
const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()

const run = (patch: Partial<RunRecord> = {}): RunRecord => ({ id: 'run-1', attempt: 1, configHash: 'h', flow: null, builder: 'codex/gpt', contractDigest: 'd', maxFixRounds: 3, perIssueTokens: 0, status: 'blocked', archived: false, ...patch })
const record = (issue: string, patch: Partial<IssueRecord> = {}): IssueRecord => ({
  issue, title: `Title ${issue}`, url: null, trackerState: null, phase: 'running', reviewState: null, run: null, dispatch: null,
  pullRequest: null, pendingDecisions: [], error: null, updatedAt: at(30), ...patch,
})
const decision = (id: string, createdAt: string): Decision => ({ id, issue: 'ENG-1', title: 'Which rollout?', message: 'context', options: [], recommendedOptionId: null, batchId: 'b', role: 'orchestrator', stage: 'contract', digest: 'x', createdAt, updatedAt: createdAt })

const input = (patch: Partial<AttentionInput> = {}): AttentionInput => ({
  now: NOW, issues: [], drift: [], locks: {}, stops: {}, delivery: {}, boardStates: {}, pausedIssues: [], plans: [], release: null,
  stagePauses: [], cooldowns: [], syncFailures: [], pii: [], automations: [], ...patch,
})

describe('the attention list', () => {
  it('orders human → failed → drift → system, oldest first inside a group, with stable ids', () => {
    const items = buildAttention(input({
      issues: [
        record('ENG-1', { phase: 'needs-input', pendingDecisions: [decision('req-2', at(5)), decision('req-1', at(50))] }),
        record('ENG-2', { phase: 'blocked', run: run(), error: 'worker gave up', updatedAt: at(100) }),
        record('ENG-3', { phase: 'review', reviewState: 'human-approval', pullRequest: { number: 7, state: 'OPEN', head: 'abc' }, updatedAt: at(1) }),
      ],
      drift: [{ issue: 'ENG-4', kind: 'tracker-closed', detail: 'The tracker says Done', trackerState: 'Done', loopPhase: 'running' }],
      stagePauses: [{ stage: 'tick', since: at(500), reason: 'config error' }],
      plans: [{ id: 'plan-a', objective: 'Build X', gate: 'plan', since: at(20) }],
      release: { head: 'f'.repeat(40), since: at(10) },
    }))
    expect(items.map((item) => item.id)).toEqual([
      'hitl:req-1', 'plan:plan-a', 'release-gate:' + 'f'.repeat(40), 'hitl:req-2', 'held-pr:ENG-3:abc',
      'blocked:ENG-2', 'drift:ENG-4:tracker-closed', 'stage-paused:tick',
    ])
    expect(items[0]).toMatchObject({ group: 'human', kind: 'hitl', decision: { id: 'req-1' }, actions: [{ id: 'answer', primary: true, destructive: false, gate: false }, { id: 'open' }] })
    expect(items.find((item) => item.kind === 'plan-gate')).toMatchObject({ issue: 'plan-a', actions: [{ id: 'approve-plan', gate: true }] })
    expect(items.find((item) => item.kind === 'held-pr')).toMatchObject({ head: 'abc', actions: [{ id: 'approve-pr', gate: true, destructive: false }, { id: 'open' }] })
    expect(items.find((item) => item.kind === 'drift')).toMatchObject({ reason: expect.not.stringContaining('tracker-closed'), detail: expect.stringContaining('tracker-closed'), actions: [{ id: 'reconcile', destructive: true }, { id: 'open' }] })
    expect(items.find((item) => item.kind === 'stage-paused')).toMatchObject({ stage: 'tick', actions: [{ id: 'resume-stage' }, { id: 'run-doctor' }] })
    expect(buildAttention(input({ issues: [record('ENG-2', { phase: 'blocked', run: run() })] }))[0]!.actions.map((action) => [action.id, action.destructive])).toEqual([['retry', false], ['cancel', true], ['open', false]])
  })

  it('pins the held-PR approval to the delivery head, not the projection guess', () => {
    const [item] = buildAttention(input({ issues: [record('ENG-3', { phase: 'review', reviewState: 'human-approval', pullRequest: { number: 7, state: 'OPEN', head: 'old' } })], delivery: { 'ENG-3': { fixRounds: 0, maxFixRounds: 3, heldFor: 'newhead' } } }))
    expect(item).toMatchObject({ id: 'held-pr:ENG-3:newhead', head: 'newhead' })
  })

  it('classifies stops from typed events: circuit breakers, stuck, fix-round cap, CI, permission wait, pause', () => {
    const stops = latestStops([
      { at: at(10), type: 'cost-guard.tripped', issue: 'A', reason: 'usage dropped 40 points' },
      { at: at(10), type: 'worker.blocked', issue: 'A', reason: 'usage dropped 40 points' },
      { at: at(9), type: 'max-duration.tripped', issue: 'B', reason: '240 min' },
      { at: at(9), type: 'worker.blocked', issue: 'B', reason: '240 min' },
      { at: at(8), type: 'worker.stuck', issue: 'C', reason: 'idle 30 min' },
      { at: at(7), type: 'worker.blocked', issue: 'D', reason: 'findings persist' },
      { at: at(6), type: 'worker.permission-wait', issue: 'E', reason: 'prompt' },
      { at: at(5), type: 'issue.paused', issue: 'F', reason: '3 failures' },
      // moved on after its stop: no longer explains anything
      { at: at(20), type: 'worker.stuck', issue: 'G', reason: 'idle' },
      { at: at(4), type: 'worker.dispatched', issue: 'G' },
    ])
    expect(Object.keys(stops).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    const blocked = (issue: string, patch: Partial<IssueRecord> = {}): IssueRecord => record(issue, { phase: 'blocked', run: run(), ...patch })
    expect(classifyIssue(blocked('A'), stops['A'], undefined)).toMatchObject({ kind: 'cost-guard', detail: 'usage dropped 40 points' })
    expect(classifyIssue(blocked('B'), stops['B'], undefined)?.kind).toBe('max-duration')
    expect(classifyIssue(blocked('C'), stops['C'], undefined)?.kind).toBe('stuck')
    expect(classifyIssue(blocked('D'), stops['D'], { fixRounds: 3, maxFixRounds: 3, heldFor: null })?.kind).toBe('fix-round-cap')
    expect(classifyIssue(blocked('D'), stops['D'], { fixRounds: 1, maxFixRounds: 3, heldFor: null })?.kind).toBe('blocked')
    expect(classifyIssue(blocked('X', { reviewState: 'ci-failed' }), undefined, undefined)?.kind).toBe('ci-failed')
    expect(classifyIssue(record('E', { phase: 'review', run: run({ status: 'running' }) }), stops['E'], undefined)).toMatchObject({ kind: 'permission-wait', ids: ['open', 'cancel'] })
    expect(classifyIssue(blocked('F'), stops['F'], undefined, true)).toMatchObject({ ids: ['resume', 'open'], reason: expect.stringMatching(/paused/) })
    expect(classifyIssue(blocked('F'), stops['F'], undefined, false)).toBeNull()
    expect(classifyIssue(record('Z', { phase: 'running' }), undefined, undefined)).toBeNull()
    // Every reason is a sentence, never the raw code.
    for (const issue of ['A', 'B', 'C', 'D']) expect(classifyIssue(blocked(issue), stops[issue], undefined)!.reason).toMatch(/^[A-Z].*\.$/)
  })

  it('leaves cancelled, archived and tracker-closed work out of the blocked list', () => {
    const items = buildAttention(input({
      issues: [
        record('ENG-1', { phase: 'blocked', run: run({ status: 'cancelled' }) }),
        record('ENG-2', { phase: 'blocked', run: run({ archived: true }) }),
        record('ENG-3', { phase: 'blocked', trackerState: 'Canceled' }),
        record('ENG-4', { phase: 'blocked' }),
        record('ENG-5', { phase: 'blocked' }),
      ],
      boardStates: { 'ENG-4': 'Done' },
    }))
    expect(items.map((item) => item.issue)).toEqual(['ENG-5'])
  })

  it('marks items locked with the reason when their issue is locked', () => {
    const [item] = buildAttention(input({ issues: [record('ENG-1', { phase: 'blocked', run: run() })], locks: { 'ENG-1': 'Tracker data is stale.' } }))
    expect(item).toMatchObject({ locked: true, lockReason: 'Tracker data is stale.' })
  })

  it('reports system conditions: cooldowns, tracker sync failures, PII, automations', () => {
    const items = buildAttention(input({
      cooldowns: [{ provider: 'codex', until: at(-30), reason: 'quota', since: at(5) }],
      syncFailures: [{ issue: 'ENG-1', operation: 'completion', error: 'HTTP 500', at: at(9) }, { issue: 'ENG-1', operation: 'review-state', error: 'HTTP 502', at: at(3) }],
      pii: [{ issue: 'ENG-2', kinds: ['email'], at: at(2) }],
      automations: [{ name: 'loop-tick', stage: 'tick', state: 'missing', fields: [], since: at(1) }, { name: 'loop-deliver', stage: 'deliver', state: 'drifted', fields: ['trigger'], since: at(1) }],
    }))
    expect(items.map((item) => item.id)).toEqual(['provider-cooldown:codex', 'tracker-sync:ENG-1', 'pii:ENG-2', 'automation-drift:loop-deliver', 'automation-missing:loop-tick'])
    expect(items.every((item) => item.group === 'system')).toBe(true)
    expect(items[1]).toMatchObject({ detail: 'review-state: HTTP 502' })
    expect(items.find((item) => item.kind === 'automation-missing')).toMatchObject({ stage: 'tick', actions: [{ id: 'reinstall-automations' }] })
  })
})
