import spawn from 'cross-spawn'
import type { CommandResult, CommandRunner, CommandRunOptions } from '../adapters/command.js'
import { KILL_GRACE_MS, detachedForTreeKill, killProcessTree } from '../kernel/process-tree.js'

/**
 * Real, shell-free command runner for the loop composition layer. Output is capped.
 *
 * Uses `cross-spawn` instead of `node:child_process`'s `spawn` directly. On Windows, npm's global install of any
 * Node CLI (`claude`, `agentskit-review`, ...) produces a `.cmd` shim; Windows' CreateProcess cannot execute a
 * `.cmd`/`.bat` file without a shell interpreter, so a plain `spawn(command, args, { shell: false })` fails with
 * ENOENT or EINVAL for every such binary, regardless of the path given (verified: bare name -> ENOENT, absolute
 * `.cmd` path -> EINVAL). `cross-spawn` detects this case and re-execs through `cmd.exe /d /s /c` with the same
 * argument escaping Node's own internals use for `shell: true`, so callers keep `shell: false` semantics (no
 * metacharacter interpretation of argv beyond what is needed to survive that one hop) on every platform.
 *
 * That hop is also why a timeout kills the whole tree rather than the direct child: what this runner holds is the
 * `cmd.exe` wrapper, and the real command keeps the inherited pipes open after the wrapper dies, so the `close`
 * event would never arrive. The same is true on POSIX of any CLI that spawns a helper. The grace timer is the
 * last resort — after it the call ends with what it has, rather than never ending.
 */
export const createProcessRunner = (defaults: { readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly env?: NodeJS.ProcessEnv } = {}): CommandRunner => ({
  run: (argv: readonly string[], options: CommandRunOptions = {}): Promise<CommandResult> => new Promise((resolve) => {
    const [command, ...args] = argv
    const started = Date.now()
    if (!command) return resolve({ code: null, stdout: '', stderr: 'empty argv', timedOut: false, durationMs: 0 })
    const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? 30_000
    const maxOutputBytes = defaults.maxOutputBytes ?? 4 * 1_048_576
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (code: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      resolve({ code, stdout, stderr: error ? `${stderr}${stderr ? '\n' : ''}${error}` : stderr, timedOut, durationMs: Date.now() - started })
    }
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? defaults.env ?? process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: detachedForTreeKill() })
    let grace: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
      grace = setTimeout(() => finish(null, `timed out after ${timeoutMs}ms and did not exit when killed`), KILL_GRACE_MS)
    }, timeoutMs)
    // stdio: ['ignore', 'pipe', 'pipe'] guarantees these are real streams; @types/cross-spawn's return type is
    // not narrowed the way node:child_process's own spawn overloads are.
    child.stdout?.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stdout) < maxOutputBytes) stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stderr) < maxOutputBytes) stderr += chunk.toString() })
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
  }),
})
