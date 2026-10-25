import { splitLines } from '@agentskit/cross-platform'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessDod, parseLoopConfigText } from '../src/index.js'
import type { CommandRunner, LoopConfig, TaskContract } from '../src/index.js'
import { ciVerification, proveFleetDod } from '../src/loop/fleet-dod.js'
import type { ControlMachineGate } from '../src/loop/control-machine.js'
import type { RunnerConnector } from '../src/loop/runner-connector.js'
import { createProcessRunner } from '../src/loop/process.js'
import { initializeGitRepository } from './git.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const DOD = `
dod:
  items:
    - id: verify
      description: the check passes
      kind: command
      command: [node, -e, "require('fs').writeFileSync('ran-here.txt', 'x'); console.log('check ok')"]
    - id: test-for-new-code
      description: new code ships a test
      kind: file-changed
      glob: "**/*.{test,spec}.*"
    - id: no-todo
      description: no TODO left behind
      kind: pattern-absent
      pattern: "TODO"
      paths: ["src/**"]
`
const config = (extra = DOD): LoopConfig => parseLoopConfigText(`${exampleYaml}${extra}`)
const contract = (check: TaskContract['outcomes'][number]['check']): TaskContract => ({ intent: 'x', scope: { inScope: ['a'], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'subtract works', check }], ambiguities: [], touchpoints: [], risks: [] }) as TaskContract

const real = createProcessRunner()
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await real.run(['git', '-C', cwd, ...args], { timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
const worktrees = async (root: string): Promise<number> => splitLines(await git(root, 'worktree', 'list')).length

/** A clone with a base commit and a "collected" commit that adds a source file and its test. */
const makeRepo = async (extraFiles: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-fleet-dod-')); cleanups.push(root)
  const stateDir = join(root, '.loop-state')
  initializeGitRepository(root)
  await git(root, 'config', 'commit.gpgsign', 'false')
  const base = await git(root, 'rev-parse', 'HEAD')
  const write = (file: string, content: string): void => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content) }
  write('src/subtract.ts', 'export const subtract = (a: number, b: number) => a - b\n')
  write('src/subtract.test.ts', "import { subtract } from './subtract'\n")
  for (const [file, content] of Object.entries(extraFiles)) write(file, content)
  await git(root, 'add', '-A'); await git(root, 'commit', '-m', 'collected')
  const head = await git(root, 'rev-parse', 'HEAD')
  await git(root, 'checkout', '--quiet', base)
  return { root, stateDir, base, head }
}

/** Real git and real commands, recorded; `install` commands are answered rather than run. */
const recordingRunner = (installOutcome = 0) => {
  const calls: { argv: readonly string[]; cwd: string | undefined; timeoutMs: number | undefined }[] = []
  const runner: CommandRunner = {
    run: async (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd, timeoutMs: options?.timeoutMs })
      if (argv[0] === 'pnpm') return { code: installOutcome, stdout: '', stderr: installOutcome ? 'ERR_PNPM_OUTDATED_LOCKFILE' : '', timedOut: false, durationMs: 1 }
      return real.run(argv, { timeoutMs: 60_000, ...(options?.cwd ? { cwd: options.cwd } : {}) })
    },
  }
  return { runner, calls }
}

const leftovers = (stateDir: string): string[] => existsSync(stateDir) ? readdirSync(stateDir).filter((name) => name.startsWith('fleet-checkout-')) : []

describe('fleet: the definition of done on a local checkout of the collected branch', () => {
  it('a collected branch that adds a test file proves test-for-new-code, with the verify command run in the temp worktree', async () => {
    const repo = await makeRepo()
    const { runner, calls } = recordingRunner()
    const cfg = config()
    const proof = await proveFleetDod({ runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null })
    expect(proof.changedFiles).toEqual(['src/subtract.test.ts', 'src/subtract.ts'])
    const assessed = assessDod({ config: cfg, contract: null, evidence: proof.evidence, prFiles: proof.changedFiles, fileContents: proof.fileContents })
    expect(assessed.lines.map((line) => [line.id, line.status])).toEqual([['verify', 'proven'], ['test-for-new-code', 'proven'], ['no-todo', 'proven']])
    expect(assessed.complete).toBe(true)
    const verify = calls.find((call) => call.argv[0] === 'node')
    expect(verify?.cwd).toContain('fleet-checkout-')
    expect(verify?.timeoutMs).toBe(cfg.connectors.fleet.verifyTimeoutMs)
    expect(proof.evidence.project[0]?.evidence).toContain('check ok')
    // The command ran in the temp worktree, which is gone: nothing reached the main clone and no worktree is left registered.
    expect(existsSync(join(repo.root, 'ran-here.txt'))).toBe(false)
    expect(leftovers(repo.stateDir)).toEqual([])
    expect(await worktrees(repo.root)).toBe(1)
  })

  it('pattern-absent reads the committed files; a TODO in a changed file fails it', async () => {
    const repo = await makeRepo({ 'src/later.ts': '// TODO: remove\n' })
    const { runner } = recordingRunner()
    const cfg = config()
    const proof = await proveFleetDod({ runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null })
    const assessed = assessDod({ config: cfg, contract: null, evidence: proof.evidence, prFiles: proof.changedFiles, fileContents: proof.fileContents })
    expect(assessed.lines.find((line) => line.id === 'no-todo')).toMatchObject({ status: 'failed', source: 'harness' })
  })

  it('never trusts the agent: a committed dod.json claiming the command passed is overruled by the local run', async () => {
    const claim = JSON.stringify({ project: [{ id: 'verify', status: 'passed', evidence: 'trust me' }], outcomes: [{ id: 'o1', status: 'passed', evidence: 'trust me' }] })
    const repo = await makeRepo({ '.ak-loop/dod.json': claim })
    const { runner } = recordingRunner()
    const failing = DOD.replace(/command: \[node.*\n/, 'command: [node, -e, "process.exit(3)"]\n')
    const cfg = config(failing)
    const proof = await proveFleetDod({ runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: contract({ kind: 'command', command: 'node -e "process.exit(1)"' }) })
    const assessed = assessDod({ config: cfg, contract: contract({ kind: 'command', command: 'x' }), evidence: proof.evidence, prFiles: proof.changedFiles, fileContents: proof.fileContents })
    expect(assessed.failed).toEqual(['verify', 'o1'])
    expect(leftovers(repo.stateDir)).toEqual([])
  })

  it('a command outcome is proven by running its check; a manual outcome by the handoff committed in the collected branch', async () => {
    const handoff = JSON.stringify({ ranAt: '2026-10-20T00:00:00Z', command: 'by hand', exitCode: 0, outcomes: [{ id: 'o1', status: 'passed', evidence: 'looked at it' }] })
    const repo = await makeRepo({ '.ak-loop/verify.json': handoff })
    const { runner } = recordingRunner()
    const cfg = config('')
    const ran = await proveFleetDod({ runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: contract({ kind: 'test', command: 'node -e "console.log(42)"' }) })
    expect(ran.evidence.outcomes).toHaveLength(1)
    expect(ran.evidence.outcomes[0]).toMatchObject({ id: 'o1', status: 'passed' })
    expect(ran.evidence.outcomes[0]?.evidence).toContain('42')
    const manual = await proveFleetDod({ runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: contract({ kind: 'manual', note: 'eyeball it' }) })
    expect(manual.evidence.outcomes).toEqual([{ id: 'o1', status: 'passed', evidence: 'looked at it' }])
  })

  it('installs with the repo\'s frozen install before running a command, and a failed install fails the command items', async () => {
    const repo = await makeRepo({ 'package.json': '{}\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
    const ok = recordingRunner()
    await proveFleetDod({ runner: ok.runner, config: config(), root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null })
    const order = ok.calls.map((call) => call.argv[0]).filter((name) => name === 'pnpm' || name === 'node')
    expect(order).toEqual(['pnpm', 'node'])
    expect(ok.calls.find((call) => call.argv[0] === 'pnpm')?.argv).toEqual(['pnpm', 'install', '--frozen-lockfile'])

    const bad = recordingRunner(1)
    const proof = await proveFleetDod({ runner: bad.runner, config: config(), root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null })
    expect(proof.evidence.project[0]).toMatchObject({ id: 'verify', status: 'failed' })
    expect(proof.evidence.project[0]?.evidence).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
    expect(bad.calls.some((call) => call.argv[0] === 'node')).toBe(false)
    expect(leftovers(repo.stateDir)).toEqual([])
  })

  it('a green gating CI proves the repository verification: verify and the outcome running verifyCommand are ci-verified, not re-run', async () => {
    const repo = await makeRepo({ 'package.json': '{}\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
    const { runner, calls } = recordingRunner()
    const cfg = config()
    const ci = ciVerification({ gating: true, status: 'green', checks: [{ name: 'ci', outcome: 'success', kind: 'check-run', url: 'https://github.com/o/r/actions/runs/1' }, { name: 'lint', outcome: 'skipped', kind: 'check-run' }], commands: [cfg.delivery.verifyCommand] })
    const outcomes = { ...contract({ kind: 'command', command: cfg.delivery.verifyCommand }), outcomes: [{ id: 'o5', description: 'repo passes', check: { kind: 'command', command: ` ${cfg.delivery.verifyCommand} ` } }, { id: 'o6', description: 'ignored', check: { kind: 'command', command: 'node -e "console.log(6)"' } }] } as TaskContract
    const proof = await proveFleetDod({ runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: outcomes, ci })
    expect(proof.evidence.project[0]).toMatchObject({ id: 'verify', status: 'passed', verdict: 'ci-verified' })
    expect(proof.evidence.project[0]?.evidence).toContain('ci green — https://github.com/o/r/actions/runs/1')
    expect(proof.evidence.outcomes.map((item) => [item.id, item.verdict])).toEqual([['o5', 'ci-verified'], ['o6', 'unit-verified']])
    // The verify command never ran here; the small check did, after the install.
    expect(calls.some((call) => call.argv.join(' ').includes('ran-here.txt'))).toBe(false)
    expect(calls.map((call) => call.argv[0]).filter((name) => name === 'pnpm' || name === 'sh')).toEqual(['pnpm', 'sh'])
    expect(proof.notes).toContain('proven by CI, not re-run locally: verify, o5')
    const assessed = assessDod({ config: cfg, contract: outcomes, evidence: proof.evidence, prFiles: proof.changedFiles, fileContents: proof.fileContents, minVerdict: 'unit-verified' })
    expect(assessed.complete).toBe(true)
    expect(leftovers(repo.stateDir)).toEqual([])
  })

  it('CI proves nothing when it does not gate, is not green, or reported no passing check', () => {
    const checks = [{ name: 'ci', outcome: 'success', kind: 'check-run' }] as const
    expect(ciVerification({ gating: true, status: 'green', checks, commands: ['pnpm verify', ''] })).toEqual({ checks: ['ci'], url: null, commands: ['pnpm verify'] })
    expect(ciVerification({ gating: true, status: 'red', checks, commands: ['pnpm verify'] })).toBeNull()
    expect(ciVerification({ gating: true, status: 'pending', checks, commands: ['pnpm verify'] })).toBeNull()
    expect(ciVerification({ gating: false, status: 'green', checks, commands: ['pnpm verify'] })).toBeNull()
    expect(ciVerification({ gating: true, status: 'green', checks: [], commands: ['pnpm verify'] })).toBeNull()
    expect(ciVerification({ gating: true, status: 'green', checks, ignore: ['ci'], commands: ['pnpm verify'] })).toBeNull()
  })

  it('without CI, the re-run installs with the packageManager the repo names, under the Node it pins', async () => {
    const repo = await makeRepo({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.0' }), 'pnpm-lock.yaml': 'lockfileVersion: 9\n', '.nvmrc': 'v22.11.0\n' })
    const calls: (readonly string[])[] = []
    const runner: CommandRunner = {
      run: async (argv, options) => {
        calls.push([...argv])
        if (argv[0] === 'fnm' && argv[1] === '--version') return { code: 0, stdout: 'fnm 1.37.0', stderr: '', timedOut: false, durationMs: 1 }
        if (argv[0] === 'fnm') { const inner = argv.slice(argv.indexOf('--') + 1); if (inner[0] === 'pnpm') return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }; return real.run(inner, { timeoutMs: 60_000, ...(options?.cwd ? { cwd: options.cwd } : {}) }) }
        return real.run(argv, { timeoutMs: 60_000, ...(options?.cwd ? { cwd: options.cwd } : {}) })
      },
    }
    const proof = await proveFleetDod({ runner, config: config(), root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null, ci: null })
    const wrapped = calls.filter((argv) => argv[0] === 'fnm' && argv[1] === 'exec')
    expect(wrapped.map((argv) => argv.slice(0, 5))).toEqual([['fnm', 'exec', '--using=22.11.0', '--', 'pnpm'], ['fnm', 'exec', '--using=22.11.0', '--', 'node']])
    expect(wrapped[0]).toEqual(['fnm', 'exec', '--using=22.11.0', '--', 'pnpm', 'install', '--frozen-lockfile'])
    expect(proof.evidence.project[0]).toMatchObject({ id: 'verify', status: 'passed', verdict: 'unit-verified' })
    expect(proof.notes).toContain('ran under Node 22.11.0 (pinned by the repo) via fnm')
  })

  it('a missing module or a wrong engine is blocked: environment, not a failed outcome of the change', async () => {
    const repo = await makeRepo()
    const { runner } = recordingRunner()
    const cfg = config(DOD.replace(/command: \[node.*\n/, 'command: [node, -e, "require(\'agentskit-module-that-is-not-installed\')"]\n'))
    const proof = await proveFleetDod({ runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null })
    expect(proof.evidence.project[0]).toMatchObject({ id: 'verify', status: 'failed', verdict: 'blocked' })
    expect(proof.evidence.project[0]?.evidence).toMatch(/^blocked: environment — .*Cannot find module 'agentskit-module-that-is-not-installed'/)
    const assessed = assessDod({ config: cfg, contract: null, evidence: proof.evidence, prFiles: proof.changedFiles, fileContents: proof.fileContents })
    expect([assessed.blocked, assessed.failed]).toEqual([['verify'], []])

    const engine = await makeRepo({ 'package.json': '{}\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
    const wrongEngine: CommandRunner = { run: async (argv, options) => argv[0] === 'pnpm' ? { code: 1, stdout: '', stderr: ' ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)\nExpected version: 22', timedOut: false, durationMs: 1 } : real.run(argv, { timeoutMs: 60_000, ...(options?.cwd ? { cwd: options.cwd } : {}) }) }
    const installed = await proveFleetDod({ runner: wrongEngine, config: config(), root: engine.root, stateDir: engine.stateDir, head: engine.head, base: engine.base, contract: null })
    expect(installed.evidence.project[0]).toMatchObject({ id: 'verify', status: 'failed', verdict: 'blocked' })
    expect(installed.evidence.project[0]?.evidence).toContain('blocked: environment — ERR_PNPM_UNSUPPORTED_ENGINE')
  })

  /** A fleet that queues one task and answers with whatever `output` holds when read. */
  const fakeFleet = () => {
    const submitted: { base: string; brief: string }[] = []
    const removed: string[] = []
    let output = ''
    let state: 'running' | 'done' | 'failed' = 'running'
    const connector: RunnerConnector = {
      id: 'fleet',
      createWorkspace: async ({ branch, baseBranch }) => { submitted.push({ base: baseBranch, brief: '' }); return { id: `ws-${submitted.length}`, path: '', branch, terminal: null } },
      removeWorkspace: async ({ id }) => { removed.push(id) },
      launchAgent: async ({ workspace }) => workspace.id,
      send: async ({ text }) => { const last = submitted.at(-1); if (last) last.brief = text; return { delivered: true, detail: `submitted q-00${submitted.length}` } },
      readScreen: async () => output,
      schedule: async () => [],
      observeWorkspaces: async () => submitted.map((_, index) => ({ id: `ws-${index + 1}`, pullRequest: null, state })),
    }
    return { connector, submitted, removed, answer: (text: string, next: typeof state = 'done') => { output = text; state = next } }
  }
  const nonceOf = (brief: string): string => /exactly `([^`]+)`/.exec(brief)?.[1] ?? ''
  const resultLine = (head: string, nonce: string, items: readonly { id: string; exitCode: number | null; tail: string }[]) => `LOOP-VERIFY-RESULT: ${JSON.stringify({ head, nonce, items })}`
  const quiet: ControlMachineGate = async (work) => ({ ran: true, value: await work() })

  it('no CI: the verify runs as a fleet task on the PR head, and its result is the verdict (fleet-verified, task id as evidence)', async () => {
    const repo = await makeRepo()
    const { runner, calls } = recordingRunner()
    const cfg = config()
    const fleet = fakeFleet()
    const input = { runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: contract({ kind: 'test', command: 'pnpm test' }), ci: null, fleet: { connector: fleet.connector, issue: 'ISSUE-1', now: new Date('2026-10-25T14:00:00Z') }, controlMachine: quiet }
    const first = await proveFleetDod(input)
    expect(first.waiting).toMatch(/fleet verify task q-001 submitted/)
    expect(fleet.submitted).toHaveLength(1)
    expect(fleet.submitted[0]?.base).toBe(repo.head)
    expect(fleet.submitted[0]?.brief).toContain('read-only')
    expect(fleet.submitted[0]?.brief).toContain('`o1`: `pnpm test`')
    // Nothing ran on this machine.
    expect(calls.some((call) => call.argv[0] === 'node' || call.argv[0] === 'sh')).toBe(false)

    const again = await proveFleetDod(input)
    expect(again.waiting).toMatch(/waiting for fleet verify task q-001/)
    expect(fleet.submitted).toHaveLength(1)

    const nonce = nonceOf(fleet.submitted[0]?.brief ?? '')
    fleet.answer(`noise\n${resultLine(repo.head, nonce, [{ id: 'verify', exitCode: 0, tail: 'check ok' }, { id: 'o1', exitCode: 1, tail: '1 test failed' }])}\n`)
    const done = await proveFleetDod(input)
    expect(done.waiting).toBeUndefined()
    expect(done.evidence.project[0]).toMatchObject({ id: 'verify', status: 'passed', verdict: 'fleet-verified' })
    expect(done.evidence.project[0]?.evidence).toContain('fleet task q-001 ran')
    expect(done.evidence.outcomes[0]).toMatchObject({ id: 'o1', status: 'failed', verdict: 'failed' })
    expect(fleet.removed).toEqual(['ws-1'])
    const assessed = assessDod({ config: cfg, contract: input.contract, evidence: done.evidence, prFiles: done.changedFiles, fileContents: done.fileContents, minVerdict: 'unit-verified' })
    expect([assessed.lines.find((line) => line.id === 'verify')?.verdict, assessed.failed]).toEqual(['fleet-verified', ['o1']])
    // A judged head is not submitted again.
    await proveFleetDod(input)
    expect(fleet.submitted).toHaveLength(1)
    expect(calls.some((call) => call.argv[0] === 'node' || call.argv[0] === 'sh')).toBe(false)
    expect(leftovers(repo.stateDir)).toEqual([])
  })

  it('a fleet task that ends without a result is blocked, not passed', async () => {
    const repo = await makeRepo()
    const { runner } = recordingRunner()
    const fleet = fakeFleet()
    const input = { runner, config: config(), root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null, fleet: { connector: fleet.connector, issue: 'ISSUE-1', now: new Date() }, controlMachine: quiet }
    await proveFleetDod(input)
    fleet.answer('LOOP-VERIFY-RESULT: {"head":"0000000","nonce":"someone-elses","items":[]}', 'failed')
    const proof = await proveFleetDod(input)
    expect(proof.evidence.project[0]).toMatchObject({ id: 'verify', status: 'failed', verdict: 'blocked' })
    expect(proof.evidence.project[0]?.evidence).toContain('q-001 failed before it printed a result')
  })

  it('a localOnly item runs here only through the control-machine gate, and waits (not fails) while it is shut', async () => {
    const repo = await makeRepo()
    const { runner, calls } = recordingRunner()
    const cfg = config(`${DOD}connectors:\n  fleet:\n    localOnly: [verify]\n`)
    const fleet = fakeFleet()
    let open = false
    const gate: ControlMachineGate = async (work) => open ? { ran: true, value: await work() } : { ran: false, detail: 'waiting: control machine busy (load 3.10/core ≥ 1)' }
    const input = { runner, config: cfg, root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null, fleet: { connector: fleet.connector, issue: 'ISSUE-1', now: new Date() }, controlMachine: gate }
    const shut = await proveFleetDod(input)
    expect(shut.waiting).toBe('waiting: control machine busy (load 3.10/core ≥ 1) — local-only: verify')
    expect(shut.evidence).toEqual({ project: [], outcomes: [] })
    expect(calls.some((call) => call.argv[0] === 'node')).toBe(false)
    // Nothing else needed the fleet.
    expect(fleet.submitted).toEqual([])
    open = true
    const ran = await proveFleetDod(input)
    expect(ran.evidence.project[0]).toMatchObject({ id: 'verify', status: 'passed', verdict: 'unit-verified' })
    expect(calls.find((call) => call.argv[0] === 'node')?.cwd).toContain('fleet-checkout-')
  })

  it('does not install when nothing needs a command, and removes the worktree when the checkout itself fails', async () => {
    const repo = await makeRepo({ 'package.json': '{}\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
    const quiet = recordingRunner()
    await proveFleetDod({ runner: quiet.runner, config: config(DOD.replace(/ {4}- id: verify[\s\S]*?(?= {4}- id: test-for-new-code)/, '')), root: repo.root, stateDir: repo.stateDir, head: repo.head, base: repo.base, contract: null })
    expect(quiet.calls.some((call) => call.argv[0] === 'pnpm')).toBe(false)
    expect(leftovers(repo.stateDir)).toEqual([])

    const { runner } = recordingRunner()
    await expect(proveFleetDod({ runner, config: config(), root: repo.root, stateDir: repo.stateDir, head: 'f'.repeat(40), contract: null })).rejects.toThrow(/could not check out/)
    expect(leftovers(repo.stateDir)).toEqual([])
    expect(await worktrees(repo.root)).toBe(1)
  })
})
