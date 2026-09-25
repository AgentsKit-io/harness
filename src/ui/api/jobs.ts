import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from '../../loop/fs-atomic.js'
import { HarnessError } from '../../kernel/errors.js'
import { readJsonFile } from '../../kernel/json-file.js'

/**
 * A durable job queue for the one operation in the new action surface slow enough to need one: contract
 * generation (an LLM call the wizard polls). The old version dispatched through a generic `UiAction` union
 * covering ~20 operation types (`plan.*`, `release.*`, doctor, …); with those out of scope, the union added
 * nothing a plain caller-supplied closure doesn't already give — so this version takes one directly instead of
 * a typed envelope + dispatcher. Heartbeat/interrupt-detection/conflict/prune are unchanged.
 */

export const UI_JOB_SCHEMA_VERSION = 2 as const
export const UI_JOB_MAX_EVENTS = 200
export const UI_JOB_MAX_TAIL_LINES = 100
export const UI_JOB_MAX_HISTORY = 200

export type UiJobStatus = 'running' | 'needs-input' | 'blocked' | 'succeeded' | 'failed' | 'cancel-pending' | 'cancelled' | 'interrupted'

export interface UiJobEvent {
  readonly at: string
  readonly phase: string
  readonly detail: string
  readonly output?: string
}

export interface UiJobRecord {
  readonly schemaVersion: typeof UI_JOB_SCHEMA_VERSION
  readonly id: string
  /** What this job does, for conflict detection and display — e.g. `contract:ENG-123`. Not a typed union: the
   * caller owns the meaning, this queue only needs it to be stable and comparable. */
  readonly kind: string
  readonly issue: string | null
  readonly status: UiJobStatus
  readonly actor: string
  readonly reason: string
  readonly acceptedAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly heartbeatAt: string
  readonly ownerPid: number
  readonly phase: string
  readonly events: readonly UiJobEvent[]
  readonly outputTail: readonly string[]
  readonly result?: unknown
  readonly error?: { readonly code?: string; readonly message: string }
  readonly cancelRequestedAt?: string
}

export interface UiJobRunContext {
  readonly emit: (event: { readonly phase: string; readonly detail: string; readonly output?: string }) => void
  readonly cancelled: () => boolean
}

export interface UiJobSubmitInput {
  readonly kind: string
  readonly issue: string | null
  readonly actor: string
  readonly reason: string
  /** Return `{ status: 'needs-input' | 'blocked', ... }` to land there instead of `succeeded` — the same
   * convention `generateOrReuseContract` already returns. Anything else lands as `succeeded`. */
  readonly run: (context: UiJobRunContext) => Promise<unknown>
}

export interface UiJobManagerOptions {
  readonly stateDir: string
  readonly now?: () => Date
  readonly staleAfterMs?: number
}

export interface UiJobManager {
  readonly list: () => readonly UiJobRecord[]
  readonly get: (id: string) => UiJobRecord | null
  /** Submitting again for the same `kind`/`issue` while a job is still active is the retry path — there is no
   * separate `retry(id)`: a caller-supplied closure cannot be replayed after a process restart anyway, and the
   * wizard's own "generate again" already re-submits with the same parameters. */
  readonly submit: (input: UiJobSubmitInput) => UiJobRecord
  readonly cancel: (id: string) => UiJobRecord
  readonly close: () => void
}

export class UiJobConflictError extends HarnessError {
  public readonly conflict: UiJobRecord
  public constructor(conflict: UiJobRecord) {
    super(`This conflicts with running job ${conflict.id} (${conflict.kind}).`, 'ACTIVE_RUN')
    this.name = 'UiJobConflictError'
    this.conflict = conflict
  }
}

const terminal = (status: UiJobStatus): boolean => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)
const filePath = (root: string, id: string): string => join(root, `${id}.json`)

const uiJobFileSchema = z.object({ schemaVersion: z.literal(UI_JOB_SCHEMA_VERSION), id: z.string().min(1), status: z.string().min(1), kind: z.string().min(1) }).loose()
const readJob = (path: string): UiJobRecord | null => readJsonFile(path, uiJobFileSchema) as UiJobRecord | null

const boundedEvents = (events: readonly UiJobEvent[]): readonly UiJobEvent[] => events.slice(-UI_JOB_MAX_EVENTS)
const boundedTail = (tail: readonly string[], output?: string): readonly string[] => {
  const next = output === undefined ? [...tail] : [...tail, ...output.split(/\r?\n/).filter(Boolean)]
  return next.slice(-UI_JOB_MAX_TAIL_LINES)
}

export const createUiJobManager = (options: UiJobManagerOptions): UiJobManager => {
  const now = options.now ?? (() => new Date())
  const root = join(options.stateDir, 'ui', 'jobs')
  mkdirSync(root, { recursive: true })
  const jobs = new Map<string, UiJobRecord>()
  const timers = new Map<string, NodeJS.Timeout>()
  const staleAfterMs = options.staleAfterMs ?? 10_000
  let closed = false

  for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json'))) {
    const job = readJob(join(root, name))
    if (job) jobs.set(job.id, job)
  }
  for (const job of jobs.values()) {
    if ((job.status === 'running' || job.status === 'cancel-pending') && (job.ownerPid !== process.pid || now().getTime() - Date.parse(job.heartbeatAt) > staleAfterMs)) {
      const interrupted: UiJobRecord = { ...job, status: 'interrupted', finishedAt: now().toISOString(), phase: 'interrupted', error: { code: 'INTERRUPTED', message: 'UI server restarted or stopped heartbeating before the job finished.' } }
      jobs.set(job.id, interrupted)
      writeJsonAtomic(filePath(root, job.id), interrupted)
    }
  }

  const persist = (job: UiJobRecord): UiJobRecord => { jobs.set(job.id, job); writeJsonAtomic(filePath(root, job.id), job); return job }
  const activeConflict = (kind: string, issue: string | null): UiJobRecord | null =>
    [...jobs.values()].find((job) => ['running', 'cancel-pending'].includes(job.status) && (job.kind === kind || (issue !== null && job.issue === issue))) ?? null
  const prune = (): void => {
    const retained = [...jobs.values()].sort((left, right) => (right.finishedAt ?? right.acceptedAt).localeCompare(left.finishedAt ?? left.acceptedAt)).slice(0, UI_JOB_MAX_HISTORY)
    const keep = new Set(retained.map((job) => job.id))
    for (const job of jobs.values()) if (terminal(job.status) && !keep.has(job.id)) { jobs.delete(job.id); try { unlinkSync(filePath(root, job.id)) } catch { /* already gone */ } }
  }
  const update = (id: string, change: (job: UiJobRecord) => UiJobRecord): UiJobRecord => {
    const current = jobs.get(id)
    if (!current) throw new Error(`Unknown UI job ${id}.`)
    return persist(change(current))
  }

  const start = (job: UiJobRecord, input: UiJobSubmitInput): void => {
    update(job.id, (current) => ({ ...current, status: 'running', startedAt: now().toISOString(), heartbeatAt: now().toISOString(), phase: 'starting' }))
    const heartbeat = setInterval(() => { if (['running', 'cancel-pending'].includes(jobs.get(job.id)?.status ?? '')) update(job.id, (current) => ({ ...current, heartbeatAt: now().toISOString() })) }, 2_000)
    heartbeat.unref()
    timers.set(job.id, heartbeat)
    void input.run({
      emit: (event) => update(job.id, (current) => ({ ...current, phase: event.phase, heartbeatAt: now().toISOString(), events: boundedEvents([...current.events, { at: now().toISOString(), ...event }]), outputTail: boundedTail(current.outputTail, event.output) })),
      cancelled: () => jobs.get(job.id)?.status === 'cancel-pending',
    }).then((result) => {
      const current = jobs.get(job.id)
      if (!current || closed || current.status === 'interrupted') return
      const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : null
      const needsInput = resultRecord?.['status'] === 'needs-input'
      const blocked = resultRecord?.['status'] === 'blocked'
      const status: UiJobStatus = current.status === 'cancel-pending' ? 'cancelled' : needsInput ? 'needs-input' : blocked ? 'blocked' : 'succeeded'
      persist({ ...current, status, finishedAt: now().toISOString(), heartbeatAt: now().toISOString(), phase: status, result })
    }).catch((error: unknown) => {
      const current = jobs.get(job.id)
      if (!current || closed || current.status === 'interrupted') return
      const cancelled = current.status === 'cancel-pending'
      const message = error instanceof Error ? error.message : String(error)
      persist({ ...current, status: cancelled ? 'cancelled' : 'failed', finishedAt: now().toISOString(), heartbeatAt: now().toISOString(), phase: cancelled ? 'cancelled' : 'failed', error: { ...(error instanceof HarnessError ? { code: error.code } : {}), message } })
    }).finally(() => { const timer = timers.get(job.id); if (timer) clearInterval(timer); timers.delete(job.id); prune() })
  }

  const submit = (input: UiJobSubmitInput): UiJobRecord => {
    const conflict = activeConflict(input.kind, input.issue)
    if (conflict) throw new UiJobConflictError(conflict)
    const at = now().toISOString()
    const job: UiJobRecord = {
      schemaVersion: UI_JOB_SCHEMA_VERSION, id: randomUUID(),
      kind: input.kind, issue: input.issue, status: 'running', actor: input.actor, reason: input.reason,
      acceptedAt: at, startedAt: at, finishedAt: null, heartbeatAt: at, ownerPid: process.pid, phase: 'starting', events: [], outputTail: [],
    }
    persist(job)
    start(job, input)
    return job
  }
  const cancel = (id: string): UiJobRecord => update(id, (job) => ['running', 'cancel-pending'].includes(job.status) ? { ...job, status: 'cancel-pending', cancelRequestedAt: now().toISOString(), phase: 'cancel-pending' } : job)

  return {
    list: () => [...jobs.values()].sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt)),
    get: (id) => jobs.get(id) ?? null,
    submit,
    cancel,
    close: () => {
      closed = true
      for (const job of jobs.values()) if (['running', 'cancel-pending'].includes(job.status)) persist({ ...job, status: 'interrupted', finishedAt: now().toISOString(), phase: 'interrupted', error: { code: 'INTERRUPTED', message: 'UI server stopped before the job finished.' } })
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
    },
  }
}
