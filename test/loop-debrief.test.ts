import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDebriefReport, loadLoopConfig, renderDebriefMarkdown } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const NOW = new Date('2026-09-12T12:00:00.000Z')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-debrief-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  mkdirSync(loaded.stateDir, { recursive: true })
  const issue = (id: string, files: Record<string, unknown>): void => {
    mkdirSync(join(loaded.stateDir, 'issues', id), { recursive: true })
    for (const [name, value] of Object.entries(files)) writeFileSync(join(loaded.stateDir, 'issues', id, name), JSON.stringify(value))
  }
  return { loaded, issue }
}

describe('loop debrief', () => {
  it('summarises in-flight delivery and held incomplete reviews for a human', () => {
    const env = setup()
    env.issue('ENG-1', {
      'dispatch.json': { issue: 'ENG-1', worktreeId: 'w', worktree: 'eng-1', branch: 'u/eng-1', terminal: 't', provider: 'claude', model: 'sonnet', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-09-12T11:00:00.000Z', url: 'https://linear.app/x/ENG-1' },
      'delivery.json': { issue: 'ENG-1', prNumber: 9, reviews: { aaa: { status: 'incomplete', at: '2026-09-12T11:30:00.000Z', provider: 'claude-cli', model: 'opus', blocking: 0, attempts: 2 } }, fixRounds: 0, nudges: [], heldFor: null, finishedAt: null, finalOutcome: null },
      'contract.json': { schemaVersion: 1, issue: 'ENG-1', issueUpdatedAt: 'u', generatedAt: '2026-09-12T10:00:00.000Z', provider: 'claude', model: 'opus', contract: { intent: 'Ship early access', scope: { inScope: ['a'], outOfScope: [] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] }, digest: 'd', assessment: { dispatchable: true, reasons: [] }, source: 'llm' },
    })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.headline).toContain('1 issue')
    expect(report.inFlight[0]).toMatchObject({ issue: 'ENG-1', phase: 'held-incomplete-review', pr: 9 })
    expect(report.held[0]?.issue).toBe('ENG-1')
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('# Loop debrief')
    expect(md).toContain('ENG-1')
    expect(md).toContain('Needs a human')
    expect(md).toContain('https://github.com/my-org/my-project/pull/9')
  })

  it('shows outcome progress read from the worktree when the worker wrote progress.json', () => {
    const env = setup()
    const worktree = mkdtempSync(join(tmpdir(), 'agentskit-loop-debrief-worktree-')); cleanups.push(worktree)
    writeFileSync(join(worktree, 'progress.json'), JSON.stringify({ o1: 'done', o2: 'in-progress' }), 'utf8')
    env.issue('ENG-2', {
      'dispatch.json': { issue: 'ENG-2', worktreeId: 'w', worktree: 'eng-2', worktreePath: worktree, branch: 'u/eng-2', terminal: 't', provider: 'claude', model: 'sonnet', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-09-12T11:00:00.000Z', url: 'https://linear.app/x/ENG-2' },
      'delivery.json': { issue: 'ENG-2', prNumber: null, reviews: {}, fixRounds: 0, nudges: [], heldFor: null, finishedAt: null, finalOutcome: null },
    })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ issue: 'ENG-2', progress: { o1: 'done', o2: 'in-progress' } })
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('1/2 outcome(s) done')
    expect(md).toContain('o1: done')
    expect(md).toContain('o2: in-progress')
  })

  const dispatch = (issue: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ issue, worktreeId: 'w', worktree: issue.toLowerCase(), branch: `u/${issue.toLowerCase()}`, terminal: 't', provider: 'claude', model: 'sonnet', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-09-12T11:00:00.000Z', url: `https://linear.app/x/${issue}`, ...overrides })
  const deliveryState = (issue: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ issue, prNumber: null, reviews: {}, fixRounds: 0, nudges: [], heldFor: null, finishedAt: null, finalOutcome: null, ...overrides })

  it('reports idle when nothing is dispatched, and phases through waiting-for-pr/awaiting-review/review-incomplete/fix-round/ready-to-merge', () => {
    const env = setup()
    expect(buildDebriefReport({ loaded: env.loaded, now: () => NOW }).headline).toContain('idle')

    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': deliveryState('ENG-1') })
    expect(buildDebriefReport({ loaded: env.loaded, now: () => NOW }).inFlight[0]).toMatchObject({ phase: 'waiting-for-pr', summary: expect.stringContaining('active; no PR yet') })

    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': deliveryState('ENG-1', { prNumber: 5 }) })
    expect(buildDebriefReport({ loaded: env.loaded, now: () => NOW }).inFlight[0]).toMatchObject({ phase: 'awaiting-review', summary: expect.stringContaining('review not started') })

    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': deliveryState('ENG-1', { prNumber: 5, reviews: { a: { status: 'incomplete', at: 't', provider: 'p', model: 'm', blocking: 0, attempts: 1 } } }) })
    expect(buildDebriefReport({ loaded: env.loaded, now: () => NOW }).inFlight[0]).toMatchObject({ phase: 'review-incomplete', summary: expect.stringContaining('review incomplete (attempt 1)') })

    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': deliveryState('ENG-1', { prNumber: 5, fixRounds: 3, reviews: { a: { status: 'findings', at: 't', provider: 'p', model: 'm', blocking: 1, attempts: 1 } } }) })
    expect(buildDebriefReport({ loaded: env.loaded, now: () => NOW }).inFlight[0]).toMatchObject({ phase: 'fix-round', summary: expect.stringContaining('fix round 3') })

    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': deliveryState('ENG-1', { prNumber: 5, reviews: { a: { status: 'clean', at: 't', provider: 'p', model: 'm', blocking: 0, attempts: 1 } } }) })
    expect(buildDebriefReport({ loaded: env.loaded, now: () => NOW }).inFlight[0]).toMatchObject({ phase: 'ready-to-merge', summary: expect.stringContaining('waiting for deliver to merge') })
  })

  it('summarises a merged outcome and a finished-otherwise outcome, and reports held via heldFor without a review', () => {
    const env = setup()
    env.issue('ENG-1', { 'dispatch.json': dispatch('ENG-1'), 'delivery.json': deliveryState('ENG-1', { prNumber: 5, finalOutcome: 'merged', finishedAt: NOW.toISOString() }) })
    const merged = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(merged.inFlight).toHaveLength(0) // a finalOutcome excludes the row from "in flight"
    expect(merged.held).toHaveLength(0)

    env.issue('ENG-2', { 'dispatch.json': dispatch('ENG-2'), 'delivery.json': deliveryState('ENG-2', { finalOutcome: 'abandoned' }) })
    const abandoned = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(abandoned.held.find((row) => row.issue === 'ENG-2')).toBeUndefined()

    env.issue('ENG-3', { 'dispatch.json': dispatch('ENG-3'), 'delivery.json': deliveryState('ENG-3', { heldFor: 'protected/path.ts' }) })
    const held = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    const row = held.held.find((r) => r.issue === 'ENG-3')
    expect(row).toMatchObject({ phase: 'held', summary: expect.stringContaining('Held for a human') })
  })

  it('lists an escalated, undispatched issue with an unmet contract as its own row', () => {
    const env = setup()
    env.issue('ENG-4', {
      'contract.json': { schemaVersion: 1, issue: 'ENG-4', issueUpdatedAt: 'u', generatedAt: '2026-09-12T09:00:00.000Z', provider: 'claude', model: 'opus', contract: { intent: 'Unclear scope', scope: { inScope: [], outOfScope: [] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] }, digest: 'd', assessment: { dispatchable: false, reasons: ['missing acceptance criteria'] }, source: 'llm' },
    })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight.find((row) => row.issue === 'ENG-4')).toBeUndefined() // escalated rows are excluded from "in flight"
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('_Nothing dispatched right now._')
  })

  it('skips an undispatched issue whose contract is still dispatchable, and always includes an explicitly requested issue', () => {
    const env = setup()
    env.issue('ENG-5', {
      'contract.json': { schemaVersion: 1, issue: 'ENG-5', issueUpdatedAt: 'u', generatedAt: '2026-09-12T09:00:00.000Z', provider: 'claude', model: 'opus', contract: { intent: 'Fine', scope: { inScope: [], outOfScope: [] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] }, digest: 'd', assessment: { dispatchable: true, reasons: [] }, source: 'llm' },
    })
    expect(buildDebriefReport({ loaded: env.loaded, now: () => NOW }).inFlight).toHaveLength(0)

    const explicit = buildDebriefReport({ loaded: env.loaded, issue: 'ENG-5', now: () => NOW })
    expect(explicit.inFlight).toMatchObject([{ issue: 'ENG-5', phase: 'idle', summary: 'Not yet dispatched' }])
  })

  it('surfaces recent escalations, provider cooldowns, and recent events in both the report and the markdown', () => {
    const env = setup()
    appendFileSync(join(env.loaded.stateDir, 'events.ndjson'), `${JSON.stringify({ at: '2026-09-12T11:00:00.000Z', type: 'contract.escalated', issue: 'ENG-6', reasons: ['blocking ambiguity: which app?'] })}\n`)
    appendFileSync(join(env.loaded.stateDir, 'events.ndjson'), `${JSON.stringify({ at: '2026-09-12T11:30:00.000Z', type: 'worker.dispatched', issue: 'ENG-7' })}\n`)
    writeFileSync(join(env.loaded.stateDir, 'provider-cooldowns.json'), JSON.stringify({ codex: { attempts: 1, until: '2026-09-13T00:00:00.000Z', reason: 'quota: weekly 100%', markedAt: NOW.toISOString() } }))
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.recentEscalations).toEqual([{ issue: 'ENG-6', at: '2026-09-12T11:00:00.000Z', reason: 'blocking ambiguity: which app?' }])
    expect(report.cooldowns).toEqual([{ provider: 'codex', reason: 'quota: weekly 100%', until: '2026-09-13T00:00:00.000Z' }])
    expect(report.recentEvents.map((e) => e.type)).toEqual(expect.arrayContaining(['contract.escalated', 'worker.dispatched']))
    const md = renderDebriefMarkdown(report)
    expect(md).toContain('## Provider cooldowns')
    expect(md).toContain('## Recent escalations')
    expect(md).toContain('## Recent events')
  })

  it('ages review phases from the current review instead of the original dispatch', () => {
    const env = setup()
    env.issue('ENG-3', {
      'dispatch.json': { issue: 'ENG-3', worktreeId: 'w', worktree: 'eng-3', branch: 'u/eng-3', terminal: 't', provider: 'claude', model: 'sonnet', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-09-12T08:00:00.000Z', url: 'https://linear.app/x/ENG-3' },
      'delivery.json': { issue: 'ENG-3', prNumber: 10, reviews: { aaa: { status: 'incomplete', at: '2026-09-12T11:50:00.000Z', provider: 'claude-cli', model: 'opus', blocking: 0, attempts: 1 } }, fixRounds: 0, nudges: [], heldFor: null, finishedAt: null, finalOutcome: null },
    })
    const report = buildDebriefReport({ loaded: env.loaded, now: () => NOW })
    expect(report.inFlight[0]).toMatchObject({ phase: 'review-incomplete', ageMin: 10 })
  })
})
