import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPreflight, loadLoopConfig, runGuidedInstall } from '../src/index.js'
import type { CommandResult, CommandRunner, GuidedInstallIO } from '../src/index.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/loop', `${name}.json`), 'utf8')) as unknown
const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const okResult = (result: unknown): CommandResult => ok({ ok: true, result })
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = (options: { readonly failCreate?: boolean; readonly emptyQueue?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-guided-gaps-')); cleanups.push(dir)
  const bin = mkdtempSync(join(tmpdir(), 'agentskit-loop-guided-gaps-bin-')); cleanups.push(bin)
  for (const name of ['claude', 'codex', 'opencode', 'grok', 'gh', 'agentskit-review', 'ak-harness']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
  const automations: Record<string, unknown>[] = []
  const calls: string[][] = []
  const runner: CommandRunner & { readonly calls: string[][] } = {
    calls,
    run: async (argv) => {
      calls.push([...argv])
      const key = argv.join(' ')
      if (key === 'orca --version') return { code: 0, stdout: '1.4.200', stderr: '', timedOut: false, durationMs: 1 }
      if (key.startsWith('orca status')) return ok(fixture('status'))
      if (key.startsWith('orca account list')) return ok(fixture('account-list'))
      if (key.startsWith('orca agent hooks status')) return ok(fixture('agent-hooks'))
      if (key.startsWith('orca worktree ps')) return okResult({ worktrees: [] })
      if (key.startsWith('orca linear list-issues')) return options.emptyQueue ? okResult({ issues: [] }) : ok(fixture(key.includes('--state Ready') ? 'list-issues-ready' : 'list-issues-todo'))
      if (key.startsWith('gh auth status')) return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
      if (key.startsWith('orca repo list')) return okResult({ repos: [{ id: 'repo-1', path: loaded.root }] })
      if (key.startsWith('orca automations list')) return okResult({ automations, items: automations })
      if (key.startsWith('orca automations create')) {
        if (options.failCreate) return { code: 1, stdout: JSON.stringify({ ok: false, error: 'boom' }), stderr: '', timedOut: false, durationMs: 1 }
        const created = { id: `auto-${automations.length + 1}`, name: argv[argv.indexOf('--name') + 1], enabled: true, trigger: argv[argv.indexOf('--trigger') + 1], provider: argv[argv.indexOf('--provider') + 1] }
        automations.push(created)
        return okResult({ automation: created })
      }
      return { code: 127, stdout: '', stderr: `no fixture for ${key}`, timedOut: false, durationMs: 1 }
    },
  }
  return { dir, bin, loaded, runner }
}

const io = (): GuidedInstallIO & { readonly lines: string[] } => {
  const lines: string[] = []
  return { lines, write: (text) => { lines.push(text) }, confirm: async (_q, fallback) => fallback, interactive: false }
}

describe('installPreflight resilience', () => {
  it('marks github.auth failed with the error message when the gh auth probe throws', async () => {
    const env = setup()
    const throwingRunner: CommandRunner = { run: async (argv) => { if (argv.join(' ').startsWith('gh auth status')) throw new Error('gh crashed'); return env.runner.run(argv) } }
    const checks = await installPreflight(env.loaded, throwingRunner, { PATH: env.bin }, 'darwin')
    expect(checks.find((check) => check.id === 'github.auth')).toMatchObject({ status: 'failed', detail: 'gh crashed' })
  })

  it('marks orca.repo as a warning with the error message when the repo list probe throws', async () => {
    const env = setup()
    const throwingRunner: CommandRunner = { run: async (argv) => { if (argv.join(' ').startsWith('orca repo list')) throw new Error('orca crashed'); return env.runner.run(argv) } }
    const checks = await installPreflight(env.loaded, throwingRunner, { PATH: env.bin }, 'darwin')
    expect(checks.find((check) => check.id === 'orca.repo')).toMatchObject({ status: 'warning', detail: 'orca repo list unavailable: orca crashed' })
  })
})

describe('runGuidedInstall branches not covered by the happy-path suite', () => {
  it('takes the "no terminal to ask" bullet when non-interactive and no local config exists', async () => {
    const env = setup()
    const terminal = io()
    const report = await runGuidedInstall({ loaded: env.loaded, runner: env.runner, io: terminal, env: { PATH: env.bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), skipRehearsal: true })
    expect(terminal.lines.some((line) => line.includes('no terminal to ask'))).toBe(true)
    expect(report.status).toBe('aborted')
  })

  it('declines to create the local config wizard when the user says no', async () => {
    const env = setup()
    const terminal: GuidedInstallIO & { readonly lines: string[] } = { lines: [], write: (text) => { terminal.lines.push(text) }, confirm: async () => false, select: async () => null, text: async () => null }
    const report = await runGuidedInstall({ loaded: env.loaded, runner: env.runner, io: terminal, env: { PATH: env.bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z') })
    expect(report.localConfig).toBeNull()
    expect(report.status).toBe('aborted')
  })

  it('runs the rehearsal with an empty queue and surfaces its notes', async () => {
    const env = setup({ emptyQueue: true })
    const terminal = io()
    const report = await runGuidedInstall({ loaded: env.loaded, runner: env.runner, io: terminal, env: { PATH: env.bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z') })
    expect(report.rehearsal).not.toBeNull()
    expect(terminal.lines.some((line) => line.includes('tick '))).toBe(true)
  })

  it('returns blocked when installLoopAutomations itself reports a failure', async () => {
    const env = setup({ failCreate: true })
    const terminal = io()
    const report = await runGuidedInstall({ loaded: env.loaded, runner: env.runner, io: terminal, env: { PATH: env.bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), skipRehearsal: true, skipLocalConfig: true, yes: true })
    expect(report.status).toBe('blocked')
    expect(report.reason).toBe('orca refused an automation')
  })
})
