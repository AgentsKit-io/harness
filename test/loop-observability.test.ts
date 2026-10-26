import { describe, expect, it } from 'vitest'
import { assessObservability, renderObservabilityMarkdown } from '../src/index.js'
import { silentStates } from '../src/loop/debrief.js'

const base = {
  generatedAt: '2026-09-13T01:00:00.000Z', project: 'agentskit/os', person: 'victor', windowHours: 24, workerIdleTimeoutMin: 45,
  queueReady: 2, freeSlots: 1, runningWorkers: 0, maxAgents: 1, activeClaims: 1, missingDeliveryIssues: [] as string[],
  terminals: [], finalizedDirtyWorktrees: [] as { worktreeId: string; issue: string | null; files: number }[], issues: [] as { issue: string; phase: string; ageMin: number | null; heldFor: string | null }[], events: [] as { at: string; type: string; issue?: string }[],
  merged: 0, blocked: 0, fixRounds: 0, reviewFindings: 0, reviewIncomplete: 0, medianLeadTimeMin: null,
  providerRemainingPercent: { claude: 80 }, machine: { cpuCount: 8, load1PerCpuPercent: 20, memoryUsedPercent: 50, freeRamGb: 8 }, memory: { recalls: 0, hits: 0, approxCharsSaved: 0 }, cache: { cachedContracts: 0 }, tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
}

describe('loop observability', () => {
  it('detects the requested blocking signals and exposes operating metrics', () => {
    const report = assessObservability({
      ...base,
      missingDeliveryIssues: ['ABC-1'],
      terminals: [{ handle: 't1', status: 'connected', worktreeId: 'w1', lastOutputAt: null, preview: '' }],
      finalizedDirtyWorktrees: [{ worktreeId: 'w2', issue: 'ABC-2', files: 3 }],
      issues: [{ issue: 'ABC-3', phase: 'fix-round', ageMin: 60, heldFor: null }],
    })
    expect(report.status).toBe('action_required')
    expect(report.anomalies.map((item) => item.id)).toEqual(expect.arrayContaining(['claim-without-delivery', 'connected-without-output', 'finalized-dirty-worktree', 'queue-ready-no-dispatch', 'stalled-delivery']))
    expect(report.metrics.queueReady).toBe(2)
  })

  it('does not flag a held item as a stalled review and renders a useful report', () => {
    const report = assessObservability({ ...base, queueReady: 0, freeSlots: 0, issues: [{ issue: 'ABC-4', phase: 'review-incomplete', ageMin: 90, heldFor: 'human' }] })
    expect(report.status).toBe('healthy')
    expect(report.anomalies).toHaveLength(0)
    expect(renderObservabilityMarkdown(report)).toContain('## Metrics')
  })

  it('lists an issue in one loop state for over 2 h without an event as an anomaly', () => {
    const now = new Date(base.generatedAt)
    const rows = [
      { issue: 'o/r#1', phase: 'waiting-for-pr', dispatchedAt: '2026-09-12T10:00:00.000Z' },
      { issue: 'o/r#2', phase: 'waiting-for-pr', dispatchedAt: '2026-09-12T10:00:00.000Z' },
      { issue: 'o/r#3', phase: 'fix-round', dispatchedAt: '2026-09-13T00:30:00.000Z' },
    ]
    // #1 last moved 14 h ago; #2 had an event 10 min ago; #3 was dispatched 30 min ago and has had none since.
    const silent = silentStates(rows, [{ at: '2026-09-12T11:00:00.000Z', type: 'worker.dispatched', issue: 'o/r#1' }, { at: '2026-09-13T00:50:00.000Z', type: 'delivery.error', issue: 'o/r#2' }], now)
    expect(silent).toEqual([{ issue: 'o/r#1', phase: 'waiting-for-pr', silentMin: 840 }])
    const report = assessObservability({ ...base, queueReady: 0, silentStates: silent })
    expect(report.anomalies).toEqual([expect.objectContaining({ id: 'silent-state', severity: 'action_required', issue: 'o/r#1', message: expect.stringMatching(/840 min without an event/) })])
  })

  it('does not report an idle queue while a scheduled stage owns the lock', () => {
    const report = assessObservability({ ...base, stageBusy: true, queueReady: 1, freeSlots: 1, events: [] })
    expect(report.anomalies.map((item) => item.id)).not.toContain('queue-ready-no-dispatch')
  })
})
