# Changelog

## [0.10.0] - 2026-09-12

Closes the gaps found comparing this harness against LangChain's "custom agent harness" article. The structural
difference stands: this harness orchestrates opaque external CLI agents, so a model/tool-loop middleware isn't
possible here — every item below targets the orchestration layer this loop actually controls (see ADR-0030).

- **Local event bus + orchestration lifecycle hooks**: `plugins.modules` (local `.mjs` files, empty by default)
  loaded once per `tick`/`deliver`, each getting `src/loop/event-bus.ts`'s bus to subscribe to loop events live
  and to `beforeDispatch`/`afterDispatch`/`beforeReview`/`afterReview`/`beforeMerge`/`afterMerge`/`onPause`/
  `onEscalate` — a `before*` hook can return `{ block: true, reason }` to stop the action. `loop doctor` gained a
  `plugins.modules` check.
- **PII/secret scanning**: `security.pii.enabled` (default false) scans issue text before it enters the
  orchestrator prompt and the worker brief for PII-shaped patterns (email, common API-key prefixes, phone,
  card-number-shaped digits); `security.pii.action` is `redact` (default when enabled), `warn`, or `block`.
- **Cost/time circuit breakers** for an in-flight dispatch, since the loop cannot count a worker CLI's own
  model/tool calls: `delivery.maxDispatchMinutes` (hard wall-clock ceiling) and `resilience.maxUsageDeltaPercent`
  (stops a dispatch whose provider's remaining Orca usage dropped past the threshold since it was sent out).
  `dispatch.json` now records `initialRemainingPercent`. Either trip stops the issue like a stuck worker.
- **Human-approval merge gate**: `delivery.merge.requireHumanApproval` (default false) holds a clean, green-checks
  PR until a human approves it on GitHub (`reviewDecision: 'APPROVED'`, already fetched with every PR snapshot).
- **MCP allowlist doctor check**: `loop doctor` validates the default-deny `mcp.allowTools` bridge wiring when
  `mcp.enabled` — MCP stays adapter-only and read-only per ADR-0028, so this checks the allow/deny plumbing, not a
  live connection to an MCP server.
- **Dynamic outcome progress**: the brief documents an optional `progress.json` convention
  (`{"o1": "done", "o2": "in-progress"}`) a worker can write at its worktree root; `loop debrief` shows
  `N/M outcome(s) done` per in-flight issue when present (`src/loop/progress.ts`, best-effort, never required).
- **Secret-shaped filename guardrail**: `delivery.secretFilePatterns` (default covers `.env`, `*.pem`, `*.key`,
  `id_rsa`, `credentials.json`, …) extends the existing `selfEditPaths` hold — a PR touching a matching filename is
  held, never reviewed or merged, in both the normal dispatch path and GitHub label intake.

## [0.9.0] - 2026-09-12

- **Failure-classification fix**: `classifyProviderFailure` now recognises real Claude/Codex/Grok usage-limit phrasing ("You've hit your session limit", "usage limit reached", "credit balance is too low", "spend limit reached", "temporarily limiting requests", "Overloaded") as `quota` instead of falling through to `other`, and `extractResetsAt` parses a relative (`resets in 3h`) or clock-time (`resets 10:40pm`) reset out of the message. A code-review exit is classified the same way, marking the reviewer's provider (not the review-CLI transport id) cooling down instead of retrying every tick. Root cause of a 2026-09-11/12 pilot bug: 19 unclassified `contract.failed` retries across 4 issues and 12 incomplete reviews over 7h with no cooldown ever recorded.
- **Auto-pause after repeated failures**: `resilience.maxConsecutiveFailures` (default 3) pauses a single issue after that many consecutive `contract.failed`/`worker.dispatch-failed` events — one deduplicated Linear comment, the `resilience.pausedLabel` (default `loop:paused`), and it is skipped locally until the label is removed or `ak-harness loop resume <issue>` runs. `resilience.stagePauseAfterRuns` does the same for a `loop stage tick|deliver` run that throws repeatedly, via `loop resume --stage tick|deliver` and a new `loop paused` listing.
- **Skills pinned into the worker brief**: `brief.skills` lists Markdown files (relative to `project.root`) embedded verbatim, sha256-digested, and truncated at `brief.maxSkillChars` in every worker brief's new "Skills (pinned)" section. A missing file fails the dispatch closed. The rendered brief is persisted to `<stateDir>/issues/<id>/brief.md`; `dispatch.json` records `briefDigest` and per-skill digests. A handoff never re-reads `brief.skills`, so editing a skill file after dispatch never affects an in-flight worker. `loop doctor` gained a `brief.skills` check.
- **Worktree setup command**: `project.setup.command` (argv, no shell) runs once in a freshly created worktree before the worker terminal opens (e.g. `pnpm install --frozen-lockfile`), bounded by `project.setup.timeoutSec` (reserved out of the tick budget). `project.setup.required` (default true) fails the dispatch — same cleanup and consecutive-failure accounting as any other dispatch failure — on a non-zero exit or timeout; set to false to only warn.
- **Reasoning effort per role**: `models.effort.<role>` (`low`\|`medium`\|`high`\|`xhigh`) is rendered via `providers.<id>.effortFlag` (e.g. codex `-c model_reasoning_effort={effort}`, grok `--reasoning-effort {effort}`) into `tui`/`headless`; a provider without `effortFlag` ignores it. `dispatch.json` and `loop retro`'s `dispatches.byProvider` record/group by `provider/model@effort`.
- **GitHub label intake**: `github.intakeLabel` (default `loop:review`; `null` disables it) makes `deliver` review and comment on any open PR carrying the label, even one the loop never dispatched (tracked as `pr-<n>`, no Linear issue involved). Every nudge lands as a PR comment instead of a terminal send; `github.reviewOnly` is a fixed schema guarantee — a clean review always ends held ("merge is human") with the label removed, never auto-merged.
- Fixed `scripts/verify-release-manifest.mjs`, which pinned the release version literal to `0.5.0` and would have failed every release since 0.6.0.

## [0.8.0] - 2026-09-12

- Worker **handoff**: when a dispatched worker is idle (or its terminal is gone) and its provider is unavailable (usage/cooldown), deliver relaunches another builder on the **same** Orca worktree + branch with a continuation brief (`renderHandoffBrief`). Lease stays; `dispatch.json` updates terminal/provider/model; `delivery.handoffs[]` + `worker.handed-off` event. Caps via `delivery.handoff.maxHandoffs` (default 2).

## [0.7.0] - 2026-09-12

- Dynamic model routing: `models.routing.mode` (`tiers` | `hybrid` | `dynamic` | `catalog`). Default `tiers` preserves 0.6 behaviour.
- `hybrid`/`dynamic` rank available providers by **remaining Orca usage** (most-constrained window) so work follows quota instead of fixed YAML order.
- Living model catalog (`catalog` mode): CLI discovery (`grok models`), builtin catalog, optional Artificial Analysis cache (`ARTIFICIAL_ANALYSIS_API_KEY`), role quality bands (`frontier`/`balanced`/`fast`).
- Doctor reports remaining usage, why a model was chosen, and Orca integrations missing from `models.providers`.

## [0.6.0] - 2026-09-12

- Loop **approved memory** for token reduction and continuous improvement: file store under `stateDir`, recall into contract/brief with `preferOverDocBridge` + issue-char shrink, human-only `ak-harness loop learning promote`, `memory.recalled` events.
- Doctor: Doc Bridge index/freshness checks; review CLI PATH/`--help` probe (warning when missing).
- Worker brief lists Doc Bridge `playbook` / `for-agents` guidance paths (`contract.briefScopes`).
- Optional deliver smoke gate (`delivery.smoke.verify-argv`) before auto-merge.
- Optional `agents.registry.yaml` role overlay; RAG `ContextProvider` via argv (no hard dep); MCP tool bridge behind policy ([ADR-0028](docs/ADR-0028-mcp-adapter-boundary.md), not loop-wired).
- Optional weekly Linear retro automation (`schedule.retro` + `schedule.retroIssue` → `loop stage retro`).
- Config knobs default off / fail-soft so existing `loop.config.yaml` behaviour is unchanged.

## [0.5.0] - 2026-09-11

- Added the keep-pushing SDLC loop foundation (`ak-harness loop validate|doctor`): `loop.config.yaml` schema (zod), provider detection with Orca usage/rate-limit awareness and cooldowns, role-based tiered model routing, machine slot assessment, Orca CLI and Linear-via-Orca adapters, and the loop doctor report.
- Added loop phase 2 adapters: Orca worktree create/set/rm, terminal send/wait/read and automations argv; Linear issue detail, status/comment/label/attach writes and a Linear `TrackingAdapter`; GitHub PR snapshots, check assessment, self-edit path guard and optimistic squash-merge via `gh`.
- Added loop phase 3 (`ak-harness loop tick|precheck|contract`): orchestrator-frozen task contracts with untrusted issue text, candidate fallback and provider cooldown on auth/quota failures, dispatch ledger claims, Orca worktree dispatch with `--linear-issue`, worker briefs, Linear In Progress transition and `needs-info` escalation.
- Added loop phase 4 (`ak-harness loop deliver`, `precheck deliver`): per-issue delivery state, PR detection by branch, protected-path hold, conflict/CI/review fix rounds sent to the worker terminal with a bounded budget, `agentskit-review` at the current head, optimistic squash-merge, Linear attach/Done, worktree cleanup, stuck/abandoned escalation with slot release.
- Added loop phase 5 (`ak-harness loop install|uninstall|status|hook`): idempotent Orca automations with `--precheck`, existing-workspace mode and session reuse; status with latest runs; a status-only SessionStart hook line; a cross-platform CI job (ubuntu/macos/windows); ADR-0027.
- `loop install` is guided: doctor and environment checks (harness/review CLIs, `gh auth`, Orca repo registration), optional dry-run tick rehearsal, explicit confirmation; `--yes`, `--force`, `--skip-rehearsal`, `--dry-run`, `--plain`.
- `loop install` offers to create the per-machine `loop.config.local.yaml` (queue owner from the Linear team, RAM reserve, worker ceiling) when it is missing; the CLI renders checks and prompts with Ink on TTYs and falls back to plain lines elsewhere. Grok is treated as a CLI subscription (`grok login`), no API key.
- Orca automations now run the stage inside the `--precheck` command (`ak-harness loop stage tick|deliver`, always exit 1) so no agent session is opened per run; `schedule.runner: agent` keeps the previous behaviour. Fixes stuck bypass-permissions sessions leaking one terminal per run.
- Added `ak-harness loop retro [--since 7d] [--json|--learnings]`: escalations by reason, dispatches by provider, merged/blocked/stuck, review outcomes, fix rounds, median lead time, cooldowns, Orca run summary, and rule-based calibration suggestions with the config knob to turn; the Markdown follows the harness retro grammar so `parseRetro`/`promoteLearnings` apply. Suggestions are split by target — `project` (config, issues, process) versus `harness` (library defects seen in production) — with `--target` to filter; the tick records `contract.failed` events.
- Reviews run `agentskit-review --mode trusted-local` by default (`delivery.review.mode`); the isolated default gives claude/codex a temporary HOME without credentials and every lens fails with "Not logged in".
- Review defaults fit an Orca stage: `profile: fast`, `votes: 1`, `concurrency: 4`, and the deadline is capped to the stage budget under `runner: precheck`; `full` profile stays available for long deadlines.
- `delivery.review.transport` (`acp` \| `headless` \| `auto`) is passed through to `agentskit-review` so Grok can use headless when ACP is broken.
- Added `ak-harness loop debrief`: read-only human explanation of in-flight work, holds, escalations and cooldowns (Markdown or `--json`).
- Added `ak-harness loop watch`: TypeScript poller over `delivery.json` (+ optional live PR) emitting `DONE` / `FAILED` / `ACTION_REQUIRED` / `PROGRESS`.
- Workers are launched with the configured TUI command in their own terminal (`orca worktree create` without `--agent`, then `orca terminal create --command <tui>`, wait for idle, send the brief). Orca's `--agent claude` starts in bypass-permissions mode and blocks on a human prompt. The tick has a wall-clock budget under `runner: precheck`; a failed dispatch removes its half-created worktree.
- Add bounded agent eval, safe context/read-only LLM cache, deterministic workflow fan-out/fan-in, and validated optimization observation contracts for token, memory, cache, and parallelism measurements.

## [0.4.0] - 2026-09-10

- Added phase quality matrices, watchdog classification, and resource telemetry.
- Added versioned eval and ecosystem compatibility manifests with fail-closed
  evidence handling.
- Added runnable consumer onboarding, adapter examples, and troubleshooting.

## [0.3.0] - 2026-09-10

- Added portable issue/worktree claims and idempotent dispatch ledger.
- Added failure classification, bounded retry/backoff, and abortable watchdog.
- Added file-scoped preflight planning and shell-composition rejection.
- Added block manifests, status snapshots, retro learning promotion, model
  policies, and provider-neutral Orca/tracking adapters.
- Added configurable machine pressure thresholds and adaptive workflow limits.


All notable changes to `@agentskit/harness` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows Semantic Versioning.

## [0.2.0] - 2026-09-09

### Added

- Pilot-cohort validation that freezes a policy/baseline pair and rejects non-normal, partial, or silently substituted ten-issue cohorts.
- Bounded five-step improvement-cycle assessment with explicit adjustments, repeat decisions, and a deterministic quality matrix.

- Deterministic G2–G5 assessment helpers and CLI commands for independent preflight review, structured idempotent PR handoff, current integration evidence, safe production exposure, and acceptance.

- Current-source evidence now requires a committed Git `HEAD`; directories outside Git fail closed instead of receiving a synthetic revision.

- Discovery gate API and CLI that emit `ready` or an auditable human decision packet from structured ambiguities, approved assumptions and source/contract/context bindings.
- Deterministic WIP admission API and CLI that count blocked and awaiting-human deliveries, reserve resumed work, and reject duplicate ledger entries.
- Controlled runtime-selection API and CLI that reject incomparable Orca/Emdash samples and exclude failed hard gates.
- Configurable `runtime.kind` contract field plus a factory for bounded process or Docker-sandbox execution.
- Real Git snapshot coverage for committed, dirty, untracked, and task-state-excluded evidence.
- Strict TypeScript modular core with generated declarations and source maps.
- Contract-frozen lifecycle, structured evidence, stale detection, human approval, retry, and cleanup.
- Explicit human cancellation and superseded retry history.
- Typed dependency-aware plugin lifecycle with deterministic cleanup.
- Append-only, source- and contract-bound lifecycle event log per run.
- Declarative profile inheritance with validated check overrides.
- Optional provenance-bearing context provider slot for Doc Bridge and Playbook adapters.
- Dependency-free Doc Bridge index adapter with deterministic references and frozen context snapshots.
- Context lifecycle events and stable context hashes that ignore resolution timestamps.
- Portable CLI snapshot resolution and `plan --context-file` binding for shell-based agents.
- Tamper-evident validation for imported context snapshots.
- Direct API callers now receive the same tamper-evident context validation as CLI callers.
- `benchmarkRuns` and `ak-harness benchmark` for reproducible historical run metrics.
- Phase 0 benchmark manifests, task identity bindings, and explicit baseline comparisons.
- Typed agent session recorder with correlated turn/tool events and guarded ordering.
- Adapter metadata and session event protocol that persists hashes instead of raw agent content.
- Required deny-by-default Policy Gate with ordered rules and correlated blocked-tool events.
- Bounded in-process tool runtime with timeout, abort signal, hashed results, and structured failures.
- Shell-free child-process runtime with timeout, output limits, and structured process failures.
- Optional Docker runtime with a no-network, read-only, unprivileged, resource-limited sandbox profile.
- Typed runtime attestation with Docker image digest and effective profile hash in terminal tool events.
- Controlled baseline observation recording through the typed API and `ak-harness benchmark baseline`, with duplicate, unknown-task, and atomic-write protections.
- Benchmark comparisons now require completed harness evidence and report honest non-comparability reasons plus check, outcome, evidence, and review metrics.
- Benchmark baselines now require explicit, unique criterion-level evidence; comparisons report baseline evidence coverage and reject incomplete evidence.
- Comparable benchmark reports now expose directional duration, attempt, and human-review outcomes, with `unavailable` for non-comparable tasks.
- CLI-recorded baseline evidence now preserves a SHA-256 digest of the evidence file and validates digest format on manifest load.
- New lifecycle event logs carry a chained SHA-256 digest and expose explicit integrity verification; legacy logs remain readable but are not reported as verified.
- Event-log locks now carry owner metadata and expose explicit human-authorized stale-lock inspection and recovery through the API and `events lock|unlock` CLI commands.
- Signed evidence verification now supports stable key identities and explicit active/revoked trust stores for controlled key rotation.
- Policy rules can require explicit human approval before sensitive tool actions enter the runtime; unresolved and rejected approvals remain fail-closed and auditable.
- Agent sessions can be resumed from their hash-chained event log, preserving pending approvals without replaying completed tools.
- Ambiguous resumed tool actions now require an explicit human retry or abandonment decision after `tool.execution.started`.
- Benchmark comparisons now expose controlled `escapedIncomplete` deltas for measuring incomplete deliveries that escaped validation.
- Verification results now carry a projection digest in `run.json` and a matching `verification.completed` event; approval rejects projection tampering.
- `ak-harness` CLI and `ak-verify` common-protocol alias.
- Public package documentation and community policy files.
