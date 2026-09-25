import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { LoopEvent } from './retro.js'
import { writeJsonAtomic } from './fs-atomic.js'
import { HarnessError } from '../kernel/errors.js'

export const INBOX_SCHEMA_VERSION = 2 as const

export type InboxStatus = 'open' | 'resolved'
export type InboxGate = 'contract.escalated' | 'plan.escalated' | 'delivery.approval' | 'delivery.pr-closed' | 'sync.failed' | 'issue.paused' | 'stage.paused' | 'review.incomplete' | 'cleanup.failed' | 'cancel.failed' | 'failure.final'
export type InboxAction = 'respond' | 'approve' | 'resume' | 'retry' | 'deliver' | 'revalidate' | 'cleanup' | 'close-issue' | 'reopen'

export interface InboxItem {
  readonly schemaVersion: typeof INBOX_SCHEMA_VERSION
  readonly id: string
  readonly issue: string
  readonly gate: InboxGate
  readonly status: InboxStatus
  readonly unread: boolean
  readonly title: string
  readonly message: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly resolvedAt: string | null
  readonly resolvedBy: string | null
  readonly fingerprint: string
  readonly actions: readonly InboxAction[]
  readonly data: Readonly<Record<string, unknown>>
}

export interface InboxStore {
  readonly list: (options?: { readonly status?: InboxStatus; readonly unreadOnly?: boolean }) => readonly InboxItem[]
  readonly get: (id: string) => InboxItem | null
  readonly getByIssueAndGate: (issue: string, gate: InboxGate) => InboxItem | null
  readonly upsert: (input: InboxUpsertInput) => InboxItem
  readonly resolve: (id: string, input: { readonly actor: string; readonly action: string; readonly data?: Readonly<Record<string, unknown>> }) => InboxItem
  readonly markRead: (id: string) => InboxItem
  readonly unreadCount: () => number
  readonly syncEvents: (events: readonly LoopEvent[]) => readonly InboxItem[]
  /** Permanently removes the card and records a fingerprint suppression. */
  readonly delete: (id: string, input: { readonly actor: string; readonly confirm: true }) => void
  readonly suppressions: () => readonly InboxSuppression[]
}

export interface InboxSuppression {
  readonly issue: string
  readonly gate: InboxGate
  readonly fingerprint: string
  readonly deletedAt: string
  readonly deletedBy: string
}

export interface InboxUpsertInput {
  readonly issue: string
  readonly gate: InboxGate
  readonly title?: string
  readonly message: string
  readonly fingerprint?: string
  readonly actions?: readonly InboxAction[]
  readonly data?: Readonly<Record<string, unknown>>
  readonly now?: Date
}

const inboxItemSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(INBOX_SCHEMA_VERSION)]), id: z.string().min(1), issue: z.string().min(1),
  gate: z.enum(['contract.escalated', 'plan.escalated', 'delivery.approval', 'delivery.pr-closed', 'sync.failed', 'issue.paused', 'stage.paused', 'review.incomplete', 'cleanup.failed', 'cancel.failed', 'failure.final']),
  status: z.enum(['open', 'resolved']), unread: z.boolean(), title: z.string(), message: z.string(), createdAt: z.string(), updatedAt: z.string(), resolvedAt: z.string().nullable(), resolvedBy: z.string().nullable(), fingerprint: z.string().min(1),
  actions: z.array(z.enum(['respond', 'approve', 'resume', 'retry', 'deliver', 'revalidate', 'cleanup', 'close-issue', 'reopen'])), data: z.record(z.string(), z.unknown()),
})
const suppressionSchema = z.object({ issue: z.string().min(1), gate: z.string().min(1), fingerprint: z.string().min(1), deletedAt: z.string(), deletedBy: z.string().min(1) })
const stateSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(INBOX_SCHEMA_VERSION)]), items: z.array(inboxItemSchema), suppressions: z.array(suppressionSchema).optional() })
type InboxState = { readonly schemaVersion: typeof INBOX_SCHEMA_VERSION; readonly items: readonly InboxItem[]; readonly suppressions: readonly InboxSuppression[] }
const pathFor = (stateDir: string): string => join(stateDir, 'inbox.json')
const lockFor = (stateDir: string): string => join(stateDir, 'inbox.lock')
const eventText = (event: LoopEvent): string => String(event['reason'] ?? event['error'] ?? event['message'] ?? event.type)
const eventFingerprint = (event: LoopEvent, gate: InboxGate): string => gate === 'delivery.pr-closed'
  ? `pr:${String(event['pr'] ?? '')}:closed:${String(event['head'] ?? '')}`
  : gate === 'sync.failed'
    ? `tracker:${String(event['operation'] ?? '')}:${String(event['error'] ?? eventText(event))}`
    : `${event.type}:${event.at}:${eventText(event)}`
const eventGate = (event: LoopEvent): InboxGate | null => {
  if (event.type === 'contract.escalated') return 'contract.escalated'
  // Technical failures return to Available with Retry; only final decisions belong in Inbox.
  if (event.type === 'pr.closed' || event.type === 'delivery.pr-closed') return 'delivery.pr-closed'
  if (event.type === 'tracker.sync-failed') return 'sync.failed'
  if (event.type === 'plan.escalated' || event.type === 'plan.no-consensus') return 'plan.escalated'
  if (event.type === 'pr.merge-refused' || event.type === 'pr.human-approval-required') return 'delivery.approval'
  if (event.type === 'pr.reviewed' && event['status'] === 'incomplete') return 'review.incomplete'
  if (event.type === 'issue.paused') return 'issue.paused'
  if (event.type === 'stage.paused') return 'stage.paused'
  if (event.type === 'worker.held') return 'delivery.approval'
  if (event.type === 'review.incomplete') return 'review.incomplete'
  if (event.type === 'cleanup.failed') return 'cleanup.failed'
  if (event.type === 'cancel.failed') return 'cancel.failed'
  if (event.type === 'worker.blocked' || event.type === 'worker.stuck') return 'failure.final'
  return null
}
const actionsFor = (gate: InboxGate): InboxItem['actions'] => gate === 'contract.escalated' ? ['respond', 'revalidate'] : gate === 'plan.escalated' ? ['respond', 'resume'] : gate === 'delivery.pr-closed' ? ['close-issue', 'reopen', 'respond'] : gate === 'sync.failed' ? ['retry', 'respond'] : gate === 'delivery.approval' ? ['approve', 'deliver'] : gate === 'issue.paused' || gate === 'stage.paused' ? ['resume', 'retry'] : gate === 'cleanup.failed' || gate === 'cancel.failed' ? ['cleanup', 'respond'] : ['retry', 'respond']

/** Durable human-decision store. The id is intentionally issue + gate, so repeated events update one card. */
export const createInboxStore = (stateDir: string, now: () => Date = () => new Date()): InboxStore => {
  mkdirSync(stateDir, { recursive: true })
  const path = pathFor(stateDir)
  const withLock = <T>(action: () => T): T => {
    const lock = lockFor(stateDir)
    let fd: number
    try { fd = openSync(lock, 'wx') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); fd = openSync(lock, 'wx') } else throw new HarnessError('Inbox is being updated by another process.', 'ACTIVE_RUN') }
        catch (retryError) { if (retryError instanceof HarnessError) throw retryError; throw error }
      } else throw error
    }
    try { return action() } finally { try { closeSync(fd) } catch { /* already closed */ } try { unlinkSync(lock) } catch { /* already removed */ } }
  }
  const read = (): InboxState => {
    if (!existsSync(path)) return { schemaVersion: INBOX_SCHEMA_VERSION, items: [], suppressions: [] }
    try {
      const checked = stateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (!checked.success) throw new HarnessError(`Invalid Inbox state at ${path}.`, 'INVALID_STATE')
      const items = checked.data.items.map((item) => ({ ...item, schemaVersion: INBOX_SCHEMA_VERSION, actions: item.gate === 'cleanup.failed' || item.gate === 'cancel.failed'
        ? item.actions.includes('cleanup') ? item.actions : ['cleanup', 'respond'] as const
        : item.actions })) as readonly InboxItem[]
      return { schemaVersion: INBOX_SCHEMA_VERSION, items, suppressions: (checked.data.suppressions ?? []) as readonly InboxSuppression[] }
    } catch (error) {
      if (error instanceof HarnessError) throw error
      throw new HarnessError(`Invalid Inbox state at ${path}: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_STATE')
    }
  }
  const persist = (state: InboxState): void => writeJsonAtomic(path, state)
  const idFor = (issue: string, gate: InboxGate): string => `${issue}::${gate}`
  const list = (options: { readonly status?: InboxStatus; readonly unreadOnly?: boolean } = {}): readonly InboxItem[] => read().items.filter((item) => (!options.status || item.status === options.status) && (!options.unreadOnly || item.unread)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const get = (id: string): InboxItem | null => read().items.find((item) => item.id === id) ?? null
  const getByIssueAndGate = (issue: string, gate: InboxGate): InboxItem | null => get(idFor(issue, gate))
  const upsert = (input: InboxUpsertInput): InboxItem => {
    return withLock(() => {
      const at = (input.now ?? now()).toISOString(); const fingerprint = input.fingerprint ?? `${input.gate}:${input.message}`; const state = read(); const id = idFor(input.issue, input.gate); const existing = state.items.find((item) => item.id === id)
      const suppressed = state.suppressions.some((item) => item.issue === input.issue && item.gate === input.gate && item.fingerprint === fingerprint)
      const item: InboxItem = {
        schemaVersion: INBOX_SCHEMA_VERSION, id, issue: input.issue, gate: input.gate, status: suppressed || existing && existing.status === 'resolved' && existing.fingerprint === fingerprint ? 'resolved' : 'open', unread: suppressed ? false : existing?.status === 'open' && existing.fingerprint === fingerprint ? existing.unread : true,
        title: input.title ?? input.gate, message: input.message, createdAt: existing?.createdAt ?? at, updatedAt: at, resolvedAt: suppressed ? at : existing && existing.status === 'resolved' && existing.fingerprint === fingerprint ? existing.resolvedAt : null, resolvedBy: suppressed ? 'suppressed' : existing && existing.status === 'resolved' && existing.fingerprint === fingerprint ? existing.resolvedBy : null,
        fingerprint, actions: input.actions ?? actionsFor(input.gate), data: input.data ?? {},
      }
      // Keep a suppressed condition out of the visible Inbox while returning a deterministic projection to callers.
      if (suppressed) return item
      persist({ schemaVersion: INBOX_SCHEMA_VERSION, items: state.items.some((candidate) => candidate.id === id) ? state.items.map((candidate) => candidate.id === id ? item : candidate) : [...state.items, item], suppressions: state.suppressions })
      return item
    })
  }
  const resolve = (id: string, input: { readonly actor: string; readonly action: string; readonly data?: Readonly<Record<string, unknown>> }): InboxItem => {
    if (!input.actor.trim() || !input.action.trim()) throw new HarnessError('Inbox resolution requires actor and action.', 'INVALID_INPUT')
    return withLock(() => {
      const state = read(); const existing = state.items.find((item) => item.id === id); if (!existing) throw new HarnessError(`Unknown Inbox item ${id}.`, 'INVALID_INPUT')
      if (!existing.actions.includes(input.action as InboxItem['actions'][number])) throw new HarnessError(`Action ${input.action} is not allowed for Inbox item ${id}.`, 'INVALID_INPUT')
      const at = now().toISOString(); const item: InboxItem = { ...existing, status: 'resolved', unread: false, updatedAt: at, resolvedAt: at, resolvedBy: input.actor, data: { ...existing.data, resolution: input.action, ...(input.data ?? {}) } }
      persist({ schemaVersion: INBOX_SCHEMA_VERSION, items: state.items.map((candidate) => candidate.id === id ? item : candidate), suppressions: state.suppressions }); return item
    })
  }
  const markRead = (id: string): InboxItem => withLock(() => { const state = read(); const existing = state.items.find((item) => item.id === id); if (!existing) throw new HarnessError(`Unknown Inbox item ${id}.`, 'INVALID_INPUT'); const item = { ...existing, unread: false }; persist({ schemaVersion: INBOX_SCHEMA_VERSION, items: state.items.map((candidate) => candidate.id === id ? item : candidate), suppressions: state.suppressions }); return item })
  const unreadCount = (): number => list({ status: 'open', unreadOnly: true }).length
  const syncEvents = (events: readonly LoopEvent[]): readonly InboxItem[] => events.flatMap((event) => { const gate = eventGate(event); const issue = typeof event.issue === 'string' ? event.issue : null; if (!gate || !issue) return []; return [upsert({ issue, gate, message: eventText(event), fingerprint: eventFingerprint(event, gate), data: event })] })
  const remove = (id: string, input: { readonly actor: string; readonly confirm: true }): void => withLock(() => {
    if (!input.actor.trim() || input.confirm !== true) throw new HarnessError('Inbox deletion requires an actor and explicit confirmation.', 'HUMAN_APPROVAL_REQUIRED')
    const state = read(); const existing = state.items.find((item) => item.id === id); if (!existing) throw new HarnessError(`Unknown Inbox item ${id}.`, 'INVALID_INPUT')
    const suppression: InboxSuppression = { issue: existing.issue, gate: existing.gate, fingerprint: existing.fingerprint, deletedAt: now().toISOString(), deletedBy: input.actor }
    persist({ schemaVersion: INBOX_SCHEMA_VERSION, items: state.items.filter((item) => item.id !== id), suppressions: [...state.suppressions.filter((item) => !(item.issue === suppression.issue && item.gate === suppression.gate && item.fingerprint === suppression.fingerprint)), suppression] })
  })
  const suppressions = (): readonly InboxSuppression[] => read().suppressions.slice()
  return { list, get, getByIssueAndGate, upsert, resolve, markRead, unreadCount, syncEvents, delete: remove, suppressions }
}

export const inboxPath = pathFor
export const deleteInboxItem = (store: InboxStore, id: string, input: { readonly actor: string; readonly confirm: true }): void => store.delete(id, input)
export const suppressInboxItem = deleteInboxItem
