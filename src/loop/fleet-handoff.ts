import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { ARTIFACT_DIR } from './artifacts.js'

/**
 * A fleet worker commits `.ak-loop/verify.json` and the DoD evidence (`git add -f`) because the harness cannot see its
 * worktree. They are the loop's state, not the product's: left in the PR they merge into the target repository and
 * every later loop PR of that repository conflicts with them.
 */

/** Where the handoff read from a collected commit lives from then on, laid out as `<root>/.ak-loop/<file>` like a worktree. */
export const handoffRoot = (stateDir: string, issue: string): string => join(stateDir, 'fleet-handoff', issue)

const tail = (value: string): string => value.trim().slice(-300)

/**
 * Copy every `.ak-loop/` file of `rev` into the state dir, then add one commit on top of `rev` that removes them.
 * Null when `rev` carries none. The commit is only created, never pushed or moved onto a branch: the caller decides.
 * Spec files (`config.spec.dir`) and everything else stay as committed.
 */
export const stripHandoff = async (input: { readonly runner: CommandRunner; readonly root: string; readonly stateDir: string; readonly issue: string; readonly rev: string }): Promise<{ readonly head: string; readonly removed: readonly string[] } | null> => {
  const { runner, root, stateDir, issue, rev } = input
  const git = (args: readonly string[], cwd: string = root) => runner.run(['git', '-C', cwd, ...args], { timeoutMs: 120_000 })
  let listed = await git(['ls-tree', '-r', '--name-only', rev, '--', ARTIFACT_DIR])
  // A head only the remote has (a PR pushed from elsewhere) is fetched once.
  if (listed.code !== 0) { await git(['fetch', '--quiet', 'origin', rev]); listed = await git(['ls-tree', '-r', '--name-only', rev, '--', ARTIFACT_DIR]) }
  if (listed.code !== 0) throw new Error(`could not list ${ARTIFACT_DIR}/ in ${rev.slice(0, 12)}: ${tail(listed.stderr || listed.stdout)}`)
  const removed = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!removed.length) return null

  const dest = handoffRoot(stateDir, issue)
  rmSync(dest, { recursive: true, force: true })
  for (const file of removed) {
    const content = await git(['show', `${rev}:${file}`])
    if (content.code !== 0) throw new Error(`could not read ${file} from ${rev.slice(0, 12)}: ${tail(content.stderr)}`)
    mkdirSync(dirname(join(dest, file)), { recursive: true })
    writeFileSync(join(dest, file), content.stdout, 'utf8')
  }

  mkdirSync(stateDir, { recursive: true })
  const checkout = mkdtempSync(join(stateDir, 'fleet-strip-'))
  let added = false
  try {
    const created = await git(['worktree', 'add', '--detach', checkout, rev])
    if (created.code !== 0) throw new Error(`could not check out ${rev.slice(0, 12)} to remove ${ARTIFACT_DIR}/: ${tail(created.stderr || created.stdout)}`)
    added = true
    const rm = await git(['rm', '-r', '-q', '-f', '--', ARTIFACT_DIR], checkout)
    if (rm.code !== 0) throw new Error(`git rm ${ARTIFACT_DIR} failed: ${tail(rm.stderr || rm.stdout)}`)
    // ponytail: a fixed identity, so the commit never depends on the clone's git config; the author line says the loop made it.
    const committed = await git(['-c', 'user.name=agentskit-loop', '-c', 'user.email=loop@agentskit.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `chore(loop): remove ${ARTIFACT_DIR}/ handoff files`], checkout)
    if (committed.code !== 0) throw new Error(`git commit failed: ${tail(committed.stderr || committed.stdout)}`)
    const head = await git(['rev-parse', 'HEAD'], checkout)
    if (head.code !== 0) throw new Error(`git rev-parse failed: ${tail(head.stderr)}`)
    return { head: head.stdout.trim(), removed }
  } finally {
    if (added) await git(['worktree', 'remove', '--force', checkout]).catch(() => undefined)
    rmSync(checkout, { recursive: true, force: true })
    await git(['worktree', 'prune']).catch(() => undefined)
  }
}
