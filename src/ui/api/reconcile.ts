import type { BoardSnapshot } from './board.js'
import type { Drift, Freshness } from './contract.js'
import type { IssueRecord } from './projection.js'

/**
 * Reconciliation: where the loop's own view of an issue (projection, dispatch records, coordination leases) and the
 * outside world (the tracker board, Orca's worktrees) disagree. Pure — `extras.ts` gathers the inputs, this only
 * compares them. Each drift names the one fact that disagrees; the UI locks destructive actions on that issue until
 * `POST /issues/:id/reconcile` settles it.
 */

export interface DispatchFact {
  readonly issue: string
  readonly worktreeId: string
  readonly finished: boolean
}

export interface ClaimFact {
  readonly issue: string
  readonly claimedAt: string
}

export interface OrcaFact {
  /** When Orca's worktree list was last read successfully; `null` = never. */
  readonly at: string | null
  /** Live worktree ids; `null` when never read (dispatch-without-worker is then undecidable, never assumed). */
  readonly worktreeIds: readonly string[] | null
}

export interface ReconcileInput {
  readonly now: Date
  readonly staleAfterMs: number
  readonly issues: readonly IssueRecord[]
  readonly board: BoardSnapshot | null
  /** The board cache's own refresh period; the tracker is only stale past twice that (or `staleAfterMs`). */
  readonly boardRefreshMs: number
  readonly dispatches: readonly DispatchFact[]
  readonly claims: readonly ClaimFact[]
  readonly orca: OrcaFact
  readonly orcaStaleAfterMs: number
  /** Last sign of life from the loop's stages (see `extras.ts`); `null` = none on disk. */
  readonly loopAt: string | null
  readonly maxAgents: number
}

export interface ReconcileResult {
  readonly drift: readonly Drift[]
  readonly freshness: readonly Freshness[]
}

const CLOSED_STATES = /^(done|completed|closed|cancell?ed|canceled|duplicate|won'?t ?(do|fix))$/i
const ACTIVE_RUN = new Set(['queued', 'dispatching', 'running'])

/** Whether a tracker state (or board lane) means the issue is finished on the tracker side. */
export const trackerClosed = (state: string | null | undefined, lane?: string | null): boolean => lane === 'done' || (typeof state === 'string' && CLOSED_STATES.test(state.trim()))

/** `*\/N * * * *` → N minutes; `hourly` → 60; anything else falls back to the schema default (5 min). */
export const cronCadenceMs = (cron: string | null | undefined): number => {
  const value = (cron ?? '').trim()
  const every = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(value)
  if (every && Number(every[1]) > 0) return Number(every[1]) * 60_000
  if (/^\d+\s+\*\s+\*\s+\*\s+\*$/.test(value) || value === 'hourly') return 3_600_000
  if (value === '* * * * *') return 60_000
  // ponytail: other cron shapes (lists, ranges, daily) fall back to the default tick; a cron parser is not worth it here.
  return 5 * 60_000
}

const freshness = (source: Freshness['source'], at: string | null, now: Date, staleAfterMs: number, forceStale = false): Freshness => {
  const ms = at ? Date.parse(at) : Number.NaN
  const ageMs = Number.isFinite(ms) ? Math.max(0, now.getTime() - ms) : null
  return { source, at: ageMs === null ? null : at, ageMs, stale: forceStale || ageMs === null || ageMs > staleAfterMs }
}

export const reconcile = (input: ReconcileInput): ReconcileResult => {
  const { now } = input
  const drift: Drift[] = []
  const records = new Map(input.issues.map((record) => [record.issue, record]))
  const boardByIssue = new Map((input.board?.issues ?? []).map((issue) => [issue.identifier, issue]))
  const dispatchByIssue = new Map(input.dispatches.map((dispatch) => [dispatch.issue, dispatch]))
  const claimsByIssue = new Map(input.claims.map((claim) => [claim.issue, claim]))

  const orca = freshness('orca', input.orca.at, now, input.orcaStaleAfterMs)
  const tracker = freshness('tracker', input.board?.fetchedAt ?? null, now, Math.max(input.staleAfterMs, 2 * input.boardRefreshMs), input.board !== null && input.board.status !== 'fresh')
  const loop = freshness('loop', input.loopAt, now, input.staleAfterMs)

  const running = input.dispatches.filter((dispatch) => !dispatch.finished).length
  if (running > input.maxAgents) drift.push({ issue: null, kind: 'capacity-overcount', detail: `${running}/${input.maxAgents} workers hold a slot; the ceiling is ${input.maxAgents}.`, trackerState: null, loopPhase: null })

  const issues = new Set([...records.keys(), ...dispatchByIssue.keys(), ...claimsByIssue.keys()])
  for (const issue of [...issues].sort()) {
    const record = records.get(issue) ?? null
    const board = boardByIssue.get(issue)
    const trackerState = board?.state ?? record?.trackerState ?? null
    const dispatch = dispatchByIssue.get(issue)
    const claim = claimsByIssue.get(issue)
    const base = { issue, trackerState, loopPhase: record?.phase ?? null }

    if (trackerClosed(trackerState, board?.lane)) {
      const holds = [
        ...(dispatch && !dispatch.finished ? ['a worker slot'] : []),
        ...(claim ? ['a dispatch lease'] : []),
        ...(record?.run && ACTIVE_RUN.has(record.run.status) ? [`a ${record.run.status} run`] : []),
      ]
      if (holds.length) drift.push({ ...base, kind: 'tracker-closed', detail: `The tracker says ${trackerState ?? 'done'}, but the loop still holds ${holds.join(', ')}.` })
    }
    // A lease is taken just before the dispatch record is written; only one older than the stale window is a leak.
    if (claim && (!dispatch || dispatch.finished) && now.getTime() - Date.parse(claim.claimedAt) > input.staleAfterMs) {
      drift.push({ ...base, kind: 'lease-without-dispatch', detail: dispatch ? 'The dispatch finished but its lease was never released.' : 'A dispatch lease is held with no dispatch record behind it.' })
    }
    if (dispatch && !dispatch.finished && input.orca.worktreeIds && !orca.stale && !input.orca.worktreeIds.includes(dispatch.worktreeId)) {
      drift.push({ ...base, kind: 'dispatch-without-worker', detail: `The dispatch is unfinished but Orca has no worktree ${dispatch.worktreeId}.` })
    }
  }
  return { drift, freshness: [loop, tracker, orca] }
}

/**
 * Issues whose destructive actions stay disabled, with the reason. Drift locks its own issue; a stale or failed
 * tracker read locks every issue with work in flight, because the state the operator would act on is unconfirmed.
 * A stale loop does not lock: an idle or dead loop is exactly when the operator needs cancel.
 */
export const computeLocks = (issues: readonly IssueRecord[], drift: readonly Drift[], freshnessList: readonly Freshness[]): Readonly<Record<string, string>> => {
  const locks: Record<string, string> = {}
  const tracker = freshnessList.find((item) => item.source === 'tracker')
  if (tracker?.stale) {
    for (const record of issues) if (record.run || record.dispatch) locks[record.issue] = 'Tracker data is stale; refresh before changing this issue.'
  }
  for (const item of drift) if (item.issue) locks[item.issue] = `Loop and tracker disagree: ${item.detail} Reconcile first.`
  return locks
}
