import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDispatchLedger, loadLoopConfig, readObserverState, runObservability, runObserveStage } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/loop', `${name}.json`), 'utf8')) as unknown
const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const table: Record<string, CommandResult> = {
  'orca --version': { code: 0, stdout: '1.4.200\n', stderr: '', timedOut: false, durationMs: 1 },
  'orca status --json': ok(fixture('status')),
  'orca account list --json': ok(fixture('account-list')),
  'orca agent hooks status --json': ok(fixture('agent-hooks')),
  'orca worktree ps --json': ok(fixture('worktree-ps')),
}

const fakeRunner = (overrides: Partial<Record<string, CommandResult>> = {}): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  const merged = { ...table, ...overrides }
  return {
    calls,
    run: async (argv) => {
      calls.push([...argv])
      return merged[argv.join(' ')] ?? { code: 127, stdout: '', stderr: `no fixture for ${argv.join(' ')}`, timedOut: false, durationMs: 1 }
    },
  }
}

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-observability-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  mkdirSync(loaded.stateDir, { recursive: true })
  return { dir, loaded }
}

describe('runObservability', () => {
  it('assembles a healthy report from doctor, debrief, and event-log state with a mostly-empty environment', async () => {
    const env = setup()
    const report = await runObservability({ loaded: env.loaded, runner: fakeRunner(), now: () => new Date('2026-09-13T12:00:00.000Z') })
    expect(report.project).toBe('my-project')
    expect(report.metrics.merged).toBe(0)
    expect(report.metrics.tokens.total).toBe(0)
    expect(typeof report.metrics.providerRemainingPercent).toBe('object')
  })

  it('flags a finalized worktree that still has uncommitted files', async () => {
    const env = setup()
    const worktreePs = {
      id: 'fixture', ok: true, result: {
        worktrees: [{ workspaceKind: 'git', worktreeId: 'w-dirty', repoId: 'repo-1', hostId: 'local', terminalPlatform: 'darwin', repo: 'demo', path: '/repo/worktrees/w-dirty', branch: 'refs/heads/x', isArchived: false, isMainWorktree: false, displayName: 'x', workspaceStatus: 'completed', lastActivityAt: 1, createdAt: 1, linkedIssue: null, linkedPR: null, linkedLinearIssue: { identifier: 'ENG-9', url: 'u' }, comment: '', isActive: false, liveTerminalCount: 0, hasAttachedPty: false }],
        hostScope: { hostIds: ['local'], omittedHostIds: [] }, totalCount: 1, truncated: false,
      },
    }
    const runner = fakeRunner({
      'orca worktree ps --json': ok(worktreePs),
      'git -C /repo/worktrees/w-dirty status --porcelain': { code: 0, stdout: ' M src/index.ts\n?? new-file.ts\n', stderr: '', timedOut: false, durationMs: 1 },
    })
    const report = await runObservability({ loaded: env.loaded, runner, now: () => new Date('2026-09-13T12:00:00.000Z') })
    expect(report.status).toBe('action_required')
    expect(report.anomalies).toContainEqual(expect.objectContaining({ id: 'finalized-dirty-worktree', issue: 'ENG-9' }))
  })

  it('surfaces a claim-without-delivery anomaly and counts merged/blocked events from the ledger and log', async () => {
    const env = setup()
    const runner = fakeRunner()
    const ledger = createDispatchLedger(env.loaded.stateDir)
    const identity = { tracker: 'linear', repository: 'org/demo', issue: 'ENG-5', worktree: 'w5', branch: 'person/eng-5' }
    const { lease } = ledger.claim({ ...identity, owner: 'worker-1' })
    ledger.recordDispatch({ lease, idempotencyKey: 'idem-1', commandDigest: 'digest-1' })
    appendFileSync(join(env.loaded.stateDir, 'events.ndjson'), `${JSON.stringify({ at: '2026-09-13T11:30:00.000Z', type: 'worker.dispatched', issue: 'ENG-5' })}\n`)
    appendFileSync(join(env.loaded.stateDir, 'events.ndjson'), `${JSON.stringify({ at: '2026-09-13T11:45:00.000Z', type: 'pr.merged', issue: 'ENG-6' })}\n`)
    const report = await runObservability({ loaded: env.loaded, runner, now: () => new Date('2026-09-13T12:00:00.000Z') })
    expect(report.anomalies.some((item) => item.id === 'claim-without-delivery' && item.issue === 'ENG-5')).toBe(true)
    expect(report.metrics.merged).toBe(1)
  })
})

describe('runObserveStage', () => {
  it('scans, remembers the problem set on disk, and stays silent on the second identical scan', async () => {
    const env = setup()
    const now = new Date('2026-09-13T12:00:00.000Z')
    // No automations exist yet in this fake Orca, so the scan has real problems to report.
    const runner = fakeRunner({ 'orca automations list --json': ok({ ok: true, result: { automations: [] } }) })
    const first = await runObserveStage({ loaded: env.loaded, runner, now: () => now })
    expect(first).toMatchObject({ status: 'action_required', notify: true, reason: 'new-problems' })
    expect(first.problems.map((problem) => problem.id)).toContain('automation-missing:loop-my-project-tick')
    expect(first.observability.project).toBe('my-project')
    expect(readObserverState(env.loaded.stateDir)).toMatchObject({ signature: first.signature, firstSeenAt: now.toISOString() })

    const second = await runObserveStage({ loaded: env.loaded, runner, now: () => new Date('2026-09-13T12:05:00.000Z') })
    expect(second).toMatchObject({ notify: false, reason: 'already-notified', signature: first.signature })

    // `persist: false` is how a human can run the scan without moving the automation's own dedupe state.
    const dry = await runObserveStage({ loaded: env.loaded, runner, now: () => new Date('2026-09-13T20:00:00.000Z'), persist: false })
    expect(dry.notify).toBe(true)
    expect(readObserverState(env.loaded.stateDir).lastNotifiedAt).toBe(now.toISOString())
  })

  it('reports the automation list being unreachable as a problem of its own', async () => {
    const env = setup()
    const report = await runObserveStage({ loaded: env.loaded, runner: fakeRunner(), now: () => new Date('2026-09-13T12:00:00.000Z') })
    expect(report.problems.map((problem) => problem.id)).toContain('automations:unavailable')
  })
})
