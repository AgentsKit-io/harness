import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { fail } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'
import { MODEL_ROLES, type ModelRole } from '../kernel/model-policy.js'

export const LOOP_CONFIG_FILE = 'loop.config.yaml'
/** Optional, gitignored per-machine overlay merged over the versioned config (e.g. `linear.person`, `machine.minFreeRamGb`). */
export const LOOP_LOCAL_CONFIG_FILE = 'loop.config.local.yaml'
export const LOOP_CONFIG_SCHEMA_VERSION = 1

const nonEmpty = z.string().trim().min(1)
const cron = z.string().trim().regex(/^(\S+\s+){4}\S+$|^(hourly|daily|weekdays|weekly)$/, 'must be a 5-field cron expression or hourly|daily|weekdays|weekly')

/** `provider/model` where provider is a key of `models.providers`; the model keeps any further slashes (e.g. `opencode/opencode-go/glm-5.3`). */
export const modelRef = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*\/[^\s/][^\s]*$/i, 'must be provider/model')

const ProviderSchema = z.object({
  bin: nonEmpty,
  auth: z.enum(['subscription', 'api-key', 'none']).default('none'),
  envKeys: z.array(nonEmpty).default([]),
  /** Orca `worktree create --agent <id>`; defaults to the provider key. */
  orcaAgent: nonEmpty.optional(),
  /** Key inside `orca account list` → `result.rateLimits`; defaults to the provider key (`opencode` → `opencodeGo`). */
  orcaUsageKey: nonEmpty.optional(),
  /** Command template used when Orca has no per-run model flag. `{model}` is substituted. */
  tui: nonEmpty,
  /** Optional read-only probe argv (argv[0] resolved on PATH) confirming the CLI can answer; exit 0 = healthy. */
  probe: z.array(nonEmpty).min(1).optional(),
  /** Headless, read-only argv template for orchestrator work (contract generation). `{model}` and `{prompt}` are substituted per element. */
  headless: z.array(nonEmpty).min(1).optional(),
  /** `agentskit-review --provider` id; defaults to `<key>-cli` (codex-cli, claude-cli, grok-cli, opencode-cli). */
  reviewProvider: nonEmpty.optional(),
})

const tiers = z.array(z.array(modelRef).min(1)).min(1)

export const LoopConfigSchema = z.object({
  schemaVersion: z.literal(LOOP_CONFIG_SCHEMA_VERSION).default(LOOP_CONFIG_SCHEMA_VERSION),
  project: z.object({
    name: nonEmpty,
    repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name'),
    baseBranch: nonEmpty.default('main'),
    root: nonEmpty.default('.'),
    stateDir: nonEmpty.default('.codex/loop'),
  }),
  orca: z.object({
    bin: nonEmpty.default('orca'),
    /** Orca repo selector for new worktrees: `id:<repoId>`, `name:<name>` or `path:<abs>`; default `path:<project.root>`. */
    repoSelector: nonEmpty.optional(),
    /** Existing worktree the automations run in; default: the enclosing worktree resolved by Orca. */
    workspaceSelector: nonEmpty.optional(),
    host: nonEmpty.optional(),
    minVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/).default('1.4.200'),
    timeoutMs: z.number().int().positive().default(20_000),
  }).prefault({}),
  linear: z.object({
    workspaceId: nonEmpty,
    teamKey: nonEmpty,
    /** Linear display name of the person whose queue this machine drains. */
    person: nonEmpty,
    /** Display name → Linear user id, for `assignee set` and audit; the queue itself filters by display name. */
    people: z.record(nonEmpty, nonEmpty).default({}),
    states: z.array(nonEmpty).min(1).default(['Todo', 'Ready']),
    excludeLabels: z.array(nonEmpty).default(['blocked', 'needs-info']),
    requireLabels: z.array(nonEmpty).default([]),
    projects: z.array(nonEmpty).default([]),
    order: z.array(z.enum(['priority', 'updatedAt', 'createdAt'])).min(1).default(['priority', 'updatedAt']),
    maxQueue: z.number().int().positive().default(50),
    inProgressState: nonEmpty.default('In Progress'),
    reviewState: nonEmpty.default('In Review'),
    doneState: nonEmpty.default('Done'),
    blockedLabel: nonEmpty.default('blocked'),
    needsInfoLabel: nonEmpty.default('needs-info'),
  }),
  models: z.object({
    orchestrator: tiers,
    reviewer: tiers,
    builder: tiers,
    watcher: tiers,
    cooldown: z.object({
      initialMin: z.number().int().positive().default(30),
      maxMin: z.number().int().positive().default(240),
      probeBeforeReenable: z.boolean().default(true),
      /** A usage window at or above this percent counts as exhausted. */
      exhaustedPercent: z.number().min(1).max(100).default(100),
    }).prefault({}),
    providers: z.record(z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/i), ProviderSchema),
  }),
  machine: z.object({
    floor: z.number().int().min(1).default(1),
    ceiling: z.number().int().min(1).optional(),
    minFreeRamGb: z.number().min(0).default(4),
    warningPercent: z.number().min(0).max(100).default(75),
    criticalPercent: z.number().min(0).max(100).default(90),
    /** Per-agent RSS budget when live measurement is unavailable. */
    agentRssMb: z.number().positive().default(1400),
    wslCap: z.number().int().min(1).default(1),
  }).prefault({}),
  delivery: z.object({
    verifyCommand: nonEmpty,
    review: z.object({
      cli: nonEmpty.default('agentskit-review'),
      /** agentskit-review execution mode. `trusted-local` reuses this user's environment (and CLI logins); the isolated default runs claude/codex with a temporary HOME and no credentials. */
      mode: z.enum(['trusted-local', 'isolated']).default('trusted-local'),
      /** `fast` = one bounded pass over the required lenses (fits a 600 s Orca stage); `full` = every lens, needs a long deadline or batching. */
      profile: z.enum(['fast', 'full']).default('fast'),
      votes: z.number().int().positive().default(1),
      concurrency: z.number().int().positive().max(16).default(4),
      /** agentskit-review severity floor that blocks auto-merge: nit < med < high < blocker. */
      minSeverity: z.enum(['nit', 'med', 'high', 'blocker']).default('med'),
      deadlineMs: z.number().int().positive().default(600_000),
      maxCalls: z.number().int().positive().max(1000).default(400),
      /** Post the review to the PR (inline + summary). */
      post: z.boolean().default(true),
    }).prefault({}),
    merge: z.object({
      auto: z.boolean().default(true),
      method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
      requireChecks: z.boolean().default(true),
    }).prefault({}),
    maxFixRounds: z.number().int().min(0).default(2),
    workerIdleTimeoutMin: z.number().int().positive().default(45),
    selfEditPaths: z.array(nonEmpty).default([LOOP_CONFIG_FILE, '.github/**']),
    /** Check names ignored when deciding CI is green (e.g. advisory bots). */
    ignoreChecks: z.array(nonEmpty).default([]),
    /** Check names that must be observed and green; empty = every reported check must pass. */
    requiredChecks: z.array(nonEmpty).default([]),
    /** Remove the Orca worktree after a successful merge. */
    cleanupWorktree: z.boolean().default(true),
    /** Linear state an abandoned (stuck/blocked) issue returns to. */
    returnState: nonEmpty.default('Todo'),
  }),
  contract: z.object({
    /** Max characters of issue description + comments rendered into the orchestrator prompt. */
    maxIssueChars: z.number().int().positive().default(12_000),
    timeoutMs: z.number().int().positive().default(300_000),
    /** Doc Bridge references appended to the orchestrator prompt when `.doc-bridge/index.json` exists. */
    maxContextReferences: z.number().int().min(0).default(6),
    /** Re-generate a cached contract older than this many hours (0 = always reuse). */
    reuseHours: z.number().min(0).default(72),
  }).prefault({}),
  schedule: z.object({
    tick: cron.default('*/5 * * * *'),
    deliver: cron.default('*/10 * * * *'),
    precheckTimeoutSec: z.number().int().positive().default(120),
    /** How the Orca automation invokes the harness inside the workspace; `-f <config>` is appended. */
    harnessCommand: nonEmpty.default('ak-harness'),
    /** Orca agent id that runs the automation prompt; default: the watcher role's first available provider, else claude. */
    provider: nonEmpty.optional(),
    /** Prefix for automation names (`<prefix>-tick`, `<prefix>-deliver`). */
    namePrefix: nonEmpty.default('loop'),
    /**
     * `precheck` (default): the stage runs inside Orca's `--precheck` command and always exits 1, so Orca records the run
     * (`skipped_precheck`, stdout captured) without ever launching an agent. `agent`: legacy — the precheck only tests for
     * work and an Orca-launched agent runs the harness (needs a provider that runs non-interactively).
     */
    runner: z.enum(['precheck', 'agent']).default('precheck'),
    /** Time budget for one stage when `runner: precheck`. Orca caps prechecks at 600 s; the stage itself must fit. */
    stageTimeoutSec: z.number().int().positive().max(600).default(600),
    timezone: nonEmpty.optional(),
  }).prefault({}),
})

export type LoopConfigInput = z.input<typeof LoopConfigSchema>
export type LoopConfig = z.output<typeof LoopConfigSchema>
export type LoopProviderConfig = LoopConfig['models']['providers'][string]

export interface ModelReference { readonly provider: string; readonly model: string }
export interface LoadedLoopConfig {
  readonly path: string
  /** Present when a `loop.config.local.yaml` overlay was merged in. */
  readonly localPath?: string
  readonly root: string
  readonly stateDir: string
  readonly config: LoopConfig
  readonly configHash: string
}

export const parseModelRef = (value: string): ModelReference => {
  const index = value.indexOf('/')
  if (index < 1 || index === value.length - 1) fail(`Model reference must be provider/model: ${value}`, 'INVALID_CONFIG')
  return { provider: value.slice(0, index), model: value.slice(index + 1) }
}

export const tiersFor = (config: LoopConfig, role: ModelRole): readonly (readonly ModelReference[])[] => config.models[role].map((tier) => tier.map(parseModelRef))

const formatIssues = (issues: readonly z.core.$ZodIssue[]): string => issues.map((issue) => `${issue.path.length ? issue.path.map(String).join('.') : '<root>'}: ${issue.message}`).join('; ')

export const validateLoopConfig = (value: unknown): LoopConfig => {
  const result = LoopConfigSchema.safeParse(value)
  if (!result.success) return fail(`Invalid ${LOOP_CONFIG_FILE}: ${formatIssues(result.error.issues)}`, 'INVALID_CONFIG')
  const config = result.data
  for (const role of MODEL_ROLES) for (const [tierIndex, tier] of config.models[role].entries()) for (const ref of tier) {
    const { provider } = parseModelRef(ref)
    if (!config.models.providers[provider]) fail(`models.${role}[${tierIndex}] references unknown provider "${provider}"; declare it under models.providers.`, 'INVALID_CONFIG')
  }
  if (config.machine.warningPercent > config.machine.criticalPercent) fail('machine.warningPercent must not exceed machine.criticalPercent.', 'INVALID_CONFIG')
  if (config.models.cooldown.initialMin > config.models.cooldown.maxMin) fail('models.cooldown.initialMin must not exceed maxMin.', 'INVALID_CONFIG')
  if (config.machine.ceiling !== undefined && config.machine.ceiling < config.machine.floor) fail('machine.ceiling must be at least machine.floor.', 'INVALID_CONFIG')
  return config
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Recursive merge: objects merge key by key, arrays and scalars from the overlay replace the base. */
export const mergeLoopConfig = (base: unknown, overlay: unknown): unknown => {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay === undefined ? base : overlay
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) result[key] = key in base ? mergeLoopConfig(base[key], value) : value
  return result
}

const parseYamlMapping = (text: string, label: string): Record<string, unknown> => {
  let raw: unknown
  try { raw = parseYaml(text) } catch (error) { return fail(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_CONFIG') }
  if (raw === null || raw === undefined) return {}
  if (!isPlainObject(raw)) return fail(`Invalid ${label}: top level must be a mapping.`, 'INVALID_CONFIG')
  return raw
}

export const parseLoopConfigText = (text: string, localText?: string): LoopConfig => validateLoopConfig(localText === undefined ? parseYamlMapping(text, LOOP_CONFIG_FILE) : mergeLoopConfig(parseYamlMapping(text, LOOP_CONFIG_FILE), parseYamlMapping(localText, LOOP_LOCAL_CONFIG_FILE)))

export const loadLoopConfig = (path: string = LOOP_CONFIG_FILE): LoadedLoopConfig => {
  const absolute = resolve(path)
  let text: string
  try { text = readFileSync(absolute, 'utf8') } catch { return fail(`Loop config not found: ${absolute}`, 'INVALID_CONFIG') }
  const localPath = resolve(dirname(absolute), LOOP_LOCAL_CONFIG_FILE)
  const localText = existsSync(localPath) ? readFileSync(localPath, 'utf8') : undefined
  const config = parseLoopConfigText(text, localText)
  const root = resolve(dirname(absolute), config.project.root)
  return { path: absolute, root, stateDir: resolve(root, config.project.stateDir), config, configHash: hashJson(config), ...(localText === undefined ? {} : { localPath }) }
}

/** Effective Orca agent id and usage key for a provider. */
export const providerIdentity = (config: LoopConfig, provider: string): { readonly orcaAgent: string; readonly orcaUsageKey: string; readonly settings: LoopProviderConfig } => {
  const settings = config.models.providers[provider] ?? fail(`Unknown provider: ${provider}`, 'INVALID_CONFIG')
  return { orcaAgent: settings.orcaAgent ?? provider, orcaUsageKey: settings.orcaUsageKey ?? provider, settings }
}

export const renderTuiCommand = (settings: LoopProviderConfig, model: string): string => settings.tui.replaceAll('{model}', model)

/** Substitute `{model}` / `{prompt}` inside each headless argv element; the prompt stays one argv element, never shell-joined. */
export const renderHeadlessArgv = (settings: LoopProviderConfig, model: string, prompt: string): readonly string[] | null => settings.headless ? settings.headless.map((part) => part.replaceAll('{model}', model).replaceAll('{prompt}', prompt)) : null
