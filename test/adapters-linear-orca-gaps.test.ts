import { describe, expect, it } from 'vitest'
import { fetchLinearIssue, fetchLinearQueue, filterAndOrderQueue, linearAttach, linearCommentAdd, parseLinearIssueDetail, parseLinearIssues } from '../src/index.js'
import type { CommandResult, CommandRunner, LoopIssue } from '../src/index.js'

const recorder = (respond: (argv: readonly string[]) => CommandResult): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  return { calls, run: async (argv) => { calls.push([...argv]); return respond(argv) } }
}
const ok = (result: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '', timedOut: false, durationMs: 1 })

describe('parseLinearIssues: shape tolerance', () => {
  it('accepts a bare array result as well as {issues: [...]}', () => {
    expect(parseLinearIssues([{ id: '1', identifier: 'ENG-1' }])).toHaveLength(1)
    expect(parseLinearIssues({ issues: [{ id: '1', identifier: 'ENG-1' }] })).toHaveLength(1)
    expect(parseLinearIssues('nope')).toEqual([])
  })

  it('defaults state/stateType to unknown when the state object is absent', () => {
    const issue = parseLinearIssues([{ id: '1', identifier: 'ENG-1' }])[0]
    expect(issue).toMatchObject({ state: 'unknown', stateType: 'unknown' })
  })

  it('reads assignee display name, falling back to name, and defaults to null with no assignee', () => {
    const byDisplayName = parseLinearIssues([{ id: '1', identifier: 'ENG-1', assignee: { displayName: 'Person', id: 'u1' } }])[0]
    expect(byDisplayName).toMatchObject({ assignee: 'Person', assigneeId: 'u1' })
    const byName = parseLinearIssues([{ id: '1', identifier: 'ENG-1', assignee: { name: 'Person 2' } }])[0]
    expect(byName?.assignee).toBe('Person 2')
    const none = parseLinearIssues([{ id: '1', identifier: 'ENG-1' }])[0]
    expect(none).toMatchObject({ assignee: null, assigneeId: null })
  })

  it('reads plain string labels as well as {name} objects, dropping blanks', () => {
    const issue = parseLinearIssues([{ id: '1', identifier: 'ENG-1', labels: ['a', { name: 'b' }, { name: '' }] }])[0]
    expect(issue?.labels).toEqual(['a', 'b'])
  })

  it('defaults priority to 0 when not a number, and treats a blank branchName as null', () => {
    const issue = parseLinearIssues([{ id: '1', identifier: 'ENG-1', priority: 'high', branchName: '   ' }])[0]
    expect(issue).toMatchObject({ priority: 0, branchName: null })
  })

  it('drops entries without an identifier', () => {
    expect(parseLinearIssues([{ id: '1' }, { id: '2', identifier: 'ENG-2' }])).toHaveLength(1)
  })
})

const issue = (overrides: Partial<LoopIssue> = {}): LoopIssue => ({ id: 'i', identifier: 'ENG-1', title: 't', url: 'u', state: 'Todo', stateType: 'unstarted', assignee: null, assigneeId: null, labels: [], priority: 0, priorityLabel: 'none', project: null, branchName: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...overrides })
const filter = (overrides: Partial<import('../src/index.js').LinearQueueFilter> = {}) => ({ states: ['Todo'], excludeLabels: [], requireLabels: [], projects: [], order: ['priority' as const], maxQueue: 50, ...overrides })

describe('filterAndOrderQueue', () => {
  it('deduplicates by identifier, keeping the first occurrence', () => {
    const result = filterAndOrderQueue([issue({ id: 'a' }), issue({ id: 'b' })], filter())
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('a')
  })

  it('excludes issues carrying an excluded label', () => {
    expect(filterAndOrderQueue([issue({ labels: ['blocked'] })], filter({ excludeLabels: ['blocked'] }))).toEqual([])
  })

  it('requires every requireLabels entry to be present', () => {
    expect(filterAndOrderQueue([issue({ labels: ['ready'] })], filter({ requireLabels: ['ready', 'reviewed'] }))).toEqual([])
    expect(filterAndOrderQueue([issue({ labels: ['ready', 'reviewed'] })], filter({ requireLabels: ['ready', 'reviewed'] }))).toHaveLength(1)
  })

  it('filters by project, excluding issues with no project or a non-matching one', () => {
    expect(filterAndOrderQueue([issue({ project: null })], filter({ projects: ['Core'] }))).toEqual([])
    expect(filterAndOrderQueue([issue({ project: 'Other' })], filter({ projects: ['Core'] }))).toEqual([])
    expect(filterAndOrderQueue([issue({ project: 'Core' })], filter({ projects: ['Core'] }))).toHaveLength(1)
  })

  it('orders by updatedAt (newest first) and createdAt (oldest first)', () => {
    const older = issue({ id: 'a', identifier: 'ENG-1', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })
    const newer = issue({ id: 'b', identifier: 'ENG-2', updatedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-02T00:00:00Z' })
    expect(filterAndOrderQueue([older, newer], filter({ order: ['updatedAt'] })).map((i) => i.identifier)).toEqual(['ENG-2', 'ENG-1'])
    expect(filterAndOrderQueue([older, newer], filter({ order: ['createdAt'] })).map((i) => i.identifier)).toEqual(['ENG-1', 'ENG-2'])
  })

  it('falls through multiple order keys and finally breaks ties by identifier', () => {
    const a = issue({ id: 'a', identifier: 'ENG-1', priority: 1, updatedAt: 'not-a-date' })
    const b = issue({ id: 'b', identifier: 'ENG-2', priority: 1, updatedAt: 'not-a-date' })
    expect(filterAndOrderQueue([b, a], filter({ order: ['priority', 'updatedAt'] })).map((i) => i.identifier)).toEqual(['ENG-1', 'ENG-2'])
  })

  it('caps the result at maxQueue', () => {
    const many = Array.from({ length: 5 }, (_, i) => issue({ id: `id-${i}`, identifier: `ENG-${i}` }))
    expect(filterAndOrderQueue(many, filter({ maxQueue: 2 }))).toHaveLength(2)
  })
})

describe('fetchLinearQueue', () => {
  it('issues one list-issues call per configured state and merges the results', async () => {
    const runner = recorder((argv) => argv.includes('Todo') ? ok({ issues: [{ id: '1', identifier: 'ENG-1', state: { name: 'Todo' } }] }) : ok({ issues: [{ id: '2', identifier: 'ENG-2', state: { name: 'Ready' } }] }))
    const results = await fetchLinearQueue(runner, { workspaceId: 'ws', teamKey: 'ENG', assignee: 'me', filter: filter({ states: ['Todo', 'Ready'] }) })
    expect(runner.calls).toHaveLength(2)
    expect(results.map((i) => i.identifier).sort()).toEqual(['ENG-1', 'ENG-2'])
  })
})

describe('parseLinearIssueDetail', () => {
  it('unwraps a nested issue object and reads comments with an author or user displayName/name fallback', () => {
    const detail = parseLinearIssueDetail({ issue: { id: '1', identifier: 'ENG-1', description: 'desc' }, comments: [{ user: { displayName: 'A' }, body: 'hi', createdAt: 't' }, { author: 'B', body: 'yo' }] })
    expect(detail).toMatchObject({ identifier: 'ENG-1', description: 'desc' })
    expect(detail.comments).toEqual([{ author: 'A', body: 'hi', createdAt: 't' }, { author: 'B', body: 'yo', createdAt: '' }])
  })

  it('accepts a flat (non-nested) issue payload', () => {
    expect(parseLinearIssueDetail({ id: '1', identifier: 'ENG-1' }).identifier).toBe('ENG-1')
  })

  it('fails closed when the payload has no identifier', () => {
    expect(() => parseLinearIssueDetail({})).toThrow(/no identifier/)
    expect(() => parseLinearIssueDetail(null)).toThrow(/no identifier/)
  })

  it('defaults comments to an empty list when absent or malformed', () => {
    expect(parseLinearIssueDetail({ id: '1', identifier: 'ENG-1' }).comments).toEqual([])
    expect(parseLinearIssueDetail({ id: '1', identifier: 'ENG-1', comments: 'nope' }).comments).toEqual([])
  })
})

describe('fetchLinearIssue and dedupeKey-driven writes', () => {
  it('fetches one issue by identifier with the expected argv', async () => {
    const runner = recorder(() => ok({ id: '1', identifier: 'ENG-1' }))
    await fetchLinearIssue(runner, 'ENG-1', { workspaceId: 'ws' })
    expect(runner.calls[0]).toEqual(['orca', 'linear', 'issue', 'ENG-1', '--full', '--workspace', 'ws', '--json'])
  })

  it('adds a deterministic --write-id only when a dedupeKey is supplied', async () => {
    const runner = recorder(() => ok({}))
    await linearCommentAdd(runner, { issue: 'ENG-1', body: 'hi' }, { workspaceId: 'ws' })
    expect(runner.calls[0]).not.toContain('--write-id')
    await linearCommentAdd(runner, { issue: 'ENG-1', body: 'hi', dedupeKey: 'k' }, { workspaceId: 'ws' })
    expect(runner.calls[1]).toContain('--write-id')
  })

  it('includes --title on linearAttach only when provided', async () => {
    const runner = recorder(() => ok({}))
    await linearAttach(runner, { issue: 'ENG-1', url: 'https://x' }, { workspaceId: 'ws' })
    expect(runner.calls[0]).not.toContain('--title')
    await linearAttach(runner, { issue: 'ENG-1', url: 'https://x', title: 'PR' }, { workspaceId: 'ws' })
    expect(runner.calls[1]).toContain('--title')
  })

  it('scopes writes with a custom bin and orca options', async () => {
    const runner = recorder(() => ok({}))
    await linearCommentAdd(runner, { issue: 'ENG-1', body: 'hi' }, { workspaceId: 'ws', bin: '/custom/orca' })
    expect(runner.calls[0]?.[0]).toBe('/custom/orca')
  })
})
