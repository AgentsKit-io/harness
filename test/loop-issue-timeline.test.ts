import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildIssueTimeline, renderIssueTimelineMarkdown } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempStateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-issue-timeline-')); cleanups.push(dir); mkdirSync(dir, { recursive: true }); return dir }
const write = (stateDir: string, event: Record<string, unknown>): void => appendFileSync(join(stateDir, 'events.ndjson'), `${JSON.stringify(event)}\n`)

describe('buildIssueTimeline', () => {
  it('orders one issue\'s events chronologically regardless of write order, and sums tokens/calls', () => {
    const stateDir = tempStateDir()
    write(stateDir, { at: '2026-09-20T10:05:00.000Z', type: 'worker.dispatched', issue: 'ENG-1', provider: 'claude', model: 'sonnet' })
    write(stateDir, { at: '2026-09-20T10:00:00.000Z', type: 'contract.generated', issue: 'ENG-1', provider: 'codex', model: 'gpt-5', digest: 'd' })
    write(stateDir, { at: '2026-09-20T10:10:00.000Z', type: 'pr.reviewed', issue: 'ENG-1', pr: 1, head: 'abc', status: 'clean', blocking: 0, provider: 'claude-cli', model: 'opus', inputTokens: 1_000, outputTokens: 200 })
    write(stateDir, { at: '2026-09-20T09:00:00.000Z', type: 'worker.dispatched', issue: 'ENG-2', provider: 'claude', model: 'sonnet' }) // a different issue, must be excluded

    const report = buildIssueTimeline(stateDir, 'ENG-1')
    expect(report.issue).toBe('ENG-1')
    expect(report.steps.map((step) => step.type)).toEqual(['contract.generated', 'worker.dispatched', 'pr.reviewed'])
    expect(report.steps[0]?.sinceLastMs).toBeNull()
    expect(report.steps[1]?.sinceLastMs).toBe(5 * 60_000)
    expect(report.steps[2]?.sinceLastMs).toBe(5 * 60_000)
    expect(report.totalMs).toBe(10 * 60_000)
    expect(report.totalTokens).toBe(1_200)
    expect(report.totalCalls).toBe(1)
  })

  it('collects fix rounds, cooldowns, and other friction as problems, and reads reason/error/status as the detail', () => {
    const stateDir = tempStateDir()
    write(stateDir, { at: '2026-09-20T10:00:00.000Z', type: 'contract.failed', issue: 'ENG-3', error: 'exited 1: quota' })
    write(stateDir, { at: '2026-09-20T10:05:00.000Z', type: 'worker.review-round', issue: 'ENG-3', pr: 1, head: 'abc', round: 1 })
    write(stateDir, { at: '2026-09-20T10:10:00.000Z', type: 'provider.cooldown', issue: 'ENG-3', provider: 'codex', kind: 'quota', until: '2026-09-20T11:00:00.000Z', source: 'review' })

    const report = buildIssueTimeline(stateDir, 'ENG-3')
    expect(report.problems.map((problem) => problem.type)).toEqual(['contract.failed', 'worker.review-round', 'provider.cooldown'])
    expect(report.problems[0]?.detail).toBe('exited 1: quota')
  })

  it('returns an empty timeline for an issue with no logged events', () => {
    const report = buildIssueTimeline(tempStateDir(), 'ENG-9')
    expect(report).toMatchObject({ issue: 'ENG-9', steps: [], totalMs: null, totalTokens: 0, totalCalls: 0, problems: [] })
  })
})

describe('renderIssueTimelineMarkdown', () => {
  it('renders a table of steps and a problems section', () => {
    const stateDir = tempStateDir()
    write(stateDir, { at: '2026-09-20T10:00:00.000Z', type: 'contract.generated', issue: 'ENG-1', provider: 'codex', model: 'gpt-5', digest: 'd' })
    write(stateDir, { at: '2026-09-20T10:05:00.000Z', type: 'worker.ci-round', issue: 'ENG-1', pr: 1, head: 'abc', round: 1 })
    const md = renderIssueTimelineMarkdown(buildIssueTimeline(stateDir, 'ENG-1'))
    expect(md).toContain('# Timeline — ENG-1')
    expect(md).toContain('codex/gpt-5')
    expect(md).toContain('## Problems')
    expect(md).toContain('worker.ci-round')
  })

  it('says plainly that there is nothing yet, for an issue with no events', () => {
    const md = renderIssueTimelineMarkdown(buildIssueTimeline(tempStateDir(), 'ENG-9'))
    expect(md).toContain('No events logged for this issue yet')
  })
})
