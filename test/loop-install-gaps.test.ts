import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  automationPrompt, automationSpecs, installLoopAutomations, loadLoopConfig, loopStatus,
  parseAutomationRuns, precheckCommand, uninstallLoopAutomations,
} from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const okResult = (result: unknown): CommandResult => ok({ ok: true, result })
const failResult = (): CommandResult => ({ code: 1, stdout: JSON.stringify({ ok: false, error: 'boom' }), stderr: '', timedOut: false, durationMs: 1 })
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = (options: { readonly yaml?: string; readonly existing?: readonly Record<string, unknown>[]; readonly failCreate?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-install-gaps-')); cleanups.push(dir)
  const bin = mkdtempSync(join(tmpdir(), 'agentskit-loop-install-gaps-bin-')); cleanups.push(bin)
  for (const name of ['claude', 'codex', 'opencode', 'grok', 'ak-harness']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(dir, 'loop.config.yaml'), options.yaml ?? exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  const automations: Record<string, unknown>[] = [...(options.existing ?? [])]
  const calls: string[][] = []
  const runner: CommandRunner & { readonly calls: string[][] } = {
    calls,
    run: async (argv) => {
      calls.push([...argv])
      const key = argv.join(' ')
      if (key.startsWith('orca account list')) return ok({})
      if (key.startsWith('orca agent hooks status')) return ok({})
      if (key.startsWith('orca automations list')) return okResult({ automations, items: automations })
      if (key.startsWith('orca automations create')) {
        if (options.failCreate) return failResult()
        const created = { id: `auto-${automations.length + 1}`, name: argv[argv.indexOf('--name') + 1], enabled: true, trigger: argv[argv.indexOf('--trigger') + 1], provider: argv[argv.indexOf('--provider') + 1] }
        automations.push(created)
        return okResult({ automation: created })
      }
      if (key.startsWith('orca automations edit')) return okResult({ automation: { id: argv[3] } })
      if (key.startsWith('orca automations remove')) { const index = automations.findIndex((item) => item['id'] === argv[3]); if (index >= 0) automations.splice(index, 1); return okResult({ removed: true }) }
      if (key.startsWith('orca automations runs')) return okResult({ runs: [] })
      return { code: 127, stdout: '', stderr: `no fixture for ${key}`, timedOut: false, durationMs: 1 }
    },
  }
  return { dir, bin, loaded, runner, automations }
}
const env = (bin: string) => ({ PATH: bin, XAI_API_KEY: 'k' })

describe('precheckCommand / automationPrompt for retro', () => {
  it('maps the retro stage to the deliver precheck command and prompt', () => {
    const { loaded } = setup()
    const agentMode = { ...loaded, config: { ...loaded.config, schedule: { ...loaded.config.schedule, runner: 'agent' as const } } }
    expect(precheckCommand(agentMode.config, agentMode.path, 'retro')).toContain('loop precheck deliver')
    expect(automationPrompt(loaded.config, loaded.path, 'retro')).toContain('stage retro')
    expect(automationPrompt(agentMode.config, agentMode.path, 'retro')).toContain('loop stage retro -f')
  })
})

describe('automationSpecs with an Orca host and a retro automation', () => {
  it('includes the host field when orca.host is set, and adds a retro spec when both schedule.retro and retroIssue are set', () => {
    const yaml = exampleYaml
      .replace('  # host: runtime:<environment-id>   # paired remote Orca host', '  host: my-remote-host')
      .replace('  # retro: weekly                     # with retroIssue, installs <prefix>-retro', '  retro: "0 9 * * 1"')
      .replace('  # retroIssue: ABC-0                 # Linear issue that receives the digest comment', '  retroIssue: ENG-1')
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-install-gaps-retro-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), yaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    const specs = automationSpecs(loaded, 'claude')
    expect(specs.map((spec) => spec.stage)).toEqual(['tick', 'deliver', 'retro'])
    expect(specs.every((spec) => spec.host === 'my-remote-host')).toBe(true)
  })
})

describe('installLoopAutomations edge cases', () => {
  it('warns when schedule.retro is set without retroIssue, and vice versa', async () => {
    const withRetroOnly = exampleYaml.replace('  # retro: weekly                     # with retroIssue, installs <prefix>-retro', '  retro: "0 9 * * 1"')
    const env1 = setup({ yaml: withRetroOnly })
    const report = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin' })
    expect(report.notes.some((note) => note.includes('retroIssue is missing'))).toBe(true)
  })

  it('warns when schedule.retroIssue is set without a retro cron', async () => {
    const withIssueOnly = exampleYaml.replace('  # retroIssue: ABC-0                 # Linear issue that receives the digest comment', '  retroIssue: ENG-1')
    const env1 = setup({ yaml: withIssueOnly })
    const report = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin' })
    expect(report.notes.some((note) => note.includes('retro cron is missing'))).toBe(true)
  })

  it('uses input.provider when supplied, without probing Orca for one', async () => {
    const env1 = setup()
    const report = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin', provider: 'grok' })
    expect(report.provider).toBe('grok')
    expect(env1.runner.calls.some((argv) => argv[1] === 'account')).toBe(false)
  })

  it('uses config.schedule.provider when set, without probing Orca', async () => {
    const withProvider = exampleYaml.replace('  # provider: claude                 # Orca agent that executes the automation prompt (default: watcher role)', '  provider: opencode')
    const env1 = setup({ yaml: withProvider })
    const report = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin' })
    expect(report.provider).toBe('opencode')
    expect(env1.runner.calls.some((argv) => argv[1] === 'account')).toBe(false)
  })

  it('falls back to claude when Orca account/hooks probes fail and no watcher/orchestrator provider ranks', async () => {
    const env1 = setup()
    const baseRun = env1.runner.run
    env1.runner.run = async (argv, options) => {
      const key = argv.join(' ')
      if (key.startsWith('orca account list') || key.startsWith('orca agent hooks status')) throw new Error('orca unreachable')
      return baseRun(argv, options)
    }
    const report = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: { PATH: env1.bin }, platform: 'darwin' })
    expect(report.provider).toBe('claude')
  })

  it('marks the report failed and records the error message when creating an automation fails', async () => {
    const env1 = setup({ failCreate: true })
    const report = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin' })
    expect(report.status).toBe('failed')
    expect(report.actions[0]?.detail).toContain('failed')
  })

  it('captures a thrown non-Error value from a failing create call', async () => {
    const env1 = setup()
    let first = true
    env1.runner.run = async (argv) => {
      const key = argv.join(' ')
      if (key.startsWith('orca automations list')) return okResult({ automations: [] })
      if (key.startsWith('orca automations create') && first) { first = false; throw 'plain string failure' }
      return { code: 127, stdout: '', stderr: 'unused', timedOut: false, durationMs: 1 }
    }
    const report = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin', provider: 'claude' })
    expect(report.status).toBe('failed')
    expect(report.actions[0]?.detail).toBe('plain string failure')
  })

  it('falls back to the existing automation id when the create/edit response has no id of its own', async () => {
    const env1 = setup({ existing: [{ id: 'auto-existing', name: 'loop-tick', enabled: true, trigger: '0 4 * * *', provider: 'claude' }] })
    env1.runner.run = async (argv) => {
      const key = argv.join(' ')
      if (key.startsWith('orca automations list')) return okResult({ automations: env1.automations, items: env1.automations })
      if (key.startsWith('orca automations edit')) return okResult({})
      if (key.startsWith('orca automations create')) return okResult({})
      return { code: 127, stdout: '', stderr: 'unused', timedOut: false, durationMs: 1 }
    }
    const report = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin', provider: 'claude' })
    expect(report.actions[0]).toMatchObject({ action: 'edit', id: 'auto-existing' })
    expect(report.actions[1]).toMatchObject({ action: 'create', id: null })
  })
})

describe('uninstallLoopAutomations edge cases', () => {
  it('reports a dry-run without removing anything', async () => {
    const env1 = setup({ existing: [{ id: 'auto-1', name: 'loop-tick', enabled: true, trigger: '*/5 * * * *', provider: 'claude' }] })
    const report = await uninstallLoopAutomations({ loaded: env1.loaded, runner: env1.runner, dryRun: true })
    expect(report.status).toBe('dry-run')
    expect(report.actions[0]).toMatchObject({ action: 'remove', detail: 'dry-run' })
    expect(env1.automations).toHaveLength(1)
  })

  it('marks the report failed and records the error when removal fails', async () => {
    const env1 = setup({ existing: [{ id: 'auto-1', name: 'loop-tick', enabled: true, trigger: '*/5 * * * *', provider: 'claude' }] })
    env1.runner.run = async (argv) => {
      const key = argv.join(' ')
      if (key.startsWith('orca automations list')) return okResult({ automations: env1.automations, items: env1.automations })
      if (key.startsWith('orca automations remove')) throw new Error('remove failed')
      return { code: 127, stdout: '', stderr: 'unused', timedOut: false, durationMs: 1 }
    }
    const report = await uninstallLoopAutomations({ loaded: env1.loaded, runner: env1.runner })
    expect(report.status).toBe('failed')
    expect(report.actions[0]?.detail).toBe('remove failed')
  })

  it('captures a thrown non-Error value from a failing removal', async () => {
    const env1 = setup({ existing: [{ id: 'auto-1', name: 'loop-tick', enabled: true, trigger: '*/5 * * * *', provider: 'claude' }] })
    env1.runner.run = async (argv) => {
      const key = argv.join(' ')
      if (key.startsWith('orca automations list')) return okResult({ automations: env1.automations, items: env1.automations })
      if (key.startsWith('orca automations remove')) throw 'plain string removal failure'
      return { code: 127, stdout: '', stderr: 'unused', timedOut: false, durationMs: 1 }
    }
    const report = await uninstallLoopAutomations({ loaded: env1.loaded, runner: env1.runner })
    expect(report.actions[0]?.detail).toBe('plain string removal failure')
  })
})

describe('loopStatus edge cases', () => {
  it('fails closed when Orca automations listing throws', async () => {
    const env1 = setup()
    env1.runner.run = async () => { throw new Error('orca down') }
    await expect(loopStatus({ loaded: env1.loaded, runner: env1.runner })).rejects.toThrow(/Orca automations unavailable/)
  })

  it('fails closed with a stringified reason when the automations listing throws a non-Error value', async () => {
    const env1 = setup()
    env1.runner.run = async () => { throw 'plain string outage' }
    await expect(loopStatus({ loaded: env1.loaded, runner: env1.runner })).rejects.toThrow(/plain string outage/)
  })

  it('treats a failing runs lookup as an empty run history rather than failing the whole status', async () => {
    const env1 = setup({ existing: [{ id: 'auto-1', name: 'loop-tick', enabled: true, trigger: '*/5 * * * *', provider: 'claude' }] })
    env1.runner.run = async (argv) => {
      const key = argv.join(' ')
      if (key.startsWith('orca automations list')) return okResult({ automations: env1.automations, items: env1.automations })
      if (key.startsWith('orca automations runs')) throw new Error('runs unavailable')
      return { code: 127, stdout: '', stderr: 'unused', timedOut: false, durationMs: 1 }
    }
    const status = await loopStatus({ loaded: env1.loaded, runner: env1.runner })
    expect(status.automations[0]).toMatchObject({ installed: true, runs: 0, lastRun: null })
  })
})

describe('parseAutomationRuns shapes', () => {
  it('reads a bare-array result and prefers startedAt/createdAt/at/finishedAt in order', () => {
    expect(parseAutomationRuns([{ startedAt: 1700000000000, status: 'ok' }])).toEqual([{ at: new Date(1700000000000).toISOString(), status: 'ok' }])
    expect(parseAutomationRuns({ runs: [{ finishedAt: '2026-01-01T00:00:00.000Z', status: 'ok' }] })).toEqual([{ at: '2026-01-01T00:00:00.000Z', status: 'ok' }])
  })

  it('falls back to a null "at" for an unparsable date and yields [] for a non-record/non-array result', () => {
    expect(parseAutomationRuns({ runs: [{ startedAt: 'not-a-date', status: 'ok' }] })).toEqual([{ at: null, status: 'ok' }])
    expect(parseAutomationRuns(null)).toEqual([])
    expect(parseAutomationRuns('nope')).toEqual([])
  })

  it('falls back to "outcome" when "status" is absent, and drops the summary when precheckResult stdout is not JSON', () => {
    expect(parseAutomationRuns({ runs: [{ at: '2026-01-01T00:00:00.000Z', outcome: 'skipped' }] })).toEqual([{ at: '2026-01-01T00:00:00.000Z', status: 'skipped' }])
    expect(parseAutomationRuns({ runs: [{ at: '2026-01-01T00:00:00.000Z', status: 'ok', precheckResult: { stdout: 'not-json' } }] })).toEqual([{ at: '2026-01-01T00:00:00.000Z', status: 'ok' }])
  })

  it('includes a reason in the summary when the precheck JSON reports one', () => {
    expect(parseAutomationRuns({ runs: [{ at: '2026-01-01T00:00:00.000Z', status: 'ok', precheckResult: { stdout: JSON.stringify({ status: 'blocked', reason: 'no capacity' }) } }] })).toEqual([{ at: '2026-01-01T00:00:00.000Z', status: 'ok', summary: 'blocked · no capacity' }])
  })

  it('sorts runs by "at" descending, with null "at" entries last', () => {
    const runs = parseAutomationRuns({ runs: [{ at: '2026-01-01T00:00:00.000Z', status: 'a' }, { status: 'no-date' }, { at: '2026-06-01T00:00:00.000Z', status: 'b' }] })
    expect(runs.map((run) => run.status)).toEqual(['b', 'a', 'no-date'])
  })
})
