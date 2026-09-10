# ADR-0025: Portable orchestration controls

## Status

Accepted

## Context

The SDLC reference project contained useful dispatch, machine, recovery, and
retro mechanisms, but also hard-coded repositories, people, branches, provider
CLIs, and dashboard infrastructure. The Harness must remain reusable and
provider-neutral.

## Decision

Add only deterministic kernel seams: issue/worktree claims, an idempotent
dispatch ledger, failure classification with bounded recovery, file-scoped
preflight planning, portable block/status/learning records, model bindings,
machine thresholds, and provider-neutral Orca/tracking adapters. External
adapters own network effects and credentials. Human decisions remain required
for material ambiguity, recovery, and learning promotion.

## Consequences

The same controls can be used with Orca, another orchestrator, Linear, GitHub,
or a local process. A dashboard, watcher, provider SDK, or repository-specific
shell workflow can be added later without weakening the kernel gates.
