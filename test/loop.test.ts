import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activeCooldowns, assessSlots, authStatusFor, availableMemoryBytes, parseMemInfo, parseVmStat, buildListIssuesArgv, compareVersions, cooldownUntil, countRunningWorkers, detectProviders, fetchLinearQueue, filterAndOrderQueue, findExecutable,
  HarnessError, loadLoopConfig, markProviderExhausted, mergeLoopConfig, parseJsonEnvelope, parseLinearIssues, parseLoopConfigText, parseModelRef, parseOrcaAgentHooks, parseOrcaStatus, parseOrcaVersion, parseOrcaWorktrees,
  parseProviderUsage, providerSpecs, readCooldowns, routeAllRoles, runLoopDoctor, selectModel, validateLoopConfig,
} from '../src/index.js'
import type { CommandResult, CommandRunner, LoopConfig, ProviderAvailability } from '../src/index.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/loop', `${name}.json`), 'utf8')) as unknown
const result = (name: string): unknown => (fixture(name) as { readonly result: unknown }).result
const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8')

const baseConfig = (): LoopConfig => validateLoopConfig({
  project: { name: 'demo', repo: 'org/demo' },
  linear: { workspaceId: 'ws-1', teamKey: 'ENG', person: 'person' },
  models: {
    orchestrator: [['codex/gpt-5.6-sol', 'claude/opus'], ['opencode/opencode-go/glm-5.3'], ['grok/grok-4-fast']],
    reviewer: [['codex/gpt-5.6-sol', 'claude/opus'], ['grok/grok-4-fast']],
    builder: [['codex/gpt-5.6-luna', 'claude/sonnet'], ['opencode/opencode-go/glm-5.3-flash'], ['grok/grok-4-fast']],
    watcher: [['claude/haiku']],
    providers: {
      claude: { bin: 'claude', auth: 'subscription', envKeys: ['ANTHROPIC_API_KEY'], tui: 'claude --model {model} --permission-mode auto' },
      codex: { bin: 'codex', auth: 'subscription', tui: 'codex -m {model} --full-auto' },
      opencode: { bin: 'opencode', orcaUsageKey: 'opencodeGo', tui: 'opencode -m {model}' },
      grok: { bin: 'grok', auth: 'subscription', tui: 'grok -m {model}' },
    },
  },
  delivery: { verifyCommand: 'pnpm test' },
})

const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const fakeRunner = (overrides: Partial<Record<string, CommandResult>> = {}): CommandRunner & { readonly calls: string[][] } => {
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
      if (key.startsWith('orca linear list-issues')) return ok(fixture(key.includes('--state Ready') ? 'list-issues-ready' : 'list-issues-todo'))
      return table[key] ?? { code: 127, stdout: '', stderr: `no fixture for ${key}`, timedOut: false, durationMs: 1 }
    },
  }
}

const fakeBinDir = (names: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-bin-'))
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return dir
}
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('loop config', () => {
  it('parses the shipped example and applies defaults', () => {
    const config = parseLoopConfigText(exampleYaml)
    expect(config.linear.states).toEqual(['Todo', 'Ready'])
    expect(config.schedule.tick).toBe('*/5 * * * *')
    expect(config.models.cooldown).toMatchObject({ initialMin: 30, maxMin: 240 })
    expect(config.delivery.review.minSeverity).toBe('med')
    expect(parseModelRef('opencode/opencode-go/glm-5.3')).toEqual({ provider: 'opencode', model: 'opencode-go/glm-5.3' })
  })

  it('fails closed on missing sections, unknown providers, and bad values', () => {
    const attempt = (value: unknown): HarnessError => { try { validateLoopConfig(value); throw new Error('expected failure') } catch (error) { return error as HarnessError } }
    expect(attempt({})).toMatchObject({ code: 'INVALID_CONFIG' })
    expect(attempt({}).message).toContain('project')
    const config = baseConfig()
    expect(attempt({ ...config, models: { ...config.models, builder: [['gemini/pro']] } }).message).toContain('unknown provider "gemini"')
    expect(attempt({ ...config, machine: { ...config.machine, warningPercent: 95, criticalPercent: 90 } }).message).toContain('warningPercent')
    expect(attempt({ ...config, schedule: { tick: 'every five minutes' } }).message).toContain('cron')
    expect(attempt({ ...config, project: { ...config.project, repo: 'not-a-repo' } }).message).toContain('owner/name')
    expect(() => parseLoopConfigText('- just\n- a list\n')).toThrow(/top level must be a mapping/)
  })

  it('loads from disk, resolves root and stateDir, and hashes the effective config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-config-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'))
    expect(loaded.root).toBe(dir)
    expect(loaded.stateDir).toBe(join(dir, '.codex/loop'))
    expect(loaded.configHash).toMatch(/^[a-f0-9]{64}$/)
    expect(() => loadLoopConfig(join(dir, 'missing.yaml'))).toThrow(/not found/)
    writeFileSync(join(dir, 'loop.config.local.yaml'), 'linear:\n  person: someone-else\nmachine:\n  minFreeRamGb: 2\nmodels:\n  builder: [[claude/haiku]]\n')
    const overlaid = loadLoopConfig(join(dir, 'loop.config.yaml'))
    expect(overlaid.localPath).toBe(join(dir, 'loop.config.local.yaml'))
    expect(overlaid.config.linear.person).toBe('someone-else')
    expect(overlaid.config.linear.teamKey).toBe(loaded.config.linear.teamKey)
    expect(overlaid.config.machine.minFreeRamGb).toBe(2)
    expect(overlaid.config.models.builder).toEqual([['claude/haiku']])
    expect(overlaid.configHash).not.toBe(loaded.configHash)
    expect(mergeLoopConfig({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 })).toEqual({ a: { b: 1, c: [3] }, d: 1, e: 2 })
  })
})

describe('orca and linear parsers', () => {
  it('parses envelopes, versions, status, worktrees, and agent hooks', () => {
    expect(parseJsonEnvelope('{"ok":true,"result":{"a":1}}')).toEqual({ ok: true, result: { a: 1 } })
    expect(parseJsonEnvelope('not json')).toBeNull()
    expect(parseJsonEnvelope('{"ok":false,"error":{"message":"boom"}}')).toMatchObject({ ok: false, error: 'boom' })
    expect(parseOrcaVersion('orca 1.4.200\n')).toBe('1.4.200')
    expect(compareVersions('1.4.200', '1.4.199')).toBe(1)
    expect(compareVersions('1.4.200', '1.10.0')).toBe(-1)
    expect(parseOrcaStatus(result('status'))).toMatchObject({ appRunning: true, runtimeReady: true, appVersion: '1.4.200' })
    const worktrees = parseOrcaWorktrees(result('worktree-ps'))
    expect(worktrees[0]).toMatchObject({ branch: 'person/eng-1-demo', linkedLinearIssue: 'ENG-1', liveTerminalCount: 1, isMainWorktree: false })
    expect(countRunningWorkers(worktrees)).toBe(1)
    expect(parseOrcaAgentHooks(result('agent-hooks'))).toMatchObject({ claude: 'installed', codex: 'installed', gemini: 'not_installed' })
  })

  it('parses Linear issues and builds one argv per state without shell strings', () => {
    const issues = parseLinearIssues(result('list-issues-todo'))
    expect(issues[0]).toMatchObject({ identifier: 'ENG-10', state: 'Todo', stateType: 'unstarted', assignee: 'person' })
    expect(issues[0]?.labels.length).toBeGreaterThan(0)
    expect(buildListIssuesArgv({ workspaceId: 'ws-1', teamKey: 'ENG', assignee: 'person', state: 'Todo', limit: 5 })).toEqual(['orca', 'linear', 'list-issues', '--team', 'ENG', '--workspace', 'ws-1', '--assignee', 'person', '--state', 'Todo', '--limit', '5', '--json'])
  })

  it('filters by state, labels, project and orders urgent first with none last', () => {
    const base = { id: 'x', title: 't', url: 'u', stateType: 'unstarted', assignee: 'p', assigneeId: 'p', labels: [] as readonly string[], priorityLabel: 'x', project: null, branchName: null, createdAt: '2026-01-01T00:00:00.000Z' }
    const issues = [
      { ...base, identifier: 'A', state: 'Todo', priority: 0, updatedAt: '2026-01-05T00:00:00.000Z' },
      { ...base, identifier: 'B', state: 'Todo', priority: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...base, identifier: 'C', state: 'Ready', priority: 2, updatedAt: '2026-01-03T00:00:00.000Z' },
      { ...base, identifier: 'D', state: 'Todo', priority: 2, updatedAt: '2026-01-04T00:00:00.000Z' },
      { ...base, identifier: 'E', state: 'Todo', priority: 1, labels: ['blocked'], updatedAt: '2026-01-06T00:00:00.000Z' },
      { ...base, identifier: 'F', state: 'In Progress', priority: 1, updatedAt: '2026-01-06T00:00:00.000Z' },
      { ...base, identifier: 'B', state: 'Todo', priority: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
    ]
    const filter = { states: ['Todo', 'Ready'], excludeLabels: ['blocked'], requireLabels: [], projects: [], order: ['priority', 'updatedAt'] as const, maxQueue: 10 }
    expect(filterAndOrderQueue(issues, filter).map((issue) => issue.identifier)).toEqual(['B', 'D', 'C', 'A'])
    expect(filterAndOrderQueue(issues, { ...filter, maxQueue: 2 }).map((issue) => issue.identifier)).toEqual(['B', 'D'])
    expect(filterAndOrderQueue(issues, { ...filter, projects: ['Alpha'] })).toEqual([])
  })

  it('fetches one page per configured state and merges them', async () => {
    const runner = fakeRunner()
    const config = baseConfig()
    const queue = await fetchLinearQueue(runner, { workspaceId: 'ws-1', teamKey: 'ENG', assignee: 'person', filter: config.linear })
    expect(runner.calls.filter((argv) => argv.includes('list-issues')).map((argv) => argv[argv.indexOf('--state') + 1])).toEqual(['Todo', 'Ready'])
    expect(new Set(queue.map((issue) => issue.state))).toEqual(new Set(['Todo', 'Ready']))
  })
})

describe('providers, usage, routing, cooldown', () => {
  it('reads Orca usage windows and marks exhausted providers with their reset time', () => {
    const account = result('account-list')
    const codex = parseProviderUsage(account, 'codex')
    expect(codex.status).toBe('ok')
    expect(codex.exhausted).toBe(true)
    expect(codex.resetsAt).toMatch(/^\d{4}-/)
    expect(codex.hasAuth).toBe(true)
    const claude = parseProviderUsage(account, 'claude')
    expect(claude).toMatchObject({ status: 'unavailable', exhausted: false })
    expect(parseProviderUsage(account, 'nope')).toMatchObject({ status: 'unknown', exhausted: false, hasAuth: null })
    expect(parseProviderUsage(account, 'opencodeGo', 100).windows.map((window) => window.kind)).toEqual(['session', 'weekly', 'monthly'])
  })

  it('derives auth status from provider kind, env keys, and Orca credentials', () => {
    const unknown = { status: 'unknown' as const, error: null, windows: [], exhausted: false, resetsAt: null, hasAuth: null }
    expect(authStatusFor({ id: 'grok', bin: 'grok', auth: 'api-key', envKeys: ['XAI_API_KEY'], orcaUsageKey: 'grok' }, unknown, {})).toBe('missing')
    expect(authStatusFor({ id: 'grok', bin: 'grok', auth: 'api-key', envKeys: ['XAI_API_KEY'], orcaUsageKey: 'grok' }, unknown, { XAI_API_KEY: 'k' })).toBe('ok')
    expect(authStatusFor({ id: 'codex', bin: 'codex', auth: 'subscription', envKeys: [], orcaUsageKey: 'codex' }, { ...unknown, hasAuth: true }, {})).toBe('ok')
    expect(authStatusFor({ id: 'codex', bin: 'codex', auth: 'subscription', envKeys: [], orcaUsageKey: 'codex' }, { ...unknown, hasAuth: false }, {})).toBe('missing')
    expect(authStatusFor({ id: 'claude', bin: 'claude', auth: 'subscription', envKeys: [], orcaUsageKey: 'claude' }, unknown, {})).toBe('ok')
    expect(authStatusFor({ id: 'claude', bin: 'claude', auth: 'subscription', envKeys: [], orcaUsageKey: 'claude' }, { ...unknown, status: 'unavailable' }, {})).toBe('unknown')
  })

  it('detects binaries on PATH without a shell and reports every unavailability reason', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode']); cleanups.push(bin)
    const env = { PATH: bin }
    expect(findExecutable('claude', env, 'darwin')).toBe(join(bin, 'claude'))
    expect(findExecutable('grok', env, 'darwin')).toBeNull()
    const config = baseConfig()
    const providers = await detectProviders({ providers: providerSpecs(config), accountList: result('account-list'), agentHooks: { claude: 'installed', codex: 'installed' }, env, platform: 'darwin', cooldowns: { opencode: '2999-01-01T00:00:00.000Z' }, now: () => new Date('2026-09-11T12:00:00.000Z') })
    const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]))
    expect(byId['claude']).toMatchObject({ available: true, probe: 'skipped', hookState: 'installed' })
    expect(byId['codex']).toMatchObject({ available: false })
    expect(byId['codex']?.reasons.join(' ')).toContain('usage exhausted')
    expect(byId['opencode']?.reasons.join(' ')).toContain('cooling down')
    expect(byId['grok']?.reasons).toEqual(['binary "grok" not found on PATH'])
    expect(byId['grok']?.auth).toBe('unknown')
  })

  it('runs the optional probe only for otherwise-available providers', async () => {
    const bin = fakeBinDir(['claude']); cleanups.push(bin)
    const runner = fakeRunner({ [`${join(bin, 'claude')} --version`]: { code: 1, stdout: '', stderr: 'broken', timedOut: false, durationMs: 1 } })
    const providers = await detectProviders({ providers: [{ id: 'claude', bin: 'claude', auth: 'none', envKeys: [], orcaUsageKey: 'claude', probe: ['claude', '--version'] }], accountList: {}, agentHooks: {}, env: { PATH: bin }, platform: 'darwin', runner })
    expect(providers[0]).toMatchObject({ available: false, probe: 'failed' })
    expect(providers[0]?.reasons).toEqual(['probe command failed'])
  })

  it('routes each role through tiers in order and falls back when a tier is exhausted', () => {
    const config = baseConfig()
    const availability = (available: readonly string[]): readonly ProviderAvailability[] => ['claude', 'codex', 'opencode', 'grok'].map((id) => ({ id, binary: `/bin/${id}`, hookState: 'unknown', auth: 'ok', usage: { status: 'unknown', error: null, windows: [], exhausted: false, resetsAt: null, hasAuth: null }, probe: 'skipped', coolingDownUntil: null, available: available.includes(id), reasons: available.includes(id) ? [] : ['usage exhausted'] }))
    expect(selectModel(config, 'orchestrator', availability(['codex', 'claude'])).selected).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', tier: 0, orcaAgent: 'codex', tui: 'codex -m gpt-5.6-sol --full-auto' })
    const claudeOnly = selectModel(config, 'orchestrator', availability(['claude']))
    expect(claudeOnly.selected).toMatchObject({ provider: 'claude', model: 'opus', tier: 0 })
    expect(claudeOnly.skipped).toHaveLength(1)
    const tier2 = selectModel(config, 'builder', availability(['opencode', 'grok']))
    expect(tier2.selected).toMatchObject({ provider: 'opencode', model: 'opencode-go/glm-5.3-flash', tier: 1 })
    expect(tier2.skipped.map((skip) => skip.ref.provider)).toEqual(['codex', 'claude'])
    const none = routeAllRoles(config, availability([]))
    expect(none['watcher'].selected).toBeNull()
    expect(none['orchestrator'].skipped).toHaveLength(4)
  })

  it('applies exponential cooldown capped at maxMin and never earlier than a known reset', () => {
    const from = new Date('2026-09-11T12:00:00.000Z')
    expect(cooldownUntil(0, 30, 240, from)).toBe('2026-09-11T12:30:00.000Z')
    expect(cooldownUntil(2, 30, 240, from)).toBe('2026-09-11T14:00:00.000Z')
    expect(cooldownUntil(9, 30, 240, from)).toBe('2026-09-11T16:00:00.000Z')
    expect(cooldownUntil(0, 30, 240, from, '2026-09-12T00:00:00.000Z')).toBe('2026-09-12T00:00:00.000Z')
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-state-')); cleanups.push(dir)
    const first = markProviderExhausted(dir, 'codex', { initialMin: 30, maxMin: 240, reason: 'weekly 100%', now: from })
    const second = markProviderExhausted(dir, 'codex', { initialMin: 30, maxMin: 240, reason: 'still 100%', now: new Date('2026-09-11T12:31:00.000Z') })
    expect(first.attempts).toBe(0)
    expect(second.attempts).toBe(1)
    expect(activeCooldowns(readCooldowns(dir), new Date('2026-09-11T12:32:00.000Z'))).toEqual({ codex: second.until })
    expect(activeCooldowns(readCooldowns(dir), new Date('2026-09-12T12:00:00.000Z'))).toEqual({})
  })
})

describe('machine slots', () => {
  it('reads reclaimable memory from vm_stat and MemAvailable rather than bare free pages', () => {
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      1000.\nPages active:    50000.\nPages inactive:  20000.\nPages speculative: 500.\nPages purgeable: 1500.\n')).toBe((1000 + 20000 + 500 + 1500) * 16384)
    expect(parseVmStat('garbage')).toBeNull()
    expect(parseMemInfo('MemTotal:       32000000 kB\nMemFree:          100000 kB\nMemAvailable:    9000000 kB\n')).toBe(9000000 * 1024)
    expect(parseMemInfo('MemTotal: 1 kB')).toBeNull()
    expect(availableMemoryBytes('freebsd')).toBeGreaterThan(0)
  })

  const sample = (load1PerCpuPercent: number, memoryUsedPercent: number) => ({ at: '2026-01-01T00:00:00.000Z', cpus: 10, load1: 1, load1PerCpuPercent, memoryUsedPercent, rssBytes: 1 })
  const machine = baseConfig().machine
  const gb = 1024 ** 3

  it('scales workers with free RAM, caps under pressure, honours WSL and the floor', () => {
    const relaxed = assessSlots({ machine, running: 1, sample: sample(20, 40), platform: 'darwin', freeBytes: 20 * gb, totalBytes: 32 * gb })
    expect(relaxed).toMatchObject({ ceiling: 5, adaptive: 5, maxAgents: 5, free: 4, wsl: false })
    const tight = assessSlots({ machine, running: 1, sample: sample(20, 40), platform: 'darwin', freeBytes: 5.5 * gb, totalBytes: 32 * gb })
    expect(tight.maxAgents).toBe(2)
    expect(tight.reasons[0]).toContain('free RAM')
    const critical = assessSlots({ machine, running: 3, sample: sample(95, 40), platform: 'darwin', freeBytes: 20 * gb, totalBytes: 32 * gb })
    expect(critical).toMatchObject({ adaptive: 1, maxAgents: 1, free: 0 })
    const wsl = assessSlots({ machine, running: 0, sample: sample(20, 40), platform: 'linux', osRelease: '5.15.0-microsoft-standard-WSL2', freeBytes: 20 * gb, totalBytes: 32 * gb })
    expect(wsl).toMatchObject({ wsl: true, maxAgents: 1 })
    const starved = assessSlots({ machine, running: 0, sample: sample(20, 96), platform: 'darwin', freeBytes: 0.5 * gb, totalBytes: 32 * gb })
    expect(starved).toMatchObject({ maxAgents: 1, free: 1 })
  })
})

describe('loop doctor', () => {
  it('composes Orca, providers, routing, slots, workers and the queue into one report with fixtures', async () => {
    const bin = fakeBinDir(['claude', 'codex', 'opencode', 'grok']); cleanups.push(bin)
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-doctor-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml.replace('person: my-linear-display-name', 'person: person'))
    const runner = fakeRunner()
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin', now: () => new Date('2026-09-11T12:00:00.000Z'), probe: false })
    expect(report.orca).toMatchObject({ version: '1.4.200', status: { runtimeReady: true } })
    expect(report.checks.find((check) => check.id === 'orca.version')).toMatchObject({ status: 'passed' })
    expect(report.checks.find((check) => check.id === 'provider.codex')).toMatchObject({ status: 'warning' })
    expect(report.routing['orchestrator']?.selected).toMatchObject({ provider: 'claude', model: 'opus' })
    expect(report.routing['builder']?.selected?.provider).toBe('claude')
    expect(report.workers.running).toBe(1)
    expect(report.queue.count).toBeGreaterThan(0)
    expect(report.queue.top[0]).toHaveProperty('branchName')
    expect(report.status).toBe('passed')
    expect(runner.calls.every((argv) => argv.every((arg) => !/[;&|`$]/.test(arg)))).toBe(true)
  })

  it('fails when Orca is missing or too old and when no provider can serve a role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-doctor-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    const runner = fakeRunner({ 'orca --version': { code: 0, stdout: '1.3.0', stderr: '', timedOut: false, durationMs: 1 }, 'orca status --json': { code: 1, stdout: '', stderr: 'not running', timedOut: false, durationMs: 1 } })
    const report = await runLoopDoctor({ configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: '/nonexistent' }, platform: 'darwin', probe: false })
    expect(report.status).toBe('failed')
    expect(report.checks.find((check) => check.id === 'orca.version')).toMatchObject({ status: 'failed' })
    expect(report.checks.find((check) => check.id === 'orca.runtime')?.detail).toContain('without a JSON envelope')
    expect(report.checks.filter((check) => check.id.startsWith('routing.')).every((check) => check.status === 'failed')).toBe(true)
  })
})
