# 0.24.0 release candidate

**0.24.0.** `ak-harness mvp evidence` collects a product's MVP evidence from GitHub for `mvp report --evidence`, and
`docs/mvp.yaml` accepts flat inline maps, checked against a synthetic parity corpus. 0.23.0 was never published, so
this is the first npm release since 0.22.3 and includes the 0.23.0 notes below.

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

**0.22.0.** Every issue gets a run under `<stateDir>/runs/<issue>-<n>/` — projected state, redacted inputs and
outputs, machine-written handoffs and evidence by hash — reconstructable with `ak-harness loop run show` (ADR-0041).
`spec.enabled` renders `specs/<issue>/` (requirements, design, tasks) from the frozen contract and plan and holds a PR
whose copy drifted; `runs.prSummary` keeps one edited comment with the run on the PR. `ScmConnector` gains
`upsertComment`.

**0.22.1.** Fixes for failures that were silent. The control plane no longer keeps a tracker rate-limited (it
backed off nothing and re-fetched every closed issue forever); the loop gets a tracker cooldown instead of a
permanent stage pause. `ak-verify run` exits non-zero on a blocked run; git errors, missing review results, a
verify run outside the PR worktree and failing plugins now fail closed. One transient error no longer ends a
delivery for good, and an Orca outage is not a dead worker.

**0.22.2.** Operational fixes: a nit-only review no longer leaves delivery waiting forever, answered contract
questions regenerate the contract, an open question no longer re-escalates every tick, Retry resumes a blocked
delivery on its open PR, and doctor accepts UI-pinned automations.

**0.22.3.** A run that loses track is restarted from scratch — only after two consecutive observations, never over
unpushed or uncommitted work, never past a worker's declared blocker, never while the tracker is cooling down. A
worker that declares itself blocked is escalated to a person; the loop never types into a bare shell or launches a
second agent into a worktree; close-or-reopen decisions stick and free the issue.

**0.23.0.** `ak-harness mvp check|digest|report` validates a product's `docs/mvp.yaml`, computes its approval digest
and reports progress by evidence level and requirement state, with a versioned `--json` schema and issues/PRs linked
by their `mvp:<id>` label; pipelines pin the exact version and call it from the installed package. Every publish now
creates its GitHub release from `CHANGELOG.md`. Breaking: 13 playbook-evaluation commands and their exports are
removed and the tarball ships four docs instead of all of `docs/`. The loop only contracts PM-approved issues
(`loop:pm-ok`); the fleet runner dispatches through the fleet coordinator queue (ADR-0045) and runs fix rounds there;
the definition of done is proven on a local checkout before merge, with an independent verifier deciding "proven"
(ADR-0047); and the merge comment on the tracker issue carries the delivery evidence and a RESOLVED / PARTIAL /
NOT PROVEN verdict (ADR-0044).

**Publishing.** 0.24.0 is minor: new features, and the only API break since 0.22.3 is the 0.23.0 removal above
(the package is still 0.x). It is published by `release-harness.yml` through npm Trusted Publishing once the
registry accepts that workflow again: every publish since 0.23.0 was rejected with E404 on
`PUT @agentskit/harness`, which is fixed on npmjs.com, not in this repository.

The blockers in `release/manifest.json` (`ecosystem-compatibility`, `pilot-benchmark`) are unchanged.
