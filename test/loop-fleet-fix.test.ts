import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTRACT_CLOSE, CONTRACT_OPEN, loadLoopConfig, readDeliveryState, runDeliver, runTick } from '../src/index.js'
import type { CommandResult, CommandRunner, TaskContract } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace(/\r\n/g, '\n').replace('person: my-linear-display-name', 'person: person').replace('my-linear-display-name: <linear-user-id>', 'person: user-id-1')
const contract: TaskContract = { intent: 'Add the demo binding', scope: { inScope: ['binding'], outOfScope: ['ui'] }, outcomes: [{ id: 'o1', description: 'tests pass', check: { kind: 'test', command: 'pnpm --filter demo test' } }], ambiguities: [], touchpoints: ['packages/demo'], risks: [] }

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const done = (stdout = '', code = 0): CommandResult => ({ code, stdout, stderr: '', timedOut: false, durationMs: 1 })
const REPO = 'my-org/my-project'
const issueJson = { number: 1, url: `https://github.com/${REPO}/issues/1`, title: 'Demo issue', state: 'OPEN', labels: [], assignees: [], createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z' }
const RUN_URL = `https://github.com/${REPO}/actions/runs/999`

/** A fleet runner with a fake `fleet`, `gh` and `git`: tasks are numbered q-0001…, and each task's state and collected tip are the test's to set. */
const makeEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-fleet-fix-')); cleanups.push(dir)
  const bin = mkdtempSync(join(tmpdir(), 'agentskit-fleet-fix-bin-')); cleanups.push(bin)
  for (const name of ['claude', 'codex', 'opencode', 'grok']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const yaml = exampleYaml.replace('# connectors:\n#   tracker: linear', 'connectors:\n  tracker: github').replace('  queueOwnership: person ', '  queueOwnership: unassigned ')
  writeFileSync(join(dir, 'loop.config.yaml'), yaml)
  writeFileSync(join(dir, 'loop.config.local.yaml'), `connectors:\n  runner: fleet\n  fleet:\n    project: ${REPO}\n`)
  const issue = { ...issueJson, labels: [{ name: loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' }).config.github.issues.labels.todo }] }
  const calls: string[][] = []
  const submits: { readonly base: string; readonly prompt: string }[] = []
  const states = new Map<string, string>()
  const prs: Record<string, unknown>[] = []
  const state = { rebased: false }
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push([...argv])
      const [bin0, verb, sub] = argv
      if (bin0 === 'orca') return { code: 127, stdout: '', stderr: 'orca: not installed', timedOut: false, durationMs: 1 }
      if (bin0 === 'fleet') {
        if (verb === 'submit') { submits.push({ base: argv[argv.indexOf('--base') + 1] ?? '', prompt: readFileSync(argv[argv.indexOf('--prompt-file') + 1] ?? '', 'utf8') }); const id = `q-000${submits.length}`; states.set(id, 'running'); return done(`submitted ${id}\n`) }
        if (verb === 'queue') return done(JSON.stringify([...states].map(([id, taskState]) => ({ id, state: taskState, hostTaskId: `ht-${id.slice(-1)}` }))))
        if (verb === 'collect') return done(JSON.stringify({ ref: `refs/remotes/fleet/h1/${verb}`, headSha: argv[2] === 'ht-1' ? 'a1b2c3d4e5f6' : 'c0ffee123456', baseSha: 'b0b0b0b', commits: 1 }))
        return done()
      }
      if (bin0 === 'gh') {
        if (verb === 'api' && sub === 'user') return done(JSON.stringify({ login: 'person' }))
        if (verb === 'api') return done('')
        if (verb === 'auth') return done('token\n')
        if (verb === 'issue' && sub === 'list') return done(JSON.stringify([issue]))
        if (verb === 'issue' && sub === 'view') return done(JSON.stringify({ ...issue, body: 'Add the binding.\n\n## Acceptance\n- tests pass', comments: [] }))
        if (verb === 'pr' && sub === 'create') { prs.push({ number: 7, url: `https://github.com/${REPO}/pull/7`, title: 'Demo', state: 'OPEN', headRefName: argv[argv.indexOf('--head') + 1], headRefOid: 'a1b2c3d4e5f6', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [], files: [], statusCheckRollup: [], updatedAt: '2026-10-20T11:00:00Z' }); return done(`https://github.com/${REPO}/pull/7\n`) }
        if (verb === 'pr' && (sub === 'list' || sub === 'view')) return done(JSON.stringify(sub === 'view' ? prs[0] : prs))
        if (verb === 'run' && sub === 'view') return done('review: src/x.ts:12 [medium] unchecked input\nreview: src/y.ts:3 [medium] missing test\n')
        return done()
      }
      if (bin0 === 'claude' && verb === '-p') return done(`thinking…\n${CONTRACT_OPEN}\n${JSON.stringify(contract)}\n${CONTRACT_CLOSE}\n`)
      if (bin0 === 'git') {
        if (argv.includes('merge-tree')) return done('0123abc\nsrc/a.ts\nsrc/b.ts\n\nCONFLICT (content): ...\n', 1)
        // Only the question "did the fix keep the PR head in its history?" is about the PR head; collect's own check is not.
        if (argv.includes('--is-ancestor')) return done('', state.rebased && argv.at(-2) === 'a1b2c3d4e5f6' ? 1 : 0)
        return done(verb === 'rev-parse' ? 'basesha\n' : '')
      }
      return { code: 127, stdout: '', stderr: `no fixture for ${argv.join(' ')}`, timedOut: false, durationMs: 1 }
    },
  }
  const machine = { sample: { at: '2026-10-20T12:00:00.000Z', cpus: 10, load1: 1, load1PerCpu: 0.1, load1PerCpuPercent: 10, memoryUsedPercent: 40, rssBytes: 1 }, freeBytes: 20 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 }
  const base = { configPath: join(dir, 'loop.config.yaml'), runner, env: { PATH: bin, XAI_API_KEY: 'k', AK_HARNESS_NO_GLOBAL: '1' }, platform: 'linux' as const, now: () => new Date('2026-10-20T12:00:00.000Z'), machine }
  const loaded = () => loadLoopConfig(base.configPath, { AK_HARNESS_NO_GLOBAL: '1' })
  const pr = () => prs[0] as Record<string, unknown>
  /** The first task is done and collected, and its PR is open. */
  const openPr = async () => {
    await runTick({ ...base, maxDispatch: 1 })
    states.set('q-0001', 'done')
    await runDeliver({ ...base })
    expect(prs).toHaveLength(1)
  }
  /** Pushes to the PR branch by a fix round (the harness's first push, `-u`, opened the PR). */
  const pushes = () => calls.filter((argv) => argv[0] === 'git' && argv.includes('push') && !argv.includes('-u'))
  return { calls, submits, states, prs, pr, state, base, loaded, openPr, pushes }
}

const ISSUE = `${REPO}#1`

describe('runner: fleet — a PR that needs a fix gets a fix round on the fleet', () => {
  it('a conflict submits a fix task cut from the PR head, briefed with the conflicting files', async () => {
    const env = makeEnv()
    await env.openPr()
    env.pr()['mergeable'] = 'CONFLICTING'; env.pr()['mergeStateStatus'] = 'DIRTY'
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ issue: ISSUE, outcome: 'fix-round', reason: 'conflicts with main', pr: 7 })
    expect(env.submits).toHaveLength(2)
    const fix = env.submits[1]!
    expect(fix.base).toBe(String(env.pr()['headRefName']))
    expect(fix.prompt.startsWith(`# Loop worker — ${REPO}`)).toBe(true)
    expect(fix.prompt).toContain('- src/a.ts')
    expect(fix.prompt).toContain('- src/b.ts')
    expect(fix.prompt).toContain('Add the demo binding')
    expect(fix.prompt).toContain('o1: tests pass')
    expect(fix.prompt).toContain('git rebase origin/main')
    expect(fix.prompt).toContain('Do NOT push')
    expect(env.calls.some((argv) => argv[0] === 'orca')).toBe(false)
    const state = readDeliveryState(env.loaded().stateDir, ISSUE)
    expect(state.fleetFix).toMatchObject({ head: 'a1b2c3d4e5f6', kind: 'conflict' })
    expect(state.fixRounds).toBe(1)

    // While the fix task runs, deliver waits and submits nothing more.
    const waiting = await runDeliver({ ...env.base })
    expect(waiting.results[0]).toMatchObject({ outcome: 'waiting', reason: 'fleet fix task running' })
    expect(env.submits).toHaveLength(2)
  })

  it('a red factory-review check puts the findings from its log in the brief', async () => {
    const env = makeEnv()
    await env.openPr()
    env.pr()['statusCheckRollup'] = [{ __typename: 'CheckRun', name: 'factory-review', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: RUN_URL }]
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ outcome: 'fix-round', reason: 'CI red: factory-review' })
    expect(env.calls).toContainEqual(['gh', 'run', 'view', '999', '--repo', REPO, '--log-failed'])
    const prompt = env.submits[1]!.prompt
    expect(prompt).toContain('Failing checks: factory-review')
    expect(prompt).toContain('src/x.ts:12 [medium] unchecked input')
    expect(prompt).toContain('src/y.ts:3 [medium] missing test')
    expect(prompt).toContain('Add the demo binding')
  })

  it('a done fix task is collected and pushed to the PR branch with a plain push', async () => {
    const env = makeEnv()
    await env.openPr()
    env.pr()['statusCheckRollup'] = [{ __typename: 'CheckRun', name: 'factory-review', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: RUN_URL }]
    await runDeliver({ ...env.base })
    env.states.set('q-0002', 'done')
    const report = await runDeliver({ ...env.base })
    expect(env.calls).toContainEqual(['fleet', 'collect', 'ht-2', '--json'])
    expect(env.pushes()).toEqual([expect.arrayContaining(['push', 'origin', `c0ffee123456:refs/heads/${String(env.pr()['headRefName'])}`])])
    expect(env.pushes()[0]?.some((arg) => arg.startsWith('--force'))).toBe(false)
    expect(report.results[0]).toMatchObject({ outcome: 'waiting', reason: expect.stringMatching(/fix pushed/) })
    expect(readDeliveryState(env.loaded().stateDir, ISSUE).fleetFix ?? null).toBeNull()
  })

  it('a fix that rebased is pushed with --force-with-lease pinned to the head it was cut from', async () => {
    const env = makeEnv()
    await env.openPr()
    env.pr()['mergeable'] = 'CONFLICTING'
    await runDeliver({ ...env.base })
    env.states.set('q-0002', 'done')
    env.state.rebased = true
    await runDeliver({ ...env.base })
    const ref = String(env.pr()['headRefName'])
    const push = env.pushes().at(-1)
    expect(push).toEqual(expect.arrayContaining([`--force-with-lease=refs/heads/${ref}:a1b2c3d4e5f6`, 'origin', `c0ffee123456:refs/heads/${ref}`]))
  })

  it('a fix task that failed is escalated, not left waiting', async () => {
    const env = makeEnv()
    await env.openPr()
    env.pr()['mergeable'] = 'CONFLICTING'
    await runDeliver({ ...env.base })
    env.states.set('q-0002', 'failed')
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ outcome: 'blocked', reason: expect.stringMatching(/fix task ended failed/) })
    expect(env.pushes()).toEqual([])
  })

  it('at the fix-round limit the issue is escalated with loop:blocked and a comment', async () => {
    const env = makeEnv()
    await env.openPr()
    const limit = env.loaded().config.delivery.maxFixRounds
    let head = 'a1b2c3d4e5f6'
    for (let round = 1; round <= limit; round += 1) {
      env.pr()['mergeable'] = 'CONFLICTING'
      expect((await runDeliver({ ...env.base })).results[0]).toMatchObject({ outcome: 'fix-round' })
      env.states.set(`q-000${round + 1}`, 'done')
      await runDeliver({ ...env.base })
      // The pushed fix becomes the PR's new head, and it conflicts again.
      head = `${round}${head.slice(1)}`
      env.pr()['headRefOid'] = head
    }
    expect(env.submits).toHaveLength(limit + 1)
    const report = await runDeliver({ ...env.base })
    expect(report.results[0]).toMatchObject({ outcome: 'blocked', reason: 'conflicts with main' })
    expect(env.submits).toHaveLength(limit + 1)
    expect(readDeliveryState(env.loaded().stateDir, ISSUE).finalOutcome).toBe('blocked')
    const comment = env.calls.find((argv) => argv[0] === 'gh' && argv[1] === 'issue' && argv[2] === 'comment')
    expect(comment?.[comment.indexOf('--body') + 1]).toContain('**Loop: blocked after 2 fix round(s)** — conflicts with main')
  })
})
