import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CRITICAL_ROLES, improveAgent, loadLoopConfig, proposeAgentChange, readImprovementState, roleSignals, runEvalGate } from '../src/index.js'
import type { AgentRegistry, CommandResult, CommandRunner, LoadedLoopConfig, RoleSignal } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const NOW = new Date('2026-09-19T12:00:00.000Z')
const ok = (): CommandResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 })
const bad = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr, timedOut: false, durationMs: 1 })

const AUTO = `agents:
  autoImprove: true
  evalCommand: [npm, run, eval]
  maxAutoLines: 5
`

const setup = (overlay = AUTO, registry = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-agent-improve-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  writeFileSync(join(dir, 'loop.config.local.yaml'), overlay)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
  mkdirSync(loaded.stateDir, { recursive: true })
  if (registry) {
    mkdirSync(join(dir, 'agents', 'builder-1'), { recursive: true })
    writeFileSync(join(dir, 'agents', 'builder-1', 'AGENT.md'), '# Builder\n\n- Read the repo guide first.\n')
    writeFileSync(join(dir, 'agents.registry.yaml'), 'schemaVersion: 1\nroles:\n  builder: builder-1\n  reviewer: reviewer-1\nagents:\n  builder-1:\n    provider: claude\n    path: agents/builder-1\n  reviewer-1:\n    provider: claude\n    path: agents/reviewer-1\n')
  }
  const event = (type: string, extra: Record<string, unknown> = {}): void => appendFileSync(join(loaded.stateDir, 'events.ndjson'), `${JSON.stringify({ at: NOW.toISOString(), type, ...extra })}\n`)
  return { dir, loaded, event }
}

const signal = (overrides: Partial<RoleSignal> = {}): RoleSignal => ({ role: 'builder', reviewFindings: 2, fixRounds: 3, escalations: 0, contraryVotes: 0, runs: 4, ratio: 1.25, ...overrides })

describe('correlating outcomes with a role', () => {
  it('counts only what the loop already writes, and gives a role with no runs no score at all', () => {
    const { loaded, event } = setup()
    event('pr.reviewed', { status: 'findings' })
    event('pr.reviewed', { status: 'clean' })
    event('worker.ci-round')
    event('plan.voted', { votes: 3, approvals: 2 })
    const signals = roleSignals(loaded.stateDir, NOW.getTime() - 3_600_000)
    const reviewer = signals.find((item) => item.role === 'reviewer')
    expect(reviewer).toMatchObject({ runs: 2, reviewFindings: 1, ratio: 0.5 })
    expect(signals.find((item) => item.role === 'builder')).toMatchObject({ runs: 1, fixRounds: 1 })
    expect(signals.find((item) => item.role === 'planner')?.contraryVotes).toBe(1)
    // Nothing ran for the orchestrator, so it has no signal — not a perfect one.
    expect(signals.some((item) => item.role === 'orchestrator')).toBe(false)
  })

  it('sorts the worst ratio first, because that is the role worth improving', () => {
    const { loaded, event } = setup()
    event('pr.reviewed', { status: 'clean' })
    event('worker.ci-round')
    expect(roleSignals(loaded.stateDir, 0)[0]?.role).toBe('builder')
  })
})

describe('the proposal', () => {
  it('appends one dated note to the installed agent\'s instructions and leaves the rest alone', () => {
    const { dir, loaded } = setup()
    const registry = { schemaVersion: 1 as const, roles: { builder: 'builder-1' }, agents: { 'builder-1': { provider: 'claude', path: 'agents/builder-1', instructions: 'AGENT.md' } } } as AgentRegistry
    const proposal = proposeAgentChange({ loaded, registry, signal: signal(), note: 'prefer the smallest change', now: NOW })
    expect(proposal?.agentId).toBe('builder-1')
    expect(proposal?.after).toContain('# Builder')
    expect(proposal?.after).toContain('<!-- loop-auto 2026-09-19 -->')
    expect(proposal?.after).toContain('prefer the smallest change')
    expect(proposal?.instructionsFile).toBe(join(dir, 'agents', 'builder-1', 'AGENT.md'))
  })

  it('proposes nothing for a role with no installed agent', () => {
    const { loaded } = setup()
    const registry = { schemaVersion: 1 as const, agents: { 'x': { provider: 'claude', instructions: 'AGENT.md' } } } as AgentRegistry
    expect(proposeAgentChange({ loaded, registry, signal: signal({ role: 'watcher' }), note: 'n', now: NOW })).toBeNull()
  })
})

describe('the eval gate', () => {
  it('adopts a change only when the eval still passes, and puts it back when it does not', async () => {
    const { loaded } = setup()
    const file = join(loaded.root, 'agents', 'builder-1', 'AGENT.md')
    const before = readFileSync(file, 'utf8')

    const failing: CommandRunner = { run: async () => bad('2 of 9 cases regressed') }
    const reverted = await improveAgent({ loaded, runner: failing, signal: signal(), note: 'n', now: () => NOW })
    expect(reverted.status).toBe('reverted')
    expect(readFileSync(file, 'utf8')).toBe(before)

    const passing: CommandRunner = { run: async () => ok() }
    const adopted = await improveAgent({ loaded, runner: passing, signal: signal(), note: 'prefer the smallest change', now: () => NOW })
    expect(adopted.status).toBe('adopted')
    expect(readFileSync(file, 'utf8')).toContain('prefer the smallest change')
    expect(readImprovementState(loaded.stateDir).history.map((record) => record.status)).toEqual(['reverted', 'adopted'])
    expect(readImprovementState(loaded.stateDir).history[1]?.evidence).toMatchObject({ role: 'builder', runs: 4 })
  })

  it('adopts nothing when there is no way to measure it', async () => {
    const { loaded } = setup('agents:\n  autoImprove: true\n')
    const gate = await runEvalGate({ config: loaded.config, runner: { run: async () => ok() }, cwd: loaded.root })
    expect(gate).toMatchObject({ ran: false, passed: false })
    expect(gate.detail).toContain('cannot be measured')
    expect((await improveAgent({ loaded, runner: { run: async () => ok() }, signal: signal(), note: 'n', now: () => NOW })).status).toBe('reverted')
  })
})

describe('what a machine never does alone', () => {
  it('leaves a critical role to a human', async () => {
    expect(CRITICAL_ROLES).toEqual(['architect', 'reviewer'])
    const { loaded } = setup()
    mkdirSync(join(loaded.root, 'agents', 'reviewer-1'), { recursive: true })
    writeFileSync(join(loaded.root, 'agents', 'reviewer-1', 'AGENT.md'), '# Reviewer\n')
    const outcome = await improveAgent({ loaded, runner: { run: async () => ok() }, signal: signal({ role: 'reviewer' }), note: 'n', now: () => NOW })
    expect(outcome.status).toBe('needs-human')
    expect(outcome.detail).toContain('critical role')
    expect(readFileSync(join(loaded.root, 'agents', 'reviewer-1', 'AGENT.md'), 'utf8')).toBe('# Reviewer\n')
  })

  it('stops at maxAutoLines and when there is no registry at all', async () => {
    const { loaded } = setup('agents:\n  autoImprove: true\n  evalCommand: [npm, run, eval]\n  maxAutoLines: 1\n')
    const outcome = await improveAgent({ loaded, runner: { run: async () => ok() }, signal: signal(), note: 'a\nb\nc', now: () => NOW })
    expect(outcome.status).toBe('needs-human')
    expect(outcome.detail).toContain('maxAutoLines')

    const { loaded: bare } = setup(AUTO, false)
    expect((await improveAgent({ loaded: bare, runner: { run: async () => ok() }, signal: signal(), note: 'n', now: () => NOW })).detail).toContain('no agents.registry.yaml')
  })

  it('never edits an agent that is code, and never invents an instructions file that is not there', async () => {
    const { dir, loaded } = setup()
    // `npx agentskit add <id>` installs an agent as code: appending an HTML comment to it is a syntax error,
    // not an improvement.
    writeFileSync(join(dir, 'agents', 'builder-1', 'agent.ts'), 'export const agent = {}\n')
    writeFileSync(join(dir, 'agents.registry.yaml'), 'schemaVersion: 1\nroles:\n  builder: builder-1\nagents:\n  builder-1:\n    provider: claude\n    path: agents/builder-1\n    instructions: agent.ts\n')
    const code = await improveAgent({ loaded, runner: { run: async () => ok() }, signal: signal(), note: 'n', now: () => NOW })
    expect(code.status).toBe('needs-human')
    expect(code.detail).toContain('the installed agent is code')
    expect(readFileSync(join(dir, 'agents', 'builder-1', 'agent.ts'), 'utf8')).toBe('export const agent = {}\n')
    // The note still reaches a human, with the evidence that produced it.
    expect(readImprovementState(loaded.stateDir).history.at(-1)).toMatchObject({ status: 'needs-human', role: 'builder' })

    const { dir: other, loaded: missing } = setup()
    rmSync(join(other, 'agents', 'builder-1', 'AGENT.md'))
    const gone = await improveAgent({ loaded: missing, runner: { run: async () => ok() }, signal: signal(), note: 'n', now: () => NOW })
    expect(gone.status).toBe('needs-human')
    expect(gone.detail).toContain('does not exist')
    expect(existsSync(join(other, 'agents', 'builder-1', 'AGENT.md'))).toBe(false)
  })

  it('writes nothing on a dry run', async () => {
    const { loaded } = setup()
    const before = readFileSync(join(loaded.root, 'agents', 'builder-1', 'AGENT.md'), 'utf8')
    const outcome = await improveAgent({ loaded, runner: { run: async () => ok() }, signal: signal(), note: 'n', now: () => NOW, dryRun: true })
    expect(outcome.status).toBe('needs-human')
    expect(readFileSync(join(loaded.root, 'agents', 'builder-1', 'AGENT.md'), 'utf8')).toBe(before)
    expect(readImprovementState(loaded.stateDir).history).toEqual([])
  })
})
