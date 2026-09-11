import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { CONTRACT_CLOSE, CONTRACT_OPEN, installPreflight, loadLoopConfig, parseTeamMembers, promptLocalConfig, renderLocalConfig, runGuidedInstall, writeLocalConfig } from '../src/index.js'
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
      if (key.startsWith('orca linear team members')) return okResult({ members: [{ id: 'u1', displayName: 'person' }, { id: 'u2', displayName: 'teammate' }] })
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
    expect(report.localConfig).toBeNull()
    expect(report.preflight.every((check) => check.status === 'passed')).toBe(true)
    expect(report.rehearsal?.results[0]).toMatchObject({ outcome: 'dry-run' })
    expect(terminal.questions).toHaveLength(2)
    expect(terminal.questions[1]).toContain('Install these automations now?')
    expect(env.automations.map((item) => item['name'])).toEqual(['loop-tick', 'loop-deliver'])
    expect(terminal.lines.some((text) => text.includes('2/5 Doctor'))).toBe(true)
    expect(terminal.lines.some((text) => text.includes('precheck ak-harness loop precheck tick'))).toBe(true)
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

describe('local config wizard', () => {
  it('renders only answered keys and parses team members', () => {
    expect(renderLocalConfig({ person: 'teammate' }, '/x/loop.config.yaml')).toContain('person: teammate')
    expect(renderLocalConfig({ person: 'teammate' }, '/x/loop.config.yaml')).not.toContain('machine:')
    expect(renderLocalConfig({ person: 'teammate', minFreeRamGb: 2, ceiling: 3 }, '/x/loop.config.yaml')).toMatch(/machine:\n  minFreeRamGb: 2\n  ceiling: 3/)
    expect(parseTeamMembers({ members: [{ id: 'a', displayName: 'x' }, { id: 'b', name: 'y' }, { nope: 1 }] })).toEqual([{ id: 'a', displayName: 'x' }, { id: 'b', displayName: 'y' }])
  })

  it('offers to create loop.config.local.yaml when missing, writes the answers, and reloads the queue owner', async () => {
    const env = setup()
    const answers: Record<string, unknown> = { 'Create loop.config.local.yaml for this machine now?': true, 'Tune how much of this machine the loop may use?': true, 'Run a dry-run tick now': false, 'Install these automations now?': false }
    const prompter = {
      lines: [] as string[],
      write: (text: string) => { prompter.lines.push(text) },
      confirm: async (question: string) => Object.entries(answers).find(([key]) => question.startsWith(key))?.[1] as boolean ?? false,
      select: async (question: string, options: readonly { value: string }[]) => question.startsWith('Whose Linear queue') ? 'teammate' : options[0]?.value ?? null,
      text: async (question: string, fallback: string) => question.startsWith('GB of RAM') ? '2' : question.startsWith('Maximum concurrent') ? '3' : fallback,
      checks: () => {}, section: () => {}, banner: () => {}, bullet: (line: string) => { prompter.lines.push(line) },
    }
    const report = await runGuidedInstall({ ...base(env, prompter) })
    expect(report.status).toBe('aborted')
    expect(report.localConfig).toMatchObject({ created: true })
    const localPath = join(env.dir, 'loop.config.local.yaml')
    expect(existsSync(localPath)).toBe(true)
    const reloaded = loadLoopConfig(env.loaded.path)
    expect(reloaded.config.linear.person).toBe('teammate')
    expect(reloaded.config.machine).toMatchObject({ minFreeRamGb: 2, ceiling: 3 })
    expect(report.preflight.find((check) => check.id === 'config.person')?.detail).toContain('teammate')
    const second = await runGuidedInstall({ ...base(env, prompter) })
    expect(second.localConfig).toMatchObject({ created: false })
    expect(env.runner.calls.filter((argv) => argv[1] === 'linear' && argv[2] === 'team')).toHaveLength(1)
  })

  it('cancels cleanly and skips the wizard with --yes or --skip-local-config', async () => {
    const nonTty = setup()
    const io0 = { interactive: false, write: () => {}, confirm: async (_q: string, fallback: boolean) => fallback, select: async () => 'teammate', text: async (_q: string, fallback: string) => fallback }
    const quiet = await runGuidedInstall({ ...base(nonTty, io0) })
    expect(quiet.localConfig).toBeNull()
    expect(existsSync(join(nonTty.dir, 'loop.config.local.yaml'))).toBe(false)
    const cancel = setup()
    const io1 = { write: () => {}, confirm: async () => true, select: async () => null, text: async () => null }
    const cancelled = await runGuidedInstall({ ...base(cancel, io1) })
    expect(cancelled.status).toBe('aborted')
    expect(existsSync(join(cancel.dir, 'loop.config.local.yaml'))).toBe(false)
    const skipped = setup()
    const io2 = { write: () => {}, confirm: async () => false, select: async () => { throw new Error('must not prompt') }, text: async () => { throw new Error('must not prompt') } }
    const report = await runGuidedInstall({ ...base(skipped, io2), skipLocalConfig: true })
    expect(report.status).toBe('aborted')
    expect(report.localConfig).toBeNull()
    const direct = await promptLocalConfig(skipped.runner, skipped.loaded, { select: async () => '__other__', text: async (_q, fallback) => fallback === 'person' ? 'typed-name' : fallback, confirm: async () => false, write: () => {} })
    expect(direct).toEqual({ person: 'typed-name' })
    const written = writeLocalConfig(skipped.loaded, { person: 'typed-name' })
    expect(written.loaded.config.linear.person).toBe('typed-name')
  })
})
