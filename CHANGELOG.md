# Changelog

## 0.2.0

- Added portable issue/worktree claims and idempotent dispatch ledger.
- Added failure classification, bounded retry/backoff, and abortable watchdog.
- Added file-scoped preflight planning and shell-composition rejection.
- Added block manifests, status snapshots, retro learning promotion, model
  policies, and provider-neutral Orca/tracking adapters.
- Added configurable machine pressure thresholds and adaptive workflow limits.

## [Unreleased]

- Add bounded agent eval, safe context/read-only LLM cache, deterministic workflow fan-out/fan-in, and validated optimization observation contracts for token, memory, cache, and parallelism measurements.

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
