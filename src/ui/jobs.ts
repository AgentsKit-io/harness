import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from '../loop/fs-atomic.js'
import { HarnessError } from '../kernel/errors.js'
import { readJsonFile } from '../kernel/json-file.js'
import { executeUiAction, type UiAction, type UiActionEvent } from './actions.js'
import { createInboxStore } from '../loop/inbox.js'
import type { LoadedLoopConfig } from '../loop/config.js'
import type { CommandRunner } from '../adapters/command.js'

export const UI_JOB_SCHEMA_VERSION = 1 as const
export const UI_JOB_MAX_EVENTS = 200
export const UI_JOB_MAX_TAIL_LINES = 100
export const UI_JOB_MAX_HISTORY = 200

export type UiJobStatus = 'running' | 'succeeded' | 'failed' | 'cancel-pending' | 'cancelled' | 'interrupted' | 'rejected'

export interface UiJobEvent {
  readonly at: string
  readonly phase: string
  readonly detail: string
  readonly output?: string
}

export interface UiJobRecord {
  readonly schemaVersion: typeof UI_JOB_SCHEMA_VERSION
  readonly id: string
  readonly parentJobId: string | null
  readonly attempt: number
  readonly action: UiAction
  readonly actionKey: string
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
  readonly provider: string
  readonly model: string | null
  readonly events: readonly UiJobEvent[]
  readonly outputTail: readonly string[]
  readonly result?: unknown
  readonly error?: { readonly code?: string; readonly message: string }
  readonly cancelRequestedAt?: string
}

export interface UiJobManagerOptions {
  readonly loaded: LoadedLoopConfig
  readonly runner: CommandRunner
  readonly now?: () => Date
  readonly execute?: typeof executeUiAction
  readonly staleAfterMs?: number
}

export interface UiJobManager {
  readonly list: () => readonly UiJobRecord[]
  readonly get: (id: string) => UiJobRecord | null
  readonly submit: (action: UiAction, parentJobId?: string) => Promise<UiJobRecord>
  readonly cancel: (id: string) => UiJobRecord
  readonly retry: (id: string) => Promise<UiJobRecord>
  readonly close: () => void
}

export class UiJobConflictError extends HarnessError {
  public readonly conflict: UiJobRecord
  public constructor(conflict: UiJobRecord) {
    super(`UI action conflicts with running job ${conflict.id} (${conflict.action.type}).`, 'ACTIVE_RUN')
    this.name = 'UiJobConflictError'
    this.conflict = conflict
  }
}

const terminal = (status: UiJobStatus): boolean => ['succeeded', 'failed', 'cancelled', 'interrupted', 'rejected'].includes(status)
const actionKeyOf = (action: UiAction): string => {
  if (action.type === 'loop.stage') return `stage:${action.stage}`
  if (action.type === 'loop.tick' || action.type === 'loop.deliver') return `stage:${action.type.slice('loop.'.length)}`
  if (action.type === 'release.run' || action.type === 'release.approve') return 'stage:release'
  return `action:${action.type}`
}
const issueOf = (action: UiAction): string | null => 'issue' in action && typeof action.issue === 'string' ? action.issue : 'identifier' in action && typeof action.identifier === 'string' ? action.identifier : null
const actorOf = (action: UiAction): string => 'actor' in action && typeof action.actor === 'string' ? action.actor : 'ui'
const reasonOf = (action: UiAction): string => 'reason' in action && typeof action.reason === 'string' ? action.reason : 'read-only UI action'
const modelOf = (config: LoadedLoopConfig['config'], action: UiAction): string | null => {
  const role = action.type.startsWith('plan.') || action.type === 'loop.contract' ? 'orchestrator' : action.type === 'loop.deliver' || action.type === 'release.run' ? 'reviewer' : action.type === 'loop.tick' || action.type === 'loop.stage' ? 'builder' : null
  if (!role) return null
  return config.models?.[role]?.[0]?.[0] ?? null
}
const filePath = (root: string, id: string): string => join(root, `${id}.json`)

const uiJobFileSchema = z.object({ schemaVersion: z.literal(UI_JOB_SCHEMA_VERSION), id: z.string().min(1), status: z.string().min(1), action: z.object({}).loose() }).loose()
const readJob = (path: string): UiJobRecord | null => readJsonFile(path, uiJobFileSchema) as UiJobRecord | null

const boundedEvents = (events: readonly UiJobEvent[]): readonly UiJobEvent[] => events.slice(-UI_JOB_MAX_EVENTS)
const boundedTail = (tail: readonly string[], output?: string): readonly string[] => {
  const next = output === undefined ? [...tail] : [...tail, ...output.split(/\r?\n/).filter(Boolean)]
  return next.slice(-UI_JOB_MAX_TAIL_LINES)
}

export const createUiJobManager = (options: UiJobManagerOptions): UiJobManager => {
  const now = options.now ?? (() => new Date())
  const root = join(options.loaded.stateDir, 'ui', 'jobs')
  mkdirSync(root, { recursive: true })
  const jobs = new Map<string, UiJobRecord>()
  const timers = new Map<string, NodeJS.Timeout>()
  const executor = options.execute ?? executeUiAction
  const staleAfterMs = options.staleAfterMs ?? 10_000
  let closed = false

  for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json'))) {
    const job = readJob(join(root, name))
    if (job) jobs.set(job.id, job)
  }
  for (const job of jobs.values()) {
    if (!terminal(job.status) && (job.ownerPid !== process.pid || now().getTime() - Date.parse(job.heartbeatAt) > staleAfterMs)) {
      const interrupted: UiJobRecord = { ...job, status: 'interrupted', finishedAt: now().toISOString(), phase: 'interrupted', error: { code: 'INTERRUPTED', message: 'UI server restarted or stopped heartbeating before the job finished.' } }
      jobs.set(job.id, interrupted)
      writeJsonAtomic(filePath(root, job.id), interrupted)
    }
  }

  const persist = (job: UiJobRecord): UiJobRecord => { jobs.set(job.id, job); writeJsonAtomic(filePath(root, job.id), job); return job }
  const activeConflict = (action: UiAction): UiJobRecord | null => {
    const actionKey = actionKeyOf(action)
    const issue = issueOf(action)
    return [...jobs.values()].find((job) => job.status === 'running' || job.status === 'cancel-pending'
      ? job.actionKey === actionKey || (issue !== null && job.issue === issue)
      : false) ?? null
  }
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
  const start = (job: UiJobRecord): void => {
    const started = update(job.id, (current) => ({ ...current, status: 'running', startedAt: now().toISOString(), heartbeatAt: now().toISOString(), phase: 'starting' }))
    const heartbeat = setInterval(() => { if (jobs.get(job.id)?.status === 'running' || jobs.get(job.id)?.status === 'cancel-pending') update(job.id, (current) => ({ ...current, heartbeatAt: now().toISOString() })) }, 2_000)
    heartbeat.unref()
    timers.set(job.id, heartbeat)
    void executor({ loaded: options.loaded, runner: options.runner, emit: (event: UiActionEvent) => {
      update(job.id, (current) => ({ ...current, phase: event.phase, heartbeatAt: now().toISOString(), events: boundedEvents([...current.events, { at: now().toISOString(), ...event }]), outputTail: boundedTail(current.outputTail, event.output) }))
    }, cancelled: () => jobs.get(job.id)?.status === 'cancel-pending' }, job.action).then((result) => {
      const current = jobs.get(job.id)
      if (!current || closed || current.status === 'interrupted') return
      persist({ ...current, status: current.status === 'cancel-pending' ? 'cancelled' : 'succeeded', finishedAt: now().toISOString(), heartbeatAt: now().toISOString(), phase: current.status === 'cancel-pending' ? 'cancelled' : 'completed', result })
    }).catch((error: unknown) => {
      const current = jobs.get(job.id)
      if (!current || closed || current.status === 'interrupted') return
      const cancelled = current.status === 'cancel-pending' || (error instanceof HarnessError && error.code === 'INVALID_STATE' && /cancellation/i.test(error.message))
      const message = error instanceof Error ? error.message : String(error)
      persist({ ...current, status: cancelled ? 'cancelled' : 'failed', finishedAt: now().toISOString(), heartbeatAt: now().toISOString(), phase: cancelled ? 'cancelled' : 'failed', error: { ...(error instanceof HarnessError ? { code: error.code } : {}), message } })
      if (!cancelled && current.action.type === 'loop.contract' && current.issue) {
        // ponytail: project only contract failures into Inbox; other UI jobs keep their existing job-only recovery surface.
        try { createInboxStore(options.loaded.stateDir).upsert({ issue: current.issue, gate: 'failure.final', title: 'Falha ao gerar contrato', message, data: { jobId: current.id } }) } catch { /* job failure remains visible even if Inbox persistence is unavailable */ }
      }
    }).finally(() => { const timer = timers.get(job.id); if (timer) clearInterval(timer); timers.delete(job.id); prune() })
    void started
  }

  const submit = async (action: UiAction, parentJobId?: string): Promise<UiJobRecord> => {
    const conflict = activeConflict(action)
    if (conflict) throw new UiJobConflictError(conflict)
    const parent = parentJobId ? jobs.get(parentJobId) : null
    const attempt = parent ? parent.attempt + 1 : 1
    const at = now().toISOString()
    const job: UiJobRecord = {
      schemaVersion: UI_JOB_SCHEMA_VERSION, id: randomUUID(), parentJobId: parent?.id ?? null, attempt,
      action, actionKey: actionKeyOf(action), issue: issueOf(action), status: 'running', actor: actorOf(action), reason: reasonOf(action),
      acceptedAt: at, startedAt: at, finishedAt: null, heartbeatAt: at, ownerPid: process.pid, phase: 'starting',
      provider: options.loaded.config.connectors.tracker, model: modelOf(options.loaded.config, action), events: [], outputTail: [],
    }
    persist(job)
    start(job)
    return job
  }
  const cancel = (id: string): UiJobRecord => update(id, (job) => {
    if (job.status !== 'running' && job.status !== 'cancel-pending') return job
    return { ...job, status: 'cancel-pending', cancelRequestedAt: now().toISOString(), phase: 'cancel-pending' }
  })
  const retry = async (id: string): Promise<UiJobRecord> => {
    const job = jobs.get(id)
    if (!job) throw new Error(`Unknown UI job ${id}.`)
    if (!['interrupted', 'cancelled', 'failed'].includes(job.status)) throw new HarnessError(`Only interrupted, cancelled or failed jobs can be retried (got ${job.status}).`, 'INVALID_STATE')
    return submit(job.action, job.id)
  }
  return {
    list: () => [...jobs.values()].sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt)),
    get: (id) => jobs.get(id) ?? null,
    submit,
    cancel,
    retry,
    close: () => {
      closed = true
      for (const job of jobs.values()) if (job.status === 'running' || job.status === 'cancel-pending') persist({ ...job, status: 'interrupted', finishedAt: now().toISOString(), phase: 'interrupted', error: { code: 'INTERRUPTED', message: 'UI server stopped before the job finished.' } })
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
    },
  }
}
