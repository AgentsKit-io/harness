import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { baseViewPath, ensureBaseView, loadLoopConfig } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = (extra = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-base-view-')); dirs.push(dir)
  const yaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
  writeFileSync(join(dir, 'loop.config.yaml'), `${yaml}${extra}`)
  return loadLoopConfig(join(dir, 'loop.config.yaml'))
}
const git = (fail?: string): CommandRunner & { readonly calls: { argv: string[]; cwd?: string }[] } => {
  const calls: { argv: string[]; cwd?: string }[] = []
  return {
    calls,
    run: async (argv, options): Promise<CommandResult> => {
      calls.push({ argv: [...argv], ...(options?.cwd ? { cwd: options.cwd } : {}) })
      if (fail && argv[1] === fail) return { code: 128, stdout: '', stderr: 'fatal: could not read from remote', timedOut: false, durationMs: 1 }
      return { code: 0, stdout: argv[1] === 'rev-parse' ? 'abc123\n' : '', stderr: '', timedOut: false, durationMs: 1 }
    },
  }
}

describe('ensureBaseView', () => {
  it('fetches the base and creates a detached worktree of origin/<base> under the state dir — never reads the checkout', async () => {
    const loaded = setup()
    const runner = git()
    const view = await ensureBaseView(runner, loaded)
    expect(view).toEqual({ path: baseViewPath(loaded), revision: 'abc123' })
    expect(runner.calls[0]?.argv).toEqual(['git', 'fetch', '--quiet', 'origin', loaded.config.project.baseBranch])
    expect(runner.calls[1]?.argv).toEqual(['git', 'worktree', 'add', '--quiet', '--detach', '--force', baseViewPath(loaded), `origin/${loaded.config.project.baseBranch}`])
  })

  it('resets an existing view hard to the freshly fetched base', async () => {
    const loaded = setup()
    mkdirSync(baseViewPath(loaded), { recursive: true }); writeFileSync(join(baseViewPath(loaded), '.git'), 'gitdir: x')
    const runner = git()
    await ensureBaseView(runner, loaded)
    expect(runner.calls.map((call) => call.argv[1])).toEqual(['fetch', 'checkout', 'clean', 'rev-parse'])
    expect(runner.calls[1]?.cwd).toBe(baseViewPath(loaded))
  })

  it('fails closed when the base cannot be fetched instead of falling back to a stale tree', async () => {
    const loaded = setup()
    await expect(ensureBaseView(git('fetch'), loaded)).rejects.toThrow(/will not read a stale tree/)
  })

  it('runs concurrent refreshes one after another, and a failed one does not block the next', async () => {
    const loaded = setup()
    let active = 0
    let maxActive = 0
    let calls = 0
    const runner: CommandRunner = {
      run: async (argv): Promise<CommandResult> => {
        active += 1; maxActive = Math.max(maxActive, active); calls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        if (calls === 1) return { code: 128, stdout: '', stderr: "fatal: Unable to create 'index.lock': File exists.", timedOut: false, durationMs: 1 }
        return { code: 0, stdout: argv[1] === 'rev-parse' ? 'abc123\n' : '', stderr: '', timedOut: false, durationMs: 1 }
      },
    }
    const results = await Promise.allSettled([ensureBaseView(runner, loaded), ensureBaseView(runner, loaded), ensureBaseView(runner, loaded)])
    expect(maxActive).toBe(1)
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
  })

  it('reads project.root as it is only when asked to', async () => {
    const loaded = setup('\n')
    const root = { ...loaded, config: { ...loaded.config, project: { ...loaded.config.project, orchestratorView: 'root' as const } } }
    const runner = git()
    expect(await ensureBaseView(runner, root)).toEqual({ path: loaded.root, revision: null })
    expect(runner.calls).toEqual([])
  })
})
