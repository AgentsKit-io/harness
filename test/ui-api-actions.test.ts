import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/adapters/command.js'
import type { LoadedLoopConfig } from '../src/loop/config.js'
import { createHitlStore } from '../src/loop/hitl.js'
import { readIssueFailures, pauseIssue } from '../src/loop/resilience-state.js'
import { writeJsonAtomic } from '../src/loop/fs-atomic.js'
import { dispatchRecordPath } from '../src/loop/tick.js'
import { answerDecision, archiveRun, cancelRun, cleanupRun, decideIssue, enqueueRun, resolveTrackerSync, resumePausedIssue, restoreRun, retryRun, type ActionContext } from '../src/ui/api/actions.js'
import { readLoopEvents } from '../src/loop/retro.js'
import { readCurrentProjection } from '../src/ui/api/store.js'

const cleanups: string[] = []
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }) })

const contextFor = (): ActionContext => {
  const root = mkdtempSync(join(tmpdir(), 'harness-ui-api-actions-')); cleanups.push(root)
  const stateDir = join(root, '.ak-loop')
  mkdirSync(stateDir, { recursive: true })
  const loaded = {
    root, stateDir, path: join(root, 'loop.config.yaml'), configHash: 'hash', unknownKeys: [],
    config: { connectors: { tracker: 'github' }, project: { repo: 'acme/app' }, delivery: { returnState: 'Todo' }, resilience: { pausedLabel: 'loop:paused' }, orca: { bin: 'orca' }, linear: { doneState: 'Done' } },
  } as unknown as LoadedLoopConfig
  const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) }
  return { loaded, runner }
}

const hitlRequest = () => ({ role: 'orchestrator' as const, stage: 'contract', question: 'Which rollout?', context: '', options: [{ id: 'a', title: 'A', description: 'a' }, { id: 'b', title: 'B', description: 'b' }, { id: 'c', title: 'C', description: 'c' }], recommendedOptionId: 'c' })

describe('the control-plane action surface', () => {
  it('enqueue creates a running record the projection can read back — queue.ts owns the run id', () => {
    const context = contextFor()
    const { runId } = enqueueRun(context, { issue: 'ENG-1', configHash: 'hash', flow: null, builder: { provider: 'codex', model: 'gpt' }, contractDigest: 'digest-1', maxFixRounds: 3, perIssueTokens: 0 })
    const record = readCurrentProjection(context.loaded.stateDir).issues['ENG-1']!
    expect(record.phase).toBe('running')
    expect(record.run).toMatchObject({ id: runId, status: 'queued', builder: 'codex/gpt' })
  })

  it('a tracker sync retry the tracker still refuses records nothing, so the failure stays visible', async () => {
    const base = contextFor()
    const loaded = { ...base.loaded, config: { ...base.loaded.config, github: { issues: { labels: { todo: 'ai-ready', inProgress: 'ai-working', review: 'ai-pr', done: 'ai-done', blocked: 'ai-blocked' } } } } } as unknown as LoadedLoopConfig
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => argv.includes('edit')
      ? { code: 1, stdout: '', stderr: "failed to update: 'ai-done' not found", timedOut: false, durationMs: 1 }
      : { code: 0, stdout: JSON.stringify({ number: 76, title: 't', body: '', state: 'OPEN', url: 'u', labels: [{ name: 'ai-pr' }], assignees: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }), stderr: '', timedOut: false, durationMs: 1 } }
    await expect(resolveTrackerSync({ loaded, runner }, 'acme/app#76', 'retry')).rejects.toThrow()
    expect(readLoopEvents(loaded.stateDir, 0).some((event) => event.type === 'ui.tracker-sync-resolved')).toBe(false)
    await resolveTrackerSync({ loaded, runner }, 'acme/app#76', 'dismiss')
    expect(readLoopEvents(loaded.stateDir, 0).filter((event) => event.type === 'ui.tracker-sync-resolved')).toMatchObject([{ issue: 'acme/app#76', action: 'dismiss' }])
  })

  it('cancel cleanup treats a stale terminal handle as already closed and goes on to remove the worktree', async () => {
    const context = contextFor()
    writeJsonAtomic(dispatchRecordPath(context.loaded.stateDir, 'acme/app#83'), { issue: 'acme/app#83', worktreeId: 'repo::C:/w/app-83', branch: 'you/app-83', provider: 'codex', model: 'gpt', terminal: 'term_gone', leaseId: 'lease-1', dispatchedAt: '2026-09-26T00:00:00.000Z' })
    const calls: string[] = []
    const runner: CommandRunner = { run: async (argv): Promise<CommandResult> => {
      calls.push(argv.slice(1, 3).join(' '))
      return argv[1] === 'terminal' && argv[2] === 'close'
        ? { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' } }), stderr: '', timedOut: false, durationMs: 1 }
        : { code: 0, stdout: '{"ok":true,"result":{}}', stderr: '', timedOut: false, durationMs: 1 }
    } }
    await cleanupRun({ ...context, runner }, 'acme/app#83', 'run-1').catch((error: unknown) => {
      expect(String(error)).not.toContain('terminal cleanup failed')
    })
    expect(calls).toContain('worktree rm')
  })

  it('cancelling a queued run (no dispatch, no active lease) completes cleanup immediately', async () => {
    const context = contextFor()
    const { runId } = enqueueRun(context, { issue: 'ENG-2', configHash: 'hash', flow: null, builder: { provider: 'codex', model: 'gpt' }, contractDigest: 'digest-1', maxFixRounds: 3, perIssueTokens: 0 })
    await cancelRun(context, 'ENG-2', runId)
    const record = readCurrentProjection(context.loaded.stateDir).issues['ENG-2']!
    expect(record.run?.status).toBe('cancelled')
    expect(record.dispatch).toBeNull()
    expect(record.phase).toBe('available')
  })

  it('retry starts a fresh attempt under a new run id; archive and restore toggle it out of and back into the active board', async () => {
    const context = contextFor()
    const first = enqueueRun(context, { issue: 'ENG-3', configHash: 'hash', flow: null, builder: { provider: 'codex', model: 'gpt' }, contractDigest: 'digest-1', maxFixRounds: 3, perIssueTokens: 0 })
    // queue.ts only allows retrying a non-active run — cancel it first, the same way the UI would before a retry.
    await cancelRun(context, 'ENG-3', first.runId)
    const { runId } = retryRun(context, 'ENG-3', first.runId)
    expect(runId).not.toBe(first.runId)
    expect(readCurrentProjection(context.loaded.stateDir).issues['ENG-3']!.run).toMatchObject({ id: runId, attempt: 2 })
    // Archiving requires a terminal run — the original (already cancelled) attempt, not the freshly retried one.
    archiveRun(context, first.runId)
    expect(readCurrentProjection(context.loaded.stateDir).issues['ENG-3']!.run?.id).toBe(runId)
    restoreRun(context, first.runId)
  })

  it('validates the option before recording an answer, and requires free text only for the anchor', () => {
    const context = contextFor()
    const hitl = createHitlStore(context.loaded.stateDir)
    const created = hitl.create({ requestId: 'req-1', batchId: 'batch-1', issue: 'ENG-4', digest: 'digest-1', ...hitlRequest() })
    expect(() => answerDecision(context, 'ENG-4', created.digest, { requestId: 'req-1', optionId: 'not-an-option', actor: 'alice' })).toThrow(/Unknown HITL option/)
    expect(() => answerDecision(context, 'ENG-4', created.digest, { requestId: 'req-1', optionId: 'none-of-the-above', actor: 'alice' })).toThrow(/requires a non-empty explanation/)
    expect(() => answerDecision(context, 'ENG-4', created.digest, { requestId: 'req-1', optionId: 'a', freeText: 'not allowed here', actor: 'alice' })).toThrow(/only allowed with/)
    expect(() => answerDecision(context, 'ENG-4', 'stale-digest', { requestId: 'req-1', optionId: 'a', actor: 'alice' })).toThrow(/stale/)
  })

  it('reports batch-ready only once every sibling request has an answer, and is idempotent for an already-answered one', () => {
    const context = contextFor()
    const hitl = createHitlStore(context.loaded.stateDir)
    const first = hitl.create({ requestId: 'batch-1:0', batchId: 'batch-1', issue: 'ENG-5', digest: 'digest-1:0', ...hitlRequest(), question: 'Q1' })
    const second = hitl.create({ requestId: 'batch-1:1', batchId: 'batch-1', issue: 'ENG-5', digest: 'digest-1:1', ...hitlRequest(), question: 'Q2' })
    const firstAnswer = answerDecision(context, 'ENG-5', first.digest, { requestId: 'batch-1:0', optionId: 'a', actor: 'alice' })
    expect(firstAnswer.batchReady).toBe(false)
    const secondAnswer = answerDecision(context, 'ENG-5', second.digest, { requestId: 'batch-1:1', optionId: 'b', actor: 'alice' })
    expect(secondAnswer.batchReady).toBe(true)
    // Answering the same request again is a no-op, not an error.
    expect(answerDecision(context, 'ENG-5', first.digest, { requestId: 'batch-1:0', optionId: 'a', actor: 'alice' })).toEqual({ batchReady: true, stage: 'contract' })
  })

  it('an open decision with no dispatch yet shows the issue as needs-input; answering it clears that override', () => {
    const context = contextFor()
    const hitl = createHitlStore(context.loaded.stateDir)
    const created = hitl.create({ requestId: 'req-1', batchId: 'batch-1', issue: 'ENG-6', digest: 'digest-1', ...hitlRequest() })
    expect(readCurrentProjection(context.loaded.stateDir).issues['ENG-6']!.phase).toBe('needs-input')
    answerDecision(context, 'ENG-6', created.digest, { requestId: 'req-1', optionId: 'c', actor: 'alice' })
    // No queue run and no other event ever touched this issue, so it now has no persisted record at all — the
    // same as an issue nobody has started yet, which is exactly right: nothing is blocking it anymore.
    expect(readCurrentProjection(context.loaded.stateDir).issues['ENG-6']?.phase).not.toBe('needs-input')
  })

  it('clears a resilience pause locally even when the tracker label removal is a no-op stub', async () => {
    const context = contextFor()
    pauseIssue(context.loaded.stateDir, 'ENG-7', 'too many failures')
    expect(readIssueFailures(context.loaded.stateDir, 'ENG-7').pausedAt).not.toBeNull()
    await resumePausedIssue(context, 'ENG-7')
    expect(readIssueFailures(context.loaded.stateDir, 'ENG-7').pausedAt).toBeNull()
  })

  it('refuses to decide an issue that is not waiting on a close-or-reopen decision', async () => {
    const context = contextFor()
    await expect(decideIssue(context, 'ENG-8', 'close-issue')).rejects.toThrow(/not waiting on a close-or-reopen decision/)
  })
})

describe('retry after a failed delivery', () => {
  it('resumes delivery on the open PR when the delivery of a completed run ended blocked, and still refuses one that merged', async () => {
    // Live (law-os AGE-1837): the run completed when its PR opened, delivery then hit the fix-round cap. Attention
    // offered Retry and the queue refused ("got completed"); a fresh attempt could not dispatch past the open PR either.
    const { createIssueQueue } = await import('../src/loop/queue.js')
    const { deliveryStatePath, readDeliveryState } = await import('../src/loop/deliver.js')
    const context = contextFor()
    const issue = 'AGE-1837'
    const { runId } = enqueueRun(context, { issue, configHash: 'hash', flow: null, builder: { provider: 'codex', model: 'gpt' }, contractDigest: 'd', maxFixRounds: 2, perIssueTokens: 0 })
    createIssueQueue({ stateDir: context.loaded.stateDir }).update(runId, { status: 'completed', projection: { stage: 'pr-open', pullRequest: 3 } })
    const delivery = (finalOutcome: string) => writeJsonAtomic(deliveryStatePath(context.loaded.stateDir, issue), { issue, prNumber: 3, reviews: { abc1234: { status: 'findings' } }, fixRounds: 2, nudges: [{ kind: 'ci' }], handoffs: [], heldFor: null, finishedAt: '2026-09-27T00:00:00.000Z', finalOutcome, cancelledAt: null })
    delivery('merged')
    expect(() => retryRun(context, issue, runId)).toThrow(/got completed/)
    delivery('blocked')
    expect(retryRun(context, issue, runId)).toEqual({ runId })
    expect(readDeliveryState(context.loaded.stateDir, issue)).toMatchObject({ prNumber: 3, finishedAt: null, finalOutcome: null, fixRounds: 0, nudges: [] })
    expect(createIssueQueue({ stateDir: context.loaded.stateDir }).list().filter((run) => run.issue === issue)).toHaveLength(1)
    expect(readCurrentProjection(context.loaded.stateDir).issues[issue]).toMatchObject({ phase: 'review', error: null })
  })

  it('a resumed failed delivery gets its error budget, failed-at head and tracker state back; a cancelled run is never resumed', async () => {
    const { createIssueQueue } = await import('../src/loop/queue.js')
    const { deliveryStatePath, readDeliveryState } = await import('../src/loop/deliver.js')
    const context = contextFor()
    const issue = 'AGE-1900'
    const { runId } = enqueueRun(context, { issue, configHash: 'hash', flow: null, builder: { provider: 'codex', model: 'gpt' }, contractDigest: 'd', maxFixRounds: 2, perIssueTokens: 0 })
    const queue = createIssueQueue({ stateDir: context.loaded.stateDir })
    queue.update(runId, { status: 'completed', projection: { stage: 'pr-open', pullRequest: 3 } })
    const failed = { issue, prNumber: 3, reviews: {}, fixRounds: 1, nudges: [], handoffs: [], heldFor: null, finishedAt: '2026-09-27T00:00:00.000Z', finalOutcome: 'failed', cancelledAt: null, consecutiveErrors: 3, failedAtHead: 'feed123', trackerState: 'Blocked' }
    writeJsonAtomic(deliveryStatePath(context.loaded.stateDir, issue), failed)
    expect(retryRun(context, issue, runId)).toEqual({ runId })
    expect(readDeliveryState(context.loaded.stateDir, issue)).toMatchObject({ finalOutcome: null, consecutiveErrors: 0, failedAtHead: null, trackerState: null })

    // Cancelled after its delivery gave up: cleanup already tore it down, so Retry starts a fresh attempt instead.
    writeJsonAtomic(deliveryStatePath(context.loaded.stateDir, issue), { ...failed, cancelledAt: '2026-09-27T01:00:00.000Z' })
    queue.update(runId, { status: 'cancelled' })
    const fresh = retryRun(context, issue, runId)
    expect(readDeliveryState(context.loaded.stateDir, issue)).toMatchObject({ finalOutcome: 'failed', cancelledAt: '2026-09-27T01:00:00.000Z' })
    expect(fresh.runId).not.toBe(runId)
  })
})
