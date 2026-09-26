import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTRACT_SCHEMA_VERSION, contractPath } from '../src/loop/contract.js'
import type { LoopEvent } from '../src/loop/retro.js'
import { emptyProjection, reduce } from '../src/ui/api/projection.js'
import { feedRoutes, recentEvents, summarizeEvent } from '../src/ui/api/routes-feed.js'
import type { RouteContext } from '../src/ui/api/routes.js'
import { fixRoundsLabel, phaseAgeMs } from '../src/ui/app/src/lib/runs.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const call = async (context: RouteContext, path: string): Promise<{ status: number; body: Record<string, unknown> } | null> => {
  let status = 0
  let payload = ''
  const response = { writeHead: (code: number) => { status = code; return response }, end: (text: string) => { payload = text } } as unknown as ServerResponse
  const handled = await feedRoutes(context, { method: 'GET' } as IncomingMessage, response, new URL(`http://x${path}`))
  return handled ? { status, body: JSON.parse(payload) as Record<string, unknown> } : null
}

const contextFor = (stateDir: string): RouteContext => ({ loaded: { stateDir, config: { contract: { reuseHours: 24 } } } } as unknown as RouteContext)

describe('recent events feed', () => {
  it('keeps the last 24 h, newest first, summarised from typed fields only', () => {
    const now = new Date('2026-09-26T12:00:00.000Z')
    const events = [
      { at: '2026-09-24T12:00:00.000Z', type: 'pr.merged', issue: 'ISSUE-0', pr: 1 },
      { at: '2026-09-26T10:00:00.000Z', type: 'worker.ci-round', issue: 'ISSUE-1', pr: 7, round: 2, secret: 'ignored' },
      { at: '2026-09-26T11:00:00.000Z', type: 'provider.cooldown', provider: 'p1', reason: 'usage limit' },
    ] as unknown as LoopEvent[]
    expect(recentEvents(events, now, 10)).toEqual([
      { at: '2026-09-26T11:00:00.000Z', type: 'provider.cooldown', issue: null, summary: 'usage limit · p1' },
      { at: '2026-09-26T10:00:00.000Z', type: 'worker.ci-round', issue: 'ISSUE-1', summary: 'round 2 · #7' },
    ])
    expect(summarizeEvent({ at: '', type: 'x', head: 'abcdef1234567' } as unknown as LoopEvent)).toBe('abcdef1')
  })

  it('serves the feed from the state dir event log', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ui-feed-')); dirs.push(stateDir)
    writeFileSync(join(stateDir, 'events.ndjson'), `${JSON.stringify({ at: new Date().toISOString(), type: 'pr.merged', issue: 'ISSUE-2', pr: 3 })}\n`)
    const result = await call(contextFor(stateDir), '/api/v1/events/recent?limit=5')
    expect(result?.status).toBe(200)
    expect(result?.body['events']).toMatchObject([{ type: 'pr.merged', issue: 'ISSUE-2', summary: '#3' }])
  })
})

describe('cached contracts', () => {
  it('reports stored contracts per issue with freshness, and refuses bad ids', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ui-feed-')); dirs.push(stateDir)
    const write = (issue: string, generatedAt: string, dispatchable: boolean): void => {
      const path = contractPath(stateDir, issue); mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, JSON.stringify({ schemaVersion: CONTRACT_SCHEMA_VERSION, issue, digest: `d-${issue}`, generatedAt, contract: { outcomes: [] }, assessment: { dispatchable } }))
    }
    write('ISSUE-1', new Date().toISOString(), true)
    write('ISSUE-2', '2020-01-01T00:00:00.000Z', false)
    const result = await call(contextFor(stateDir), '/api/v1/contracts?issues=ISSUE-1,ISSUE-2,ISSUE-3')
    expect(result?.body['contracts']).toMatchObject({ 'ISSUE-1': { fresh: true, dispatchable: true }, 'ISSUE-2': { fresh: false, dispatchable: false } })
    expect((result?.body['contracts'] as Record<string, unknown>)['ISSUE-3']).toBeUndefined()
    expect((await call(contextFor(stateDir), '/api/v1/contracts?issues=../x'))?.status).toBe(400)
  })
})

describe('phase age and fix rounds', () => {
  it('stamps phaseSince only when the phase changes', () => {
    const events = [
      { at: '2026-09-26T10:00:00.000Z', type: 'ui.run-enqueued', issue: 'ISSUE-1' },
      { at: '2026-09-26T10:05:00.000Z', type: 'worker.dispatched', issue: 'ISSUE-1', branch: 'b', worktree: 'w' },
    ] as unknown as LoopEvent[]
    const record = events.reduce(reduce, emptyProjection()).issues['ISSUE-1']!
    expect(record.updatedAt).toBe('2026-09-26T10:05:00.000Z')
    expect(record.phaseSince).toBe('2026-09-26T10:00:00.000Z')
    expect(phaseAgeMs(record, Date.parse('2026-09-26T10:10:00.000Z'))).toBe(600_000)
    expect(phaseAgeMs({ ...record, phaseSince: undefined }, Date.parse('2026-09-26T10:10:00.000Z'))).toBe(300_000)
  })

  it('labels used/max fix rounds once the issue was dispatched', () => {
    const base = { issue: 'ISSUE-1', dispatch: null, pullRequest: null, run: null } as never
    expect(fixRoundsLabel(base)).toBe('—')
    expect(fixRoundsLabel({ ...(base as object), dispatch: {}, run: { maxFixRounds: 3 }, fixRoundsUsed: 2 } as never)).toBe('2/3')
  })
})

describe('tracker facts cache persistence', () => {
  it('starts warm from disk and writes new lookups back, bounded', async () => {
    const { createTrackerStateCache, trackerFactsStore } = await import('../src/ui/api/extras.js')
    const stateDir = mkdtempSync(join(tmpdir(), 'ui-feed-')); dirs.push(stateDir)
    const store = trackerFactsStore(stateDir)
    const first = createTrackerStateCache(async () => ({ state: 'Canceled', title: 'Old work' }), () => 1_000, store)
    first(['ISSUE-1'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    const asked: string[] = []
    const second = createTrackerStateCache(async (issue) => { asked.push(issue); return { state: 'x', title: 'y' } }, () => 2_000, store)
    expect(second(['ISSUE-1'])).toEqual({ 'ISSUE-1': { state: 'Canceled', title: 'Old work' } })
    expect(asked).toEqual([])
  })
})
