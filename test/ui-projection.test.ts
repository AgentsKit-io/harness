import { describe, expect, it } from 'vitest'
import { emptyProjection, overlayLiveState, reduce, type Decision, type ProjectionState, type RunRecord } from '../src/ui/api/projection.js'
import type { LoopEvent } from '../src/loop/retro.js'

const at = (n: number): string => new Date(2026, 0, 1, 0, 0, n).toISOString()
const fold = (events: readonly LoopEvent[]): ProjectionState => events.reduce(reduce, emptyProjection())
const enqueued: LoopEvent = { at: at(0), type: 'ui.run-enqueued', issue: 'ENG-1' }
const dispatched: LoopEvent = { at: at(1), type: 'worker.dispatched', issue: 'ENG-1', branch: 'you/eng-1', worktree: 'eng-1', worktreeId: 'wt-1', terminal: 'term-1', provider: 'codex', model: 'gpt', contractDigest: 'digest-1' }

const run = (status: RunRecord['status']): RunRecord => ({ id: 'run-1', attempt: 1, configHash: 'cfg', flow: null, builder: 'codex/gpt', contractDigest: 'digest-1', maxFixRounds: 3, perIssueTokens: 0, status, archived: false })

describe('the consolidated issue projection (pure reducer)', () => {
  it('ignores an event with no issue field, and any type it does not recognise', () => {
    const state = emptyProjection()
    expect(reduce(state, { at: at(0), type: 'stage.completed', stage: 'tick' })).toBe(state)
    expect(reduce(state, { at: at(0), type: 'something.invented', issue: 'ENG-1' })).toBe(state)
  })

  it('enqueue puts the issue in running phase, clears any stale dispatch/error', () => {
    const state = fold([enqueued])
    expect(state.issues['ENG-1']).toMatchObject({ phase: 'running', error: null, dispatch: null })
  })

  it('dispatch fills the dispatch ref', () => {
    const state = fold([enqueued, dispatched])
    expect(state.issues['ENG-1']!.dispatch).toMatchObject({ branch: 'you/eng-1', worktreeId: 'wt-1', provider: 'codex' })
  })

  it('a failed dispatch frees the issue back to available', () => {
    const state = fold([enqueued, { at: at(1), type: 'worker.dispatch-failed', issue: 'ENG-1', error: 'worktree create failed' }])
    const record = state.issues['ENG-1']!
    expect(record.phase).toBe('available')
    expect(record.error).toBe('worktree create failed')
  })

  it('reads pr.reviewed.status directly — no text guessing', () => {
    const clean = fold([enqueued, dispatched, { at: at(2), type: 'pr.reviewed', issue: 'ENG-1', pr: 42, head: 'sha1', status: 'clean' }])
    expect(clean.issues['ENG-1']!.reviewState).toBe('ready-to-merge')
    expect(clean.issues['ENG-1']!.pullRequest).toEqual({ number: 42, state: 'OPEN', head: 'sha1' })

    const findings = fold([enqueued, dispatched, { at: at(2), type: 'pr.reviewed', issue: 'ENG-1', pr: 42, head: 'sha1', status: 'findings' }])
    expect(findings.issues['ENG-1']!.reviewState).toBe('changes-requested')

    const incomplete = fold([enqueued, dispatched, { at: at(2), type: 'pr.reviewed', issue: 'ENG-1', pr: 42, head: 'sha1', status: 'incomplete' }])
    expect(incomplete.issues['ENG-1']!.reviewState).toBe('review-pending')
  })

  it('terminal delivery outcomes map to the right phase', () => {
    expect(fold([enqueued, dispatched, { at: at(2), type: 'worker.merged', issue: 'ENG-1', reason: 'clean review', worktreeId: 'wt-1' }]).issues['ENG-1']!.phase).toBe('completed')
    expect(fold([enqueued, dispatched, { at: at(2), type: 'worker.blocked', issue: 'ENG-1', reason: 'fix rounds exhausted', worktreeId: 'wt-1' }]).issues['ENG-1']!.phase).toBe('blocked')
    expect(fold([enqueued, dispatched, { at: at(2), type: 'worker.stuck', issue: 'ENG-1', reason: 'idle too long', worktreeId: 'wt-1' }]).issues['ENG-1']!.phase).toBe('blocked')
    expect(fold([enqueued, dispatched, { at: at(2), type: 'worker.abandoned', issue: 'ENG-1', reason: 'PR closed', worktreeId: 'wt-1' }]).issues['ENG-1']!.phase).toBe('needs-decision')
  })

  it('a contract escalation with no companion HITL stays blocked; one followed by a request does not matter here — overlay decides needs-input', () => {
    const state = fold([{ at: at(0), type: 'contract.escalated', issue: 'ENG-2', reasons: ['no executable outcome'], digest: 'd1' }])
    expect(state.issues['ENG-2']!.phase).toBe('blocked')
  })

  it('cleanup outcomes free the issue back to available or hold it for inspection', () => {
    const completed = fold([enqueued, dispatched, { at: at(3), type: 'ui.cleanup-completed', issue: 'ENG-1', runId: 'run-1' }])
    expect(completed.issues['ENG-1']!.dispatch).toBeNull()
    expect(completed.issues['ENG-1']!.phase).toBe('available')

    const failed = fold([enqueued, dispatched, { at: at(2), type: 'ui.cleanup-failed', issue: 'ENG-1', runId: 'run-1', detail: 'worktree remove failed' }])
    expect(failed.issues['ENG-1']!.phase).toBe('blocked')
    expect(failed.issues['ENG-1']!.error).toBe('worktree remove failed')
  })

  it('retry (a second ui.run-enqueued) clears dispatch/error the same as a fresh enqueue', () => {
    const state = fold([enqueued, dispatched, { at: at(2), type: 'worker.failed', issue: 'ENG-1', reason: 'crashed', worktreeId: 'wt-1' }, { at: at(3), type: 'ui.run-enqueued', issue: 'ENG-1' }])
    const record = state.issues['ENG-1']!
    expect(record.phase).toBe('running')
    expect(record.dispatch).toBeNull()
  })

  it('a needs-decision issue resolves to completed (close) or a clean available slate (reopen)', () => {
    const base = [enqueued, dispatched, { at: at(2), type: 'pr.closed' as const, issue: 'ENG-1', pr: 7, head: 'sha1', reason: 'closed by author' }]
    const closed = fold([...base, { at: at(3), type: 'ui.issue-decided', issue: 'ENG-1', action: 'close-issue' }])
    expect(closed.issues['ENG-1']!.phase).toBe('completed')
    const reopened = fold([...base, { at: at(3), type: 'ui.issue-decided', issue: 'ENG-1', action: 'reopen' }])
    expect(reopened.issues['ENG-1']!.phase).toBe('available')
    expect(reopened.issues['ENG-1']!.dispatch).toBeNull()
  })

  it('accepts an issue id from `event.pr` (the GitHub-intake path) — previously these events were silently dropped', () => {
    const merged = fold([{ at: at(0), type: 'github-intake.merged', pr: 223, reason: 'human merged on GitHub' }])
    expect(merged.issues['pr-223']?.phase).toBe('completed')
    expect(merged.issues['pr-223']?.pullRequest).toEqual({ number: 223, state: 'MERGED', head: null })
  })

  it('maps every github-intake.* terminal to the same phase/review-state as its dispatched counterpart', () => {
    const held = fold([{ at: at(0), type: 'github-intake.held', pr: 9, reason: 'review clean; external PR' }])
    expect(held.issues['pr-9']).toMatchObject({ phase: 'review', reviewState: 'human-approval' })
    const blocked = fold([{ at: at(0), type: 'github-intake.blocked', pr: 10, reason: 'fix rounds exhausted' }])
    expect(blocked.issues['pr-10']).toMatchObject({ phase: 'blocked', error: 'fix rounds exhausted' })
    const abandoned = fold([{ at: at(0), type: 'github-intake.abandoned', pr: 11, reason: 'closed without merge' }])
    expect(abandoned.issues['pr-11']?.phase).toBe('needs-decision')
    const needsInput = fold([{ at: at(0), type: 'github-intake.needs-input', pr: 12, reason: 'external review asks' }])
    expect(needsInput.issues['pr-12']?.phase).toBe('needs-input')
  })

  it('a pr.reviewed emission without `issue` but with `pr` lands on `pr-<n>` and sets reviewState', () => {
    const state = fold([{ at: at(0), type: 'pr.reviewed', pr: 50, head: 'sha', status: 'findings', blocking: 1, provider: 'codex', model: 'gpt', profile: 'p', votes: 1, minSeverity: 'med', source: 'github-intake', calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }])
    expect(state.issues['pr-50']).toMatchObject({ phase: 'review', reviewState: 'changes-requested' })
  })
})

describe('overlayLiveState (the queue.ts/hitl.ts merge)', () => {
  const record = fold([enqueued, dispatched]).issues['ENG-1']!

  it('attaches the live run and decisions without changing a phase the reducer already set from a real event', () => {
    const merged = overlayLiveState(record, run('running'), [])
    expect(merged.phase).toBe('running')
    expect(merged.run).toEqual(run('running'))
  })

  it('an open decision with no dispatch yet overrides the phase to needs-input', () => {
    const decision: Decision = { id: 'req-1', issue: 'ENG-2', title: 'Which rollout?', message: '', options: [], recommendedOptionId: null, batchId: 'batch-1', role: 'orchestrator', stage: 'contract', digest: 'd1', createdAt: at(0), updatedAt: at(0) }
    const notYetDispatched = fold([{ at: at(0), type: 'contract.escalated', issue: 'ENG-2', reasons: ['ambiguous'], digest: 'd1' }]).issues['ENG-2']!
    const merged = overlayLiveState(notYetDispatched, null, [decision])
    expect(merged.phase).toBe('needs-input')
  })

  it('an open decision found AFTER a dispatch does not override the phase — it is a mid-review decision, not a blocker', () => {
    const decision: Decision = { id: 'req-2', issue: 'ENG-1', title: 'Which rollout?', message: '', options: [], recommendedOptionId: null, batchId: 'batch-2', role: 'reviewer', stage: 'review', digest: 'd2', createdAt: at(0), updatedAt: at(0) }
    const merged = overlayLiveState(record, run('running'), [decision])
    expect(merged.phase).toBe('running')
    expect(merged.pendingDecisions).toEqual([decision])
  })
})
