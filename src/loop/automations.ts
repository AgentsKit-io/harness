import type { OrcaAutomation, OrcaAutomationSpec } from '../adapters/orca-cli.js'
import type { LoadedLoopConfig, LoopConfig } from './config.js'

/** Every stage the harness can own a scheduled automation for. `tick`/`deliver` are always declared; `retro`/`observe` only when the config asks. */
export type LoopStage = 'tick' | 'deliver' | 'retro' | 'observe'
export const LOOP_STAGES: readonly LoopStage[] = ['tick', 'deliver']
/** Every stage name install/uninstall/status reconcile, declared or not — an automation the config dropped must still be found to be switched off. */
export const MANAGED_STAGES: readonly LoopStage[] = ['tick', 'deliver', 'retro', 'observe']

export const automationName = (config: LoopConfig, stage: LoopStage): string => `${effectiveAutomationPrefix(config)}-${stage}`

/** Turn an arbitrary project name into a safe Orca automation-name suffix: lowercase, `[a-z0-9-]`, collapse repeats, trim,
 * cap at 32 chars. Never throws — an empty result falls back to the literal default. */
export const sanitizeAutomationSuffix = (value: string): string => {
  const lowered = value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return lowered
}

/** Per-config discriminator for the automation name. Two configs running side-by-side in the same Orca must each
 * get their own `<prefix>-tick` and `<prefix>-deliver`, otherwise one install overwrites the other's automation.
 * Default `namePrefix: 'loop'` is the legacy single-project value; deriving from `project.name` here means opening
 * `ak-harness ui` for a second project is enough — no `loop install` babysitting per project. An explicit
 * `schedule.namePrefix` set in the config wins, always. */
export const effectiveAutomationPrefix = (config: LoopConfig): string => {
  if (config.schedule.namePrefix && config.schedule.namePrefix !== 'loop') return config.schedule.namePrefix
  const sanitized = sanitizeAutomationSuffix(config.project.name)
  return sanitized ? `loop-${sanitized}` : 'loop'
}

/** Quote a path for Orca's precheck shell on every platform: double quotes, no backslash doubling (cmd.exe keeps `\\` literal). */
export const shellQuote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`

/**
 * The exact command Orca runs before each scheduled run.
 *
 * `agent` runner: exit 0 = work exists. `precheck` runner: runs the whole stage and exits 1 so no agent is launched —
 * except `observe`, whose whole purpose is to exit 0 when a human has to look, so that Orca launches the investigator.
 */
export const precheckCommand = (config: LoopConfig, configPath: string, stage: LoopStage): string =>
  config.schedule.runner === 'precheck' || stage === 'observe'
    ? `${config.schedule.harnessCommand} loop stage ${stage} -f ${shellQuote(configPath)}`
    : `${config.schedule.harnessCommand} loop precheck ${stage === 'retro' ? 'deliver' : stage} -f ${shellQuote(configPath)}`

const observePrompt = (config: LoopConfig, configPath: string): string => `You are the health observer of the AgentsKit keep-pushing loop for ${config.project.repo}. This session only starts when \`${precheckCommand(config, configPath, 'observe')}\` found a problem set that is new, or unresolved for longer than the reminder window — its JSON report (problems, signature, first seen) is the precheck output of this run.

Investigate the reported problems in this workspace, read-only first: \`${config.schedule.harnessCommand} loop doctor -f ${shellQuote(configPath)} --json\`, \`${config.schedule.harnessCommand} loop debrief -f ${shellQuote(configPath)}\`, \`${config.schedule.harnessCommand} loop status -f ${shellQuote(configPath)} --json\`. Then report what is broken, the evidence, and the single next action a human should take. Do not dispatch work, do not open pull requests, do not edit files in this repository — the tick and deliver automations own the queue.`

/** Prompt the automation agent receives: run the harness stage, report, do nothing else. */
export const automationPrompt = (config: LoopConfig, configPath: string, stage: LoopStage): string => stage === 'observe'
  ? observePrompt(config, configPath)
  : config.schedule.runner === 'precheck'
    ? `This automation does its work inside its precheck command (${precheckCommand(config, configPath, stage)}), which always exits non-zero so that no agent session is needed. If you are reading this, the precheck unexpectedly exited 0: reply exactly LOOP_PRECHECK_BYPASSED and stop. Do not run any command.`
    : `You are the scheduled runner of the AgentsKit keep-pushing loop for ${config.project.repo}. Run exactly this command in the current workspace and nothing else:

${config.schedule.harnessCommand} loop ${stage === 'retro' ? 'stage retro' : stage} -f ${shellQuote(configPath)} --json

Then reply with a two-line summary of the JSON report (status, and the per-issue outcomes). Do not edit files, do not open pull requests, do not run other commands, do not retry on failure — the next scheduled run will. If the command is not found, reply "HARNESS_MISSING" and stop.`

export type AutomationSpec = OrcaAutomationSpec & { readonly stage: LoopStage }

/** Which stages this config declares, and why a stage that could exist does not. */
export const declaredStages = (config: LoopConfig): { readonly stages: readonly LoopStage[]; readonly notes: readonly string[] } => {
  const stages: LoopStage[] = [...LOOP_STAGES]
  const notes: string[] = []
  if (config.schedule.retro && config.schedule.retroIssue) stages.push('retro')
  else if (config.schedule.retro) notes.push('schedule.retro is set but schedule.retroIssue is missing — skipping <prefix>-retro automation')
  else if (config.schedule.retroIssue) notes.push('schedule.retroIssue is set but schedule.retro cron is missing — skipping <prefix>-retro automation')
  if (config.schedule.observe) stages.push('observe')
  return { stages, notes }
}

const triggerFor = (config: LoopConfig, stage: LoopStage): string => stage === 'tick'
  ? config.schedule.tick
  : stage === 'deliver'
    ? config.schedule.deliver
    : stage === 'retro'
      ? config.schedule.retro ?? config.schedule.deliver
      : config.schedule.observe ?? config.schedule.deliver

/**
 * The automations this config declares, fully resolved. This is the desired state `loop install` reconciles Orca
 * against and `loop doctor` compares Orca to — one function, so the two can never disagree.
 */
export const automationSpecs = (loaded: LoadedLoopConfig, provider: string): readonly AutomationSpec[] => {
  const { config } = loaded
  const workspace = config.orca.workspaceSelector ?? `path:${loaded.root}`
  return declaredStages(config).stages.map((stage) => ({
    stage,
    name: automationName(config, stage),
    trigger: triggerFor(config, stage),
    prompt: automationPrompt(config, loaded.path, stage),
    provider,
    precheck: precheckCommand(config, loaded.path, stage),
    // Every precheck gets the ordinary (short, Orca-ceiling-compatible) budget: `tick`'s precheck only peeks a
    // lock and fires a detached background worker (see `loop stage tick` in cli.ts) rather than doing the real
    // contract-generation-and-dispatch work inline, so it — like deliver, retro, and observe — never needs
    // `schedule.stageTimeoutSec`'s long budget here; that value now only bounds the detached worker's own
    // internal deadline, which Orca's precheck ceiling has no say over.
    precheckTimeoutSec: config.schedule.precheckTimeoutSec,
    workspace,
    ...(config.orca.host ? { host: config.orca.host } : {}),
    reuseSession: true,
    enabled: true,
  }))
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null

/** The fields of a live Orca automation this harness owns, read out of the raw payload `orca automations list` returns. */
export interface AutomationFields {
  readonly trigger: string
  readonly prompt: string | null
  readonly precheck: string | null
  readonly precheckTimeoutSec: number | null
  readonly provider: string | null
  readonly workspace: string | null
  readonly enabled: boolean
}

export const automationFields = (automation: OrcaAutomation): AutomationFields => {
  const raw = automation.raw
  const precheck = isRecord(raw['precheck']) ? raw['precheck'] : null
  const timeout = precheck ? precheck['timeoutSeconds'] ?? precheck['timeoutSec'] : null
  return {
    trigger: automation.trigger,
    prompt: text(raw['prompt']),
    precheck: precheck ? text(precheck['command']) : text(raw['precheck']),
    precheckTimeoutSec: typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : null,
    provider: automation.provider,
    workspace: text(raw['workspaceId']) ?? text(raw['workspace']),
    enabled: automation.enabled,
  }
}

/**
 * Orca stores a workspace as `<repoId>::<absolute path>`; the config declares `path:<absolute path>`. Compare on the
 * path alone, and report no drift for any selector shape this harness cannot map — a guess here would rewrite a
 * working automation on every install.
 *
 * Orca always normalizes the path it stores to forward slashes, even on Windows, while `loaded.root` (and so the
 * desired `path:` selector) is built with `node:path`'s native separator. Compare on forward slashes so a Windows
 * checkout doesn't see permanent drift against its own just-reconciled automation.
 */
const normalizeSlashes = (value: string): string => value.replace(/\\/g, '/')

const workspaceMatches = (desired: string | undefined, actual: string | null): boolean => {
  if (!desired || !actual) return true
  if (!desired.startsWith('path:')) return true
  const path = normalizeSlashes(desired.slice('path:'.length))
  const actualPath = normalizeSlashes(actual)
  return actualPath === path || actualPath.endsWith(`::${path}`)
}

/** The named fields where the live automation disagrees with what the config declares. Empty = in sync. */
export const automationDrift = (spec: AutomationSpec, automation: OrcaAutomation): readonly string[] => {
  const actual = automationFields(automation)
  const drift: string[] = []
  if (actual.trigger !== spec.trigger) drift.push('trigger')
  if (actual.prompt !== null && actual.prompt !== spec.prompt) drift.push('prompt')
  if (actual.precheck !== null && actual.precheck !== spec.precheck) drift.push('precheck')
  if (actual.precheckTimeoutSec !== null && spec.precheckTimeoutSec !== undefined && actual.precheckTimeoutSec !== spec.precheckTimeoutSec) drift.push('precheckTimeout')
  // An empty desired provider means "whatever is running it": the caller (doctor) did not resolve a provider, and
  // rewriting an automation because of a field nobody declared would be drift invented by the checker.
  if (spec.provider && actual.provider !== null && actual.provider !== spec.provider) drift.push('provider')
  if (!workspaceMatches(spec.workspace, actual.workspace)) drift.push('workspace')
  if (actual.enabled !== (spec.enabled !== false)) drift.push('enabled')
  return drift
}

/** One scheduled run as `loop status`/`doctor`/the UI need it. `error` is set only when the precheck broke. */
export interface AutomationRun { readonly at: string | null; readonly status: string | null; readonly summary?: string; readonly error?: string }

/**
 * A stage precheck exits 1 on every run by design (`runner: precheck`), so the exit code says nothing. What says the
 * stage never ran is a precheck that printed no JSON report and wrote to stderr — a harness that crashed on load,
 * e.g. an older global `ak-harness` rejecting a config it does not understand. That failure used to be visible only
 * inside Orca's run history.
 */
export const parseAutomationRuns = (result: unknown): readonly AutomationRun[] => {
  const list = isRecord(result) && Array.isArray(result['runs']) ? result['runs'] : Array.isArray(result) ? result : []
  return list.filter(isRecord).map((run) => {
    const raw = run['startedAt'] ?? run['createdAt'] ?? run['at'] ?? run['finishedAt']
    const at = typeof raw === 'number' ? new Date(raw).toISOString() : typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : null
    const precheck = isRecord(run['precheckResult']) ? run['precheckResult'] : null
    const stdout = precheck && typeof precheck['stdout'] === 'string' ? precheck['stdout'] : ''
    const stderr = precheck && typeof precheck['stderr'] === 'string' ? precheck['stderr'].trim() : ''
    let report: Record<string, unknown> | null = null
    try { const parsed = JSON.parse(stdout) as unknown; report = isRecord(parsed) ? parsed : null } catch { report = null }
    const summary = report && typeof report['status'] === 'string' ? `${report['status']}${Array.isArray(report['results']) ? ` · ${report['results'].length} result(s)` : ''}${typeof report['reason'] === 'string' ? ` · ${report['reason']}` : ''}` : null
    const error = report === null && stderr ? (stderr.split(/\r?\n/)[0] ?? stderr).slice(0, 400) : null
    return { at, status: typeof run['status'] === 'string' ? run['status'] : typeof run['outcome'] === 'string' ? run['outcome'] : null, ...(summary === null ? {} : { summary }), ...(error === null ? {} : { error }) }
  }).sort((left, right) => (right.at ?? '').localeCompare(left.at ?? ''))
}

export interface AutomationDriftRow { readonly name: string; readonly stage: LoopStage | null; readonly state: 'in-sync' | 'missing' | 'drifted' | 'undeclared'; readonly fields: readonly string[] }

/**
 * Compare every automation this config owns — declared or merely named by the prefix — with Orca's live state.
 * `undeclared` is how an automation the config stopped declaring surfaces instead of silently running on forever.
 */
export const reconcileAutomations = (specs: readonly AutomationSpec[], existing: readonly OrcaAutomation[], config: LoopConfig): readonly AutomationDriftRow[] => {
  const rows: AutomationDriftRow[] = specs.map((spec) => {
    const current = existing.find((item) => item.name === spec.name)
    if (!current) return { name: spec.name, stage: spec.stage, state: 'missing' as const, fields: [] }
    const fields = automationDrift(spec, current)
    return { name: spec.name, stage: spec.stage, state: fields.length ? ('drifted' as const) : ('in-sync' as const), fields }
  })
  for (const stage of MANAGED_STAGES) {
    const name = automationName(config, stage)
    if (specs.some((spec) => spec.name === name)) continue
    const current = existing.find((item) => item.name === name)
    if (current && current.enabled) rows.push({ name, stage, state: 'undeclared', fields: [] })
  }
  return rows
}
