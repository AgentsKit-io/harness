import spawn from 'cross-spawn'
import type { CommandResult, CommandRunner, CommandRunOptions } from '../adapters/command.js'

/**
 * Real, shell-free command runner for the loop composition layer. Output is capped; timeouts kill the process group.
 *
 * Uses `cross-spawn` instead of `node:child_process`'s `spawn` directly. On Windows, npm's global
 * install of any Node CLI (`claude`, `agentskit-review`, ...) produces a `.cmd` shim; Windows'
 * CreateProcess cannot execute a `.cmd`/`.bat` file without a shell interpreter, so a plain
 * `spawn(command, args, { shell: false })` fails with ENOENT or EINVAL for every such binary,
 * regardless of the path given (verified: bare name -> ENOENT, absolute `.cmd` path -> EINVAL).
 * `cross-spawn` detects this case and re-execs through `cmd.exe /d /s /c` with the same argument
 * escaping Node's own internals use for `shell: true`, so callers keep `shell: false` semantics
 * (no metacharacter interpretation of argv beyond what's needed to survive that one hop) on every
 * platform, including the POSIX path this runner already exercised.
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
      resolve({ code, stdout, stderr: error ? `${stderr}${stderr ? '\n' : ''}${error}` : stderr, timedOut, durationMs: Date.now() - started })
    }
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? defaults.env ?? process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    // stdio: ['ignore', 'pipe', 'pipe'] guarantees these are real streams; @types/cross-spawn's
    // return type is not narrowed the way node:child_process's own spawn overloads are.
    child.stdout?.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stdout) < maxOutputBytes) stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stderr) < maxOutputBytes) stderr += chunk.toString() })
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
  }),
})
