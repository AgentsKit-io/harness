import type { CommandRunner } from '../adapters/command.js'
import { findExecutable } from '../adapters/command.js'
import { orcaAccountList, orcaAgentHooks, orcaAutomationCreateArgv, orcaAutomationDisableArgv, orcaAutomationEditArgv, orcaAutomationRemove, orcaAutomationRuns, orcaAutomationsList, orcaJson, type OrcaAutomation } from '../adapters/orca-cli.js'
import { detectProviders } from '../adapters/providers.js'
import { fail } from '../kernel/errors.js'
import { automationName, automationSpecs, declaredStages, MANAGED_STAGES, reconcileAutomations, shellQuote, type LoopStage } from './automations.js'
import { loadLoopConfig, providerIdentity, type LoadedLoopConfig } from './config.js'
import { activeCooldowns, readCooldowns } from './cooldown.js'
import { providerSpecs } from './doctor.js'
import { rankModels } from './routing.js'

export { automationName, automationPrompt, automationSpecs, declaredStages, LOOP_STAGES, MANAGED_STAGES, precheckCommand, shellQuote } from './automations.js'
export type { AutomationSpec, LoopStage } from './automations.js'

export interface InstallInput {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly runner: CommandRunner
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly dryRun?: boolean
  /** Orca agent id override for the automation provider. */
  readonly provider?: string
  readonly now?: () => Date
}

export interface InstallAction { readonly name: string; readonly stage: LoopStage; readonly action: 'create' | 'edit' | 'remove' | 'disable' | 'skip'; readonly id: string | null; readonly argv: readonly string[]; readonly detail: string }
export interface InstallReport { readonly status: 'ok' | 'dry-run' | 'failed'; readonly provider: string; readonly workspace: string; readonly actions: readonly InstallAction[]; readonly notes: readonly string[] }

const chooseProvider = async (input: InstallInput, loaded: LoadedLoopConfig): Promise<string> => {
  if (input.provider) return input.provider
  if (loaded.config.schedule.provider) return loaded.config.schedule.provider
  const orca = { bin: loaded.config.orca.bin, timeoutMs: loaded.config.orca.timeoutMs }
  const now = input.now ?? (() => new Date())
  const [accountList, agentHooks] = await Promise.all([orcaAccountList(input.runner, orca).catch(() => ({})), orcaAgentHooks(input.runner, orca).catch(() => ({}) as Readonly<Record<string, 'installed' | 'not_installed' | 'unknown'>>)])
  const providers = await detectProviders({ providers: providerSpecs(loaded.config), accountList, agentHooks, env: input.env, platform: input.platform, exhaustedPercent: loaded.config.models.cooldown.exhaustedPercent, cooldowns: activeCooldowns(readCooldowns(loaded.stateDir), now()), now })
  const watcher = rankModels(loaded.config, 'watcher', providers)[0] ?? rankModels(loaded.config, 'orchestrator', providers)[0]
  return watcher ? providerIdentity(loaded.config, watcher.provider).orcaAgent : 'claude'
}

/**
 * Reconcile Orca's scheduled automations with what the config declares: create what is missing, edit only what
 * drifted, switch off what the config no longer declares, and leave an automation that already matches untouched.
 *
 * Idempotence is the point. Before this, install rewrote every automation on every run and never noticed one edited
 * by hand, which is how four automations spent five days pointing at a config file from 2026-09-14.
 */
export const installLoopAutomations = async (input: InstallInput): Promise<InstallReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  const bin = config.schedule.harnessCommand.split(/\s+/)[0] ?? config.schedule.harnessCommand
  const notes: string[] = [...declaredStages(config).notes]
  if (!findExecutable(bin, input.env ?? process.env, input.platform ?? process.platform)) notes.unshift(`"${bin}" is not on PATH for this shell; Orca runs the precheck/prompt in its own environment — install it globally (npm i -g @agentskit/harness) or set schedule.harnessCommand to an absolute command.`)
  const provider = await chooseProvider(input, loaded)
  const orca = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
  const existing = await orcaAutomationsList(input.runner, orca)
  const specs = automationSpecs(loaded, provider)
  const rows = reconcileAutomations(specs, existing, config)
  const actions: InstallAction[] = []
  let failed = false
  const apply = async (name: string, stage: LoopStage, action: InstallAction['action'], id: string | null, argv: readonly string[], detail: string): Promise<void> => {
    if (input.dryRun) { actions.push({ name, stage, action, id, argv, detail: 'dry-run' }); return }
    try {
      const result = await orcaJson(input.runner, argv.slice(1), { ...orca, timeoutMs: Math.max(orca.timeoutMs, 60_000) })
      const record = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {}
      const nested = typeof record['automation'] === 'object' && record['automation'] !== null ? record['automation'] as Record<string, unknown> : record
      actions.push({ name, stage, action, id: typeof nested['id'] === 'string' ? nested['id'] : id, argv, detail })
    } catch (error) { failed = true; actions.push({ name, stage, action, id, argv, detail: error instanceof Error ? error.message : String(error) }) }
  }
  for (const row of rows) {
    const spec = specs.find((item) => item.name === row.name)
    const current = existing.find((item) => item.name === row.name)
    const stage = row.stage ?? 'tick'
    if (row.state === 'in-sync') { actions.push({ name: row.name, stage, action: 'skip', id: current?.id ?? null, argv: [], detail: 'already matches the config' }); continue }
    if (row.state === 'undeclared') {
      if (!current) continue
      await apply(row.name, stage, 'disable', current.id, orcaAutomationDisableArgv(current.id, config.orca.bin), 'the config no longer declares this stage — switched off, not removed')
      continue
    }
    if (!spec) continue
    if (row.state === 'missing') { await apply(spec.name, stage, 'create', null, orcaAutomationCreateArgv(spec, config.orca.bin), `created · ${spec.trigger} · provider ${provider}`); continue }
    await apply(spec.name, stage, 'edit', current?.id ?? null, orcaAutomationEditArgv(current!.id, spec, config.orca.bin), `updated ${row.fields.join(', ')} · ${spec.trigger} · provider ${provider}`)
  }
  return { status: failed ? 'failed' : input.dryRun ? 'dry-run' : 'ok', provider, workspace: config.orca.workspaceSelector ?? `path:${loaded.root}`, actions, notes }
}

export const uninstallLoopAutomations = async (input: InstallInput): Promise<InstallReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  const orca = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
  const existing = await orcaAutomationsList(input.runner, orca)
  const actions: InstallAction[] = []
  let failed = false
  for (const stage of MANAGED_STAGES) {
    const name = automationName(config, stage)
    const current = existing.find((item) => item.name === name)
    if (!current) { actions.push({ name, stage, action: 'skip', id: null, argv: [], detail: 'not installed' }); continue }
    const argv = [config.orca.bin, 'automations', 'remove', current.id, '--json']
    if (input.dryRun) { actions.push({ name, stage, action: 'remove', id: current.id, argv, detail: 'dry-run' }); continue }
    try { await orcaAutomationRemove(input.runner, current.id, orca); actions.push({ name, stage, action: 'remove', id: current.id, argv, detail: 'removed' }) } catch (error) { failed = true; actions.push({ name, stage, action: 'remove', id: current.id, argv, detail: error instanceof Error ? error.message : String(error) }) }
  }
  return { status: failed ? 'failed' : input.dryRun ? 'dry-run' : 'ok', provider: '', workspace: config.orca.workspaceSelector ?? `path:${loaded.root}`, actions, notes: [] }
}

export interface AutomationStatus { readonly stage: LoopStage; readonly name: string; readonly installed: boolean; readonly enabled: boolean; readonly id: string | null; readonly trigger: string | null; readonly provider: string | null; readonly lastRun: { readonly at: string | null; readonly status: string | null; readonly summary?: string } | null; readonly runs: number }
export interface LoopStatusReport { readonly installed: number; readonly total: number; readonly automations: readonly AutomationStatus[]; readonly summary: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseAutomationRuns = (result: unknown): readonly { readonly at: string | null; readonly status: string | null; readonly summary?: string }[] => {
  const list = isRecord(result) && Array.isArray(result['runs']) ? result['runs'] : Array.isArray(result) ? result : []
  return list.filter(isRecord).map((run) => {
    const raw = run['startedAt'] ?? run['createdAt'] ?? run['at'] ?? run['finishedAt']
    const at = typeof raw === 'number' ? new Date(raw).toISOString() : typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : null
    const precheck = isRecord(run['precheckResult']) ? run['precheckResult'] : null
    const stdout = precheck && typeof precheck['stdout'] === 'string' ? precheck['stdout'] : ''
    let summary: string | null = null
    try { const parsed = JSON.parse(stdout) as Record<string, unknown>; summary = typeof parsed['status'] === 'string' ? `${parsed['status']}${Array.isArray(parsed['results']) ? ` · ${parsed['results'].length} result(s)` : ''}${typeof parsed['reason'] === 'string' ? ` · ${parsed['reason']}` : ''}` : null } catch { summary = null }
    return { at, status: typeof run['status'] === 'string' ? run['status'] : typeof run['outcome'] === 'string' ? run['outcome'] : null, ...(summary === null ? {} : { summary }) }
  }).sort((left, right) => (right.at ?? '').localeCompare(left.at ?? ''))
}

export const loopStatus = async (input: Pick<InstallInput, 'configPath' | 'loaded' | 'runner'>): Promise<LoopStatusReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  const orca = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
  let existing: readonly OrcaAutomation[] = []
  try { existing = await orcaAutomationsList(input.runner, orca) } catch (error) { return fail(`Orca automations unavailable: ${error instanceof Error ? error.message : String(error)}`, 'HARNESS_ERROR') }
  const automations: AutomationStatus[] = []
  for (const stage of declaredStages(config).stages) {
    const name = automationName(config, stage)
    const current = existing.find((item) => item.name === name)
    if (!current) { automations.push({ stage, name, installed: false, enabled: false, id: null, trigger: null, provider: null, lastRun: null, runs: 0 }); continue }
    const runs = await orcaAutomationRuns(input.runner, current.id, orca).then(parseAutomationRuns).catch(() => [])
    automations.push({ stage, name, installed: true, enabled: current.enabled, id: current.id, trigger: current.trigger || null, provider: current.provider, lastRun: runs[0] ?? null, runs: runs.length })
  }
  const installed = automations.filter((item) => item.installed && item.enabled).length
  const summary = installed === 0 ? `loop: not installed — to enable: ${config.schedule.harnessCommand} loop install -f ${shellQuote(loaded.path)}` : `loop: installed (${installed}/${automations.length}${automations.some((item) => item.lastRun?.at) ? `, last run ${automations.map((item) => item.lastRun?.at).filter(Boolean).sort().at(-1)}` : ''})`
  return { installed, total: automations.length, automations, summary }
}
