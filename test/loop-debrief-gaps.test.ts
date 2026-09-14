import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendLoopEvent, buildDebriefReport, loadLoopConfig, markProviderExhausted, renderDebriefMarkdown } from '../src/index.js'
import type { LoadedLoopConfig } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const NOW = new Date('2026-09-12T12:00:00.000Z')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = (): { readonly loaded: LoadedLoopConfig; readonly issue: (id: string, files: Record<string, unknown>) => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-debrief-gaps-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  mkdirSync(loaded.stateDir, { recursive: true })
  const issue = (id: string, files: Record<string, unknown>): void => {
    mkdirSync(join(loaded.stateDir, 'issues', id), { recursive: true })
    for (const [name, value] of Object.entries(files)) writeFileSync(join(loaded.stateDir, 'issues', id, name), JSON.stringify(value))
  }
  return { loaded, issue }
}

const dispatch = (issue: string, overrides: Record<string, unknown> = {}) => ({
  issue, worktreeId: 'w', worktree: `${issue.toLowerCase()}-wt`, branch: `u/${issue}`, terminal: 't', provider: 'claude', model: 'sonnet',
  contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-09-12T11:00:00.000Z', url: `https://linear.app/x/${issue}`, ...overrides,
})

describe('buildDebriefReport phases and headline', () => {
  it('reports idle when nothing is in flight or held', () => {
    const env = setup()
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.headline).toBe('Loop idle for person on my-project')
    expect(report.inFlight).toEqual([])
    expect(report.held).toEqual([])
  })

  it('reports a merged final outcome and excludes it from inFlight', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 9, reviews: {}, fixRounds: 0, finalOutcome: 'merged' } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight).toEqual([])
    expect(report.held).toEqual([])
  })

  it('reports waiting-for-pr when a worker is dispatched but no PR exists yet', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1') })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ issue: 'ENG-1', phase: 'waiting-for-pr', summary: 'Worker claude/sonnet active; no PR yet' })
  })

  it('reports awaiting-review once a PR exists with no review yet', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 5, reviews: {}, fixRounds: 0 } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ phase: 'awaiting-review', summary: 'PR #5 open; review not started' })
  })

  it('reports review-incomplete (not yet held) on a first incomplete review attempt', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 5, reviews: { r1: { status: 'incomplete', at: '2026-09-12T11:30:00.000Z', provider: 'p', model: 'm', blocking: 0, attempts: 1 } }, fixRounds: 0 } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ phase: 'review-incomplete', summary: 'PR #5 review incomplete (attempt 1)' })
    expect(report.held).toEqual([])
  })

  it('reports fix-round when the latest review found blocking findings', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 5, reviews: { r1: { status: 'findings', at: '2026-09-12T11:30:00.000Z', provider: 'p', model: 'm', blocking: 2, attempts: 1 } }, fixRounds: 1 } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ phase: 'fix-round', summary: 'PR #5 has review findings; fix round 1' })
  })

  it('reports ready-to-merge when the latest review is clean', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 5, reviews: { r1: { status: 'clean', at: '2026-09-12T11:30:00.000Z', provider: 'p', model: 'm', blocking: 0, attempts: 1 } }, fixRounds: 0 } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ phase: 'ready-to-merge', summary: 'PR #5 review clean; waiting for deliver to merge' })
  })

  it('reports the default in-flight phase for an unrecognized review status, using the reviewStatus field', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 5, reviews: { r1: { status: 'pending', at: '2026-09-12T11:30:00.000Z', provider: 'p', model: 'm', blocking: 0, attempts: 1 } }, fixRounds: 0 } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ phase: 'in-flight', summary: 'In flight', reviewStatus: 'pending×1' })
  })

  it('reports held for a self-edit/protected-path hold, distinct from the incomplete-review hold message', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 5, reviews: {}, fixRounds: 0, heldFor: 'abcdef1234567890' } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.held[0]).toMatchObject({ phase: 'held', summary: 'Held for a human (self-edit or protected path at abcdef1)' })
  })

  it('builds an "escalated" row for a non-dispatchable contract, but it is filtered out of both inFlight and held (excluded from every visible list) — the human-facing "Needs-info" summary this computes is currently unreachable from the report or its markdown', () => {
    const env = setup()
    env.issue('ENG-1', { 'contract.json': { schemaVersion: 1, issue: 'ENG-1', issueUpdatedAt: 'u', generatedAt: '2026-09-12T09:00:00.000Z', provider: 'codex', model: 'gpt', contract: { intent: 'Ambiguous ask', scope: { inScope: [], outOfScope: [] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] }, digest: 'd', assessment: { dispatchable: false, reasons: ['unclear scope'] }, source: 'llm' } })
    env.issue('ENG-2', { 'contract.json': { schemaVersion: 1, issue: 'ENG-2', issueUpdatedAt: 'u', generatedAt: '2026-09-12T09:00:00.000Z', provider: 'codex', model: 'gpt', contract: { intent: 'Clear ask', scope: { inScope: [], outOfScope: [] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] }, digest: 'd', assessment: { dispatchable: true, reasons: [] }, source: 'llm' } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight).toEqual([])
    expect(report.held).toEqual([])
    expect(report.headline).toBe('Loop idle for person on my-project')
    expect(renderDebriefMarkdown(report)).not.toContain('Needs-info')
  })

  it('includes an explicitly requested issue with no dispatch/delivery/contract state as an idle row (fixed upstream: the "always include" branch for input.issue used to be shadowed by an unconditional skip check right after it)', () => {
    const env = setup()
    const report = buildDebriefReport({ loaded: env.loaded, issue: 'ENG-404', now: () => NOW })
    expect(report.inFlight).toMatchObject([{ issue: 'ENG-404', phase: 'idle', summary: 'Not yet dispatched' }])
    expect(report.held).toEqual([])
  })

  it('counts held issues in the headline alongside in-flight issues', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1') })
    env.issue('ENG-2', { 'dispatch.json': dispatch('ENG-2'), 'delivery.json': { issue: 'ENG-2', prNumber: 3, reviews: {}, fixRounds: 0, heldFor: 'a' } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.headline).toBe('Loop working 2 issue(s), 1 held for a human on my-project')
  })

  it('reports active provider cooldowns with their reason and expiry', () => {
    const env = setup()
    markProviderExhausted(env.loaded.stateDir, 'codex', { initialMin: 30, maxMin: 240, reason: 'weekly limit', now: new Date('2026-09-12T11:55:00.000Z') })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.cooldowns).toEqual([{ provider: 'codex', reason: 'weekly limit', until: expect.any(String) }])
  })

  it('reports recent contract.escalated events within the window, reading the "reasons" array field', () => {
    const env = setup()
    appendLoopEvent(env.loaded.stateDir, { at: '2026-09-12T11:50:00.000Z', type: 'contract.escalated', issue: 'ENG-1', reasons: ['ambiguous scope', 'second reason'] })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.recentEscalations).toEqual([{ issue: 'ENG-1', at: expect.any(String), reason: 'ambiguous scope' }])
  })

  it('reports recent events generically, defaulting issue to null when absent', () => {
    const env = setup()
    appendLoopEvent(env.loaded.stateDir, { at: '2026-09-12T11:50:00.000Z', type: 'worker.dispatched' })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.recentEvents).toEqual([{ at: expect.any(String), type: 'worker.dispatched', issue: null }])
  })

  it('falls back to the singular "reason" field and "?" issue when an escalation event has neither reasons nor a string issue', () => {
    const env = setup()
    appendLoopEvent(env.loaded.stateDir, { at: '2026-09-12T11:50:00.000Z', type: 'contract.escalated', reason: 'single reason field' })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.recentEscalations).toEqual([{ issue: '?', at: expect.any(String), reason: 'single reason field' }])
  })

  it('leaves ageMin null when dispatchedAt is missing, and null on an unparsable dispatchedAt', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1', { dispatchedAt: undefined }) })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]?.ageMin).toBeNull()
  })

  it('reports the idle phase for a delivery record that exists with no matching dispatch record', () => {
    const env = setup()
    env.issue('ENG-1', { 'delivery.json': { issue: 'ENG-1', prNumber: null, reviews: { r1: { status: 'incomplete', at: '2026-09-12T11:30:00.000Z', provider: 'p', model: 'm', blocking: 0, attempts: 1 } }, fixRounds: 0, heldFor: null, finishedAt: null, finalOutcome: null } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ issue: 'ENG-1', phase: 'idle', summary: 'Not yet dispatched', dispatchedAt: null })
  })

  it('summarizes a custom final outcome not explicitly handled (merged/held) via the generic "Finished as" fallback', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 7, reviews: {}, fixRounds: 0, finalOutcome: 'abandoned' } })
    const report = buildDebriefReport({ loaded: env.loaded, issue: 'ENG-1', now: () => NOW })
    expect(report.held).toEqual([])
    const rows = [...report.inFlight]
    expect(rows).toEqual([])
  })

  it('defaults an escalated row\'s summary reason when the contract reports an empty reasons list', () => {
    const env = setup()
    env.issue('ENG-1', { 'contract.json': { schemaVersion: 1, issue: 'ENG-1', issueUpdatedAt: 'u', generatedAt: '2026-09-12T09:00:00.000Z', provider: 'codex', model: 'gpt', contract: { intent: 'x', scope: { inScope: [], outOfScope: [] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] }, digest: 'd', assessment: { dispatchable: false, reasons: [] }, source: 'llm' } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight).toEqual([])
  })
})

describe('renderDebriefMarkdown sections', () => {
  it('renders every optional section when populated: intent, worker age, worktree, branch, PR+review, Linear link, cooldowns, escalations, recent events', () => {
    const env = setup()
    env.issue('ENG-1', {
      'dispatch.json': dispatch('ENG-1'),
      'delivery.json': { issue: 'ENG-1', prNumber: 5, reviews: { r1: { status: 'clean', at: '2026-09-12T11:30:00.000Z', provider: 'p', model: 'm', blocking: 0, attempts: 1 } }, fixRounds: 0 },
      'contract.json': { schemaVersion: 1, issue: 'ENG-1', issueUpdatedAt: 'u', generatedAt: '2026-09-12T09:00:00.000Z', provider: 'claude', model: 'opus', contract: { intent: 'Ship the thing', scope: { inScope: [], outOfScope: [] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] }, digest: 'd', assessment: { dispatchable: true, reasons: [] }, source: 'llm' },
    })
    markProviderExhausted(env.loaded.stateDir, 'codex', { initialMin: 30, maxMin: 240, reason: 'weekly limit', now: new Date('2026-09-12T11:55:00.000Z') })
    appendLoopEvent(env.loaded.stateDir, { at: '2026-09-12T11:50:00.000Z', type: 'contract.escalated', issue: 'ENG-2', reasons: ['unclear'] })
    appendLoopEvent(env.loaded.stateDir, { at: '2026-09-12T11:51:00.000Z', type: 'worker.dispatched', issue: 'ENG-1' })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('- Intent: Ship the thing')
    expect(md).toContain('- Worker: `claude/sonnet` · 60 min')
    expect(md).toContain('- Worktree: `eng-1-wt`')
    expect(md).toContain('- Branch: `u/ENG-1`')
    expect(md).toContain('- PR: https://github.com/my-org/my-project/pull/5 · review clean×1')
    expect(md).toContain('- Linear: https://linear.app/x/ENG-1')
    expect(md).toContain('## Provider cooldowns')
    expect(md).toContain('`codex`: weekly limit until')
    expect(md).toContain('## Recent escalations')
    expect(md).toContain('**ENG-2**: unclear')
    expect(md).toContain('## Recent events')
    expect(md).toContain('`worker.dispatched` · ENG-1')
    expect(md).toContain('Read-only. Run `ak-harness loop deliver`')
  })

  it('omits the age suffix and worktree/branch lines for a row missing that data', () => {
    const env = setup()
    env.issue('ENG-1', { 'delivery.json': { issue: 'ENG-1', prNumber: null, reviews: { r1: { status: 'incomplete', at: '2026-09-12T11:30:00.000Z', provider: 'p', model: 'm', blocking: 0, attempts: 1 } }, fixRounds: 0, heldFor: null, finishedAt: null, finalOutcome: null } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('### ENG-1 — idle')
    expect(md).not.toContain('- Worker:')
    expect(md).not.toContain('- Worktree:')
    expect(md).not.toContain('- Branch:')
  })

  it('includes the PR link in the "Needs a human" section when a held row has one', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': { issue: 'ENG-1', prNumber: 5, reviews: {}, fixRounds: 0, heldFor: 'abcdef1234567890' } })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('(https://github.com/my-org/my-project/pull/5)')
  })

  it('omits the issue suffix for a recent event with no associated issue', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1') })
    appendLoopEvent(env.loaded.stateDir, { at: '2026-09-12T11:50:00.000Z', type: 'doctor.ran' })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('`doctor.ran`\n')
  })

  it('renders the "nothing dispatched" placeholder when inFlight is empty', () => {
    const env = setup()
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('_Nothing dispatched right now._')
    expect(md).not.toContain('## Needs a human')
    expect(md).not.toContain('## Provider cooldowns')
    expect(md).not.toContain('## Recent escalations')
    expect(md).not.toContain('## Recent events')
  })
})
