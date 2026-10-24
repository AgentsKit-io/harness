import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTRACT_CLOSE, CONTRACT_OPEN, loadLoopConfig, readDispatchRecord, readDeliveryState, runLoopDoctor, runDeliver, runTick } from '../src/index.js'
import type { CommandResult, CommandRunner, TaskContract } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace(/\r\n/g, '\n').replace('person: my-linear-display-name', 'person: person').replace('my-linear-display-name: <linear-user-id>', 'person: user-id-1')
const contract: TaskContract = { intent: 'Add the demo binding', scope: { inScope: ['binding'], outOfScope: ['ui'] }, outcomes: [{ id: 'o1', description: 'tests pass', check: { kind: 'test', command: 'pnpm --filter demo test' } }], ambiguities: [], touchpoints: ['packages/demo'], risks: [] }

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const done = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false, durationMs: 1 })
const REPO = 'my-org/my-project'
const issueJson = { number: 1, url: `https://github.com/${REPO}/issues/1`, title: 'Demo issue', state: 'OPEN', labels: [], assignees: [], createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z' }

/** GitHub tracker + fleet runner, with a fake `gh`, `fleet` and `git`; any `orca` call is recorded and answers "not installed". */
const makeFleetEnv = (options: { readonly runner?: 'fleet' | 'orca'; readonly taskState?: () => string; readonly fleetDoctor?: CommandResult; readonly quickDoctor?: boolean; readonly fleetQueue?: CommandResult; readonly commits?: number } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-fleet-dispatch-')); cleanups.push(dir)
  const bin = mkdtempSync(join(tmpdir(), 'agentskit-fleet-dispatch-bin-')); cleanups.push(bin)
  for (const name of ['claude', 'codex', 'opencode', 'grok']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const yaml = exampleYaml.replace('# connectors:\n#   tracker: linear', 'connectors:\n  tracker: github').replace('  queueOwnership: person ', '  queueOwnership: unassigned ')
  writeFileSync(join(dir, 'loop.config.yaml'), yaml)
  if ((options.runner ?? 'fleet') === 'fleet') writeFileSync(join(dir, 'loop.config.local.yaml'), `connectors:\n  runner: fleet\n  fleet:\n    project: ${REPO}\n`)
  // The GitHub queue only lists issues carrying the lifecycle "todo" label.
  const issue = { ...issueJson, labels: [{ name: loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' }).config.github.issues.labels.todo }] }
  const calls: string[][] = []
  const prompts: string[] = []
  let queueId: string | null = null
  const prs: Record<string, unknown>[] = []
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push([...argv])
      const [bin0, verb, sub] = argv
      if (bin0 === 'orca') return { code: 127, stdout: '', stderr: 'orca: not installed', timedOut: false, durationMs: 1 }
      if (bin0 === 'fleet') {
        if (verb === 'submit') { prompts.push(readFileSync(argv[argv.indexOf('--prompt-file') + 1] ?? '', 'utf8')); queueId = 'q-0001'; return done('submitted q-0001\n') }
        if (verb === 'queue') return options.fleetQueue ?? done(JSON.stringify(queueId ? [{ id: queueId, state: options.taskState?.() ?? 'running', hostTaskId: 'ht-77' }] : []))
        if (verb === 'collect') return done(JSON.stringify({ ref: 'refs/remotes/fleet/h1/ht-77', headSha: 'a1b2c3d4e5f6', baseSha: 'b0b0b0b', commits: options.commits ?? 1 }))
        if (verb === 'doctor' && sub === '--help') return done(options.quickDoctor ? 'Usage: fleet doctor [--quick] [--json]\n' : 'Usage: fleet doctor [--json]\n')
        if (verb === 'doctor') return options.fleetDoctor ?? done(JSON.stringify({ status: 'ok', checks: [{ id: 'coordinator', ok: true }, { id: 'hosts', ok: true }] }))
        return done()
      }
      if (bin0 === 'gh') {
        if (verb === 'api' && sub === 'user') return done(JSON.stringify({ login: 'person' }))
        if (verb === 'api') return done('')
        if (verb === 'auth') return done('token\n')
        if (verb === 'issue' && sub === 'list') return done(JSON.stringify([issue]))
        if (verb === 'issue' && sub === 'view') return done(JSON.stringify({ ...issue, body: 'Add the binding.\n\n## Acceptance\n- tests pass', comments: [] }))
        if (verb === 'pr' && sub === 'create') { prs.push({ number: 7, url: `https://github.com/${REPO}/pull/7`, title: argv[argv.indexOf('--title') + 1], state: 'OPEN', headRefName: argv[argv.indexOf('--head') + 1], headRefOid: 'abc123', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [], files: [], statusCheckRollup: [], updatedAt: '2026-10-20T11:00:00Z' }); return done(`https://github.com/${REPO}/pull/7\n`) }
        if (verb === 'pr' && sub === 'list') return done(JSON.stringify(prs))
        return done()
      }
      if (bin0 === 'claude' && verb === '-p') return done(`thinking…\n${CONTRACT_OPEN}\n${JSON.stringify(contract)}\n${CONTRACT_CLOSE}\n`)
      if (bin0 === 'git') return done(verb === 'rev-parse' ? 'basesha\n' : '')
      return { code: 127, stdout: '', stderr: `no fixture for ${argv.join(' ')}`, timedOut: false, durationMs: 1 }
    },
  }
  const machine = { sample: { at: '2026-10-20T12:00:00.000Z', cpus: 10, load1: 1, load1PerCpuPercent: 10, memoryUsedPercent: 40, rssBytes: 1 }, freeBytes: 20 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 }
  const base = { configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k', AK_HARNESS_NO_GLOBAL: '1' }, platform: 'linux' as const, now: () => new Date('2026-10-20T12:00:00.000Z'), machine }
  return { dir, calls, prompts, prs, base, loaded: () => loadLoopConfig(base.configPath, { AK_HARNESS_NO_GLOBAL: '1' }) }
}

const orcaCalls = (calls: readonly string[][]) => calls.filter((argv) => argv[0] === 'orca')

describe('runner: fleet dispatches through the fleet', () => {
  it('a dry run plans fleet submit, never Orca, and calls no model', async () => {
    const env = makeFleetEnv()
    const report = await runTick({ ...env.base, dryRun: true, onlyIssue: '1' })
    const [result] = report.results
    expect(result).toMatchObject({ issue: `${REPO}#1`, outcome: 'dry-run' })
    expect(result?.argv?.slice(0, 2)).toEqual(['fleet', 'submit'])
    expect(result?.argv).toContain('github:my-org/my-project')
    expect(result?.reason).toMatch(/fleet queue/)
    expect(orcaCalls(env.calls)).toEqual([])
    // No contract cached and none generated: a dry run must not spend model quota.
    expect(env.calls.filter((argv) => argv[0] === 'claude' || argv[0] === 'codex' || argv[0] === 'opencode' || argv[0] === 'grok')).toEqual([])
    expect(env.calls.some((argv) => argv[0] === 'fleet' && argv[1] === 'submit')).toBe(false)
  })

  it('a real tick creates the workspace, submits the brief through fleet submit, and never calls Orca', async () => {
    const env = makeFleetEnv()
    const report = await runTick({ ...env.base, maxDispatch: 1, onlyIssue: '#1' })
    expect(report.results[0]).toMatchObject({ issue: `${REPO}#1`, outcome: 'dispatched' })
    expect(orcaCalls(env.calls)).toEqual([])
    const submits = env.calls.filter((argv) => argv[0] === 'fleet' && argv[1] === 'submit')
    expect(submits).toHaveLength(1)
    expect(submits[0]).toEqual(expect.arrayContaining(['--project', 'github:my-org/my-project', '--base', 'main']))
    // The brief is the prompt (through a file, never argv), and tells a non-interactive worker not to push or open a PR.
    expect(submits[0]?.join(' ')).not.toContain('Demo issue')
    expect(env.prompts[0]).toContain('Demo issue')
    expect(env.prompts[0]).toContain('do NOT push and do NOT open a pull request')
    const record = readDispatchRecord(env.loaded().stateDir, `${REPO}#1`)
    expect(record).toMatchObject({ runner: 'fleet', terminal: record?.worktreeId })
    expect(record?.worktreePath).toBeUndefined()
  })

  it('deliver observes the task, then collects the branch and opens the PR as the harness', async () => {
    let task = 'running'
    const env = makeFleetEnv({ taskState: () => task })
    await runTick({ ...env.base, maxDispatch: 1 })
    const { stateDir } = env.loaded()
    const record = readDispatchRecord(stateDir, `${REPO}#1`)
    expect(record).not.toBeNull()

    const waiting = await runDeliver({ ...env.base })
    expect(waiting.results[0]).toMatchObject({ outcome: 'waiting', reason: 'fleet task running' })
    expect(env.calls.some((argv) => argv[0] === 'fleet' && argv[1] === 'collect')).toBe(false)

    task = 'done'
    const delivered = await runDeliver({ ...env.base })
    const collect = env.calls.find((argv) => argv[0] === 'fleet' && argv[1] === 'collect')
    // `fleet collect` takes the host task id the queue reports, not the harness-side workspace id.
    expect(collect).toEqual(['fleet', 'collect', 'ht-77', '--json'])
    // The harness's own branch is moved to `head` (a safe ref name, no `#`), then pushed.
    expect(record?.branch).not.toMatch(/#/)
    expect(env.calls).toContainEqual(['git', '-C', expect.any(String), 'branch', '-f', record?.branch, 'a1b2c3d4e5f6'])
    const push = env.calls.find((argv) => argv[0] === 'git' && argv.includes('push'))
    expect(push).toEqual(['git', 'push', '-u', 'origin', `refs/heads/${record?.branch}:refs/heads/${record?.branch}`])
    const create = env.calls.find((argv) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'create')
    expect(create).toEqual(expect.arrayContaining(['--repo', REPO, '--head', record?.branch ?? '', '--base', 'main']))
    expect(create?.[create.indexOf('--body') + 1]).toContain(`Loop-Contract: ${record?.contractDigest}`)
    expect(delivered.results[0]).toMatchObject({ outcome: 'waiting', pr: 7 })
    expect(orcaCalls(env.calls)).toEqual([])
  })

  it('deliver opens no PR for a done task that made no commits', async () => {
    let task = 'running'
    const env = makeFleetEnv({ taskState: () => task, commits: 0 })
    await runTick({ ...env.base, maxDispatch: 1 })
    task = 'done'
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ outcome: 'stuck', reason: expect.stringMatching(/no commits/) })
    expect(env.calls.some((argv) => argv[0] === 'git' && argv.includes('push'))).toBe(false)
    expect(env.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'create')).toBe(false)
  })

  it('deliver escalates a task that failed instead of collecting', async () => {
    let task = 'running'
    const env = makeFleetEnv({ taskState: () => task })
    await runTick({ ...env.base, maxDispatch: 1 })
    task = 'failed'
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ outcome: 'stuck' })
    expect(env.calls.some((argv) => argv[0] === 'fleet' && argv[1] === 'collect')).toBe(false)
    expect(readDeliveryState(env.loaded().stateDir, `${REPO}#1`).finalOutcome).toBe('stuck')
    expect(orcaCalls(env.calls)).toEqual([])
  })
})

describe('loop doctor probes the selected runner', () => {
  it('fleet: checks fleet doctor and fleet queue, and does not ask Orca', async () => {
    const env = makeFleetEnv()
    const report = await runLoopDoctor({ configPath: env.base.configPath, runner: env.base.runner, env: env.base.env, platform: 'linux' })
    const byId = new Map(report.checks.map((check) => [check.id, check]))
    expect(byId.get('fleet.doctor')).toMatchObject({ status: 'passed', detail: expect.stringContaining('2/2 checks ok') })
    expect(byId.get('fleet.queue')).toMatchObject({ status: 'passed' })
    expect([...byId.keys()].some((id) => id.startsWith('orca.'))).toBe(false)
    expect(orcaCalls(env.calls)).toEqual([])
  })

  it('fleet: a failing fleet doctor or an unreachable queue fails the report', async () => {
    const env = makeFleetEnv({ fleetDoctor: done(JSON.stringify({ status: 'failed', checks: [{ id: 'hosts', ok: false }] })), fleetQueue: { code: 1, stdout: '', stderr: 'coordinator down', timedOut: false, durationMs: 1 } })
    const report = await runLoopDoctor({ configPath: env.base.configPath, runner: env.base.runner, env: env.base.env, platform: 'linux' })
    expect(report.status).toBe('failed')
    expect(report.checks.find((check) => check.id === 'fleet.doctor')).toMatchObject({ status: 'failed', detail: expect.stringContaining('hosts') })
    expect(report.checks.find((check) => check.id === 'fleet.queue')).toMatchObject({ status: 'failed', detail: expect.stringContaining('coordinator down') })
  })

  const doctorReport = (env: ReturnType<typeof makeFleetEnv>) => runLoopDoctor({ configPath: env.base.configPath, runner: env.base.runner, env: env.base.env, platform: 'linux' })
  const doctorCall = (env: ReturnType<typeof makeFleetEnv>) => env.calls.find((argv) => argv[0] === 'fleet' && argv[1] === 'doctor' && argv[2] !== '--help')

  it('fleet: uses the quick doctor when the CLI has it, else the full doctor', async () => {
    const quick = makeFleetEnv({ quickDoctor: true })
    await doctorReport(quick)
    expect(doctorCall(quick)).toEqual(['fleet', 'doctor', '--quick', '--json'])
    const full = makeFleetEnv()
    await doctorReport(full)
    expect(doctorCall(full)).toEqual(['fleet', 'doctor', '--json'])
  })

  it('fleet: an identity-alias or disk failure is a warning with its detail, not a failure', async () => {
    const env = makeFleetEnv({ fleetDoctor: done(JSON.stringify({ status: 'failed', checks: [{ id: 'hosts', ok: true }, { id: 'identity-aliases', ok: false, detail: 'alias mismatch' }, { id: 'disk', status: 'fail', message: 'low' }] })) })
    const check = (await doctorReport(env)).checks.find((item) => item.id === 'fleet.doctor')
    expect(check).toMatchObject({ status: 'warning', detail: expect.stringContaining('identity-aliases (alias mismatch)') })
    expect(check?.detail).toContain('disk (low)')
  })

  it('fleet: a quick doctor that exits 3 with only collector and slow-check failures is a warning', async () => {
    const stdout = JSON.stringify({ status: 'failed', checks: [{ id: 'hosts', ok: true }, { id: 'project-in-fleet-file', ok: true }, { id: 'metrics-collector', ok: false, detail: 'no samples' }, { id: 'disk-usage', status: 'fail', message: 'slow' }] })
    const env = makeFleetEnv({ quickDoctor: true, fleetDoctor: { code: 3, stdout, stderr: 'fleet: FLEET_DOCTOR_FAILED: at least one check failed', timedOut: false, durationMs: 1 } })
    const check = (await doctorReport(env)).checks.find((item) => item.id === 'fleet.doctor')
    expect(check).toMatchObject({ status: 'warning', detail: expect.stringContaining('metrics-collector (no samples)') })
    expect(check?.detail).toContain('exit 3')
  })

  it('fleet: a non-zero doctor exit still blocks on a failing host check, or when it prints no JSON', async () => {
    const host = makeFleetEnv({ fleetDoctor: { code: 3, stdout: JSON.stringify({ checks: [{ id: 'hosts', ok: false }] }), stderr: '', timedOut: false, durationMs: 1 } })
    expect((await doctorReport(host)).checks.find((item) => item.id === 'fleet.doctor')).toMatchObject({ status: 'failed', detail: expect.stringContaining('blocking: hosts') })
    const bare = makeFleetEnv({ fleetDoctor: { code: 3, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 } })
    expect((await doctorReport(bare)).checks.find((item) => item.id === 'fleet.doctor')).toMatchObject({ status: 'failed', detail: expect.stringContaining('exited 3') })
  })

  it('fleet: a missing agents host or project blocks, and a doctor that times out fails', async () => {
    const project = makeFleetEnv({ fleetDoctor: done(JSON.stringify({ checks: [{ id: 'project-in-fleet-file', ok: false, detail: 'not listed' }] })) })
    expect((await doctorReport(project)).checks.find((item) => item.id === 'fleet.doctor')).toMatchObject({ status: 'failed', detail: expect.stringContaining('blocking: project-in-fleet-file (not listed)') })
    const slow = makeFleetEnv({ fleetDoctor: { code: null, stdout: '', stderr: '', timedOut: true, durationMs: 90_000 } })
    expect((await doctorReport(slow)).checks.find((item) => item.id === 'fleet.doctor')).toMatchObject({ status: 'failed', detail: expect.stringContaining('timed out') })
  })
})

describe('tick --issue', () => {
  it.each(['1', '#1', `${REPO}#1`, `https://github.com/${REPO}/issues/1`])('accepts %s for the GitHub tracker', async (form) => {
    const env = makeFleetEnv()
    const report = await runTick({ ...env.base, dryRun: true, onlyIssue: form })
    expect(report.queue.candidates).toEqual([`${REPO}#1`])
    expect(report.results[0]).toMatchObject({ issue: `${REPO}#1`, outcome: 'dry-run' })
  })

  it('errors when it matches no issue, or names another repository', async () => {
    const env = makeFleetEnv()
    await expect(runTick({ ...env.base, dryRun: true, onlyIssue: '99' })).rejects.toThrow(/matches no issue/)
    await expect(runTick({ ...env.base, dryRun: true, onlyIssue: 'other-org/other#1' })).rejects.toThrow(/other-org\/other/)
    await expect(runTick({ ...env.base, dryRun: true, onlyIssue: 'not-an-issue' })).rejects.toThrow(/Invalid GitHub issue identifier/)
  })
})
