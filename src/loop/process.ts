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
 *
 * On Windows, that `cmd.exe` hop also breaks any argv element containing a literal newline: cross-spawn joins
 * `command` and every arg into one string and hands it to `cmd.exe /d /s /c "<that string>"` — cmd.exe's line
 * parser then reads only up to the first newline in that string and silently drops the rest, so a multi-line
 * prompt (every orchestrator/reviewer/builder headless call renders one — see `renderContractPrompt`) reaches
 * the provider CLI truncated to its first line, with no error: exit 0, a plausible-looking reply, no argv-length
 * or quoting complaint. The provider CLI then genuinely has no task to act on and asks a clarifying question
 * ("what would you like me to work on") or errors on the now-missing markers — which surfaces upstream as
 * `HARNESS_ERROR: Orchestrator output contains no contract block.`, indistinguishable from a real model
 * non-compliance failure. Reproduced directly: `cross-spawn`'s own escaping (`lib/util/escape.js`) never
 * touches `\n`, and cmd.exe fundamentally cannot carry an embedded newline through `/c "<one-line command>"` —
 * there is no quoting that survives it. POSIX `spawn` passes argv untouched, so this is Windows-only.
 *
 * Fix: when the caller marks the call with `promptOnStdin` (set only at the three headless-prompt call sites —
 * `generateContract`, `plan-stage`, `plan-vote` — never for an arbitrary internal command), pull any argv
 * element(s) containing `\n` out of argv on Windows before spawning and write them to the child's stdin instead,
 * newline-joined if there is more than one. A CLI whose positional prompt argument is missing conventionally
 * reads it from stdin (verified for `claude -p`) — every provider in `loop.config.example.yaml` uses that same
 * `-p`/`exec ... "{prompt}"` shape. A CLI that does not follow the convention now fails loudly with its own
 * "missing argument" usage error instead of silently answering a truncated first line — strictly better than
 * today's failure mode either way. Opt-in and Windows-only so every other caller (an internal `gh`/`git`
 * invocation, a test fixture that happens to pass a multi-line script to `node -e`) is completely unaffected —
 * POSIX `spawn` never had this bug, and a plain `.exe` on Windows does not go through the `cmd.exe` hop that
 * causes it, but this runner has no cheap, dependency-internals-free way to tell that case apart from a `.cmd`
 * shim before spawning, so the flag stays scoped to callers who know their argv is a rendered prompt.
 */
const extractMultilineArgs = (args: readonly string[]): { readonly args: readonly string[]; readonly stdin: string | null } => {
  const multiline = args.filter((arg) => arg.includes('\n'))
  if (!multiline.length) return { args, stdin: null }
  return { args: args.filter((arg) => !arg.includes('\n')), stdin: multiline.join('\n\n') }
}

export const createProcessRunner = (defaults: { readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly env?: NodeJS.ProcessEnv } = {}): CommandRunner => ({
  run: (argv: readonly string[], options: CommandRunOptions = {}): Promise<CommandResult> => new Promise((resolve) => {
    const [command, ...rawArgs] = argv
    const started = Date.now()
    if (!command) return resolve({ code: null, stdout: '', stderr: 'empty argv', timedOut: false, durationMs: 0 })
    const { args, stdin } = options.promptOnStdin && process.platform === 'win32' ? extractMultilineArgs(rawArgs) : { args: rawArgs, stdin: null }
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
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? defaults.env ?? process.env, shell: false, stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, detached: detachedForTreeKill() })
    if (stdin !== null) child.stdin?.end(stdin)
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
