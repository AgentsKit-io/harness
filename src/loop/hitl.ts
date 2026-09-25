import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HarnessError } from '../kernel/errors.js'
import { writeJsonAtomic } from './fs-atomic.js'

export const HITL_SCHEMA_VERSION = 1 as const
export const HITL_ANCHOR_ID = 'none-of-the-above' as const
export const HITL_ANCHOR_TITLE = 'None of the above' as const
export const HITL_FREE_TEXT_MAX = 5_000

export type HitlRole = 'orchestrator' | 'planner' | 'builder' | 'reviewer' | 'watcher' | 'verify' | 'dod'
export type HitlStatus = 'open' | 'answered' | 'stale'

export interface HitlOption {
  readonly id: string
  readonly title: string
  readonly description: string
}

export interface HitlAnswer {
  readonly optionId: string
  readonly freeText?: string
  readonly actor: string
  readonly answeredAt: string
  readonly digest: string
}

export interface HitlRequest {
  readonly schemaVersion: typeof HITL_SCHEMA_VERSION
  readonly requestId: string
  readonly batchId: string
  readonly issue: string
  readonly role: HitlRole
  readonly stage: string
  readonly question: string
  readonly context: string
  readonly options: readonly HitlOption[]
  readonly recommendedOptionId: string
  readonly digest: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly status: HitlStatus
  readonly unread: boolean
  readonly answer: HitlAnswer | null
  readonly source: 'llm'
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface HitlRequestInput {
  readonly requestId?: string
  readonly batchId?: string
  readonly issue: string
  readonly role: HitlRole
  readonly stage: string
  readonly question: string
  readonly context?: string
  readonly options: readonly HitlOption[]
  readonly recommendedOptionId: string
  readonly digest: string
  readonly source?: 'llm'
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly now?: Date
}

export interface HitlStore {
  readonly list: (options?: { readonly status?: HitlStatus; readonly issue?: string; readonly batchId?: string }) => readonly HitlRequest[]
  readonly get: (requestId: string) => HitlRequest | null
  readonly create: (input: HitlRequestInput) => HitlRequest
  readonly answer: (requestId: string, input: { readonly optionId: string; readonly freeText?: string; readonly actor: string; readonly expectedDigest: string }) => HitlRequest
  readonly markStale: (requestId: string, reason?: string) => HitlRequest
  readonly markRead: (requestId: string) => HitlRequest
  readonly batchReady: (batchId: string) => boolean
}

const optionSchema = z.object({ id: z.string().trim().min(1), title: z.string().trim().min(1), description: z.string().trim().min(1) })
const answerSchema = z.object({ optionId: z.string().trim().min(1), freeText: z.string().max(HITL_FREE_TEXT_MAX).optional(), actor: z.string().trim().min(1), answeredAt: z.string(), digest: z.string().min(1) })
const requestSchema = z.object({
  schemaVersion: z.literal(HITL_SCHEMA_VERSION), requestId: z.string().min(1), batchId: z.string().min(1), issue: z.string().min(1),
  role: z.enum(['orchestrator', 'planner', 'builder', 'reviewer', 'watcher', 'verify', 'dod']), stage: z.string().min(1), question: z.string().min(1), context: z.string(),
  options: z.array(optionSchema).min(3).max(4), recommendedOptionId: z.string().min(1), digest: z.string().min(1), createdAt: z.string(), updatedAt: z.string(),
  status: z.enum(['open', 'answered', 'stale']), unread: z.boolean(), answer: answerSchema.nullable(), source: z.literal('llm'), metadata: z.record(z.string(), z.unknown()),
})

const requestPath = (stateDir: string, requestId: string): string => join(stateDir, 'hitl', 'requests', `${encodeURIComponent(requestId)}.json`)
const lockPath = (stateDir: string): string => join(stateDir, 'hitl', 'hitl.lock')
const digestOf = (value: unknown): string => JSON.stringify(value)

const validateInput = (input: HitlRequestInput): void => {
  if (!input.issue.trim() || !input.stage.trim() || !input.question.trim() || !input.digest.trim()) throw new HarnessError('HITL request requires issue, stage, question and digest.', 'INVALID_INPUT')
  if (input.options.length < 3 || input.options.length > 4) throw new HarnessError('HITL requests must contain exactly 3 or 4 suggested options.', 'INVALID_INPUT')
  const ids = new Set<string>()
  for (const option of input.options) {
    if (!option.id.trim() || !option.title.trim() || !option.description.trim()) throw new HarnessError('HITL options require id, title and description.', 'INVALID_INPUT')
    if (option.id === HITL_ANCHOR_ID || ids.has(option.id)) throw new HarnessError('HITL option ids must be unique and cannot use the fixed anchor id.', 'INVALID_INPUT')
    ids.add(option.id)
  }
  if (!ids.has(input.recommendedOptionId)) throw new HarnessError('HITL recommendation must point to one suggested option.', 'INVALID_INPUT')
}

const withLock = <T>(stateDir: string, action: () => T): T => {
  mkdirSync(join(stateDir, 'hitl', 'requests'), { recursive: true })
  const path = lockPath(stateDir)
  let fd: number
  try { fd = openSync(path, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (Date.now() - statSync(path).mtimeMs <= 30_000) throw new HarnessError('HITL state is being updated by another process.', 'ACTIVE_RUN')
    unlinkSync(path); fd = openSync(path, 'wx')
  }
  try { return action() } finally { try { closeSync(fd) } catch { /* already closed */ } try { unlinkSync(path) } catch { /* already removed */ } }
}

const readRequest = (path: string): HitlRequest | null => {
  if (!existsSync(path)) return null
  const checked = requestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  if (!checked.success) throw new HarnessError(`Invalid HITL request at ${path}.`, 'INVALID_STATE')
  return checked.data as HitlRequest
}

const normalize = (input: HitlRequestInput, now: Date): HitlRequest => ({
  schemaVersion: HITL_SCHEMA_VERSION,
  requestId: input.requestId ?? randomUUID(),
  batchId: input.batchId ?? randomUUID(),
  issue: input.issue,
  role: input.role,
  stage: input.stage,
  question: input.question.trim(),
  context: (input.context ?? '').trim(),
  options: input.options.map((option) => ({ id: option.id.trim(), title: option.title.trim(), description: option.description.trim() })),
  recommendedOptionId: input.recommendedOptionId,
  digest: input.digest,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  status: 'open',
  unread: true,
  answer: null,
  source: 'llm',
  metadata: input.metadata ?? {},
})

/** Durable HITL state. The interface owns validation, idempotency and stale-digest protection for every caller. */
export const createHitlStore = (stateDir: string, now: () => Date = () => new Date()): HitlStore => {
  const root = join(stateDir, 'hitl', 'requests')
  mkdirSync(root, { recursive: true })
  const list = (options: { readonly status?: HitlStatus; readonly issue?: string; readonly batchId?: string } = {}): readonly HitlRequest[] => readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => readRequest(join(root, name))).filter((request): request is HitlRequest => request !== null && (!options.status || request.status === options.status) && (!options.issue || request.issue === options.issue) && (!options.batchId || request.batchId === options.batchId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const get = (requestId: string): HitlRequest | null => readRequest(requestPath(stateDir, requestId))
  const create = (input: HitlRequestInput): HitlRequest => withLock(stateDir, () => {
    validateInput(input)
    const at = input.now ?? now()
    const request = normalize(input, at)
    const existing = get(request.requestId)
    if (existing) {
      if (existing.digest !== request.digest) throw new HarnessError(`HITL request ${request.requestId} already exists with another digest.`, 'INVALID_STATE')
      return existing
    }
    writeJsonAtomic(requestPath(stateDir, request.requestId), request)
    return request
  })
  const answer = (requestId: string, input: { readonly optionId: string; readonly freeText?: string; readonly actor: string; readonly expectedDigest: string }): HitlRequest => withLock(stateDir, () => {
    const existing = get(requestId)
    if (!existing) throw new HarnessError(`Unknown HITL request ${requestId}.`, 'INVALID_INPUT')
    if (existing.digest !== input.expectedDigest || existing.status === 'stale') throw new HarnessError(`HITL request ${requestId} is stale.`, 'INVALID_STATE')
    const validIds = new Set(existing.options.map((option) => option.id).concat(HITL_ANCHOR_ID))
    if (!validIds.has(input.optionId)) throw new HarnessError(`Unknown HITL option ${input.optionId}.`, 'INVALID_INPUT')
    const freeText = input.freeText?.trim()
    if (input.optionId === HITL_ANCHOR_ID && !freeText) throw new HarnessError('None of the above requires a non-empty explanation.', 'INVALID_INPUT')
    if (input.optionId !== HITL_ANCHOR_ID && freeText) throw new HarnessError('Free text is only allowed with None of the above.', 'INVALID_INPUT')
    if (freeText && freeText.length > HITL_FREE_TEXT_MAX) throw new HarnessError(`HITL free text cannot exceed ${HITL_FREE_TEXT_MAX} characters.`, 'INVALID_INPUT')
    const digest = digestOf({ requestId, optionId: input.optionId, freeText: freeText ?? null, expectedDigest: input.expectedDigest })
    if (existing.status === 'answered') {
      if (existing.answer?.digest === digest) return existing
      throw new HarnessError(`HITL request ${requestId} already has another answer.`, 'INVALID_STATE')
    }
    const at = now().toISOString()
    const next: HitlRequest = { ...existing, status: 'answered', updatedAt: at, answer: { optionId: input.optionId, ...(freeText ? { freeText } : {}), actor: input.actor, answeredAt: at, digest } }
    writeJsonAtomic(requestPath(stateDir, requestId), next)
    return next
  })
  const markStale = (requestId: string, reason?: string): HitlRequest => withLock(stateDir, () => {
    const existing = get(requestId)
    if (!existing) throw new HarnessError(`Unknown HITL request ${requestId}.`, 'INVALID_INPUT')
    const next = { ...existing, status: 'stale' as const, updatedAt: now().toISOString(), context: reason ? `${existing.context}\n\nStale: ${reason}`.trim() : existing.context }
    writeJsonAtomic(requestPath(stateDir, requestId), next)
    return next
  })
  const markRead = (requestId: string): HitlRequest => withLock(stateDir, () => {
    const existing = get(requestId)
    if (!existing) throw new HarnessError(`Unknown HITL request ${requestId}.`, 'INVALID_INPUT')
    if (!existing.unread) return existing
    const next = { ...existing, unread: false, updatedAt: now().toISOString() }
    writeJsonAtomic(requestPath(stateDir, requestId), next)
    return next
  })
  const batchReady = (batchId: string): boolean => {
    const batch = list({ batchId })
    return batch.length > 0 && batch.every((request) => request.status === 'answered')
  }
  return { list, get, create, answer, markStale, markRead, batchReady }
}

export const hitlRequestPath = requestPath
export const allHitlOptions = (request: HitlRequest): readonly HitlOption[] => [...request.options, { id: HITL_ANCHOR_ID, title: HITL_ANCHOR_TITLE, description: 'Provide a different decision with a short explanation.' }]
