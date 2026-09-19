import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LearningRecord } from '../src/kernel/learning.js'
import type { AgentMemoryAdapter, AgentMemoryHit } from '../src/kernel/memory.js'
import { LoopConfigSchema } from '../src/loop/config.js'
import {
  createFileMemoryAdapter, createFileMemoryKvStore, memoryDigestOf, openLoopMemory, planMemoryContext,
  preferMemoryOverDocBridge, promoteLearningsToMemory, selectMemoryForPrompt, upsertProposedLearnings,
} from '../src/loop/memory.js'
import type { LoadedLoopConfig } from '../src/loop/config.js'

const baseConfig = (memory: Record<string, unknown> = {}) => LoopConfigSchema.parse({
  project: { name: 'demo', repo: 'Acme/demo', stateDir: '.ak-loop' },
  linear: { workspaceId: 'ws', teamKey: 'ENG', person: 'alice' },
  models: {
    orchestrator: [['claude/opus']],
    reviewer: [['claude/opus']],
    builder: [['claude/sonnet']],
    watcher: [['claude/haiku']],
    providers: { claude: { bin: 'claude', auth: 'subscription', tui: 'claude --model {model}', headless: ['claude', '-p', '{prompt}', '--model', '{model}'] } },
  },
  delivery: { verifyCommand: 'pnpm test' },
  memory: {
    enabled: true, preferOverDocBridge: true, minDocBridgeWhenMemory: 1, maxRecall: 3, maxSummaryChars: 80,
    maxBlockChars: 400, shrinkIssueCharsWhenMemory: true, issueCharsWithMemory: 1000, categories: ['adjustment'],
    ...memory,
  },
})

const loaded = (config: ReturnType<typeof baseConfig>, stateDir: string): LoadedLoopConfig => ({ path: join(stateDir, 'loop.config.yaml'), root: stateDir, stateDir, config, configHash: 'x'.repeat(64) })

describe('createFileMemoryKvStore', () => {
  it('returns undefined for a corrupt stored value instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-mem-kv-'))
    const store = createFileMemoryKvStore(dir)
    await store.set('key', { a: 1 })
    const path = join(dir, `${Buffer.from('key').toString('base64url')}.json`)
    writeFileSync(path, 'not-json', 'utf8')
    expect(await store.get('key')).toBeUndefined()
  })

  it('returns undefined for a key that was never set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-mem-kv-'))
    const store = createFileMemoryKvStore(dir)
    expect(await store.get('missing')).toBeUndefined()
  })
})

describe('openLoopMemory', () => {
  it('returns null when memory is disabled', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-mem-open-'))
    const config = baseConfig({ enabled: false })
    expect(openLoopMemory(loaded(config, stateDir))).toBeNull()
  })

  it('returns null when the backend is "none"', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-mem-open-'))
    const config = baseConfig({ backend: 'none' })
    expect(openLoopMemory(loaded(config, stateDir))).toBeNull()
  })

  it('returns a working adapter when memory is enabled with a file backend', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-mem-open-'))
    const config = baseConfig()
    const adapter = openLoopMemory(loaded(config, stateDir))
    expect(adapter).not.toBeNull()
    await adapter!.remember({ id: 'L-1', scope: 'global', summary: 'x', source: 's', sourceRevision: 'r', contentHash: 'h', approved: true })
    expect((await adapter!.recall({ query: 'x' })).length).toBeGreaterThan(0)
  })
})

describe('memoryDigestOf', () => {
  it('produces a deterministic digest from hit identity, hash, and staleness only', () => {
    const hits: readonly AgentMemoryHit[] = [{ record: { id: 'L-1', scope: 'project', summary: 'x', source: 's', sourceRevision: 'r', contentHash: 'h1', approved: true }, relevant: true, stale: false }]
    expect(memoryDigestOf(hits)).toBe(memoryDigestOf(hits))
    expect(memoryDigestOf([])).toHaveLength(64)
  })
})

describe('selectMemoryForPrompt', () => {
  it('excludes a hit whose scope is not in the allowed scopes', () => {
    const config = baseConfig({ scopes: ['issue'] }).memory
    const hits: readonly AgentMemoryHit[] = [{ record: { id: 'L-1', scope: 'project', summary: 'x', source: 's', sourceRevision: 'r', contentHash: 'h', approved: true }, relevant: true, stale: false }]
    expect(selectMemoryForPrompt(hits, config).hits).toEqual([])
  })

  it('stops adding lines once the block would exceed maxBlockChars', () => {
    const config = baseConfig({ maxBlockChars: 40, maxSummaryChars: 30, maxRecall: 10 }).memory
    const hit = (id: string): AgentMemoryHit => ({ record: { id, scope: 'project', summary: 'a fairly long summary line here', source: 's', sourceRevision: 'r', contentHash: 'h', approved: true }, relevant: true, stale: false })
    const selected = selectMemoryForPrompt([hit('L-1'), hit('L-2'), hit('L-3')], config)
    expect(selected.hits.length).toBeLessThan(3)
    expect(selected.approxChars).toBeLessThanOrEqual(config.maxBlockChars + 40)
  })
})

describe('preferMemoryOverDocBridge', () => {
  it('returns the references unchanged when there are no memory hits', () => {
    const refs = [{ id: 'a', uri: 'doc-bridge://a.md' }]
    expect(preferMemoryOverDocBridge(refs, [], 1)).toEqual({ references: refs, dropped: 0 })
  })
})

describe('planMemoryContext', () => {
  const references = [{ id: 'a', uri: 'doc-bridge://a.md', title: 'A' }]

  it('returns an empty plan when there is no adapter', async () => {
    const config = baseConfig()
    const plan = await planMemoryContext({ adapter: null, config, issueId: 'ENG-1', issueTitle: 't', project: 'demo', references })
    expect(plan).toMatchObject({ hits: [], memoryBlock: '', references, docBridgeBefore: 1, docBridgeAfter: 1 })
  })

  it('returns an empty plan when memory.enabled is false, even with an adapter present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-mem-plan-'))
    const adapter = createFileMemoryAdapter(dir)
    const config = baseConfig({ enabled: false })
    const plan = await planMemoryContext({ adapter, config, issueId: 'ENG-1', issueTitle: 't', project: 'demo', references })
    expect(plan.hits).toEqual([])
  })

  it('falls back to a project-scoped recall when the title-targeted recall finds nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-mem-plan-'))
    const adapter = createFileMemoryAdapter(dir)
    await adapter.remember({ id: 'L-1', scope: 'project', summary: 'unrelated wording entirely', source: 'demo', sourceRevision: 'r', contentHash: 'h', approved: true })
    const config = baseConfig()
    const plan = await planMemoryContext({ adapter, config, issueId: 'ENG-1', issueTitle: 'nothing matches this', project: 'demo', references })
    expect(plan.hits.length).toBeGreaterThan(0)
  })

  it('treats a throwing recall as no hits rather than failing the plan', async () => {
    const throwingAdapter: AgentMemoryAdapter = { id: 'x', version: '1', remember: async () => {}, recall: async () => { throw new Error('recall failed') } }
    const config = baseConfig()
    const plan = await planMemoryContext({ adapter: throwingAdapter, config, issueId: 'ENG-1', issueTitle: 't', project: 'demo', references })
    expect(plan.hits).toEqual([])
  })

  it('keeps every Doc Bridge reference when preferOverDocBridge is false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-mem-plan-'))
    const adapter = createFileMemoryAdapter(dir)
    await adapter.remember({ id: 'L-1', scope: 'project', summary: 'A', source: 'demo', sourceRevision: 'r', contentHash: 'h', approved: true })
    const config = baseConfig({ preferOverDocBridge: false })
    const plan = await planMemoryContext({ adapter, config, issueId: 'ENG-1', issueTitle: 'A', project: 'demo', references: [{ id: 'a', uri: 'doc-bridge://a.md', title: 'A' }] })
    expect(plan.docBridgeAfter).toBe(plan.docBridgeBefore)
  })

  it('does not shrink the issue char budget when shrinkIssueCharsWhenMemory is false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-mem-plan-'))
    const adapter = createFileMemoryAdapter(dir)
    await adapter.remember({ id: 'L-1', scope: 'project', summary: 'A', source: 'demo', sourceRevision: 'r', contentHash: 'h', approved: true })
    const config = baseConfig({ shrinkIssueCharsWhenMemory: false })
    const plan = await planMemoryContext({ adapter, config, issueId: 'ENG-1', issueTitle: 'A', project: 'demo', references })
    expect(plan.issueCharBudget).toBe(config.contract.maxIssueChars)
  })
})

describe('promoteLearningsToMemory edge cases', () => {
  const proposed: LearningRecord = { id: 'L-abc', source: 'loop-retro:demo', category: 'adjustment', text: 'do the thing', status: 'proposed', recordedAt: '2026-09-11T00:00:00Z' }

  it('skips remembering when there is no adapter, but still promotes the ledger', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-learn-gaps-'))
    upsertProposedLearnings(stateDir, [proposed])
    const result = await promoteLearningsToMemory({ stateDir, config: baseConfig(), adapter: null, ids: ['L-abc'], actor: 'human', sourceRevision: 'rev' })
    expect(result.remembered).toEqual([])
    expect(result.ledger.records[0]?.status).toBe('promoted')
  })

  it('skips remembering when memory.writeOnPromote is false', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-learn-gaps-'))
    upsertProposedLearnings(stateDir, [proposed])
    const adapter = createFileMemoryAdapter(join(stateDir, 'memory'))
    const result = await promoteLearningsToMemory({ stateDir, config: baseConfig({ writeOnPromote: false }), adapter, ids: ['L-abc'], actor: 'human', sourceRevision: 'rev' })
    expect(result.remembered).toEqual([])
  })

  it('skips a promoted record whose category is not in memory.categories', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-learn-gaps-'))
    const other: LearningRecord = { ...proposed, id: 'L-other', category: 'worked' }
    upsertProposedLearnings(stateDir, [other])
    const adapter = createFileMemoryAdapter(join(stateDir, 'memory'))
    const result = await promoteLearningsToMemory({ stateDir, config: baseConfig({ categories: ['adjustment'] }), adapter, ids: ['L-other'], actor: 'human', sourceRevision: 'rev' })
    expect(result.remembered).toEqual([])
  })

  it('skips a ledger record that is not among the requested ids, even if already promoted', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-learn-gaps-'))
    const already = { ...proposed, id: 'L-already', status: 'promoted' as const }
    const untouched = { ...proposed, id: 'L-untouched' }
    upsertProposedLearnings(stateDir, [already, untouched])
    const adapter = createFileMemoryAdapter(join(stateDir, 'memory'))
    const result = await promoteLearningsToMemory({ stateDir, config: baseConfig(), adapter, ids: ['L-untouched'], actor: 'human', sourceRevision: 'rev' })
    expect(result.remembered).toEqual(['L-untouched'])
  })
})
