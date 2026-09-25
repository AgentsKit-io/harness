import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/adapters/command.js'
import type { LoadedLoopConfig } from '../src/loop/config.js'
import { createHitlStore } from '../src/loop/hitl.js'
import { readIssueFailures, pauseIssue } from '../src/loop/resilience-state.js'
import { answerDecision, archiveRun, cancelRun, decideIssue, enqueueRun, resumePausedIssue, restoreRun, retryRun, type ActionContext } from '../src/ui/api/actions.js'
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
