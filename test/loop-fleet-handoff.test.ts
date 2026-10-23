import { splitLines } from '@agentskit/cross-platform'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLoopConfigText } from '../src/index.js'
import type { TaskContract } from '../src/index.js'
import { proveFleetDod } from '../src/loop/fleet-dod.js'
import { handoffRoot, stripHandoff } from '../src/loop/fleet-handoff.js'
import { createProcessRunner } from '../src/loop/process.js'
import { initializeGitRepository } from './git.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const runner = createProcessRunner()
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await runner.run(['git', '-C', cwd, ...args], { timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
const files = async (cwd: string, rev: string): Promise<string[]> => splitLines(await git(cwd, 'ls-tree', '-r', '--name-only', rev)).filter(Boolean)

const VERIFY = JSON.stringify({ ranAt: '2026-10-20T00:00:00Z', command: 'by hand', exitCode: 0, outcomes: [{ id: 'o1', status: 'passed', evidence: 'looked at it' }] })
const SPEC = ['specs/ISSUE-1/requirements.md', 'specs/ISSUE-1/design.md', 'specs/ISSUE-1/tasks.md']

/** A clone, a bare "origin", and a collected commit that carries product code, the rendered spec and the worker's handoff. */
const makeRepo = async (handoff: Record<string, string> = { '.ak-loop/verify.json': VERIFY, '.ak-loop/dod.json': '{"project":[],"outcomes":[]}', '.ak-loop/plan.md': '# plan\n' }) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-fleet-handoff-')); cleanups.push(dir)
  const root = join(dir, 'clone'); const origin = join(dir, 'origin.git'); const stateDir = join(dir, 'state')
  mkdirSync(root)
  initializeGitRepository(root)
  await git(root, 'config', 'commit.gpgsign', 'false')
  await git(dir, 'init', '--bare', '--quiet', origin)
  await git(root, 'remote', 'add', 'origin', origin)
  const base = await git(root, 'rev-parse', 'HEAD')
  const write = (file: string, content: string): void => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content) }
  write('src/a.ts', 'export const a = 1\n')
  for (const spec of SPEC) write(spec, `# ${spec}\n`)
  for (const [file, content] of Object.entries(handoff)) write(file, content)
  await git(root, 'add', '-A', '-f'); await git(root, 'commit', '-m', 'work')
  const head = await git(root, 'rev-parse', 'HEAD')
  await git(root, 'branch', 'person/issue-1')
  await git(root, 'checkout', '--quiet', base)
  return { root, origin, stateDir, base, head }
}

describe('fleet: .ak-loop handoff files stay out of the PR', () => {
  it('reads the handoff from the collected commit, then pushes a branch with no .ak-loop path and the spec files intact', async () => {
    const repo = await makeRepo()
    const stripped = await stripHandoff({ runner, root: repo.root, stateDir: repo.stateDir, issue: 'ISSUE-1', rev: 'refs/heads/person/issue-1' })
    expect(stripped?.removed.toSorted()).toEqual(['.ak-loop/dod.json', '.ak-loop/plan.md', '.ak-loop/verify.json'])
    if (!stripped) throw new Error('nothing stripped')
    // One commit on top of the worker's: its history is kept, only the handoff paths are gone.
    expect(await git(repo.root, 'rev-parse', `${stripped.head}^`)).toBe(repo.head)
    expect(await git(repo.root, 'log', '-1', '--format=%s', stripped.head)).toBe('chore(loop): remove .ak-loop/ handoff files')

    await git(repo.root, 'update-ref', 'refs/heads/person/issue-1', stripped.head)
    await git(repo.root, 'push', 'origin', 'refs/heads/person/issue-1:refs/heads/person/issue-1')
    const pushed = await files(repo.origin, 'person/issue-1')
    expect(pushed.filter((file) => file.startsWith('.ak-loop/'))).toEqual([])
    expect(pushed).toEqual(expect.arrayContaining([...SPEC, 'src/a.ts']))
    expect(await git(repo.root, 'diff', '--name-only', `${repo.base}...${stripped.head}`)).not.toContain('.ak-loop')

    // The evidence is not lost: the state dir keeps it, laid out like a worktree.
    expect(readFileSync(join(handoffRoot(repo.stateDir, 'ISSUE-1'), '.ak-loop', 'verify.json'), 'utf8')).toBe(VERIFY)
    expect(readdirSync(repo.stateDir).filter((name) => name.startsWith('fleet-strip-'))).toEqual([])
    expect(splitLines(await git(repo.root, 'worktree', 'list')).length).toBe(1)
  })

  it('the definition of done still reads the evidence, from the kept copy, on the head that has no .ak-loop', async () => {
    const repo = await makeRepo()
    const stripped = await stripHandoff({ runner, root: repo.root, stateDir: repo.stateDir, issue: 'ISSUE-1', rev: repo.head })
    if (!stripped) throw new Error('nothing stripped')
    const contract = { intent: 'x', scope: { inScope: ['a'], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'works', check: { kind: 'manual', note: 'eyeball it' } }], ambiguities: [], touchpoints: [], risks: [] } as TaskContract
    const proof = await proveFleetDod({ runner, config: parseLoopConfigText(exampleYaml), root: repo.root, stateDir: repo.stateDir, handoff: handoffRoot(repo.stateDir, 'ISSUE-1'), head: stripped.head, base: repo.base, contract })
    expect(proof.evidence.outcomes).toEqual([{ id: 'o1', status: 'passed', evidence: 'looked at it' }])
    expect(proof.changedFiles.some((file) => file.startsWith('.ak-loop/'))).toBe(false)
  })

  it('an open PR whose head carries .ak-loop paths gets the removal commit, fetched from the remote when the clone lacks it', async () => {
    const repo = await makeRepo()
    await git(repo.root, 'push', 'origin', `${repo.head}:refs/heads/person/issue-1`)
    await git(repo.origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    await git(repo.root, 'branch', '-D', 'person/issue-1')
    await git(repo.root, 'reflog', 'expire', '--expire=now', '--all'); await git(repo.root, 'gc', '--prune=now', '--quiet')
    const stripped = await stripHandoff({ runner, root: repo.root, stateDir: repo.stateDir, issue: 'ISSUE-1', rev: repo.head })
    if (!stripped) throw new Error('nothing stripped')
    await git(repo.root, 'push', 'origin', `${stripped.head}:refs/heads/person/issue-1`)
    expect((await files(repo.origin, 'person/issue-1')).filter((file) => file.startsWith('.ak-loop/'))).toEqual([])
    expect(existsSync(join(handoffRoot(repo.stateDir, 'ISSUE-1'), '.ak-loop', 'verify.json'))).toBe(true)
    // A second pass finds nothing left to remove.
    expect(await stripHandoff({ runner, root: repo.root, stateDir: repo.stateDir, issue: 'ISSUE-1', rev: stripped.head })).toBeNull()
  })

  it('a commit with no .ak-loop path is left alone', async () => {
    const repo = await makeRepo({})
    expect(await stripHandoff({ runner, root: repo.root, stateDir: repo.stateDir, issue: 'ISSUE-1', rev: repo.head })).toBeNull()
    expect(existsSync(handoffRoot(repo.stateDir, 'ISSUE-1'))).toBe(false)
  })
})
