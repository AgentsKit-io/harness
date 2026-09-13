import { describe, expect, it } from 'vitest'
import { assessBlock, validateBlockManifest } from '../src/index.js'

const validManifest = { schemaVersion: 1 as const, id: 'B-1', title: 'Build', tracker: 'linear', repository: 'org/repo', acceptanceCriteria: ['tests pass'], dependencies: [], wave: 1, status: 'todo' as const }

describe('validateBlockManifest', () => {
  it('accepts a full manifest with optional budget/humanGates/sourceHash', () => {
    const manifest = validateBlockManifest({ ...validManifest, budget: { maxMinutes: 30, maxAttempts: 3 }, humanGates: ['approve-pr'], sourceHash: 'abc123' })
    expect(manifest).toMatchObject({ budget: { maxMinutes: 30, maxAttempts: 3 }, humanGates: ['approve-pr'], sourceHash: 'abc123' })
  })

  it('rejects a non-object value', () => {
    expect(() => validateBlockManifest(null)).toThrow(/must be an object/)
    expect(() => validateBlockManifest([])).toThrow(/must be an object/)
  })

  it('rejects the wrong schemaVersion', () => {
    expect(() => validateBlockManifest({ ...validManifest, schemaVersion: 2 })).toThrow(/schemaVersion must be 1/)
  })

  it('rejects empty or malformed acceptanceCriteria', () => {
    expect(() => validateBlockManifest({ ...validManifest, acceptanceCriteria: [] })).toThrow(/acceptanceCriteria must not be empty/)
    expect(() => validateBlockManifest({ ...validManifest, acceptanceCriteria: 'not-an-array' })).toThrow(/acceptanceCriteria must be an array/)
    expect(() => validateBlockManifest({ ...validManifest, acceptanceCriteria: [''] })).toThrow(/acceptanceCriteria must be an array/)
  })

  it('deduplicates and trims dependencies, and rejects malformed ones', () => {
    expect(validateBlockManifest({ ...validManifest, dependencies: [' B-0 ', 'B-0', 'B-2'] }).dependencies).toEqual(['B-0', 'B-2'])
    expect(() => validateBlockManifest({ ...validManifest, dependencies: [1] })).toThrow(/dependencies must be an array/)
  })

  it('rejects a non-positive or non-integer wave', () => {
    expect(() => validateBlockManifest({ ...validManifest, wave: 0 })).toThrow(/wave must be a positive integer/)
    expect(() => validateBlockManifest({ ...validManifest, wave: 1.5 })).toThrow(/wave must be a positive integer/)
  })

  it('rejects an invalid status', () => {
    expect(() => validateBlockManifest({ ...validManifest, status: 'not-a-status' })).toThrow(/status is invalid/)
  })

  it('rejects a malformed budget object and non-integer budget fields', () => {
    expect(() => validateBlockManifest({ ...validManifest, budget: 'nope' })).toThrow(/budget must be an object/)
    expect(() => validateBlockManifest({ ...validManifest, budget: [] })).toThrow(/budget must be an object/)
    expect(() => validateBlockManifest({ ...validManifest, budget: { maxMinutes: 0 } })).toThrow(/budget.maxMinutes must be a positive integer/)
    expect(() => validateBlockManifest({ ...validManifest, budget: { maxAttempts: -1 } })).toThrow(/budget.maxAttempts must be a positive integer/)
  })

  it('accepts a budget with only one of maxMinutes/maxAttempts set', () => {
    expect(validateBlockManifest({ ...validManifest, budget: { maxMinutes: 10 } }).budget).toEqual({ maxMinutes: 10 })
    expect(validateBlockManifest({ ...validManifest, budget: {} }).budget).toEqual({})
  })

  it('rejects malformed humanGates or sourceHash when provided', () => {
    expect(() => validateBlockManifest({ ...validManifest, humanGates: [42] })).toThrow(/humanGates must be an array/)
    expect(() => validateBlockManifest({ ...validManifest, sourceHash: '' })).toThrow(/sourceHash must be a non-empty string/)
  })

  it('rejects a non-string/empty id, title, tracker, or repository', () => {
    expect(() => validateBlockManifest({ ...validManifest, id: '' })).toThrow(/id must be a non-empty string/)
    expect(() => validateBlockManifest({ ...validManifest, title: 42 })).toThrow(/title must be a non-empty string/)
  })
})

describe('assessBlock', () => {
  it('reports blocked with a "complete dependencies" hint when dependencies are unmet, regardless of status', () => {
    const manifest = { ...validManifest, dependencies: ['B-0'], status: 'blocked' as const }
    const result = assessBlock(manifest, [])
    expect(result).toMatchObject({ status: 'blocked', blockers: ['B-0'], next: ['Complete dependencies: B-0'] })
  })

  it('reports blocked with a "resolve the recorded blocker" hint when status is blocked but dependencies are met', () => {
    const manifest = { ...validManifest, dependencies: ['B-0'], status: 'blocked' as const }
    const result = assessBlock(manifest, ['B-0'])
    expect(result).toMatchObject({ status: 'blocked', blockers: [], next: ['Resolve the recorded blocker before dispatch.'] })
  })

  it('reports ready with a dispatch hint when dependencies are met and status is not blocked', () => {
    const manifest = { ...validManifest, dependencies: ['B-0'], status: 'todo' as const }
    const result = assessBlock(manifest, ['B-0'])
    expect(result).toMatchObject({ status: 'ready', blockers: [], next: ['Dispatch the block with the frozen acceptance criteria.'] })
    expect(result.manifestHash).toHaveLength(64)
  })

  it('rejects a completed-dependency entry that is not a non-empty string', () => {
    expect(() => assessBlock(validManifest, [''])).toThrow(/completedDependencies\[\] must be a non-empty string/)
  })
})
