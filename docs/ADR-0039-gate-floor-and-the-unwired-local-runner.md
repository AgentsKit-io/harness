# ADR-0039: A floor under auto-merge, and an unwired runner that said it was fine

## Status

Accepted

## Context

A pre-publish review asked a question this project had never answered out loud: with
every switch this configuration offers turned off, what still stops a bad change from
merging? The answer was *nothing*, and two separate places in the codebase claimed
otherwise.

**The flow switches compose.** `flows.profiles.<name>.stages` can turn the review,
the local verify and the definition-of-done assessment off for a flow
(`flows.ts:145`), `merge.requireChecks` drops CI gating (`deliver.ts:546`), and
`merge.requireHumanApproval` defaults to `false` (`config.ts:350`). Each of those is
a deliberate, defensible feature on its own — an incident flow that skips the review
to get a fix in is exactly what flows are for. Set together with `merge.auto: true`,
they reach `githubMerge` with red CI, no review, no proof of done and no human. The
comment above the review phase asserted that "every other gate (checks, DoD, the
human approval) still runs". Three of the four things it named are switches.

**A runner that was never called.** `connectors.runner` accepts `local`, and
`createRunnerConnector` returns a real `createLocalRunner` for it — git worktrees,
tmux, the system crontab. Nothing in production calls either function: `tick.ts`
calls `orcaWorktreeCreate` directly, and `loop install` reconciles Orca automations
only. So a project that set `connectors.runner: local` got Orca, silently, while
`doctor` probed for tmux and crontab and reported `runner.local: passed`. The
interface exists, by its own comment, "to prove the engine depends on the interface
rather than on Orca" — but an interface whose second implementation is unreachable
proves the opposite.

## Decision

**Auto-merge has a floor: at least one gate must have examined the diff.** `deliver`
now records what actually vouched for a change — CI (when `merge.requireChecks` is
on and checks came back green), the review, the project verify, the definition of
done — and refuses to auto-merge when that list is empty, holding the PR for a human
instead. No individual switch was removed: turning the review off still works, and
so does turning any other single gate off. What is gone is the combination where
nothing read the diff and nobody was asked to, which is not a faster flow but an
unattended push. A flow that genuinely wants that says so with `merge.auto: false`
and merges by hand — a decision with a person's name on it.

**`connectors.runner: "local"` is rejected at config load.** Fail closed, with a
message that says why, rather than accept a value and do something else. The
`createLocalRunner` implementation and its tests stay: wiring it later should be a
change of caller, not a rewrite. `doctor`'s `runner.local` probe is deleted — it
could only ever describe a configuration that no longer loads.

**The CI self-approval stays, annotated.** `ci.yml` runs
`plan approved --by human` against this repository's own verification contract.
`assertHuman` (`kernel/state-machine.ts:12`) accepts no other actor, so making that
line truthful would mean teaching a human-approval gate to accept a machine. That is
a worse trade than a comment: the approval a human really made is the contract in
the tree, reviewed; CI re-enacts it to exercise the CLI end to end. The workflow now
says so where the line is.

## Consequences

A project using a flow that disabled everything will start seeing PRs held with
`nothing examined this change` instead of merged. That is the intended behaviour
change, and it is the one case where this ADR breaks an existing setup on purpose:
the previous behaviour was merging unreviewed code unattended, which nobody can have
been relying on deliberately.

A project with `connectors.runner: "local"` in its config will fail to load until it
says `orca`. It was already running Orca; only the label changes, and now it is
accurate.

What this does not do: the floor counts gates that *ran*, not gates that were
thorough. A flow with only CI gating on, whose CI is one green no-op job, passes the
floor. This ADR draws a line under "nothing at all", not a quality bar — that remains
what `delivery.review`, `dod.items` and the project's own checks are for.
