import { spawn } from 'node:child_process'
import type { CommandResult, CommandRunner, CommandRunOptions } from '../adapters/command.js'

/** Real, shell-free command runner for the loop composition layer. Output is capped; timeouts kill the process group. */
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
    child.stdout.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stdout) < maxOutputBytes) stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stderr) < maxOutputBytes) stderr += chunk.toString() })
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
  }),
})
