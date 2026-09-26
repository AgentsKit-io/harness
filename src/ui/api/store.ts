import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonFile } from '../../kernel/json-file.js'
import { writeJsonAtomic } from '../../loop/fs-atomic.js'
import { readLoopEvents, type LoopEvent } from '../../loop/retro.js'
import { listDispatched, readDeliveryState, type DeliverOutcome } from '../../loop/deliver.js'
import { intakeIssueId, listIntake } from '../../loop/github-intake.js'
import { createIssueQueue, type IssueRun } from '../../loop/queue.js'
import { createHitlStore, type HitlRequest } from '../../loop/hitl.js'
import { emptyProjection, overlayLiveState, reduce, type Decision, type IssueRecord, type ProjectionState, type RunRecord } from './projection.js'

/**
 * The impure half of the projection: pulls new events into `projection.ts`'s pure reducer, persists the
 * result, and overlays a live read of `queue.ts`/`hitl.ts` (see `projection.ts`'s header for why those two are
 * read directly rather than reconstructed from events). One small pair of files replace `lifecycle.json`:
 * `projection.json` (phase/reviewState/dispatch/pullRequest per issue) and `cursor.json` (how far the tail has
 * read) — `queue.json` and `hitl/requests/*.json` stay exactly where the engine already keeps them.
 */

const PROJECTION_SCHEMA_VERSION = 1 as const

interface Cursor { readonly schemaVersion: typeof PROJECTION_SCHEMA_VERSION; readonly lastEventAt: string; readonly seenAtSameMs: readonly string[] }
const cursorSchema = z.object({ schemaVersion: z.literal(PROJECTION_SCHEMA_VERSION), lastEventAt: z.string(), seenAtSameMs: z.array(z.string()) })
const projectionSchema = z.object({ schemaVersion: z.literal(PROJECTION_SCHEMA_VERSION), issues: z.record(z.string(), z.object({}).loose()) })

const cursorPath = (stateDir: string): string => join(stateDir, 'ui', 'cursor.json')
const projectionPath = (stateDir: string): string => join(stateDir, 'ui', 'projection.json')
const emptyCursor = (): Cursor => ({ schemaVersion: PROJECTION_SCHEMA_VERSION, lastEventAt: new Date(0).toISOString(), seenAtSameMs: [] })
/** Identifies one event for the same-millisecond tie-break — content, not just type, since two different events
 * of the same type can land in the same millisecond (e.g. two `worker.dispatched` in one tick). */
const eventKey = (event: LoopEvent): string => `${event.type}:${JSON.stringify(event)}`

const runRecordFrom = (run: IssueRun): RunRecord => ({
  id: run.id, attempt: run.attempt, configHash: run.config.configHash, flow: run.config.flow,
  builder: `${run.config.builder.provider}/${run.config.builder.model}`, contractDigest: run.contract.digest,
  maxFixRounds: run.config.maxFixRounds, perIssueTokens: run.config.perIssueTokens, status: run.status, archived: run.archived,
})

const decisionFrom = (request: HitlRequest): Decision => ({
  id: request.requestId, issue: request.issue, title: request.question, message: request.context,
  options: request.options, recommendedOptionId: request.recommendedOptionId, batchId: request.batchId,
  role: request.role, stage: request.stage, digest: request.digest, createdAt: request.createdAt, updatedAt: request.updatedAt,
})

/** Every dispatched-but-unknown issue gets a minimal record from the engine's own current-state files
 * (`dispatch.json`/`delivery.json`, reused via `listDispatched`/`readDeliveryState` — the engine is not
 * rewritten). Runs once, only on the very first sync (no cursor yet): after that the event tail alone keeps
 * every issue current, because `worker.dispatched` and friends are always appended regardless of who triggered
 * the tick. This step only exists to recover an issue whose dispatch predates `events.ndjson`'s own retention
 * window (`tick.ts`'s `EVENTS_RETENTION_MS`, 30 days) — not a per-poll re-scan of the state directory. */
const seedFromEngineState = (state: ProjectionState, stateDir: string): ProjectionState => {
  let next = state
  for (const dispatch of listDispatched(stateDir)) {
    if (next.issues[dispatch.issue]) continue
    const delivery = readDeliveryState(stateDir, dispatch.issue)
    const phase: IssueRecord['phase'] = phaseForDeliveryOutcome(delivery.finalOutcome, 'running')
    const record: IssueRecord = {
      issue: dispatch.issue, title: null, url: null, trackerState: null, phase, reviewState: null, run: null,
      dispatch: {
        branch: dispatch.branch || null, worktree: dispatch.worktree || null, worktreeId: dispatch.worktreeId || null,
        terminal: dispatch.terminal, provider: dispatch.provider || null, model: dispatch.model || null,
        contractDigest: dispatch.contractDigest || null, dispatchedAt: dispatch.dispatchedAt || null,
      },
      pullRequest: delivery.prNumber ? { number: delivery.prNumber, state: delivery.finalOutcome === 'merged' ? 'MERGED' : delivery.finalOutcome === 'abandoned' ? 'CLOSED' : 'OPEN', head: null } : null,
      pendingDecisions: [], error: null, updatedAt: delivery.finishedAt ?? dispatch.dispatchedAt ?? new Date(0).toISOString(),
    }
    next = { issues: { ...next.issues, [dispatch.issue]: record } }
  }
  // GitHub-intake PRs the loop did not dispatch but did pick up via `github.intakeLabel`. They have a record file
  // (`intake.json`) and may have a `delivery.json` after the first review; without seeding, the projection is
  // blind to them until the engine emits a typed event for the same PR.
  for (const intake of listIntake(stateDir)) {
    const identifier = intakeIssueId(intake.pr)
    if (next.issues[identifier]) continue
    const delivery = readDeliveryState(stateDir, identifier)
    const phase: IssueRecord['phase'] = phaseForDeliveryOutcome(delivery.finalOutcome, 'review')
    next = {
      issues: {
        ...next.issues,
        [identifier]: {
          issue: identifier, title: null, url: null, trackerState: null, phase,
          reviewState: delivery.finalOutcome === 'held' ? 'human-approval' : null,
          run: null, dispatch: null,
          pullRequest: { number: intake.pr, state: delivery.finalOutcome === 'merged' ? 'MERGED' : delivery.finalOutcome === 'abandoned' ? 'CLOSED' : 'OPEN', head: null },
          pendingDecisions: [],
          error: delivery.finalOutcome && ['failed', 'blocked', 'stuck'].includes(delivery.finalOutcome) ? delivery.finalOutcome : null,
          updatedAt: delivery.finishedAt ?? intake.addedAt,
        },
      },
    }
  }
  return next
}

/** Engine-state author of truth for an issue's phase. Mirrors the reducer's terminal transitions and the seed mapper,
 * so the reconcile pass and the bootstrap agree on what `merged`/`abandoned`/`blocked`/etc. mean for the UI. */
const phaseForDeliveryOutcome = (outcome: DeliverOutcome | null, fallback: IssueRecord['phase']): IssueRecord['phase'] => {
  if (outcome === 'merged') return 'completed'
  if (outcome === 'abandoned') return 'needs-decision'
  if (outcome === 'blocked' || outcome === 'stuck' || outcome === 'failed') return 'blocked'
  if (outcome === 'needs-input') return 'needs-input'
  return fallback
}

/** Review-state the engine signals directly through `delivery.json`. Only `held` (the human-attestation gate) maps to a
 * non-null sub-status today; CI/review-derived substates come from events. */
const reviewStateForDeliveryOutcome = (outcome: DeliverOutcome | null): IssueRecord['reviewState'] =>
  outcome === 'held' ? 'human-approval' : null

/** Walk every issue's authoritative state file (`delivery.json` under `.ak-loop/issues/<id>/`) and force the
 * projection to agree. The reducer is a stream fold over events; this is the spot where the engine's actual
 * terminal decisions override whatever the events said (or did not say). Catches the gap that left the control
 * plane stuck at `running` after a merge performed outside the loop, and any other "event missed / event never
 * emitted" case that the engine itself already settled. */
const reconcileAgainstEngineState = (state: ProjectionState, stateDir: string): ProjectionState => {
  const issuesDir = join(stateDir, 'issues')
  if (!existsSync(issuesDir)) return state
  const known = new Set<string>([...Object.keys(state.issues), ...listDispatched(stateDir).map((dispatch) => dispatch.issue), ...listIntake(stateDir).map((intake) => intakeIssueId(intake.pr))])
  let next = state
  for (const issue of known) {
    const delivery = readDeliveryState(stateDir, issue)
    if (!delivery.finishedAt || !delivery.finalOutcome) continue
    const enginePhase = phaseForDeliveryOutcome(delivery.finalOutcome, 'review')
    const engineReviewState = reviewStateForDeliveryOutcome(delivery.finalOutcome)
    const record = next.issues[issue] ?? { issue, title: null, url: null, trackerState: null, phase: 'available' as const, reviewState: null, run: null, dispatch: null, pullRequest: null, pendingDecisions: [], error: null, updatedAt: new Date(0).toISOString() }
    const phaseMatches = record.phase === enginePhase
    const reviewMatches = (record.reviewState ?? null) === (engineReviewState ?? null)
    if (phaseMatches && reviewMatches) continue
    next = {
      issues: {
        ...next.issues,
        [issue]: {
          ...record,
          phase: enginePhase,
          reviewState: engineReviewState,
          pullRequest: delivery.prNumber
            ? { number: delivery.prNumber, state: delivery.finalOutcome === 'merged' ? 'MERGED' : delivery.finalOutcome === 'abandoned' ? 'CLOSED' : record.pullRequest?.state ?? 'OPEN', head: record.pullRequest?.head ?? null }
            : record.pullRequest,
          error: enginePhase === 'blocked' ? delivery.finalOutcome && ['failed', 'blocked', 'stuck'].includes(delivery.finalOutcome) ? delivery.finalOutcome : record.error : record.error,
          updatedAt: delivery.finishedAt ?? record.updatedAt,
        },
      },
    }
  }
  return next
}

/** Reads `queue.ts`/`hitl.ts` live and overlays them onto every issue the reducer knows about, plus any issue
 * that only exists in one of those two stores so far (a run enqueued, or a worker HITL materialized, before its
 * next event landed). */
const overlayLiveStores = (state: ProjectionState, stateDir: string): ProjectionState => {
  const runsByIssue = new Map(createIssueQueue({ stateDir }).list().map((run) => [run.issue, run]))
  const openHitl = createHitlStore(stateDir).list({ status: 'open' })
  const decisionsByIssue = new Map<string, Decision[]>()
  for (const request of openHitl) { const list = decisionsByIssue.get(request.issue) ?? []; list.push(decisionFrom(request)); decisionsByIssue.set(request.issue, list) }

  const issues = new Set([...Object.keys(state.issues), ...runsByIssue.keys(), ...decisionsByIssue.keys()])
  const merged: Record<string, IssueRecord> = {}
  for (const issue of issues) {
    const record = state.issues[issue] ?? { issue, title: null, url: null, trackerState: null, phase: 'available', reviewState: null, run: null, dispatch: null, pullRequest: null, pendingDecisions: [], error: null, updatedAt: new Date(0).toISOString() }
    const latestRun = runsByIssue.get(issue)
    const live = overlayLiveState(record, latestRun ? runRecordFrom(latestRun) : null, decisionsByIssue.get(issue) ?? [])
    merged[issue] = record.dispatch || record.pullRequest ? { ...live, fixRoundsUsed: readDeliveryState(stateDir, issue).fixRounds } : live
  }
  return { issues: merged }
}

const readCursor = (stateDir: string): { readonly cursor: Cursor; readonly isFirstSync: boolean } => {
  const parsed = readJsonFile(cursorPath(stateDir), cursorSchema)
  return parsed ? { cursor: parsed, isFirstSync: false } : { cursor: emptyCursor(), isFirstSync: true }
}

const readProjection = (stateDir: string): ProjectionState => {
  const parsed = readJsonFile(projectionPath(stateDir), projectionSchema)
  return parsed ? { issues: parsed.issues as unknown as Record<string, IssueRecord> } : emptyProjection()
}

/** Read-only: today's projection without pulling in new events, live-overlaid with the current `queue.ts`/
 * `hitl.ts` state. For a request handler that just wants the current picture; `syncProjection` is what actually
 * advances the cursor and should own the poll loop. */
export const readCurrentProjection = (stateDir: string): ProjectionState => overlayLiveStores(readProjection(stateDir), stateDir)

/**
 * Pull every loop event newer than the cursor into the projection, in order, persist the result, and return it
 * live-overlaid. Idempotent past the cursor and safe across a process restart: on restart this rereads
 * `projection.json` + `cursor.json` and continues exactly where it left off, instead of recomputing the world
 * from several stores with regex guesses the way the old `createUiSnapshot` did on every single poll.
 */
export const syncProjection = (stateDir: string): ProjectionState => {
  const { cursor, isFirstSync } = readCursor(stateDir)
  let state = readProjection(stateDir)
  if (isFirstSync) state = seedFromEngineState(state, stateDir)

  const sinceMs = Date.parse(cursor.lastEventAt)
  const seenAtSameMs = new Set(cursor.seenAtSameMs)
  const fresh = readLoopEvents(stateDir, sinceMs)
    .filter((event) => {
      const eventMs = Date.parse(event.at)
      if (!Number.isFinite(eventMs) || eventMs < sinceMs) return false
      if (eventMs === sinceMs && seenAtSameMs.has(eventKey(event))) return false
      return true
    })
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))

  for (const event of fresh) state = reduce(state, event)
  // Engine-state reconciliation: any divergence between the reducer's last fold and `delivery.json` is resolved
  // in favour of the engine. Cheap (one stat per known issue per sync) and idempotent. Runs on every sync, not
  // only on first sync, so a missed event cannot leave a stale phase.
  state = reconcileAgainstEngineState(state, stateDir)

  const lastAt = fresh.at(-1)?.at ?? cursor.lastEventAt
  const lastAtMs = Date.parse(lastAt)
  const nextCursor: Cursor = { schemaVersion: PROJECTION_SCHEMA_VERSION, lastEventAt: lastAt, seenAtSameMs: fresh.filter((event) => Date.parse(event.at) === lastAtMs).map(eventKey) }

  writeJsonAtomic(projectionPath(stateDir), { schemaVersion: PROJECTION_SCHEMA_VERSION, issues: state.issues })
  writeJsonAtomic(cursorPath(stateDir), nextCursor)
  return overlayLiveStores(state, stateDir)
}
