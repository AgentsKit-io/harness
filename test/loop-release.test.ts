import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approveRelease, createLoopEventBus, loadLoopConfig, readLoopEvents, readReleaseBatch, readReleaseState, renderReleaseMarkdown, runReleaseStage } from '../src/index.js'
import type { CommandResult, CommandRunner, LoadedLoopConfig, ReleaseBatch } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const NOW = new Date('2026-09-19T12:00:00.000Z')
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false, durationMs: 1 })
const bad = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr, timedOut: false, durationMs: 1 })

const RELEASE = 'release:\n  enabled: true\n  branch: production\n'
const LOG = ['abc123\u001ffeat: ENG-1 add health endpoint', 'def456\u001ffix: ENG-2 correct the timeout'].join('\n')

const setup = (overlay = RELEASE): LoadedLoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-release-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  writeFileSync(join(dir, 'loop.config.local.yaml'), overlay)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
  mkdirSync(loaded.stateDir, { recursive: true })
  return loaded
}

/** A runner that answers git by subcommand and everything else from `others`, recording every call. */
const runner = (overrides: { readonly head?: CommandResult; readonly log?: CommandResult; readonly push?: CommandResult; readonly others?: (argv: readonly string[]) => CommandResult } = {}): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  return {
    calls,
    run: async (argv) => {
      calls.push([...argv])
      if (argv[0] === 'git' && argv.includes('rev-parse')) return overrides.head ?? ok('headsha0000')
      if (argv[0] === 'git' && argv.includes('log')) return overrides.log ?? ok(LOG)
      if (argv[0] === 'git' && argv.includes('push')) return overrides.push ?? ok()
      return overrides.others?.(argv) ?? ok()
    },
  }
}

const batchOf = async (loaded: LoadedLoopConfig, cli = runner()): Promise<ReleaseBatch> => readReleaseBatch({ loaded, runner: cli })

describe('reading the batch', () => {
  it('lists what is on the integration branch and not on the release branch, with the issues it carries', async () => {
    const loaded = setup()
    const batch = await batchOf(loaded)
    expect(batch).toMatchObject({ base: 'main', branch: 'production', head: 'headsha0000' })
    expect(batch.commits.map((commit) => commit.issue)).toEqual(['ENG-1', 'ENG-2'])
    expect(batch.issues).toEqual(['ENG-1', 'ENG-2'])
  })

  it('reports a git failure instead of pretending the batch is empty', async () => {
    const batch = await batchOf(setup(), runner({ log: bad('fatal: unknown revision production') }))
    expect(batch.error).toContain('unknown revision production')
    expect(batch.commits).toEqual([])
  })
})

describe('the human gate', () => {
  it('binds the approval to the exact head, and refuses an empty or unknown batch', async () => {
    const loaded = setup()
    const approval = approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    expect(approval).toEqual({ head: 'headsha0000', actor: 'emerson', at: NOW.toISOString(), commits: 2 })
    expect(readReleaseState(loaded.stateDir).approval).toEqual(approval)
    const empty = await batchOf(loaded, runner({ log: ok('') }))
    expect(() => approveRelease({ loaded, batch: empty, actor: 'emerson' })).toThrow(/Nothing to release/)
    expect(() => approveRelease({ loaded, batch: { ...empty, head: null, error: 'git is unavailable' }, actor: 'emerson' })).toThrow(/git is unavailable/)
  })

  it('waits when nothing is approved, and again when the branch moved past the approval', async () => {
    const loaded = setup()
    const waiting = await runReleaseStage({ loaded, runner: runner(), now: () => NOW })
    expect(waiting).toMatchObject({ status: 'waiting', promoted: false })
    expect(waiting.detail).toContain('loop release approve')

    approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    const moved = await runReleaseStage({ loaded, runner: runner({ head: ok('newerhead111') }), now: () => NOW })
    expect(moved.status).toBe('waiting')
    expect(moved.detail).toContain('re-approve the current batch')
  })

  it('announces a batch waiting for approval once per head, not once per tick', async () => {
    const loaded = setup()
    await runReleaseStage({ loaded, runner: runner(), now: () => NOW })
    const first = readLoopEvents(loaded.stateDir).filter((event) => event.type === 'release.waiting')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ head: 'headsha0000', commits: 2, branch: 'production' })
    expect(readReleaseState(loaded.stateDir).waitingNotifiedFor).toBe('headsha0000')

    // The cron runs again on the same head: still waiting, and still the same one announcement.
    await runReleaseStage({ loaded, runner: runner(), now: () => NOW })
    expect(readLoopEvents(loaded.stateDir).filter((event) => event.type === 'release.waiting')).toHaveLength(1)

    // A new merge is genuinely new news.
    await runReleaseStage({ loaded, runner: runner({ head: ok('newerhead111') }), now: () => NOW })
    expect(readLoopEvents(loaded.stateDir).filter((event) => event.type === 'release.waiting')).toHaveLength(2)

    // A dry run says what it would do without writing the announcement down.
    const dry = setup()
    await runReleaseStage({ loaded: dry, runner: runner(), now: () => NOW, dryRun: true })
    expect(readLoopEvents(dry.stateDir).filter((event) => event.type === 'release.waiting')).toEqual([])
  })
})

describe('promoting and deploying', () => {
  it('does nothing at all until release.enabled, and refuses a promotion that would be a no-op', async () => {
    expect((await runReleaseStage({ loaded: setup(''), runner: runner() })).status).toBe('idle')
    const same = setup('release:\n  enabled: true\n  branch: main\n')
    expect((await runReleaseStage({ loaded: same, runner: runner() })).detail).toContain('promotion would be a no-op')
  })

  it('promotes the approved head and reports when no deploy is declared', async () => {
    const loaded = setup()
    approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    const cli = runner()
    const report = await runReleaseStage({ loaded, runner: cli, now: () => NOW })
    expect(report).toMatchObject({ status: 'ok', promoted: true, deployed: false, smoke: 'skipped' })
    expect(cli.calls.find((argv) => argv.includes('push'))).toEqual(['git', '-C', loaded.root, 'push', 'origin', 'headsha0000:refs/heads/production'])
    // The approval is spent: the next batch needs its own.
    expect(readReleaseState(loaded.stateDir).approval).toBeNull()
    expect(readLoopEvents(loaded.stateDir).map((event) => event.type)).toContain('release.promoted')
  })

  it('loads plugins.modules (not just notifications), reaching an externally-owned bus too', async () => {
    const loaded = setup(`${RELEASE}plugins:\n  modules: [plugin.mjs]\n`)
    writeFileSync(join(loaded.root, 'plugin.mjs'), `export default { id: 'release-logger', apply(bus) { globalThis.__releaseEvents = []; bus.on('release.promoted', (event) => { globalThis.__releaseEvents.push(event.type) }) } }`, 'utf8')
    approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    await runReleaseStage({ loaded, runner: runner(), now: () => NOW })
    expect((globalThis as { __releaseEvents?: readonly unknown[] }).__releaseEvents).toEqual(['release.promoted'])

    // An externally-owned bus (as `loop stage` passes) is used as-is: no second plugin/notifier attachment on it.
    const loaded2 = setup()
    approveRelease({ loaded: loaded2, batch: await batchOf(loaded2), actor: 'emerson', now: () => NOW })
    const bus = createLoopEventBus()
    const seen: string[] = []
    bus.on('release.promoted', (event) => seen.push(event.type))
    await runReleaseStage({ loaded: loaded2, runner: runner(), now: () => NOW, bus })
    expect(seen).toEqual(['release.promoted'])
  })

  it('runs the deploy and the smoke, and rolls back when the smoke fails', async () => {
    const loaded = setup(`${RELEASE}  deploy: [./deploy.sh]\n  smoke: [./smoke.sh]\n  rollback: [./rollback.sh]\n`)
    approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    const cli = runner({ others: (argv) => argv[0] === './smoke.sh' ? bad('health check returned 503') : ok() })
    const report = await runReleaseStage({ loaded, runner: cli, now: () => NOW })
    expect(report).toMatchObject({ status: 'rolled-back', promoted: true, deployed: true, smoke: 'failed' })
    expect(cli.calls.map((argv) => argv[0])).toContain('./rollback.sh')
    expect(readLoopEvents(loaded.stateDir).map((event) => event.type)).toEqual(expect.arrayContaining(['release.promoted', 'release.deployed', 'release.smoke-failed', 'release.rolled-back']))
    expect(readReleaseState(loaded.stateDir).history.at(-1)).toMatchObject({ status: 'rolled-back' })
  })

  it('says plainly that a human must decide when the smoke fails with no rollback declared', async () => {
    const loaded = setup(`${RELEASE}  deploy: [./deploy.sh]\n  smoke: [./smoke.sh]\n`)
    approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    const report = await runReleaseStage({ loaded, runner: runner({ others: (argv) => argv[0] === './smoke.sh' ? bad('503') : ok() }), now: () => NOW })
    expect(report.status).toBe('failed')
    expect(report.detail).toContain('no release.rollback is declared')
  })

  it('keeps the approval when the promotion push fails', async () => {
    const loaded = setup()
    approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    const report = await runReleaseStage({ loaded, runner: runner({ push: bad('remote rejected') }), now: () => NOW })
    expect(report).toMatchObject({ status: 'failed', promoted: false })
    expect(readReleaseState(loaded.stateDir).approval).not.toBeNull()
  })

  it('touches nothing on a dry run', async () => {
    const loaded = setup()
    approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    const cli = runner()
    const report = await runReleaseStage({ loaded, runner: cli, now: () => NOW, dryRun: true })
    expect(report.status).toBe('dry-run')
    expect(cli.calls.some((argv) => argv.includes('push'))).toBe(false)
  })

  it('renders the batch, the approval and what it did', async () => {
    const loaded = setup()
    approveRelease({ loaded, batch: await batchOf(loaded), actor: 'emerson', now: () => NOW })
    const markdown = renderReleaseMarkdown(await runReleaseStage({ loaded, runner: runner(), now: () => NOW }))
    expect(markdown).toContain('# Release — main → production')
    expect(markdown).toContain('feat: ENG-1 add health endpoint')
    expect(markdown).toContain('Approved by emerson')
    expect(markdown).toContain('promote →')
  })
})
