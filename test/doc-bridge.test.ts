import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HarnessError, createDocBridgeContextProvider } from '../src/index.js'

it('resolves real indexed knowledge with a stable source and snapshot hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-doc-bridge-test-'))
  mkdirSync(join(root, '.doc-bridge'), { recursive: true })
  writeFileSync(join(root, '.doc-bridge', 'index.json'), JSON.stringify({ schemaVersion: 1, contentHash: 'a'.repeat(64), contentHashAlgo: 'sha256-normalized-v1', knowledge: [{ id: 'playbook-harness', type: 'guide', title: 'Harness guide', path: 'content/docs/harness.md', body: 'Portable harness verification' }, { id: 'other', type: 'guide', title: 'Other', path: 'content/docs/other.md', body: 'Unrelated content' }] }))
  const provider = createDocBridgeContextProvider({ root })
  const first = await provider.resolve({ query: 'harness', scope: ['playbook'] })
  const second = await provider.resolve({ query: 'harness', scope: ['playbook'] })
  expect(first.references.map((reference) => reference.id)).toEqual(['playbook-harness'])
  expect(first.sourceHash).toBe('a'.repeat(64))
  expect(first.snapshotHash).toBe(second.snapshotHash)
  expect(first.references[0]?.uri).toBe('doc-bridge://content/docs/harness.md')
})

it('fails clearly when the configured index is missing', async () => {
  const provider = createDocBridgeContextProvider({ root: mkdtempSync(join(tmpdir(), 'agentskit-harness-doc-bridge-missing-')) })
  await expect(provider.resolve({ query: 'harness' })).rejects.toThrow()
})

it('rejects an index beyond the configured age budget before returning context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-doc-bridge-stale-'))
  mkdirSync(join(root, '.doc-bridge'), { recursive: true })
  const path = join(root, '.doc-bridge', 'index.json')
  writeFileSync(path, JSON.stringify({ contentHash: 'c'.repeat(64), knowledge: [{ id: 'guide', path: 'docs/guide.md', title: 'Guide', body: 'Reliable context' }] }))
  const old = new Date('2020-01-01T00:00:00.000Z')
  utimesSync(path, old, old)
  const provider = createDocBridgeContextProvider({ root, maxAgeHours: 24, now: () => new Date('2020-01-03T00:00:00.000Z').getTime() })
  await expect(provider.resolve({ query: 'guide' })).rejects.toThrow('refresh it before resolving context')
  await provider.resolve({ query: 'guide' }).catch((error: unknown) => {
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).code).toBe('STALE')
  })
})

it('fails with a classified error when the index cannot be parsed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-doc-bridge-unreadable-'))
  mkdirSync(join(root, '.doc-bridge'), { recursive: true })
  writeFileSync(join(root, '.doc-bridge', 'index.json'), 'not json')
  const provider = createDocBridgeContextProvider({ root, maxAgeHours: 24 })
  await expect(provider.resolve({ query: 'guide' })).rejects.toThrow('Doc Bridge index is unreadable')
  await provider.resolve({ query: 'guide' }).catch((error: unknown) => {
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).code).toBe('INVALID_STATE')
  })
})

it('abstains on unrelated terms and ranks grounded token matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-doc-bridge-ranking-'))
  mkdirSync(join(root, '.doc-bridge'), { recursive: true })
  writeFileSync(join(root, '.doc-bridge', 'index.json'), JSON.stringify({
    schemaVersion: 1,
    contentHash: 'b'.repeat(64),
    contentHashAlgo: 'sha256-normalized-v1',
    knowledge: [
      { id: 'auth', type: 'guide', title: 'Auth', path: 'docs/auth.md', body: 'Authentication boundaries.' },
      { id: 'other', type: 'guide', title: 'Other', path: 'docs/other.md', body: 'Authoritative billing notes.' },
    ],
  }))
  const provider = createDocBridgeContextProvider({ root })
  const grounded = await provider.resolve({ query: 'auth' })
  const unrelated = await provider.resolve({ query: 'zxqvnomatch987654321' })
  expect(grounded.references.map((reference) => reference.id)).toEqual(['auth'])
  expect(grounded.references[0]?.relevance).toBe(1)
  expect(unrelated.references).toEqual([])
})

it('resolves ownership records when they are not duplicated in knowledge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-doc-bridge-ownership-'))
  mkdirSync(join(root, '.doc-bridge'), { recursive: true })
  writeFileSync(join(root, '.doc-bridge', 'index.json'), JSON.stringify({
    schemaVersion: 1,
    contentHash: 'd'.repeat(64),
    knowledge: [],
    lookup: { ownership: { 'billing-core': { path: 'packages/billing-core', purpose: 'Billing contracts', agentDoc: 'docs/billing-core.md' } } },
  }))

  const result = await createDocBridgeContextProvider({ root }).resolve({ query: 'billing-core' })
  expect(result.references).toMatchObject([{ id: 'billing-core', uri: 'doc-bridge://docs/billing-core.md' }])
  expect(result.references[0]).not.toHaveProperty('title')
})
