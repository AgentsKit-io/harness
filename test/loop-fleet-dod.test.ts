import { splitLines } from '@agentskit/cross-platform'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessDod, parseLoopConfigText } from '../src/index.js'
import type { CommandRunner, LoopConfig, TaskContract } from '../src/index.js'
import { proveFleetDod } from '../src/loop/fleet-dod.js'
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
