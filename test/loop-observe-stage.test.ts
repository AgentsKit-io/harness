import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessObserveStage, readObserverState, renderObserveMarkdown, staleStageLocks } from '../src/index.js'
import type { AutomationStatus, ObservabilityReport, ObserveAssessmentInput, ObserverState } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const NOW = new Date('2026-09-19T12:00:00.000Z')
const EMPTY: ObserverState = { signature: null, firstSeenAt: null, lastNotifiedAt: null }

const observability = (overrides: Partial<ObservabilityReport> = {}): ObservabilityReport => ({
  status: 'healthy',
  generatedAt: NOW.toISOString(),
  project: 'pilot',
  person: 'person',
  windowHours: 24,
  anomalies: [],
  failingChecks: [],
  metrics: {
    queueReady: 0, freeSlots: 1, runningWorkers: 0, maxAgents: 3, activeClaims: 0, inFlight: 0, held: 0, merged: 0, blocked: 0,
    fixRounds: 0, reviewFindings: 0, reviewIncomplete: 0, medianLeadTimeMin: null, providerRemainingPercent: {},
    machine: { cpuCount: 8, load1PerCpuPercent: 10, memoryUsedPercent: 50, freeRamGb: 8 },
    memory: { recalls: 0, hits: 0, approxCharsSaved: 0 }, cache: { cachedContracts: 0 },
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }, events: {},
  },
  ...overrides,
})

const automation = (overrides: Partial<AutomationStatus> = {}): AutomationStatus => ({
  stage: 'tick', name: 'loop-tick', installed: true, enabled: true, id: 'auto-1', trigger: '*/5 * * * *', provider: 'claude',
  lastRun: { at: new Date(NOW.getTime() - 60_000).toISOString(), status: 'skipped_precheck' }, runs: 3, ...overrides,
})

const assess = (overrides: Partial<ObserveAssessmentInput> = {}) => assessObserveStage({
  observability: observability(), automations: [automation()], automationError: null, staleLocks: [],
  previous: EMPTY, now: NOW, reminderHours: 2, schedulerStallMin: 20, ...overrides,
})

describe('observe stage assessment', () => {
  it('stays silent and clears the remembered problem set when nothing is wrong', () => {
    const { report, state } = assess({ previous: { signature: 'old', firstSeenAt: '2026-09-19T09:00:00.000Z', lastNotifiedAt: '2026-09-19T09:00:00.000Z' } })
    expect(report).toMatchObject({ status: 'healthy', notify: false, reason: 'healthy', problems: [] })
    expect(state).toEqual(EMPTY)
    expect(renderObserveMarkdown({ ...report, observability: observability() })).toContain('No problems detected')
  })

  it('collects action-required anomalies, failing doctor checks, automation health and stale locks', () => {
    const { report } = assess({
      observability: observability({
        status: 'action_required',
        anomalies: [
          { id: 'stalled-delivery', severity: 'action_required', issue: 'ENG-7', message: 'ENG-7 is in fix-round for 90 min', evidence: {} },
          { id: 'connected-without-output', severity: 'warning', issue: null, message: 'ignored: warnings are not escalations', evidence: {} },
        ],
        failingChecks: [{ id: 'provider.claude', status: 'warning', detail: 'auth expired' }],
      }),
      automations: [automation(), automation({ stage: 'deliver', name: 'loop-deliver', enabled: false }), automation({ stage: 'retro', name: 'loop-retro', installed: false, id: null, lastRun: null }), automation({ stage: 'observe', name: 'loop-observe', lastRun: { at: new Date(NOW.getTime() - 60 * 60_000).toISOString(), status: 'ok' } })],
      staleLocks: ['.stage-tick.lock'],
    })
    expect(report.problems.map((problem) => problem.id)).toEqual([
      'anomaly:stalled-delivery:ENG-7',
      'automation-disabled:loop-deliver',
      'automation-missing:loop-retro',
      'automation-stalled:loop-observe',
      'check:provider.claude',
      'stale-lock:.stage-tick.lock',
    ])
    expect(report).toMatchObject({ status: 'action_required', notify: true, reason: 'new-problems', firstSeenAt: NOW.toISOString() })
    expect(renderObserveMarkdown({ ...report, observability: observability() })).toContain('automation-disabled:loop-deliver')
  })

  it('reports the tracker being unreachable instead of calling the loop healthy', () => {
    const { report } = assess({ automations: [], automationError: 'orca automations list failed' })
    expect(report.problems.map((problem) => problem.id)).toEqual(['automations:unavailable'])
    expect(report.notify).toBe(true)
  })

  it('goes quiet on an unchanged problem set and speaks again only after the reminder window', () => {
    // No automations in this case: the clock moves hours, and a fixed lastRun would age into a second problem.
    const failing = { observability: observability({ failingChecks: [{ id: 'linear.queue', status: 'failed' as const, detail: 'unreachable' }] }), automations: [] }
    const first = assess(failing)
    expect(first.report.reason).toBe('new-problems')

    const soon = assess({ ...failing, previous: first.state, now: new Date(NOW.getTime() + 30 * 60_000) })
    expect(soon.report).toMatchObject({ status: 'action_required', notify: false, reason: 'already-notified', firstSeenAt: NOW.toISOString() })
    expect(soon.state.lastNotifiedAt).toBe(first.state.lastNotifiedAt)

    const later = assess({ ...failing, previous: first.state, now: new Date(NOW.getTime() + 3 * 3_600_000) })
    expect(later.report).toMatchObject({ notify: true, reason: 'reminder', firstSeenAt: NOW.toISOString() })
    expect(later.state.lastNotifiedAt).toBe(new Date(NOW.getTime() + 3 * 3_600_000).toISOString())

    // A different problem set is a new notification, even inside the reminder window.
    const other = assess({ observability: observability({ failingChecks: [{ id: 'orca.runtime', status: 'failed' as const, detail: 'runtime down' }] }), automations: [], previous: first.state, now: new Date(NOW.getTime() + 60_000) })
    expect(other.report.reason).toBe('new-problems')
    expect(other.report.signature).not.toBe(first.report.signature)
  })

  it('treats a never-notified but remembered signature as overdue rather than silent', () => {
    const { report } = assess({
      observability: observability({ failingChecks: [{ id: 'linear.queue', status: 'failed', detail: 'unreachable' }] }),
      previous: { signature: assess({ observability: observability({ failingChecks: [{ id: 'linear.queue', status: 'failed', detail: 'unreachable' }] }) }).report.signature, firstSeenAt: '2026-09-19T08:00:00.000Z', lastNotifiedAt: null },
    })
    expect(report).toMatchObject({ notify: true, reason: 'reminder', firstSeenAt: '2026-09-19T08:00:00.000Z' })
  })
})

describe('observer state and stage locks on disk', () => {
  it('reads a missing or corrupt state file as "nothing remembered"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-observe-')); cleanups.push(dir)
    expect(readObserverState(dir)).toEqual(EMPTY)
    writeFileSync(join(dir, 'observer-state.json'), '{ not json')
    expect(readObserverState(dir)).toEqual(EMPTY)
    writeFileSync(join(dir, 'observer-state.json'), JSON.stringify({ signature: 'abc', firstSeenAt: 1, lastNotifiedAt: '2026-09-19T09:00:00.000Z' }))
    expect(readObserverState(dir)).toEqual({ signature: 'abc', firstSeenAt: null, lastNotifiedAt: '2026-09-19T09:00:00.000Z' })
  })

  it('finds only stage locks older than the threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-observe-locks-')); cleanups.push(dir)
    expect(staleStageLocks(join(dir, 'missing'), 30, NOW)).toEqual([])
    mkdirSync(join(dir, 'state'), { recursive: true })
    for (const name of ['.stage-tick.lock', '.stage-deliver.lock', 'contract.json']) writeFileSync(join(dir, 'state', name), '{}')
    const old = (NOW.getTime() - 90 * 60_000) / 1000
    utimesSync(join(dir, 'state', '.stage-tick.lock'), old, old)
    expect(staleStageLocks(join(dir, 'state'), 30, NOW)).toEqual(['.stage-tick.lock'])
  })
})
