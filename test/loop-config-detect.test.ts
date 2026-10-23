import { runCommand } from '@agentskit/cross-platform'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDebriefReport, configSources, describeConfigSource, installLoopAutomations, loadLoopConfig, renderDebriefMarkdown } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'
import { detectTestGlob, detectVerifyCommand, findGitDir, parseRemote } from '../src/loop/detect.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const git = async (dir: string, ...args: string[]): Promise<void> => {
  const result = await runCommand('git', ['-C', dir, ...args])
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

/** A real git repository (as `git clone` leaves it: origin remote and remote HEAD), holding `files`; no loop.config.yaml unless given. */
const repo = async (files: Readonly<Record<string, string>>, remote = 'git@github.com:Acme/Web-Shop.git', head = 'develop'): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-detect-')); cleanups.push(dir)
  await git(dir, 'init', '-q')
  await git(dir, 'remote', 'add', 'origin', remote)
  await git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${head}`)
  for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content) }
  return dir
}

const pkg = (value: Record<string, unknown>): string => JSON.stringify(value)
const noGlobal = { AK_HARNESS_NO_GLOBAL: '1' }

describe('a repository without loop.config.yaml', () => {
  it('runs a JS monorepo on built-ins plus what it detects: remote, branch, fleet project, preset, verify command, tests', async () => {
    const dir = await repo({
      'package.json': pkg({ name: 'shop', private: true, scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'vitest', dev: 'vite' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'pnpm-workspace.yaml': 'packages: [packages/*]\n',
      'packages/cart/src/cart.test.ts': 'test()\n',
      'packages/cart/src/cart.ts': 'export {}\n',
    })
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_CONFIG: join(dir, 'no-such-harness.yaml') })
    const { config } = loaded
    expect(loaded.projectFile).toBe(false)
    expect(loaded.globalPath).toBeUndefined()
    expect(config.project).toMatchObject({ name: 'Web-Shop', repo: 'Acme/Web-Shop', baseBranch: 'develop', stateDir: '.ak-loop' })
    expect(config.connectors).toMatchObject({ tracker: 'github', scm: 'github', fleet: { project: 'github:acme/web-shop' } })
    expect(loaded.detectedPreset).toBe('monorepo')
    expect(config.delivery.verifyCommand).toBe('pnpm run lint && pnpm run typecheck && pnpm run test')
    // The preset's `pnpm verify` item is a guess this repository cannot pass; the test glob is the real one.
    expect(config.dod.items.find((item) => item.kind === 'command')).toBeUndefined()
    expect(config.dod.items.find((item) => item.id === 'test-for-new-code')?.glob).toBe('**/*.test.ts')
    // Global absent → the built-in models.
    expect(config.models.builder).toEqual([['claude/sonnet', 'codex/gpt-5.6-luna']])
    expect(loaded.provenance?.['models.builder']).toBe('built-in')
    expect(loaded.provenance?.['project.repo']).toBe('detected')
    expect(loaded.provenance?.['delivery.review.criticalPaths']).toBe('preset:monorepo')
    expect(describeConfigSource(loaded)).toBe('built-in defaults (+ detected, preset monorepo)')
    // The state dir is git-ignored without a commit: .git/info/exclude, never .gitignore.
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('/.ak-loop/')
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
    // Loading again adds nothing twice.
    loadLoopConfig(join(dir, 'loop.config.yaml'), noGlobal)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').split('/.ak-loop/')).toHaveLength(2)
  })

  it('reads a linked worktree through its .git file to the common git dir', async () => {
    const main = await repo({ 'go.mod': 'module x\n' })
    await git(main, 'add', 'go.mod')
    await git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
    const linked = join(main, '..', `${main.split('/').pop()}-wt`); cleanups.push(linked)
    await git(main, 'worktree', 'add', '-q', linked)
    // realpath: on macOS the temp dir is /var, a link to /private/var.
    expect(realpathSync(findGitDir(linked) as string)).toBe(realpathSync(join(main, '.git')))
    const loaded = loadLoopConfig(join(linked, 'loop.config.yaml'), noGlobal)
    expect(loaded.config.project.repo).toBe('Acme/Web-Shop')
    expect(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('/.ak-loop/')
  })

  it('layers the global default under detection for a web app, and asks for tests only where there are some', async () => {
    const dir = await repo({
      'package.json': pkg({ name: 'site', scripts: { check: 'run-s lint test', lint: 'eslint .' }, dependencies: { next: '15.0.0' } }),
      'package-lock.json': '{}\n',
      '.gitignore': '.ak-loop/\n',
    }, 'https://github.com/acme/site.git', 'main')
    const global = join(dir, '..', `${dir.split('/').pop()}-harness.yaml`); cleanups.push(global)
    writeFileSync(global, 'connectors:\n  runner: fleet\ndelivery:\n  maxFixRounds: 4\n')
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_CONFIG: global })
    expect(loaded.globalPath).toBe(global)
    expect(loaded.detectedPreset).toBe('web-app')
    expect(loaded.config.connectors.runner).toBe('fleet')
    expect(loaded.config.connectors.fleet.project).toBe('github:acme/site')
    expect(loaded.config.delivery.verifyCommand).toBe('npm run check')
    expect(loaded.config.delivery.maxFixRounds).toBe(4)
    expect(loaded.provenance?.['delivery.maxFixRounds']).toBe('global')
    expect(loaded.config.dod.items.map((item) => item.id)).toEqual(['no-todo'])
    expect(describeConfigSource(loaded)).toBe('global default (+ detected, preset web-app)')
    // .gitignore already covers it: nothing is added to the exclude file.
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).not.toContain('/.ak-loop/')
  })

  it('refuses a repository with no verify command instead of guessing one', async () => {
    const dir = await repo({ 'package.json': pkg({ name: 'bare', scripts: { start: 'node .' } }), 'README.md': '# bare\n' })
    expect(() => loadLoopConfig(join(dir, 'loop.config.yaml'), noGlobal)).toThrow(/no verify command could be detected.*refuses to guess/)
  })

  it('takes a repo file as an override of one key, and still detects the rest', async () => {
    const dir = await repo({ 'Makefile': 'lint:\n\techo lint\ncheck: lint\n\techo ok\n', 'loop.config.yaml': 'delivery:\n  maxFixRounds: 7\n' }, 'git@github.com:Acme/Pipeline.git', 'trunk')
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), noGlobal)
    expect(loaded.projectFile).toBe(true)
    expect(loaded.config.delivery.maxFixRounds).toBe(7)
    expect(loaded.provenance?.['delivery.maxFixRounds']).toBe('project')
    expect(loaded.config.delivery.verifyCommand).toBe('make check')
    expect(loaded.config.project).toMatchObject({ repo: 'Acme/Pipeline', baseBranch: 'trunk' })
    expect(loaded.config.connectors.fleet.project).toBe('github:acme/pipeline')
    // With a file, detection never adds a preset or DoD the file did not ask for.
    expect(loaded.detectedPreset).toBeUndefined()
    expect(loaded.config.dod.items).toEqual([])
    expect(configSources(loaded)).toEqual([
      'built-in defaults',
      'detected from the repository: project.name, project.repo, project.baseBranch, delivery.verifyCommand, connectors.tracker, connectors.scm, connectors.fleet.project',
      `project ${join(dir, 'loop.config.yaml')}`,
    ])
  })

  it('derives a GitLab fleet project id, and leaves a declared Linear board on Linear', async () => {
    const dir = await repo({ 'go.mod': 'module x\n', 'loop.config.yaml': 'linear:\n  workspaceId: w\n  teamKey: ENG\n  person: me\n' }, 'git@gitlab.com:Acme/Pipeline.git')
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), noGlobal)
    expect(loaded.config.connectors.fleet.project).toBe('gitlab:acme/pipeline')
    expect(loaded.config.connectors.tracker).toBe('linear')
    const github = await repo({ 'go.mod': 'module x\n', 'loop.config.yaml': 'linear:\n  workspaceId: w\n  teamKey: ENG\n  person: me\n' })
    expect(loadLoopConfig(join(github, 'loop.config.yaml'), noGlobal).config.connectors.tracker).toBe('linear')
  })

  it('lets a repo file value win over a detected one', async () => {
    const dir = await repo({ 'go.mod': 'module x\n', 'loop.config.yaml': 'project:\n  name: billing\n  repo: acme/billing\n  baseBranch: main\ndelivery:\n  verifyCommand: make ci\nconnectors:\n  tracker: github\n' })
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), noGlobal)
    expect(loaded.config.project).toMatchObject({ name: 'billing', repo: 'acme/billing', baseBranch: 'main' })
    expect(loaded.config.delivery.verifyCommand).toBe('make ci')
    // A complete file never triggers detection at all.
    expect(loaded.detectedKeys).toEqual([])
  })

  it('still fails on a -f path that does not exist and is not loop.config.yaml (a typo, not a repository without a file)', async () => {
    const dir = await repo({ 'go.mod': 'module x\n' })
    expect(() => loadLoopConfig(join(dir, 'loop.confg.yaml'), noGlobal)).toThrow(/Loop config not found/)
  })

  it('installs Orca automations and shows the source in debrief and status for a repository without a file', async () => {
    const dir = await repo({ 'pyproject.toml': '[project]\nname = "x"\n', 'tests/test_app.py': 'def test(): pass\n' })
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), noGlobal)
    expect(loaded.config.delivery.verifyCommand).toBe('python -m pytest')
    const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result: payload }), stderr: '', timedOut: false, durationMs: 1 })
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv) => { calls.push([...argv]); return argv.join(' ').startsWith('orca automations list') ? ok({ automations: [] }) : ok({}) } }
    const report = await installLoopAutomations({ loaded, runner, provider: 'claude', env: { PATH: '/nonexistent' }, platform: 'linux' })
    expect(report.status).toBe('ok')
    const created = calls.filter((argv) => argv[1] === 'automations' && argv[2] === 'create')
    expect(created).toHaveLength(2)
    expect(created[0]?.join(' ')).toContain(join(dir, 'loop.config.yaml'))
    const debrief = buildDebriefReport({ loaded })
    expect(debrief.configSource).toBe('built-in defaults (+ detected)')
    expect(renderDebriefMarkdown(debrief)).toContain('config: built-in defaults (+ detected)')
  })
})

describe('detection helpers', () => {
  it('reads GitHub and GitLab remotes in https, ssh and scp form', () => {
    expect(parseRemote('git@github.com:Acme/Repo.git')).toEqual({ host: 'github', owner: 'Acme', name: 'Repo' })
    expect(parseRemote('https://github.com/acme/repo')).toEqual({ host: 'github', owner: 'acme', name: 'repo' })
    expect(parseRemote('ssh://git@gitlab.example.com/team/svc.git')).toEqual({ host: 'gitlab', owner: 'team', name: 'svc' })
    expect(parseRemote('https://bitbucket.org/a/b.git')).toBeNull()
  })

  it('builds a test glob from the real test files only', () => {
    expect(detectTestGlob(['src/a.ts', 'README.md'])).toBeNull()
    expect(detectTestGlob(['src/a.spec.tsx', 'test/b.test.ts', 'py/test_c.py'])).toBe('**/{*.spec.tsx,*.test.ts,test_*.py}')
  })

  it('prefers one aggregate script, in order check, ci, verify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-verify-')); cleanups.push(dir)
    writeFileSync(join(dir, 'package.json'), pkg({ scripts: { verify: 'x', ci: 'y', test: 'z' } }))
    writeFileSync(join(dir, 'yarn.lock'), '')
    expect(detectVerifyCommand(dir)).toBe('yarn run ci')
    writeFileSync(join(dir, 'package.json'), pkg({ scripts: { 'check-types': 'tsc', 'test:unit': 'vitest', build: 'tsup' } }))
    expect(detectVerifyCommand(dir)).toBe('yarn run check-types && yarn run test:unit && yarn run build')
  })
})
