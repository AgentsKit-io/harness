import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
