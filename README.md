---
docbridge:
  covers:
    - package:@agentskit/harness
---

# @agentskit/harness

Portable, evidence-backed development protocol for coding agents. The harness freezes a task contract, executes every configured check, binds evidence to the current source revision, detects stale results, and applies the configured controlled or YOLO approval policy.

## Keep-pushing loop (Orca)

`ak-harness loop …` drains one person's Linear queue through Orca worktrees 24/7 — tiered model routing with
usage-aware fallback, orchestrator-frozen contracts, adversarial review, squash-merge, and one deduplicated
escalation when a ticket cannot be verified. Everything project-specific lives in `loop.config.yaml`
(start from [`loop.config.example.yaml`](loop.config.example.yaml)). Guide: [`docs/LOOP.md`](docs/LOOP.md)
(setup, Orca automations, Doc Bridge + `agentskit-review` wiring, AgentsKit ecosystem map, SDLC extension ideas) ·
decision record: [`docs/ADR-0027-keep-pushing-loop.md`](docs/ADR-0027-keep-pushing-loop.md).

## Install

```bash
pnpm add -D @agentskit/harness
```

New consumers can run [`examples/minimum-profile.mjs`](examples/minimum-profile.mjs)
after `pnpm build`; the walkthrough is in [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md).
Common gate and runtime failures are documented in [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

The package requires Node.js 22 or newer and exposes both `ak-harness` and the common-protocol alias `ak-verify`.

## Workflow

```bash
ak-harness doctor --json
ak-harness plan approved --by human
ak-harness start
ak-verify run --json
ak-verify approve <run-id> approved --by human --json
ak-harness cancel <run-id> --by human --reason "Requirements changed"
ak-harness benchmark --manifest benchmarks/harness-phase-0.json --json
```

`plan` rejects unresolved ambiguities and unauthorized dirty worktrees. After `start`, the contract is frozen. Any source, configuration, or contract change invalidates evidence and moves the run to `STALE`. A human can cancel an active run; retrying a blocked, stale, or cancelled run marks the previous run `SUPERSEDED`.

Current-source evidence requires a committed Git `HEAD`. A directory outside Git, or a repository without its first commit, is rejected as `GIT_REQUIRED`; it is not a supported pilot mode because it cannot prove revision currentness.

## Contract

Every repository supplies `.codex/verification.json` with explicit scope, outcomes, applicable surfaces, and executable checks. Each check must declare `evidence: "structured"`; its final output line must be JSON and map to the outcome IDs it proves:

```json
{"status":"passed","criteria":["api-behavior"]}
```

Endpoint, database, CLI, MCP, and UI checks must declare `execution: "real"`. UI checks additionally require `real-browser` and `screenshot` capabilities. Screenshot artifacts carry a project-relative path, SHA-256 hash, and viewport.

## API

The public TypeScript API is exported from `src/index.ts` and includes configuration loading, lifecycle operations, state transitions, evidence verification, approvals, cancellation, retries, task-owned cleanup, versioned capability manifests, event-envelope validation, deterministic phase execution, and stable error classification. Internal modules are not part of the supported API. The checked-in [capability manifest](./capabilities/public-surface.json) is generated from this entry point; run `pnpm test:capabilities` to detect drift.

## Extensibility

The kernel stays responsible for contracts, state transitions, evidence, source
binding, stale detection, and human decisions. Optional integrations use the
typed plugin registry instead of changing those guarantees:

```ts
import { createPluginRegistry, createPluginSlot } from '@agentskit/harness'

const providers = createPluginSlot<{ readonly resolve: (query: string) => Promise<string> }>('context.provider')
const registry = createPluginRegistry()
registry.register({
  id: 'my-context', version: '1.0.0', apiVersion: 1,
  apply: (context) => {
    context.register(providers, 'local', { resolve: async (query) => `context:${query}` })
  },
})
registry.mount()
// registry.contributions(providers) is deterministic and typed.
registry.dispose()
```

Each run also writes an append-only `events.ndjson` containing lifecycle facts
bound to its source revision and contract hash. New event logs carry a chained
SHA-256 digest; verify one with `ak-harness events verify [run-id]`. Logs from
older harness versions remain readable but are reported as `legacy`, not as
verified. After verification, `run.json` also carries a `verificationDigest`
that must match the `verification.completed` event before human approval. Human
approvals, rejections, and tracking authorizations are then recorded as
hash-chained `approval.recorded` or `authorization.recorded` events bound to
that digest, source revision, and contract hash. The stable `run.json` remains
the CLI projection and evidence index.

Use `ak-harness audit [run-id]` to reconcile a run projection with its verified
events. `ak-harness status` performs the same reconciliation before reporting
the current state, so a post-approval edit cannot appear as `COMPLETE`.
Concurrent event writers are serialized by an atomic per-run lock and fail
closed if the log is busy.

Structured plans, findings, decisions, repairs, blockers, approvals, and phase
results can be persisted as provenance-bound `ArtifactEnvelope` records. Each
artifact has a version, run/issue/source/contract/config/context hashes, a
content digest, and both JSON and Markdown representations. `FileArtifactStore`
is idempotent: retrying the same write does not duplicate the event-log record.
Use `resumeStateFromArtifacts` to rebuild completed phase outputs after an
interruption, and inspect records with `ak-harness artifacts inspect <path>` or
`ak-harness artifacts list [run-id]`.

The legacy event-log record remains schema version 1 for compatibility. New
provider-neutral integrations can exchange the schema-versioned v2
`HarnessEventEnvelope`, which requires event identity, correlation, source
revision, idempotency, and provenance metadata. `classifyHarnessError` maps
stable Harness error codes to `retry`, `block`, or `escalate` dispositions.

Replaceable integrations use the shared `AdapterMetadata` contract: every
adapter declares an assurance level (`unverified`, `contract-tested`, or
`runtime-attested`) and measured/unknown telemetry. Coding agents return
structured output, diff, usage, timeout/cancellation status, and failure
classification; Doc Bridge reports relevance and context cost; Orca exposes
lease/lock/worktree/SHA projections; and tracking adapters deduplicate effects
by idempotency key (with a dry-run mode).

Each harness event may also carry an optional `correlation` envelope. Its
`operationId` is the stable identity used when a lifecycle crosses into
AgentsKit, Chat, Doc Bridge, or Code Review; the optional `runId`, `sessionId`,
`turnId`, `actionId`, and `traceId` remain local identities. The envelope is
bounded metadata only and never contains prompts, arguments, results, or
secrets.

Export a reconciled `COMPLETE` run for external review with an Ed25519 key:

```bash
ak-harness events export <run-id> --output evidence.json --private-key private.pem --key-id release-v1
ak-harness events verify-bundle evidence.json --trusted-key-store trust-store.json
```

The bundle includes the run projection, event log, and referenced check outputs,
each with a SHA-256 digest. A trust store can mark keys `active` or `revoked` to
support controlled key rotation. Treat exported outputs as potentially sensitive.

Profiles are optional declarative overlays in `.codex/verification.json`. They
inherit in order, override existing checks by ID, and are resolved before the
contract is frozen:

```json
{
  "profile": "ci",
  "profiles": {
    "ci": {
      "checkOverrides": [{ "id": "unit", "timeoutMs": 120000 }],
      "budget": { "maxDurationMs": 900000 }
    }
  }
}
```

`runtime.kind` chooses the executor used by an integration: `process` is a bounded shell-free local child process; `docker` adds the Docker sandbox. The choice is frozen in the resolved contract and therefore changes its hash. Docker remains fail-closed when its daemon or image is unavailable.

`autonomy: "yolo"` removes the generic final review only after every applicable check passes, tracking is disabled, and the frozen contract has no ambiguity. It never auto-approves a material decision, external tracking, or a tool rule that requires approval.

The phase executor applies the same rule to a declarative SDLC profile. A profile
declares dependencies, inputs/outputs, gates, bounded retries, budgets, and an
effect class (`read`, `write`, or `external`). `safe`, `yolo`, and `dry-run`
profiles share the engine; only the effect policy changes:

```ts
const profile = createPhaseProfile({
  id: 'feature', mode: 'yolo',
  phases: [
    { id: 'discover', outputs: ['plan'], effect: 'read' },
    { id: 'implement', inputs: ['plan'], dependsOn: ['discover'], effect: 'write' },
  ],
})
const result = await executePhaseProfile(profile, {
  preflight: grillMeAndPreflight,
  handlers: { discover, implement },
})
```

Preflight runs for all mutating phases before any effect. Material ambiguities
are returned as one structured decision packet; dry-run previews mutating phases
without invoking their handlers. `planPhaseProfile` exposes the deterministic
route without executing it.

`runAdversarialReview` executes independent review lenses with bounded
concurrency/retries and blocks empty or non-reproducible verdicts. Delivery
helpers hash-bind the approved PR body/metadata and only emit a QA transition
after feature validation and G5 acceptance; failed QA returns to verification.

`createQualityMatrix` aggregates phase evidence, outcomes, duration, token/cache,
machine, and concurrency signals into bounded 0–100 dimensions with baseline
deltas. Missing measurements remain `unknown`; `evaluateWatchdog` emits typed
budget/resource/contention blockers instead of treating absent data as success.

Use named profiles to make the operational choice explicit:

```json
{
  "profile": "process",
  "runtime": { "kind": "process" },
  "profiles": {
    "process": { "runtime": { "kind": "process" } },
    "docker": { "runtime": { "kind": "docker" } }
  }
}
```

```ts
const runtime = createConfiguredToolRuntime({
  runtime: loaded.config.runtime,
  process: { tools: processTools },
  docker: { tools: dockerTools },
})
```

Doc Bridge and Playbook integrations can implement `ContextProvider` and
register it through `CONTEXT_PROVIDER_SLOT`; the kernel records neither their
credentials nor their transport and does not depend on either package. The
portable adapter reads a local Doc Bridge index without adding a dependency:

```ts
import { createDocBridgeContextProvider, planRun } from '@agentskit/harness'

const provider = createDocBridgeContextProvider({ root: process.cwd() })
const context = await provider.resolve({ query: 'harness', scope: ['playbook'] })
const run = await planRun({
  configPath: '.codex/verification.json',
  decision: 'approved',
  contextSnapshots: [context],
})
```

The same boundary is available to shell-based agents:

```bash
ak-harness context resolve harness --scope playbook --json > context.json
ak-harness plan approved --context-file context.json --json
```

`context.json` may contain one snapshot or an array of snapshots, so providers
outside this package can participate without a runtime plugin loader.
The loader rejects a snapshot when its semantic contents no longer match its
`snapshotHash`.

The snapshot stores the Doc Bridge `contentHash`, reference hashes, and a
stable `contextHash`; resolution time is metadata and does not change the
reproducibility hash. Context is resolved before planning and is frozen with
the run, so later index changes cannot silently change its evidence.

## Delivery gates

The optional delivery helpers evaluate gates without embedding a GitHub, Linear,
or deployment provider. Adapters perform external effects only after the
deterministic decision is recorded:

```ts
const g2 = assessPreflight({
  criteria,
  implementerId: 'implementer',
  reviewerId: 'independent-reviewer',
  reviewKind: 'adversarial',
  reviewApproved: true,
})
```

G2 ignores later-gate pending criteria but blocks failed/pending G2 evidence,
self-review, and a third repair. `composePullRequest` creates a structured PR
body only from an approved, current G2 result; it reuses a confirmed matching
remote PR and preserves uncertain state. G3 binds CI to the candidate revision.
G4 requires an approved environment profile, identified artifact, isolation or
version-bound acceptance, technical evidence, and a 15-minute low-risk window.
G5 remains `awaiting-acceptance` until the applicable business/UX decision is
recorded. `assessWorktreeCleanup` permits cleanup only after remote branch SHA,
PR, and G3 all match.

## Pilot cohort

`ak-harness pilot cohort.json` validates the frozen cohort before work starts.
It requires a policy hash, a baseline reference, exactly ten included issues,
and the `normal` classification for each. Excluded or aborted issues need a
reason and cannot be silently replaced in the same manifest.

## Improvement cycle

The five pilot steps can be evaluated as a bounded cycle: adversarial review,
G2 preflight, baseline recording, pilot execution, and harness/no-harness
comparison. Each iteration must contain those steps in order. A failed,
blocked, or pending step requires a reason; repeating requires an explicit
adjustment. The assessment returns `complete`, `repeat` (with the next
iteration), or `blocked` when the adjustment is missing or the iteration
budget is exhausted, plus a criterion-level matrix:

```bash
ak-harness cycle assess cycle.json --json
```

This is a deterministic decision helper: Orca, Emdash, GitHub, Linear, and
other adapters remain responsible for executing external actions and supplying
their structured results.

## Agent optimization and evaluation

The Harness also validates the optimization layer without owning a provider.
The memory boundary accepts only approved records with explicit scope, source
revision, and content hash; an adapter can back it with AgentsKit memory.
`runAgentEval` runs a bounded suite and returns criterion-level accuracy;
`createLlmCache` provides deterministic keys and hit/miss/invalidation evidence
for context and read-only calls; and `runWorkflow` executes independent nodes
in sorted, bounded fan-out/fan-in batches while serializing nodes that share a
`mutationKey`. `OptimizationObservation` carries
optional token, memory, cache, and parallelism measurements and refuses
incomparable provider/model/configuration bindings.

`evals/manifest.json` is the versioned evaluation battery. `validateEvalManifest`
requires contract, deterministic, integration, quality, regression, and
resource layers plus coverage for every supported component. `runEvalBattery`
repeats each case and reports min/median/max scores; unknown, stale, critical,
subjective, or unapproved regression results block the gate.

`compatibility/manifest.json` pins the AgentsKit ecosystem revisions and the
upstream test/eval commands. `assessCompatibility` accepts only complete,
evidence-bound real-adapter observations and blocks unknown or failed upstream
results; migration and rollback procedures are kept beside the manifest.

These are seams, not replacements for AgentsKit packages. An integration may
adapt `@agentskit/memory` and `@agentskit/eval` into them while keeping the
Harness provider-neutral. Missing measurements remain missing; they are never
reported as zero.

## Discovery gate

Discovery is a small deterministic gate before implementation. An adapter or
agent supplies a structured list of ambiguities; the Harness does not decide
product questions. Material ambiguities produce one decision packet with
options and a recommendation. A non-material ambiguity can proceed only when
an approved policy assumption covers it, and the result records that policy in
the decision log.

```bash
ak-harness discovery assess discovery.json --json
```

The result is `ready` or `awaiting-decision`, and carries the source revision,
contract hash, context hash, decision log and digest. Recheck it before
implementation with `isDiscoveryCurrent`: any source, contract or context
change makes the earlier result stale. The input is intentionally portable so
Linear, Orca and Emdash adapters can produce it later without becoming kernel
dependencies.

## WIP admission

Use the same portable approach to decide whether a new issue can start. The
default limit is three deliveries started and not terminal. `blocked`,
`awaiting-decision` and `awaiting-acceptance` still consume a delivery slot;
they release an executor but do not hide unfinished work. Resuming an existing
non-terminal issue keeps its reservation and takes priority over new work.

```bash
ak-harness wip assess wip.json --json
```

## Runtime experiment

Compare Orca and Emdash only when both records carry the same source revision, contract, provider, model, and configuration hash. A failed hard gate is ineligible; the remaining candidates are ordered by human minutes, duration, cost, then `orca` only as the final tie-break.

```sh
ak-harness experiment select experiment.json --json
```

The Harness only assesses the supplied ledger. A future Linear adapter owns
reading and writing the tracker; it must persist the ledger/recovery identity
and use the existing event-log lock before acting.

## Portable orchestration controls

The package includes the small controls needed by an external orchestrator without
embedding a tracker or provider:

```ts
import { createDispatchLedger, createOrcaDispatchPlan, planFilePreflight, runWithRecovery } from '@agentskit/harness'

const ledger = createDispatchLedger('.codex/verification')
const claim = ledger.claim({ tracker: 'linear', repository: 'org/repo', issue: 'ENG-1', worktree: 'eng-1', branch: 'codex/eng-1', owner: 'agent' })
const dispatch = createOrcaDispatchPlan({ repository: 'org/repo', worktree: 'eng-1', branch: 'codex/eng-1', baseBranch: 'main', goalFile: 'GOAL.md' })
ledger.recordDispatch({ lease: claim.lease, idempotencyKey: dispatch.idempotencyKey, commandDigest: dispatch.commandDigest })
```

Claims are keyed by tracker, repository, issue, worktree, and branch. They are
atomic, idempotent, and recoverable only by a human. The ledger never executes
the command; an Orca adapter may execute the returned argv after recording the
decision.

`planFilePreflight` skips documentation-only changes, selects colocated tests,
and `validateSafeCommand` rejects shell composition. `runWithRecovery` retries
only classified retryable failures with a bounded exponential delay and an
abortable watchdog. `parseRetro` produces proposed learnings; only a human can
promote them. `createStatusSnapshot` creates a digest-bound status projection.

Linear/GitHub and Orca integrations should implement the provider-neutral
tracking and dispatch adapters; no credentials or network clients belong in
the kernel.

Agent sessions can record adapter identity, turns, and guarded tool actions
during `IMPLEMENTING` without persisting prompt, argument, or result contents:

```ts
import { createSessionRecorder } from '@agentskit/harness'

const session = createSessionRecorder({
  stateDir: '.codex/verification',
  run: implementingRun,
  adapter: { id: 'my-agent', version: '1.0.0', capabilities: ['tool-calls'] },
  policy,
  runtime,
})
const turn = session.startTurn(inputHash)
const action = session.requestTool({ turnId: turn.payload.turnId, toolId: 'shell', argumentsHash })
await session.executeTool({ actionId: action.payload.actionId, arguments: { command: 'echo ok' } })
session.end('completed')

// After a process interruption, recover the same session from events.ndjson.
const resumed = createSessionRecorder({ stateDir, run, adapter, policy, runtime, sessionId: session.sessionId, resume: true })
```

The recorder enforces turn-before-tool, one terminal result per action, no
pending actions or unresolved approvals at session end, and no calls after
termination. With `resume: true`, it reconstructs turns, pending actions, and
approval decisions from the hash-chained event log; completed actions are not
replayed. It is an observation seam; tool execution and policy decisions remain
separate kernel phases.

Every session also requires a policy gate. The built-in gate is an ordered
allow/block/approve list with deny-by-default behavior:

```ts
import { createPolicyGate, createSessionRecorder } from '@agentskit/harness'

const policy = createPolicyGate({
  rules: [{ id: 'safe-shell', effect: 'allow', toolIds: ['shell'], reason: 'approved local tool' }],
})
const session = createSessionRecorder({ stateDir, run, adapter, policy })
```

The first matching rule wins. A blocked attempt writes `policy.evaluated` and
`tool.blocked` events and raises `POLICY_BLOCKED`; it never becomes a pending
tool action. An `approve` decision writes `tool.approval.requested` and keeps
the action out of the runtime until `session.approveTool({ actionId,
decision: 'approved' })` is called by a human. Rejection writes an auditable
`tool.approval.recorded` and `tool.blocked` pair. Custom policy gates can
implement the same typed `PolicyGate` interface without coupling the harness
to a runtime or provider.

When resuming, an action with a persisted `tool.execution.started` event is
ambiguous: its runtime may have produced an external side effect before the
process stopped. The harness refuses to execute it until a human calls
`session.recoverTool({ actionId, decision: 'retry', actor: 'human' })` or
`session.recoverTool({ actionId, decision: 'abandon', actor: 'human' })`.
Actions that were requested but never started remain safe to execute after
recovery. Completed actions are never replayed.

The built-in runtime executes registered handlers in memory, passes an
`AbortSignal`, enforces a timeout, and records only a result hash and duration:

```ts
import { createToolRuntime } from '@agentskit/harness'

const runtime = createToolRuntime({
  timeoutMs: 30_000,
  tools: [{ toolId: 'shell', execute: async ({ arguments: input }) => runShell(input) }],
})
```

Missing tools, handler errors, and timeouts become structured failures. This is
an execution boundary, not a process/container security sandbox; use a
provider-specific isolated runtime when hard isolation is required.

For a shell-free child-process boundary, register fixed commands with
`createProcessToolRuntime`. It sends one JSON request over stdin, kills a
timed-out or oversized process, and hashes stdout without storing it:

```ts
import { createProcessToolRuntime } from '@agentskit/harness'

const runtime = createProcessToolRuntime({
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  tools: [{ toolId: 'worker', command: process.execPath, args: ['worker.mjs'] }],
})
```

This is a process boundary with bounded I/O, not a container or operating
system security boundary. Use an isolated provider runtime for untrusted code.

For an optional Docker boundary, register fixed image commands with
`createDockerToolRuntime`. The default is fail-closed for image supply: it
uses cached images only, disables network access, makes the container root
filesystem read-only, drops capabilities, runs without privilege escalation,
and applies resource limits:

```ts
import { createDockerToolRuntime } from '@agentskit/harness'

const runtime = createDockerToolRuntime({
  tools: [{
    toolId: 'worker',
    image: 'node:22.13.0-bookworm-slim',
    command: ['node', 'worker.mjs'],
    mounts: [{ source: process.cwd(), target: '/workspace', readOnly: true }],
    cwd: '/workspace',
  }],
  memoryLimit: '512m',
  cpus: 1,
  pidsLimit: 128,
})
```

The provider does not add Docker as a package dependency and is not a VM or a
compromised-daemon boundary. Pin images for reproducibility; set `pull` to
`missing` or `always` only when image acquisition is explicitly authorized.
Completed and failed tool events carry the resolved image digest and an
effective profile hash, so reviewers can identify the runtime used for each
action without storing raw output.

`benchmark` aggregates the local run history into a versioned JSON report. It
includes check/outcome/evidence pass rates, retries, stale runs, human approvals,
and average/median verification duration. With `--manifest`, it also compares
bound harness tasks with explicitly recorded baseline observations. A baseline
must include evidence for every acceptance criterion; missing, duplicate, or
unknown criterion evidence is rejected. Missing baselines and incomplete
evidence remain non-comparable; the harness never invents a baseline. These are
execution metrics, not a claim of productivity improvement; compare reports over
a controlled task corpus to measure that outcome.

Attach a task to a benchmark suite in the verification contract:

```json
{
  "benchmark": {
    "suiteId": "agentskit-harness-phase-9",
    "taskId": "harness-benchmark-evidence",
    "mode": "harness"
  }
}
```

The manifest format is available at `benchmarks/harness-phase-9.json`. Record a
controlled baseline through the public CLI instead of editing JSON by hand:

```bash
ak-harness benchmark baseline harness-benchmark-evidence \
  --manifest benchmarks/harness-phase-9.json \
  --status passed \
  --source manual-run-2026-08-29 \
  --evidence-file benchmarks/harness-phase-9-evidence.example.json \
  --attempts 1 --duration-ms 900000 \
  --review-minutes 20 --escaped-incomplete 0
```

The command validates the task and values, rejects duplicate observations, and
atomically updates the manifest. Baseline observations are explicit records
with a source, timestamp, and criterion-level evidence. An empty or `not-run` baseline is reported as
non-comparable rather than treated as success.

When evidence is supplied through `--evidence-file`, the manifest also stores
the file's lowercase SHA-256 digest as `evidenceDigest`. This binds the
recorded JSON input to the observation; it does not independently validate a
manual, remote, or external source named by an evidence entry.

A comparison is considered comparable only when the task has an explicit
baseline with complete criterion-level evidence and its latest bound harness
run is `COMPLETE`. Blocked, incomplete, missing, or `not-run` inputs expose a
non-comparability reason and mark directional outcomes as `unavailable`.
Comparable reports include check, outcome, evidence, duration, attempt, and
human-review metrics plus directional outcomes. Completed runs with every
check, outcome, and evidence slot passing are projected as
`escapedIncomplete: 0`; a controlled baseline can record observed escapes and
the report exposes their delta and direction. A positive improvement rate
means the harness used less of that measured resource; these metrics do not
establish causality or productivity improvement alone.

## Repository organization

The Playbook contains guidance; this repository contains the enforceable SDLC
engine. See [MANIFESTO.md](./MANIFESTO.md) for the boundary and
[docs/ORGANIZATION.md](./docs/ORGANIZATION.md) for the Angular Conventional
Commits and capability layout.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination /tmp/agentskit-harness-pack
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for changes, tests, and release expectations. See [CHANGELOG.md](./CHANGELOG.md) for version history.

## Release

Releases are published by `.github/workflows/release-harness.yml` after a merge to
`main`. The workflow uses npm Trusted Publishing (GitHub OIDC) and does not read
or require an `NPM_TOKEN`. Configure the npm trusted publisher once for
`AgentsKit-io/harness`, workflow `release-harness.yml`, and package
`@agentskit/harness`; version changes remain the release trigger.
The 0.4.0 candidate checklist and explicit blockers live in
[`release/manifest.json`](release/manifest.json) and
[`release/notes.md`](release/notes.md).

## License

MIT. See [LICENSE](./LICENSE).
