import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyWatchEvent, classifyWatchPhase, formatWatchEvent, loadLoopConfig, snapshotWatchTargets, watchDeliveries } from '../src/index.js'
import type { CommandResult, CommandRunner, DeliveryState } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const delivery = (over: Partial<DeliveryState> = {}): DeliveryState => ({
  issue: 'ENG-1',
  prNumber: 9,
  reviews: {},
  fixRounds: 0,
  nudges: [],
  heldFor: null,
  finishedAt: null,
  finalOutcome: null,
  ...over,
})

describe('loop watch', () => {
  it('classifies delivery phases into DONE / FAILED / ACTION_REQUIRED', () => {
    expect(classifyWatchPhase(delivery({ finalOutcome: 'merged', finishedAt: 't' }), null)).toBe('merged')
    expect(classifyWatchPhase(delivery({ reviews: { a: { status: 'incomplete', at: 't', provider: 'x', model: 'm', blocking: 0, attempts: 2 } } }), null)).toBe('held-incomplete-review')
    const event = classifyWatchEvent('held-incomplete-review', delivery({ reviews: { a: { status: 'incomplete', at: 't', provider: 'x', model: 'm', blocking: 0, attempts: 2 } } }), null, '2026-09-12T12:00:00.000Z', 'ENG-1')
    expect(event.kind).toBe('ACTION_REQUIRED')
    expect(formatWatchEvent(event)).toContain('ACTION_REQUIRED: ENG-1')
  })

  it('emits DONE when delivery.json is already merged (--once)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify({ issue: 'ENG-1', worktreeId: 'w', worktree: 'w', branch: 'b', terminal: 't', provider: 'claude', model: 'sonnet', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-09-12T11:00:00.000Z', url: 'u' }))
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'delivery.json'), JSON.stringify(delivery({ finalOutcome: 'merged', finishedAt: '2026-09-12T11:50:00.000Z' })))
    const seen: string[] = []
    const report = await watchDeliveries({ loaded, once: true, livePr: false, onEvent: (event) => seen.push(event.kind) })
    expect(report.status).toBe('done')
    expect(seen).toEqual(['DONE'])
    expect(report.targets[0]?.phase).toBe('merged')
  })

  it('classifyWatchPhase covers every remaining branch', () => {
    expect(classifyWatchPhase(delivery(), { state: 'MERGED' } as never)).toBe('merged')
    expect(classifyWatchPhase(delivery({ finalOutcome: 'failed' }), null)).toBe('failed')
    expect(classifyWatchPhase(delivery({ finalOutcome: 'stuck' }), null)).toBe('stuck')
    expect(classifyWatchPhase(delivery({ finalOutcome: 'abandoned' }), null)).toBe('abandoned')
    expect(classifyWatchPhase(delivery(), { state: 'CLOSED' } as never)).toBe('closed')
    expect(classifyWatchPhase(delivery({ heldFor: 'a' }), null)).toBe('held')
    expect(classifyWatchPhase(delivery({ reviews: { a: { status: 'incomplete', at: 't', provider: 'x', model: 'm', blocking: 0, attempts: 1 } } }), null)).toBe('review-incomplete')
    expect(classifyWatchPhase(delivery({ reviews: { a: { status: 'findings', at: 't', provider: 'x', model: 'm', blocking: 1, attempts: 1 } } }), null)).toBe('fix-round')
    expect(classifyWatchPhase(delivery({ reviews: { a: { status: 'clean', at: 't', provider: 'x', model: 'm', blocking: 0, attempts: 1 } } }), null)).toBe('ready-to-merge')
    expect(classifyWatchPhase(delivery({ prNumber: 9 }), null)).toBe('awaiting-review')
    expect(classifyWatchPhase(delivery({ prNumber: null }), null)).toBe('waiting-for-pr')
  })

  it('classifyWatchEvent covers every remaining branch', () => {
    const at = '2026-09-12T12:00:00.000Z'
    expect(classifyWatchEvent('closed', delivery({ finalOutcome: 'stuck' }), null, at, 'ENG-1')).toMatchObject({ kind: 'FAILED', message: expect.stringContaining('closed without merge') })
    expect(classifyWatchEvent('failed', delivery({ finalOutcome: 'failed' }), null, at, 'ENG-1')).toMatchObject({ kind: 'FAILED' })
    expect(classifyWatchEvent('held', delivery({ heldFor: 'ambiguity-clock' }), null, at, 'ENG-1')).toMatchObject({ kind: 'ACTION_REQUIRED', message: expect.stringContaining('ambigui') })
    expect(classifyWatchEvent('held', delivery({ heldFor: null }), null, at, 'ENG-1')).toMatchObject({ kind: 'ACTION_REQUIRED', message: 'Held for a human' })
    expect(classifyWatchEvent('fix-round', delivery({ fixRounds: 2 }), null, at, 'ENG-1')).toMatchObject({ kind: 'ACTION_REQUIRED', message: expect.stringContaining('(2)') })
    expect(classifyWatchEvent('waiting-for-pr', delivery({ prNumber: null }), null, at, 'ENG-1')).toMatchObject({ kind: 'PROGRESS' })
    expect(classifyWatchEvent('awaiting-review', delivery({ prNumber: 9 }), null, at, 'ENG-1')).toMatchObject({ kind: 'PROGRESS', message: expect.stringContaining('PR #9') })
  })

  const pr = (overrides: Record<string, unknown> = {}): CommandResult => ({
    code: 0,
    stdout: JSON.stringify({ author: { id: 'u', is_bot: false, login: 'p', name: 'P' }, baseRefName: 'main', files: [], headRefName: 'person/eng-1', headRefOid: 'sha', isDraft: false, labels: [], mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', number: 6111, reviewDecision: '', state: 'OPEN', title: 't', updatedAt: '2026-09-11T00:00:00Z', statusCheckRollup: [], url: 'u', ...overrides }),
    stderr: '', timedOut: false, durationMs: 1,
  })

  const dispatchRecord = (issue: string, branch = 'b'): Record<string, unknown> => ({ issue, worktreeId: 'w', worktree: 'w', branch, terminal: 't', provider: 'claude', model: 'sonnet', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-09-12T11:00:00.000Z', url: 'u' })

  it('snapshotWatchTargets fetches a live PR by number, skips a filtered-in issue with no state at all, and filters to a single issue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-snap-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify(dispatchRecord('ENG-1')))
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'delivery.json'), JSON.stringify(delivery({ prNumber: 6111 })))
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-2'), { recursive: true }) // no dispatch.json, no delivery.json content — nothing to report
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv) => { calls.push([...argv]); return pr() } }
    const targets = await snapshotWatchTargets({ loaded, runner, livePr: true })
    expect(targets.map((t) => t.issue)).toEqual(['ENG-1'])
    expect(targets[0]?.pr?.number).toBe(6111)
    expect(calls[0]).toContain('view')

    const filtered = await snapshotWatchTargets({ loaded, runner, livePr: true, issue: 'ENG-1' })
    expect(filtered).toHaveLength(1)

    // ENG-2 has neither a dispatch record nor any delivery state — explicitly asking to watch it yields nothing.
    const skipped = await snapshotWatchTargets({ loaded, runner, livePr: true, issue: 'ENG-2' })
    expect(skipped).toHaveLength(0)
  })

  it('snapshotWatchTargets falls back to the branch lookup when there is no PR number yet, and swallows a failed live-PR call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-snap2-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify(dispatchRecord('ENG-1', 'person/eng-1')))
    const runner: CommandRunner = { run: async (argv) => argv.includes('list') ? { code: 0, stdout: JSON.stringify([JSON.parse((pr() as { stdout: string }).stdout)]), stderr: '', timedOut: false, durationMs: 1 } : pr() }
    const targets = await snapshotWatchTargets({ loaded, runner, livePr: true })
    expect(targets[0]?.pr?.headRef).toBe('person/eng-1')

    const failingRunner: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 }) }
    const failed = await snapshotWatchTargets({ loaded, runner: failingRunner, livePr: true })
    expect(failed[0]?.pr).toBeNull()
  })

  it('watchDeliveries polls until timeout, reporting action-required over waiting, and suppresses the initial PROGRESS event but not an initial ACTION_REQUIRED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-poll-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify(dispatchRecord('ENG-1')))
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'delivery.json'), JSON.stringify(delivery({ heldFor: 'blocked' })))
    let now = new Date('2026-09-12T12:00:00.000Z')
    const sleeps: number[] = []
    const seen: string[] = []
    const report = await watchDeliveries({
      loaded, livePr: false, intervalMs: 1000, timeoutMs: 2500,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now = new Date(now.getTime() + ms) },
      onEvent: (event) => seen.push(event.kind),
    })
    expect(report.status).toBe('action-required')
    expect(seen).toEqual(['ACTION_REQUIRED']) // reported on the very first tick, unlike a PROGRESS phase
    expect(sleeps.length).toBeGreaterThan(0)
  })

  it('watchDeliveries stops as soon as every target reaches a terminal phase, and re-reports a changed non-initial phase', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-poll2-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify(dispatchRecord('ENG-1')))
    const deliveryPath = join(loaded.stateDir, 'issues', 'ENG-1', 'delivery.json')
    writeFileSync(deliveryPath, JSON.stringify(delivery({ prNumber: null })))
    let tickCount = 0
    const seen: string[] = []
    const report = await watchDeliveries({
      loaded, livePr: false, intervalMs: 10,
      sleep: async () => {
        tickCount += 1
        if (tickCount === 1) writeFileSync(deliveryPath, JSON.stringify(delivery({ finalOutcome: 'merged', finishedAt: '2026-09-12T12:00:00.000Z' })))
      },
      onEvent: (event) => seen.push(event.kind),
    })
    expect(report.status).toBe('done')
    expect(seen).toEqual(['DONE']) // the initial waiting-for-pr PROGRESS was suppressed; only the change to merged was reported
  })

  it('waits for a named issue that is not dispatched yet instead of calling it done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-pending-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    expect((await watchDeliveries({ loaded, issue: 'ENG-1', once: true, livePr: false })).status).toBe('waiting')
    let tickCount = 0
    const seen: string[] = []
    const report = await watchDeliveries({
      loaded, issue: 'ENG-1', livePr: false, intervalMs: 10,
      sleep: async () => {
        tickCount += 1
        // Dispatched between polls, then merged: the watch must still be there to see it.
        if (tickCount === 1) {
          mkdirSync(join(loaded.stateDir, 'issues', 'ENG-1'), { recursive: true })
          writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify(dispatchRecord('ENG-1')))
          writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'delivery.json'), JSON.stringify(delivery({ finalOutcome: 'merged', finishedAt: '2026-09-12T12:00:00.000Z' })))
        }
      },
      onEvent: (event) => seen.push(event.kind),
    })
    expect(report.status).toBe('done')
    expect(seen).toContain('DONE')
  })

  it('uses the real clock and a real timer for now/sleep when neither is overridden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-defaults-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    const report = await watchDeliveries({ loaded, once: true, livePr: false })
    expect(report.status).toBe('done') // no dispatched issues at all → targets.length === 0
    expect(Date.parse(report.generatedAt)).not.toBeNaN()
  })

  it('polls with the real default sleep timer until timeoutMs elapses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-realsleep-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify(dispatchRecord('ENG-1')))
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'delivery.json'), JSON.stringify(delivery({ prNumber: null })))
    const report = await watchDeliveries({ loaded, livePr: false, intervalMs: 20, timeoutMs: 30 })
    expect(report.status).toBe('waiting') // stays at waiting-for-pr (PROGRESS) the whole time, so the real timer is what ends the loop
  }, 10_000)

  it('reports a mix of a failed and a terminal target as failed once all targets are terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-watch-mixed-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-1'), { recursive: true })
    mkdirSync(join(loaded.stateDir, 'issues', 'ENG-2'), { recursive: true })
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify(dispatchRecord('ENG-1')))
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-1', 'delivery.json'), JSON.stringify(delivery({ finalOutcome: 'merged', finishedAt: '2026-09-12T12:00:00.000Z' })))
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-2', 'dispatch.json'), JSON.stringify(dispatchRecord('ENG-2')))
    writeFileSync(join(loaded.stateDir, 'issues', 'ENG-2', 'delivery.json'), JSON.stringify(delivery({ issue: 'ENG-2', finalOutcome: 'failed' })))
    const report = await watchDeliveries({ loaded, once: true, livePr: false })
    expect(report.status).toBe('failed')
  })
})
