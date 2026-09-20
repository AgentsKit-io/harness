import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLoopConfig, readLearningsLedger, readLoopEvents, runRetroStage, upsertProposedLearnings, writeLearningsLedger } from '../src/index.js'
import type { CommandResult, CommandRunner, LearningRecord } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const runner = (): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  return { calls, run: async (argv) => { calls.push([...argv]); return ok({ ok: true, result: { automations: [], comment: { id: 'c1' } } }) } }
}

const learning = (text: string, sightings: number): LearningRecord => ({ id: `L-${text}`, source: 'retro', category: 'adjustment', text, status: 'proposed', recordedAt: '2026-09-12T00:00:00.000Z', sightings })

const setup = (extra: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-autopromote-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  // The retro schedule and the opt-in ride in the machine overlay, so the example config stays a single mapping.
  writeFileSync(join(dir, 'loop.config.local.yaml'), `schedule:\n  retro: weekly\n  retroIssue: ENG-0\n${extra}`)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
  mkdirSync(loaded.stateDir, { recursive: true })
  // Two lessons: one seen twice (a pattern), one seen once (an anecdote).
  writeLearningsLedger(loaded.stateDir, { records: [learning('always run lint before pushing', 2), learning('one-off flake', 1)] })
  return loaded
}

const AUTO = 'memory:\n  enabled: true\n  autoPromote:\n    enabled: true\n'

describe('the retro promoting recurring lessons by itself', () => {
  it('promotes the recurring lesson as loop-auto, leaves the anecdote proposed, and says how to revoke it', async () => {
    const loaded = setup(AUTO)
    const cli = runner()
    const report = await runRetroStage({ loaded, runner: cli, since: '7d' })
    expect(report.autoPromoted).toEqual(['L-always run lint before pushing'])
    const ledger = readLearningsLedger(loaded.stateDir)
    expect(ledger.records.find((record) => record.text === 'always run lint before pushing')?.status).toBe('promoted')
    expect(ledger.records.find((record) => record.text === 'one-off flake')?.status).toBe('proposed')
    const comment = cli.calls.find((argv) => argv.includes('comment'))?.join(' ') ?? ''
    expect(comment).toContain('loop-auto')
    expect(comment).toContain('loop learning reject --ids L-always run lint before pushing --by human')
    expect(readLoopEvents(loaded.stateDir).some((event) => event.type === 'memory.auto-promoted')).toBe(true)
  })

  it('leaves everything proposed when the project did not opt in', async () => {
    const loaded = setup('memory:\n  enabled: true\n')
    const report = await runRetroStage({ loaded, runner: runner(), since: '7d' })
    expect(report.autoPromoted).toEqual([])
    expect(readLearningsLedger(loaded.stateDir).records.every((record) => record.status === 'proposed')).toBe(true)
  })

  it('promotes nothing on a dry run', async () => {
    const loaded = setup(AUTO)
    const report = await runRetroStage({ loaded, runner: runner(), since: '7d', dryRun: true })
    expect(report).toMatchObject({ status: 'dry-run', autoPromoted: [], tuned: [] })
    expect(readLearningsLedger(loaded.stateDir).records.every((record) => record.status === 'proposed')).toBe(true)
  })

  it('counts a lesson proposed again instead of deduplicating it into an anecdote', () => {
    const loaded = setup(AUTO)
    const first = upsertProposedLearnings(loaded.stateDir, [learning('new lesson', 1)])
    expect(first.records.find((record) => record.text === 'new lesson')?.sightings ?? 1).toBe(1)
    const second = upsertProposedLearnings(loaded.stateDir, [learning('new lesson', 1)])
    expect(second.records.find((record) => record.text === 'new lesson')?.sightings).toBe(2)
  })
})
