import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { fail } from '../kernel/errors.js'
import type { LoadedLoopConfig } from './config.js'

/** Where the harness keeps its own read-only checkout of the base branch, inside the (gitignored) state directory. */
export const baseViewPath = (loaded: LoadedLoopConfig): string => join(loaded.stateDir, 'base-view')

export interface BaseView {
  /** The directory the orchestrator's headless calls run in. */
  readonly path: string
  /** `origin/<baseBranch>` as it was fetched, or null under `orchestratorView: root`. */
  readonly revision: string | null
}

/**
 * The tree the orchestrator reads: the base branch as the remote has it now, not whatever the human's checkout
 * happens to hold.
 *
 * Contract generation, the plan interview, the architect and the votes all run a model with read access to the
 * repository, and they used to run it in `project.root`. That is the operator's own checkout — possibly on an
 * unrelated branch, possibly hundreds of commits behind. Observed: an architect, run from a checkout 447 commits
 * behind `origin/main`, designed a module to "create" scripts that had been merged hours earlier, because in the
 * tree it could see they did not exist. Workers never had the problem: each gets a fresh worktree from the base.
 *
 * So the harness keeps one detached worktree of `origin/<baseBranch>` under the state directory, fetches before
 * each use and resets it hard — it is the harness's own, nobody edits it. Failing to fetch is a failure, not a
 * silent fallback to the stale tree; `project.orchestratorView: root` restores the old behaviour on purpose.
 */
export const ensureBaseView = async (runner: CommandRunner, loaded: LoadedLoopConfig): Promise<BaseView> => {
  const { project } = loaded.config
  if (project.orchestratorView === 'root') return { path: loaded.root, revision: null }
  const git = async (args: readonly string[], cwd: string, what: string): Promise<string> => {
    const outcome = await runner.run(['git', ...args], { cwd, timeoutMs: 120_000 })
    if (outcome.timedOut || outcome.code !== 0) {
      return fail(`Base view: ${what} failed (${outcome.timedOut ? 'timed out' : `exit ${outcome.code ?? 'null'}`}): ${`${outcome.stderr}\n${outcome.stdout}`.trim().slice(0, 300)}. The orchestrator will not read a stale tree; fix the remote access or set project.orchestratorView: root.`, 'GIT_REQUIRED')
    }
    return outcome.stdout.trim()
  }
  const ref = `origin/${project.baseBranch}`
  const path = baseViewPath(loaded)
  await git(['fetch', '--quiet', 'origin', project.baseBranch], loaded.root, `git fetch origin ${project.baseBranch}`)
  if (existsSync(join(path, '.git'))) {
    await git(['checkout', '--quiet', '--detach', '--force', ref], path, `checkout ${ref}`)
    await git(['clean', '-fdq'], path, 'clean')
  } else {
    await git(['worktree', 'add', '--quiet', '--detach', '--force', path, ref], loaded.root, `worktree add ${ref}`)
  }
  const revision = await git(['rev-parse', 'HEAD'], path, 'rev-parse')
  return { path, revision: revision || null }
}
