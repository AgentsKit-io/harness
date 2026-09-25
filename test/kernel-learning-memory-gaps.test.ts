import { describe, expect, it } from 'vitest'
import { createInMemoryMemoryAdapter, createKvMemoryAdapter, parseRetro, promoteLearnings, validateMemoryRecord } from '../src/index.js'
import type { AgentMemoryRecord } from '../src/index.js'

describe('parseRetro', () => {
  it('rejects blank markdown, blank source, and an invalid recordedAt', () => {
    expect(() => parseRetro('', 'B-1')).toThrow(/markdown/)
    expect(() => parseRetro('- item', '  ')).toThrow(/source/)
    expect(() => parseRetro('- item', 'B-1', 'not-a-date')).toThrow(/recordedAt/)
  })

  it('categorizes a "went well" heading as worked', () => {
    const records = parseRetro('## What went well\n- Tests caught the regression early', 'B-1')
    expect(records).toEqual([expect.objectContaining({ category: 'worked' })])
  })

  it('defaults uncategorized lines before any heading to "other"', () => {
    const records = parseRetro('- No heading yet', 'B-1')
    expect(records[0]?.category).toBe('other')
  })

  it('ignores headings and lines that are not list items', () => {
    const records = parseRetro('## Problems\nJust a sentence, not a list item.\n\n- Real item', 'B-1')
    expect(records).toHaveLength(1)
    expect(records[0]?.text).toBe('Real item')
  })

  it('strips checkbox markers from list items', () => {
    const records = parseRetro('## Adjustments\n- [x] Narrow the diff scope', 'B-1')
    expect(records[0]?.text).toBe('Narrow the diff scope')
  })

  it('deduplicates identical items within the same category and source', () => {
    const records = parseRetro('## Problems\n- Flaky test\n- Flaky test', 'B-1')
    expect(records).toHaveLength(1)
  })

  it('produces distinct ids for the same text under different categories', () => {
    const records = parseRetro('## Problems\n- Same wording\n## Adjustments\n- Same wording', 'B-1')
    expect(records).toHaveLength(2)
    expect(records[0]?.id).not.toBe(records[1]?.id)
  })
})

describe('promoteLearnings', () => {
  const records = parseRetro('## Problems\n- Tests were too broad', 'B-1')

  it('accepts the automated promoter as a named actor of its own (ADR-0019 amendment)', () => {
    const promoted = promoteLearnings(records, { actor: 'loop-auto', ids: [records[0]!.id] })
    expect(promoted[0]).toMatchObject({ id: records[0]!.id, status: 'promoted' })
  })

  it('requires a human or the automated promoter', () => {
    expect(() => promoteLearnings(records, { actor: 'agent', ids: [records[0]!.id] })).toThrow(/human or "loop-auto" actor/)
  })

  it('rejects a blank id in the ids list', () => {
    expect(() => promoteLearnings(records, { actor: 'human', ids: ['  '] })).toThrow(/ids\[\]/)
  })

  it('rejects unknown learning ids', () => {
    expect(() => promoteLearnings(records, { actor: 'human', ids: ['L-does-not-exist'] })).toThrow(/Unknown learning IDs: L-does-not-exist/)
  })

  it('defaults to "promoted" and supports explicit "rejected"', () => {
    expect(promoteLearnings(records, { actor: 'human', ids: [records[0]!.id] })[0]?.status).toBe('promoted')
    expect(promoteLearnings(records, { actor: 'human', ids: [records[0]!.id], status: 'rejected' })[0]?.status).toBe('rejected')
  })

  it('leaves records whose id is not targeted unchanged', () => {
    const other = { ...records[0]!, id: 'L-other' }
    const result = promoteLearnings([records[0]!, other], { actor: 'human', ids: [records[0]!.id] })
    expect(result[1]).toEqual(other)
  })
})

const record = (overrides: Partial<AgentMemoryRecord> = {}): AgentMemoryRecord => ({ id: 'm1', scope: 'global', summary: 'summary', source: 'source', sourceRevision: 'rev', contentHash: 'hash', approved: true, ...overrides })

describe('validateMemoryRecord', () => {
  it('rejects a blank id, summary, source, sourceRevision, or contentHash', () => {
    expect(() => validateMemoryRecord(record({ id: '  ' }))).toThrow(/memory.id/)
    expect(() => validateMemoryRecord(record({ summary: '' }))).toThrow(/memory.summary/)
    expect(() => validateMemoryRecord(record({ source: '' }))).toThrow(/memory.source/)
    expect(() => validateMemoryRecord(record({ sourceRevision: '' }))).toThrow(/memory.sourceRevision/)
    expect(() => validateMemoryRecord(record({ contentHash: '' }))).toThrow(/memory.contentHash/)
  })

  it('rejects an invalid scope', () => {
    expect(() => validateMemoryRecord(record({ scope: 'nope' as never }))).toThrow(/memory.scope/)
  })

  it('rejects a record that is not approved', () => {
    expect(() => validateMemoryRecord(record({ approved: false as never }))).toThrow(/approved memory/)
  })

  it('returns the record unchanged when valid', () => {
    expect(validateMemoryRecord(record())).toEqual(record())
  })
})

describe('createInMemoryMemoryAdapter', () => {
  it('matches issue and project scoped records by source substring and reports telemetry', async () => {
    const adapter = createInMemoryMemoryAdapter()
    await adapter.remember(record({ id: 'issue-rec', scope: 'issue', source: 'linear:ABC-1' }))
    await adapter.remember(record({ id: 'project-rec', scope: 'project', source: 'project:harness' }))
    expect((await adapter.recall({ query: '', issueId: 'ABC-1' })).map((hit) => hit.record.id)).toEqual(['issue-rec'])
    expect((await adapter.recall({ query: '', issueId: 'no-match' }))).toEqual([])
    expect((await adapter.recall({ query: '', project: 'harness' })).map((hit) => hit.record.id)).toEqual(['project-rec'])
    expect((await adapter.recall({ query: '', project: 'no-match' }))).toEqual([])
    expect(adapter.telemetry?.()).toMatchObject({ status: 'measured', memoryWrites: 2 })
  })
})

describe('createKvMemoryAdapter', () => {
  const kv = () => {
    const store = new Map<string, unknown>()
    return { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) } }
  }

  it('reports telemetry, tolerates a non-array index, and skips re-adding an already-indexed id', async () => {
    const store = kv()
    const adapter = createKvMemoryAdapter(store)
    expect(await store.get('agentskit-harness:memory:index')).toBeUndefined()
    await adapter.remember(record({ id: 'm1' }))
    await adapter.remember(record({ id: 'm1', summary: 'updated summary' }))
    expect(await store.get('agentskit-harness:memory:index')).toEqual(['m1'])
    expect(adapter.telemetry?.()).toMatchObject({ status: 'measured', memoryWrites: 2 })
  })

  it('recalls an empty result set when nothing has ever been remembered', async () => {
    const adapter = createKvMemoryAdapter(kv())
    expect(await adapter.recall({ query: '' })).toEqual([])
  })

  it('matches issue and project scoped records and marks stale recalls', async () => {
    const adapter = createKvMemoryAdapter(kv())
    await adapter.remember(record({ id: 'issue-rec', scope: 'issue', source: 'linear:ABC-1', sourceRevision: 'rev-1' }))
    await adapter.remember(record({ id: 'project-rec', scope: 'project', source: 'project:harness' }))
    expect((await adapter.recall({ query: '', issueId: 'ABC-1' })).map((hit) => hit.record.id)).toEqual(['issue-rec'])
    expect((await adapter.recall({ query: '', issueId: 'no-match' }))).toEqual([])
    expect((await adapter.recall({ query: '', project: 'harness' })).map((hit) => hit.record.id)).toEqual(['project-rec'])
    expect((await adapter.recall({ query: '', issueId: 'ABC-1', sourceRevision: 'rev-2' }))[0]).toMatchObject({ stale: true })
  })
})
