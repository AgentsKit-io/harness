import { describe, expect, it } from 'vitest'
import { createModelPolicy, modelFor } from '../src/index.js'

describe('createModelPolicy', () => {
  it('normalizes bindings and computes a stable digest', () => {
    const policy = createModelPolicy([{ role: 'builder', provider: 'agentskit', model: 'luna', maxTokens: 4000 }])
    expect(policy.bindings).toEqual([{ role: 'builder', provider: 'agentskit', model: 'luna', maxTokens: 4000 }])
    expect(policy.digest).toHaveLength(64)
    expect(createModelPolicy([{ role: 'builder', provider: 'agentskit', model: 'luna', maxTokens: 4000 }]).digest).toBe(policy.digest)
  })

  it('rejects an empty or non-array bindings list', () => {
    expect(() => createModelPolicy([])).toThrow(/non-empty array/)
    expect(() => createModelPolicy('nope' as never)).toThrow(/non-empty array/)
  })

  it('rejects a non-object binding entry', () => {
    expect(() => createModelPolicy([null as never])).toThrow(/bindings\[0\] must be an object/)
    expect(() => createModelPolicy([[] as never])).toThrow(/bindings\[0\] must be an object/)
  })

  it('rejects an invalid role', () => {
    expect(() => createModelPolicy([{ role: 'not-a-role' as never, provider: 'p', model: 'm' }])).toThrow(/bindings\[0\].role is invalid/)
  })

  it('rejects a non-positive or non-integer maxTokens', () => {
    expect(() => createModelPolicy([{ role: 'builder', provider: 'p', model: 'm', maxTokens: 0 }])).toThrow(/maxTokens must be a positive integer/)
    expect(() => createModelPolicy([{ role: 'builder', provider: 'p', model: 'm', maxTokens: 1.5 }])).toThrow(/maxTokens must be a positive integer/)
  })

  it('rejects a missing/blank provider or model', () => {
    expect(() => createModelPolicy([{ role: 'builder', provider: '', model: 'm' }])).toThrow(/provider is required/)
    expect(() => createModelPolicy([{ role: 'builder', provider: 'p', model: '  ' }])).toThrow(/model is required/)
  })

  it('rejects binding the same role more than once', () => {
    expect(() => createModelPolicy([{ role: 'builder', provider: 'p', model: 'm1' }, { role: 'builder', provider: 'p', model: 'm2' }])).toThrow(/may be bound only once/)
  })
})

describe('modelFor', () => {
  it('returns the binding for a role, and fails closed when the role has no binding', () => {
    const policy = createModelPolicy([{ role: 'builder', provider: 'p', model: 'm' }])
    expect(modelFor(policy, 'builder').model).toBe('m')
    expect(() => modelFor(policy, 'reviewer')).toThrow(/No model binding exists for role: reviewer/)
  })
})
