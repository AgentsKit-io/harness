import type { ChildProcess } from 'node:child_process'
import { killProcessTree as killTree } from '@agentskit/cross-platform'

/** How long to wait, after killing, for the child to actually close before giving up on it. */
export const KILL_GRACE_MS = 2_000

/**
 * Kill a child process **and everything it started**.
 *
 * `child.kill()` signals exactly one process. When the child is a shell (`shell: true`) or a Windows `.cmd`
 * shim, that one process is the wrapper: the real command — the test runner, the provider CLI — survives, keeps
 * the inherited stdout/stderr pipes open, and the `close` event the caller is waiting for never arrives. A
 * timeout then hangs the run instead of ending it, which is the worst shape a timeout can have.
 *
 * `@agentskit/cross-platform` walks the tree (`taskkill /t /f` on Windows, every descendant on POSIX) and falls
 * back to the direct kill when the tree cannot be walked.
 */
export const killProcessTree = (child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void => {
  if (child.pid === undefined) return
  void killTree(child.pid, signal, (sig) => child.kill(sig))
}

/**
 * Callers still spawn detached on POSIX so the child leads its own group and a terminal Ctrl+C does not reach it
 * behind the runner's back. Windows has no group to detach into.
 */
export const detachedForTreeKill = (): boolean => process.platform !== 'win32'
