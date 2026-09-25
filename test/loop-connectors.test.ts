import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalRunner, createOrcaRunner, createRunnerConnector, loadLoopConfig, resolveConnectors, scheduledJobs } from '../src/index.js'
import type { CommandResult, CommandRunner, LoadedLoopConfig } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person').replace('my-linear-display-name: <linear-user-id>', 'person: user-id-1')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false, durationMs: 1 })
const recording = (answer: (argv: readonly string[]) => CommandResult = () => ok()): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  return { calls, run: async (argv) => { calls.push([...argv]); return answer(argv) } }
}

const setup = (overlay = ''): LoadedLoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-connectors-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  if (overlay) writeFileSync(join(dir, 'loop.config.local.yaml'), overlay)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
  mkdirSync(loaded.stateDir, { recursive: true })
  return loaded
}

describe('tracker and scm connectors', () => {
  it('speak the interface and translate to the vendor CLI underneath', async () => {
    const loaded = setup()
    const runner = recording((argv) => argv.includes('view') ? ok(JSON.stringify({ number: 7, url: 'u', headRefOid: 'sha', isDraft: false, files: [] })) : ok(JSON.stringify({ ok: true, result: {} })))
    const { tracker, scm } = resolveConnectors({ runner, config: loaded.config })
    expect(tracker.id).toBe('linear')
    expect(scm.id).toBe('github')

    await tracker.comment({ issue: 'ENG-1', body: 'hello', dedupeKey: 'k' })
    await tracker.addLabels('ENG-1', ['blocked'])
    await tracker.claim('ENG-1', 'person')
    await tracker.release('ENG-1')
    const linearCalls = runner.calls.filter((argv) => argv[0] === 'orca')
    expect(linearCalls.map((argv) => argv.slice(1, 3).join(' '))).toEqual(['linear comment', 'linear label', 'linear assignee', 'linear assignee'])
    // The dedupe key becomes the CLI's idempotency id, which is why it lives in the interface.
    expect(linearCalls[0]).toContain('--write-id')
    // `claim` takes a `models.linear.people` key ('person'), not a Linear user id: Orca's `assignee set` needs
    // `--to-id <userId>` (it dropped `--assignee`), so the connector must resolve it via the people map.
    expect(linearCalls[2]).toEqual(expect.arrayContaining(['--to-id', 'user-id-1']))
    expect(linearCalls[2]).not.toContain('--assignee')

    await scm.comment({ number: 7, body: 'note' })
    expect(runner.calls.at(-1)?.slice(0, 3)).toEqual(['gh', 'pr', 'comment'])
  })

  it('fails loudly when claiming for a person with no entry in models.linear.people', async () => {
    const loaded = setup()
    const runner = recording()
    const { tracker } = resolveConnectors({ runner, config: loaded.config })
    await expect(tracker.claim('ENG-1', 'someone-not-in-the-map')).rejects.toThrow(/No Linear user id configured for "someone-not-in-the-map"/)
  })

  it('refuses an unknown implementation with the interface to implement', () => {
    const loaded = setup()
    const broken = { ...loaded.config, connectors: { ...loaded.config.connectors, tracker: 'jira' as unknown as 'linear' } }
    expect(() => resolveConnectors({ runner: recording(), config: broken })).toThrow(/TrackerConnector/)
  })
})

describe('the runner connector, twice', () => {
  it('picks the implementation the config names', () => {
    expect(createRunnerConnector({ loaded: setup(), runner: recording() }).id).toBe('orca')
  })

  it('refuses connectors.runner: local, because nothing in dispatch is wired to it yet', () => {
    // Accepting it gave a project Orca behaviour while its config said "local", and doctor called that `passed`.
    // The implementation below stays tested so wiring it later is a change of caller, not a rewrite.
    expect(() => setup('connectors:\n  runner: local\n')).toThrow(/not wired into dispatch yet/)
  })

  it('creates a workspace, launches and talks to it through Orca', async () => {
    const loaded = setup()
    const runner = recording((argv) => argv.includes('create') && argv.includes('worktree')
      ? ok(JSON.stringify({ ok: true, result: { worktree: { worktreeId: 'w1', path: '/tmp/w1', branch: 'b' } } }))
      : ok(JSON.stringify({ ok: true, result: { terminal: { handle: 't1' }, send: { prompt: { accepted: true, stages: ['input_accepted'] } } } })))
    const orca = createOrcaRunner({ loaded, runner })
    const workspace = await orca.createWorkspace({ name: 'w1', branch: 'b', baseBranch: 'main', issue: 'ENG-1' })
    expect(workspace).toMatchObject({ id: 'w1', path: '/tmp/w1', branch: 'b' })
    expect(await orca.launchAgent({ workspace, command: 'claude' })).toBe('t1')
    expect(await orca.send({ terminal: 't1', text: 'hello' })).toMatchObject({ delivered: true })
  })

  it('creates a git worktree, a tmux session, and types before it presses Enter', async () => {
    const loaded = setup()
    const runner = recording()
    const local = createLocalRunner({ loaded, runner })
    const workspace = await local.createWorkspace({ name: 'eng-1', branch: 'person/eng-1', baseBranch: 'main' })
    expect(workspace.path.replaceAll('\\', '/').endsWith('/eng-1')).toBe(true)
    expect(runner.calls.some((argv) => argv.includes('worktree') && argv.includes('add'))).toBe(true)

    const session = await local.launchAgent({ workspace, command: 'claude --model opus' })
    expect(session).toBe('ak-eng-1')
    expect(runner.calls.at(-1)).toEqual(['tmux', 'new-session', '-d', '-s', 'ak-eng-1', '-c', workspace.path, 'claude --model opus'])

    await local.send({ terminal: session, text: 'do the thing\nand more' })
    // Literal text first, Enter second: a newline inside the text must not submit it early.
    expect(runner.calls.at(-2)).toEqual(['tmux', 'send-keys', '-t', session, '-l', 'do the thing\nand more'])
    expect(runner.calls.at(-1)).toEqual(['tmux', 'send-keys', '-t', session, 'Enter'])
  })

  it('reconciles only the crontab lines it owns, and leaves everyone else\'s alone', async () => {
    const loaded = setup()
    const existing = '0 9 * * * /usr/bin/backup\n*/9 * * * * old-command # ak-harness loop-my-project-tick\n'
    const runner = recording((argv) => argv[0] === 'crontab' && argv[1] === '-l' ? ok(existing) : ok())
    const local = createLocalRunner({ loaded, runner })
    const jobs = scheduledJobs(loaded, ['tick', 'deliver'])
    expect(jobs.map((job) => job.name)).toEqual(['loop-my-project-tick', 'loop-my-project-deliver'])
    expect(jobs[0]?.command).toContain('loop stage tick')

    const changed = await local.schedule(jobs)
    expect(changed).toHaveLength(2)
    const written = readFileSync(join(loaded.stateDir, 'crontab.local'), 'utf8')
    expect(written).toContain('0 9 * * * /usr/bin/backup')
    expect(written).not.toContain('old-command')
    expect(written).toContain('# ak-harness loop-my-project-tick')
    expect(runner.calls.at(-1)).toEqual(['crontab', join(loaded.stateDir, 'crontab.local')])
  })

  it('writes nothing when the crontab already matches', async () => {
    const loaded = setup()
    const jobs = scheduledJobs(loaded, ['tick'])
    const current = `${jobs[0]?.cron} ${jobs[0]?.command} # ak-harness ${jobs[0]?.name}\n`
    const runner = recording((argv) => argv[1] === '-l' ? ok(current) : ok())
    expect(await createLocalRunner({ loaded, runner }).schedule(jobs)).toEqual([])
    expect(runner.calls).toHaveLength(1)
  })
})

describe('unknown config keys', () => {
  it('names a key the schema does not know instead of stripping it in silence', () => {
    // `maxFixRoundz: 2` used to be accepted with `maxFixRounds` quietly taking its default — a typo that reads
    // as "I configured this" and behaves as "I did not". Reported, not rejected: a config written for a newer
    // harness legitimately carries keys this version has never heard of.
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-unknown-keys-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml.replace('  maxFixRounds: 2', '  maxFixRoundz: 2'))
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
    expect(loaded.unknownKeys).toEqual(['delivery.maxFixRoundz'])
    expect(loaded.config.delivery.maxFixRounds).toBe(2) // still the default, but no longer silently
  })

  it('reports nothing for the example config every project copies', () => {
    expect(setup().unknownKeys).toEqual([])
  })
})
