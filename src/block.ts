import { fail } from './errors.js'
import { hashJson } from './hash.js'

export const BLOCK_STATUSES = ['todo', 'picked', 'development', 'validation', 'pr-open', 'merged', 'post-merge', 'done', 'blocked', 'scope-cut'] as const
export type BlockStatus = typeof BLOCK_STATUSES[number]

export interface BlockManifest {
  readonly schemaVersion: 1
  readonly id: string
  readonly title: string
  readonly tracker: string
  readonly repository: string
  readonly acceptanceCriteria: readonly string[]
  readonly dependencies: readonly string[]
  readonly wave: number
  readonly status: BlockStatus
  readonly budget?: { readonly maxMinutes?: number; readonly maxAttempts?: number }
  readonly humanGates?: readonly string[]
  readonly sourceHash?: string
}

export interface BlockAssessment {
  readonly status: 'ready' | 'blocked'
  readonly manifestHash: string
  readonly blockers: readonly string[]
  readonly next: readonly string[]
}

const text = (value: unknown, label: string): string => {
  return typeof value === 'string' && value.trim() ? value.trim() : fail(`${label} must be a non-empty string.`, 'INVALID_INPUT')
}
const list = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value)) return fail(`${label} must be an array of non-empty strings.`, 'INVALID_INPUT')
  if (!value.every((item: unknown): item is string => typeof item === 'string' && Boolean(item.trim()))) return fail(`${label} must be an array of non-empty strings.`, 'INVALID_INPUT')
  return [...new Set(value.map((item: string) => item.trim()))]
}

export const validateBlockManifest = (value: unknown): BlockManifest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('block manifest must be an object.', 'INVALID_INPUT')
  const raw = value as Record<string, unknown>
  if (raw['schemaVersion'] !== 1) fail('block manifest schemaVersion must be 1.', 'INVALID_INPUT')
  const criteria = list(raw['acceptanceCriteria'], 'acceptanceCriteria')
  if (!criteria.length) fail('acceptanceCriteria must not be empty.', 'INVALID_INPUT')
  const dependencies = list(raw['dependencies'] ?? [], 'dependencies')
  const wave = raw['wave']
  if (!Number.isInteger(wave) || (wave as number) < 1) fail('wave must be a positive integer.', 'INVALID_INPUT')
  const status = raw['status']
  if (!(BLOCK_STATUSES as readonly unknown[]).includes(status)) fail('status is invalid.', 'INVALID_INPUT')
  const budgetRaw = raw['budget']
  let budget: BlockManifest['budget']
  if (budgetRaw !== undefined) {
    if (typeof budgetRaw !== 'object' || budgetRaw === null || Array.isArray(budgetRaw)) fail('budget must be an object.', 'INVALID_INPUT')
    const candidate = budgetRaw as Record<string, unknown>
    for (const key of ['maxMinutes', 'maxAttempts'] as const) if (candidate[key] !== undefined && (!Number.isInteger(candidate[key]) || (candidate[key] as number) < 1)) fail(`budget.${key} must be a positive integer.`, 'INVALID_INPUT')
    budget = { ...(candidate['maxMinutes'] === undefined ? {} : { maxMinutes: candidate['maxMinutes'] as number }), ...(candidate['maxAttempts'] === undefined ? {} : { maxAttempts: candidate['maxAttempts'] as number }) }
  }
  return { schemaVersion: 1, id: text(raw['id'], 'id'), title: text(raw['title'], 'title'), tracker: text(raw['tracker'], 'tracker'), repository: text(raw['repository'], 'repository'), acceptanceCriteria: criteria, dependencies, wave: wave as number, status: status as BlockStatus, ...(budget ? { budget } : {}), ...(raw['humanGates'] === undefined ? {} : { humanGates: list(raw['humanGates'], 'humanGates') }), ...(raw['sourceHash'] === undefined ? {} : { sourceHash: text(raw['sourceHash'], 'sourceHash') }) }
}

export const assessBlock = (manifest: BlockManifest, completedDependencies: readonly string[] = []): BlockAssessment => {
  const value = validateBlockManifest(manifest)
  const completed = new Set(completedDependencies.map((item) => text(item, 'completedDependencies[]')))
  const blockers = value.dependencies.filter((dependency) => !completed.has(dependency))
  const next = blockers.length ? [`Complete dependencies: ${blockers.join(', ')}`] : value.status === 'blocked' ? ['Resolve the recorded blocker before dispatch.'] : ['Dispatch the block with the frozen acceptance criteria.']
  return { status: blockers.length || value.status === 'blocked' ? 'blocked' : 'ready', manifestHash: hashJson(value), blockers, next }
}
