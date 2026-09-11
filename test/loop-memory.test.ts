import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderContractPrompt, resolveDocContext } from '../src/loop/contract.js'
import { renderWorkerBrief } from '../src/loop/brief.js'
import {
  createFileMemoryAdapter, learningToMemoryRecord, planMemoryContext, preferMemoryOverDocBridge,
  promoteLearningsToMemory, selectMemoryForPrompt, upsertProposedLearnings,
} from '../src/loop/memory.js'
import { LoopConfigSchema } from '../src/loop/config.js'
import type { LearningRecord } from '../src/kernel/learning.js'

const baseConfig = () => LoopConfigSchema.parse({
  project: { name: 'demo', repo: 'Acme/demo', stateDir: '.codex/loop' },
  linear: { workspaceId: 'ws', teamKey: 'ENG', person: 'alice' },
  models: {
    orchestrator: [['claude/opus']],
    reviewer: [['claude/opus']],
    builder: [['claude/sonnet']],
    watcher: [['claude/haiku']],
    providers: {
      claude: { bin: 'claude', auth: 'subscription', tui: 'claude --model {model}', headless: ['claude', '-p', '{prompt}', '--model', '{model}'] },
    },
  },
  delivery: { verifyCommand: 'pnpm test' },
  memory: {
    enabled: true,
    preferOverDocBridge: true,
    minDocBridgeWhenMemory: 1,
    maxRecall: 3,
    maxSummaryChars: 80,
    maxBlockChars: 400,
    shrinkIssueCharsWhenMemory: true,
    issueCharsWithMemory: 1000,
    categories: ['adjustment'],
  },
})

describe('loop memory', () => {
  it('selectMemoryForPrompt caps the block and drops stale by default', () => {
    const config = baseConfig().memory
    const hits = [
      { record: { id: 'L-1', scope: 'project' as const, summary: 'Always run package tests before PR', source: 'loop-retro:demo', sourceRevision: 'a', contentHash: 'h1', approved: true as const }, relevant: true, stale: false },
      { record: { id: 'L-2', scope: 'project' as const, summary: 'Old rule', source: 'loop-retro:demo', sourceRevision: 'b', contentHash: 'h2', approved: true as const }, relevant: true, stale: true },
    ]
    const selected = selectMemoryForPrompt(hits, config)
    expect(selected.hits).toHaveLength(1)
    expect(selected.block).toContain('Approved memory')
    expect(selected.block).toContain('Always run package tests')
    expect(selected.approxChars).toBeLessThanOrEqual(config.maxBlockChars)
  })

  it('preferMemoryOverDocBridge shrinks refs while keeping a minimum', () => {
    const hits = [{
      record: { id: 'L-1', scope: 'project' as const, summary: 'playbook conventions for agents', source: 'docs/playbook', sourceRevision: 'a', contentHash: 'same', approved: true as const },
      relevant: true,
      stale: false,
    }]
    const refs = [
      { id: 'playbook-1', uri: 'doc-bridge://docs/playbook.md', title: 'Playbook conventions', contentHash: 'same' },
      { id: 'other', uri: 'doc-bridge://docs/other.md', title: 'Other' },
      { id: 'extra', uri: 'doc-bridge://docs/extra.md', title: 'Extra' },
    ]
    const result = preferMemoryOverDocBridge(refs, hits, 1)
    expect(result.references.length).toBeLessThan(refs.length)
    expect(result.references.length).toBeGreaterThanOrEqual(1)
    expect(result.dropped).toBeGreaterThan(0)
  })

  it('planMemoryContext reduces issue char budget when hits exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-mem-'))
    const adapter = createFileMemoryAdapter(dir)
    await adapter.remember({
      id: 'L-keep',
      scope: 'project',
      summary: 'Prefer package-scoped vitest for touched packages',
      source: 'loop-retro:demo|adjustment',
      sourceRevision: 'rev1',
      contentHash: 'c1',
      approved: true,
    })
    const config = baseConfig()
    const plan = await planMemoryContext({
      adapter,
      config,
      issueId: 'ENG-1',
      issueTitle: 'vitest packages',
      project: 'demo',
      references: [
        { id: 'a', uri: 'doc-bridge://a.md', title: 'Prefer package-scoped vitest' },
        { id: 'b', uri: 'doc-bridge://b.md', title: 'Unrelated' },
      ],
    })
    expect(plan.hits.length).toBeGreaterThan(0)
    expect(plan.memoryBlock).toContain('Approved memory')
    expect(plan.issueCharBudget).toBe(config.memory.issueCharsWithMemory)
    expect(plan.docBridgeAfter).toBeLessThanOrEqual(plan.docBridgeBefore)
    expect(plan.approxCharsSaved).toBeGreaterThanOrEqual(0)
  })

  it('renderContractPrompt and brief include memory and shrink issue text', () => {
    const config = baseConfig()
    const issue = {
      id: '1', identifier: 'ENG-1', title: 't', url: 'u', state: 'Todo', stateType: 'unstarted',
      assignee: 'alice', assigneeId: null, labels: [], priority: 0, priorityLabel: 'None', project: null,
      branchName: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      description: 'x'.repeat(5000), comments: [],
    }
    const memoryBlock = '## Approved memory (must follow)\n- [project] Prefer package tests\n'
    const prompt = renderContractPrompt({
      issue,
      config,
      references: [{ id: 'r', uri: 'doc-bridge://r.md' }],
      memoryBlock,
      maxIssueChars: 1000,
    })
    expect(prompt).toContain('Approved memory')
    expect(prompt).toContain('Prefer package tests')
    expect(prompt.length).toBeLessThan(issue.description.length + 4000)

    const brief = renderWorkerBrief({
      issue,
      contract: {
        schemaVersion: 1,
        issue: 'ENG-1',
        issueUpdatedAt: issue.updatedAt,
        generatedAt: issue.updatedAt,
        provider: 'claude',
        model: 'opus',
        contract: {
          intent: 'do the thing',
          scope: { inScope: ['src'], outOfScope: [] },
          outcomes: [{ id: 'o1', description: 'tests pass', check: { kind: 'test', command: 'pnpm test' } }],
          ambiguities: [],
          touchpoints: [],
          risks: [],
        },
        digest: 'abc',
        assessment: { dispatchable: true, reasons: [] },
        source: 'manual',
      },
      config,
      branch: 'alice/eng-1',
      provider: 'claude',
      model: 'sonnet',
      memoryBlock,
      maxIssueChars: 1000,
      guidanceRefs: [{ id: 'pb', uri: 'doc-bridge://docs/playbook.md', title: 'Playbook' }],
    })
    expect(brief).toContain('Approved memory')
    expect(brief).toContain('Repository guidance')
    expect(brief).toContain('docs/playbook.md')
  })

  it('promoteLearningsToMemory requires human and writes approved records', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-learn-'))
    const proposed: LearningRecord = {
      id: 'L-abc',
      source: 'loop-retro:demo:2026-09-11',
      category: 'adjustment',
      text: 'Raise review floor to high for cloud PRs',
      status: 'proposed',
      recordedAt: '2026-09-11T00:00:00Z',
    }
    upsertProposedLearnings(stateDir, [proposed])
    const adapter = createFileMemoryAdapter(join(stateDir, 'memory'))
    await expect(promoteLearningsToMemory({
      stateDir,
      config: baseConfig(),
      adapter,
      ids: ['L-abc'],
      actor: 'bot',
      sourceRevision: 'rev',
    })).rejects.toThrow(/human/i)

    const result = await promoteLearningsToMemory({
      stateDir,
      config: baseConfig(),
      adapter,
      ids: ['L-abc'],
      actor: 'human',
      sourceRevision: 'rev',
    })
    expect(result.remembered).toEqual(['L-abc'])
    const hits = await adapter.recall({ query: 'review floor', project: 'demo' })
    expect(hits.some((hit) => hit.record.id === 'L-abc')).toBe(true)
    expect(learningToMemoryRecord(proposed, { project: 'demo', sourceRevision: 'rev' }).approved).toBe(true)
  })

  it('resolveDocContext accepts scopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-bridge-'))
    mkdirSync(join(root, '.doc-bridge'), { recursive: true })
    writeFileSync(join(root, '.doc-bridge', 'index.json'), JSON.stringify({
      contentHash: 'h',
      knowledge: [
        { id: 'pb', type: 'doc', title: 'Playbook', path: 'docs/playbook.md', description: 'playbook practices', tags: ['playbook'], contentHash: 'h' },
        { id: 'other', type: 'doc', title: 'Other', path: 'docs/other.md', description: 'misc', tags: ['other'], contentHash: 'h' },
      ],
    }))
    const refs = await resolveDocContext(root, 'practices', 8, ['playbook'])
    expect(refs.some((ref) => ref.id === 'pb')).toBe(true)
  })
})
