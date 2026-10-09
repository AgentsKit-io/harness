import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLoopConfig, precheckTick, runTick } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'
import { splitLines } from '@agentskit/cross-platform'

/**
 * `linear.refill` and `queue.yieldTo` against a fake Orca that keeps a tiny Linear board in memory: `list-issues`
 * answers from it by `--assignee`/`--state`, and `assignee set` writes into it, so what the refill assigns is what the
 * next read sees.
 */
const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace(/\r\n/g, '\n')
const ok = (result: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '', timedOut: false, durationMs: 1 })
const failed = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr, timedOut: false, durationMs: 1 })

interface BoardIssue { readonly identifier: string; state: string; assignee: string | null; readonly labels: readonly string[]; readonly priority: number }
const PEOPLE: Readonly<Record<string, string>> = { person: 'user-id-1', sib: 'user-id-2' }
const issue = (identifier: string, priority: number, extra: Partial<BoardIssue> = {}): BoardIssue => ({ identifier, state: 'Todo', assignee: null, labels: [], priority, ...extra })
const toLinear = (item: BoardIssue) => ({
  id: item.identifier, identifier: item.identifier, title: item.identifier, url: `https://linear.app/x/issue/${item.identifier}`,
  state: { name: item.state, type: 'unstarted' }, assignee: item.assignee ? { id: PEOPLE[item.assignee], displayName: item.assignee } : null,
  labels: item.labels.map((name) => ({ name })), priority: item.priority, priorityLabel: String(item.priority), project: { name: 'Alpha' },
  branchName: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
})

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const makeBoard = (issues: BoardIssue[], options: { readonly failAssign?: readonly string[]; readonly rateLimitAssign?: boolean } = {}) => {
  const calls: string[][] = []
  const runner: CommandRunner & { readonly calls: string[][] } = {
    calls,
    run: async (argv) => {
      calls.push([...argv])
      const key = argv.join(' ')
      const flag = (name: string): string | undefined => argv[argv.indexOf(name) + 1]
      if (key === 'orca --version') return { code: 0, stdout: '1.4.200', stderr: '', timedOut: false, durationMs: 1 }
      if (key.startsWith('orca account list') || key.startsWith('orca agent hooks status')) return ok({})
      if (key.startsWith('orca worktree ps')) return ok({ worktrees: [] })
      if (key.startsWith('orca status')) return ok({})
      if (key.startsWith('orca linear list-issues')) {
        const assignee = flag('--assignee')
        const state = flag('--state')
        return ok({ issues: issues.filter((item) => item.state === state && (assignee === 'null' ? item.assignee === null : item.assignee === assignee)).map(toLinear) })
      }
      if (key.startsWith('orca linear assignee set')) {
        const id = argv[4] as string
        if (options.rateLimitAssign) return failed('Linear API: HTTP 429 Too Many Requests')
        if (options.failAssign?.includes(id)) return failed(`cannot assign ${id}: archived`)
        const person = Object.entries(PEOPLE).find(([, userId]) => userId === flag('--to-id'))?.[0] ?? null
        const target = issues.find((item) => item.identifier === id)
        if (target) target.assignee = person
        return ok({ ok: true })
      }
      return failed(`no fixture for ${key}`)
    },
  }
  return { runner, issues }
}

const writeLoop = (options: { readonly name?: string; readonly person?: string; readonly ownership?: 'person' | 'unassigned'; readonly yieldTo?: readonly string[]; readonly dir?: string } = {}): string => {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'agentskit-refill-'))
  if (!options.dir) cleanups.push(dir)
  mkdirSync(dir, { recursive: true })
  let yaml = exampleYaml.replace('person: my-linear-display-name', `person: ${options.person ?? 'person'}`)
    .replace('my-linear-display-name: <linear-user-id>', Object.entries(PEOPLE).map(([name, id]) => `${name}: ${id}`).join('\n    '))
    .replace('  name: my-project', `  name: ${options.name ?? 'my-project'}`)
  if (options.ownership) yaml = yaml.replace('  queueOwnership: person ', `  queueOwnership: ${options.ownership} `)
  if (options.yieldTo) yaml = yaml.replace('  yieldTo: []', `  yieldTo: [${options.yieldTo.map((path) => JSON.stringify(path)).join(', ')}]`)
  writeFileSync(join(dir, 'loop.config.yaml'), yaml)
  return join(dir, 'loop.config.yaml')
}

const binDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-refill-bin-')); cleanups.push(dir)
  for (const name of ['claude', 'codex', 'opencode', 'grok']) writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return dir
}
const relaxed = { sample: { at: '2026-09-11T12:00:00.000Z', cpus: 10, load1: 1, load1PerCpuPercent: 10, memoryUsedPercent: 40, rssBytes: 1 }, freeBytes: 20 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 }
const options = (runner: CommandRunner, configPath: string, bin: string) => ({ configPath, runner, env: { PATH: bin, XAI_API_KEY: 'k' }, platform: 'darwin' as const, now: () => new Date('2026-09-11T12:00:00.000Z'), machine: relaxed })

/** Rewrites the refill block of a written config: the example ships it disabled, these tests switch it per case. */
const setRefill = (configPath: string, fields: { readonly enabled?: boolean; readonly target?: number; readonly skipLabels?: readonly string[] }): void => {
  const text = readFileSync(configPath, 'utf8')
  const start = text.indexOf('  refill:')
  const end = text.indexOf('\n', text.indexOf('skipLabels:', start))
  const block = `  refill:\n    enabled: ${fields.enabled ?? true}\n    target: ${fields.target ?? 4}\n    skipLabels: [${(fields.skipLabels ?? []).join(', ')}]`
  writeFileSync(configPath, `${text.slice(0, start)}${block}${text.slice(end)}`)
}
const assigned = (runner: { readonly calls: string[][] }): string[] => runner.calls.filter((call) => call.slice(1, 4).join(' ') === 'linear assignee set').map((call) => call[4] as string)
const events = (configPath: string): readonly Record<string, unknown>[] => {
  const path = join(loadLoopConfig(configPath).stateDir, 'events.ndjson')
  try { return splitLines(readFileSync(path, 'utf8')).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) } catch { return [] }
}

describe('linear.refill', () => {
  it('defaults keep the historical behaviour: refill disabled, yieldTo empty', () => {
    const configPath = writeLoop()
    const { config } = loadLoopConfig(configPath)
    expect(config.linear.refill).toEqual({ enabled: false, target: 4, skipLabels: [] })
    expect(config.queue.yieldTo).toEqual([])
  })

  it('assigns exactly target - held unassigned issues, urgent before high before none, skipping skip/exclude labels', async () => {
    const board = makeBoard([
      issue('ENG-1', 2, { assignee: 'person' }),
      issue('ENG-2', 3, { assignee: 'person', state: 'Ready' }),
      issue('ENG-10', 0), issue('ENG-11', 2), issue('ENG-12', 1), issue('ENG-13', 1, { labels: ['QA'] }), issue('ENG-14', 1, { labels: ['blocked'] }), issue('ENG-15', 3),
      issue('ENG-16', 1, { state: 'Backlog' }),
    ])
    const configPath = writeLoop()
    setRefill(configPath, { target: 5, skipLabels: ['QA'] })
    const report = await runTick({ ...options(board.runner, configPath, binDir()), maxDispatch: 0 })
    // held 2 of 5 → three picks: urgent (ENG-12), then high (ENG-11), then medium (ENG-15); none (ENG-10) sorts last.
    expect(assigned(board.runner)).toEqual(['ENG-12', 'ENG-11', 'ENG-15'])
    expect(board.issues.filter((item) => item.assignee === 'person').map((item) => item.identifier).sort()).toEqual(['ENG-1', 'ENG-11', 'ENG-12', 'ENG-15', 'ENG-2'])
    expect(board.runner.calls.find((call) => call[4] === 'ENG-12')).toContain('user-id-1')
    expect(report.notes.some((note) => note.includes('refill: assigned ENG-12, ENG-11, ENG-15 to person (2/5 held before)'))).toBe(true)
    // The refilled issues are in this tick's queue already: the refill ran before the queue read.
    expect(report.queue.candidates).toEqual(expect.arrayContaining(['ENG-11', 'ENG-12', 'ENG-15']))
    expect(events(configPath).find((event) => event['type'] === 'queue.refilled')).toMatchObject({ person: 'person', issues: ['ENG-12', 'ENG-11', 'ENG-15'], held: 2, target: 5 })
  })

  it('does nothing when the person already holds target issues, when disabled, or under unassigned ownership', async () => {
    const full = makeBoard([issue('ENG-1', 2, { assignee: 'person' }), issue('ENG-2', 2, { assignee: 'person' }), issue('ENG-10', 1)])
    const fullPath = writeLoop()
    setRefill(fullPath, { target: 2 })
    await runTick({ ...options(full.runner, fullPath, binDir()), maxDispatch: 0 })
    expect(assigned(full.runner)).toEqual([])
    // Held is counted, then the pool is never even read.
    expect(full.runner.calls.some((call) => call.includes('--assignee') && call[call.indexOf('--assignee') + 1] === 'null')).toBe(false)

    const disabled = makeBoard([issue('ENG-10', 1)])
    await runTick({ ...options(disabled.runner, writeLoop(), binDir()), maxDispatch: 0 })
    expect(assigned(disabled.runner)).toEqual([])

    const pooled = makeBoard([issue('ENG-10', 1)])
    const pooledPath = writeLoop({ ownership: 'unassigned' })
    setRefill(pooledPath, { target: 4 })
    await runTick({ ...options(pooled.runner, pooledPath, binDir()), maxDispatch: 0 })
    expect(assigned(pooled.runner)).toEqual([])
  })

  it('a dry run assigns nothing and reports what it would assign', async () => {
    const board = makeBoard([issue('ENG-10', 2), issue('ENG-11', 1), issue('ENG-12', 3)])
    const configPath = writeLoop()
    setRefill(configPath, { target: 2 })
    const report = await runTick({ ...options(board.runner, configPath, binDir()), dryRun: true })
    expect(assigned(board.runner)).toEqual([])
    expect(report.notes).toContain('dry-run: refill would assign ENG-11, ENG-10 to person (0/2 held)')
    expect(events(configPath).some((event) => event['type'] === 'queue.refilled')).toBe(false)
  })

  it('an assignment failure is a note and the tick goes on', async () => {
    const board = makeBoard([issue('ENG-10', 1), issue('ENG-11', 2), issue('ENG-12', 3)], { failAssign: ['ENG-10'] })
    const configPath = writeLoop()
    setRefill(configPath, { target: 2 })
    const report = await runTick({ ...options(board.runner, configPath, binDir()), maxDispatch: 0 })
    expect(assigned(board.runner)).toEqual(['ENG-10', 'ENG-11'])
    expect(report.status).not.toBe('failed')
    expect(report.notes.some((note) => note.startsWith('refill: assigning ENG-10 to person failed'))).toBe(true)
    expect(report.notes.some((note) => note.includes('refill: assigned ENG-11 to person'))).toBe(true)
    expect(report.queue.candidates).toEqual(['ENG-11'])
  })

  it('a rate-limited assignment stops the refill and the tick waits out the tracker cooldown', async () => {
    const board = makeBoard([issue('ENG-10', 1), issue('ENG-11', 2)], { rateLimitAssign: true })
    const configPath = writeLoop()
    setRefill(configPath, { target: 2 })
    const report = await runTick({ ...options(board.runner, configPath, binDir()), maxDispatch: 0 })
    expect(assigned(board.runner)).toEqual(['ENG-10'])
    expect(report.status).toBe('blocked')
    expect(report.notes.some((note) => note.startsWith('refill: assigning ENG-10 to person failed'))).toBe(true)
  })

  it('an idle person loop prechecks as having work when its refill has something to assign', async () => {
    const board = makeBoard([issue('ENG-10', 1)])
    const configPath = writeLoop()
    setRefill(configPath, { target: 2 })
    const precheck = await precheckTick(options(board.runner, configPath, binDir()))
    expect(precheck).toMatchObject({ work: true, reason: 'refill would assign 1 issue(s) to person (0/2 held)' })
    expect(assigned(board.runner)).toEqual([])
    // Asked on a sibling's behalf, the pending refill is not work.
    expect((await precheckTick({ ...options(board.runner, configPath, binDir()), includeRefill: false })).work).toBe(false)
  })
})

describe('queue.yieldTo', () => {
  const siblings = (siblingIssues: BoardIssue[], yieldTo?: (siblingPath: string) => readonly string[]) => {
    const root = mkdtempSync(join(tmpdir(), 'agentskit-yield-')); cleanups.push(root)
    const siblingPath = writeLoop({ dir: join(root, 'law-os'), name: 'law-os', person: 'sib' })
    const board = makeBoard([issue('ENG-1', 2, { assignee: 'person' }), ...siblingIssues])
    const mainPath = writeLoop({ dir: join(root, 'design-system'), name: 'design-system', yieldTo: yieldTo ? yieldTo(siblingPath) : ['../law-os/loop.config.yaml'] })
    return { board, mainPath, siblingPath }
  }

  it('yields when the sibling has dispatchable work: nothing new is dispatched and the tick is ok', async () => {
    const { board, mainPath } = siblings([issue('ENG-20', 1, { assignee: 'sib' }), issue('ENG-21', 2, { assignee: 'sib' })])
    const report = await runTick(options(board.runner, mainPath, binDir()))
    expect(report.status).toBe('ok')
    expect(report.results).toEqual([])
    expect(report.notes).toContain('yielding to law-os: 2 dispatchable issue(s); nothing new dispatched')
    expect(board.runner.calls.some((call) => call.slice(0, 3).join(' ') === 'orca worktree create' || call[0] === 'claude' || call[0] === 'codex')).toBe(false)
    expect(events(mainPath).find((event) => event['type'] === 'queue.yielded')).toMatchObject({ to: 'law-os', candidates: 2 })
    // Its own precheck says the same, so the scheduler does not start a worker for it.
    expect(await precheckTick(options(board.runner, mainPath, binDir()))).toMatchObject({ work: false, reason: 'yielding to law-os: 2 dispatchable issue(s)' })
  })

  it('does not yield when the sibling has nothing to dispatch (an absolute path works too)', async () => {
    const { board, mainPath } = siblings([issue('ENG-20', 1)], (siblingPath) => [siblingPath])
    const report = await runTick({ ...options(board.runner, mainPath, binDir()), maxDispatch: 0 })
    expect(report.notes.some((note) => note.includes('yielding'))).toBe(false)
    expect(report.queue.candidates).toEqual(['ENG-1'])
    expect((await precheckTick(options(board.runner, mainPath, binDir()))).work).toBe(true)
  })

  it('fails open, with a note, when the sibling config is missing or invalid', async () => {
    const { board, mainPath, siblingPath } = siblings([issue('ENG-20', 1, { assignee: 'sib' })], () => ['../nowhere/loop.config.yaml', '../law-os/loop.config.yaml'])
    writeFileSync(siblingPath, 'schemaVersion: 1\nproject: {}\n')
    const report = await runTick({ ...options(board.runner, mainPath, binDir()), maxDispatch: 0 })
    expect(report.status).not.toBe('failed')
    expect(report.notes.some((note) => note.startsWith('yieldTo ../nowhere/loop.config.yaml: could not evaluate'))).toBe(true)
    expect(report.notes.some((note) => note.startsWith('yieldTo ../law-os/loop.config.yaml: could not evaluate'))).toBe(true)
    expect(report.notes.some((note) => note.startsWith('yielding to'))).toBe(false)
    const precheck = await precheckTick(options(board.runner, mainPath, binDir()))
    expect(precheck.work).toBe(true)
    expect(precheck.notes?.length).toBe(2)
  })

  it('a yield cycle is cut instead of followed', async () => {
    const { board, mainPath, siblingPath } = siblings([issue('ENG-20', 1, { assignee: 'sib' })])
    writeFileSync(siblingPath, readFileSync(siblingPath, 'utf8').replace('  yieldTo: []', '  yieldTo: ["../design-system/loop.config.yaml"]'))
    // law-os would yield back to design-system, which has work — but design-system is the one asking, so law-os's
    // own answer stands and design-system yields to it.
    const report = await runTick(options(board.runner, mainPath, binDir()))
    expect(report.notes).toContain('yielding to law-os: 1 dispatchable issue(s); nothing new dispatched')
  })
})
