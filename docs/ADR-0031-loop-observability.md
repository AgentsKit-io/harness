# ADR-0031: Read-only loop observability

## Status

Accepted

## Context

The keep-pushing loop already records durable events and exposes doctor, debrief,
and retro reports, but operators still have to correlate them manually to find
stalled workers, missing delivery state, or an idle queue. A daemon or dashboard
would add another runtime to operate.

## Decision

Add a read-only `loop observe` command and a pure `assessObservability` function.
The collector reuses existing doctor/debrief/event-log data and read-only Orca
queries. It reports queue, delivery, machine, provider, memory, cache, and token
metrics, plus deterministic anomaly rules for:

- connected terminals with no output;
- active claims without `delivery.json`;
- completed worktrees with uncommitted files;
- ready work with a free slot but no recent dispatch; and
- in-flight worker/review phases past `delivery.workerIdleTimeoutMin`.

`--precheck` provides scheduler-compatible exit semantics (0 actionable, 1
healthy). The event log remains the source of truth; no new persistence or
background process is introduced.

## Consequences

Operators and the existing observer can consume one stable JSON/Markdown report,
while tests exercise the anomaly rules without Orca or network fixtures. A future
dashboard or MCP read-only surface can consume the same report without changing
the loop execution path.
