import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { fail, HarnessError } from '../kernel/errors.js'
import { writeJsonAtomic } from './fs-atomic.js'
import type { ModelReference } from './config.js'

/** The queue is deliberately a small durable state machine shared by UI, CLI and scheduled ticks. */
export const ISSUE_QUEUE_SCHEMA_VERSION = 3 as const

export type IssueRunStatus = 'queued' | 'dispatching' | 'running' | 'needs-input' | 'blocked' | 'failed' | 'completed' | 'cancelled'

export interface IssueRunConfigSnapshot {
  readonly configHash: string
  readonly flow: string | null
  readonly builder: ModelReference
  readonly maxFixRounds: number
  readonly perIssueTokens: number
  /** The builder override is the only model override. These roles stay project-owned. */
  readonly roles: { readonly orchestrator: 'project'; readonly reviewer: 'project'; readonly watcher: 'project'; readonly delivery: 'snapshot' }
}

export interface IssueRunContractSnapshot {
  readonly digest: string
  readonly status: 'valid'
  readonly frozenAt: string
}

export interface IssueRunPreflightSnapshot {
  readonly status: 'passed'
  readonly checkedAt: string
  readonly capacity?: { readonly free: number; readonly max: number }
}

export interface IssueRunProjection {
  readonly stage: string
  readonly branch: string | null
  readonly worktree: string | null
  readonly terminal: string | null
  readonly pullRequest: number | null
  readonly evidence: readonly string[]
  readonly timeline: readonly { readonly at: string; readonly stage: string; readonly detail: string }[]
}

export interface IssueRun {
  readonly schemaVersion: typeof ISSUE_QUEUE_SCHEMA_VERSION
  readonly id: string
  readonly issue: string
  readonly title: string | null
  readonly url: string | null
  readonly sequence: number
  readonly acceptedAt: string
  readonly updatedAt: string
  readonly status: IssueRunStatus
  readonly attempt: number
  readonly config: IssueRunConfigSnapshot
  readonly contract: IssueRunContractSnapshot
  readonly preflight: IssueRunPreflightSnapshot
  readonly projection: IssueRunProjection
  readonly error: string | null
  /** Archived runs remain queryable and never become executable again. */
  readonly archived: boolean
  readonly archivedAt: string | null
}

export interface EnqueueIssueRunInput {
  readonly issue: string
  readonly title?: string | null
  readonly url?: string | null
  readonly config: IssueRunConfigSnapshot
  readonly contract: IssueRunContractSnapshot
  readonly preflight: IssueRunPreflightSnapshot
  readonly now?: Date
}

export interface IssueQueueProjection {
  readonly queued: number
  readonly dispatching: number
  readonly running: number
  readonly needsInput: number
  readonly blocked: number
  readonly failed: number
  readonly completed: number
  readonly cancelled: number
  readonly activeIssues: readonly string[]
  readonly runs: readonly IssueRun[]
}

export interface IssueQueue {
  readonly list: () => readonly IssueRun[]
  readonly get: (id: string) => IssueRun | null
  readonly getByIssue: (issue: string) => IssueRun | null
  readonly getLatestByIssue: (issue: string) => IssueRun | null
  readonly enqueue: (input: EnqueueIssueRunInput) => IssueRun
  /** Atomically reserve the oldest queued request. */
  readonly consumeFifo: () => IssueRun | null
  readonly update: (id: string, patch: IssueRunPatch) => IssueRun
  readonly cancel: (id: string, options?: { readonly confirmActive?: boolean; readonly cleanupConfirmed?: boolean }) => IssueRun
  readonly retry: (id: string, now?: Date) => IssueRun
  readonly archive: (id: string, now?: Date) => IssueRun
  readonly restore: (id: string, now?: Date) => IssueRun
  readonly archiveMany: (ids: readonly string[], now?: Date) => readonly IssueRun[]
  readonly restoreMany: (ids: readonly string[], now?: Date) => readonly IssueRun[]
  readonly project: () => IssueQueueProjection
}

export interface IssueRunPatch {
  readonly status?: IssueRunStatus
  readonly error?: string | null
  readonly projection?: Partial<IssueRunProjection>
  readonly now?: Date
}

export interface IssueQueueOptions {
  readonly stateDir: string
  readonly now?: () => Date
}

const issueRunSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(ISSUE_QUEUE_SCHEMA_VERSION)]),
  id: z.string().min(1), issue: z.string().min(1), title: z.string().nullable(), url: z.string().nullable(),
  sequence: z.number().int().positive(), acceptedAt: z.string(), updatedAt: z.string(),
  status: z.enum(['queued', 'dispatching', 'running', 'needs-input', 'blocked', 'failed', 'completed', 'cancelled']),
  attempt: z.number().int().positive(),
  config: z.object({ configHash: z.string().min(1), flow: z.string().nullable(), builder: z.object({ provider: z.string().min(1), model: z.string().min(1) }), maxFixRounds: z.number().int().min(0), perIssueTokens: z.number().int().min(0), roles: z.object({ orchestrator: z.literal('project'), reviewer: z.literal('project'), watcher: z.literal('project'), delivery: z.literal('snapshot') }) }),
  contract: z.object({ digest: z.string().min(1), status: z.literal('valid'), frozenAt: z.string() }),
  preflight: z.object({ status: z.literal('passed'), checkedAt: z.string(), capacity: z.object({ free: z.number().int().min(0), max: z.number().int().min(0) }).optional() }),
  projection: z.object({ stage: z.string(), branch: z.string().nullable(), worktree: z.string().nullable(), terminal: z.string().nullable(), pullRequest: z.number().int().positive().nullable(), evidence: z.array(z.string()), timeline: z.array(z.object({ at: z.string(), stage: z.string(), detail: z.string() })) }),
  error: z.string().nullable(), archived: z.boolean().optional(), archivedAt: z.string().nullable().optional(),
})

const stateSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(ISSUE_QUEUE_SCHEMA_VERSION)]), nextSequence: z.number().int().positive(), runs: z.array(issueRunSchema) })
type QueueState = { readonly schemaVersion: typeof ISSUE_QUEUE_SCHEMA_VERSION; readonly nextSequence: number; readonly runs: readonly IssueRun[] }

const terminal = (status: IssueRunStatus): boolean => ['completed', 'failed', 'cancelled'].includes(status)
const active = (status: IssueRunStatus): boolean => ['queued', 'dispatching', 'running', 'needs-input', 'blocked'].includes(status)
const executing = (status: IssueRunStatus): boolean => ['queued', 'dispatching', 'running'].includes(status)
const historicalDelivery = (run: IssueRun): boolean => run.status === 'completed' && ['pr-open', 'pr-closed', 'merged', 'closed'].includes(run.projection.stage)
const pathFor = (stateDir: string): string => join(stateDir, 'queue.json')
const lockFor = (stateDir: string): string => join(stateDir, 'queue.lock')

const emptyState = (): QueueState => ({ schemaVersion: ISSUE_QUEUE_SCHEMA_VERSION, nextSequence: 1, runs: [] })
const normalizeRun = (run: z.infer<typeof issueRunSchema>): IssueRun => ({
  ...run,
  schemaVersion: ISSUE_QUEUE_SCHEMA_VERSION,
  status: run.status === 'needs-input' && run.projection.stage === 'blocked' ? 'blocked' : run.status,
  archived: run.archived ?? false,
  archivedAt: run.archivedAt ?? null,
}) as IssueRun

const readState = (path: string): QueueState => {
  if (!existsSync(path)) return emptyState()
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const checked = stateSchema.safeParse(parsed)
    if (!checked.success) return fail(`Invalid issue queue state at ${path}.`, 'INVALID_STATE')
    return { schemaVersion: ISSUE_QUEUE_SCHEMA_VERSION, nextSequence: checked.data.nextSequence, runs: checked.data.runs.map(normalizeRun) }
  } catch (error) {
    if (error instanceof HarnessError) throw error
    return fail(`Invalid issue queue state at ${path}: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_STATE')
  }
}

const withLock = <T>(stateDir: string, action: () => T): T => {
  const path = lockFor(stateDir)
  let fd: number
  try { fd = openSync(path, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try { if (Date.now() - statSync(path).mtimeMs > 30_000) { unlinkSync(path); fd = openSync(path, 'wx') } else throw new HarnessError('Issue queue is being updated by another process.', 'ACTIVE_RUN') }
      catch (retryError) { if (retryError instanceof HarnessError) throw retryError; throw error }
    } else throw error
  }
  try { return action() } finally { try { closeSync(fd) } catch { /* already closed */ } try { unlinkSync(path) } catch { /* already removed */ } }
}

const requiredInput = (input: EnqueueIssueRunInput): void => {
  if (!input.issue.trim()) fail('Issue identifier is required.', 'INVALID_INPUT')
  if (!input.config.configHash.trim()) fail('A configuration snapshot is required.', 'INVALID_INPUT')
  if (!input.config.builder.provider.trim() || !input.config.builder.model.trim()) fail('A routable builder model is required.', 'INVALID_INPUT')
  if (!input.contract.digest.trim() || input.contract.status !== 'valid') fail('A valid contract is required before queue confirmation.', 'INVALID_INPUT')
  if (input.preflight.status !== 'passed') fail('A passed capacity preflight is required before queue confirmation.', 'INVALID_INPUT')
  if (!Number.isInteger(input.config.maxFixRounds) || input.config.maxFixRounds < 0) fail('maxFixRounds must be a non-negative integer.', 'INVALID_INPUT')
  if (!Number.isInteger(input.config.perIssueTokens) || input.config.perIssueTokens < 0) fail('perIssueTokens must be a non-negative integer.', 'INVALID_INPUT')
}

const initialProjection = (): IssueRunProjection => ({ stage: 'queued', branch: null, worktree: null, terminal: null, pullRequest: null, evidence: [], timeline: [] })

/** Persistent queue with FIFO reservation and issue-level idempotency. */
export const createIssueQueue = (options: IssueQueueOptions): IssueQueue => {
  mkdirSync(options.stateDir, { recursive: true })
  const statePath = pathFor(options.stateDir)
  const now = options.now ?? (() => new Date())
  let state = readState(statePath)
  const refresh = (): QueueState => { state = readState(statePath); return state }
  const persist = (next: QueueState): void => { state = next; writeJsonAtomic(statePath, next) }
  const mutate = <T>(fn: (current: QueueState) => { readonly state: QueueState; readonly value: T }): T => withLock(options.stateDir, () => { const result = fn(refresh()); persist(result.state); return result.value })
  const list = (): readonly IssueRun[] => refresh().runs.slice().sort((left, right) => left.sequence - right.sequence)
  const get = (id: string): IssueRun | null => refresh().runs.find((run) => run.id === id) ?? null
  const getByIssue = (issue: string): IssueRun | null => refresh().runs.filter((run) => run.issue === issue).sort((left, right) => right.sequence - left.sequence).find((run) => active(run.status)) ?? null
  const enqueue = (input: EnqueueIssueRunInput): IssueRun => {
    requiredInput(input)
    return mutate((current) => {
      const duplicate = current.runs.find((run) => run.issue === input.issue && active(run.status))
      if (duplicate) throw new HarnessError(`Issue ${input.issue} already has an active queue request (${duplicate.id}).`, 'ACTIVE_RUN')
      const latest = current.runs.filter((run) => run.issue === input.issue).sort((left, right) => right.sequence - left.sequence)[0]
      if (latest && historicalDelivery(latest)) throw new HarnessError(`Issue ${input.issue} already has a historical delivery (${latest.id}); retry or reopen it before starting another run.`, 'ACTIVE_RUN')
      const at = (input.now ?? now()).toISOString()
      const run: IssueRun = {
        schemaVersion: ISSUE_QUEUE_SCHEMA_VERSION, id: `run-${randomUUID()}`, issue: input.issue, title: input.title ?? null, url: input.url ?? null,
        sequence: current.nextSequence, acceptedAt: at, updatedAt: at, status: 'queued', attempt: 1,
        config: { ...input.config, builder: { ...input.config.builder }, roles: { ...input.config.roles } }, contract: { ...input.contract }, preflight: { ...input.preflight }, projection: initialProjection(), error: null, archived: false, archivedAt: null,
      }
      return { state: { ...current, nextSequence: current.nextSequence + 1, runs: [...current.runs, run] }, value: run }
    })
  }
  const update = (id: string, patch: IssueRunPatch): IssueRun => mutate((current) => {
    const existing = current.runs.find((run) => run.id === id) ?? fail(`Unknown queue run ${id}.`, 'INVALID_INPUT')
    if (patch.status === 'running' && !['running', 'dispatching', 'queued', 'needs-input'].includes(existing.status)) fail(`Run ${id} cannot enter running from ${existing.status}.`, 'INVALID_STATE')
    if (patch.status === 'completed' && existing.status !== 'completed' && !['running', 'dispatching', 'queued'].includes(existing.status)) fail(`Run ${id} cannot complete from ${existing.status}.`, 'INVALID_STATE')
    const at = (patch.now ?? now()).toISOString()
    const requestedStage = patch.projection?.stage ?? existing.projection.stage
    const timeline = patch.projection?.timeline ?? (requestedStage !== existing.projection.stage || patch.status !== existing.status
      ? [...existing.projection.timeline, { at, stage: requestedStage, detail: patch.error ?? patch.status ?? requestedStage }]
      : existing.projection.timeline)
    const projection = patch.projection ? { ...existing.projection, ...patch.projection, timeline } : patch.status && patch.status !== existing.status
      ? { ...existing.projection, stage: requestedStage, timeline }
      : existing.projection
    const next: IssueRun = { ...existing, ...(patch.status ? { status: patch.status } : {}), ...(patch.error !== undefined ? { error: patch.error } : {}), projection, updatedAt: at }
    return { state: { ...current, runs: current.runs.map((run) => run.id === id ? next : run) }, value: next }
  })
  const consumeFifo = (): IssueRun | null => mutate((current) => {
    const next = current.runs.filter((run) => run.status === 'queued').sort((left, right) => left.sequence - right.sequence)[0]
    if (!next) return { state: current, value: null }
    const at = now().toISOString()
    const claimed: IssueRun = { ...next, status: 'dispatching', updatedAt: at, projection: { ...next.projection, stage: 'dispatching', timeline: [...next.projection.timeline, { at, stage: 'dispatching', detail: 'Reserved by scheduler.' }] } }
    return { state: { ...current, runs: current.runs.map((run) => run.id === next.id ? claimed : run) }, value: claimed }
  })
  const cancel = (id: string, cancelOptions: { readonly confirmActive?: boolean; readonly cleanupConfirmed?: boolean } = {}): IssueRun => mutate((current) => {
    const existing = current.runs.find((run) => run.id === id) ?? fail(`Unknown queue run ${id}.`, 'INVALID_INPUT')
    if (terminal(existing.status)) return { state: current, value: existing }
    if (existing.status === 'queued') {
      const at = now().toISOString(); const next: IssueRun = { ...existing, status: 'cancelled', updatedAt: at, projection: { ...existing.projection, stage: 'cancelled', timeline: [...existing.projection.timeline, { at, stage: 'cancelled', detail: 'Cancelled before dispatch.' }] } }
      return { state: { ...current, runs: current.runs.map((run) => run.id === id ? next : run) }, value: next }
    }
    if (!cancelOptions.confirmActive) throw new HarnessError('Active cancellation requires explicit confirmation.', 'HUMAN_APPROVAL_REQUIRED')
    if (!cancelOptions.cleanupConfirmed) throw new HarnessError('Active cancellation is refused until terminal, worktree and lease cleanup are confirmed.', 'INVALID_STATE')
    const at = now().toISOString(); const next: IssueRun = { ...existing, status: 'cancelled', updatedAt: at, projection: { ...existing.projection, stage: 'cancelled', timeline: [...existing.projection.timeline, { at, stage: 'cancelled', detail: 'Cleanup confirmed.' }] } }
    return { state: { ...current, runs: current.runs.map((run) => run.id === id ? next : run) }, value: next }
  })
  const retry = (id: string, retryAt = now()): IssueRun => mutate((current) => {
    const existing = current.runs.find((run) => run.id === id) ?? fail(`Unknown queue run ${id}.`, 'INVALID_INPUT')
    if (!['failed', 'cancelled', 'needs-input', 'blocked'].includes(existing.status)) fail(`Only failed, cancelled or blocked runs can be retried (got ${existing.status}).`, 'INVALID_STATE')
    const duplicate = current.runs.some((run) => run.id !== id && run.issue === existing.issue && active(run.status))
    if (duplicate) throw new HarnessError(`Issue ${existing.issue} already has an active queue request.`, 'ACTIVE_RUN')
    const at = retryAt.toISOString()
    const next: IssueRun = { ...existing, schemaVersion: ISSUE_QUEUE_SCHEMA_VERSION, id: `run-${randomUUID()}`, sequence: current.nextSequence, acceptedAt: at, status: 'queued', attempt: existing.attempt + 1, updatedAt: at, error: null, archived: false, archivedAt: null, projection: { ...initialProjection(), timeline: [{ at, stage: 'queued', detail: `Retry ${existing.attempt + 1} queued from ${existing.id}.` }] } }
    return { state: { ...current, nextSequence: current.nextSequence + 1, runs: [...current.runs, next] }, value: next }
  })
  const archive = (id: string, at = now()): IssueRun => mutate((current) => {
    const existing = current.runs.find((run) => run.id === id) ?? fail(`Unknown queue run ${id}.`, 'INVALID_INPUT')
    if (executing(existing.status)) fail(`Run ${id} is active and cannot be archived.`, 'INVALID_STATE')
    if (existing.archived) return { state: current, value: existing }
    const timestamp = at.toISOString(); const next: IssueRun = { ...existing, archived: true, archivedAt: timestamp, updatedAt: timestamp }
    return { state: { ...current, runs: current.runs.map((run) => run.id === id ? next : run) }, value: next }
  })
  const restore = (id: string, at = now()): IssueRun => mutate((current) => {
    const existing = current.runs.find((run) => run.id === id) ?? fail(`Unknown queue run ${id}.`, 'INVALID_INPUT')
    if (!existing.archived) return { state: current, value: existing }
    const next: IssueRun = { ...existing, archived: false, archivedAt: null, updatedAt: at.toISOString() }
    return { state: { ...current, runs: current.runs.map((run) => run.id === id ? next : run) }, value: next }
  })
  const archiveMany = (ids: readonly string[], at = now()): readonly IssueRun[] => mutate((current) => {
    const selected = new Set(ids); const missing = ids.find((candidate) => !current.runs.some((run) => run.id === candidate)); if (missing) fail(`Unknown queue run ${missing}.`, 'INVALID_INPUT')
    const activeId = current.runs.find((run) => selected.has(run.id) && executing(run.status))?.id; if (activeId) fail(`Run ${activeId} is active and cannot be archived.`, 'INVALID_STATE')
    const timestamp = at.toISOString(); const runs = current.runs.map((run) => selected.has(run.id) ? { ...run, archived: true, archivedAt: run.archivedAt ?? timestamp, updatedAt: timestamp } : run)
    return { state: { ...current, runs }, value: runs.filter((run) => selected.has(run.id)) }
  })
  const restoreMany = (ids: readonly string[], at = now()): readonly IssueRun[] => mutate((current) => {
    const selected = new Set(ids); const missing = ids.find((candidate) => !current.runs.some((run) => run.id === candidate)); if (missing) fail(`Unknown queue run ${missing}.`, 'INVALID_INPUT')
    const timestamp = at.toISOString(); const runs = current.runs.map((run) => selected.has(run.id) ? { ...run, archived: false, archivedAt: null, updatedAt: timestamp } : run)
    return { state: { ...current, runs }, value: runs.filter((run) => selected.has(run.id)) }
  })
  const project = (): IssueQueueProjection => {
    const runs = list(); const count = (status: IssueRunStatus): number => runs.filter((run) => run.status === status).length
    return { queued: count('queued'), dispatching: count('dispatching'), running: count('running'), needsInput: count('needs-input'), blocked: count('blocked'), failed: count('failed'), completed: count('completed'), cancelled: count('cancelled'), activeIssues: [...new Set(runs.filter((run) => active(run.status)).map((run) => run.issue))], runs }
  }
  const getLatestByIssue = (issue: string): IssueRun | null => refresh().runs.filter((run) => run.issue === issue).sort((left, right) => right.sequence - left.sequence)[0] ?? null
  return { list, get, getByIssue, getLatestByIssue, enqueue, consumeFifo, update, cancel, retry, archive, restore, archiveMany, restoreMany, project }
}

export const issueQueuePath = pathFor
export const retryIssueRun = (queue: IssueQueue, id: string, now?: Date): IssueRun => queue.retry(id, now)
export const archiveIssueRun = (queue: IssueQueue, id: string, now?: Date): IssueRun => queue.archive(id, now)
export const restoreIssueRun = (queue: IssueQueue, id: string, now?: Date): IssueRun => queue.restore(id, now)
