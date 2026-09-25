import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendLoopEvent } from '../src/loop/tick.js'
import { readCurrentProjection, syncProjection } from '../src/ui/api/store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const stateDirFor = (): string => { const root = mkdtempSync(join(tmpdir(), 'harness-ui-store-')); roots.push(root); return root }

const writeDispatch = (stateDir: string, issue: string, overrides: Partial<Record<string, unknown>> = {}): void => {
  const dir = join(stateDir, 'issues', issue)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dispatch.json'), JSON.stringify({ issue, worktreeId: `wt-${issue}`, worktree: issue, branch: `you/${issue.toLowerCase()}`, terminal: 'term-1', provider: 'codex', model: 'gpt-5', contractDigest: 'digest-1', dispatchedAt: '2026-01-01T00:00:00.000Z', ...overrides }))
}

describe('the projection store', () => {
  it('bootstraps a minimal record from dispatch.json on the very first sync only', () => {
    const stateDir = stateDirFor()
    writeDispatch(stateDir, 'ENG-1')
    const state = syncProjection(stateDir)
    expect(state.issues['ENG-1']).toMatchObject({ phase: 'running', dispatch: { worktreeId: 'wt-ENG-1', provider: 'codex' } })
    expect(existsSync(join(stateDir, 'ui', 'projection.json'))).toBe(true)
    expect(existsSync(join(stateDir, 'ui', 'cursor.json'))).toBe(true)

    // A second dispatch appearing after the first sync must NOT get picked up by re-scanning dispatch.json —
    // only a real event moves it into the projection, proving the bootstrap really is once-only.
    writeDispatch(stateDir, 'ENG-2')
    const second = syncProjection(stateDir)
    expect(second.issues['ENG-2']).toBeUndefined()
  })

  it('folds in events written before the first sync, and events win over the bootstrap guess', () => {
    const stateDir = stateDirFor()
    writeDispatch(stateDir, 'ENG-3')
    appendLoopEvent(stateDir, { at: '2026-01-01T00:05:00.000Z', type: 'worker.merged', issue: 'ENG-3', reason: 'clean review', worktreeId: 'wt-ENG-3' })
    const state = syncProjection(stateDir)
    expect(state.issues['ENG-3']!.phase).toBe('completed')
  })

  it('is idempotent when nothing changed, and only advances on a real new event', () => {
    const stateDir = stateDirFor()
    writeDispatch(stateDir, 'ENG-4')
    const first = syncProjection(stateDir)
    const second = syncProjection(stateDir)
    expect(second).toEqual(first)

    appendLoopEvent(stateDir, { at: '2026-01-01T00:10:00.000Z', type: 'worker.merged', issue: 'ENG-4', reason: 'clean review', worktreeId: 'wt-ENG-4' })
    const third = syncProjection(stateDir)
    expect(third.issues['ENG-4']!.phase).toBe('completed')
  })

  it('survives a simulated restart: a fresh call rereads projection+cursor and continues from there', () => {
    const stateDir = stateDirFor()
    writeDispatch(stateDir, 'ENG-5')
    syncProjection(stateDir)
    appendLoopEvent(stateDir, { at: '2026-01-01T00:10:00.000Z', type: 'worker.held', issue: 'ENG-5', reason: 'protected path', worktreeId: 'wt-ENG-5' })
    // No in-memory state carried over — `syncProjection` only ever reads from stateDir, exactly like a new process would.
    const resumed = syncProjection(stateDir)
    expect(resumed.issues['ENG-5']).toMatchObject({ phase: 'review', reviewState: 'human-approval' })
    expect(readCurrentProjection(stateDir)).toEqual(resumed)
  })

  it('does not double-apply two events that land in the same millisecond', () => {
    const stateDir = stateDirFor()
    writeDispatch(stateDir, 'ENG-6')
    const at = '2026-01-01T00:20:00.000Z'
    appendLoopEvent(stateDir, { at, type: 'worker.review-round', issue: 'ENG-6', pr: 9, head: 'sha1', round: 1 })
    appendLoopEvent(stateDir, { at, type: 'worker.reviewed', issue: 'ENG-6', reason: 'review ran', worktreeId: 'wt-ENG-6' })
    const first = syncProjection(stateDir)
    expect(first.issues['ENG-6']!.reviewState).toBe('changes-requested')
    const second = syncProjection(stateDir)
    expect(second).toEqual(first)
  })

  it('engine-state reconciliation: a delivery.json final outcome flips the phase even when no event was emitted', () => {
    // The exact gap the bug report described: a PR was merged outside the loop, `complete()` never ran (so no
    // `pr.merged` was ever appended), and the reducer has nothing to fold. The reconcile pass against
    // `<stateDir>/issues/<id>/delivery.json` is what surfaces the terminal.
    const stateDir = stateDirFor()
    writeDispatch(stateDir, 'ENG-7', { prNumber: 99 })
    const deliveryDir = join(stateDir, 'issues', 'ENG-7')
    writeFileSync(join(deliveryDir, 'delivery.json'), JSON.stringify({ issue: 'ENG-7', prNumber: 99, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: null, finishedAt: '2026-01-01T00:30:00.000Z', finalOutcome: 'merged' }))
    const state = syncProjection(stateDir)
    expect(state.issues['ENG-7']).toMatchObject({ phase: 'completed', pullRequest: { number: 99, state: 'MERGED' } })
  })

  it('engine-state reconciliation: a held final outcome (no event emitted) still flips phase/review-state', () => {
    const stateDir = stateDirFor()
    writeDispatch(stateDir, 'ENG-8')
    const deliveryDir = join(stateDir, 'issues', 'ENG-8')
    writeFileSync(join(deliveryDir, 'delivery.json'), JSON.stringify({ issue: 'ENG-8', prNumber: 7, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: 'sha', finishedAt: '2026-01-01T00:31:00.000Z', finalOutcome: 'held' }))
    const state = syncProjection(stateDir)
    expect(state.issues['ENG-8']).toMatchObject({ phase: 'review', reviewState: 'human-approval' })
  })

  it('engine-state reconciliation: an issue with no delivery.json and no events stays at the reducer\u2019s guess', () => {
    const stateDir = stateDirFor()
    writeDispatch(stateDir, 'ENG-9')
    const state = syncProjection(stateDir)
    expect(state.issues['ENG-9']!.phase).toBe('running')
  })

  it('seedFromEngineState bootstraps a GitHub-intake PR from intake.json + delivery.json', () => {
    const stateDir = stateDirFor()
    const dir = join(stateDir, 'issues', 'pr-220')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'intake.json'), JSON.stringify({ pr: 220, headRef: 'Dev4LifeV/foo', source: 'github-label', addedAt: '2026-01-01T00:00:00.000Z' }))
    writeFileSync(join(dir, 'delivery.json'), JSON.stringify({ issue: 'pr-220', prNumber: 220, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: null, finishedAt: '2026-01-01T01:00:00.000Z', finalOutcome: 'held' }))
    const state = syncProjection(stateDir)
    expect(state.issues['pr-220']).toMatchObject({ phase: 'review', reviewState: 'human-approval', pullRequest: { number: 220, state: 'OPEN' } })
  })
})
