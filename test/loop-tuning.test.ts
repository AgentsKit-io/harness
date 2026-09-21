import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyToYaml, applyTuning, loadLoopConfig, nextValue, planTuning, readMetrics, readTuningState } from '../src/index.js'
import type { CommandRunner, LoadedLoopConfig, RetroReport, TuningState } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const TUNING = `
tuning:
  enabled: true
  maxChangesPerRetro: 1
  knobs:
    - path: delivery.review.minSeverity
      metric: review-findings-ratio
      values: [med, nit]
    - path: delivery.workerIdleTimeoutMin
      metric: stuck-count
      min: 15
      max: 60
      step: 5
`

const setup = (extra = TUNING): LoadedLoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-tuning-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), `${exampleYaml}${extra}`)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
  mkdirSync(loaded.stateDir, { recursive: true })
  return loaded
}

const report = (overrides: Partial<RetroReport['delivery']> = {}, escalations = 0): RetroReport => ({
  generatedAt: '2026-09-19T12:00:00.000Z',
  window: { since: '2026-09-12T12:00:00.000Z', until: '2026-09-19T12:00:00.000Z', label: '7d' } as RetroReport['window'],
  project: 'my-project', person: 'person', counts: {},
  escalations: { total: escalations, issues: [], reasons: [] },
  dispatches: { total: 3, failed: 0, byProvider: {} },
  delivery: { merged: 4, blocked: 0, stuck: 0, abandoned: 0, inFlight: 0, fixRounds: 2, reviewsClean: 3, reviewsFindings: 1, reviewsIncomplete: 0, medianLeadTimeMin: 30, ...overrides },
  providers: { cooldowns: [], cooldownEvents: 0 },
  harness: { relaunches: 0, dispatchFailures: [], contractFailures: [], mergeRefusals: 0, reviewToolErrors: 0 },
  orca: null, issues: [], suggestions: [], digest: 'digest-1',
})

const EMPTY: TuningState = { history: [], frozen: [] }

describe('tuning metrics and steps', () => {
  it('reads every metric as "lower is better"', () => {
    expect(readMetrics(report())).toEqual({ 'review-findings-ratio': 0.25, 'stuck-count': 0, 'fix-rounds-per-merge': 0.5, 'escalation-count': 0 })
    expect(readMetrics(report({ reviewsClean: 0, reviewsFindings: 0, reviewsIncomplete: 0, merged: 0, fixRounds: 3, stuck: 1, abandoned: 2 }), 5)).toMatchObject({ 'review-findings-ratio': 0, 'stuck-count': 3, 'fix-rounds-per-merge': 3 })
  })

  it('moves one step along the ladder, and never past its end or its range', () => {
    const ladder = { path: 'x', metric: 'stuck-count' as const, values: ['med', 'nit'] }
    expect(nextValue(ladder, 'med', 2)).toBe('nit')
    expect(nextValue(ladder, 'nit', 2)).toBeNull()
    expect(nextValue(ladder, 'blocker', 2)).toBeNull()
    // A healthy metric leaves the knob alone: a loop that keeps tightening eventually stops merging anything.
    expect(nextValue(ladder, 'med', 0)).toBeNull()
    const numeric = { path: 'y', metric: 'stuck-count' as const, min: 15, max: 20, step: 5 }
    expect(nextValue(numeric, 15, 1)).toBe(20)
    expect(nextValue(numeric, 20, 1)).toBeNull()
    expect(nextValue({ path: 'z', metric: 'stuck-count' as const }, 15, 1)).toBeNull()
  })
})

describe('planning a tuning cycle', () => {
  it('proposes at most maxChangesPerRetro changes, only for metrics that are not zero', () => {
    const loaded = setup()
    const plan = planTuning(loaded.config, report({ stuck: 2 }), EMPTY)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ action: 'change', path: 'delivery.review.minSeverity', from: 'med', to: 'nit', metric: 'review-findings-ratio' })
    expect(planTuning(loaded.config, report({ reviewsFindings: 0, reviewsClean: 4 }), EMPTY)).toEqual([])
  })

  it('changes nothing at all when tuning is off', () => {
    expect(planTuning(setup('').config, report({ stuck: 5 }), EMPTY)).toEqual([])
  })

  it('reverts and freezes a knob whose metric got worse after the last change', () => {
    const loaded = setup()
    const previous: TuningState = { history: [{ path: 'delivery.review.minSeverity', metric: 'review-findings-ratio', from: 'nit', to: 'med', at: '2026-09-12T00:00:00.000Z', reason: 'x', metricBefore: 0.1, evidence: {}, status: 'applied' }], frozen: [] }
    const plan = planTuning(loaded.config, report(), previous)
    expect(plan[0]).toMatchObject({ action: 'revert', path: 'delivery.review.minSeverity', from: 'med', to: 'nit' })
    expect(plan[0]?.reason).toContain('worsened')
    // A knob already frozen is never touched again without a human.
    expect(planTuning(loaded.config, report(), { ...previous, frozen: ['delivery.review.minSeverity'] }).some((decision) => decision.path === 'delivery.review.minSeverity' && decision.action !== 'hold')).toBe(false)
  })

  it('holds a change that did not make things worse instead of stacking another one', () => {
    const loaded = setup()
    const previous: TuningState = { history: [{ path: 'delivery.review.minSeverity', metric: 'review-findings-ratio', from: 'nit', to: 'med', at: '2026-09-12T00:00:00.000Z', reason: 'x', metricBefore: 0.9, evidence: {}, status: 'applied' }], frozen: [] }
    expect(planTuning(loaded.config, report(), previous)[0]).toMatchObject({ action: 'hold', path: 'delivery.review.minSeverity' })
  })
})

describe('writing the change back', () => {
  it('edits one value in place and keeps every comment', () => {
    const text = '# a comment\nfoo:\n  bar: 1   # trailing\n  baz: keep\n'
    const edited = applyToYaml(text, 'foo.bar', 4)
    expect(edited).toContain('# a comment')
    expect(edited).toContain('# trailing')
    expect(edited).toContain('baz: keep')
    expect(edited).toMatch(/bar: 4/)
    expect(() => applyToYaml(text, 'foo.absent', 1)).toThrow(/does not exist/)
  })

  it('applies the plan, records the evidence, and reloads as a valid config', async () => {
    const loaded = setup()
    const result = await applyTuning({ loaded, report: report(), now: () => new Date('2026-09-19T12:00:00.000Z') })
    expect(result.applied.map((decision) => decision.path)).toEqual(['delivery.review.minSeverity'])
    expect(loadLoopConfig(loaded.path, { AK_HARNESS_NO_GLOBAL: '1' }).config.delivery.review.minSeverity).toBe('nit')
    const state = readTuningState(loaded.stateDir)
    expect(state.history[0]).toMatchObject({ path: 'delivery.review.minSeverity', from: 'med', to: 'nit', metricBefore: 0.25, status: 'applied' })
    expect(state.history[0]?.evidence).toMatchObject({ digest: 'digest-1' })
    expect(readFileSync(loaded.path, 'utf8')).toContain('# Never put secrets in this file')
  })

  it('writes nothing on a dry run', async () => {
    const loaded = setup()
    const result = await applyTuning({ loaded, report: report(), dryRun: true })
    expect(result.applied).toEqual([])
    expect(result.notes).toEqual(['dry-run: nothing written'])
    expect(readTuningState(loaded.stateDir)).toEqual(EMPTY)
  })

  it('commits with the reason and the evidence only when the project asked for it', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv) => { calls.push([...argv]); return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 } } }
    const quiet = setup()
    await applyTuning({ loaded: quiet, report: report(), runner })
    expect(calls).toEqual([])

    const committing = setup(`${TUNING}  commit: true\n`)
    const result = await applyTuning({ loaded: committing, report: report(), runner })
    expect(result.committed).toBe(true)
    expect(calls[0]?.slice(0, 2)).toEqual(['git', '-C'])
    expect(calls[1]?.[5]).toContain('chore(loop): tune delivery.review.minSeverity med → nit')
    expect(calls[1]?.[7]).toContain('review-findings-ratio is 0.25')
  })

  it('reports a failed commit without losing the change', async () => {
    const committing = setup(`${TUNING}  commit: true\n`)
    const runner: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'nothing to commit', timedOut: false, durationMs: 1 }) }
    const result = await applyTuning({ loaded: committing, report: report(), runner })
    expect(result.committed).toBe(false)
    expect(result.notes[0]).toContain('nothing to commit')
    expect(loadLoopConfig(committing.path, { AK_HARNESS_NO_GLOBAL: '1' }).config.delivery.review.minSeverity).toBe('nit')
  })
})
