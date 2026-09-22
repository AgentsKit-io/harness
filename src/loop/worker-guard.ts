import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { touchesProtectedPaths } from '../adapters/github-cli.js'
import { shellQuote } from './automations.js'
import type { LoopConfig } from './config.js'

/**
 * The subset of a `PreToolUse` hook event this cares about. Claude Code and Grok Build CLI (`xai-org/grok-build`)
 * emit the same shape on stdin — confirmed byte-compatible, deliberately, by both projects — so one parser and
 * one decision function cover both.
 */
export interface PreToolUseEvent {
  readonly tool_name?: string
  readonly tool_input?: Readonly<Record<string, unknown>>
  readonly cwd?: string
}

/**
 * Tool names whose `tool_input.file_path` names the file about to be written. A `Bash` call that writes a
 * protected file by shelling out (`echo secret > .env`) is not caught here — neither is it caught by the PR-time
 * gate this mirrors (`touchesProtectedPaths` there only ever sees the PR's changed-file list, never how a file
 * got that way), so this is the same scope as the gate it backs up, not a narrower one.
 */
const GUARDED_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export const parsePreToolUseEvent = (raw: string): PreToolUseEvent | null => {
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null ? value as PreToolUseEvent : null
  } catch { return null }
}

/**
 * The file a guarded tool call is about to touch, or `null` for a tool this check has no opinion on.
 *
 * `NotebookEdit` names its target `notebook_path`, not `file_path`: reading only the latter made the notebook
 * matcher enforce nothing at all, which is worse than not matching it, because the hook still reported success.
 */
export const extractFilePath = (event: PreToolUseEvent): string | null => {
  if (!event.tool_name || !GUARDED_TOOLS.has(event.tool_name)) return null
  const path = event.tool_input?.['file_path'] ?? event.tool_input?.['notebook_path']
  return typeof path === 'string' && path.trim() ? path : null
}

export interface WorkerGuardVerdict { readonly blocked: boolean; readonly reason: string | null }

/**
 * The same judgement `deliver.ts` makes on a PR's changed files (`protectedFiles`/`secretShapedFiles`), applied
 * to one file path before it is even written. One rule, two enforcement points: this one during the work, that
 * one as the backstop for whatever a hook missed, failed on, or was never installed for.
 */
export const assessWorkerGuard = (input: {
  readonly filePath: string | null
  readonly cwd: string
  readonly selfEditPaths: readonly string[]
  readonly secretFilePatterns: readonly string[]
}): WorkerGuardVerdict => {
  if (!input.filePath) return { blocked: false, reason: null }
  const relativePath = isAbsolute(input.filePath) ? relative(input.cwd, input.filePath) : input.filePath
  if (relativePath.startsWith('..')) return { blocked: false, reason: null } // outside the worktree: not this check's business
  const protected_ = touchesProtectedPaths([relativePath], input.selfEditPaths)
  if (protected_.length) return { blocked: true, reason: `${relativePath} matches a protected path (delivery.selfEditPaths)` }
  const secret = touchesProtectedPaths([relativePath], input.secretFilePatterns)
  if (secret.length) return { blocked: true, reason: `${relativePath} matches a secret-shaped filename (delivery.secretFilePatterns)` }
  return { blocked: false, reason: null }
}

/** Parses stdin, judges it, and says what the CLI should do: exit code and, on a block, the stderr line. */
export const runWorkerGuard = (stdin: string, config: LoopConfig, fallbackCwd: string): { readonly exitCode: number; readonly message: string | null } => {
  const event = parsePreToolUseEvent(stdin)
  if (!event) return { exitCode: 0, message: null } // unparseable input is not this check's problem to fail closed over
  const verdict = assessWorkerGuard({
    filePath: extractFilePath(event),
    cwd: event.cwd ?? fallbackCwd,
    selfEditPaths: config.delivery.selfEditPaths,
    secretFilePatterns: config.delivery.secretFilePatterns,
  })
  return verdict.blocked ? { exitCode: 2, message: verdict.reason } : { exitCode: 0, message: null }
}

// ---------------------------------------------------------------------------------------------------------------
// Installing the hook into a fresh worktree, one provider at a time. `claude` and `grok` get the shared
// PreToolUse hook shape; `opencode` gets static deny rules (its own declarative permission engine, no
// subprocess) because its `ask`-under-no-TTY behavior is unresolved upstream — see ADR-0038. `codex` and any
// other provider are left alone: the PR-time gate is their only enforcement for now.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The existing config to merge into, or `null` when there is a file here that cannot be parsed. `null` means
 * "leave it alone": rewriting a file whose contents we could not read would silently destroy a project's own
 * `opencode.json` over a trailing comma. The dispatch then runs without this guard and says so — the PR-time
 * gate is still there, and a guard that ate the project's config would be a worse trade than one that is absent.
 */
const readJsonObject = (path: string): Record<string, unknown> | null => {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

const writeJsonObject = (path: string, value: Record<string, unknown>): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

interface HookEntry { readonly matcher?: string; readonly hooks: readonly { readonly type: string; readonly command: string }[] }

/** Claude Code and Grok's own `hooks.PreToolUse` array, our entry appended once — never duplicated on a re-install (dispatch retry, a provider handoff into the same worktree). */
const mergePreToolUseHook = (existing: Record<string, unknown>, command: string): Record<string, unknown> => {
  const hooks = (existing['hooks'] && typeof existing['hooks'] === 'object' ? existing['hooks'] as Record<string, unknown> : {}) as { PreToolUse?: readonly HookEntry[] }
  const preToolUse: readonly HookEntry[] = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  const alreadyInstalled = preToolUse.some((entry) => entry.hooks.some((hook) => hook.command === command))
  const entry: HookEntry = { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command }] }
  return { ...existing, hooks: { ...hooks, PreToolUse: alreadyInstalled ? preToolUse : [...preToolUse, entry] } }
}

/** opencode's declarative `permission.edit` rules, one `deny` per protected/secret pattern — additive, never overwrites a rule the project already declared for the same pattern. */
const mergeOpencodeDenyRules = (existing: Record<string, unknown>, patterns: readonly string[]): Record<string, unknown> => {
  const permission = (existing['permission'] && typeof existing['permission'] === 'object' ? existing['permission'] as Record<string, unknown> : {})
  const edit = (permission['edit'] && typeof permission['edit'] === 'object' ? permission['edit'] as Record<string, unknown> : {})
  const nextEdit = { ...edit }
  for (const pattern of patterns) if (!(pattern in nextEdit)) nextEdit[pattern] = 'deny'
  return { ...existing, permission: { ...permission, edit: nextEdit } }
}

/**
 * The exact installed harness build the hook keeps calling, immune to whatever `@agentskit/harness` version is
 * on PATH by the time the hook actually fires (which can be long after dispatch, and long after an upgrade
 * elsewhere on the machine). `realpathSync` follows every symlink pnpm/npm put in the way, so a version-pinned
 * package manager (pnpm's content-addressable store, in particular) pins this to the exact version that was
 * running at dispatch time, not "whatever `ak-harness` resolves to right now".
 */
const resolveOwnCliPath = (): string => realpathSync(process.argv[1] ?? 'ak-harness')

export type WorkerGuardInstallOutcome = { readonly installed: false } | { readonly installed: true; readonly path: string }

export const installWorkerGuard = (input: { readonly worktreePath: string; readonly provider: string; readonly config: LoopConfig; readonly cliPath?: string }): WorkerGuardInstallOutcome => {
  if (!input.config.delivery.workerGuard.enabled) return { installed: false }
  // A dispatch record that lost its worktree path (deliver.ts handles exactly that case when it reads phase
  // artifacts) would otherwise throw here and fail the whole handoff, which is how a guard becomes an outage.
  if (!input.worktreePath) return { installed: false }
  // Quoted: an install prefix with a space (`C:\Users\First Last\...`, `Application Support`) would otherwise
  // split into two shell words, the hook would exit 127, and every CLI here treats a non-2 exit as "allow" —
  // enforcement that reports itself installed and blocks nothing.
  const command = `${shellQuote(input.cliPath ?? resolveOwnCliPath())} loop worker-guard`
  const write = (path: string, merge: (existing: Record<string, unknown>) => Record<string, unknown>): WorkerGuardInstallOutcome => {
    const existing = readJsonObject(path)
    if (!existing) return { installed: false }
    writeJsonObject(path, merge(existing))
    return { installed: true, path }
  }
  if (input.provider === 'claude') return write(join(input.worktreePath, '.claude', 'settings.local.json'), (existing) => mergePreToolUseHook(existing, command))
  if (input.provider === 'grok') return write(join(input.worktreePath, '.grok', 'hooks', 'config.json'), (existing) => mergePreToolUseHook(existing, command))
  if (input.provider === 'opencode') {
    const patterns = [...input.config.delivery.selfEditPaths, ...input.config.delivery.secretFilePatterns]
    return write(join(input.worktreePath, 'opencode.json'), (existing) => mergeOpencodeDenyRules(existing, patterns))
  }
  return { installed: false } // codex (open upstream hook-enforcement bugs) and anything else: PR-time gate only, see ADR-0038
}
