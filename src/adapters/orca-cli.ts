import { fail } from '../kernel/errors.js'
import { parseJsonEnvelope, type CommandRunner } from './command.js'

export interface OrcaCliOptions { readonly bin?: string; readonly timeoutMs?: number; readonly cwd?: string }

export interface OrcaStatus {
  readonly appRunning: boolean
  readonly runtimeReady: boolean
  readonly runtimeState: string
  readonly appVersion: string | null
  readonly runtimeId: string | null
}

export interface OrcaWorktree {
  readonly id: string
  readonly repoId: string
  readonly repo: string
  readonly path: string
  readonly branch: string
  readonly displayName: string
  readonly workspaceStatus: string
  readonly isArchived: boolean
  readonly isMainWorktree: boolean
  readonly liveTerminalCount: number
  readonly lastActivityAt: number | null
  readonly linkedLinearIssue: string | null
  readonly comment: string
}

export type OrcaAgentHookState = 'installed' | 'not_installed' | 'unknown'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

export const compareVersions = (left: string, right: string): number => {
  const parse = (value: string): number[] => value.trim().split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [a, b] = [parse(left), parse(right)]
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

export const parseOrcaVersion = (stdout: string): string | null => stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null

export const parseOrcaStatus = (result: unknown): OrcaStatus => {
  const record = isRecord(result) ? result : {}
  const app = isRecord(record['app']) ? record['app'] : {}
  const runtime = isRecord(record['runtime']) ? record['runtime'] : {}
  return {
    appRunning: app['running'] === true,
    runtimeReady: runtime['state'] === 'ready' && runtime['reachable'] === true,
    runtimeState: str(runtime['state'], 'unknown'),
    appVersion: typeof runtime['appVersion'] === 'string' ? runtime['appVersion'] : null,
    runtimeId: typeof runtime['runtimeId'] === 'string' ? runtime['runtimeId'] : null,
  }
}

const linkedLinear = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (isRecord(value)) for (const key of ['identifier', 'id', 'url']) if (typeof value[key] === 'string' && (value[key] as string).trim()) return (value[key] as string).trim()
  return null
}

export const parseOrcaWorktrees = (result: unknown): readonly OrcaWorktree[] => {
  const list = isRecord(result) && Array.isArray(result['worktrees']) ? result['worktrees'] : Array.isArray(result) ? result : []
  return list.filter(isRecord).map((item) => ({
    id: str(item['worktreeId'], str(item['id'])),
    repoId: str(item['repoId']),
    repo: str(item['repo']),
    path: str(item['path']),
    branch: str(item['branch']).replace(/^refs\/heads\//, ''),
    displayName: str(item['displayName']),
    workspaceStatus: str(item['workspaceStatus'], 'unknown'),
    isArchived: item['isArchived'] === true,
    isMainWorktree: item['isMainWorktree'] === true,
    liveTerminalCount: num(item['liveTerminalCount']) ?? 0,
    lastActivityAt: num(item['lastActivityAt']),
    linkedLinearIssue: linkedLinear(item['linkedLinearIssue']),
    comment: str(item['comment']),
  })).filter((item) => item.id)
}

export const parseOrcaAgentHooks = (result: unknown): Readonly<Record<string, OrcaAgentHookState>> => {
  const statuses = isRecord(result) && Array.isArray(result['statuses']) ? result['statuses'] : []
  return Object.fromEntries(statuses.filter(isRecord).flatMap((item) => {
    const agent = str(item['agent'])
    if (!agent) return []
    const state = item['state'] === 'installed' ? 'installed' : item['state'] === 'not_installed' ? 'not_installed' : 'unknown'
    return [[agent, state]]
  }))
}

/** Run one `orca … --json` command and return the unwrapped `result`, failing closed on any transport or envelope error. */
export const orcaJson = async (runner: CommandRunner, args: readonly string[], options: OrcaCliOptions = {}): Promise<unknown> => {
  const bin = options.bin ?? 'orca'
  const argv = [bin, ...args, ...(args.includes('--json') ? [] : ['--json'])]
  const outcome = await runner.run(argv, { timeoutMs: options.timeoutMs ?? 20_000, ...(options.cwd ? { cwd: options.cwd } : {}) })
  if (outcome.timedOut) fail(`${argv.slice(0, 3).join(' ')} timed out after ${options.timeoutMs ?? 20_000}ms.`, 'HARNESS_ERROR')
  const envelope = parseJsonEnvelope(outcome.stdout)
  if (!envelope) return fail(`${argv.slice(0, 3).join(' ')} exited ${outcome.code ?? 'null'} without a JSON envelope${outcome.stderr.trim() ? `: ${outcome.stderr.trim().slice(0, 300)}` : '.'}`, 'HARNESS_ERROR')
  if (!envelope.ok) return fail(`${argv.slice(0, 3).join(' ')} failed: ${envelope.error ?? 'unknown error'}`, 'HARNESS_ERROR')
  return envelope.result
}

export const orcaVersion = async (runner: CommandRunner, options: OrcaCliOptions = {}): Promise<string | null> => {
  const outcome = await runner.run([options.bin ?? 'orca', '--version'], { timeoutMs: options.timeoutMs ?? 10_000 })
  return outcome.code === 0 ? parseOrcaVersion(outcome.stdout) : null
}

export const orcaStatus = async (runner: CommandRunner, options: OrcaCliOptions = {}): Promise<OrcaStatus> => parseOrcaStatus(await orcaJson(runner, ['status'], options))
export const orcaWorktrees = async (runner: CommandRunner, options: OrcaCliOptions = {}): Promise<readonly OrcaWorktree[]> => parseOrcaWorktrees(await orcaJson(runner, ['worktree', 'ps'], options))
export const orcaAgentHooks = async (runner: CommandRunner, options: OrcaCliOptions = {}): Promise<Readonly<Record<string, OrcaAgentHookState>>> => parseOrcaAgentHooks(await orcaJson(runner, ['agent', 'hooks', 'status'], options))
export const orcaAccountList = async (runner: CommandRunner, options: OrcaCliOptions = {}): Promise<unknown> => orcaJson(runner, ['account', 'list'], options)

// ---- worktree lifecycle -------------------------------------------------------------------------

export interface OrcaCreatedWorktree {
  readonly id: string
  readonly path: string
  readonly branch: string
  readonly agentTerminalHandle: string | null
  readonly raw: unknown
}

export const parseOrcaWorktreeCreate = (result: unknown): OrcaCreatedWorktree => {
  const record = isRecord(result) ? result : {}
  const nested = isRecord(record['worktree']) ? record['worktree'] : record
  const startup = isRecord(record['startupTerminal']) ? record['startupTerminal'] : isRecord(nested['startupTerminal']) ? nested['startupTerminal'] : {}
  const id = str(nested['worktreeId'], str(nested['id'], str(record['worktreeId'], str(record['id']))))
  if (!id) fail('orca worktree create returned no worktree id.', 'HARNESS_ERROR')
  return {
    id,
    path: str(nested['path'], str(record['path'], id.includes('::') ? id.slice(id.indexOf('::') + 2) : '')),
    branch: str(nested['branch'], str(record['branch'])).replace(/^refs\/heads\//, ''),
    agentTerminalHandle: str(record['agentTerminalHandle'], str(nested['agentTerminalHandle'], str(startup['handle']))) || null,
    raw: result,
  }
}

/** Execute a `createOrcaDispatchPlan` argv (first element is the orca binary). */
export const orcaWorktreeCreate = async (runner: CommandRunner, argv: readonly string[], options: OrcaCliOptions = {}): Promise<OrcaCreatedWorktree> => {
  const [bin, ...args] = argv
  return parseOrcaWorktreeCreate(await orcaJson(runner, args, { ...options, bin: bin ?? options.bin ?? 'orca', timeoutMs: options.timeoutMs ?? 120_000 }))
}

export const orcaWorktreeSetArgv = (input: { readonly worktree: string; readonly comment?: string; readonly workspaceStatus?: string; readonly linearIssue?: string | null; readonly displayName?: string }, bin = 'orca'): readonly string[] => [bin, 'worktree', 'set', '--worktree', input.worktree,
  ...(input.comment === undefined ? [] : ['--comment', input.comment]),
  ...(input.workspaceStatus === undefined ? [] : ['--workspace-status', input.workspaceStatus]),
  ...(input.linearIssue === undefined ? [] : ['--linear-issue', input.linearIssue ?? 'null']),
  ...(input.displayName === undefined ? [] : ['--display-name', input.displayName]),
  '--json']

export const orcaWorktreeSet = async (runner: CommandRunner, input: Parameters<typeof orcaWorktreeSetArgv>[0], options: OrcaCliOptions = {}): Promise<unknown> => orcaJson(runner, orcaWorktreeSetArgv(input).slice(1), options)

export const orcaWorktreeRemove = async (runner: CommandRunner, input: { readonly worktree: string; readonly force?: boolean }, options: OrcaCliOptions = {}): Promise<unknown> => orcaJson(runner, ['worktree', 'rm', '--worktree', input.worktree, ...(input.force ? ['--force'] : [])], { ...options, timeoutMs: options.timeoutMs ?? 60_000 })

// ---- terminals -----------------------------------------------------------------------------------

export interface OrcaTerminal {
  readonly handle: string
  readonly title: string
  readonly worktreeId: string | null
  readonly status: string
  readonly command: string | null
  readonly branch: string | null
  readonly preview: string
  readonly lastOutputAt: number | null
  readonly raw: Record<string, unknown>
}

export const parseOrcaTerminals = (result: unknown): readonly OrcaTerminal[] => {
  const list = isRecord(result) ? (Array.isArray(result['terminals']) ? result['terminals'] : Array.isArray(result['items']) ? result['items'] : []) : Array.isArray(result) ? result : []
  return list.filter(isRecord).map((item) => ({
    handle: str(item['handle'], str(item['id'])),
    title: str(item['title'], str(item['name'])),
    worktreeId: str(item['worktreeId'], str(item['worktree'])) || null,
    status: item['orphaned'] === true ? 'orphaned' : item['connected'] === false ? 'disconnected' : str(item['status'], str(item['state'], item['connected'] === true ? 'connected' : 'unknown')),
    command: str(item['command'], str(item['agent'])) || null,
    branch: str(item['branch']).replace(/^refs\/heads\//, '') || null,
    preview: str(item['preview']),
    lastOutputAt: num(item['lastOutputAt']),
    raw: item,
  })).filter((item) => item.handle)
}

export const orcaTerminalList = async (runner: CommandRunner, input: { readonly worktree?: string; readonly limit?: number } = {}, options: OrcaCliOptions = {}): Promise<readonly OrcaTerminal[]> => parseOrcaTerminals(await orcaJson(runner, ['terminal', 'list', ...(input.worktree ? ['--worktree', input.worktree] : []), ...(input.limit ? ['--limit', String(input.limit)] : [])], options))

export const orcaTerminalCreate = async (runner: CommandRunner, input: { readonly worktree: string; readonly command: string; readonly title?: string }, options: OrcaCliOptions = {}): Promise<{ readonly handle: string; readonly raw: unknown }> => {
  const result = await orcaJson(runner, ['terminal', 'create', '--worktree', input.worktree, '--command', input.command, ...(input.title ? ['--title', input.title] : [])], { ...options, timeoutMs: options.timeoutMs ?? 60_000 })
  const record = isRecord(result) ? result : {}
  const terminal = isRecord(record['terminal']) ? record['terminal'] : record
  const handle = str(terminal['handle'], str(record['handle']))
  if (!handle) fail('orca terminal create returned no terminal handle.', 'HARNESS_ERROR')
  return { handle, raw: result }
}

export interface OrcaSendReceipt { readonly accepted: boolean; readonly requestId: string | null; readonly stages: readonly string[]; readonly warnings: readonly string[] }

export const parseOrcaSendReceipt = (result: unknown): OrcaSendReceipt => {
  const record = isRecord(result) ? result : {}
  const receipt = isRecord(record['receipt']) ? record['receipt'] : record
  const stages = Array.isArray(receipt['stages']) ? receipt['stages'].map((stage: unknown) => isRecord(stage) ? str(stage['stage'], str(stage['name'])) : str(stage)).filter(Boolean) : []
  // Orca returns `ok:true` with a null/empty result for a plain send; only an explicit `accepted:false` means the input was refused.
  const accepted = receipt['accepted'] === false ? false : receipt['accepted'] === true || stages.includes('input_accepted') || (result === null || result === undefined || Object.keys(record).length === 0)
  return { accepted, requestId: str(receipt['requestId'], str(record['requestId'])) || null, stages, warnings: Array.isArray(record['warnings']) ? record['warnings'].map((warning: unknown) => isRecord(warning) ? str(warning['message'], JSON.stringify(warning)) : str(warning)) : [] }
}

export const orcaTerminalSend = async (runner: CommandRunner, input: { readonly terminal: string; readonly text: string; readonly enter?: boolean; readonly waitSubmitSeconds?: number }, options: OrcaCliOptions = {}): Promise<OrcaSendReceipt> => parseOrcaSendReceipt(await orcaJson(runner, ['terminal', 'send', '--terminal', input.terminal, '--text', input.text, ...(input.enter === false ? [] : ['--enter']), ...(input.waitSubmitSeconds ? ['--wait-submit', String(input.waitSubmitSeconds)] : [])], { ...options, timeoutMs: options.timeoutMs ?? ((input.waitSubmitSeconds ?? 0) * 1000 + 30_000) }))

export const orcaTerminalWait = async (runner: CommandRunner, input: { readonly terminal: string; readonly for: 'exit' | 'tui-idle'; readonly timeoutMs: number }, options: OrcaCliOptions = {}): Promise<{ readonly satisfied: boolean; readonly raw: unknown }> => {
  const result = await orcaJson(runner, ['terminal', 'wait', '--terminal', input.terminal, '--for', input.for, '--timeout-ms', String(input.timeoutMs)], { ...options, timeoutMs: input.timeoutMs + 15_000 })
  const record = isRecord(result) ? result : {}
  const wait = isRecord(record['wait']) ? record['wait'] : record
  return { satisfied: wait['satisfied'] === true, raw: result }
}

export const orcaTerminalScreen = async (runner: CommandRunner, input: { readonly terminal: string }, options: OrcaCliOptions = {}): Promise<string> => {
  const result = await orcaJson(runner, ['terminal', 'read', '--terminal', input.terminal, '--screen'], options)
  const record = isRecord(result) ? (isRecord(result['terminal']) ? result['terminal'] : result) : {}
  const screen = record['tail'] ?? record['screen'] ?? record['lines'] ?? record['text'] ?? record['output']
  return Array.isArray(screen) ? screen.map((line: unknown) => isRecord(line) ? str(line['text'], str(line['line'])) : String(line)).join('\n') : typeof screen === 'string' ? screen : ''
}

// ---- automations ---------------------------------------------------------------------------------

export interface OrcaAutomation { readonly id: string; readonly name: string; readonly enabled: boolean; readonly trigger: string; readonly provider: string | null; readonly raw: Record<string, unknown> }

export const parseOrcaAutomations = (result: unknown): readonly OrcaAutomation[] => {
  const list = isRecord(result) ? (Array.isArray(result['automations']) ? result['automations'] : Array.isArray(result['items']) ? result['items'] : []) : Array.isArray(result) ? result : []
  return list.filter(isRecord).map((item) => ({ id: str(item['id']), name: str(item['name']), enabled: item['enabled'] !== false && item['disabled'] !== true, trigger: str(item['rrule'], str(item['trigger'], str(item['schedule'], typeof item['schedule'] === 'object' && item['schedule'] !== null ? JSON.stringify(item['schedule']) : ''))), provider: str(item['agentId'], str(item['provider'], str(item['agent']))) || null, raw: item })).filter((item) => item.id)
}

export const orcaAutomationsList = async (runner: CommandRunner, options: OrcaCliOptions = {}): Promise<readonly OrcaAutomation[]> => parseOrcaAutomations(await orcaJson(runner, ['automations', 'list'], options))

export interface OrcaAutomationSpec {
  readonly name: string
  readonly trigger: string
  readonly prompt: string
  readonly provider: string
  readonly precheck?: string
  readonly precheckTimeoutSec?: number
  readonly workspace?: string
  readonly repo?: string
  readonly host?: string
  readonly reuseSession?: boolean
  readonly enabled?: boolean
}

export const orcaAutomationCreateArgv = (spec: OrcaAutomationSpec, bin = 'orca'): readonly string[] => [bin, 'automations', 'create', '--name', spec.name, '--trigger', spec.trigger, '--prompt', spec.prompt, '--provider', spec.provider,
  ...(spec.precheck ? ['--precheck', spec.precheck] : []),
  ...(spec.precheckTimeoutSec ? ['--precheck-timeout', String(spec.precheckTimeoutSec)] : []),
  ...(spec.workspace ? ['--workspace', spec.workspace, '--workspace-mode', 'existing'] : spec.repo ? ['--repo', spec.repo] : []),
  ...(spec.host ? ['--host', spec.host] : []),
  ...(spec.workspace && spec.reuseSession !== false ? ['--reuse-session'] : []),
  spec.enabled === false ? '--disabled' : '--enabled',
  '--json']

export const orcaAutomationEditArgv = (id: string, spec: OrcaAutomationSpec, bin = 'orca'): readonly string[] => [bin, 'automations', 'edit', id, '--name', spec.name, '--trigger', spec.trigger, '--prompt', spec.prompt, '--provider', spec.provider,
  ...(spec.precheck ? ['--precheck', spec.precheck] : []),
  ...(spec.precheckTimeoutSec ? ['--precheck-timeout', String(spec.precheckTimeoutSec)] : []),
  ...(spec.workspace ? ['--workspace', spec.workspace, '--workspace-mode', 'existing'] : spec.repo ? ['--repo', spec.repo] : []),
  ...(spec.host ? ['--host', spec.host] : []),
  ...(spec.workspace && spec.reuseSession !== false ? ['--reuse-session'] : []),
  spec.enabled === false ? '--disabled' : '--enabled',
  '--json']

export const orcaAutomationRemove = async (runner: CommandRunner, id: string, options: OrcaCliOptions = {}): Promise<unknown> => orcaJson(runner, ['automations', 'remove', id], options)
export const orcaAutomationRun = async (runner: CommandRunner, id: string, options: OrcaCliOptions = {}): Promise<unknown> => orcaJson(runner, ['automations', 'run', id], options)
export const orcaAutomationRuns = async (runner: CommandRunner, id: string, options: OrcaCliOptions = {}): Promise<unknown> => orcaJson(runner, ['automations', 'runs', '--id', id], options)
