import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTRACT_CLOSE, CONTRACT_OPEN, installPreflight, loadLoopConfig, runGuidedInstall } from '../src/index.js'
import type { CommandResult, CommandRunner, GuidedInstallIO } from '../src/index.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/loop', `${name}.json`), 'utf8')) as unknown
const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const okResult = (result: unknown): CommandResult => ok({ ok: true, result })
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const contract = { intent: 'x', scope: { inScope: ['a'], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'd', check: { kind: 'test', command: 'pnpm test' } }], ambiguities: [], touchpoints: [], risks: [] }

const setup = (options: { readonly ghAuth?: boolean; readonly harnessOnPath?: boolean; readonly repoRegistered?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-guided-')); cleanups.push(dir)
  const bin = mkdtempSync(join(tmpdir(), 'agentskit-loop-guided-bin-')); cleanups.push(bin)
  for (const name of ['claude', 'codex', 'opencode', 'grok', 'gh', 'agentskit-review', ...(options.harnessOnPath === false ? [] : ['ak-harness'])]) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
      if (key.startsWith('orca linear list-issues')) return ok(fixture(key.includes('--state Ready') ? 'list-issues-ready' : 'list-issues-todo'))
      if (key.startsWith('orca linear issue')) { const issues = (fixture('list-issues-todo') as { result: { issues: { identifier: string }[] } }).result.issues; const issue = issues.find((item) => item.identifier === argv[3]); return okResult({ issue: { ...issue, description: 'do it' }, comments: [] }) }
      if (argv[0] === 'claude' && argv[1] === '-p') return { code: 0, stdout: `${CONTRACT_OPEN}${JSON.stringify(contract)}${CONTRACT_CLOSE}`, stderr: '', timedOut: false, durationMs: 1 }
      if (key.startsWith('gh auth status')) return { code: options.ghAuth === false ? 1 : 0, stdout: '', stderr: options.ghAuth === false ? 'not logged in' : '', timedOut: false, durationMs: 1 }
      if (key.startsWith('orca repo list')) return okResult({ repos: options.repoRegistered === false ? [] : [{ id: 'repo-1', path: loaded.root }] })
      if (key.startsWith('orca automations list')) return okResult({ automations, items: automations })
      if (key.startsWith('orca automations create')) { const created = { id: `auto-${automations.length + 1}`, name: argv[argv.indexOf('--name') + 1], enabled: true, trigger: argv[argv.indexOf('--trigger') + 1], provider: argv[argv.indexOf('--provider') + 1] }; automations.push(created); return okResult({ automation: created }) }
      if (key.startsWith('orca automations runs')) return okResult({ runs: [] })
      return { code: 127, stdout: '', stderr: `no fixture for ${key}`, timedOut: false, durationMs: 1 }
    },
  }
  return { dir, bin, loaded, runner, automations }
}

const io = (answers: readonly boolean[] | ((question: string) => boolean)): GuidedInstallIO & { readonly lines: string[]; readonly questions: string[] } => {
  const lines: string[] = []; const questions: string[] = []; let index = 0
  return { lines, questions, write: (text) => { lines.push(text) }, confirm: async (question) => { questions.push(question); return typeof answers === 'function' ? answers(question) : answers[index++] ?? false } }
}
const relaxed = { sample: { at: '2026-09-11T12:00:00.000Z', cpus: 10, load1: 1, load1PerCpuPercent: 10, memoryUsedPercent: 40, rssBytes: 1 }, freeBytes: 20 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 }
const base = (env: ReturnType<typeof setup>, terminal: GuidedInstallIO) => ({ loaded: env.loaded, runner: env.runner, io: terminal, env: { PATH: env.bin, XAI_API_KEY: 'k' }, platform: 'darwin' as const, now: () => new Date('2026-09-11T12:00:00.000Z') })

describe('guided install', () => {
  it('runs doctor and environment checks, rehearses a dry-run tick, asks before installing, and installs on yes', async () => {
    const env = setup()
    const terminal = io([true, true])
    const report = await runGuidedInstall({ ...base(env, terminal), skipRehearsal: false })
    expect(report.status).toBe('installed')
    expect(report.doctor?.status).toBe('passed')
    expect(report.preflight.map((check) => check.id)).toEqual(['env.harness', 'env.review-cli', 'env.gh', 'github.auth', 'orca.repo', 'config.person'])
    expect(report.preflight.every((check) => check.status === 'passed')).toBe(true)
    expect(report.rehearsal?.results[0]).toMatchObject({ outcome: 'dry-run' })
    expect(terminal.questions).toHaveLength(2)
    expect(terminal.questions[1]).toContain('Install these automations now?')
    expect(env.automations.map((item) => item['name'])).toEqual(['loop-tick', 'loop-deliver'])
    expect(terminal.lines.some((text) => text.includes('1/4 Doctor'))).toBe(true)
    expect(terminal.lines.some((text) => text.includes('precheck:'))).toBe(true)
    expect(env.runner.calls.some((argv) => argv[1] === 'worktree' && argv[2] === 'create')).toBe(false)
  })

  it('aborts without creating anything when the user declines, and never prompts with --yes', async () => {
    const declined = setup()
    const terminal = io([false, false])
    const report = await runGuidedInstall({ ...base(declined, terminal) })
    expect(report.status).toBe('aborted')
    expect(declined.automations).toEqual([])
    expect(terminal.questions).toHaveLength(2)
    const auto = setup()
    const silent = io(() => { throw new Error('must not prompt') })
    const yes = await runGuidedInstall({ ...base(auto, silent), yes: true, skipRehearsal: true })
    expect(yes.status).toBe('installed')
    expect(yes.rehearsal).toBeNull()
    expect(auto.automations).toHaveLength(2)
  })

  it('blocks on failed checks unless --force, and dry-run never creates automations', async () => {
    const broken = setup({ ghAuth: false, harnessOnPath: false })
    const terminal = io([true, true])
    const report = await runGuidedInstall({ ...base(broken, terminal) })
    expect(report.status).toBe('blocked')
    expect(report.reason).toContain('env.harness')
    expect(report.reason).toContain('github.auth')
    expect(terminal.questions).toHaveLength(0)
    expect(broken.automations).toEqual([])
    const forced = await runGuidedInstall({ ...base(broken, io([false, true])), force: true })
    expect(forced.status).toBe('installed')
    expect(broken.automations).toHaveLength(2)
    const dry = setup({ repoRegistered: false })
    const dryReport = await runGuidedInstall({ ...base(dry, io([false])), dryRun: true })
    expect(dryReport.status).toBe('dry-run')
    expect(dryReport.install?.actions.map((action) => action.action)).toEqual(['create', 'create'])
    expect(dry.automations).toEqual([])
    expect(dryReport.preflight.find((check) => check.id === 'orca.repo')).toMatchObject({ status: 'warning' })
    const preflight = await installPreflight(dry.loaded, dry.runner, { PATH: '/nonexistent' }, 'darwin')
    expect(preflight.filter((check) => check.status === 'failed').map((check) => check.id)).toEqual(['env.harness', 'env.review-cli', 'env.gh'])
  })
})
