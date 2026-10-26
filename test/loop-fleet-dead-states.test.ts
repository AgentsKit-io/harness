import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTRACT_CLOSE, CONTRACT_OPEN, loadLoopConfig, readDeliveryState, runDeliver, runTick } from '../src/index.js'
import type { CommandResult, CommandRunner, TaskContract } from '../src/index.js'
import { readRetries } from '../src/loop/deliver-state.js'

/**
 * 2026-10-26: the conveyor stood still — 0 todo, 14 blocked, 7 in progress for up to 14 h, 10 free fleet slots. These
 * are the dead states it hit, each with a way out: a fake GitHub tracker (labels and assignees kept as `gh` edits
 * them) and a fake fleet (each task's queue state, failure reason and `collect --json` answer are the test's to set).
 */

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace(/\r\n/g, '\n').replace('person: my-linear-display-name', 'person: person').replace('my-linear-display-name: <linear-user-id>', 'person: user-id-1')
const contract: TaskContract = { intent: 'Add the demo binding', scope: { inScope: ['binding'], outOfScope: ['ui'] }, outcomes: [{ id: 'o1', description: 'tests pass', check: { kind: 'test', command: 'pnpm --filter demo test' } }], ambiguities: [], touchpoints: ['packages/demo'], risks: [] }

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const done = (stdout = '', code = 0): CommandResult => ({ code, stdout, stderr: '', timedOut: false, durationMs: 1 })
const REPO = 'my-org/my-project'
const ISSUE = `${REPO}#1`
const TODO = 'loop:todo'
const IN_PROGRESS = 'loop:in-progress'
const BLOCKED = 'loop:blocked'

interface Task { state: string; reason?: string; collect?: Record<string, unknown> }

const makeEnv = (initialLabels: readonly string[] = [TODO]) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-dead-states-')); cleanups.push(dir)
  const bin = mkdtempSync(join(tmpdir(), 'agentskit-dead-states-bin-')); cleanups.push(bin)
  for (const name of ['claude', 'codex', 'opencode', 'grok']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const yaml = exampleYaml.replace('# connectors:\n#   tracker: linear', 'connectors:\n  tracker: github').replace('  queueOwnership: person ', '  queueOwnership: unassigned ')
  writeFileSync(join(dir, 'loop.config.yaml'), yaml)
  writeFileSync(join(dir, 'loop.config.local.yaml'), `connectors:\n  runner: fleet\n  fleet:\n    project: ${REPO}\n`)
  const issue = { number: 1, url: `https://github.com/${REPO}/issues/1`, title: 'Demo issue', state: 'OPEN', labels: [...initialLabels], assignees: [] as string[], createdAt: '2026-10-20T08:00:00Z', updatedAt: '2026-10-20T08:00:00Z' }
  const issueJson = () => ({ ...issue, labels: issue.labels.map((name) => ({ name })), assignees: issue.assignees.map((login) => ({ login })) })
  const calls: string[][] = []
  const submits: { readonly base: string; readonly prompt: string }[] = []
  const tasks = new Map<string, Task>()
  const prs: Record<string, unknown>[] = []
  const comments: string[] = []
  let clock = new Date('2026-10-20T12:00:00.000Z')
  const values = (argv: readonly string[], flag: string) => argv.flatMap((arg, index) => arg === flag ? [argv[index + 1] ?? ''] : [])
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push([...argv])
      const [bin0, verb, sub] = argv
      if (bin0 === 'orca') return { code: 127, stdout: '', stderr: 'orca: not installed', timedOut: false, durationMs: 1 }
      if (bin0 === 'fleet') {
        if (verb === 'submit') { submits.push({ base: argv[argv.indexOf('--base') + 1] ?? '', prompt: readFileSync(argv[argv.indexOf('--prompt-file') + 1] ?? '', 'utf8') }); const id = `q-000${submits.length}`; tasks.set(id, { state: 'running' }); return done(`submitted ${id}\n`) }
        if (verb === 'queue') return done(JSON.stringify([...tasks].map(([id, task]) => ({ id, state: task.state, hostTaskId: `ht-${id.slice(-1)}`, ...(task.reason ? { reason: task.reason } : {}) }))))
        if (verb === 'collect') {
          const task = tasks.get(`q-000${String(argv[2]).slice(-1)}`)
          return done(JSON.stringify(task?.collect ?? { ref: `refs/remotes/fleet/h1/${argv[2]}`, headSha: 'c0ffee123456', baseSha: 'b0b0b0b', commits: 1 }))
        }
        return done()
      }
      if (bin0 === 'gh') {
        if (verb === 'api' && sub === 'user') return done(JSON.stringify({ login: 'person' }))
        if (verb === 'api') return done('')
        if (verb === 'auth') return done('token\n')
        if (verb === 'label' && sub === 'list') return done('[]')
        if (verb === 'issue' && sub === 'list') return done(JSON.stringify([issueJson()]))
        if (verb === 'issue' && sub === 'view') return done(JSON.stringify({ ...issueJson(), body: 'Add the binding.\n\n## Acceptance\n- tests pass', comments: [] }))
        if (verb === 'issue' && sub === 'edit') {
          issue.labels = [...issue.labels.filter((label) => !values(argv, '--remove-label').includes(label)), ...values(argv, '--add-label').filter((label) => !issue.labels.includes(label))]
          issue.assignees = [...issue.assignees.filter((login) => !values(argv, '--remove-assignee').includes(login)), ...values(argv, '--add-assignee')]
          return done()
        }
        if (verb === 'issue' && sub === 'comment') { comments.push(argv[argv.indexOf('--body') + 1] ?? ''); return done() }
        if (verb === 'pr' && sub === 'create') {
          prs.push({ number: 7, url: `https://github.com/${REPO}/pull/7`, title: 'Demo', state: 'OPEN', isDraft: argv.includes('--draft'), headRefName: argv[argv.indexOf('--head') + 1], headRefOid: 'a1b2c3d4e5f6', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: values(argv, '--label').map((name) => ({ name })), files: [], statusCheckRollup: [], updatedAt: '2026-10-20T11:00:00Z' })
          return done(`https://github.com/${REPO}/pull/7\n`)
        }
        if (verb === 'pr' && sub === 'ready') { prs[0]!['isDraft'] = false; return done() }
        if (verb === 'pr' && sub === 'edit') { prs[0]!['labels'] = []; return done() }
        if (verb === 'pr' && (sub === 'list' || sub === 'view')) return done(JSON.stringify(sub === 'view' ? prs[0] : prs))
        return done()
      }
      if (bin0 === 'claude' && verb === '-p') return done(`thinking…\n${CONTRACT_OPEN}\n${JSON.stringify(contract)}\n${CONTRACT_CLOSE}\n`)
      if (bin0 === 'git') {
        if (argv.includes('merge-tree')) return done('0123abc\nsrc/a.ts\n\nCONFLICT (content): ...\n', 1)
        return done(verb === 'rev-parse' ? 'basesha\n' : '')
      }
      return { code: 127, stdout: '', stderr: `no fixture for ${argv.join(' ')}`, timedOut: false, durationMs: 1 }
    },
  }
  const machine = { sample: { at: '2026-10-20T12:00:00.000Z', cpus: 10, load1: 1, load1PerCpuPercent: 10, memoryUsedPercent: 40, rssBytes: 1 }, freeBytes: 20 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 }
  const base = { configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k', AK_HARNESS_NO_GLOBAL: '1' }, platform: 'linux' as const, now: () => clock, machine }
  const loaded = () => loadLoopConfig(base.configPath, { AK_HARNESS_NO_GLOBAL: '1' })
  const latest = () => `q-000${submits.length}`
  /** Dispatch the issue and let the latest fleet task end as `task` says. */
  const dispatch = async (task?: Task) => {
    expect((await runTick({ ...base, maxDispatch: 1 })).results[0]).toMatchObject({ outcome: 'dispatched' })
    expect(issue.labels).toEqual([IN_PROGRESS])
    if (task) tasks.set(latest(), task)
  }
  const advance = (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000) }
  const pushes = () => calls.filter((argv) => argv[0] === 'git' && argv.includes('push') && !argv.includes('-u'))
  return { calls, submits, tasks, prs, issue, comments, base, loaded, dispatch, advance, latest, pushes }
}

describe('no dead states: a worker that ends with nothing to deliver goes back to Todo', () => {
  it('a stuck worker (fleet task failed before a PR) is labelled loop:todo, not loop:blocked, and counted', async () => {
    const env = makeEnv()
    await env.dispatch({ state: 'failed', reason: 'agent exited 1' })
    const report = await runDeliver({ ...env.base })
    expect(report.results).toEqual([expect.objectContaining({ issue: ISSUE, outcome: 'restarted', reason: expect.stringMatching(/fleet task ended failed \(agent exited 1\).*returned to Todo \(automatic retry 1\/2\)/) })])
    expect(env.issue.labels).toEqual([TODO])
    expect(env.issue.assignees).toEqual([])
    expect(env.comments.at(-1)).toMatch(/worker stuck — returned to Todo/)
    const { stateDir } = env.loaded()
    expect(readRetries(stateDir, ISSUE, 'stuck', new Date('2026-10-20T12:00:00.000Z'))).toHaveLength(1)
    expect(readDeliveryState(stateDir, ISSUE)).toMatchObject({ finalOutcome: 'restarted' })
    // Nothing holds it: the next tick dispatches it again.
    await env.dispatch()
    expect(env.submits).toHaveLength(2)
  })

  it('the 3rd stuck dispatch in 24 h is a real block, with the 3 reasons', async () => {
    const env = makeEnv()
    for (const [attempt, reason] of [[1, 'agent exited 1'], [2, 'agent exited 2']] as const) {
      await env.dispatch({ state: 'failed', reason })
      expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'restarted', reason: expect.stringMatching(new RegExp(`automatic retry ${attempt}/2`)) })
      env.advance(60)
    }
    await env.dispatch({ state: 'cancelled' })
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ outcome: 'blocked', reason: expect.stringMatching(/worker stuck 3 times in 24 h/) })
    expect(env.issue.labels).toEqual([BLOCKED])
    const block = env.comments.at(-1) ?? ''
    expect(block).toContain('agent exited 1')
    expect(block).toContain('agent exited 2')
    expect(block).toContain('fleet task ended cancelled')
    expect(readDeliveryState(env.loaded().stateDir, ISSUE).finalOutcome).toBe('blocked')
  })

  it('stuck dispatches older than 24 h do not count toward the block', async () => {
    const env = makeEnv()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await env.dispatch({ state: 'failed' })
      expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'restarted' })
      env.advance(13 * 60)
    }
  })
})

describe('no dead states: collect', () => {
  it('a done task whose collect has an empty ref is not a transient error: the issue goes back to Todo', async () => {
    const env = makeEnv()
    await env.dispatch({ state: 'done', collect: { ref: '', headSha: 'a1b2c3d4e5f6', commits: 1 } })
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ outcome: 'restarted', reason: expect.stringMatching(/no commits/) })
    expect(env.issue.labels).toEqual([TODO])
    expect(readDeliveryState(env.loaded().stateDir, ISSUE).finalOutcome).toBe('restarted')
    expect(env.calls.some((argv) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'create')).toBe(false)
  })

  it('an incomplete task with a WIP commit opens a draft PR labelled loop:wip and dispatches a continuation, then makes it ready', async () => {
    const env = makeEnv()
    await env.dispatch({ state: 'done', collect: { ref: 'refs/remotes/fleet/h1/ht-1', headSha: 'a1b2c3d4e5f6', baseSha: 'b0b0b0b', commits: 1, status: 'incomplete' } })
    const report = await runDeliver({ ...env.base })
    const create = env.calls.find((argv) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'create') ?? []
    expect(create).toEqual(expect.arrayContaining(['--draft', '--label', 'loop:wip']))
    expect(report.results[0]).toMatchObject({ outcome: 'fix-round', pr: 7, reason: expect.stringMatching(/stopped before finishing/) })
    expect(env.submits).toHaveLength(2)
    expect(env.submits[1]?.base).toBe(String(env.prs[0]?.['headRefName']))
    expect(env.submits[1]?.prompt).toMatch(/previous worker stopped before finishing/)
    expect(readDeliveryState(env.loaded().stateDir, ISSUE).fleetFix).toMatchObject({ kind: 'continue', head: 'a1b2c3d4e5f6' })

    // The continuation finishes: its commits are pushed to the draft's branch …
    env.tasks.set('q-0002', { state: 'done' })
    expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'waiting', reason: expect.stringMatching(/continue fix pushed/) })
    expect(env.pushes()).toEqual([expect.arrayContaining([`c0ffee123456:refs/heads/${String(env.prs[0]?.['headRefName'])}`])])
    // … and once that head is the PR's, the draft is made ready and loses the WIP label.
    env.prs[0]!['headRefOid'] = 'c0ffee123456'
    expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'waiting', reason: expect.stringMatching(/no longer a draft/) })
    expect(env.calls).toContainEqual(['gh', 'pr', 'ready', '7', '--repo', REPO])
    expect(env.calls).toContainEqual(expect.arrayContaining(['pr', 'edit', '7', '--remove-label', 'loop:wip']))
  })
})

describe('no dead states: orphans in progress are reclaimed', () => {
  it('a dispatched task the fleet queue no longer lists is confirmed on a second pass, then returned to Todo', async () => {
    const env = makeEnv()
    await env.dispatch()
    env.tasks.clear()
    expect((await runDeliver({ ...env.base })).results).toEqual([expect.objectContaining({ outcome: 'waiting', reason: expect.stringMatching(/not in the fleet queue/) })])
    expect(env.issue.labels).toEqual([IN_PROGRESS])
    const report = await runDeliver({ ...env.base })
    expect(report.results).toEqual([expect.objectContaining({ outcome: 'restarted', reason: expect.stringMatching(/no longer in the fleet queue/) })])
    expect(env.issue.labels).toEqual([TODO])
  })

  it('an issue labelled loop:in-progress with no dispatch, lease or fleet task behind it goes back to Todo', async () => {
    const env = makeEnv([IN_PROGRESS])
    const report = await runDeliver({ ...env.base })
    expect(report.results).toEqual([expect.objectContaining({ issue: ISSUE, outcome: 'restarted', reason: expect.stringMatching(/orphan reclaimed/) })])
    expect(env.issue.labels).toEqual([TODO])
    expect(env.comments.at(-1)).toMatch(/orphan reclaimed/)
  })

  it('an attempt that ended `failed` with no PR, still labelled in progress, is reclaimed', async () => {
    const env = makeEnv()
    await env.dispatch()
    // Three passes that throw (a transient error each) finish the attempt as `failed`; the label stays in progress.
    env.tasks.set(env.latest(), { state: 'done', collect: { ref: 'refs/remotes/fleet/h1/ht-1', commits: 1 } })
    for (let pass = 0; pass < 2; pass += 1) expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'waiting', reason: expect.stringMatching(/transient error/) })
    // The pass that finishes it `failed` is the pass that reclaims it: the label never outlives the attempt.
    const report = await runDeliver({ ...env.base })
    expect(report.results).toEqual([expect.objectContaining({ outcome: 'failed' }), expect.objectContaining({ outcome: 'restarted', reason: expect.stringMatching(/orphan reclaimed.*finished failed/) })])
    expect(readDeliveryState(env.loaded().stateDir, ISSUE).finalOutcome).toBe('failed')
    expect(env.issue.labels).toEqual([TODO])
  })

  it('a live dispatch is never taken for an orphan', async () => {
    const env = makeEnv()
    await env.dispatch()
    expect((await runDeliver({ ...env.base })).results).toEqual([expect.objectContaining({ outcome: 'waiting', reason: 'fleet task running' })])
    expect(env.issue.labels).toEqual([IN_PROGRESS])
  })
})

describe('no dead states: a fix round whose fleet task failed for an infrastructure reason is retried', () => {
  const openConflictingPr = async (env: ReturnType<typeof makeEnv>) => {
    await env.dispatch({ state: 'done' })
    await runDeliver({ ...env.base })
    expect(env.prs).toHaveLength(1)
    env.prs[0]!['mergeable'] = 'CONFLICTING'; env.prs[0]!['mergeStateStatus'] = 'DIRTY'
    expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'fix-round', reason: 'conflicts with main' })
    expect(env.submits).toHaveLength(2)
  }

  it('no eligible host: the round is given back and resubmitted, not blocked', async () => {
    const env = makeEnv()
    await openConflictingPr(env)
    env.tasks.set('q-0002', { state: 'failed', reason: 'no-eligible-host' })
    const retried = await runDeliver({ ...env.base })
    expect(retried.results[0]).toMatchObject({ outcome: 'waiting', reason: expect.stringMatching(/infrastructure failure.*retried next pass \(1\/3/) })
    const state = readDeliveryState(env.loaded().stateDir, ISSUE)
    expect(state).toMatchObject({ fixRounds: 0, finalOutcome: null })
    expect(state.fleetFix ?? null).toBeNull()
    expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'fix-round', reason: 'conflicts with main' })
    expect(env.submits).toHaveLength(3)
  })

  it('at most 3 infrastructure retries a day; the 4th failure blocks', async () => {
    const env = makeEnv()
    await openConflictingPr(env)
    for (let retry = 1; retry <= 3; retry += 1) {
      env.tasks.set(env.latest(), { state: 'cancelled', reason: 'cancelled by the fleet' })
      expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'waiting', reason: expect.stringMatching(new RegExp(`\\(${retry}/3 today\\)`)) })
      expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'fix-round' })
    }
    env.tasks.set(env.latest(), { state: 'failed', reason: 'host down' })
    expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'blocked', reason: expect.stringMatching(/after 3 infrastructure retries/) })
  })

  it('a fix task that itself failed is blocked for a human', async () => {
    const env = makeEnv()
    await openConflictingPr(env)
    env.tasks.set('q-0002', { state: 'failed', reason: 'tests failed after the merge' })
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ outcome: 'blocked', reason: expect.stringMatching(/fix task ended failed \(tests failed after the merge\)/) })
    expect(env.issue.labels).toEqual([BLOCKED])
  })
})
