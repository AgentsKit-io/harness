# ADR-0034: Connectors for the tracker, the SCM and the runner

## Status

Accepted

## Context

The loop was written against Linear, GitHub and Orca because those are what it runs
on. Calling them directly from `tick`, `deliver` and `release` makes every one of
those files know a vendor's CLI, and makes "does this work without Orca?" a question
nobody can answer without reading all of them.

## Decision

Three seams, each a narrow interface the stages depend on:

- **Tracker** — the queue, an issue's detail, its state transitions and comments.
- **SCM** — pull requests, their checks, comments, labels and the merge itself.
- **Runner** — where work executes: a worktree and a terminal, or a local process.

`resolveConnectors` selects tracker and SCM from `connectors.*`;
`createRunnerConnector` selects the runner the same way.

**A seam is only proven by a second implementation.** An interface with one
implementation is a guess about what varies, and it is wrong in the same direction
every time: the single vendor's shape leaks into the interface and nobody notices
until the second one arrives.

Today that rule is met by exactly one of the three. The runner has two — `orca`
(worktrees and terminals) and `local` (git worktree, tmux, the system crontab) — and
that seam is therefore the one known to hold. `connectors.tracker` accepts `linear`
and `connectors.scm` accepts `github`, and nothing else: those two interfaces are
written from one vendor each, and this ADR records that as an open risk rather than
as portability the harness does not have. An unknown value fails closed, naming the
interface to implement.

A second tracker or SCM is a new factory in `connectors.ts` and a new value in the
enum — never a change in `tick`, `deliver` or `release`. Whatever that change forces
in the interface is the measurement of how much of the vendor had leaked in.

## Consequences

The stages are testable with plain fakes and no network. The cost is one indirection
between a stage and the CLI it ultimately calls, and the discipline of keeping the
interfaces narrow: a method added for one vendor's convenience is how the seam
starts leaking again.
