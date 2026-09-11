import { fail } from './errors.js'
import { hashJson } from './hash.js'

export const MODEL_ROLES = ['orchestrator', 'reviewer', 'builder', 'watcher'] as const
export type ModelRole = typeof MODEL_ROLES[number]

export interface ModelBinding {
  readonly role: ModelRole
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

export interface ModelPolicy {
  readonly bindings: readonly ModelBinding[]
  readonly digest: string
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

export const createModelPolicy = (bindings: readonly ModelBinding[]): ModelPolicy => {
  if (!Array.isArray(bindings) || !bindings.length) fail('bindings must be a non-empty array.', 'INVALID_INPUT')
  const normalized = bindings.map((binding, index) => {
    if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) fail(`bindings[${index}] must be an object.`, 'INVALID_INPUT')
    if (!(MODEL_ROLES as readonly string[]).includes(binding.role)) fail(`bindings[${index}].role is invalid.`, 'INVALID_INPUT')
    if (binding.maxTokens !== undefined && (!Number.isInteger(binding.maxTokens) || binding.maxTokens < 1)) fail(`bindings[${index}].maxTokens must be a positive integer.`, 'INVALID_INPUT')
    return { role: binding.role, provider: required(binding.provider, `bindings[${index}].provider`), model: required(binding.model, `bindings[${index}].model`), ...(binding.maxTokens === undefined ? {} : { maxTokens: binding.maxTokens }) }
  })
  if (new Set(normalized.map((binding) => binding.role)).size !== normalized.length) fail('Each model role may be bound only once.', 'INVALID_INPUT')
  return { bindings: normalized, digest: hashJson(normalized) }
}

export const modelFor = (policy: ModelPolicy, role: ModelRole): ModelBinding => policy.bindings.find((binding) => binding.role === role) ?? fail(`No model binding exists for role: ${role}.`, 'INVALID_STATE')
