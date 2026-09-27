import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendLoopEvent, githubUpsertComment, renderRunSummaryMarkdown, classifyRunEvent, listAgentRuns, pruneAgentRuns, readAgentRunReport, renderAgentRunMarkdown, runDirFor } from '../src/index.js'
import { recordRunEvidence, recordRunIo } from '../src/loop/agent-runs.js'
import type { LoopEventPayload } from '../src/loop/event-bus.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-runs-')); cleanups.push(dir); return dir }

let clock = Date.parse('2026-09-20T10:00:00.000Z')
const emit = (dir: string, type: string, fields: Record<string, unknown> = {}): void => {
  clock += 60_000
  appendLoopEvent(dir, { at: new Date(clock).toISOString(), type, issue: 'ENG-1', ...fields } as LoopEventPayload)
}

describe('agent runs (ADR-0041)', () => {
  it('projects one issue into one run: stage, status, fix rounds, approval and machine-written handoffs', () => {
    const dir = stateDir()
    emit(dir, 'contract.generated', { digest: 'c1' })
    emit(dir, 'worker.dispatched', { maxFixRounds: 2 })
    emit(dir, 'worker.ci-round', { pr: 7, head: 'aaaa', round: 1 })
    emit(dir, 'pr.reviewed', { pr: 7, head: 'bbbbbbbbbbbbbbbb', status: 'clean' })
    emit(dir, 'worker.held', { reason: 'review clean; auto-merge disabled' })
    let report = readAgentRunReport(dir, 'ENG-1')
    expect(report?.state).toMatchObject({ runId: 'ENG-1-1', currentStage: 'review', status: 'awaiting-human', loopCount: 1, maxLoopCount: 2, pr: 7, head: 'bbbbbbbbbbbbbbbb', nextRequiredApproval: 'held: review clean; auto-merge disabled', closedAt: null })
    emit(dir, 'pr.human-approved', { head: 'bbbbbbbbbbbbbbbb', by: 'emerson' })
    emit(dir, 'pr.merged', { pr: 7 })
    emit(dir, 'worker.merged', { reason: 'merged' })
    report = readAgentRunReport(dir, 'ENG-1-1')
    expect(report?.state).toMatchObject({ currentStage: 'closed', status: 'completed', nextRequiredApproval: null })
    expect(report?.state.closedAt).not.toBeNull()
    expect(report?.handoffs.map((handoff) => `${String(handoff['from'])}->${String(handoff['to'])}`)).toEqual(['intake->contract', 'contract->build', 'build->fix', 'fix->review', 'review->merge', 'merge->closed'])
    expect(readdirSync(join(runDirFor(dir, 'ENG-1-1'), 'handoffs'))).toEqual(['01-intake-to-contract.json', '02-contract-to-build.json', '03-build-to-fix.json', '04-fix-to-review.json', '05-review-to-merge.json', '06-merge-to-closed.json'])
    expect(report?.handoffs[2]).toMatchObject({ trigger: { type: 'worker.ci-round', round: 1 }, loopCount: 1, maxLoopCount: 2 })
  })

  it('opens run n+1 on a re-dispatch or after a closed run, and attaches late events to the closed one', () => {
    const dir = stateDir()
    emit(dir, 'worker.dispatched', {})
    emit(dir, 'worker.dispatched', {})
    expect(listAgentRuns(dir).map((run) => [run.runId, run.status, run.supersedes])).toEqual(expect.arrayContaining([['ENG-1-1', 'superseded', null], ['ENG-1-2', 'running', 'ENG-1-1']]))
    emit(dir, 'worker.blocked', { reason: 'fix rounds exhausted' })
    emit(dir, 'ui.cleanup-completed', { runId: 'q1' })
    expect(readAgentRunReport(dir, 'ENG-1')?.state).toMatchObject({ runId: 'ENG-1-2', status: 'blocked', nextRequiredApproval: 'blocked: fix rounds exhausted' })
    emit(dir, 'contract.generated', { digest: 'c2' })
    expect(readAgentRunReport(dir, 'ENG-1')?.state).toMatchObject({ runId: 'ENG-1-3', supersedes: 'ENG-1-2', currentStage: 'contract' })
  })

  it('ignores events that belong to no issue', () => {
    const dir = stateDir()
    appendLoopEvent(dir, { at: new Date().toISOString(), type: 'stage.completed', stage: 'tick', durationMs: 1, status: 'ok', count: 0 } as LoopEventPayload)
    expect(existsSync(join(dir, 'runs'))).toBe(false)
  })

  it('records inputs and outputs redacted, bounded, and once per content', () => {
    const dir = stateDir()
    const prompt = 'Contact ops@example.com about ENG-1'
    const first = recordRunIo(dir, 'ENG-1', { direction: 'input', stage: 'contract', role: 'orchestrator', content: prompt })
    expect(recordRunIo(dir, 'ENG-1', { direction: 'input', stage: 'contract', role: 'orchestrator', content: prompt })).toEqual(first)
    const ref = recordRunIo(dir, 'ENG-1', { direction: 'input', stage: 'plan', role: 'planner', content: prompt })
    expect(ref).toMatchObject({ sameAs: first?.file, file: 'inputs/02-plan-planner.ref.json' })
    const runDir = runDirFor(dir, 'ENG-1-1')
    expect(readFileSync(join(runDir, first?.file ?? ''), 'utf8')).toBe('Contact [REDACTED:email] about ENG-1')
    const log = recordRunIo(dir, 'ENG-1', { direction: 'output', stage: 'build', role: 'worker-terminal', content: `${'x'.repeat(2000)}FAILED here`, extension: 'txt', maxBytes: 1024 })
    const tail = readFileSync(join(runDir, log?.file ?? ''), 'utf8')
    expect(tail.startsWith('…[truncated')).toBe(true)
    expect(tail.endsWith('FAILED here')).toBe(true)
    expect(readAgentRunReport(dir, 'ENG-1')?.state.lastOutput).toBe('runs/ENG-1-1/outputs/01-build-worker-terminal.txt')
  })

  it('hands the next stage exactly the I/O recorded since the last handoff, plus the frozen contract', () => {
    const dir = stateDir()
    mkdirSync(join(dir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(dir, 'issues', 'ENG-1', 'contract.json'), JSON.stringify({ schemaVersion: 1, issue: 'ENG-1', digest: 'c1', contract: { outcomes: [{ id: 'O1' }, { id: 'O2' }] } }))
    recordRunIo(dir, 'ENG-1', { direction: 'input', stage: 'contract', role: 'orchestrator', content: 'prompt' })
    recordRunIo(dir, 'ENG-1', { direction: 'output', stage: 'contract', role: 'orchestrator', content: 'answer' })
    emit(dir, 'contract.generated', { digest: 'c1' })
    const [handoff] = readAgentRunReport(dir, 'ENG-1')?.handoffs ?? []
    expect((handoff?.['handed'] as { file: string }[]).map((entry) => entry.file)).toEqual(['inputs/01-contract-orchestrator.md', 'outputs/01-contract-orchestrator.md'])
    expect(handoff?.['contract']).toEqual({ digest: 'c1', outcomes: ['O1', 'O2'] })
    expect(readAgentRunReport(dir, 'ENG-1')?.state.pending).toEqual([])
  })

  it('links evidence by hash without copying it, and picks up the review file from pr.reviewed', () => {
    const dir = stateDir()
    const verify = join(dir, 'verify.json')
    writeFileSync(verify, '{"outcomes":[]}')
    recordRunEvidence(dir, 'ENG-1', 'verify', verify)
    recordRunEvidence(dir, 'ENG-1', 'verify', verify)
    mkdirSync(join(dir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(dir, 'issues', 'ENG-1', 'review-bbbbbbbbbbbb.json'), '{"status":"clean"}')
    emit(dir, 'pr.reviewed', { pr: 7, head: 'bbbbbbbbbbbbbbbb' })
    const state = readAgentRunReport(dir, 'ENG-1')?.state
    expect(state?.evidence.map((item) => [item.kind, item.path])).toEqual([['verify', 'verify.json'], ['review', 'issues/ENG-1/review-bbbbbbbbbbbb.json']])
    expect(JSON.parse(readFileSync(join(runDirFor(dir, 'ENG-1-1'), 'evidence', 'index.json'), 'utf8'))).toHaveLength(2)
  })

  it('prunes to `keep` runs per issue and drops expired closed runs, never the open one', () => {
    const dir = stateDir()
    for (let index = 0; index < 4; index += 1) emit(dir, 'worker.dispatched', {})
    emit(dir, 'worker.dispatched', { issue: 'ENG-2' })
    const removed = pruneAgentRuns(dir, { keep: 2, maxAgeDays: 30, now: new Date(clock) })
    expect([...removed].sort()).toEqual(['ENG-1-1', 'ENG-1-2'])
    expect(listAgentRuns(dir).map((run) => run.runId).sort()).toEqual(['ENG-1-3', 'ENG-1-4', 'ENG-2-1'])
    expect(pruneAgentRuns(dir, { keep: 5, maxAgeDays: 1, now: new Date(clock + 3 * 86_400_000) })).toEqual(['ENG-1-3'])
  })

  it('classifies without side effects and renders a readable reconstruction', () => {
    expect(classifyRunEvent({ type: 'plan.escalated', unresolved: ['no test for O2'] })).toEqual({ stage: 'plan', status: 'awaiting-human', approval: 'plan: no test for O2' })
    expect(classifyRunEvent({ type: 'provider.call' })).toEqual({})
    const dir = stateDir()
    emit(dir, 'contract.generated', {})
    const markdown = renderAgentRunMarkdown(readAgentRunReport(dir, 'ENG-1')!)
    expect(markdown).toContain('# Run ENG-1-1')
    expect(markdown).toContain('1. intake → contract (contract.generated)')
  })

  it('never posts a second copy of the summary when the comment lookup fails', async () => {
    const calls: string[][] = []
    const runner = { run: async (argv: readonly string[]) => { calls.push([...argv]); return { code: 1, stdout: '', stderr: 'HTTP 502', timedOut: false, durationMs: 1 } } }
    await expect(githubUpsertComment(runner, { repo: 'o/r', number: 7, body: 'b', marker: '<!-- m -->' })).rejects.toThrow(/HTTP 502/)
    expect(calls).toHaveLength(1)
  })

  it('redacts secrets from the approval text and handoff fields that reach the PR summary', () => {
    const dir = stateDir()
    emit(dir, 'worker.dispatched', {})
    emit(dir, 'worker.permission-wait', { terminal: 't', reason: 'Allow `curl -H "Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123"`?', context: { key: 'lin_api_abcdefghijklmnopqrstuvwxyz' } })
    const report = readAgentRunReport(dir, 'ENG-1')!
    expect(report.state.nextRequiredApproval).toContain('[REDACTED:api-key]')
    expect(renderRunSummaryMarkdown(report)).not.toContain('ghp_')
    expect(JSON.stringify(report.handoffs)).not.toMatch(/ghp_|lin_api_/)
  })
})
