import { describe, expect, it } from 'vitest'
import { createStatusSnapshot, validateStatusSnapshot } from '../src/index.js'

const base = { generatedAt: '2026-01-01T00:00:00.000Z', sourceRevision: 'abc', blocks: [{ id: 'B-1', status: 'todo' as const }] }

describe('createStatusSnapshot', () => {
  it('sorts blocks by id and includes optional machine/metrics/next fields', () => {
    const snapshot = createStatusSnapshot({ ...base, blocks: [{ id: 'B-2', status: 'todo' }, { id: 'B-1', status: 'done' }], metrics: { durationMs: 10 }, next: 'ship it' })
    expect(snapshot.blocks.map((b) => b.id)).toEqual(['B-1', 'B-2'])
    expect(snapshot.metrics).toEqual({ durationMs: 10 })
    expect(snapshot.next).toBe('ship it')
  })

  it('rejects a missing/blank sourceRevision', () => {
    expect(() => createStatusSnapshot({ ...base, sourceRevision: '' })).toThrow(/sourceRevision must be a non-empty string/)
  })

  it('rejects an invalid generatedAt timestamp', () => {
    expect(() => createStatusSnapshot({ ...base, generatedAt: 'not-a-date' })).toThrow(/generatedAt must be a valid timestamp/)
  })

  it('rejects a non-array blocks field', () => {
    expect(() => createStatusSnapshot({ ...base, blocks: 'nope' as never })).toThrow(/blocks must be an array/)
  })

  it('rejects a malformed block entry', () => {
    expect(() => createStatusSnapshot({ ...base, blocks: [null as never] })).toThrow(/blocks\[0\] must be an object/)
    expect(() => createStatusSnapshot({ ...base, blocks: [{ id: '', status: 'todo' } as never] })).toThrow(/blocks\[0\].id is required/)
    expect(() => createStatusSnapshot({ ...base, blocks: [{ id: 'B-1', status: 'not-a-status' } as never] })).toThrow(/blocks\[0\].status is invalid/)
  })

  it('rejects metrics with a blank key, non-numeric, non-finite, or negative value', () => {
    expect(() => createStatusSnapshot({ ...base, metrics: { '': 1 } })).toThrow(/metrics must contain finite non-negative numbers/)
    expect(() => createStatusSnapshot({ ...base, metrics: { x: Number.NaN } })).toThrow(/metrics must contain finite non-negative numbers/)
    expect(() => createStatusSnapshot({ ...base, metrics: { x: -1 } })).toThrow(/metrics must contain finite non-negative numbers/)
  })

  it('treats a blank next field as omitted rather than validating it', () => {
    expect(createStatusSnapshot({ ...base, next: '' }).next).toBeUndefined()
  })
})

describe('validateStatusSnapshot', () => {
  it('round-trips a snapshot created by createStatusSnapshot', () => {
    const snapshot = createStatusSnapshot(base)
    expect(validateStatusSnapshot(snapshot)).toEqual(snapshot)
  })

  it('rejects a non-object value', () => {
    expect(() => validateStatusSnapshot(null)).toThrow(/must be an object/)
    expect(() => validateStatusSnapshot([])).toThrow(/must be an object/)
  })

  it('rejects a tampered digest or wrong schemaVersion', () => {
    const snapshot = createStatusSnapshot(base)
    expect(() => validateStatusSnapshot({ ...snapshot, digest: 'tampered' })).toThrow(/digest or schemaVersion is invalid/)
    expect(() => validateStatusSnapshot({ ...snapshot, schemaVersion: 2 as never })).toThrow(/digest or schemaVersion is invalid/)
  })
})
