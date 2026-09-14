import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDocBridgeContextProvider, inspectDocBridgeIndex } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-doc-bridge-gaps-')); cleanups.push(dir); mkdirSync(join(dir, '.doc-bridge'), { recursive: true }); return dir }
const writeIndex = (root: string, value: unknown): void => writeFileSync(join(root, '.doc-bridge', 'index.json'), typeof value === 'string' ? value : JSON.stringify(value))

describe('inspectDocBridgeIndex', () => {
  it('reports present:false with a null ageHours when the index file does not exist', () => {
    const inspection = inspectDocBridgeIndex(tempRoot())
    expect(inspection).toMatchObject({ present: false, contentHash: null, mtimeMs: null, ageHours: null, error: null })
  })

  it('reports the error message when the index is present but unreadable JSON', () => {
    const root = tempRoot()
    writeIndex(root, 'not json')
    const inspection = inspectDocBridgeIndex(root)
    expect(inspection.present).toBe(true)
    expect(inspection.error).toContain('JSON')
  })

  it('falls back to a hash of the whole document when contentHash is absent or empty', () => {
    const root = tempRoot()
    writeIndex(root, { knowledge: [] })
    const inspection = inspectDocBridgeIndex(root)
    expect(inspection.contentHash).toHaveLength(64)
  })
})

describe('createDocBridgeContextProvider: missing index under an age budget', () => {
  it('still fails (via the read attempt) when the index is missing and maxAgeHours is set', async () => {
    const root = tempRoot()
    await expect(createDocBridgeContextProvider({ root, maxAgeHours: 24 }).resolve({ query: 'x' })).rejects.toThrow()
  })
})

describe('createDocBridgeContextProvider: query/scope matching edge cases', () => {
  it('returns no references for a blank query', async () => {
    const root = tempRoot()
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [{ id: 'x', path: 'x.md', body: 'anything' }] })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: '   ' })
    expect(result.references).toEqual([])
  })

  it('ignores an empty scope array (treated as no scope filter)', async () => {
    const root = tempRoot()
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [{ id: 'x', path: 'x.md', body: 'auth boundary' }] })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: 'auth', scope: [] })
    expect(result.references.map((r) => r.id)).toEqual(['x'])
  })

  it('matches a CJK query token by substring rather than the word-boundary regex', async () => {
    const root = tempRoot()
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [{ id: 'x', path: 'x.md', body: '認証と権限の説明' }] })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: '認証' })
    expect(result.references.map((r) => r.id)).toEqual(['x'])
  })

  it('treats a non-array knowledge field as empty', async () => {
    const root = tempRoot()
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: 'not-an-array' })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: 'anything' })
    expect(result.references).toEqual([])
  })
})

describe('createDocBridgeContextProvider: ownership entries', () => {
  it('ignores a malformed lookup/ownership shape and an owner entry with no usable path', async () => {
    const root = tempRoot()
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [], lookup: 'not-an-object' })
    expect((await createDocBridgeContextProvider({ root }).resolve({ query: 'x' })).references).toEqual([])

    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [], lookup: { ownership: 'not-an-object' } })
    expect((await createDocBridgeContextProvider({ root }).resolve({ query: 'x' })).references).toEqual([])

    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [], lookup: { ownership: { a: null } } })
    expect((await createDocBridgeContextProvider({ root }).resolve({ query: 'x' })).references).toEqual([])

    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [], lookup: { ownership: { a: { purpose: 'no path here' } } } })
    expect((await createDocBridgeContextProvider({ root }).resolve({ query: 'purpose' })).references).toEqual([])
  })

  it('falls back to the raw "path" field when agentDoc is absent, and omits body when nothing textual is set', async () => {
    const root = tempRoot()
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [], lookup: { ownership: { a: { path: 'src/a', id: 'custom-id' } } } })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: 'custom-id' })
    expect(result.references).toMatchObject([{ id: 'custom-id', uri: 'doc-bridge://src/a' }])
  })
})

describe('createDocBridgeContextProvider: ranking and reference shaping', () => {
  it('prefers an ownership entry over a same-scoring knowledge entry with the same path', async () => {
    const root = tempRoot()
    writeIndex(root, {
      contentHash: 'a'.repeat(64),
      knowledge: [{ id: 'from-knowledge', path: 'shared.md', body: 'shared topic' }],
      lookup: { ownership: { x: { path: 'shared.md', purpose: 'shared topic' } } },
    })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: 'shared' })
    expect(result.references).toHaveLength(1)
    expect(result.references[0]?.id).toBe('x')
  })

  it('caps results at 8 entries even when more score above zero', async () => {
    const root = tempRoot()
    const knowledge = Array.from({ length: 12 }, (_, i) => ({ id: `doc-${i}`, path: `doc-${i}.md`, body: 'shared keyword' }))
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: 'shared' })
    expect(result.references).toHaveLength(8)
  })

  it('omits title when absent and uses the per-entry contentHash when present, falling back to the document hash otherwise', async () => {
    const root = tempRoot()
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [{ id: 'no-title', path: 'x.md', body: 'keyword', contentHash: 'b'.repeat(64) }, { id: 'has-title', path: 'y.md', title: 'Y', body: 'keyword' }] })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: 'keyword' })
    const noTitle = result.references.find((r) => r.id === 'no-title')
    const hasTitle = result.references.find((r) => r.id === 'has-title')
    expect(noTitle).not.toHaveProperty('title')
    expect(noTitle?.contentHash).toBe('b'.repeat(64))
    expect(hasTitle?.title).toBe('Y')
    expect(hasTitle?.contentHash).toBe('a'.repeat(64))
  })

  it('skips a candidate whose id or path is not a usable string', async () => {
    const root = tempRoot()
    writeIndex(root, { contentHash: 'a'.repeat(64), knowledge: [{ id: 123, path: 'x.md', body: 'keyword' }] })
    const result = await createDocBridgeContextProvider({ root }).resolve({ query: 'keyword' })
    expect(result.references).toEqual([])
  })
})
