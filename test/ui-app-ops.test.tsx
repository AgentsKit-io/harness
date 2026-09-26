import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { AttentionItem, IssueRecord, UiSnapshot } from '@/lib/api'
import { availableIssues, capTone, formatTokens, matchesSearch, phaseLabel, recentChanges, runBucket, segments } from '@/lib/runs'
import { confirmBasis } from '@/lib/actions'
import { AttentionCard, AttentionQueue, targetOf } from '@/pages/Attention'
import { RunsTable, filterCounts, inFilter } from '@/pages/Runs'
import { diffFrom } from '@/pages/Batch'
import { IssuePanel, StatusBox, timelineFields } from '@/components/IssuePanel'

const AT = '2026-09-25T12:00:00.000Z'

const record = (overrides: Partial<IssueRecord> = {}): IssueRecord => ({
  issue: 'AK-1', title: 'Import files', url: null, trackerState: 'In Progress', phase: 'running', reviewState: null,
  run: { id: 'r1', attempt: 1, configHash: 'h', flow: null, builder: 'anthropic/sonnet', contractDigest: 'd', maxFixRounds: 3, perIssueTokens: 100_000, status: 'running', archived: false },
  dispatch: { branch: 'ak-1-import', worktree: null, worktreeId: null, terminal: null, provider: 'anthropic', model: 'sonnet', contractDigest: 'd', dispatchedAt: AT },
  pullRequest: null, pendingDecisions: [], error: null, updatedAt: AT, ...overrides,
})

const item = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 'x', group: 'failed', kind: 'ci-failed', issue: 'AK-1', title: 'Import files', reason: 'CI failed on round 3/3', detail: null, since: AT,
  actions: [{ id: 'open', label: 'Open', primary: false, destructive: false, gate: false }, { id: 'retry', label: 'Retry', primary: true, destructive: false, gate: false }],
  locked: false, lockReason: null, ...overrides,
})

const snapshot = (issues: readonly IssueRecord[], extras?: UiSnapshot['extras']): UiSnapshot => ({
  schemaVersion: 1 as UiSnapshot['schemaVersion'], generatedAt: AT,
  project: { name: 'demo', repo: 'org/demo', baseBranch: 'main', root: '/', stateDir: '/', configHash: 'h' },
  capacity: { maxAgents: 2, running: 1, free: 1 },
  board: { provider: 'github', repo: 'org/demo', status: 'fresh', fetchedAt: AT, truncated: false, error: null, issues: [
    { identifier: 'AK-1', title: 'Import files', url: 'u', state: 'In Progress', lane: 'in-progress', labels: [], assignees: [], createdAt: AT, updatedAt: AT },
    { identifier: 'AK-2', title: 'Export', url: 'u', state: 'Todo', lane: 'todo', labels: [], assignees: [], createdAt: AT, updatedAt: AT },
    { identifier: 'AK-3', title: 'Old', url: 'u', state: 'Done', lane: 'done', labels: [], assignees: [], createdAt: AT, updatedAt: AT },
  ] },
  issues, ...(extras ? { extras } : {}),
})

describe('ui runs helpers', () => {
  it('buckets records by what the operator would call them', () => {
    expect(runBucket(record())).toBe('running')
    expect(runBucket(record({ dispatch: null, run: { ...record().run!, status: 'queued' } }))).toBe('queued')
    expect(runBucket(record({ phase: 'review', reviewState: 'human-approval' }))).toBe('held')
    expect(runBucket(record({ phase: 'review' }))).toBe('review')
    expect(runBucket(record({ phase: 'blocked' }))).toBe('blocked')
    expect(runBucket(record({ phase: 'completed' }))).toBe('done')
    expect(runBucket(record({ run: { ...record().run!, archived: true } }))).toBe('archived')
  })

  it('draws the 4-stage bar with the current stage active only while moving', () => {
    expect(segments(record())).toEqual(['done', 'active', 'todo', 'todo'])
    expect(segments(record({ phase: 'review', pullRequest: { number: 4, state: 'OPEN', head: 'abc' } }))).toEqual(['done', 'done', 'active', 'todo'])
    expect(segments(record({ phase: 'blocked' }))).toEqual(['done', 'stopped', 'todo', 'todo'])
    expect(segments(record({ phase: 'completed' }))).toEqual(['done', 'done', 'done', 'done'])
    expect(phaseLabel(record({ phase: 'blocked' }))).toBe('build · blocked')
  })

  it('formats tokens, colors caps at 80% and 100%, searches id/title/branch/PR', () => {
    expect(formatTokens(41_200)).toBe('41k')
    expect(formatTokens(1_760_000)).toBe('1.76M')
    expect(capTone(50, 100)).toBe('bg-accent')
    expect(capTone(80, 100)).toBe('bg-warning')
    expect(capTone(100, 100)).toBe('bg-danger')
    const withPr = record({ pullRequest: { number: 431, state: 'OPEN', head: null } })
    for (const query of ['ak-1', 'import', 'ak-1-import', '#431']) expect(matchesSearch(withPr, query)).toBe(true)
    expect(matchesSearch(withPr, 'nope')).toBe(false)
  })

  it('counts filter chips, keeping archived out of All', () => {
    const records = [record(), record({ issue: 'AK-2', phase: 'blocked' }), record({ issue: 'AK-3', run: { ...record().run!, archived: true } })]
    const counts = filterCounts(records)
    expect(counts.all).toBe(2)
    expect(counts.running).toBe(1)
    expect(counts.blocked).toBe(1)
    expect(counts.archived).toBe(1)
    expect(inFilter(records[2]!, 'all')).toBe(false)
  })

  it('lists queueable board issues and a newest-first change feed', () => {
    const snap = snapshot([record(), record({ issue: 'AK-9', updatedAt: '2026-09-25T13:00:00.000Z' })])
    expect(availableIssues(snap).map((issue) => issue.identifier)).toEqual(['AK-2'])
    expect(recentChanges(snap).map((row) => row.issue)).toEqual(['AK-9', 'AK-1'])
  })

  it('keeps only fields that differ from the batch defaults as overrides', () => {
    expect(diffFrom({ builder: 'a', maxFixRounds: 3 }, { builder: 'b', maxFixRounds: 3 })).toEqual({ builder: 'b' })
  })
})

describe('confirm basis', () => {
  it('lists freshness and issue facts, marking a locked issue stale', () => {
    const snap = snapshot([record()], {
      freshness: [{ source: 'tracker', at: AT, ageMs: 14_000, stale: false }], drift: [], attention: [],
      locks: { 'AK-1': 'Tracker says Canceled' }, staleAfterMs: 60_000,
    })
    const basis = confirmBasis(snap, 2_000, { issue: 'AK-1', head: 'abcdef123' })
    expect(basis.map((row) => row.label)).toEqual(['tracker read', 'loop state', 'tracker state', 'PR head', 'out of sync'])
    expect(basis.find((row) => row.label === 'out of sync')?.stale).toBe(true)
    expect(basis.find((row) => row.label === 'PR head')?.value).toBe('abcdef1')
  })

  it('treats an older server without extras as fresh rather than blocking every action', () => {
    expect(confirmBasis(snapshot([record()]), 2_000, { issue: 'AK-1' }).every((row) => !row.stale)).toBe(true)
  })
})

describe('attention components', () => {
  const noop = vi.fn()

  it('renders groups in order human → failed → drift → system', () => {
    const html = renderToStaticMarkup(<AttentionQueue now={Date.parse(AT)} busy={null} onAction={noop} onAnswer={noop} items={[
      item({ id: 's', group: 'system', title: 'Automation drift' }), item({ id: 'd', group: 'drift', title: 'Tracker closed' }),
      item({ id: 'h', group: 'human', title: 'Pick a calendar' }), item({ id: 'f', group: 'failed', title: 'CI red' }),
    ]} />)
    const order = ['Human decisions', 'Stuck or failed', 'Out of sync', 'System'].map((name) => html.indexOf(name))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('shows HITL options inline with the recommended one highlighted', () => {
    const decision = { id: 'q1', issue: 'AK-1', title: 't', message: 'm', options: [{ id: 'a', title: 'National calendar', description: '' }, { id: 'b', title: 'Local only', description: '' }],
      recommendedOptionId: 'a', batchId: 'b', role: 'r', stage: 'contract', digest: 'dg', createdAt: AT, updatedAt: AT }
    const html = renderToStaticMarkup(<AttentionCard color="text-warning" now={Date.parse(AT)} busy={null} onAction={noop} onAnswer={noop}
      item={item({ group: 'human', kind: 'hitl', decision, actions: [{ id: 'answer', label: 'Answer', primary: true, destructive: false, gate: false }] })} />)
    expect(html).toContain('National calendar (recommended)')
    expect(html).toContain('Local only')
    expect(html).not.toContain('>Answer<')
  })

  it('disables destructive actions and shows the lock notice when locked', () => {
    const html = renderToStaticMarkup(<AttentionCard color="text-drift" now={Date.parse(AT)} busy={null} onAction={noop} onAnswer={noop}
      item={item({ group: 'drift', locked: true, lockReason: 'Locked until reconciled', actions: [{ id: 'cancel', label: 'Cancel', primary: false, destructive: true, gate: false }] })} />)
    expect(html).toContain('Locked until reconciled')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/)
  })

  it('maps an item to its action target, carrying head, stage and lock', () => {
    expect(targetOf(item({ head: 'abc', locked: true, lockReason: 'drift' }))).toMatchObject({ issue: 'AK-1', head: 'abc', lockReason: 'drift' })
    expect(targetOf(item({ issue: null, id: 'plan-gate:P-7' })).planId).toBe('P-7')
  })
})

describe('runs table and issue panel', () => {
  it('renders rows with phase, rounds cap, tokens vs cap and the personal override badge', () => {
    const html = renderToStaticMarkup(<RunsTable now={Date.parse(AT)} selected={null} onOpen={vi.fn()} tokens={new Map([['AK-1', 85_000]])}
      rows={[record({ run: { ...record().run!, weakenedGates: ['review.required'] } })]} />)
    expect(html).toContain('AK-1')
    expect(html).toContain('85k/100k')
    expect(html).toContain('—/3')
    expect(html).toContain('personal override')
    expect(html).toContain('bg-warning')
  })

  it('shows why a run stopped with next-step actions, gating destructive ones behind reconcile', () => {
    const detail = { issue: 'AK-1', contract: null, criteria: [], review: null, spend: { tokens: 0, cap: null, calls: 0 }, worker: null, fixRounds: { used: 3, max: 3 },
      nextStep: { reason: 'CI failed on fix round 3/3', detail: null, actions: [{ id: 'retry' as const, label: 'Retry with +1 round', primary: true, destructive: false, gate: false }, { id: 'cancel' as const, label: 'Cancel run', primary: false, destructive: true, gate: false }] } }
    const html = renderToStaticMarkup(<StatusBox record={record({ phase: 'blocked' })} detail={detail} locked="Tracker says Canceled" busy={null} onAction={vi.fn()} />)
    expect(html).toContain('CI failed on fix round 3/3')
    expect(html).toContain('Retry with +1 round')
    expect(html).toContain('Reconcile first')
    expect(html).toContain('Tracker says Canceled')
  })

  it('renders timeline rows with structured fields, and the panel only when ?issue= is set', () => {
    expect(timelineFields({ at: AT, type: 'worker.ci-round', round: 2, tokens: 41_000, provider: 'anthropic' })).toEqual(['round 2', 'provider anthropic', 'tokens 41k'])
    expect(renderToStaticMarkup(<MemoryRouter initialEntries={['/runs']}><IssuePanel /></MemoryRouter>)).toBe('')
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/runs?issue=AK-5']}><IssuePanel /></MemoryRouter>)
    expect(html).toContain('AK-5')
    expect(html).toContain('aria-label="Close detail"')
    expect(html).toContain('role="tablist"')
  })
})
