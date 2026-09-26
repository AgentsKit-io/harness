# 0.21.0 release candidate

The control plane (`ak-harness ui`) becomes the operator's single place to see what needs them and act on it
safely, plus the loop fixes found running it against a real repository since 0.19.0. `CHANGELOG.md` has the full
list; `docs/ADR-0040` records the decisions.

**Attention first.** The home page is a queue of what needs a person — decisions, stuck or failed runs, state out
of sync, system problems — each with its reason and next action. Empty means nothing does.

**Reconciled, then locked.** Every refresh compares the loop with the tracker and Orca, including issues the board
does not list. Drift is shown and reconciled explicitly; destructive actions refuse (409) while their issue is out
of sync or its data is stale. On a real loop, 24 "blocked" issues were 4 once cancelled work was recognised.

**Every operator action, same kernel.** Held-PR approval (pinned to the head), plan, design and release approval,
learnings, stage pause and resume, tick/deliver/doctor, automation reinstall and batch enqueue call the functions
the CLI calls. There is no deploy from the UI.

**Insights and configuration.** Trends, Costs (tokens and plan usage, no dollar figures) and Explore read at most
30 days of events. Settings shows each value's layer, writes only the personal overlay, returns team changes as a
diff, and records every run queued under a weakened gate.

**Loop.** A worktree kept for inspection no longer blocks its issue forever (#112); scheduled stages run the
harness that installed them and a crashed precheck is reported (#114).

**Behaviour change.** The UI no longer installs Orca automations when it starts; missing or drifted automations
appear as system items and reinstall on request.

**0.21.0.** Runs shows fix rounds used and real time in phase; the home event stream reads the loop's event log
(`GET /api/v1/events/recent`); New batch shows which issues already have a fresh contract (`GET /api/v1/contracts`);
tracker titles and states survive a UI restart.

The blockers in `release/manifest.json` (`ecosystem-compatibility`, `pilot-benchmark`) are unchanged.
