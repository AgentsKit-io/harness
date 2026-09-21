import { spawn } from 'node:child_process'
import type { CommandResult, CommandRunner, CommandRunOptions } from '../adapters/command.js'
import { KILL_GRACE_MS, detachedForTreeKill, killProcessTree } from '../kernel/process-tree.js'

/**
 * Real, shell-free command runner for the loop composition layer. Output is capped.
 *
 * A timeout kills the whole tree, not just the direct child: a `.cmd` shim on Windows, or any CLI that spawns a
 * helper, keeps the inherited pipes open after the wrapper dies, and the `close` event would never arrive. The
 * grace timer is the last resort — after it, the call ends with what it has rather than never ending.
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
    child.stdout.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stdout) < maxOutputBytes) stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stderr) < maxOutputBytes) stderr += chunk.toString() })
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
  }),
})
