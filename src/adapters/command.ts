import { delimiter, isAbsolute, join } from 'node:path'
import { accessSync, constants, existsSync, statSync } from 'node:fs'

export interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly durationMs: number
}

export interface CommandRunOptions {
  readonly timeoutMs?: number
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /**
   * This argv carries a rendered prompt that may be multiple lines (an orchestrator/reviewer/builder headless
   * call — see `renderHeadlessArgv`), and the target CLI reads its prompt from stdin when it is absent from argv
   * (verified for `claude -p`). On Windows, `createProcessRunner` uses this to route any newline-bearing argv
   * element to stdin instead of argv — see its doc comment for why: `cmd.exe`, which a `.cmd`-shim CLI always
   * spawns through, silently truncates any command line at its first embedded newline. Ignored on other
   * platforms and by callers that omit it, so a command with no stdin-reading convention (an internal `gh`/`git`
   * call, a test fixture) is never affected.
   */
  readonly promptOnStdin?: boolean
}

/** Shell-free command execution seam. Adapters receive it; composition supplies the real one; tests supply fakes. */
export interface CommandRunner {
  run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandResult>
}

/** A regular file that the current process can actually execute — not just one that happens to sit at this
 * path. `X_OK` is meaningless on Windows (any existing file passes), which is correct there: PATHEXT is what
 * decides runnability, not a POSIX-style permission bit. */
const executable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

/** Resolve an executable on PATH without spawning a shell. Honours PATHEXT on Windows. */
export const findExecutable = (name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null => {
  if (typeof name !== 'string' || !name.trim()) return null
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) return existsSync(name) && executable(name) ? name : null
  const extensions = platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`)
      if (executable(candidate)) return candidate
    }
    if (platform === 'win32' && executable(join(dir, name))) return join(dir, name)
  }
  return null
}

/** Parse the `{ ok, result }` envelope every `orca … --json` command prints. Returns null when the payload is not an envelope. */
export const parseJsonEnvelope = (stdout: string): { readonly ok: boolean; readonly result: unknown; readonly error?: string } | null => {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as { readonly ok?: unknown; readonly result?: unknown; readonly error?: unknown }
  if (typeof record.ok !== 'boolean') return null
  const error = typeof record.error === 'string' ? record.error : typeof record.error === 'object' && record.error !== null && typeof (record.error as { readonly message?: unknown }).message === 'string' ? (record.error as { readonly message: string }).message : undefined
  return { ok: record.ok, result: record.result, ...(error === undefined ? {} : { error }) }
}
