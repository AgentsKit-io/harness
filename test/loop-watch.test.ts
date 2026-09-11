import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyWatchEvent, classifyWatchPhase, formatWatchEvent, loadLoopConfig, watchDeliveries } from '../src/index.js'
import type { DeliveryState } from '../src/index.js'

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
})
