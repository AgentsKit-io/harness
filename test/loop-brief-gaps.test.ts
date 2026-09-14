import { describe, expect, it } from 'vitest'
import { assessContract, parseLinearIssueDetail, renderHandoffBrief, renderWorkerBrief, validateLoopConfig } from '../src/index.js'
import type { StoredContract, TaskContract } from '../src/index.js'

const config = validateLoopConfig({
  project: { name: 'demo', repo: 'org/demo', baseBranch: 'main' },
  linear: { workspaceId: 'ws-1', teamKey: 'ENG', person: 'person' },
  models: {
    orchestrator: [['codex/gpt-5.6-sol']],
    reviewer: [['codex/gpt-5.6-sol']],
    builder: [['codex/gpt-5.6-sol']],
    watcher: [['codex/gpt-5.6-sol']],
    providers: { codex: { bin: 'codex', auth: 'subscription', tui: 'codex -m {model} --full-auto' } },
  },
  delivery: { verifyCommand: 'pnpm test' },
})

const issue = (overrides: { readonly description?: string; readonly comments?: readonly unknown[] } = {}) => parseLinearIssueDetail({
  issue: { id: 'i1', identifier: 'ENG-1', title: 'Title', url: 'https://linear.app/x', state: 'In Progress', updatedAt: '2026-01-01T00:00:00.000Z' },
  description: overrides.description ?? 'do the thing',
  comments: overrides.comments ?? [],
})

const bareContract: TaskContract = { intent: 'ship it', scope: { inScope: ['x'], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'works', check: { kind: 'manual' } }], ambiguities: [], touchpoints: [], risks: [] }

const stored = (contract: TaskContract): StoredContract => ({ schemaVersion: 1, issue: 'ENG-1', issueUpdatedAt: '2026-01-01T00:00:00.000Z', generatedAt: 'now', provider: 'codex', model: 'gpt-5.6-sol', contract, digest: 'd'.repeat(16), assessment: assessContract(contract), source: 'llm' })

describe('renderWorkerBrief', () => {
  it('omits the Doc Bridge guidance section when no guidanceRefs are supplied', () => {
    const brief = renderWorkerBrief({ issue: issue(), contract: stored(bareContract), config, branch: 'b', provider: 'claude', model: 'sonnet' })
    expect(brief).not.toContain('Repository guidance')
  })

  it('renders an outcome check with neither a command nor a note', () => {
    const brief = renderWorkerBrief({ issue: issue(), contract: stored(bareContract), config, branch: 'b', provider: 'claude', model: 'sonnet' })
    expect(brief).toContain('- o1: works\n  check: manual')
  })

  it('renders an outcome check note when one is provided', () => {
    const withNote: TaskContract = { ...bareContract, outcomes: [{ id: 'o1', description: 'works', check: { kind: 'manual', note: 'verify by hand' } }] }
    const brief = renderWorkerBrief({ issue: issue(), contract: stored(withNote), config, branch: 'b', provider: 'claude', model: 'sonnet' })
    expect(brief).toContain('- o1: works\n  check: manual (verify by hand)')
  })

  it('includes the Doc Bridge guidance section when guidanceRefs are supplied', () => {
    const brief = renderWorkerBrief({ issue: issue(), contract: stored(bareContract), config, branch: 'b', provider: 'claude', model: 'sonnet', guidanceRefs: [{ id: 'r1', uri: 'doc-bridge://docs/x.md', title: 'X guide' }] })
    expect(brief).toContain('Repository guidance')
    expect(brief).toContain('docs/x.md — X guide')
  })

  it('drops an empty description, lists non-empty comment bodies, and falls back to "unknown" for an authorless comment', () => {
    const brief = renderWorkerBrief({ issue: issue({ description: '', comments: [{ body: 'please add tests', createdAt: 'x' }] }), contract: stored(bareContract), config, branch: 'b', provider: 'claude', model: 'sonnet' })
    expect(brief).toContain('--- comment by unknown\nplease add tests')
    expect(brief).not.toMatch(/data">\s*\n\s*---/)
  })

  it('omits the touchpoints/risks lines when the contract declares none, and includes them when it does', () => {
    const bareBrief = renderWorkerBrief({ issue: issue(), contract: stored(bareContract), config, branch: 'b', provider: 'claude', model: 'sonnet' })
    expect(bareBrief).not.toContain('Likely touchpoints')
    expect(bareBrief).not.toContain('Risks to watch')
    const withRisks: TaskContract = { ...bareContract, touchpoints: ['packages/demo'], risks: ['may break auth'] }
    const richBrief = renderWorkerBrief({ issue: issue(), contract: stored(withRisks), config, branch: 'b', provider: 'claude', model: 'sonnet' })
    expect(richBrief).toContain('Likely touchpoints: packages/demo')
    expect(richBrief).toContain('Risks to watch: may break auth')
  })

  it('does not require onPiiDetected when PII is found and no callback is supplied', () => {
    const piiConfig = validateLoopConfig({ ...config, security: { pii: { enabled: true, action: 'warn' } } })
    expect(() => renderWorkerBrief({ issue: issue({ description: 'contact ops@example.com' }), contract: stored(bareContract), config: piiConfig, branch: 'b', provider: 'claude', model: 'sonnet' })).not.toThrow()
  })
})

describe('renderHandoffBrief', () => {
  it('renders a continuation brief referencing the prior worker, worktree, and blocked/done sentinels', () => {
    const brief = renderHandoffBrief({
      issue: 'ENG-1', issueUrl: 'https://linear.app/x', config, branch: 'person/eng-1', worktree: 'eng-1',
      previousProvider: 'codex', previousModel: 'gpt-5.6-sol', provider: 'claude', model: 'sonnet',
      contractDigest: 'abcdef123456ffff', reason: 'provider cooldown',
    })
    expect(brief).toContain('codex/gpt-5.6-sol')
    expect(brief).toContain('provider cooldown')
    expect(brief).toContain('eng-1')
    expect(brief).toContain('person/eng-1')
    expect(brief).toContain('claude/sonnet')
    expect(brief).toContain('LOOP_WORKER_DONE ENG-1')
    expect(brief).toContain(config.delivery.verifyCommand)
    expect(brief).toContain(config.delivery.selfEditPaths.join(', '))
  })
})
