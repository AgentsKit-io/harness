import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { acquireStageLock } from '../src/loop/stage-lock.js'
import { loadLoopConfig, readLoopEvents, stageEntry } from '../src/index.js'

// The CLI module parses `process.argv` on import unless told it is being introspected; the tests drive its
// command tree directly instead, in-process.
process.env['AK_HARNESS_CLI_INTROSPECT'] = '1'
process.env['AK_HARNESS_NO_GLOBAL'] = '1'

const spawnWorker = vi.hoisted(() => ({ fn: (_input: { readonly logPath: string; readonly cwd: string }): { readonly pid: number | null; readonly logPath: string } => ({ pid: null, logPath: '' }) }))
vi.mock('../src/loop/detached-worker.js', () => ({ spawnDetachedWorker: (input: { readonly logPath: string; readonly cwd: string }) => spawnWorker.fn(input) }))
const stages = vi.hoisted(() => ({ tick: 0, retro: 0, notifierThrows: false, tickReport: null as unknown }))
vi.mock('../src/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/index.js')>()
  return {
    ...original,
    runTick: async () => { stages.tick += 1; return stages.tickReport ?? { status: 'idle', results: [] } },
    runRetroStage: async () => { stages.retro += 1; return { status: 'ok', learningsProposed: 0 } },
    attachNotifier: (...args: Parameters<typeof original.attachNotifier>) => { if (stages.notifierThrows) throw new Error('notifier exploded'); return original.attachNotifier(...args) },
  }
})

let cli: typeof import('../src/cli.js')['cliProgram']
beforeAll(async () => { cli = (await import('../src/cli.js')).cliProgram })

const cleanups: string[] = []
afterEach(() => {
  process.exitCode = undefined
  stages.tick = 0; stages.retro = 0; stages.notifierThrows = false; stages.tickReport = null
  vi.restoreAllMocks()
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const quietly = async (argv: readonly string[]): Promise<string> => {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)) })
  await cli.parseAsync(['node', 'cli', ...argv])
  return lines.join('\n')
}

describe('ak-verify run exit code', () => {
  const fixture = (checkExit: number): string => {
    const root = mkdtempSync(join(tmpdir(), 'agentskit-cli-exit-')); cleanups.push(root)
    const configPath = join(root, '.ak-harness', 'verification.json')
    mkdirSync(join(root, '.ak-harness'), { recursive: true })
    const evidence = JSON.stringify({ status: checkExit === 0 ? 'passed' : 'failed', criteria: ['package'] })
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1, project: 'cli-exit-fixture', root: '..', stateDir: '.ak-harness/verification', profile: 'strict',
      contract: { intent: 'Exit codes.', scope: { inScope: ['fixture'], outOfScope: ['production'] }, ambiguities: [], outcomes: [{ id: 'package', statement: 'The check passes.', checks: ['fixture-check'] }] },
      surfaces: { logic: true, endpoint: { required: false, reason: 'fixture' }, database: { required: false, reason: 'fixture' }, cli: { required: false, reason: 'fixture' }, mcp: { required: false, reason: 'fixture' }, ui: { required: false, reason: 'fixture' }, docs: { required: false, reason: 'fixture' } },
      checks: [{ id: 'fixture-check', category: 'logic', command: `"${process.execPath}" -e 'console.log(${JSON.stringify(evidence)}); process.exit(${checkExit})'`, evidence: 'structured' }],
      tracking: { required: false, reason: 'fixture' },
    }))
    const git = (args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' }) }
    git(['init', '-q']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Harness test']); git(['add', '.']); git(['commit', '-qm', 'fixture'])
    return configPath
  }
  const verify = async (configPath: string): Promise<{ readonly state: string; readonly exitCode: unknown }> => {
    await quietly(['--config', configPath, '--json', 'plan', 'approved', '--by', 'human'])
    await quietly(['--config', configPath, '--json', 'start'])
    const out = await quietly(['--config', configPath, '--json', 'run'])
    return { state: (JSON.parse(out.trim().split('\n').at(-1)!) as { readonly state: string }).state, exitCode: process.exitCode }
  }

  it('exits non-zero when the verification run ends BLOCKED', async () => {
    const configPath = fixture(1)
    const result = await verify(configPath)
    expect(result.state).toBe('BLOCKED')
    expect(result.exitCode).toBe(1)
    process.exitCode = undefined
    await quietly(['--config', configPath, '--json', 'status'])
    expect(process.exitCode).toBe(1)
  }, 30_000)

  it('exits zero when the run reaches human approval', async () => {
    const result = await verify(fixture(0))
    expect(result.state).toBe('AWAITING_HUMAN_APPROVAL')
    expect(result.exitCode ?? 0).toBe(0)
  }, 30_000)
})

describe('scheduled loop stages', () => {
  const loopConfig = (overlay = ''): string => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-cli-stage-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person'))
    if (overlay) writeFileSync(join(dir, 'loop.config.local.yaml'), overlay)
    return join(dir, 'loop.config.yaml')
  }
  const BROKEN_PLUGIN = 'plugins:\n  modules: [missing-gate.mjs]\n'
  const stateDir = (file: string): string => loadLoopConfig(file).stateDir
  const events = (file: string, type: string): readonly Record<string, unknown>[] => readLoopEvents(stateDir(file)).filter((event) => event.type === type) as unknown as readonly Record<string, unknown>[]

  it('fails a stage whose plugin did not load, instead of running it ungated', async () => {
    const file = loopConfig(BROKEN_PLUGIN)
    await quietly(['loop', '-f', file, 'stage', 'retro'])
    expect(stages.retro).toBe(0)
    expect(process.exitCode).toBe(1)
    expect(events(file, 'plugin.load-failed')).toEqual([expect.objectContaining({ path: 'missing-gate.mjs' })])
    expect(events(file, 'stage.completed')).toEqual([expect.objectContaining({ stage: 'retro', status: 'error' })])
  })

  it('never spawns a tick worker past a plugin that failed to load, and counts it toward the auto-pause', async () => {
    const file = loopConfig(BROKEN_PLUGIN)
    const spawn = vi.spyOn(spawnWorker, 'fn')
    await quietly(['loop', '-f', file, 'stage', 'tick'])
    expect(spawn).not.toHaveBeenCalled()
    expect(stageEntry(stateDir(file), 'tick').consecutiveFailures).toBe(1)
    expect(events(file, 'plugin.load-failed')).toHaveLength(1)
  })

  it('fails the tick worker run itself when a plugin failed to load', async () => {
    const file = loopConfig(BROKEN_PLUGIN)
    await quietly(['loop', '-f', file, 'tick-worker'])
    expect(stages.tick).toBe(0)
    expect(stageEntry(stateDir(file), 'tick')).toMatchObject({ consecutiveFailures: 1, lastReason: expect.stringContaining('missing-gate.mjs') })
    expect(events(file, 'plugin.load-failed')).toHaveLength(1)
  })

  it('counts a tick worker run whose every result failed as a failed run, but not a tracker cooldown', async () => {
    const file = loopConfig()
    stages.tickReport = { status: 'failed', results: [{ issue: 'ENG-1', outcome: 'failed', reason: 'issue fetch failed: 502' }] }
    await quietly(['loop', '-f', file, 'tick-worker'])
    expect(stageEntry(stateDir(file), 'tick')).toMatchObject({ consecutiveFailures: 1, lastReason: expect.stringContaining('ENG-1: issue fetch failed') })
    stages.tickReport = { status: 'blocked', results: [] }
    await quietly(['loop', '-f', file, 'tick-worker'])
    expect(stageEntry(stateDir(file), 'tick').consecutiveFailures).toBe(0)
  })

  it('records a worker that crashes before taking the stage lock as a failed run', async () => {
    const file = loopConfig()
    stages.notifierThrows = true
    await quietly(['loop', '-f', file, 'tick-worker'])
    expect(process.exitCode).toBe(1)
    expect(stageEntry(stateDir(file), 'tick')).toMatchObject({ consecutiveFailures: 1, lastReason: 'notifier exploded' })
  })

  it('reports an unconfirmed worker spawn as a failed run, not a kick-off', async () => {
    const file = loopConfig()
    spawnWorker.fn = (input) => ({ pid: null, logPath: input.logPath })
    const out = await quietly(['loop', '-f', file, 'stage', 'tick'])
    expect(out).not.toContain('kicked-off')
    expect(events(file, 'stage.completed')).toEqual([expect.objectContaining({ stage: 'tick', status: 'error' })])
    expect(stageEntry(stateDir(file), 'tick').consecutiveFailures).toBe(1)
  }, 15_000)

  it('confirms a worker that took and released the stage lock between two polls', async () => {
    const file = loopConfig()
    // A worker with nothing to do: acquires the lock and releases it before the precheck's first poll.
    spawnWorker.fn = (input) => { acquireStageLock(stateDir(file), 'tick')?.(); return { pid: process.pid, logPath: input.logPath } }
    const out = await quietly(['loop', '-f', file, 'stage', 'tick'])
    expect(out).toContain('kicked-off')
    expect(stageEntry(stateDir(file), 'tick').consecutiveFailures).toBe(0)
  })
})
