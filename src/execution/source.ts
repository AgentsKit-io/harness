import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { hashJson, sha256 } from '../kernel/hash.js'
import { fail } from '../kernel/errors.js'
import type { SourceSnapshot } from '../kernel/types.js'

const execFileAsync = promisify(execFile)
// A failed git call (or output past execFile's 1 MiB default maxBuffer) used to read as '' and hash as
// "unchanged", approving a stale run as current. It now fails closed, with room for any realistic diff.
const git = async (root: string, args: readonly string[]): Promise<string> => {
  try { return (await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })).stdout.trim() } catch (error) { return fail(`git ${args[0] ?? ''} failed: ${error instanceof Error ? error.message : String(error)}`) }
}

/**
 * Whether a `git status --porcelain` line refers to exactly this repository-relative path.
 *
 * Git always prints forward slashes and quotes a path with unusual characters; `path.relative()` returns the
 * platform's separator. Comparing the two directly worked on POSIX and never matched on Windows, where it made
 * the harness's own config file look like a dirty worktree and refused every plan.
 */
export const statusLineIsPath = (line: string, relativePath: string): boolean => {
  const wanted = relativePath.replaceAll('\\', '/')
  if (!wanted) return false
  return line.endsWith(` ${wanted}`) || line.endsWith(` "${wanted}"`)
}

export const sourceSnapshot = async (root: string, stateDir: string): Promise<SourceSnapshot> => {
  const revision = await git(root, ['rev-parse', 'HEAD']).catch(() => '')
  if (!revision) fail('Current-source evidence requires a Git repository with a committed HEAD.', 'GIT_REQUIRED')
  const stateRelative = relative(root, stateDir).replaceAll('\\', '/')
  const pathspec = ['--', '.']
  if (stateRelative && stateRelative !== '..' && !stateRelative.startsWith('../')) pathspec.push(`:(exclude)${stateRelative}`)
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all', ...pathspec])
  const diff = await git(root, ['diff', '--no-ext-diff', '--binary', 'HEAD', ...pathspec])
  const untrackedPaths = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).filter((path) => !stateRelative || (path !== stateRelative && !path.startsWith(`${stateRelative}/`)))
  const untracked = untrackedPaths.map((path) => ({ path, hash: sha256(readFileSync(resolve(root, path))) }))
  const fingerprint = { revision, status, diff, untracked }
  return { revision, status, statusHash: hashJson(fingerprint) }
}
