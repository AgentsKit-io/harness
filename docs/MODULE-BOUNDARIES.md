# Module and boundary inventory (H-040)

This document is the reviewed starting point for the 0.4.0 work. It describes
the repository at revision `f4b2b092af97d528bd5fe5955ed38f101521b98d` (the
`main` baseline captured on 2026-09-10) and is intentionally descriptive: it
does not claim that the proposed 0.4.0 boundary has already been accepted.

## Classification

| Class | Meaning | Dependency rule |
| --- | --- | --- |
| Kernel | Deterministic contracts, state transitions, policy and metric projections | May use Node standard library and other kernel modules; must not import adapters, provider SDKs, CLI composition, credentials, or UI libraries (`ink`/`react` are composition-only). |
| Execution support | Local process, filesystem, event, evidence, and run lifecycle plumbing | May depend on the kernel; must expose provenance and fail closed at trust boundaries. |
| Adapter | Provider-specific or external-system integration | May depend on kernel contracts; must not be imported by kernel modules. |
| Composition | Package and CLI entry points | May compose kernel, execution support, and adapters; consumers use `src/index.ts`. |

## Complete source inventory

Every current TypeScript module is listed below. Relative imports are the
observed imports at the baseline revision; `stdlib` means Node's built-in
modules, not a provider dependency.

| Module | Class | Responsibility | Relative dependencies | External boundary |
| --- | --- | --- | --- | --- |
| `src/kernel/constants.ts` | Kernel | State, decision, and surface constants | `types` (type-only) | None |
| `src/kernel/errors.ts` | Kernel | Typed fail-closed errors | None | None |
| `src/kernel/hash.ts` | Kernel | SHA-256 and JSON digests | stdlib | None |
| `src/kernel/types.ts` | Kernel | Shared contract, run, evidence, and metric types | `context` (type-only) | None |
| `src/kernel/state-machine.ts` | Kernel | Legal lifecycle transitions and human decisions | `constants`, `types` | None |
| `src/kernel/discovery.ts` | Kernel | Discovery freshness, ambiguity, and decision packets | `errors`, `hash` | None |
| `src/kernel/wip.ts` | Kernel | WIP admission and capacity decisions | `errors` | None |
| `src/kernel/experiment.ts` | Kernel | Comparable runtime/provider selection | `errors` | None |
| `src/delivery/index.ts` | Delivery | G2–G5 delivery gates and deterministic PR projection | `errors`, `hash` | None |
| `src/delivery/review.ts` | Delivery | Bounded parallel adversarial review lenses and evidence verdicts | `errors`, `hash`, `workflow`, `delivery/index` (type-only) | Reviewer callback supplied by caller |
| `src/kernel/cycle.ts` | Kernel | Bounded improvement-cycle assessment | stdlib, `errors` | None |
| `src/kernel/eval.ts` | Kernel | Versioned eval manifest validation, deterministic battery runner, min/median/max aggregation, and fail-closed assessment | `errors`, `hash` | Grader callback supplied by caller |
| `src/kernel/compatibility.ts` | Kernel | Pinned AgentsKit component manifest and evidence-bound compatibility assessment | `errors`, `hash` | Upstream commands and reports supplied by caller |
| `src/kernel/cache.ts` | Kernel | Safe cache keys and in-memory LLM cache contract | `hash`, `errors` | Cache backend supplied by caller |
| `src/kernel/optimization.ts` | Kernel | Token, memory, cache, parallelism comparisons | `hash`, `errors` | None |
| `src/kernel/memory.ts` | Kernel | Memory record validation and memory adapter contract | `errors` | KV store supplied by caller |
| `src/kernel/policy.ts` | Kernel | Tool/action policy gate | `errors` | None |
| `src/kernel/preflight.ts` | Kernel | File-scoped checks and safe-command validation | stdlib, `errors` | Shell command is data, never executed here |
| `src/kernel/block.ts` | Kernel | Portable execution block manifest and dependency admission | `errors`, `hash` | None |
| `src/kernel/learning.ts` | Kernel | Retrospective parsing and human learning promotion | stdlib, `errors` | None |
| `src/kernel/status.ts` | Kernel | Deterministic status snapshot and digest | `errors`, `hash`, `block`, `types` (type-only) | None |
| `src/kernel/model-policy.ts` | Kernel | Role-to-model binding and validation | `errors`, `hash` | Provider is data, not an SDK |
| `src/execution/machine.ts` | Execution support | Machine sampling and adaptive concurrency | stdlib, `types`, `errors` | Host CPU/memory metrics |
| `src/execution/coordination.ts` | Execution support | Atomic issue/worktree claims and dispatch ledger | stdlib, `errors`, `hash` | Local state directory only |
| `src/kernel/resilience.ts` | Kernel | Failure classification and bounded retry/recovery policy | `errors` | Operation callback supplied by caller |
| `src/kernel/workflow.ts` | Kernel | Bounded workflow scheduling | `errors` | Node callbacks supplied by caller |
| `src/kernel/phase-executor.ts` | Kernel | Declarative phase routing, preflight, effect policy, and bounded decisions | `errors`, `workflow` | Phase handlers, gates, and Grill-me callback supplied by caller |
| `src/kernel/artifacts.ts` | Kernel support | Versioned provenance-bound artifacts, Markdown rendering, and idempotent phase resume projection | stdlib, `errors`, `hash`, `events`, `phase-executor` (type-only) | Local state directory only |
| `src/kernel/adapter-contract.ts` | Kernel | Shared assurance levels and bounded telemetry contract | `errors` | Provider measurements supplied by adapters |
| `src/kernel/quality.ts` | Kernel | Phase telemetry validation, 0–100 quality matrix, baseline deltas, and watchdog blockers | `errors`, `hash` | Metrics supplied by phases/adapters |
| `src/kernel/pilot.ts` | Kernel | Cohort freeze and pilot assessment | `errors`, `hash` | None |
| `src/kernel/plugins.ts` | Kernel | Generic slots, dependency checks, and lifecycle listeners | `errors`, `events` (type-only) | Plugin implementation supplied by caller |
| `src/context/index.ts` | Context | Context snapshot contract, hashing, and provider slot | stdlib, `plugins`, `hash`, `errors` | Provider implementation supplied by caller |
| `src/execution/metrics.ts` | Execution support | Benchmark manifest validation, run projection, and comparison | stdlib, `errors`, `files`, `types` | Reads local state only |
| `src/execution/config.ts` | Execution support | Contract loading, profile resolution, and config hashing | stdlib, `constants`, `profiles`, `errors`, `hash`, `files`, `types` | Local `.codex/verification.json` |
| `src/profiles/index.ts` | Profiles | Profile defaults and overrides | `errors` | None |
| `src/execution/files.ts` | Execution support | Run/config JSON and task-artifact filesystem helpers | stdlib, `errors`, `types` | Local filesystem |
| `src/execution/source.ts` | Execution support | Git/source snapshot and dirty-tree detection | stdlib, `hash`, `errors`, `types` | Git CLI |
| `src/execution/runs.ts` | Execution support | Run persistence and lifecycle event creation | `hash`, `files`, `events`, `context`, `types` | Local state directory |
| `src/execution/verification.ts` | Execution support | Plan/start/verify/reconcile/approval orchestration | stdlib, `runs`, `config`, `errors`, `evidence`, `state-machine`, `source`, `files`, `context`, `hash`, `types`, `events`, `machine` | Configured check commands and local processes |
| `src/kernel/events.ts` | Kernel support | Event contracts, append-only log, hash chain, and lock recovery | stdlib, `errors`, `hash`, `context` (type-only), `types` (type-only), `runtime` (type-only) | Local filesystem |
| `src/execution/evidence.ts` | Execution support | Structured evidence parsing and artifact validation | stdlib, `hash`, `files`, `types` | Check output and local artifacts |
| `src/execution/bundle.ts` | Execution support | Signed evidence bundle export and verification | stdlib, `errors`, `files`, `hash`, `verification`, `events`, `config`, `types` | Local keys and files |
| `src/execution/agent.ts` | Execution support | Agent session recorder, resume, and tool lifecycle | stdlib, `events`, `errors`, `policy`, `runtime`, `types` | Agent/runtime callbacks |
| `src/execution/runtime.ts` | Execution support | Process, Docker, and generic tool runtimes | stdlib, `hash`, `errors`, `types` | Child process and Docker CLI |
| `src/cli.ts` | Composition | `ak-harness` / `ak-verify` command surface | `index`, `metrics`, `errors`, `events`, stdlib, `commander` | Shell/CLI invocation |
| `src/index.ts` | Composition | Supported package entry point | All supported public modules | Consumer import boundary |
| `src/adapters/doc-bridge.ts` | Adapter | Deterministic Doc Bridge context provider | stdlib, `hash`, `context` | `.doc-bridge/index.json` |
| `src/adapters/agent.ts` | Adapter | Structured coding-agent execution with bounded timeout and failure classification | `errors`, `resilience`, `adapter-contract` | Agent/provider callback supplied by caller |
| `src/adapters/orca.ts` | Adapter | Safe, idempotent Orca dispatch plan | `errors`, `hash`, `preflight` | Orca CLI arguments; no execution |
| `src/adapters/tracking.ts` | Adapter | Idempotent provider-neutral tracking transition | `errors`, `hash` | User-supplied Linear/GitHub/etc. handler |
| `src/adapters/command.ts` | Adapter | Shell-free command runner seam, PATH executable lookup, Orca JSON envelope parsing | stdlib | Command runner supplied by composition or tests |
| `src/adapters/orca-cli.ts` | Adapter | Typed `orca … --json` calls: version/status/account/agent hooks, worktree ps/create/set/rm, terminal list/send/wait/read, automations list/create/edit/remove/run | `errors`, `command` | Orca CLI via the injected runner |
| `src/adapters/providers.ts` | Adapter | Coding-agent CLI availability: binary, auth, Orca usage windows, exhaustion, cooldown, optional probe | `command` | PATH, env var names, `orca account list` payload |
| `src/adapters/linear-orca.ts` | Adapter | Linear queue via `orca linear list-issues`, issue detail, status/comment/label/attach writes with deterministic `--write-id`, `TrackingAdapter` over Orca | `errors`, `hash`, `orca-cli`, `tracking`, `command` | Linear through the Orca CLI |
| `src/adapters/github-cli.ts` | Adapter | Pull request snapshots, check classification, self-edit path guard, optimistic squash-merge and comments via `gh` | `errors`, `command` | GitHub through the `gh` CLI |
| `src/adapters/code-review.ts` | Adapter | `agentskit-review` argv, `--result` parsing, severity floor, worker-facing findings | `command` (type-only) | AgentsKit code review CLI via runner |
| `src/loop/config.ts` | Composition | `loop.config.yaml` schema (zod), loading, model reference parsing | `errors`, `hash`, `model-policy`, `yaml`, `zod` | Project config file |
| `src/loop/process.ts` | Composition | Real shell-free `CommandRunner` with timeout and output caps | stdlib, `command` (type-only) | Child processes |
| `src/loop/slots.ts` | Composition | Machine slot assessment: adaptive concurrency, RAM reserve, WSL cap, floor | stdlib, `machine`, `config` | Host CPU/memory |
| `src/loop/routing.ts` | Composition | Tiered role → provider/model selection over provider availability | `model-policy`, `providers` (type-only), `config` | None |
| `src/loop/cooldown.ts` | Composition | Provider cooldown store with exponential backoff | stdlib, `providers` | `<stateDir>/provider-cooldowns.json` |
| `src/loop/doctor.ts` | Composition | Loop readiness report: Orca, providers, routing, slots, workers, queue | adapters, `config`, `cooldown`, `routing`, `slots` | Orca CLI via runner |
| `src/loop/contract.ts` | Composition | Task contract schema, orchestrator prompt (issue text as untrusted data), marked-JSON parsing, dispatchability assessment, candidate fallback with auth/quota classification, contract cache | `errors`, `hash`, `resilience`, `doc-bridge`, `config`, `routing` (type-only), `zod` | Headless coding-agent CLI via runner |
| `src/loop/brief.ts` | Composition | Worker prompt: frozen contract + repository rules + protected paths + done signal | `contract`, `config`, `linear-orca` (type-only) | None |
| `src/loop/tick.ts` | Composition | One keep-pushing tick: intake, admit (slots + dispatch ledger claim), contract, dispatch into an Orca worktree, Linear transition, escalation, precheck | adapters, `coordination`, `errors`, `hash`, `brief`, `config`, `contract`, `cooldown`, `doctor`, `routing`, `slots` | Orca CLI + Linear via runner; `<stateDir>` files |
| `src/loop/deliver.ts` | Composition | Deliver stage per dispatched issue: PR detection, self-edit hold, conflict/CI/review fix rounds via terminal, review at head, optimistic squash-merge, Linear Done, cleanup, stuck/abandoned escalation | adapters, `coordination`, `errors`, `config`, `cooldown`, `doctor`, `routing`, `tick` | Orca, Linear, GitHub, agentskit-review via runner; `<stateDir>` files |
| `src/loop/install.ts` | Composition | Orca automation specs (`<prefix>-tick`, `<prefix>-deliver`) with read-only prechecks, idempotent create/edit by name, uninstall, status and the SessionStart hook line | `command`, `orca-cli`, `providers`, `errors`, `config`, `cooldown`, `doctor`, `routing` | Orca automations via runner |
| `src/loop/guided-install.ts` | Composition | Interactive install: doctor + environment preflight, dry-run rehearsal, confirmation, install, status; readline IO injected | `command`, `orca-cli`, `config`, `doctor`, `install`, `tick`, stdlib readline | Terminal prompts; Orca via runner |
| `src/loop/local-config.ts` | Composition | Per-machine overlay wizard: Linear team members via Orca, queue owner and machine tuning answers, YAML rendering and reload | `orca-cli`, `config`, `yaml` | Orca via runner; writes `loop.config.local.yaml` |
| `src/loop/retro.ts` | Composition | Retro digest over `events.ndjson`, per-issue state, cooldowns and Orca runs; rule-based calibration suggestions; Markdown that `parseRetro` can lift into learnings | `orca-cli`, `hash`, `learning`, `config`, `contract`, `cooldown`, `deliver`, `install`, `tick` | Orca via runner (optional); `<stateDir>` files |
| `src/loop/debrief.ts` | Composition | Human-facing read-only snapshot of what the loop is working on (in-flight, holds, escalations, cooldowns) | `config`, `contract`, `cooldown`, `deliver`, `retro`, `tick` | `<stateDir>` files only |
| `src/loop/watch.ts` | Composition | Poll delivery (+ optional live PR) and emit DONE/FAILED/ACTION_REQUIRED/PROGRESS for agents or humans | `command`, `github-cli`, `config`, `deliver`, `tick` | optional `gh` via runner; `<stateDir>` files |
| `src/loop/ui/components.tsx` | Composition | Ink components: check rows, sections, banner, spinner, select/confirm/text prompts | `ink`, `react`, `doctor` (type-only) | Terminal |
| `src/loop/ui/terminal.tsx` | Composition | `createRichIO`: Ink-backed IO for TTYs with a plain-text fallback | `ink`, `react`, `components`, `guided-install` (type-only) | Terminal |

## Allowed dependency directions and exceptions

```text
consumer -> src/index.ts -> composition
                         -> execution support -> kernel
                         -> adapters -> kernel
kernel -----------------> kernel (or Node stdlib)
```

The following are intentional exceptions and are type-only or composition
edges, not provider leakage:

1. `context.ts` uses the generic plugin slot from `plugins.ts`; the provider
   implementation remains outside the kernel.
2. `plugins.ts` references event types and `events.ts` references context and
   runtime types only. These are compile-time contracts, not runtime cycles.
3. `cli.ts` imports from `index.ts` so the CLI exercises the supported public
   surface rather than private implementation paths.
4. `bundle.ts` calls reconciliation because a bundle is only exportable from a
   reconciled terminal run; this is a local execution-support dependency.
5. `runtime.ts` contains process/Docker mechanics because those are execution
   providers. Kernel decisions receive runtime evidence as data and do not
   import the runtime implementation.

Any new external provider (Linear, GitHub, Orca, Doc Bridge, MCP, event bridge,
LLM, or memory backend) must enter through an adapter or plugin slot. A new
provider import in a kernel module is a boundary violation and requires an ADR.

## Public entry point inventory

`src/index.ts` is the only supported consumer entry point. Its named exports
are grouped below; the source file remains authoritative for exact signatures.

| Area | Named exports |
| --- | --- |
| Lifecycle/config | `STATES`, `LEGAL_TRANSITIONS`, `HarnessError`, `loadConfig`, `validateConfig`, `transition`, `assertHuman`, `approvedDecision`, `loadLatestRun`, `planRun`, `startRun`, `verifyRun`, `reconcileRun`, `approveRun`, `authorizeRun`, `retryRun`, `cancelRun`, `cleanTaskArtifacts` |
| Events/plugins/context | `EVENT_LOG_GENESIS`, `FileEventStore`, `HARNESS_EVENT_SCHEMA_VERSION`, `HARNESS_EVENT_TYPES`, `inspectEventLogLock`, `recoverEventLogLock`, `createPluginRegistry`, `createPluginSlot`, `HARNESS_PLUGIN_API_VERSION`, `CONTEXT_PROVIDER_SLOT`, `hashContextSnapshot`, `hashContextSnapshots`, `readContextSnapshots`, `validateContextSnapshot`, `validateContextSnapshots` |
| Discovery and delivery | `assessDiscovery`, `isDiscoveryCurrent`, `assessWip`, `WIP_STATES`, `selectRuntime`, `assessAcceptance`, `assessIntegration`, `assessPreflight`, `assessProduction`, `assessWorktreeCleanup`, `composePullRequest`, `assessPilot`, `IMPROVEMENT_CYCLE_STEPS`, `assessImprovementCycle` |
| Eval and optimization | `assessAgentEval`, `runAgentEval`, `createLlmCache`, `createLlmCacheKey`, `validateCacheableOperation`, `compareOptimization`, `validateOptimizationObservation`, `MEMORY_SCOPES`, `createInMemoryMemoryAdapter`, `createKvMemoryAdapter`, `validateMemoryRecord`, `runWorkflow`, `BENCHMARK_SCHEMA_VERSION`, `benchmarkRuns`, `loadBenchmarkManifest`, `recordBenchmarkObservation`, `validateBenchmarkManifest` |
| Agent/runtime controls | `createSessionRecorder`, `createCodingAgentAdapter`, `createPolicyGate`, `createConfiguredToolRuntime`, `createDockerToolRuntime`, `createProcessToolRuntime`, `createToolRuntime`, `adaptiveConcurrency`, `createMachineMonitor`, `sampleMachine`, `summarizeMachine`, `createDispatchLedger`, `classifyFailure`, `recoveryDelayMs`, `runWithRecovery`, `planFilePreflight`, `validateSafeCommand`, `BLOCK_STATUSES`, `assessBlock`, `validateBlockManifest`, `LEARNING_STATUSES`, `parseRetro`, `promoteLearnings`, `createStatusSnapshot`, `validateStatusSnapshot`, `MODEL_ROLES`, `createModelPolicy`, `modelFor`, `PHASE_MODES`, `createPhaseProfile`, `planPhaseProfile`, `executePhaseProfile`, `ARTIFACT_SCHEMA_VERSION`, `createArtifactEnvelope`, `FileArtifactStore`, `artifactIsFresh`, `resumeStateFromArtifacts`, `ASSURANCE_LEVELS`, `validateAdapterMetadata` |
| Integrations and evidence | `createDocBridgeContextProvider`, `createOrcaDispatchPlan`, `createTrackingAdapter`, `createTrackingTransition`, `EVIDENCE_BUNDLE_SCHEMA_VERSION`, `exportEvidenceBundle`, `readEvidenceTrustStore`, `verifyEvidenceBundle` |

The entry point also re-exports the public type surfaces from `types`,
`events`, `plugins`, `context`, `discovery`, `wip`, `experiment`, `delivery`,
`pilot`, `cycle`, `metrics`, `agent`, `policy`, `runtime`, `bundle`, and
`machine`, `phase-executor`, `artifacts`, plus explicit type exports for cache, optimization, memory,
coordination, resilience, preflight, block, learning, status, model policy,
Orca, and tracking. No adapter implementation is re-exported wholesale.

## External integration inventory

| Integration | Current location | Side effects | 0.4.0 boundary |
| --- | --- | --- | --- |
| Doc Bridge | `src/adapters/doc-bridge.ts` | Reads a local index | Keep behind `ContextProvider`; measure context hit/quality separately. |
| Orca | `src/adapters/orca.ts` | None; produces argv and lifecycle projections only | Keep lease/worktree/issue-lock/SHA planning provider-neutral; execution belongs to the orchestrator. |
| Linear/GitHub/other tracker | `src/adapters/tracking.ts` callback | Caller-owned network mutation | Require idempotency key and explicit tracking authorization. |
| Orca CLI (loop) | `src/adapters/orca-cli.ts`, `src/adapters/linear-orca.ts` via `CommandRunner` | Read-only `--json` calls in the doctor; dispatch/mutation arrive in later loop phases | Argv only, never a shell string; every call bounded by a timeout; envelope `ok:false` fails closed. |
| Coding-agent CLIs | `src/adapters/providers.ts` | PATH lookup and optional probe command | Env keys are names only; usage comes from Orca, never from provider SDKs. |
| GitHub | `src/adapters/github-cli.ts` via `CommandRunner` | `gh pr view/list`, `gh api PUT …/merge` with `sha=<reviewed head>`, `gh pr comment` | Merge is refused by GitHub when the head moved; every call argv-based and bounded. |
| AgentsKit code review | `src/adapters/code-review.ts` via `CommandRunner` | `agentskit-review --pr … --result <file> [--post]` | Exit codes 0/1/2 plus the private result file decide clean/findings/incomplete; the floor is `--block`. |
| Process runtime | `src/execution/runtime.ts` | Starts child processes | Execution support; policy and evidence gates remain kernel decisions. |
| Docker runtime | `src/execution/runtime.ts` | Starts Docker containers | Optional sandbox selected by config, never a mandatory kernel dependency. |
| LLM provider/model | Caller/plugin | Provider call and token spend | Bind provider/model in experiment metadata; do not embed SDKs in kernel. |
| Memory backend | Caller/plugin; `memory.ts` contract | Backend reads/writes | Keep record validation in kernel; backend adapter owns persistence. |
| MCP/event bridge | Not implemented | Future network/event effects | Add as adapters only after a separate ADR and eval coverage. |

## Review status

This inventory is evidence for H-040. ADR-0026 records the accepted boundary;
the remaining H-040 work is empirical baseline collection and verification
evidence, not an unresolved architecture choice.
