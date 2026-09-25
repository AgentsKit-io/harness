import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HarnessError } from '../kernel/errors.js'
import { writeJsonAtomic } from './fs-atomic.js'

/** The issue lifecycle is separate from an execution attempt: a PR can outlive its run. */
export const ISSUE_LIFECYCLE_SCHEMA_VERSION = 1 as const

export type LifecyclePhase = 'available' | 'running' | 'review' | 'needs-input' | 'needs-decision' | 'blocked' | 'completed'
export type ReviewSubstatus = 'pr-open' | 'ci-pending' | 'ci-failed' | 'review-pending' | 'changes-requested' | 'human-approval' | 'ready-to-merge'

export interface LifecyclePullRequest {
  readonly number: number
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED'
  readonly url?: string | null
  readonly head?: string | null
}

export interface IssueLifecycle {
  readonly schemaVersion: typeof ISSUE_LIFECYCLE_SCHEMA_VERSION
  readonly issue: string
  readonly title: string | null
  readonly url: string | null
  readonly phase: LifecyclePhase
  readonly reviewState: ReviewSubstatus | null
  readonly runId: string | null
  readonly pullRequest: LifecyclePullRequest | null
  readonly error: string | null
  readonly action: 'configure' | 'retry' | 'resume' | 'close-or-reopen' | 'inspect' | null
  readonly updatedAt: string
  readonly trackerState: string | null
}

export interface LifecycleReconcileInput {
  readonly issue: string
  readonly phase?: LifecyclePhase
  readonly title?: string | null
  readonly url?: string | null
  readonly runId?: string | null
  readonly runStatus?: string | null
  readonly stage?: string | null
  readonly deliveryOutcome?: string | null
  readonly pullRequest?: LifecyclePullRequest | null
  readonly reviewState?: ReviewSubstatus | null
  readonly error?: string | null
  readonly trackerState?: string | null
  readonly technicalFailure?: boolean
  readonly finalFailure?: boolean
  readonly events?: readonly LifecycleEvent[]
  readonly now?: Date
}

export interface LifecycleEvent {
  readonly type: string
  readonly at?: string
  readonly reason?: string
  readonly error?: string
  readonly message?: string
  readonly status?: string
  readonly [key: string]: unknown
}

export interface LifecycleStore {
  readonly list: () => readonly IssueLifecycle[]
  readonly get: (issue: string) => IssueLifecycle | null
  readonly upsert: (input: LifecycleReconcileInput) => IssueLifecycle
  readonly reconcile: (inputs: readonly LifecycleReconcileInput[]) => readonly IssueLifecycle[]
}

const lifecycleSchema = z.object({
  schemaVersion: z.literal(ISSUE_LIFECYCLE_SCHEMA_VERSION), issue: z.string().min(1), title: z.string().nullable(), url: z.string().nullable(),
  phase: z.enum(['available', 'running', 'review', 'needs-input', 'needs-decision', 'blocked', 'completed']), reviewState: z.enum(['pr-open', 'ci-pending', 'ci-failed', 'review-pending', 'changes-requested', 'human-approval', 'ready-to-merge']).nullable(),
  runId: z.string().nullable(), pullRequest: z.object({ number: z.number().int().positive(), state: z.enum(['OPEN', 'CLOSED', 'MERGED']), url: z.string().nullable().optional(), head: z.string().nullable().optional() }).nullable(),
  error: z.string().nullable(), action: z.enum(['configure', 'retry', 'resume', 'close-or-reopen', 'inspect']).nullable(), updatedAt: z.string(), trackerState: z.string().nullable(),
})
const stateSchema = z.object({ schemaVersion: z.literal(ISSUE_LIFECYCLE_SCHEMA_VERSION), issues: z.array(lifecycleSchema) })
type LifecycleState = { readonly schemaVersion: typeof ISSUE_LIFECYCLE_SCHEMA_VERSION; readonly issues: readonly IssueLifecycle[] }

const pathFor = (stateDir: string): string => join(stateDir, 'lifecycle.json')
const lockFor = (stateDir: string): string => join(stateDir, 'lifecycle.lock')
const emptyState = (): LifecycleState => ({ schemaVersion: ISSUE_LIFECYCLE_SCHEMA_VERSION, issues: [] })
const textOf = (event: LifecycleEvent): string => `${event.reason ?? event.error ?? event.message ?? event.status ?? event.type}`.toLowerCase()

const reviewStateFor = (input: LifecycleReconcileInput, previous: IssueLifecycle | null): ReviewSubstatus | null => {
  if (input.reviewState !== undefined) return input.reviewState
  if (input.pullRequest?.state !== 'OPEN' && previous?.phase !== 'review') return null
  const events = [...(input.events ?? [])].sort((left, right) => Date.parse(right.at ?? '') - Date.parse(left.at ?? ''))
  const review = events.find((event) => event.type === 'pr.reviewed' && typeof event.status === 'string')
  if (review?.status === 'clean') return 'ready-to-merge'
  if (review?.status === 'findings') return 'changes-requested'
  if (review?.status === 'incomplete') return 'review-pending'
  if (events.some((event) => event.type === 'worker.held')) return 'human-approval'
  if (events.some((event) => event.type === 'pr.merge-refused' || event.type === 'pr.human-approval-required')) return 'human-approval'
  const text = events.map(textOf).join(' ')
  if (/ci|check/.test(text) && /fail|red|error/.test(text)) return 'ci-failed'
  if (/check|ci/.test(text) && /pending|wait|missing/.test(text)) return 'ci-pending'
  if (/change|finding|requested/.test(text)) return 'changes-requested'
  if (/human|approval|approve/.test(text)) return 'human-approval'
  if (/ready|merge/.test(text) && !/refused|not/.test(text)) return 'ready-to-merge'
  if (input.pullRequest?.state === 'OPEN' && input.stage === 'pr-open') return 'pr-open'
  return previous?.reviewState ?? 'review-pending'
}

const phaseFor = (input: LifecycleReconcileInput, previous: IssueLifecycle | null): LifecyclePhase => {
  if (input.phase) return input.phase
  if (input.stage === 'closed') return 'completed'
  if (input.stage === 'reopened') return 'available'
  if (input.technicalFailure || ['failed', 'cancelled'].includes(input.runStatus ?? '')) return 'available'
  if (input.finalFailure || ['blocked', 'stuck'].includes(input.deliveryOutcome ?? '')) return 'blocked'
  if (input.pullRequest?.state === 'MERGED' || input.deliveryOutcome === 'merged') return 'completed'
  if (input.pullRequest?.state === 'CLOSED' || input.deliveryOutcome === 'abandoned' || input.stage === 'pr-closed') return 'needs-decision'
  if (input.pullRequest?.state === 'OPEN' || input.stage === 'pr-open' || ['waiting', 'reviewed', 'fix-round', 'nudged', 'held'].includes(input.deliveryOutcome ?? '') || previous?.phase === 'review' && input.runStatus === 'completed') return 'review'
  if (input.runStatus === 'needs-input') return input.finalFailure ? 'blocked' : 'needs-input'
  if (['queued', 'dispatching', 'running'].includes(input.runStatus ?? '') || input.stage === 'running') return 'running'
  if (input.stage === 'available') return 'available'
  return previous?.phase ?? 'available'
}

const actionFor = (phase: LifecyclePhase, error: string | null): IssueLifecycle['action'] => phase === 'available' ? (error ? 'retry' : 'configure') : phase === 'needs-input' ? 'resume' : phase === 'needs-decision' ? 'close-or-reopen' : phase === 'blocked' ? 'retry' : phase === 'review' && error ? 'retry' : phase === 'completed' ? null : 'inspect'

/** Pure issue projection. The previous record lets a later delivery tick retain PR identity and evidence. */
export const projectLifecycle = (input: LifecycleReconcileInput, previous: IssueLifecycle | null = null): IssueLifecycle => {
  const phase = phaseFor(input, previous)
  const pullRequest = input.pullRequest === undefined ? previous?.pullRequest ?? null : input.pullRequest
  const error = input.error === undefined ? previous?.error ?? null : input.error
  return {
    schemaVersion: ISSUE_LIFECYCLE_SCHEMA_VERSION,
    issue: input.issue,
    title: input.title === undefined ? previous?.title ?? null : input.title,
    url: input.url === undefined ? previous?.url ?? null : input.url,
    phase,
    reviewState: phase === 'review' ? reviewStateFor(input, previous) : null,
    runId: input.runId === undefined ? previous?.runId ?? null : input.runId,
    pullRequest,
    error: phase === 'available' || phase === 'blocked' || phase === 'review' || phase === 'needs-input' ? error : null,
    action: actionFor(phase, error),
    updatedAt: (input.now ?? new Date()).toISOString(),
    trackerState: input.trackerState === undefined ? previous?.trackerState ?? null : input.trackerState,
  }
}

const readState = (path: string): LifecycleState => {
  if (!existsSync(path)) return emptyState()
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    if (!parsed.success) throw new HarnessError(`Invalid lifecycle state at ${path}.`, 'INVALID_STATE')
    return parsed.data as LifecycleState
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new HarnessError(`Invalid lifecycle state at ${path}: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_STATE')
  }
}

const withLock = <T>(stateDir: string, action: () => T): T => {
  const path = lockFor(stateDir); let fd: number
  try { fd = openSync(path, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (Date.now() - statSync(path).mtimeMs <= 30_000) throw new HarnessError('Lifecycle projection is being updated by another process.', 'ACTIVE_RUN')
    unlinkSync(path); fd = openSync(path, 'wx')
  }
  try { return action() } finally { try { closeSync(fd) } catch { /* already closed */ } try { unlinkSync(path) } catch { /* already removed */ } }
}

/** Durable issue projection. Reconciliation only writes local state; it never dispatches or mutates a tracker. */
export const createLifecycleStore = (stateDir: string): LifecycleStore => {
  mkdirSync(stateDir, { recursive: true }); const path = pathFor(stateDir); let state = readState(path)
  const refresh = (): LifecycleState => { state = readState(path); return state }
  const persist = (next: LifecycleState): void => { state = next; writeJsonAtomic(path, next) }
  const list = (): readonly IssueLifecycle[] => refresh().issues.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const get = (issue: string): IssueLifecycle | null => refresh().issues.find((candidate) => candidate.issue === issue) ?? null
  const upsert = (input: LifecycleReconcileInput): IssueLifecycle => withLock(stateDir, () => {
    const current = refresh(); const previous = current.issues.find((candidate) => candidate.issue === input.issue) ?? null; const next = projectLifecycle(input, previous)
    persist({ schemaVersion: ISSUE_LIFECYCLE_SCHEMA_VERSION, issues: current.issues.some((candidate) => candidate.issue === input.issue) ? current.issues.map((candidate) => candidate.issue === input.issue ? next : candidate) : [...current.issues, next] }); return next
  })
  const reconcile = (inputs: readonly LifecycleReconcileInput[]): readonly IssueLifecycle[] => inputs.map(upsert)
  return { list, get, upsert, reconcile }
}

/** Reconcile a bounded set of observations after a restart; legacy observations never cause a new run. */
export const reconcileLifecycle = (input: { readonly stateDir: string; readonly signals: readonly LifecycleReconcileInput[] }): readonly IssueLifecycle[] => createLifecycleStore(input.stateDir).reconcile(input.signals)
export const lifecyclePath = pathFor
