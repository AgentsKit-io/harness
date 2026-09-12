import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One recorded failure for an issue, kept for diagnostics (`loop retro`, `loop status`). */
export interface IssueFailureRecord {
  readonly kind: string
  readonly at: string
  readonly reason: string
}

export interface IssueFailureState {
  readonly issue: string
  /** Consecutive failures since the last success (dispatch, clean/findings review, merge). Resets to 0 on any of those. */
  readonly consecutive: number
  /** Most recent failures first, capped at 10 — enough for a human to see the pattern without the file growing unbounded. */
  readonly history: readonly IssueFailureRecord[]
  readonly pausedAt: string | null
  readonly pausedReason: string | null
}

const emptyIssueState = (issue: string): IssueFailureState => ({ issue, consecutive: 0, history: [], pausedAt: null, pausedReason: null })

export const issueFailurePath = (stateDir: string, issue: string): string => join(stateDir, 'issues', issue, 'failures.json')

export const readIssueFailures = (stateDir: string, issue: string): IssueFailureState => {
  const path = issueFailurePath(stateDir, issue)
  if (!existsSync(path)) return emptyIssueState(issue)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IssueFailureState>
    return { ...emptyIssueState(issue), ...parsed, issue }
  } catch { return emptyIssueState(issue) }
}

const writeIssueFailures = (stateDir: string, state: IssueFailureState): void => {
  const path = issueFailurePath(stateDir, state.issue)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Record one failure for an issue and return the updated state. Callers decide, from `consecutive`, whether the
 * `maxConsecutiveFailures` threshold was just crossed and the issue should be paused (see `pauseIssue`).
 */
export const recordIssueFailure = (stateDir: string, issue: string, kind: string, reason: string, now: Date = new Date()): IssueFailureState => {
  const current = readIssueFailures(stateDir, issue)
  const next: IssueFailureState = {
    issue,
    consecutive: current.consecutive + 1,
    history: [{ kind, at: now.toISOString(), reason: reason.slice(0, 300) }, ...current.history].slice(0, 10),
    pausedAt: current.pausedAt,
    pausedReason: current.pausedReason,
  }
  writeIssueFailures(stateDir, next)
  return next
}

/** Clear the consecutive-failure counter (and any pause) after progress: a successful dispatch, a clean/findings review, or a merge. */
export const clearIssueFailures = (stateDir: string, issue: string): void => {
  const current = readIssueFailures(stateDir, issue)
  if (current.consecutive === 0 && current.pausedAt === null && current.history.length === 0) return
  writeIssueFailures(stateDir, { ...emptyIssueState(issue), history: current.history })
}

export const pauseIssue = (stateDir: string, issue: string, reason: string, now: Date = new Date()): IssueFailureState => {
  const current = readIssueFailures(stateDir, issue)
  const next: IssueFailureState = { ...current, pausedAt: now.toISOString(), pausedReason: reason }
  writeIssueFailures(stateDir, next)
  return next
}

/** Manual or label-driven resume: clears the pause and the counter so the issue gets a clean slate; history is kept. */
export const resumeIssue = (stateDir: string, issue: string): IssueFailureState => {
  const current = readIssueFailures(stateDir, issue)
  const next = { ...emptyIssueState(issue), history: current.history }
  writeIssueFailures(stateDir, next)
  return next
}

export const isIssuePaused = (stateDir: string, issue: string): boolean => readIssueFailures(stateDir, issue).pausedAt !== null

/** All paused issues under `<stateDir>/issues/*\/failures.json`, for `loop status`/`loop retro`. */
export const listPausedIssues = (stateDir: string): readonly IssueFailureState[] => {
  const dir = join(stateDir, 'issues')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readIssueFailures(stateDir, entry.name))
    .filter((state) => state.pausedAt !== null)
}

// ---------------------------------------------------------------------------------------------------------------
// Stage-level pause: protects the machine when a scheduled `loop stage <tick|deliver>` run throws (config error,
// unhandled adapter failure) rather than returning a report — a crash loop under Orca's automation otherwise
// retries every `schedule.tick`/`schedule.deliver` interval forever with nothing but the Orca run log to notice it.
// ---------------------------------------------------------------------------------------------------------------

export type LoopStageName = 'tick' | 'deliver'

export interface StagePauseEntry {
  readonly consecutiveFailures: number
  readonly lastFailureAt: string | null
  readonly lastReason: string | null
  readonly pausedAt: string | null
  readonly pausedReason: string | null
}

export type StagePauseState = Partial<Record<LoopStageName, StagePauseEntry>>

const emptyStageEntry: StagePauseEntry = { consecutiveFailures: 0, lastFailureAt: null, lastReason: null, pausedAt: null, pausedReason: null }

export const stagePausePath = (stateDir: string): string => join(stateDir, 'paused.json')

export const readStagePause = (stateDir: string): StagePauseState => {
  const path = stagePausePath(stateDir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as StagePauseState : {}
  } catch { return {} }
}

const writeStagePause = (stateDir: string, state: StagePauseState): void => {
  const path = stagePausePath(stateDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export const stageEntry = (stateDir: string, stage: LoopStageName): StagePauseEntry => readStagePause(stateDir)[stage] ?? emptyStageEntry
export const isStagePaused = (stateDir: string, stage: LoopStageName): boolean => stageEntry(stateDir, stage).pausedAt !== null

/**
 * Record the outcome of one `loop stage` run. A thrown exception is a failure; anything that returns a report
 * (including an idle/no-op tick) is a success and clears both the counter and any existing pause. Crossing
 * `threshold` consecutive failures pauses the stage; the caller (`loop stage`) checks `isStagePaused` up front and
 * skips the actual run while paused, so a crash loop cannot spend budget or provider usage.
 */
export const recordStageRunResult = (stateDir: string, stage: LoopStageName, outcome: { readonly succeeded: true } | { readonly succeeded: false; readonly reason: string }, threshold: number, now: Date = new Date()): StagePauseEntry => {
  const state = readStagePause(stateDir)
  if (outcome.succeeded) {
    const { [stage]: _removed, ...rest } = state
    writeStagePause(stateDir, rest)
    return emptyStageEntry
  }
  const current = state[stage] ?? emptyStageEntry
  const consecutiveFailures = current.consecutiveFailures + 1
  const entry: StagePauseEntry = {
    consecutiveFailures,
    lastFailureAt: now.toISOString(),
    lastReason: outcome.reason.slice(0, 300),
    pausedAt: consecutiveFailures >= threshold ? current.pausedAt ?? now.toISOString() : null,
    pausedReason: consecutiveFailures >= threshold ? outcome.reason.slice(0, 300) : null,
  }
  writeStagePause(stateDir, { ...state, [stage]: entry })
  return entry
}

export const resumeStage = (stateDir: string, stage: LoopStageName): void => {
  const state = readStagePause(stateDir)
  const { [stage]: _removed, ...rest } = state
  writeStagePause(stateDir, rest)
}
