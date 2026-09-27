# ADR-0041: Agent runs and rendered specs

## Status

Accepted

## Context

ADR-0032 made every transition an event, so the *path* an issue took can be rebuilt from `events.ndjson`
(`loop issue-timeline`). What cannot be rebuilt is the *content*: the prompt the orchestrator was given, the plan it
returned, the brief the worker received, what the worker left behind, and what one step actually handed the next.
Those lived in scattered places (`issues/<id>/*.json`, the worktree's `.ak-loop/`, a terminal screen) or nowhere, so
"how was this built?" had no answer once the worktree was gone.

The second gap is on the PR. A reviewer sees a diff and the DoD table, but not the specification the change was
built against. The contract and the approved plan already are that specification — as JSON in the local state dir.

## Decision

**One issue, one run.** `<stateDir>/runs/<issue>-<n>/` holds:

```
state.json    projection of the issue's events: currentStage, status, loopCount/maxLoopCount,
              lastOutput, nextRequiredApproval, pr, head, supersedes
inputs/       NN-<stage>-<role>.md   what a step was handed (prompt, brief), redacted
outputs/      NN-<stage>-<role>.*    what it produced (raw model output, worker artifacts, terminal tail)
handoffs/     NN-<from>-to-<to>.json what the machine passed on at each stage change
evidence/     index.json             proof files linked by sha256 (verify.json, DoD, review), never copied
```

- A second dispatch, or any opening event after the run closed, starts run `n+1` with `supersedes` pointing back.
- **Nothing here is a source of truth.** `issues/<id>/` and `events.ndjson` stay authoritative. `state.json` is
  `classifyRunEvent` folded over the issue's events as `appendLoopEvent` writes them. Recording is best-effort and
  never fails the stage that emitted the event.
- **Handoffs are written by the machine**, from state it already holds: the triggering event, the I/O recorded
  since the previous handoff (by hash), the frozen contract's outcome ids, the plan's unresolved objections, the
  evidence hashes and the next required approval. A model never writes one — same rule as ADR-0032.
- **Capture is everything the harness sees**, passed through `scanForPii` first. The worker's own session stays
  opaque (runner-specific); its brief, artifacts and terminal tail are captured. `digest:` identical content is
  stored once per run; a repeat under another name is a `.ref.json` pointer.
- **`windowed:`** `runs.keep` runs per issue (default 3) and closed runs younger than `runs.maxAgeDays` (30),
  pruned at the start of each tick. The open run is never pruned.

**Specs are rendered, not written.** With `spec.enabled`, dispatch renders `specs/<issue>/requirements.md`,
`design.md` and `tasks.md` (the GitHub Spec Kit / Kiro layout) into the worktree from the frozen contract and the
approved plan — pure functions, no model call, no new gate on content. Requirement ids *are* the contract's outcome
ids, so requirement → check → evidence (`verify.json`) is traceable without a new mapping. The worker commits the
files unchanged; `deliver` re-renders them and sends a fix round when they are missing, uncommitted, or drifted
from the frozen contract.

**The PR carries the run.** With `runs.prSummary`, `deliver` keeps one comment on the PR — found by a marker and
edited in place (`ScmConnector.upsertComment`) — with the run's stage, status, handoffs and evidence hashes. It is
re-posted only when the run changed.

## Consequences

`loop run show <issue|run-id>` reconstructs a run from disk without the worktree; `loop issue-timeline` still owns
the event-level view. A run directory can be deleted at any time without changing what the loop decides next.
The cost is disk (bounded by `runs.keep`/`maxAgeDays`/`maxIoBytes`) and one small lock per event.

Specs are off by default: turning them on adds files to every PR and a new reason for a fix round, which a project
opts into. A worker that wants the spec to change says so in `plan.md`; the spec changes when the contract does.
