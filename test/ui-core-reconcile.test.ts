import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDispatchLedger, readActiveClaims } from '../src/execution/coordination.js'
import type { BoardSnapshot } from '../src/ui/api/board.js'
import type { IssueRecord } from '../src/ui/api/projection.js'
import { computeLocks, cronCadenceMs, reconcile, trackerClosed, type ReconcileInput } from '../src/ui/api/reconcile.js'

const cleanups: string[] = []
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }) })

const NOW = new Date('2026-01-10T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()

const record = (issue: string, patch: Partial<IssueRecord> = {}): IssueRecord => ({
  issue, title: issue, url: null, trackerState: null, phase: 'running', reviewState: null, run: null, dispatch: null,
  pullRequest: null, pendingDecisions: [], error: null, updatedAt: ago(60_000), ...patch,
})

const board = (issues: readonly { identifier: string; state: string; lane: BoardSnapshot['issues'][number]['lane'] }[], patch: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  provider: 'linear', repo: 'acme/app', status: 'fresh', fetchedAt: ago(1_000), truncated: false, error: null,
  issues: issues.map((issue) => ({ ...issue, title: issue.identifier, url: 'https://tracker.example/x', labels: [], assignees: [], createdAt: ago(1), updatedAt: ago(1) })), ...patch,
})

const input = (patch: Partial<ReconcileInput> = {}): ReconcileInput => ({
  now: NOW, staleAfterMs: 600_000, issues: [], board: board([]), boardRefreshMs: 60_000, dispatches: [], claims: [],
  orca: { at: ago(1_000), worktreeIds: [] }, orcaStaleAfterMs: 600_000, loopAt: ago(1_000), maxAgents: 4, ...patch,
})

describe('reconciliation between the loop and the outside world', () => {
  it('flags a tracker Done/Canceled issue the loop still holds a slot, lease or active run for', () => {
    const result = reconcile(input({
      issues: [record('ENG-1'), record('ENG-2'), record('ENG-3', { trackerState: 'Canceled' })],
      board: board([{ identifier: 'ENG-1', state: 'Done', lane: 'done' }, { identifier: 'ENG-2', state: 'Done', lane: 'done' }]),
      dispatches: [{ issue: 'ENG-1', worktreeId: 'wt-1', finished: false }, { issue: 'ENG-2', worktreeId: 'wt-2', finished: true }],
      claims: [{ issue: 'ENG-3', claimedAt: ago(1_000) }],
      orca: { at: ago(1_000), worktreeIds: ['wt-1'] },
    }))
    expect(result.drift.map((item) => [item.issue, item.kind])).toEqual([['ENG-1', 'tracker-closed'], ['ENG-3', 'tracker-closed']])
    expect(result.drift[0]).toMatchObject({ trackerState: 'Done', loopPhase: 'running' })
    expect(result.drift[0]!.detail).toContain('a worker slot')
  })

  it('reports running above the ceiling ("5/4 workers") as capacity overcount', () => {
    const dispatches = [1, 2, 3, 4, 5].map((n) => ({ issue: `ENG-${n}`, worktreeId: `wt-${n}`, finished: false }))
    const result = reconcile(input({ dispatches, orca: { at: ago(1_000), worktreeIds: dispatches.map((item) => item.worktreeId) } }))
    expect(result.drift).toEqual([expect.objectContaining({ issue: null, kind: 'capacity-overcount', detail: expect.stringContaining('5/4') })])
  })

  it('treats a lease without a dispatch as a leak only past the stale window (dispatch writes its record after claiming)', () => {
    expect(reconcile(input({ claims: [{ issue: 'ENG-1', claimedAt: ago(30_000) }] })).drift).toEqual([])
    expect(reconcile(input({ claims: [{ issue: 'ENG-1', claimedAt: ago(700_000) }] })).drift.map((item) => item.kind)).toEqual(['lease-without-dispatch'])
    expect(reconcile(input({ claims: [{ issue: 'ENG-1', claimedAt: ago(700_000) }], dispatches: [{ issue: 'ENG-1', worktreeId: 'wt', finished: true }] })).drift[0]?.detail).toMatch(/never released/)
  })

  it('reports a dispatch without a worker only when Orca was actually read and is fresh', () => {
    const dispatches = [{ issue: 'ENG-1', worktreeId: 'wt-gone', finished: false }]
    expect(reconcile(input({ dispatches, orca: { at: ago(1_000), worktreeIds: ['wt-other'] } })).drift.map((item) => item.kind)).toEqual(['dispatch-without-worker'])
    expect(reconcile(input({ dispatches, orca: { at: null, worktreeIds: null } })).drift).toEqual([])
    expect(reconcile(input({ dispatches, orca: { at: ago(3_600_000), worktreeIds: ['wt-other'] } })).drift).toEqual([])
  })

  it('reports freshness per source; a board that failed to refresh is stale even when recent, and "never" is never fresh', () => {
    const fresh = reconcile(input()).freshness
    expect(fresh.map((item) => [item.source, item.stale])).toEqual([['loop', false], ['tracker', false], ['orca', false]])
    const stale = reconcile(input({ loopAt: null, board: board([], { status: 'stale' }), orca: { at: null, worktreeIds: null } })).freshness
    expect(stale.map((item) => [item.source, item.stale, item.at])).toEqual([['loop', true, null], ['tracker', true, ago(1_000)], ['orca', true, null]])
  })

  it('locks drifted issues, and every in-flight issue while the tracker read is stale — a stale loop alone locks nothing', () => {
    const issues = [record('ENG-1', { dispatch: { branch: 'b', worktree: null, worktreeId: 'wt', terminal: null, provider: null, model: null, contractDigest: null, dispatchedAt: null } }), record('ENG-2')]
    const drift = reconcile(input({ issues, board: board([{ identifier: 'ENG-1', state: 'Done', lane: 'done' }]), dispatches: [{ issue: 'ENG-1', worktreeId: 'wt', finished: false }], orca: { at: ago(1), worktreeIds: ['wt'] } }))
    expect(Object.keys(computeLocks(issues, drift.drift, drift.freshness))).toEqual(['ENG-1'])
    expect(computeLocks(issues, drift.drift, drift.freshness)['ENG-1']).toMatch(/Reconcile first/)
    const staleTracker = reconcile(input({ issues, board: board([], { status: 'error' }) }))
    expect(computeLocks(issues, [], staleTracker.freshness)).toEqual({ 'ENG-1': expect.stringMatching(/stale/) })
    expect(computeLocks(issues, [], reconcile(input({ issues, loopAt: null })).freshness)).toEqual({})
  })

  it('derives the stale window from the tick cron and recognises closed tracker states', () => {
    expect(cronCadenceMs('*/5 * * * *')).toBe(300_000)
    expect(cronCadenceMs('*/2 * * * *')).toBe(120_000)
    expect(cronCadenceMs('hourly')).toBe(3_600_000)
    expect(cronCadenceMs('0 9 * * 1-5')).toBe(300_000)
    expect(cronCadenceMs(undefined)).toBe(300_000)
    for (const state of ['Done', 'Canceled', 'cancelled', 'Completed', 'Duplicate']) expect(trackerClosed(state)).toBe(true)
    expect(trackerClosed('In Progress')).toBe(false)
    expect(trackerClosed('Shipped', 'done')).toBe(true)
  })

  it('reads active leases from the claim files, without replaying the ledger or creating directories', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'harness-ui-core-claims-')); cleanups.push(stateDir)
    expect(readActiveClaims(join(stateDir, 'missing'))).toEqual([])
    const ledger = createDispatchLedger(stateDir)
    const { lease } = ledger.claim({ tracker: 'linear', repository: 'acme/app', issue: 'ENG-1', worktree: 'wt', branch: 'b', owner: 'loop' })
    ledger.claim({ tracker: 'linear', repository: 'acme/app', issue: 'ENG-2', worktree: 'wt2', branch: 'b2', owner: 'loop' })
    expect(readActiveClaims(stateDir).map((claim) => claim.issue).sort()).toEqual(['ENG-1', 'ENG-2'])
    ledger.release(lease, 'done')
    expect(readActiveClaims(stateDir).map((claim) => claim.issue)).toEqual(['ENG-2'])
  })
})

describe('tracker state for issues off the board', () => {
  it('looks issues up in the background, bounded per cycle, and never reports an unknown state', async () => {
    const { createTrackerStateCache } = await import('../src/ui/api/extras.js')
    const asked: string[] = []
    let clock = 0
    const read = createTrackerStateCache(async (issue) => { asked.push(issue); return issue === 'ISSUE-1' ? 'Canceled' : 'In Progress' }, () => clock)
    const ids = Array.from({ length: 10 }, (_, index) => `ISSUE-${index + 1}`)
    expect(read(ids)).toEqual({})
    expect(asked).toHaveLength(8)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(read(ids)['ISSUE-1']).toBe('Canceled')
    expect(asked).toHaveLength(10)
    clock += 11 * 60_000
    read(['ISSUE-1'])
    expect(asked).toHaveLength(11)
  })
})
