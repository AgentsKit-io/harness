import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runLoopDoctor } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/loop', `${name}.json`), 'utf8')) as unknown
const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const fakeBinDir = (names: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-doctor-gaps-bin-')); cleanups.push(dir)
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return dir
}

const fakeRunner = (overrides: Partial<Record<string, CommandResult>> = {}, throwers: Partial<Record<string, string>> = {}): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  const table: Record<string, CommandResult> = {
    'orca --version': { code: 0, stdout: '1.4.200\n', stderr: '', timedOut: false, durationMs: 1 },
    'orca status --json': ok(fixture('status')),
    'orca account list --json': ok(fixture('account-list')),
    'orca agent hooks status --json': ok(fixture('agent-hooks')),
    'orca worktree ps --json': ok(fixture('worktree-ps')),
    ...overrides,
  }
  return {
    calls,
    run: async (argv) => {
      calls.push([...argv])
      const key = argv.join(' ')
      for (const [prefix, message] of Object.entries(throwers)) if (key.startsWith(prefix)) throw new Error(message)
      if (key.startsWith('orca linear list-issues')) return ok(fixture(key.includes('--state Ready') ? 'list-issues-ready' : 'list-issues-todo'))
      return table[key] ?? { code: 127, stdout: '', stderr: `no fixture for ${key}`, timedOut: false, durationMs: 1 }
    },
  }
}

const configDir = (yaml: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-doctor-gaps-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), yaml)
  return dir
}

describe('runLoopDoctor probe failures', () => {
  it('reports a warning when the Orca account list probe throws', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const runner = fakeRunner({}, { 'orca account list': 'accounts unreachable' })
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'orca.accounts')).toMatchObject({ status: 'warning', detail: expect.stringContaining('accounts unreachable') })
  })

  it('reports a warning when the Orca agent hooks probe throws', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const runner = fakeRunner({}, { 'orca agent hooks status': 'hooks unreachable' })
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'orca.agent-hooks')).toMatchObject({ status: 'warning', detail: expect.stringContaining('hooks unreachable') })
  })

  it('reports a warning when Orca worktree listing throws', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const runner = fakeRunner({}, { 'orca worktree ps': 'worktrees unreachable' })
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'orca.worktrees')).toMatchObject({ status: 'warning', detail: expect.stringContaining('worktrees unreachable') })
    expect(report.workers).toMatchObject({ running: 0, worktrees: [], error: expect.stringContaining('worktrees unreachable') })
  })

  it('fails the linear.queue check when fetching the queue throws', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const runner = fakeRunner({}, { 'orca linear list-issues': 'linear unreachable' })
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'linear.queue')).toMatchObject({ status: 'failed', detail: expect.stringContaining('linear unreachable') })
    expect(report.queue).toMatchObject({ count: 0, error: expect.stringContaining('linear unreachable') })
  })

  it('reports undeclared Orca provider integrations', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const runner = fakeRunner({ 'orca account list --json': ok({ ...(fixture('account-list') as Record<string, unknown>), gemini: { usedPercent: 10 } }) })
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'orca.undeclared-providers')).toMatchObject({ status: 'warning', detail: expect.stringContaining('gemini') })
  })

  it('resolves catalog candidates for every role when models.routing.mode is catalog', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const yaml = exampleYaml.replace('    mode: hybrid', '    mode: catalog')
    const dir = configDir(yaml)
    const runner = fakeRunner()
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.status).toBeDefined()
    expect(report.checks.some((check) => check.id.startsWith('routing.'))).toBe(true)
  })
})

describe('doc-bridge checks', () => {
  it('warns when the index is missing and requireDocBridge is false, fails when it is true', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const runner = fakeRunner()
    const warned = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(warned.checks.find((check) => check.id === 'doc-bridge.index')).toMatchObject({ status: 'warning' })

    const strictYaml = exampleYaml.replace('requireDocBridge: false', 'requireDocBridge: true')
    const strictDir = configDir(strictYaml)
    const failed = await runLoopDoctor({ configPath: join(strictDir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(failed.checks.find((check) => check.id === 'doc-bridge.index')).toMatchObject({ status: 'failed' })
  })

  it('reports a corrupt Doc Bridge index as unreadable', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    mkdirSync(join(dir, '.doc-bridge'), { recursive: true })
    writeFileSync(join(dir, '.doc-bridge', 'index.json'), 'not-json', 'utf8')
    const runner = fakeRunner()
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'doc-bridge.index')).toMatchObject({ status: 'warning', detail: expect.stringContaining('unreadable') })
  })

  it('passes freshness when the index is present and recent, and warns when it exceeds the max age', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    mkdirSync(join(dir, '.doc-bridge'), { recursive: true })
    writeFileSync(join(dir, '.doc-bridge', 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), contentHash: 'a'.repeat(64), entries: [] }), 'utf8')
    const runner = fakeRunner()
    const fresh = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(fresh.checks.find((check) => check.id === 'doc-bridge.index')).toMatchObject({ status: 'passed' })
    expect(fresh.checks.find((check) => check.id === 'doc-bridge.freshness')).toMatchObject({ status: 'passed' })

    const indexPath = join(dir, '.doc-bridge', 'index.json')
    const old = new Date(Date.now() - 200 * 3_600_000)
    utimesSync(indexPath, old, old)
    const stale = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(stale.checks.find((check) => check.id === 'doc-bridge.freshness')).toMatchObject({ status: 'warning', detail: expect.stringContaining('exceeds') })
  })
})

describe('review.cli and memory checks', () => {
  it('warns when the review CLI is not on PATH', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const runner = fakeRunner()
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'review.cli')).toMatchObject({ status: 'warning' })
  })

  it('passes review.cli when found, and runs the --help probe when doctorProbe is "help"', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok', 'agentskit-review'])
    const yaml = exampleYaml.replace('    # doctorProbe: help                 # nit < med < high < blocker; findings at/above this block auto-merge', '    doctorProbe: help')
    const dir = configDir(yaml)
    const runner = fakeRunner({ 'agentskit-review --help': { code: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 } })
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z') })
    expect(report.checks.find((check) => check.id === 'review.cli')).toMatchObject({ status: 'passed' })
    expect(report.checks.find((check) => check.id === 'review.help')).toMatchObject({ status: 'passed' })
  })

  it('warns when the --help probe exits non-zero or throws', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok', 'agentskit-review'])
    const yaml = exampleYaml.replace('    # doctorProbe: help                 # nit < med < high < blocker; findings at/above this block auto-merge', '    doctorProbe: help')
    const dir = configDir(yaml)
    const failing = fakeRunner({ 'agentskit-review --help': { code: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 } })
    const failedProbe = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner: failing, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z') })
    expect(failedProbe.checks.find((check) => check.id === 'review.help')).toMatchObject({ status: 'warning', detail: expect.stringContaining('exit 1') })

    const throwing = fakeRunner({}, { 'agentskit-review --help': 'help probe crashed' })
    const thrownProbe = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner: throwing, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z') })
    expect(thrownProbe.checks.find((check) => check.id === 'review.help')).toMatchObject({ status: 'warning', detail: expect.stringContaining('help probe crashed') })
  })

  it('does not run the --help probe when probe is false, even with doctorProbe set to help', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok', 'agentskit-review'])
    const yaml = exampleYaml.replace('    # doctorProbe: help                 # nit < med < high < blocker; findings at/above this block auto-merge', '    doctorProbe: help')
    const dir = configDir(yaml)
    const runner = fakeRunner()
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'review.help')).toBeUndefined()
  })

  it('reports a passed memory check when memory.enabled is true', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const yaml = exampleYaml.replace('enabled: false                     # set true to recall approved learnings into contract/brief (token reduction)', 'enabled: true')
    const dir = configDir(yaml)
    const runner = fakeRunner()
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.checks.find((check) => check.id === 'memory')).toMatchObject({ status: 'passed' })
  })

  it('passes automations.drift when Orca matches the config, and names the drifted fields when it does not', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const configPath = join(dir, 'loop.config.yaml')
    const shared = { runner: fakeRunner(), env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin' as const, now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false }
    const automation = (name: string, rrule: string) => ({ id: `id-${name}`, name, enabled: true, rrule, agentId: 'claude', prompt: `This automation does its work inside its precheck command (ak-harness loop stage ${name.slice(5)} -f "${configPath}"), which always exits non-zero so that no agent session is needed. If you are reading this, the precheck unexpectedly exited 0: reply exactly LOOP_PRECHECK_BYPASSED and stop. Do not run any command.`, precheck: { command: `ak-harness loop stage ${name.slice(5)} -f "${configPath}"`, timeoutSeconds: 600 }, workspaceId: `repo-1::${dir}` })
    const inSync = fakeRunner({ 'orca automations list --json': ok({ ok: true, result: { automations: [automation('loop-tick', '*/5 * * * *'), automation('loop-deliver', '*/10 * * * *')] } }) })
    expect((await runLoopDoctor({ ...shared, runner: inSync, configPath })).checks.find((check) => check.id === 'automations.drift')).toMatchObject({ status: 'passed' })

    const drifted = fakeRunner({ 'orca automations list --json': ok({ ok: true, result: { automations: [automation('loop-tick', '0 4 * * *')] } }) })
    expect((await runLoopDoctor({ ...shared, runner: drifted, configPath })).checks.find((check) => check.id === 'automations.drift')).toMatchObject({ status: 'warning', detail: expect.stringContaining('loop-tick: drifted (trigger)') })

    // Orca unreachable is a warning about the check, never a silent pass.
    expect((await runLoopDoctor({ ...shared, runner: fakeRunner({}, { 'orca automations list': 'orca is down' }), configPath })).checks.find((check) => check.id === 'automations.drift')).toMatchObject({ status: 'warning', detail: expect.stringContaining('orca is down') })
  })
})

describe('the installed agents a registry points at', () => {
  const base = (bin: string) => ({ runner: fakeRunner(), env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin' as const, now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })

  it('says which instructions file it found, and fails on one that is not there', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok'])
    const dir = configDir(exampleYaml)
    const registry = 'schemaVersion: 1\nroles:\n  builder: builder-1\nagents:\n  builder-1:\n    provider: claude\n    path: agents/builder-1\n'
    writeFileSync(join(dir, 'agents.registry.yaml'), registry)

    // The registry names a directory nobody installed: every run for that role quietly falls back to the provider.
    const broken = await runLoopDoctor({ ...base(bin), configPath: join(dir, 'loop.config.yaml') })
    expect(broken.checks.find((check) => check.id === 'agents.registry')).toMatchObject({ status: 'failed', detail: expect.stringContaining('agents/builder-1 is not in the repository') })

    mkdirSync(join(dir, 'agents', 'builder-1'), { recursive: true })
    writeFileSync(join(dir, 'agents', 'builder-1', 'AGENT.md'), '# Builder\n')
    const found = await runLoopDoctor({ ...base(bin), configPath: join(dir, 'loop.config.yaml') })
    expect(found.checks.find((check) => check.id === 'agents.registry')).toMatchObject({ status: 'passed', detail: expect.stringContaining('agents/builder-1/AGENT.md') })

    // An agent that is code is healthy; it only changes who applies an improvement.
    writeFileSync(join(dir, 'agents', 'builder-1', 'agent.ts'), 'export const agent = {}\n')
    writeFileSync(join(dir, 'agents.registry.yaml'), `${registry}    instructions: agent.ts\n`)
    const code = await runLoopDoctor({ ...base(bin), configPath: join(dir, 'loop.config.yaml') })
    expect(code.checks.find((check) => check.id === 'agents.registry')).toMatchObject({ status: 'passed', detail: expect.stringContaining('code — improvements go to a human') })
  })
})
