import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIssueQueue, createLifecycleStore, listDispatched, markDispatchCancelled, projectLifecycle, readDeliveryState, type EnqueueIssueRunInput } from '../src/index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const input = (issue: string, at: string): EnqueueIssueRunInput => ({
  issue, title: issue, config: { configHash: 'config-1', flow: 'default', builder: { provider: 'codex', model: 'gpt-5.6' }, maxFixRounds: 2, perIssueTokens: 10_000, roles: { orchestrator: 'project', reviewer: 'project', watcher: 'project', delivery: 'snapshot' } },
  contract: { digest: `contract-${issue}`, status: 'valid', frozenAt: at }, preflight: { status: 'passed', checkedAt: at, capacity: { free: 1, max: 2 } }, now: new Date(at),
})

describe('persistent issue queue', () => {
  it('discovers dispatch records for provider identifiers containing path separators', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-dispatch-records-')); roots.push(root)
    const issue = 'Dev4LifeV/mais-thopp-sistemas#217'
    const recordPath = join(root, 'issues', issue, 'dispatch.json')
    mkdirSync(join(root, 'issues', issue), { recursive: true })
    writeFileSync(recordPath, JSON.stringify({ issue, worktreeId: 'worktree-217', branch: 'vctud/mais-thopp-sistemas-217', provider: 'codex', model: 'gpt-5' }))
    expect(listDispatched(root)).toEqual(expect.arrayContaining([expect.objectContaining({ issue, worktreeId: 'worktree-217' })]))
  })

  it('keeps confirmation order, reserves FIFO, and rejects the same issue twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-queue-')); roots.push(root); mkdirSync(root, { recursive: true })
    const queue = createIssueQueue({ stateDir: root })
    const first = queue.enqueue(input('ENG-1', '2026-09-23T10:00:00.000Z'))
    queue.enqueue(input('ENG-2', '2026-09-23T10:01:00.000Z'))
    expect(queue.project()).toMatchObject({ queued: 2, activeIssues: ['ENG-1', 'ENG-2'] })
    expect(queue.consumeFifo()?.issue).toBe('ENG-1')
    expect(queue.consumeFifo()?.issue).toBe('ENG-2')
    expect(() => queue.enqueue(input('ENG-1', '2026-09-23T10:02:00.000Z'))).toThrow(/already has an active queue request/)
    expect(queue.get(first.id)?.config.builder).toEqual({ provider: 'codex', model: 'gpt-5.6' })
  })

  it('persists queued work and fails closed for active cancellation without cleanup confirmation', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-queue-restart-')); roots.push(root)
    const first = createIssueQueue({ stateDir: root }).enqueue(input('ENG-3', '2026-09-23T10:00:00.000Z'))
    expect(() => createIssueQueue({ stateDir: root }).cancel(first.id, { confirmActive: true })).not.toThrow()
    const queue = createIssueQueue({ stateDir: root })
    const queued = queue.enqueue(input('ENG-4', '2026-09-23T10:01:00.000Z'))
    queue.consumeFifo()
    expect(() => queue.cancel(queued.id, { confirmActive: true })).toThrow(/cleanup.*confirmed/i)
    expect(queue.cancel(queued.id, { confirmActive: true, cleanupConfirmed: true }).status).toBe('cancelled')
  })

  it('migrates persisted v2 queue records to the current schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-queue-v2-')); roots.push(root)
    const run = createIssueQueue({ stateDir: root }).enqueue(input('ENG-v2', '2026-09-23T10:00:00.000Z'))
    const state = JSON.parse(readFileSync(join(root, 'queue.json'), 'utf8')) as { schemaVersion: number; runs: readonly Record<string, unknown>[] }
    writeFileSync(join(root, 'queue.json'), JSON.stringify({ ...state, schemaVersion: 2, runs: state.runs.map((record) => ({ ...record, schemaVersion: 2 })) }))
    expect(createIssueQueue({ stateDir: root }).get(run.id)).toMatchObject({ schemaVersion: 3, issue: 'ENG-v2', archived: false, archivedAt: null })
  })

  it('accepts an idempotent running projection from a second observer', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-queue-projection-')); roots.push(root)
    const queue = createIssueQueue({ stateDir: root })
    const run = queue.enqueue(input('ENG-8', '2026-09-23T10:00:00.000Z'))
    queue.consumeFifo()
    expect(queue.update(run.id, { status: 'running', projection: { stage: 'running' } }).status).toBe('running')
    expect(queue.update(run.id, { status: 'running', projection: { stage: 'running', terminal: 'term-1' } })).toMatchObject({ status: 'running', projection: { terminal: 'term-1' } })
  })

  it('does not accept a confirmation without a valid contract and preflight', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-queue-validation-')); roots.push(root)
    const queue = createIssueQueue({ stateDir: root })
    expect(() => queue.enqueue({ ...input('ENG-5', '2026-09-23T10:00:00.000Z'), contract: { digest: '', status: 'valid', frozenAt: 'now' } })).toThrow(/valid contract/)
  })

  it('creates a new run id for retry and keeps the failed attempt archiveable', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-queue-retry-')); roots.push(root)
    const queue = createIssueQueue({ stateDir: root })
    const first = queue.enqueue(input('ENG-9', '2026-09-23T10:00:00.000Z'))
    queue.update(first.id, { status: 'failed', error: 'provider timeout', projection: { stage: 'failed' } })
    const retry = queue.retry(first.id, new Date('2026-09-23T10:01:00.000Z'))
    expect(retry.id).not.toBe(first.id)
    expect(retry.attempt).toBe(2)
    expect(queue.get(first.id)).toMatchObject({ status: 'failed', error: 'provider timeout', archived: false })
    expect(queue.archive(first.id).archived).toBe(true)
    expect(queue.restore(first.id).archived).toBe(false)
  })

  it('retries a blocked run as a new attempt without mutating the blocked record', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-queue-blocked-retry-')); roots.push(root)
    const queue = createIssueQueue({ stateDir: root })
    const first = queue.enqueue(input('ENG-13', '2026-09-23T10:00:00.000Z'))
    queue.update(first.id, { status: 'blocked', error: 'fix rounds exhausted', projection: { stage: 'blocked' } })
    const retry = queue.retry(first.id, new Date('2026-09-23T10:01:00.000Z'))
    expect(retry.id).not.toBe(first.id)
    expect(retry.status).toBe('queued')
    expect(retry.attempt).toBe(2)
    expect(queue.get(first.id)).toMatchObject({ status: 'blocked', error: 'fix rounds exhausted', projection: { stage: 'blocked' } })
  })

  it('does not enqueue a second run after a PR-backed run becomes historical', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-queue-pr-idempotency-')); roots.push(root)
    const queue = createIssueQueue({ stateDir: root })
    const run = queue.enqueue(input('ENG-14', '2026-09-23T10:00:00.000Z'))
    queue.update(run.id, { status: 'completed', projection: { stage: 'pr-open', pullRequest: 14 } })
    expect(() => queue.enqueue(input('ENG-14', '2026-09-23T10:01:00.000Z'))).toThrow(/historical delivery/)
  })
})

describe('lifecycle projection and delivery evidence', () => {
  it('marks a cancelled dispatch finished while retaining its delivery evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-delivery-cancel-')); roots.push(root)
    const cancelled = markDispatchCancelled(root, 'Dev4LifeV/mais-thopp-sistemas#217', new Date('2026-09-23T10:00:00.000Z'))
    expect(cancelled.cancelledAt).toBe('2026-09-23T10:00:00.000Z')
    expect(cancelled.finishedAt).toBe('2026-09-23T10:00:00.000Z')
    expect(readDeliveryState(root, 'Dev4LifeV/mais-thopp-sistemas#217')).toMatchObject({ cancelledAt: '2026-09-23T10:00:00.000Z', finishedAt: '2026-09-23T10:00:00.000Z' })
  })

  it('projects PR review and terminal decisions without conflating the run with the issue', () => {
    expect(projectLifecycle({ issue: 'ENG-11', runId: 'run-1', runStatus: 'completed', stage: 'pr-open', pullRequest: { number: 11, state: 'OPEN' }, events: [{ type: 'worker.reviewed', reason: 'checks pending' }] })).toMatchObject({ phase: 'review', reviewState: 'ci-pending', runId: 'run-1' })
    expect(projectLifecycle({ issue: 'ENG-11', runId: 'run-1', runStatus: 'completed', stage: 'pr-open', pullRequest: { number: 11, state: 'OPEN' }, events: [{ type: 'pr.reviewed', status: 'clean' }] })).toMatchObject({ phase: 'review', reviewState: 'ready-to-merge' })
    expect(projectLifecycle({ issue: 'ENG-11', runId: 'run-1', runStatus: 'completed', stage: 'pr-open', pullRequest: { number: 11, state: 'OPEN' }, events: [{ type: 'worker.held', reason: 'protected paths' }] })).toMatchObject({ phase: 'review', reviewState: 'human-approval' })
    expect(projectLifecycle({ issue: 'ENG-11', runId: 'run-1', runStatus: 'needs-input', stage: 'blocked', finalFailure: true, pullRequest: { number: 11, state: 'OPEN' } })).toMatchObject({ phase: 'blocked', reviewState: null })
    expect(projectLifecycle({ issue: 'ENG-11', runId: 'run-1', runStatus: 'cancelled', pullRequest: { number: 11, state: 'OPEN' } })).toMatchObject({ phase: 'available', reviewState: null })
    expect(projectLifecycle({ issue: 'ENG-11', runId: 'run-1', runStatus: 'completed', stage: 'merged', deliveryOutcome: 'merged', pullRequest: { number: 11, state: 'MERGED' } })).toMatchObject({ phase: 'completed', reviewState: null })
  })

  it('persists lifecycle projection across a new store', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-lifecycle-')); roots.push(root)
    const first = createLifecycleStore(root)
    first.upsert({ issue: 'ENG-12', phase: 'blocked', error: 'fix rounds exhausted' })
    expect(createLifecycleStore(root).get('ENG-12')).toMatchObject({ phase: 'blocked', error: 'fix rounds exhausted' })
  })
})
