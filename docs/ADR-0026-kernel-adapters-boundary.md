# ADR-0026: Kernel and adapter boundary for 0.4.0

## Status

Accepted — approved by the owner on 2026-09-10.

## Context

The Harness now contains deterministic SDLC controls, local execution
plumbing, and three provider-facing adapters. The 0.4.0 goal is a modular
engine that can plug in orchestrators, documentation, trackers, memory,
models, MCP, and event bridges without making the kernel provider-specific.
H-040 requires a baseline before changing behavior and must not infer
architecture decisions that belong to the owner.

## Decision

Adopt the following boundary for review:

1. **Kernel:** deterministic contracts and decisions: state machine, discovery,
   WIP admission, delivery gates, eval scoring, cache/memory record contracts,
   workflow scheduling, policy, preflight, coordination, resilience, status,
   learning, model bindings, and metric projections. Kernel modules may use
   Node standard library and other kernel contracts only.
2. **Execution support:** local filesystem, Git/source snapshots, process or
   Docker execution, event logs, evidence, run persistence, reconciliation,
   and the CLI. It may depend on the kernel but does not define provider
   semantics.
3. **Adapters/plugins:** Doc Bridge, Orca, Linear/GitHub (or another tracker),
   LLM providers, memory stores, MCP, and event bridges. They implement
   generic contracts and own credentials/network side effects.
4. **Composition:** `src/index.ts` and `src/cli.ts` compose the surfaces. A
   consumer must not import private module paths as a supported API.
5. **Fail-closed rule:** provider failure, missing evidence, stale source, or
   ambiguous product decisions cannot be converted into a passing kernel
   decision by an adapter.

## Dependency constraints

```text
consumer -> composition -> execution support -> kernel
consumer -> composition -> adapters -> kernel contracts
kernel -> kernel / Node stdlib only
```

Type-only references between `context`, `plugins`, `events`, `runtime`, and
`types` are allowed. `bundle` may call run reconciliation because signed
evidence must be exported only from a reconciled terminal run. These are the
only baseline exceptions; a new runtime import direction requires an ADR.

## Human decisions required

The following decisions are intentionally not inferred by this ADR:

- approve the module classifications in `docs/MODULE-BOUNDARIES.md`;
- approve `codex / gpt-5.6-luna / high` as the pilot's fixed provider/model
  binding, or provide a replacement;
- approve the proposed eval thresholds and three repetitions, or provide
  different values;
- provide or authorize a controlled no-Harness cohort and its task IDs;
- decide whether future MCP/event-bridge adapters belong in this package or a
  separate integration package once their contracts are specified.

The architecture decision is accepted. H-040 still requires empirical baseline
collection and verification evidence before it can be reported complete.

## Consequences

- Swapping Orca, a tracker, Doc Bridge, a model, or a memory backend does not
  require changing kernel decisions.
- External side effects stay auditable and testable through adapter contracts.
- The kernel remains usable in a local process or Docker execution mode.
- Provider-specific integration tests and evals are required before an adapter
  can be described as production-ready.

## Alternatives considered

- **Provider logic in the kernel:** rejected; it couples decisions to vendors
  and makes deterministic comparison impossible.
- **A new abstraction layer for every capability:** rejected for now; one-file
  capabilities stay in the existing capability-first layout until a second
  implementation or boundary test requires a directory.
