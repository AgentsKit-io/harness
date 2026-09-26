# ADR-0040: Control plane v2 — attention first, reconciled, and still only a projection

## Status

Accepted

## Context

The control plane from #111 replaced a fragile page with a stable projection, but on a real loop it still showed
state that was no longer true and offered destructive actions on it: an issue shown as running after the tracker
closed it, "5/4 workers in use", and a blocked list where most entries had been cancelled weeks earlier. The tracker
board only lists the queue's open states, so the page had no way to learn that those issues were closed. Most of
what the loop records (token spend, per-criterion evidence, routing, cooldowns, learnings, automation drift) was
not visible, and half the operator's actions (approving a held PR, plan and release gates, learnings, stage pause)
existed only in the CLI.

## Decision

1. **The home page is an attention queue**, ordered human decisions → stuck or failed → out of sync → system, then
   oldest first. It is a pure function (`src/ui/api/attention.ts`) of the projection, the reconciliation result and
   cheap local state; an empty queue means nothing needs the operator.
2. **Reconcile before acting.** Each snapshot compares the projection, the tracker and Orca (`reconcile.ts`).
   Issues the board does not carry get their title and tracker state from a cached, bounded, background lookup —
   an unknown state stays unknown, never "closed". Drift becomes an attention item with one action (reconcile),
   and destructive endpoints refuse with 409 while their issue is locked. Missing data is never fresh.
3. **Every action is a kernel function.** Route modules (`src/ui/api/routes-*.ts`) call what the CLI calls:
   `approveHeldDelivery`, `approvePlan`, `approveRelease`, learnings promotion, `pauseStage`/`resumeStage`,
   `runTick`/`runDeliver`/`runLoopDoctor` as jobs, `installLoopAutomations`. There is no deploy endpoint.
   Human gates record the configured person as actor.
4. **The UI no longer installs automations on start.** It reports missing or drifted automations and reinstalls
   them on request, pinned to the running harness binary (#114).
5. **Configuration is shown with provenance and written only to the personal layer.** Team values come back as a
   diff to commit; a tuned knob's revert freezes it and returns the undo as a diff. Weakening a gate is allowed
   only in the personal layer with explicit confirmation, and every run queued under it records `weakenedGates`.
   The kernel floor from ADR-0039 still applies underneath.
6. **Insights are windowed read models.** Metrics and search read at most 30 days of events (the archive
   retention), cache by file size and mtime, and never read an unbounded history.
7. **No new dependencies.** Charts are small SVG components; search is a bounded scan.

## Consequences

- The page can be wrong only for as long as its sources are stale, and it says so: a stale tracker locks
  destructive actions on issues with work in flight; a stale loop locks nothing, because that is when cancel is
  most needed.
- Opening the UI no longer keeps a project's schedule installed by itself; a missing automation is a system item.
- Personal overrides make a machine's runs weaker than the team's on purpose; the badge and the recorded
  `weakenedGates` keep that visible in review.
