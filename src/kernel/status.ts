import { fail } from './errors.js'
import { hashJson } from './hash.js'
import type { BlockStatus } from './block.js'
import type { MachineMetrics } from './types.js'

export interface StatusBlock {
  readonly id: string
  readonly status: BlockStatus
  readonly owner?: string
  readonly issue?: string
  readonly branch?: string
  readonly revision?: string
  readonly blockers?: readonly string[]
}

export interface StatusSnapshot {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly sourceRevision: string
  readonly blocks: readonly StatusBlock[]
  readonly machine?: MachineMetrics
  readonly metrics?: Readonly<Record<string, number>>
  readonly next?: string
  readonly digest: string
}

const required = (value: unknown, label: string): string => {
  return typeof value === 'string' && value.trim() ? value.trim() : fail(`${label} must be a non-empty string.`, 'INVALID_INPUT')
}

export const createStatusSnapshot = (input: Omit<StatusSnapshot, 'schemaVersion' | 'digest'>): StatusSnapshot => {
  const sourceRevision = required(input.sourceRevision, 'sourceRevision')
  if (!Number.isFinite(Date.parse(input.generatedAt))) fail('generatedAt must be a valid timestamp.', 'INVALID_INPUT')
  if (!Array.isArray(input.blocks)) fail('blocks must be an array.', 'INVALID_INPUT')
  const blocks = input.blocks.map((block, index) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) fail(`blocks[${index}] must be an object.`, 'INVALID_INPUT')
    const value = block as StatusBlock
    if (!(typeof value.id === 'string' && value.id.trim())) fail(`blocks[${index}].id is required.`, 'INVALID_INPUT')
    if (!['todo', 'picked', 'development', 'validation', 'pr-open', 'merged', 'post-merge', 'done', 'blocked', 'scope-cut'].includes(value.status)) fail(`blocks[${index}].status is invalid.`, 'INVALID_INPUT')
    return { ...value, id: value.id.trim() }
  }).sort((left, right) => left.id.localeCompare(right.id))
  if (input.metrics !== undefined && Object.entries(input.metrics).some(([key, value]) => !key.trim() || typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail('metrics must contain finite non-negative numbers.', 'INVALID_INPUT')
  const body = { schemaVersion: 1 as const, generatedAt: input.generatedAt, sourceRevision, blocks, ...(input.machine ? { machine: input.machine } : {}), ...(input.metrics ? { metrics: input.metrics } : {}), ...(input.next ? { next: required(input.next, 'next') } : {}) }
  return { ...body, digest: hashJson(body) }
}

export const validateStatusSnapshot = (value: unknown): StatusSnapshot => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('status snapshot must be an object.', 'INVALID_INPUT')
  const raw = value as StatusSnapshot
  const snapshot = createStatusSnapshot({ generatedAt: required(raw.generatedAt, 'generatedAt'), sourceRevision: required(raw.sourceRevision, 'sourceRevision'), blocks: raw.blocks, ...(raw.machine ? { machine: raw.machine } : {}), ...(raw.metrics ? { metrics: raw.metrics } : {}), ...(raw.next ? { next: raw.next } : {}) })
  if (raw.schemaVersion !== 1 || raw.digest !== snapshot.digest) fail('status snapshot digest or schemaVersion is invalid.', 'HARNESS_ERROR')
  return snapshot
}
