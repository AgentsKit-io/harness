import { spawn, type ChildProcess } from 'node:child_process'

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
 * POSIX gets the process group, which is why the callers spawn detached there. Windows has no process group to
 * signal, so the tree is walked by `taskkill /t`; the direct kill stays as the fallback for both.
 */
export const killProcessTree = (child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void => {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch { /* fall through to the direct kill */ }
    try { child.kill(signal) } catch { /* already gone */ }
    return
  }
  // A detached child leads its own group, so the negative pid reaches the wrapper and everything under it.
  try { process.kill(-pid, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
}

/** Spawn options that make `killProcessTree` able to reach a whole tree. Windows has no group to detach into. */
export const detachedForTreeKill = (): boolean => process.platform !== 'win32'
