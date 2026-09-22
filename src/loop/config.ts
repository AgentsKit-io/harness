import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { fail } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'
import { MODEL_ROLES, type ModelRole } from '../kernel/model-policy.js'
import { PRESET_NAMES, presetFor } from './presets.js'

export const LOOP_CONFIG_FILE = 'loop.config.yaml'
/** Optional, gitignored per-machine overlay merged over the versioned config (e.g. `linear.person`, `machine.minFreeRamGb`). */
export const LOOP_LOCAL_CONFIG_FILE = 'loop.config.local.yaml'
/** The user's own layer, outside every repository: identity, models and providers, effort, machine capacity, notification channels. */
export const GLOBAL_CONFIG_FILE = 'harness.yaml'
export const LOOP_CONFIG_SCHEMA_VERSION = 1

/** `loop.config.team.<key>.yaml`: what diverges between teams sharing one repository. */
export const teamConfigFile = (team: string): string => `loop.config.team.${team}.yaml`

/**
 * Where the user's global layer lives: `$AK_HARNESS_CONFIG`, else `$AK_HARNESS_HOME/harness.yaml`, else
 * `~/.agentskit/harness.yaml`. A missing file is not an error — the global layer is optional by design.
 */
export const globalConfigPath = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string =>
  env['AK_HARNESS_CONFIG']?.trim() || resolve(env['AK_HARNESS_HOME']?.trim() || resolve(home, '.agentskit'), GLOBAL_CONFIG_FILE)

/** `AK_HARNESS_NO_GLOBAL=1` loads the project without the user's layer — for tests and for reproducing what CI sees. */
export const globalLayerDisabled = (env: NodeJS.ProcessEnv = process.env): boolean => env['AK_HARNESS_NO_GLOBAL'] === '1'

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
  /** Reasoning-effort flag template substituted with `{effort}` into `tui`/`headless` (e.g. codex `-c model_reasoning_effort={effort}`, grok `--reasoning-effort {effort}`). Providers without one ignore `models.effort`. */
  effortFlag: nonEmpty.optional(),
  /**
   * Argv template appended to `headless` when a caller supplies a JSON Schema, one element per array entry (never
   * whitespace-split, unlike `effortFlag`, because the schema itself contains spaces) with `{schema}` substituted
   * into whichever element carries it — e.g. claude: `["--output-format", "json", "--json-schema", "{schema}"]`.
   *
   * Exists because plan-mode headless runs regressed (Claude Code <2.1.198, see git history) from asking the model
   * to retype its frozen contract/plan between text markers: a model that had already produced the JSON internally
   * would sometimes reply with only a prose summary ("the contract is frozen above") and never repeat the markers,
   * which read as "no contract block" even though the run succeeded. `--json-schema` gets the structured value out
   * of the API's own structured-output field instead of the model's free-text reply, so the marker convention is no
   * longer load-bearing for a provider that sets this. `headless`'s own trailing `--output-format` stays as the
   * text-mode default — this template's own `--output-format json` is appended after it and wins (last flag wins
   * on every CLI parser checked), so no base template needs editing when a caller opts in.
   *
   * Optional and providers without it keep the original marker-parsing path (`parseContractOutput` and friends) —
   * this is additive, not a replacement, so an unconfigured provider (or one whose CLI has no such flag) is unaffected.
   */
  structuredOutputFlag: z.array(nonEmpty).optional(),
  /**
   * Whether this CLI can delegate to subagents of its own.
   *
   * Only read when a flow asks its builder to lead (`flows.profiles.<name>.lead`). Off by default: claiming a
   * provider delegates when it cannot produces a worker that spends its first minutes looking for a tool that
   * does not exist.
   */
  subagents: z.boolean().default(false),
})

const effortLevel = z.enum(['low', 'medium', 'high', 'xhigh'])

/**
 * The loop's role vocabulary: every place a model is asked to do something, named once.
 *
 * `orchestrator`/`builder`/`watcher`/`review` are the four that pick a model list (`models.<role>`); `planner`,
 * `vote`, `verify` and `dod` are the finer per-issue phases that borrow one of those lists. One vocabulary, so a
 * profile that pins a role and a phase that runs it are talking about the same thing.
 */
export const LOOP_ROLES = ['orchestrator', 'planner', 'vote', 'builder', 'verify', 'review', 'dod', 'watcher'] as const
export type LoopRole = typeof LOOP_ROLES[number]
const loopRole = z.enum(LOOP_ROLES)

/** The phases that run per issue. `builder` is the work itself and is never switched off. */
export const WORKER_ROLES = ['planner', 'vote', 'builder', 'verify', 'review', 'dod'] as const
export type WorkerRole = typeof WORKER_ROLES[number]

const tiers = z.array(z.array(modelRef).min(1)).min(1)

export const LoopConfigSchema = z.object({
  schemaVersion: z.literal(LOOP_CONFIG_SCHEMA_VERSION).default(LOOP_CONFIG_SCHEMA_VERSION),
  /**
   * Defaults for this kind of project (`web-app`, `library`, `monorepo`, `data-pipeline`, `mobile`), merged
   * **below** every other layer. Anything this file states wins over the preset; the preset only fills silence.
   */
  extends: nonEmpty.optional(),
  project: z.object({
    name: nonEmpty,
    repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name'),
    baseBranch: nonEmpty.default('main'),
    root: nonEmpty.default('.'),
    /**
     * Where the loop keeps everything that is NOT the project's configuration: dispatch ledger, delivery
     * state, contracts, events, agent memory, plans. Meant to be gitignored — the configuration lives at
     * the repo root as `loop.config.yaml`, versioned; this directory is runtime state, per machine.
     */
    stateDir: nonEmpty.default('.ak-loop'),
    /** Selects the `loop.config.team.<key>.yaml` layer. `$AK_LOOP_TEAM` overrides it; a declared team whose file is missing fails loudly. */
    team: nonEmpty.optional(),
    /**
     * The tree the orchestrator's headless calls (contract, plan interview, architect, votes, decompose) read.
     * `base` (default): a harness-owned detached worktree of `origin/<baseBranch>`, fetched before each use.
     * `root`: `project.root` as it is — whatever branch and age the operator's checkout has.
     */
    orchestratorView: z.enum(['base', 'root']).default('base'),
    setup: z.object({
      /** Argv (no shell — one element per arg, e.g. `[pnpm, install, --frozen-lockfile]`) run once in a freshly created worktree before the worker terminal opens. Unset/empty = skip. */
      command: z.array(nonEmpty).min(1).optional(),
      timeoutSec: z.number().int().positive().default(600),
      /** When true, a failing/timing-out setup removes the worktree and counts as a dispatch failure instead of handing the worker a broken environment. */
      required: z.boolean().default(true),
    }).prefault({}),
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
    /** Optional ordered handoff between owners after the current dispatchable queue drains. */
    rotation: z.object({
      enabled: z.boolean().default(false),
      owners: z.array(nonEmpty).default([]),
      advanceWhenEmpty: z.boolean().default(true),
    }).prefault({}),
    /**
     * Whose queue this machine drains. `person` (default) keeps the historical behaviour: the issues
     * assigned to `linear.person`. `unassigned` drains the issues with NO assignee and turns the
     * assignee into a transient claim — written on dispatch, cleared when the item returns — so
     * several machines can share one priority-ordered queue without colliding.
     *
     * Note when switching to `unassigned`: clearing the assignees is then REQUIRED, not cosmetic. With
     * `person` and an emptied backlog the queue comes back empty and the loop looks healthy while doing
     * nothing.
     */
    queueOwnership: z.enum(['person', 'unassigned']).default('person'),
    states: z.array(nonEmpty).min(1).default(['Todo', 'Ready']),
    /**
     * Where `loop plan decompose --create` puts new issues. It must NOT be one of `states`: those are the queue, and
     * an issue the planner just wrote is not work anyone approved yet. Moving it into `states` is the human gate.
     */
    entryState: nonEmpty.default('Backlog'),
    excludeLabels: z.array(nonEmpty).default(['blocked', 'needs-info']),
    /** ALL of these must be on the issue (AND). */
    requireLabels: z.array(nonEmpty).default([]),
    /**
     * At least ONE of these must be on the issue (OR) — how a machine declares the slices of the board
     * it drains, e.g. `[layer:L2, layer:L3]`. `requireLabels` cannot say this: it demands every label on
     * the same issue, so two layers there match nothing and the queue comes back silently empty.
     */
    anyLabels: z.array(nonEmpty).default([]),
    projects: z.array(nonEmpty).default([]),
    order: z.array(z.enum(['priority', 'updatedAt', 'createdAt'])).min(1).default(['priority', 'updatedAt']),
    maxQueue: z.number().int().positive().default(50),
    inProgressState: nonEmpty.default('In Progress'),
    reviewState: nonEmpty.default('In Review'),
    doneState: nonEmpty.default('Done'),
    blockedLabel: nonEmpty.default('blocked'),
    needsInfoLabel: nonEmpty.default('needs-info'),
  }),
  /**
   * Suites already red on the base branch, declared so a worker is not asked to pass a verification that
   * nobody can pass.
   *
   * The harness does NOT run `delivery.verifyCommand` — the worker does, in its own worktree, before
   * opening the PR. So tolerating known breakage cannot be done by parsing output the harness never
   * sees: it has to be *told* to the worker, which is what this list does.
   *
   * Every entry carries the tracking issue on purpose. A quarantine without an owner becomes permanent,
   * and the worker needs to know the failure is someone else's to avoid "fixing" it inside an unrelated
   * task.
   */
  knownFailures: z
    .array(
      z.object({
        /** Path or suite name as the runner prints it. */
        path: nonEmpty,
        /** Tracking issue — no anonymous quarantine. */
        issue: nonEmpty,
        /** Why it is red, in one line. */
        reason: nonEmpty,
      }),
    )
    .default([]),
  /**
   * Stricter review for the slices of the board that deserve it, keyed by label.
   *
   * The review IS the gate when there is no CI, and not every change carries the same risk: a contract
   * that freezes evidence and a copy tweak should not be judged with the same budget. First matching
   * entry wins, and it only overrides the fields it names — everything else falls back to
   * `delivery.review`.
   */
  reviewOverrides: z
    .array(
      z.object({
        /** Matches when the issue carries at least ONE of these labels. */
        anyLabels: z.array(nonEmpty).min(1),
        votes: z.number().int().positive().max(5).optional(),
        minSeverity: z.enum(['nit', 'med', 'high', 'blocker']).optional(),
        /** Mesmo enum de `delivery.review.profile` — um perfil inventado aqui só falharia no CLI. */
        profile: z.enum(['fast', 'full']).optional(),
        /** Why this slice is stricter — read by whoever wonders about the cost. */
        reason: nonEmpty.optional(),
      }),
    )
    .default([]),
  models: z.object({
    orchestrator: tiers,
    reviewer: tiers,
    builder: tiers,
    watcher: tiers,
    /** How candidates are ordered. `tiers` = YAML order (0.6 behaviour). `hybrid` = keep tiers, rank by remaining usage inside each. `dynamic` = flatten + usage. `catalog` = discover models via CLI/AA/builtin + usage. */
    routing: z.object({
      mode: z.enum(['tiers', 'hybrid', 'dynamic', 'catalog']).default('tiers'),
      /** Which usage window drives remaining%. `max` = most constrained window. */
      usageMetric: z.enum(['max', 'session', 'weekly', 'monthly']).default('max'),
      /** Prefer providers with live usage % over those with unknown usage (e.g. grok often has no %). */
      preferKnownUsage: z.boolean().default(true),
      excludeProviders: z.array(nonEmpty).default([]),
      /** If non-empty, only these providers may be selected (still must be declared under providers). */
      includeProviders: z.array(nonEmpty).default([]),
      /** Hard pin per role (`provider/model`). If pinned provider is unavailable, fall through unless pinStrict. */
      pin: z.object({
        orchestrator: modelRef.optional(),
        reviewer: modelRef.optional(),
        builder: modelRef.optional(),
        watcher: modelRef.optional(),
      }).prefault({}),
      pinStrict: z.boolean().default(false),
      /**
       * How to choose among the candidates a role's tiers allow.
       *
       * `quality-first` (default, today's behaviour): the best available, with failover. `usage-balanced`: spread
       * across providers by remaining window. `cost-first`: the cheapest that the role can still use — from
       * `models.cost` when declared, otherwise the last tier, which is where a config already puts its cheap
       * last resort. Policy never widens the candidate set; it only orders it.
       */
      policy: z.enum(['quality-first', 'usage-balanced', 'cost-first']).default('quality-first'),
    }).prefault({}),
    /** Relative cost per `provider/model`, any unit you like — only the order matters. Used by `policy: cost-first`. */
    cost: z.record(modelRef, z.number().nonnegative()).default({}),
    /** Quality band when `routing.mode: catalog` (and as soft bias in hybrid). */
    /**
     * cheapest-sufficient: default quality tracks what a role actually does, not tradition. `orchestrator`
     * (freezing a contract from an issue) and `reviewer` (reading a diff) are bounded, structured tasks — neither
     * defaults above `builder`, the role that does the open-ended work of writing and debugging the code itself.
     */
    roles: z.object({
      orchestrator: z.object({ quality: z.enum(['frontier', 'balanced', 'fast']).default('balanced'), preferCreators: z.array(nonEmpty).default([]) }).prefault({}),
      reviewer: z.object({ quality: z.enum(['frontier', 'balanced', 'fast']).default('balanced'), preferCreators: z.array(nonEmpty).default([]) }).prefault({}),
      builder: z.object({ quality: z.enum(['frontier', 'balanced', 'fast']).default('balanced'), preferCreators: z.array(nonEmpty).default([]) }).prefault({}),
      watcher: z.object({ quality: z.enum(['frontier', 'balanced', 'fast']).default('fast'), preferCreators: z.array(nonEmpty).default([]) }).prefault({}),
    }).prefault({}),
    catalog: z.object({
      sources: z.array(z.enum(['cli', 'artificial-analysis', 'builtin'])).default(['cli', 'builtin']),
      /** How long a provider's CLI-discovered model list (e.g. `grok models`) is trusted before spawning the CLI again — it rarely changes between releases. */
      cliCacheHours: z.number().positive().default(6),
      artificialAnalysis: z.object({
        enabled: z.boolean().default(false),
        apiKeyEnv: nonEmpty.default('ARTIFICIAL_ANALYSIS_API_KEY'),
        cacheHours: z.number().positive().default(24),
        endpoint: nonEmpty.default('https://artificialanalysis.ai/api/v2/data/llms/models'),
      }).prefault({}),
    }).prefault({}),
    cooldown: z.object({
      initialMin: z.number().int().positive().default(30),
      maxMin: z.number().int().positive().default(240),
      probeBeforeReenable: z.boolean().default(true),
      /** A usage window at or above this percent counts as exhausted. */
      exhaustedPercent: z.number().min(1).max(100).default(100),
    }).prefault({}),
    providers: z.record(z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/i), ProviderSchema),
    /**
     * Reasoning effort requested per role; only applied for providers whose `effortFlag` is set.
     *
     * cheapest-sufficient, the same rule `routing.roles.*.quality` already follows: effort tracks the difficulty
     * of what a role does. `builder` writes and debugs the code — open-ended, the hardest thing here — while
     * `reviewer` reads a finished diff against stated criteria and `orchestrator` turns an issue into a contract;
     * both are bounded. Giving the writer `medium` while the readers got `high` was the inversion the rule
     * exists to stop, and it was paying more for the cheaper problem.
     */
    effort: z.object({
      orchestrator: effortLevel.default('medium'),
      reviewer: effortLevel.default('medium'),
      builder: effortLevel.default('high'),
      watcher: effortLevel.default('low'),
    }).prefault({}),
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
      /** agentskit-review transport. `headless` is required for current grok-cli (ACP fails on submit_batched_findings); omit to use the CLI default. */
      transport: z.enum(['acp', 'headless', 'auto']).optional(),
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
      /** Doctor probe depth for the review CLI (`help` runs `--help`; `none` only checks PATH). */
      doctorProbe: z.enum(['help', 'none']).default('help'),
      /**
       * Cost lever: a change at or below this many lines — or touching only documentation — is reviewed by the
       * cheapest available candidate instead of the strongest. 0 disables it and every review uses the strongest.
       */
      smallChangeLines: z.number().int().min(0).default(0),
      /** Path prefixes that always get the strongest reviewer, whatever the size (contracts, security, migrations). */
      criticalPaths: z.array(nonEmpty).default([]),
    }).prefault({}),
    merge: z.object({
      auto: z.boolean().default(true),
      method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
      requireChecks: z.boolean().default(true),
      /**
       * Extra synchronous gate on top of a clean review + green checks: a real human must approve the PR on
       * GitHub (`reviewDecision: 'APPROVED'`, already fetched with every PR snapshot) before the loop merges it.
       * False by default so existing configs keep auto-merging on a clean review, matching ADR-0027 §6.
       */
      requireHumanApproval: z.boolean().default(false),
    }).prefault({}),
    /** Optional bounded smoke gate before auto-merge (argv via CommandRunner; default off). */
    smoke: z.object({
      enabled: z.boolean().default(false),
      kind: z.enum(['none', 'verify-argv']).default('none'),
      argv: z.array(nonEmpty).default([]),
      timeoutMs: z.number().int().positive().default(120_000),
    }).prefault({}),
    /** Harness-side verify runtime for smoke/doctor only; workers still see `verifyCommand` as a string. */
    verify: z.object({
      runtime: z.enum(['process', 'docker']).default('process'),
      argv: z.array(nonEmpty).default([]),
      docker: z.object({
        image: z.string().trim().default(''),
        cwd: nonEmpty.default('/work'),
      }).prefault({}),
    }).prefault({}),
    maxFixRounds: z.number().int().min(0).default(2),
    workerIdleTimeoutMin: z.number().int().positive().default(45),
    /**
     * Hard wall-clock ceiling on one dispatch, independent of idle detection: `workerIdleTimeoutMin` only catches
     * a worker that stopped producing output, not one that is still active but has been running far longer than
     * any real task on this project should. Unset (default) = disabled.
     */
    maxDispatchMinutes: z.number().int().positive().optional(),
    /**
     * When a worker goes idle / dies and its provider is out of usage (or otherwise unavailable),
     * relaunch another builder on the **same** Orca worktree + branch with a continuation brief.
     */
    handoff: z.object({
      enabled: z.boolean().default(true),
      maxHandoffs: z.number().int().min(0).max(5).default(2),
      /** Only hand off when the current provider is unavailable (exhausted/cooldown/missing). */
      onlyWhenProviderUnavailable: z.boolean().default(true),
    }).prefault({}),
    selfEditPaths: z.array(nonEmpty).default([LOOP_CONFIG_FILE, '.github/**']),
    /**
     * Glob patterns (same matcher as `selfEditPaths`) for filenames that should never enter a PR the loop reviews
     * or merges, regardless of the diff content — the loop cannot fetch a PR's actual diff content today, so this
     * is a filename-shaped guardrail, not a secret-content scan. A PR touching one of these is held exactly like
     * `selfEditPaths`, with a distinct reason. Defaults cover the most common accidentally-committed secret files.
     */
    secretFilePatterns: z.array(nonEmpty).default(['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa', '**/id_rsa.*', '**/credentials.json', '**/*.p12', '**/*.pfx']),
    /**
     * Real-time enforcement of `selfEditPaths`/`secretFilePatterns` inside the worker's own session, not just at
     * PR-review time. Where the dispatched provider supports it (`claude`, `grok`; `codex` is deliberately left
     * out — its `PreToolUse` hooks have open upstream bugs, see ADR-0038 — and `opencode` gets static deny rules
     * instead of a live hook, also ADR-0038), the loop writes a provider-native permission config into the fresh
     * worktree before the terminal opens, so a write to a protected or secret-shaped path is refused as it
     * happens. This is additive: the PR-time gate stays the only enforcement for a provider it does not cover,
     * and a worker whose hook itself fails (crash/timeout) falls back to that same PR-time gate — see ADR-0038
     * for the fail-open caveats this cannot close.
     */
    workerGuard: z.object({
      enabled: z.boolean().default(true),
    }).prefault({}),
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
    /** Warn (or fail when requireDocBridge) when the Doc Bridge index mtime is older than this many hours. */
    docBridgeMaxAgeHours: z.number().min(0).default(168),
    /** When true, doctor fails if `.doc-bridge/index.json` is missing or unreadable. */
    requireDocBridge: z.boolean().default(false),
    /** Doc Bridge scopes resolved into the worker brief (titles/paths only). */
    briefScopes: z.array(nonEmpty).default(['playbook', 'for-agents']),
    maxBriefReferences: z.number().int().min(0).default(4),
    /** Context providers consulted when freezing a contract. */
    contextProviders: z.array(z.enum(['doc-bridge', 'rag'])).default(['doc-bridge']),
  }).prefault({}),
  memory: z.object({
    /** Master switch. When false the loop never recalls or writes memory. */
    enabled: z.boolean().default(false),
    backend: z.enum(['file', 'none']).default('file'),
    /** Directory under stateDir for the file KV store. */
    storePath: nonEmpty.default('memory'),
    maxRecall: z.number().int().positive().default(5),
    maxSummaryChars: z.number().int().positive().default(240),
    maxBlockChars: z.number().int().positive().default(1_200),
    /** Drop Doc Bridge refs covered by memory so the context budget shrinks. */
    preferOverDocBridge: z.boolean().default(true),
    minDocBridgeWhenMemory: z.number().int().min(0).default(2),
    scopes: z.array(z.enum(['issue', 'project', 'global'])).default(['project', 'global']),
    includeStale: z.boolean().default(false),
    writeOnPromote: z.boolean().default(true),
    categories: z.array(z.enum(['worked', 'problem', 'adjustment', 'other'])).default(['adjustment']),
    shrinkIssueCharsWhenMemory: z.boolean().default(true),
    issueCharsWithMemory: z.number().int().positive().default(4_000),
    /**
     * When a lesson stops being an anecdote and starts being a pattern.
     *
     * A learning proposed `minSightings` times is surfaced by `loop retro` as ready to promote, with the
     * exact command — so the human act is one keystroke instead of an analysis, and at most `maxPerRun`
     * are offered at a time.
     *
     * With `autoPromote.enabled` the retro promotes them itself as `loop-auto` — under the same three
     * bounds, and never as `human` (ADR-0019, amendment of 2026-09-19). Off by default: turning it on is
     * the project's decision, and every automatic promotion stays listable and revocable.
     */
    recurrence: z.object({
      /** How many sightings make a lesson a pattern. Below 2 is "it happened once". */
      minSightings: z.number().int().min(2).max(20).default(2),
      maxPerRun: z.number().int().positive().max(20).default(3),
    }).prefault({}),
    autoPromote: z.object({
      /** When true, `loop retro` promotes the recurring lessons itself, attributed to `loop-auto`. */
      enabled: z.boolean().default(false),
    }).prefault({}),
  }).prefault({}),
  agents: z.object({
    registryPath: nonEmpty.default('agents.registry.yaml'),
    /** When true, missing registry or role entry fails doctor/routing closed. */
    requireRegistry: z.boolean().default(false),
    /**
     * Let the retro propose improvements to the instructions of the agents this project installed under
     * `agents/<id>/`. Off by default; `architect` and `reviewer` are never auto-changed whatever this says, and
     * publishing anything back to the registry is always a human's gesture.
     */
    autoImprove: z.boolean().default(false),
    /** Argv that runs the agent eval. Without it nothing is adopted: a change that cannot be measured is a guess. */
    evalCommand: z.array(nonEmpty).default([]),
    evalTimeoutSec: z.number().int().positive().default(900),
    /** More lines than this in one proposal and it waits for a human. */
    maxAutoLines: z.number().int().positive().default(5),
    /** Bad outcomes per run above which a role is worth improving at all. */
    minRatio: z.number().min(0).default(0.5),
  }).prefault({}),
  rag: z.object({
    enabled: z.boolean().default(false),
    /** Argv that prints a ContextSnapshot (or `{ references, sourceHash }`) JSON on stdout. */
    queryArgv: z.array(nonEmpty).default([]),
    timeoutMs: z.number().int().positive().default(30_000),
    maxReferences: z.number().int().min(0).default(4),
  }).prefault({}),
  mcp: z.object({
    /** Public API / future CLI only in 0.6.0 — not wired into tick/deliver. */
    enabled: z.boolean().default(false),
    allowTools: z.array(nonEmpty).default([]),
  }).prefault({}),
  plugins: z.object({
    /**
     * Local `.mjs` files (relative to `project.root`) loaded once per invocation of any stage (`tick`, `deliver`,
     * `retro`, `release`, `intake`, `maintain` — every one that emits an event); each exports `{ id, apply(bus) }`
     * and gets the loop's in-process event bus to subscribe to (`src/loop/event-bus.ts`) — events
     * (`contract.failed`, `worker.dispatched`, …) and lifecycle hooks (`beforeDispatch`, `beforeMerge`, … a
     * `before*` hook can block the action). Run through `loop stage <name>`, every stage in that one process
     * shares a single bus, so a plugin sees every event the invocation emits, not just its own stage's. Same
     * trust level as `agents.registry.yaml`: files already in this repo, never fetched over the network.
     */
    modules: z.array(nonEmpty).default([]),
  }).prefault({}),
  github: z.object({
    /** A PR labeled with this on GitHub is picked up by deliver even though the loop never dispatched it. Set null to disable intake entirely. */
    intakeLabel: nonEmpty.nullable().default('loop:review'),
    /** Intake PRs are always review + comment only; this loop never merges a PR it did not dispatch, regardless of a clean review. */
    reviewOnly: z.literal(true).default(true),
  }).prefault({}),
  resilience: z.object({
    /**
     * Consecutive failures on the same issue — contract generation failing on every candidate, or a worker/worktree
     * dispatch failing — before the loop stops retrying it and escalates instead of spinning every tick. (Pilot
     * 2026-09-11: one unclassified quota error produced 19 silent retries across 4 issues over 7h with no cap.)
     * `contract.escalated` (a genuine "needs more information" decision) does not count; a successful dispatch,
     * a clean/findings review, or a merge clears the counter.
     */
    maxConsecutiveFailures: z.number().int().positive().default(3),
    /** Label applied (and checked for removal, to auto-resume) when an issue is paused after `maxConsecutiveFailures`. */
    pausedLabel: nonEmpty.default('loop:paused'),
    /** Consecutive *thrown* `loop stage` runs (config/adapter crash, not a normal idle/ok/blocked report) before that stage pauses itself. */
    stagePauseAfterRuns: z.number().int().positive().default(3),
    /**
     * Cost circuit breaker: the loop cannot count a worker CLI's internal model/tool calls (it is an opaque
     * process), so instead it watches the builder provider's remaining Orca usage from dispatch time. If that
     * provider's remaining usage drops by at least this many percentage points *while this one issue is in
     * flight*, deliver stops nudging/reviewing/merging it and escalates like a stuck worker.
     *
     * Default 40 (previously unset/disabled): the incident that motivated this default was a single dispatch
     * burning 25% of a weekly window with nobody told until long after. The number is deliberately generous —
     * this signal is noisy on a provider shared by concurrent dispatches, so it is set high enough that a
     * normal-cost dispatch should not trip it — because tripping only escalates (worktree and PR kept, lease
     * released, a human looks) rather than discarding anything; the delta is logged on every pass regardless
     * (`provider.usage-observed`) so the trend is visible long before this ceiling would ever matter. Set to 100
     * to make it effectively never trip, for a project that wants the log without the breaker.
     */
    maxUsageDeltaPercent: z.number().min(1).max(100).default(40),
  }).prefault({}),
  brief: z.object({
    /** Markdown files (paths relative to `project.root`) pinned verbatim into every worker brief, sha256-digested for traceability. Missing file = dispatch fails closed. */
    skills: z.array(nonEmpty).default([]),
    /** Per-file cap; a file over this length is truncated with a visible note rather than blowing the brief budget. */
    maxSkillChars: z.number().int().positive().default(6_000),
  }).prefault({}),
  security: z.object({
    pii: z.object({
      /** Off by default: scanning issue text/PR findings for PII-shaped patterns before they enter a prompt or a public comment. */
      enabled: z.boolean().default(false),
      /** `redact` replaces a match with `[REDACTED:<kind>]`; `warn` leaves the text as-is but logs a `security.pii-detected` event; `block` fails the contract instead of sending the text anywhere. */
      action: z.enum(['redact', 'warn', 'block']).default('redact'),
    }).prefault({}),
  }).prefault({}),
  /**
   * Ceilings on what the loop may spend. A budget that is reached **escalates; it never insists** — the loop
   * calling the same model again with less headroom is how a bad hour becomes a bad week.
   */
  budget: z.object({
    /**
     * Percentage of a provider's window the loop may consume, leaving the rest for the human sharing the plan.
     * 100 (default) changes nothing; 80 means the loop stops using a provider once 80% of the window is gone.
     */
    perProvider: z.number().min(1).max(100).default(100),
    /** Tokens one issue may consume across every model call the loop makes for it. 0 = no ceiling. */
    perIssueTokens: z.number().int().min(0).default(0),
  }).prefault({}),
  /**
   * Where work comes from when nobody typed it: an alert, a log error, a piece of user feedback. `intake` reads
   * the declared sources, deduplicates against what it already filed, and creates the issue with its evidence.
   * It is what closes the cycle — and the only way the `incident` flow starts without a human at a keyboard.
   */
  intake: z.object({
    enabled: z.boolean().default(false),
    /** Each source is argv printing a JSON array of alerts: `{ id?, title, body?, severity?, url? }`. */
    sources: z.array(z.object({
      id: nonEmpty,
      command: z.array(nonEmpty).min(1),
      timeoutSec: z.number().int().positive().default(120),
      /** Labels every issue from this source carries, on top of `intake.labels`. */
      labels: z.array(nonEmpty).default([]),
    })).default([]),
    labels: z.array(nonEmpty).default([]),
    /** An alert with the same fingerprint inside this window is not filed again. */
    dedupeWindowHours: z.number().positive().default(168),
    /** Severity (as the source reports it, lowercased) → `flow:<name>` label, so a P0 can start the incident flow. */
    flowBySeverity: z.record(nonEmpty, nonEmpty).default({}),
    maxPerRun: z.number().int().positive().max(50).default(5),
  }).prefault({}),
  /**
   * Dependencies, security and licences, on a schedule — what a bot does from outside, inside the loop and under
   * the same Definition of Done. A check that has nothing to decide files nothing.
   */
  maintain: z.object({
    enabled: z.boolean().default(false),
    checks: z.array(z.object({
      id: nonEmpty,
      command: z.array(nonEmpty).min(1),
      timeoutSec: z.number().int().positive().default(600),
      /** `output` files an issue when the command prints anything; `exit-code` when it exits non-zero. */
      fileWhen: z.enum(['output', 'exit-code']).default('exit-code'),
      title: nonEmpty,
      labels: z.array(nonEmpty).default([]),
    })).default([]),
    /** How often the same unresolved finding may be filed again. */
    dedupeWindowHours: z.number().positive().default(168),
  }).prefault({}),
  /**
   * Which implementation of each connector this project uses. The engine speaks only to the interfaces
   * (`TrackerConnector`, `ScmConnector`, `RunnerConnector`); adding Jira, GitLab or a cloud sandbox is a new
   * implementation and a new value here, never a change in tick, deliver or release.
   */
  connectors: z.object({
    tracker: z.enum(['linear']).default('linear'),
    scm: z.enum(['github']).default('github'),
    /** `orca` drives Orca's worktrees and terminals; `local` is git worktree + tmux + the system crontab. */
    runner: z.enum(['orca', 'local']).default('orca'),
    local: z.object({
      /** Where `local` puts its worktrees. Relative paths resolve against `project.root`. */
      worktreeRoot: nonEmpty.default('../.ak-worktrees'),
      tmuxBin: nonEmpty.default('tmux'),
      /** Marker comment the harness owns in the crontab; every line it manages carries it. */
      cronMarker: nonEmpty.default('# ak-harness'),
    }).prefault({}),
  }).prefault({}),
  /**
   * Promotion and deploy. The loop closes an issue when it merges into `project.baseBranch` — the integration
   * branch; `release` moves that batch to `releaseBranch` and runs the project's deploy, and it **never** starts
   * without a human approving the batch. Everything that acts on the world keeps a human in front of it.
   */
  release: z.object({
    enabled: z.boolean().default(false),
    /** Where the approved batch is promoted to. Must differ from `project.baseBranch`. */
    branch: nonEmpty.default('production'),
    /** Deploy argv (no shell), run in `project.root` after the promotion push succeeds. Unset = promotion only. */
    deploy: z.array(nonEmpty).min(1).optional(),
    deployTimeoutSec: z.number().int().positive().default(1_800),
    /** Post-deploy smoke argv. A non-zero exit runs `rollback` (when declared) and escalates. */
    smoke: z.array(nonEmpty).min(1).optional(),
    smokeTimeoutSec: z.number().int().positive().default(300),
    /** When set, release notes for the batch are written here (newest first) and committed before the promotion. */
    notesFile: nonEmpty.optional(),
    /** Rollback argv, declared by the project because only the project knows what undoing its deploy means. */
    rollback: z.array(nonEmpty).min(1).optional(),
    rollbackTimeoutSec: z.number().int().positive().default(900),
  }).prefault({}),
  /**
   * The roles that run per issue, and the plan the worker starts from.
   *
   * The planner and the vote run **in the harness, headless, before dispatch** — the same shape as freezing the
   * contract. The model writes the plan and writes the votes; the machine counts them and decides. The worker is
   * only launched once a plan has consensus, so it starts from an approved plan instead of inventing one.
   */
  worker: z.object({
    plan: z.object({
      enabled: z.boolean().default(false),
      /** How many agents vote on the plan. */
      votes: z.number().int().min(1).max(7).default(3),
      /** How many of them must approve. Default 2 of 3. */
      approvals: z.number().int().min(1).max(7).default(2),
      /** Planner → vote → replan cycles before the item becomes a human's problem. Three models disagreeing three times is an ambiguous requirement. */
      maxCycles: z.number().int().min(1).max(5).default(3),
      timeoutMs: z.number().int().positive().default(300_000),
      /**
       * Per-call budget for `loop plan` (interview, architect, design vote, decompose). Separate from `timeoutMs`
       * because the architect designs a whole PRD against the whole repository, not one issue — and it runs from a
       * human's shell, not inside a scheduler stage capped at 600 s. At 300 s `glm-5.3` never finished a design.
       */
      stageTimeoutMs: z.number().int().positive().default(900_000),
    }).prefault({}),
    /**
     * The phases that run for one issue, in order.
     *
     * Unset (the default) means every phase answers for itself, from its own block — `worker.plan.enabled`,
     * `delivery.verify.argv`, `delivery.review`, `dod.items` — which in practice is `['builder', 'review']` and is
     * exactly what a project that never opted in already has. **Declaring the list makes it the answer**: a phase
     * not named here does not run, however well configured its own block is. That is the point of declaring it.
     */
    roles: z.array(z.enum(WORKER_ROLES)).min(1).optional(),
  }).prefault({}),
  /**
   * The slices of the codebase, each with the one thing that decides it: a label the tracker carries, a file
   * boundary, and the test that closes it.
   *
   * This is the source; a layer's description in the tracker is a reflection of it, never the other way round.
   * The decomposer reads these to place an issue, the brief tells the worker which test closes its layer, and
   * the cheap verifier runs that test instead of the whole suite when the issue belongs to one.
   */
  layers: z.array(z.object({
    id: nonEmpty,
    /** The tracker label that puts an issue in this layer, e.g. `layer:L2`. */
    label: nonEmpty,
    description: z.string().trim().default(''),
    /** Globs the layer owns. A PR for this layer touching anything else is reported, and held when `enforce`. */
    paths: z.array(nonEmpty).default([]),
    /** The command that closes this layer. Used by the brief and by the pre-review verifier. */
    verify: z.string().trim().default(''),
    /** Off by default: a boundary that blocks before a team has drawn it properly costs more than it protects. */
    enforce: z.boolean().default(false),
  })).default([]),
  /**
   * Where the PRD, the technical design and the decisions live once a human approves them.
   *
   * `file` writes them into the repository, which is what makes them reviewable, diffable and greppable by the
   * workers that come later. `none` keeps them only in the loop's state. A tracker-document backend is the seam
   * this leaves open; Orca's CLI has no document command today, so there is nothing honest to implement against.
   */
  documents: z.object({
    backend: z.enum(['file', 'none']).default('file'),
    prdPath: nonEmpty.default('docs/prd'),
    designPath: nonEmpty.default('docs/design'),
  }).prefault({}),
  /**
   * The project's half of the Definition of Done: the same list for every issue, and every item provable.
   *
   * The issue's half is the frozen contract's `outcomes`. A PR merges only when both lists are proven, and the
   * proof — a command's output, a changed file, an absent pattern — is written on the PR. There is deliberately no
   * `manual` kind: what cannot be proven is not a DoD item, it is a wish.
   */
  dod: z.object({
    /** With items declared, the project list is enforced at merge; with none, only the contract outcomes are. */
    items: z.array(z.object({
      id: nonEmpty,
      description: nonEmpty,
      /**
       * `command` — argv the worker runs, exit 0 is the proof (the harness never runs it; the worker does, in its
       * own worktree). `file-changed` — the PR must touch a path matching `glob`. `pattern-absent` — no changed
       * file may contain `pattern`.
       */
      kind: z.enum(['command', 'file-changed', 'pattern-absent']),
      command: z.array(nonEmpty).min(1).optional(),
      glob: nonEmpty.optional(),
      pattern: nonEmpty.optional(),
      /** Restrict `pattern-absent` / `file-changed` to these path globs; empty = every changed file. */
      paths: z.array(nonEmpty).default([]),
    })).default([]),
    /** Where the worker writes its proofs, relative to the worktree root. */
    evidenceFile: nonEmpty.default('.ak-loop/dod.json'),
  }).prefault({}),
  /**
   * Knobs the retro is allowed to move by itself, each inside a declared range and justified by a declared metric.
   *
   * A knob with no metric is not auto-adjustable: the metric is what proves the change helped, and it is the same
   * number that reverts it when the next cycle is worse. Never auto-adjustable, whatever this block says: models,
   * providers, gates and branches — the things that decide who pays and what reaches production.
   */
  tuning: z.object({
    enabled: z.boolean().default(false),
    /** At most this many knobs move in one retro, so a bad cycle changes one thing and stays explainable. */
    maxChangesPerRetro: z.number().int().positive().max(10).default(1),
    /** Commit the edited `loop.config.yaml` with the reason and the evidence. Off by default: committing is the project's call. */
    commit: z.boolean().default(false),
    knobs: z.array(z.object({
      /** Dotted path into this config, e.g. `delivery.review.minSeverity`. Must resolve to a declared field. */
      path: nonEmpty,
      /** The metric that justifies moving it, and that reverts it when the next cycle is worse. */
      metric: z.enum(['review-findings-ratio', 'stuck-count', 'fix-rounds-per-merge', 'escalation-count']),
      /** Ordered ladder of allowed values, cheapest first. Use this for enums. */
      values: z.array(z.union([z.string(), z.number()])).min(2).optional(),
      /** Numeric range. `step` is how far one retro may move it. */
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
    })).default([]),
  }).prefault({}),
  /**
   * Named flow profiles — one motor, several kinds of demand. A profile switches on and off what the loop spends:
   * review strictness and votes, CI babysitting, the human gates, and (as the stages land) the worker's own roles.
   * A selection rule picks one per issue; unmatched issues get `flows.default`.
   */
  flows: z.object({
    /** Profile used when no rule matches. Must name a key of `profiles` (or `null` for "change nothing"). */
    default: nonEmpty.optional(),
    profiles: z.record(nonEmpty, z.object({
      /** Replaces the named `delivery.review` fields for issues on this flow. Other fields keep the project value. */
      review: z.object({
        votes: z.number().int().positive().optional(),
        minSeverity: z.enum(['nit', 'med', 'high', 'blocker']).optional(),
        profile: z.enum(['fast', 'full']).optional(),
        deadlineMs: z.number().int().positive().optional(),
      }).optional(),
      merge: z.object({
        auto: z.boolean().optional(),
        /** CI babysitting: with checks required, a red check becomes a fix round; without, the review is the gate. */
        requireChecks: z.boolean().optional(),
        requireHumanApproval: z.boolean().optional(),
      }).optional(),
      maxFixRounds: z.number().int().min(0).optional(),
      /**
       * Who runs a role on this flow, and how hard it thinks.
       *
       * Precedence is narrow beats broad: the role inside the profile, then the project's config, then the global
       * one. A `provider`/`model` here **narrows** the role's candidate list to that pin; it never widens it, so a
       * pin nobody can serve right now falls through to the role's ordinary candidates instead of dispatching
       * something nobody asked for.
       */
      roles: z.partialRecord(loopRole, z.object({
        provider: nonEmpty.optional(),
        model: nonEmpty.optional(),
        effort: effortLevel.optional(),
        /** Ceiling for one call of this role on this flow. Unset = the role's own default. */
        timeoutMs: z.number().int().positive().optional(),
      })).default({}),
      /**
       * Per-issue phases this flow switches off (or explicitly back on), overriding `worker.roles`.
       *
       * These are the phases of one issue — not the scheduled automations, which are `schedule.*`. `builder` is
       * the work itself: listing it as `false` is accepted and ignored, because a flow that builds nothing is not
       * a flow.
       */
      stages: z.partialRecord(z.enum(WORKER_ROLES), z.boolean()).default({}),
      /**
       * The builder leads instead of typing: it delegates one plan item at a time and integrates the results.
       *
       * Only worth asking for where the provider has subagents (`models.providers.<id>.subagents`). Where it does
       * not, the brief says so plainly and the dispatch record keeps that fact — silently dropping the request
       * would leave a human reading "lead" in the config and a worker that never led anything.
       */
      lead: z.boolean().optional(),
      /** Free-form note shown wherever the flow is reported, so a costlier gate can explain itself. */
      reason: nonEmpty.optional(),
    })).default({}),
    /**
     * Rules are evaluated by kind, never by position: **label, then project, then priority**. A label is an explicit
     * intention and outranks a signal; within one kind the first matching rule wins.
     */
    select: z.array(z.object({
      flow: nonEmpty,
      anyLabels: z.array(nonEmpty).default([]),
      projects: z.array(nonEmpty).default([]),
      priorities: z.array(nonEmpty).default([]),
    })).default([]),
  }).prefault({}),
  /**
   * Where the loop calls a human. The tracker comment always happens — it is the record; this is the channel
   * on top of it. Two generic shapes only: a webhook (Slack, Discord, Telegram bots, n8n) and a local command
   * (system notification, mail CLI). Zero vendor code, so a new destination is configuration, not a release.
   */
  notifications: z.object({
    /** Loop event types that reach the channel. `onEscalate` always does, whatever this list says. */
    events: z.array(nonEmpty).default(['contract.escalated', 'contract.failed', 'issue.paused', 'stage.paused', 'pr.merge-refused', 'release.waiting']),
    webhook: z.object({
      /** Literal URL. Only for the user's global file, which lives outside every repository; in a versioned config use `urlEnv`. */
      url: nonEmpty.optional(),
      /** Name of the environment variable holding the URL — the shape a versioned config uses, since this file never holds secrets. */
      urlEnv: nonEmpty.optional(),
      method: z.enum(['POST', 'PUT']).default('POST'),
      /** Extra headers. Values are literal; put a token in `urlEnv` or a proxy instead of writing it here. */
      headers: z.record(nonEmpty, z.string()).default({}),
      timeoutMs: z.number().int().positive().default(10_000),
    }).optional(),
    /** Argv (no shell). `{summary}`, `{event}`, `{issue}` and `{json}` are substituted per element. */
    command: z.array(nonEmpty).min(1).optional(),
    commandTimeoutMs: z.number().int().positive().default(10_000),
  }).prefault({}),
  schedule: z.object({
    tick: cron.default('*/5 * * * *'),
    deliver: cron.default('*/10 * * * *'),
    /** When set with `retroIssue`, install also creates `<prefix>-retro`. */
    retro: cron.optional(),
    /** Linear issue that receives the weekly retro digest comment. */
    retroIssue: nonEmpty.optional(),
    /** When set, install also manages `<prefix>-observe`: the health scan whose precheck exits 0 only when a human-facing anomaly is new or overdue for a reminder. */
    observe: cron.optional(),
    observer: z.object({
      /** Event window the scan reads, as accepted by `loop observe --since`. */
      since: nonEmpty.default('24h'),
      /** An unresolved problem set already notified is repeated at most this often. */
      reminderHours: z.number().positive().default(2),
      /** No automation run in this long means the scheduler itself stopped, not that the loop is idle. */
      schedulerStallMin: z.number().int().positive().default(20),
      /** A stage lock older than this is presumed abandoned rather than a long run. */
      staleLockMin: z.number().int().positive().default(30),
    }).prefault({}),
    precheckTimeoutSec: z.number().int().positive().default(120),
    /** How the Orca automation invokes the harness inside the workspace; `-f <config>` is appended. */
    harnessCommand: nonEmpty.default('ak-harness'),
    /** Orca agent id that runs the automation prompt; default: the watcher role's first available provider, else claude. */
    provider: nonEmpty.optional(),
    /** Prefix for automation names (`<prefix>-tick`, `<prefix>-deliver`, `<prefix>-retro`, `<prefix>-observe`). */
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
  /** Present when the user's `~/.agentskit/harness.yaml` layer exists and was merged in underneath the project. */
  readonly globalPath?: string
  /** Present when `project.team` (or `$AK_LOOP_TEAM`) selected a `loop.config.team.<key>.yaml` layer. */
  readonly teamPath?: string
  readonly team?: string
  readonly root: string
  readonly stateDir: string
  readonly config: LoopConfig
  readonly configHash: string
  /**
   * Key paths the project's YAML declares that this version's schema does not know, so they were stripped.
   * Almost always a typo (`maxFixRoundz`), occasionally a config written for a newer harness. Reported by
   * `loop validate` and `loop doctor` rather than rejected — see `unknownConfigKeys`.
   */
  readonly unknownKeys: readonly string[]
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
  if (config.linear.states.includes(config.linear.entryState)) fail(`linear.entryState "${config.linear.entryState}" is one of linear.states — planned issues would be dispatched before a human approved them.`, 'INVALID_CONFIG')
  if (config.machine.warningPercent > config.machine.criticalPercent) fail('machine.warningPercent must not exceed machine.criticalPercent.', 'INVALID_CONFIG')
  if (config.models.cooldown.initialMin > config.models.cooldown.maxMin) fail('models.cooldown.initialMin must not exceed maxMin.', 'INVALID_CONFIG')
  if (config.machine.ceiling !== undefined && config.machine.ceiling < config.machine.floor) fail('machine.ceiling must be at least machine.floor.', 'INVALID_CONFIG')
  // `RunnerConnector` has a `local` implementation and no production caller: `tick`/`deliver`/`install` still go
  // straight to Orca. Accepting this silently gave a project Orca behaviour while its config said otherwise —
  // and `doctor` reported `runner.local: passed` on top of it. Fail closed until it is actually wired.
  if (config.connectors.runner === 'local') fail('connectors.runner: "local" is not wired into dispatch yet — tick, deliver and install still use Orca, so setting it would silently run Orca anyway. Use "orca"; follow the local runner in docs/ADR-0039.', 'INVALID_CONFIG')
  return config
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Key paths present in the YAML a project wrote but absent from the validated config: fields zod stripped
 * because nothing declares them. `maxFixRoundz: 9` used to be accepted in silence, with `maxFixRounds` quietly
 * taking its default — a typo that reads as "I configured this" and behaves as "I did not".
 *
 * Reported rather than rejected. A config written for a newer harness legitimately carries keys this version
 * does not know, and failing that closed would make every upgrade a flag day. Silence was the bug, not leniency.
 */
export const unknownConfigKeys = (raw: unknown, parsed: unknown, prefix = ''): readonly string[] => {
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return []
  const dropped: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (!(key in parsed)) { dropped.push(path); continue }
    dropped.push(...unknownConfigKeys(value, parsed[key], path))
  }
  return dropped
}

/**
 * Lists that ARE gates: an overlay adds to them, and removes an entry only by naming it as `!entry`.
 *
 * Replacing them would let an older, more specific layer silently undo a protection added later to a broader one.
 * That is not hypothetical: a machine overlay written to free one file under `.github/` replaced the whole
 * `selfEditPaths`, and so dropped a `packages/**` freeze the project added days later without anyone noticing.
 */
const GATE_LISTS: readonly string[] = ['delivery.selfEditPaths', 'delivery.secretFilePatterns', 'delivery.requiredChecks']

const mergeGateList = (base: unknown, overlay: readonly unknown[]): unknown[] => {
  const removed = new Set(overlay.filter((item): item is string => typeof item === 'string' && item.startsWith('!')).map((item) => item.slice(1)))
  const kept = (Array.isArray(base) ? base : []).filter((item) => !removed.has(String(item)))
  const added = overlay.filter((item) => !(typeof item === 'string' && item.startsWith('!')) && !kept.includes(item))
  return [...kept, ...added]
}

/**
 * Recursive merge: objects merge key by key, arrays and scalars from the overlay replace the base — except the
 * gate lists in {@link GATE_LISTS}, which accumulate across layers and shrink only through an explicit `!entry`.
 */
export const mergeLoopConfig = (base: unknown, overlay: unknown, path = ''): unknown => {
  if (Array.isArray(overlay) && GATE_LISTS.includes(path)) return mergeGateList(base, overlay)
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay === undefined ? base : overlay
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const child = path ? `${path}.${key}` : key
    // A section the base never declared still goes through the merge, so a gate list nested in it is normalised too.
    result[key] = key in base ? mergeLoopConfig(base[key], value, child) : isPlainObject(value) || Array.isArray(value) ? mergeLoopConfig(isPlainObject(value) ? {} : undefined, value, child) : value
  }
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

/** The four layers, in the order they are merged. The most specific wins, and each one has exactly one owner. */
export interface LoopConfigLayers {
  /** `~/.agentskit/harness.yaml` — the user. */
  readonly globalText?: string
  /** `loop.config.yaml` — the project. Weighs more than the global layer, which stays untouched. */
  readonly text: string
  /** `loop.config.team.<key>.yaml` — the team, for what diverges inside one repository. */
  readonly teamText?: string
  /** `loop.config.local.yaml` — this machine. */
  readonly localText?: string
}

/** The team key this machine drains for: `$AK_LOOP_TEAM` first, else `project.team` from the layers merged so far. */
export const resolveTeamKey = (merged: unknown, env: NodeJS.ProcessEnv = process.env): string | null => {
  const fromEnv = env['AK_LOOP_TEAM']?.trim()
  if (fromEnv) return fromEnv
  if (!isPlainObject(merged)) return null
  const project = merged['project']
  if (!isPlainObject(project)) return null
  const team = project['team']
  return typeof team === 'string' && team.trim() ? team.trim() : null
}

/** Merge the layers in order — global, project, team, machine — and validate the result once, as one config. */
export const composeLoopConfig = (layers: LoopConfigLayers): LoopConfig => {
  const project = parseYamlMapping(layers.text, LOOP_CONFIG_FILE)
  // The preset is the lowest layer: it fills what nobody declared and overrides nothing.
  const extendsName = typeof project['extends'] === 'string' ? project['extends'].trim() : ''
  const preset = extendsName ? presetFor(extendsName) : null
  if (extendsName && !preset) fail(`Unknown preset "${extendsName}" in ${LOOP_CONFIG_FILE}. Available: ${PRESET_NAMES.join(', ')}.`, 'INVALID_CONFIG')
  const merged = [
    preset,
    layers.globalText === undefined ? null : parseYamlMapping(layers.globalText, GLOBAL_CONFIG_FILE),
    project,
    layers.teamText === undefined ? null : parseYamlMapping(layers.teamText, 'loop.config.team.<key>.yaml'),
    layers.localText === undefined ? null : parseYamlMapping(layers.localText, LOOP_LOCAL_CONFIG_FILE),
  ].filter((layer): layer is Record<string, unknown> => layer !== null).reduce<unknown>((base, layer) => mergeLoopConfig(base, layer), {})
  return validateLoopConfig(merged)
}

const readIfPresent = (path: string): string | undefined => existsSync(path) ? readFileSync(path, 'utf8') : undefined

export const loadLoopConfig = (path: string = LOOP_CONFIG_FILE, env: NodeJS.ProcessEnv = process.env): LoadedLoopConfig => {
  const absolute = resolve(path)
  let text: string
  try { text = readFileSync(absolute, 'utf8') } catch { return fail(`Loop config not found: ${absolute}`, 'INVALID_CONFIG') }
  const directory = dirname(absolute)
  const globalPath = globalConfigPath(env)
  const globalText = globalLayerDisabled(env) ? undefined : readIfPresent(globalPath)
  const localPath = resolve(directory, LOOP_LOCAL_CONFIG_FILE)
  const localText = readIfPresent(localPath)
  // The team key can come from any layer this machine already has, so it is resolved from a first merge and the
  // team file is then inserted at its own precedence — above the project, below this machine's overlay.
  const team = resolveTeamKey(composeLoopConfig({ ...(globalText === undefined ? {} : { globalText }), text, ...(localText === undefined ? {} : { localText }) }), env)
  const teamPath = team === null ? null : resolve(directory, teamConfigFile(team))
  const teamText = teamPath === null ? undefined : readIfPresent(teamPath)
  if (teamPath !== null && teamText === undefined) fail(`Team "${team}" is declared but ${teamPath} does not exist.`, 'INVALID_CONFIG')
  const config = composeLoopConfig({ ...(globalText === undefined ? {} : { globalText }), text, ...(teamText === undefined ? {} : { teamText }), ...(localText === undefined ? {} : { localText }) })
  const root = resolve(directory, config.project.root)
  return {
    path: absolute, root, stateDir: resolve(root, config.project.stateDir), config, configHash: hashJson(config),
    unknownKeys: unknownConfigKeys(parseYamlMapping(text, LOOP_CONFIG_FILE), config),
    ...(localText === undefined ? {} : { localPath }),
    ...(globalText === undefined ? {} : { globalPath }),
    ...(teamText === undefined || teamPath === null || team === null ? {} : { teamPath, team }),
  }
}

/** Effective Orca agent id and usage key for a provider. */
export const providerIdentity = (config: LoopConfig, provider: string): { readonly orcaAgent: string; readonly orcaUsageKey: string; readonly settings: LoopProviderConfig } => {
  const settings = config.models.providers[provider] ?? fail(`Unknown provider: ${provider}`, 'INVALID_CONFIG')
  return { orcaAgent: settings.orcaAgent ?? provider, orcaUsageKey: settings.orcaUsageKey ?? provider, settings }
}

export type EffortLevel = z.infer<typeof effortLevel>

const renderEffortFlag = (settings: LoopProviderConfig, effort: EffortLevel | undefined): string | null =>
  effort && settings.effortFlag ? settings.effortFlag.replaceAll('{effort}', effort) : null

export const renderTuiCommand = (settings: LoopProviderConfig, model: string, effort?: EffortLevel): string => {
  const base = settings.tui.replaceAll('{model}', model)
  const flag = renderEffortFlag(settings, effort)
  return flag ? `${base} ${flag}` : base
}

/** The review settings in force for one issue — `delivery.review` with any label override applied. */
export type EffectiveReviewSettings = LoopConfig['delivery']['review'] & { readonly overriddenBy: string | null }

/**
 * Resolve the review settings for an issue from its labels (`reviewOverrides`).
 *
 * First match wins, and only the fields it names are replaced — an override that sets `votes` must not
 * silently reset the deadline, the transport or the CLI. `overriddenBy` carries the matched label so the
 * deliver log can say WHY a review cost two votes instead of one; a stricter gate that cannot explain
 * itself reads as a bug.
 */
export const resolveReviewSettings = (config: LoopConfig, labels: readonly string[] = []): EffectiveReviewSettings => {
  const base = config.delivery.review
  for (const override of config.reviewOverrides) {
    const matched = override.anyLabels.find((label) => labels.includes(label))
    if (matched === undefined) continue
    return {
      ...base,
      ...(override.votes !== undefined ? { votes: override.votes } : {}),
      ...(override.minSeverity !== undefined ? { minSeverity: override.minSeverity } : {}),
      ...(override.profile !== undefined ? { profile: override.profile } : {}),
      overriddenBy: matched,
    }
  }
  return { ...base, overriddenBy: null }
}

/**
 * Substitute `{model}` / `{prompt}` inside each headless argv element; the prompt stays one argv element, never
 * shell-joined. `jsonSchema` (a JSON Schema, pre-serialized to a string by the caller) is appended via
 * `structuredOutputFlag` when the provider declares one; a provider without it ignores `jsonSchema` entirely and
 * the caller falls back to marker-based text parsing.
 */
export const renderHeadlessArgv = (settings: LoopProviderConfig, model: string, prompt: string, effort?: EffortLevel, jsonSchema?: string): readonly string[] | null => {
  if (!settings.headless) return null
  const argv = settings.headless.map((part) => part.replaceAll('{model}', model).replaceAll('{prompt}', prompt))
  const flag = renderEffortFlag(settings, effort)
  const withEffort = flag ? [...argv, ...flag.split(/\s+/).filter(Boolean)] : argv
  const structured = jsonSchema && settings.structuredOutputFlag ? settings.structuredOutputFlag.map((part) => part.replaceAll('{schema}', jsonSchema)) : []
  return [...withEffort, ...structured]
}
