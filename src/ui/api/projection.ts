import type { LoopEvent } from '../../loop/retro.js'

/**
 * The projection of "what is happening with an issue" that drives the control plane's UI.
 *
 * `queue.ts` (`IssueRun`) and `hitl.ts` (`HitlRequest`) are not reinvented here — both are real engine
 * integration points (`config.queue.mode: 'explicit'` reads `queue.ts` directly as its dispatch source;
 * `deliver.ts`'s `materializeWorkerHitl` reads `hitl.ts`'s file state back to know a worker's own question was
 * answered) that `tick.ts`/`deliver.ts` import directly — reimplementing their state via events would either
 * diverge from the engine's own copy or require rewriting the engine, both out of scope. `store.ts` reads them
 * live and overlays them onto `IssueRecord.run`/`pendingDecisions` at snapshot time, the same way it already
 * overlays board metadata.
 *
 * What genuinely had no other authoritative source — `phase` and `reviewState`, the exact thing the old
 * `lifecycle.ts` guessed with regex over free event text — is what this file's pure reducer derives, from the
 * typed fields the event vocabulary already declares (`pr.reviewed.status`, `worker.${outcome}`), never text.
 */

export type IssuePhase = 'available' | 'running' | 'review' | 'needs-input' | 'needs-decision' | 'blocked' | 'completed'
/** `null` means "in review, no specific signal yet" — deliberately not guessed from unstructured event text
 * the way the old `lifecycle.ts` did; a substatus only appears once a typed event actually says so. */
export type ReviewSubstatus = 'ci-failed' | 'review-pending' | 'changes-requested' | 'human-approval' | 'ready-to-merge'
export type RunStatus = 'queued' | 'dispatching' | 'running' | 'needs-input' | 'blocked' | 'failed' | 'completed' | 'cancelled'

/** A live projection of `queue.ts`'s `IssueRun` for this issue — overlaid by `store.ts`, never built by the
 * reducer. `null` for an issue the engine dispatched on its own (a scheduled tick, nobody used the wizard). */
export interface RunRecord {
  readonly id: string
  readonly attempt: number
  readonly configHash: string
  readonly flow: string | null
  readonly builder: string
  readonly contractDigest: string
  readonly maxFixRounds: number
  readonly perIssueTokens: number
  readonly status: RunStatus
  readonly archived: boolean
}

/** What the engine's own `worker.dispatched` reported, regardless of who triggered the tick that dispatched it. */
export interface DispatchRef {
  readonly branch: string | null
  readonly worktree: string | null
  readonly worktreeId: string | null
  readonly terminal: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly contractDigest: string | null
  readonly dispatchedAt: string | null
}

export interface PullRequestRef {
  readonly number: number
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED'
  readonly head: string | null
}

export interface DecisionOption { readonly id: string; readonly title: string; readonly description: string }

/** A live projection of one of `hitl.ts`'s open `HitlRequest`s — overlaid by `store.ts`, never built by the
 * reducer (`hitl.ts` is the answer-side source of truth too: `deliver.ts` reads it back directly to learn a
 * worker's own question was answered, so this UI writing anywhere else would not be seen by the engine). */
export interface Decision {
  readonly id: string
  readonly issue: string
  readonly title: string
  readonly message: string
  readonly options: readonly DecisionOption[]
  readonly recommendedOptionId: string | null
  readonly batchId: string
  readonly role: string
  readonly stage: string
  readonly digest: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface IssueRecord {
  readonly issue: string
  readonly title: string | null
  readonly url: string | null
  readonly trackerState: string | null
  readonly phase: IssuePhase
  readonly reviewState: ReviewSubstatus | null
  readonly run: RunRecord | null
  readonly dispatch: DispatchRef | null
  readonly pullRequest: PullRequestRef | null
  readonly pendingDecisions: readonly Decision[]
  readonly error: string | null
  readonly updatedAt: string
}

export interface ProjectionState {
  readonly issues: Readonly<Record<string, IssueRecord>>
}

export const emptyProjection = (): ProjectionState => ({ issues: {} })

const strOrNull = (value: unknown): string | null => typeof value === 'string' && value ? value : null
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

const blankRecord = (issue: string, at: string): IssueRecord => ({
  issue, title: null, url: null, trackerState: null, phase: 'available', reviewState: null,
  run: null, dispatch: null, pullRequest: null, pendingDecisions: [], error: null, updatedAt: at,
})

const withIssue = (state: ProjectionState, issue: string, at: string, update: (record: IssueRecord) => IssueRecord): ProjectionState => {
  const current = state.issues[issue] ?? blankRecord(issue, at)
  return { issues: { ...state.issues, [issue]: { ...update(current), updatedAt: at } } }
}

const pullRequestFrom = (record: IssueRecord, event: LoopEvent, prState: PullRequestRef['state']): PullRequestRef | null => {
  const number = num(event['pr'])
  if (number === null) return record.pullRequest
  return { number, state: prState, head: strOrNull(event['head']) ?? record.pullRequest?.head ?? null }
}

/**
 * The one place the issue's UI-facing phase/review-state is derived from the loop's own event log — replaces
 * regex guesses over free event text (the old `lifecycle.ts`) with direct reads of the typed fields the
 * vocabulary already declares. Pure: same inputs, same output, no IO, no clock. Never touches `run` or
 * `pendingDecisions` — `store.ts` overlays both from `queue.ts`/`hitl.ts` after every fold.
 */
export const reduce = (state: ProjectionState, event: LoopEvent): ProjectionState => {
  // Two ways an event names the issue it is about: most carry `issue` directly; the `github-intake.*` family and a
  // few `pr.reviewed` emissions for intake PRs carry `pr` instead — these are tracked under `pr-<n>`, the same id
  // `intakeIssueId(pr)` produces. Falling back to `pr` here is what makes the projection finally see GitHub-intake
  // PRs instead of silently dropping every event for them.
  const issueFromEvent = typeof event.issue === 'string' && event.issue
    ? event.issue
    : typeof event['pr'] === 'number'
      ? `pr-${event['pr']}`
      : null
  if (!issueFromEvent) return state
  const issue = issueFromEvent
  const at = event.at

  switch (event.type) {
    // Emitted both for a fresh wizard confirmation and for a retry — both mean "a new attempt is queued."
    case 'ui.run-enqueued':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'running', error: null, dispatch: null }))
    case 'worker.dispatched':
      return withIssue(state, issue, at, (record) => ({
        ...record, phase: 'running',
        dispatch: {
          branch: strOrNull(event['branch']), worktree: strOrNull(event['worktree']), worktreeId: strOrNull(event['worktreeId']),
          terminal: strOrNull(event['terminal']), provider: strOrNull(event['provider']), model: strOrNull(event['model']),
          contractDigest: strOrNull(event['contractDigest']), dispatchedAt: at,
        },
      }))
    case 'worker.dispatch-failed':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'available', error: strOrNull(event['error']) ?? record.error }))
    case 'worker.merged':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'completed' }))
    case 'worker.held':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review', reviewState: 'human-approval' }))
    case 'worker.blocked':
    case 'worker.stuck':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'blocked', error: strOrNull(event['reason']) ?? record.error }))
    case 'worker.abandoned':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'needs-decision' }))
    case 'worker.failed':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'blocked', error: strOrNull(event['reason']) ?? record.error }))
    case 'worker.waiting':
    case 'worker.reviewed':
    case 'worker.fix-round':
    case 'worker.nudged':
    case 'worker.handed-off':
    case 'worker.needs-input':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review' }))
    case 'worker.ci-round':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review', reviewState: 'ci-failed', pullRequest: pullRequestFrom(record, event, 'OPEN') }))
    case 'worker.review-round':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review', reviewState: 'changes-requested', pullRequest: pullRequestFrom(record, event, 'OPEN') }))
    case 'worker.conflict-round':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review', pullRequest: pullRequestFrom(record, event, 'OPEN') }))
    case 'pr.reviewed': {
      const status = event['status']
      const reviewState: ReviewSubstatus | null = status === 'clean' ? 'ready-to-merge' : status === 'findings' ? 'changes-requested' : status === 'incomplete' ? 'review-pending' : null
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review', reviewState: reviewState ?? record.reviewState, pullRequest: pullRequestFrom(record, event, 'OPEN') }))
    }
    case 'pr.merged':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'completed', pullRequest: pullRequestFrom(record, event, 'MERGED') }))
    case 'pr.closed':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'needs-decision', pullRequest: pullRequestFrom(record, event, 'CLOSED') }))
    case 'pr.merge-refused':
      return withIssue(state, issue, at, (record) => ({ ...record, error: strOrNull(event['message']) ?? record.error }))
    case 'pr.human-approved':
      return withIssue(state, issue, at, (record) => ({ ...record, reviewState: 'ready-to-merge' }))
    case 'contract.failed':
    case 'plan.failed':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'available', error: strOrNull(event['error']) ?? record.error }))
    case 'contract.escalated': {
      // A companion `human.hitl-requested` follows in the same tick when the escalation is answerable, and
      // pushes the phase on to `needs-input` right after this — see the store-level merge for that rule. When
      // none follows (no executable outcome at all, nothing to ask), this is the phase that sticks.
      const reasons = Array.isArray(event['reasons']) ? event['reasons'].filter((reason): reason is string => typeof reason === 'string').join('; ') : null
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'blocked', error: reasons ?? record.error }))
    }
    case 'plan.escalated': {
      const unresolved = Array.isArray(event['unresolved']) ? event['unresolved'].filter((reason): reason is string => typeof reason === 'string').join('; ') : null
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'blocked', error: unresolved ?? record.error }))
    }
    case 'issue.paused':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'blocked', error: strOrNull(event['reason']) ?? record.error }))
    case 'queue.claim-failed':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'available', error: strOrNull(event['error']) ?? record.error }))
    case 'ui.cleanup-completed':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'available', dispatch: null }))
    case 'ui.cleanup-failed':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'blocked', error: strOrNull(event['detail']) ?? record.error }))
    case 'ui.issue-decided':
      return withIssue(state, issue, at, (record) => event['action'] === 'close-issue'
        ? { ...record, phase: 'completed', error: null }
        : { ...record, phase: 'available', error: null, dispatch: null })
    // GitHub-intake PRs the loop did not dispatch, but reviews and (sometimes) holds. Terminals map to the same
    // phases as their dispatched counterparts; `pr-<n>` is the issue id (see `issueFromEvent` above). `pr.reviewed`
    // emitted from `handleIntakePullRequest` carries `pr` rather than `issue`, so it lands here too.
    case 'github-intake.merged': {
      const prNumber = num(event['pr'])
      return withIssue(state, issue, at, (record) => ({
        ...record,
        phase: 'completed',
        pullRequest: prNumber === null ? record.pullRequest : { number: prNumber, state: 'MERGED', head: record.pullRequest?.head ?? null },
      }))
    }
    case 'github-intake.held':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review', reviewState: 'human-approval' }))
    case 'github-intake.blocked':
    case 'github-intake.failed':
    case 'github-intake.stuck':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'blocked', error: strOrNull(event['reason']) ?? record.error }))
    case 'github-intake.abandoned':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'needs-decision', error: strOrNull(event['reason']) ?? record.error }))
    case 'github-intake.needs-input':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'needs-input' }))
    case 'github-intake.waiting':
    case 'github-intake.reviewed':
    case 'github-intake.nudged':
    case 'github-intake.handed-off':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review' }))
    case 'github-intake.fix-round':
      return withIssue(state, issue, at, (record) => ({ ...record, phase: 'review', reviewState: 'changes-requested' }))
    default:
      return state
  }
}

/** Board metadata (title/url/tracker state) is not carried by loop events — it comes from the remote tracker via
 * `board.ts`. Applied separately from `reduce` so the pure reducer never needs a board snapshot as an input. */
export const applyBoardMetadata = (state: ProjectionState, issue: string, meta: { readonly title: string; readonly url: string; readonly trackerState: string }): ProjectionState =>
  withIssue(state, issue, state.issues[issue]?.updatedAt ?? new Date(0).toISOString(), (record) => ({ ...record, title: meta.title, url: meta.url, trackerState: meta.trackerState }))

/**
 * Overlays a live read of `queue.ts`/`hitl.ts` onto one issue's reduced state, and reconciles the one place they
 * disagree with the pure reducer's own guess: an issue with an open decision and no dispatch yet is
 * `needs-input`, whichever the reducer landed on (mirrors the old `materializeContractHitl`/`materializePlanHitl`
 * rule that a HITL request blocks dispatch until answered).
 */
export const overlayLiveState = (record: IssueRecord, run: RunRecord | null, pendingDecisions: readonly Decision[]): IssueRecord => ({
  ...record, run, pendingDecisions,
  phase: pendingDecisions.length > 0 && record.dispatch === null ? 'needs-input' : record.phase,
})
