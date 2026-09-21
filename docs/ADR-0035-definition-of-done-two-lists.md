# ADR-0035: The definition of done is two lists, and there is no `manual` item

## Status

Accepted

## Context

"Done" in an unattended loop has to be decided without a human in the room. A single
checklist cannot do it: some things are true of every issue in a repository (the
suite is green, the changelog moved) and some are true only of this one (the endpoint
returns 404 for an unknown id). Merging them into one list means either restating the
project's rules on every issue or losing the issue's own acceptance criteria.

## Decision

Two lists, both required before a merge:

- **The project's** — `dod.items` in the config. The same for every issue: a command
  that must exit 0, a file the PR must touch, a pattern no changed file may contain.
- **The issue's** — the outcomes of the contract the orchestrator froze before
  dispatch, each with the check that proves it.

The worker runs the checks in its own worktree and writes the proofs to
`.ak-loop/dod.json` (and what it ran to `.ak-loop/verify.json`, ADR-0035's companion
in `src/loop/artifacts.ts`). `assessDod` judges both lists, and the table — item,
verdict, evidence — is written onto the PR either way, so a human reading the PR sees
proof rather than a promise.

An item the worker did not prove is **missing**, not **failed**. The difference is
the instruction that goes back: missing means "prove it", failed means "fix it", and
a loop that conflates them sends the wrong one.

Some checks the harness can decide by itself from the PR's changed files
(`file-changed`, `pattern-absent`); `command` is never one of them, because the
harness does not run project commands — the worker does, in its own worktree, where
the change actually is.

**There is deliberately no `manual` kind.** An item whose proof is "someone looked at
it" cannot gate an unattended merge; it is a wish, and calling it a definition of
done would make the whole table untrustworthy. Work that genuinely needs a human eye
is `delivery.merge.requireHumanApproval`, which is a gate with a name, not a
checkbox nobody can check.

## Consequences

A project with no `dod.items` still gets the issue list enforced, so adopting the
loop costs nothing up front. The bar rises by adding items, one at a time, each of
which must be provable — which is the only honest way to raise it.
