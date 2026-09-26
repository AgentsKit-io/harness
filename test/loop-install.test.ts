import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { automationName, automationPrompt, automationSpecs, installLoopAutomations, loadLoopConfig, loopStatus, parseAutomationRuns, precheckCommand, sanitizeAutomationSuffix, shellQuote, uninstallLoopAutomations } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/loop', `${name}.json`), 'utf8')) as unknown
const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const okResult = (result: unknown): CommandResult => ok({ ok: true, result })
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = (existing: readonly Record<string, unknown>[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-install-')); cleanups.push(dir)
  const bin = mkdtempSync(join(tmpdir(), 'agentskit-loop-install-bin-')); cleanups.push(bin)
  for (const name of ['claude', 'codex', 'opencode', 'grok', 'ak-harness']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  const automations: Record<string, unknown>[] = [...existing]
  const calls: string[][] = []
  const runner: CommandRunner & { readonly calls: string[][] } = {
    calls,
    run: async (argv) => {
      calls.push([...argv])
      const key = argv.join(' ')
      if (key.startsWith('orca account list')) return ok(fixture('account-list'))
      if (key.startsWith('orca agent hooks status')) return ok(fixture('agent-hooks'))
      if (key.startsWith('orca automations list')) return okResult({ automations, items: automations })
      if (key.startsWith('orca automations create')) { const created = { id: `auto-${automations.length + 1}`, name: argv[argv.indexOf('--name') + 1], enabled: !argv.includes('--disabled'), trigger: argv[argv.indexOf('--trigger') + 1], provider: argv[argv.indexOf('--provider') + 1] }; automations.push(created); return okResult({ automation: created }) }
      if (key.startsWith('orca automations edit')) return okResult({ automation: { id: argv[3] } })
      if (key.startsWith('orca automations remove')) { const index = automations.findIndex((item) => item['id'] === argv[3]); if (index >= 0) automations.splice(index, 1); return okResult({ removed: true }) }
      if (key.startsWith('orca automations runs')) return okResult({ runs: [{ startedAt: 1789140000000, status: 'succeeded' }, { startedAt: 1789150000000, status: 'skipped_precheck', precheckResult: { exitCode: 1, stdout: JSON.stringify({ status: 'ok', results: [{ issue: 'ENG-1' }] }) } }] })
      return { code: 127, stdout: '', stderr: `no fixture for ${key}`, timedOut: false, durationMs: 1 }
    },
  }
  return { dir, bin, loaded, runner, automations }
}
const env = (bin: string) => ({ PATH: bin, XAI_API_KEY: 'k' })

describe('loop install', () => {
  it('derives two automation specs with read-only prechecks, existing-workspace mode and the config path baked in', () => {
    const { loaded } = setup()
    const specs = automationSpecs(loaded, 'claude')
    // Default `schedule.namePrefix: 'loop'` plus a non-default `project.name` (`my-project` in the fixture) yields a
    // per-project prefix — two configs running side-by-side no longer share `<prefix>-tick`/`<prefix>-deliver` and
    // overwriting each other's automations on every Orca reconcile.
    expect(specs.map((spec) => spec.name)).toEqual(['loop-my-project-tick', 'loop-my-project-deliver'])
    expect(specs[0]).toMatchObject({ trigger: '*/5 * * * *', provider: 'claude', reuseSession: true })
    expect(specs[0]?.precheck).toBe(precheckCommand(loaded.config, loaded.path, 'tick'))
    expect(specs[0]?.precheck).toBe(`ak-harness loop stage tick -f "${loaded.path}"`)
    // Always the short precheck budget, never schedule.stageTimeoutSec — tick's precheck fires a detached
    // background worker instead of doing the real work inline, so Orca's own precheck ceiling never has to
    // accommodate a potentially much longer stage budget.
    expect(specs[0]?.precheckTimeoutSec).toBe(120)
    expect(automationPrompt(loaded.config, loaded.path, 'tick')).toContain('LOOP_PRECHECK_BYPASSED')
    const agentMode = { ...loaded, config: { ...loaded.config, schedule: { ...loaded.config.schedule, runner: 'agent' as const } } }
    expect(automationSpecs(agentMode, 'claude')[0]).toMatchObject({ precheckTimeoutSec: 120 })
    expect(automationSpecs(agentMode, 'claude')[0]?.precheck).toContain('loop precheck tick')
    expect(automationPrompt(agentMode.config, loaded.path, 'deliver')).toContain(`ak-harness loop deliver -f "${loaded.path}" --json`)
    expect(shellQuote('C:\\Users\\x y\\loop.config.yaml')).toBe('"C:\\Users\\x y\\loop.config.yaml"')
    expect(shellQuote('/a/"b"/c')).toBe('"/a/\\"b\\"/c"')
    expect(specs[0]?.workspace).toBe(`path:${loaded.root}`)
    expect(automationName(loaded.config, 'tick')).toBe('loop-my-project-tick')
  })

  it('respects an explicit `schedule.namePrefix` and does not derive from project.name', () => {
    const { loaded } = setup()
    const pinned = { ...loaded, config: { ...loaded.config, schedule: { ...loaded.config.schedule, namePrefix: 'cust-x' } } }
    expect(automationSpecs(pinned, 'claude').map((spec) => spec.name)).toEqual(['cust-x-tick', 'cust-x-deliver'])
  })

  it('sanitizes awkward project names so two configs can never collide on an automation name', () => {
    expect(sanitizeAutomationSuffix('My Repo (v2)!')).toBe('my-repo-v2')
    expect(sanitizeAutomationSuffix('   ')).toBe('')
    expect(sanitizeAutomationSuffix('café résumé')).toBe('cafe-re-sume')
    // 32-char ceiling keeps the Orca-side identifier bounded.
    expect(sanitizeAutomationSuffix('a'.repeat(80)).length).toBe(32)
  })

  it('creates on first install, leaves a matching automation alone on the second, picks the watcher provider, and warns when the harness binary is missing', async () => {
    const env1 = setup()
    const first = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin' })
    expect(first.status).toBe('ok')
    expect(first.provider).toBe('claude')
    expect(first.actions.map((action) => action.action)).toEqual(['create', 'create'])
    expect(first.actions[0]?.argv.slice(0, 3)).toEqual(['orca', 'automations', 'create'])
    expect(first.actions[0]?.argv).toContain('--workspace-mode')
    expect(first.actions[0]?.argv).toContain('--reuse-session')
    expect(first.notes).toEqual([])
    // Idempotence: a second install over automations that already match the config must not rewrite them.
    const second = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin' })
    expect(second.actions.map((action) => action.action)).toEqual(['skip', 'skip'])
    expect(second.actions[0]?.detail).toBe('already matches the config')
    expect(env1.automations).toHaveLength(2)
    // …and an automation edited by hand is put back, naming the field that drifted.
    env1.automations[0]!['rrule'] = '0 3 * * *'
    const third = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin' })
    expect(third.actions.map((action) => action.action)).toEqual(['edit', 'skip'])
    expect(third.actions[0]?.argv.slice(0, 4)).toEqual(['orca', 'automations', 'edit', 'auto-1'])
    expect(third.actions[0]?.detail).toContain('updated trigger')
    const dry = await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: { PATH: '/nonexistent' }, platform: 'darwin', dryRun: true, provider: 'codex' })
    expect(dry.status).toBe('dry-run')
    expect(dry.provider).toBe('codex')
    expect(dry.notes[0]).toContain('not on PATH')
    expect(env1.runner.calls.filter((argv) => argv[1] === 'automations' && (argv[2] === 'create' || argv[2] === 'edit'))).toHaveLength(3)
  })

  it('reports status with latest runs, and uninstall removes only the loop automations', async () => {
    const env1 = setup([{ id: 'other-1', name: 'someone-else', enabled: true, trigger: 'daily', provider: 'codex' }])
    await installLoopAutomations({ loaded: env1.loaded, runner: env1.runner, env: env(env1.bin), platform: 'darwin' })
    const status = await loopStatus({ loaded: env1.loaded, runner: env1.runner })
    expect(status.installed).toBe(2)
    expect(status.automations[0]).toMatchObject({ installed: true, enabled: true, runs: 2, lastRun: { status: 'skipped_precheck', summary: 'ok · 1 result(s)' } })
    expect(status.summary).toMatch(/^loop: installed \(2\/2, last run 2026-/)
    expect(parseAutomationRuns({ runs: [{ createdAt: '2026-01-01T00:00:00.000Z', outcome: 'ok' }] })).toEqual([{ at: '2026-01-01T00:00:00.000Z', status: 'ok' }])
    const removed = await uninstallLoopAutomations({ loaded: env1.loaded, runner: env1.runner })
    expect(removed.actions.map((action) => action.action)).toEqual(['remove', 'remove', 'skip', 'skip'])
    expect(env1.automations.map((item) => item['name'])).toEqual(['someone-else'])
    const again = await uninstallLoopAutomations({ loaded: env1.loaded, runner: env1.runner })
    expect(again.actions.every((action) => action.action === 'skip')).toBe(true)
    const empty = await loopStatus({ loaded: env1.loaded, runner: env1.runner })
    expect(empty.summary).toContain(`loop: not installed — to enable: ak-harness loop install -f "${env1.loaded.path}"`)
  })
})
