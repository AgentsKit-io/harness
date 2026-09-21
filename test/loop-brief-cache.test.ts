import { describe, expect, it } from 'vitest'
import { assessContract, parseLinearIssueDetail, renderContractPrompt, renderWorkerBrief, validateLoopConfig } from '../src/index.js'
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
  dod: { items: [{ id: 'tests', description: 'the suite is green', kind: 'command', command: ['pnpm', 'test'] }] },
})

const issue = (identifier: string, title: string) => parseLinearIssueDetail({
  issue: { id: identifier, identifier, title, url: `https://linear.app/x/issue/${identifier}`, state: 'In Progress', updatedAt: '2026-01-01T00:00:00.000Z' },
  description: `do ${title}`,
  comments: [],
})

const contract = (intent: string): TaskContract => ({ intent, scope: { inScope: ['x'], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'works', check: { kind: 'command', command: 'pnpm test' } }], ambiguities: [], touchpoints: [], risks: [] })

const stored = (identifier: string, intent: string): StoredContract => ({ schemaVersion: 1, issue: identifier, issueUpdatedAt: '2026-01-01T00:00:00.000Z', generatedAt: 'now', provider: 'codex', model: 'gpt-5.6-sol', contract: contract(intent), digest: identifier.repeat(8), assessment: assessContract(contract(intent)), source: 'llm' })

/** How much of two prompts is byte-identical from the start — the part a provider's cache can reuse. */
const sharedPrefix = (left: string, right: string): string => {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  return left.slice(0, index)
}

describe('a prompt prefix a cache can hit', () => {
  it('keeps everything invariant for the repository at the head of the worker brief', () => {
    const first = renderWorkerBrief({ issue: issue('ENG-1', 'the first thing'), contract: stored('ENG-1', 'ship one'), config, branch: 'person/eng-1', provider: 'claude', model: 'sonnet' })
    const second = renderWorkerBrief({ issue: issue('ENG-2', 'a different thing'), contract: stored('ENG-2', 'ship two'), config, branch: 'person/eng-2', provider: 'claude', model: 'sonnet' })
    const prefix = sharedPrefix(first, second)

    // Without a floor this is decoration: the reorder is only worth anything if the shared head is most of the
    // standing text, not the first two words that happen to match.
    expect(prefix.length).toBeGreaterThan(1500)
    expect(prefix).toContain('## Standing rules')
    expect(prefix).toContain('## Definition of Done')
    expect(prefix).toContain('.ak-loop/verify.json')
    // Nothing about either issue may leak into the shared head, or the head stops being shared.
    expect(prefix).not.toContain('ENG-1')
    expect(prefix).not.toContain('ENG-2')
    // And the tail still carries everything a worker needs to act on this one.
    expect(first).toContain('# Your task: ENG-1 — the first thing')
    expect(first).toContain('git push -u origin person/eng-1')
    expect(first).toContain('LOOP_WORKER_DONE ENG-1')
  })

  it('keeps the contract prompt schema and rules ahead of the issue it is about', () => {
    const first = renderContractPrompt({ issue: issue('ENG-1', 'the first thing'), config, references: [] })
    const second = renderContractPrompt({ issue: issue('ENG-2', 'a different thing'), config, references: [] })
    const prefix = sharedPrefix(first, second)

    expect(prefix.length).toBeGreaterThan(1000)
    expect(prefix).toContain('Produce the contract as JSON')
    expect(prefix).not.toContain('ENG-1')
    expect(first.indexOf('Issue ENG-1')).toBeGreaterThan(first.indexOf('Produce the contract as JSON'))
    expect(first.trimEnd().endsWith('Now freeze the contract for ENG-1, between the markers, and write nothing else.')).toBe(true)
  })
})
