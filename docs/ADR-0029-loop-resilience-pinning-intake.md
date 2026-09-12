# ADR-0029: Loop resilience, brief pinning, worktree setup, effort routing, and GitHub intake

- Status: Accepted
- Date: 2026-09-12

## Context

The 2026-09-11/12 pilot ran the keep-pushing loop (ADR-0027) unattended for ~7 hours and surfaced two production
defects and, separately, a review of `ColeMurray/background-agents` (an open-source clone of Ramp's Inspect
background-agent system) suggested transferable ideas already partially covered by this harness's own mechanisms.

Measured from `events.ndjson`: `classifyProviderFailure` did not recognise real Claude/Codex usage-limit phrasing
("You've hit your session limit", "usage limit reached") or Grok's ("Overloaded", "temporarily limiting requests"),
so every such failure fell through to `other` and `onProviderFailure` never fired — no cooldown was ever recorded.
The same gap existed on the review path (`agentskit-review` exit classified without checking the same patterns).
Result: 19 unclassified `contract.failed` retries across 4 issues and 12 incomplete reviews over 7h, with no cap
anywhere — nothing counted consecutive failures on an issue or a stage, so a single misclassified error retried
forever.

## Decision

1. **Failure classification** (bug fix, no schema change): `classifyProviderFailure` (`src/loop/contract.ts`) checks
   a `QUOTA_PATTERN` covering the phrasing above before falling back to the kernel's generic `classifyFailure`, and
   `extractResetsAt` parses a relative (`resets in 3h`) or clock-time (`resets 10:40pm`) reset out of the message.
   `deliver.ts`'s review-incomplete path applies the same classification and marks the **reviewer's own provider id**
   (`ctx.reviewer.provider`, e.g. `codex`) cooling down — not the review-CLI transport id (`review.provider`, e.g.
   `codex-cli`), which `rankModels`/`detectProviders` never look up. This was the second, related pilot bug.
2. **Per-issue and per-stage auto-pause** (new `src/loop/resilience-state.ts`, Composition, no kernel change):
   `resilience.maxConsecutiveFailures` (default 3) pauses a single issue — one deduplicated Linear comment, the
   `resilience.pausedLabel` — after that many consecutive `contract.failed`/`worker.dispatch-failed` events; a
   successful dispatch clears the counter. `resilience.stagePauseAfterRuns` does the same for a `loop stage
   tick|deliver` run that *throws* (not a normal idle/ok/blocked report) repeatedly. Both are separate from, and do
   not replace, the existing `blocked`/`stuck` escalation via `linear.excludeLabels` (ADR-0027 §6) — those already
   self-exclude a terminal outcome; this closes the two pre-dispatch paths that had no ceiling at all.
3. **Skills pinned into the worker brief** (new `src/loop/skills.ts`): `brief.skills` lists Markdown files, read
   once at dispatch time, sha256-digested, truncated at `brief.maxSkillChars` with a visible note, and embedded in
   a new brief section. A missing file fails the dispatch closed. This is deliberately a separate mechanism from
   the existing Doc Bridge `contract.briefScopes` (path/title pointers resolved per issue) — skills are full pinned
   content with a cryptographic digest recorded in `dispatch.json`, and a handoff never re-reads them, so editing a
   skill file after dispatch cannot affect an in-flight worker.
4. **Worktree setup command**: `project.setup.command` (argv, no shell) runs once between `orca worktree create`
   and opening the worker terminal — e.g. `pnpm install --frozen-lockfile` — bounded by `project.setup.timeoutSec`
   (reserved out of the tick time budget so it cannot itself blow the budget). `project.setup.required` (default
   true) routes a failing/timing-out setup through the same worktree-cleanup and consecutive-failure path as any
   other dispatch failure.
5. **Reasoning effort per role**: `models.effort.<role>` is rendered into `tui`/`headless` only for a provider that
   declares `providers.<id>.effortFlag`; a provider without one silently ignores it, so the feature is opt-in per
   provider and safe to default-enable. `agentskit-review` has no such flag, so `models.effort.reviewer` is
   recorded (for `loop retro` grouping and future use) without being wired into the review CLI call.
6. **GitHub label intake** (new `src/loop/github-intake.ts`): `github.intakeLabel` lets a human ask the loop to
   review a PR it never dispatched (tracked as `pr-<n>`, no Linear issue). It reuses the same checks/review/fix-round
   decisions as a normal dispatch, but every nudge becomes a PR comment (no worker terminal exists) and
   `github.reviewOnly` is pinned `true` in the schema — this loop merges only PRs it dispatched itself, never one it
   was only asked to review, however clean that review comes back.

## Consequences

- No kernel change; `pnpm test:boundaries` stays green. All six changes are Composition (`src/loop/*`) or a small
  Adapter addition (`githubOpenPullRequests` gains `label?`, plus `githubLabelRemove`, in `src/adapters/github-cli.ts`).
- `loop.config.yaml` gains six new top-level/nested blocks (`resilience`, `brief`, `project.setup`, `models.effort`,
  `providers.<id>.effortFlag`, `github`), all with safe defaults (`.prefault({})`) so an existing 0.8.0 config keeps
  its exact prior behaviour unless a project opts in.
- New CLI surface: `ak-harness loop resume [issue] [--stage tick|deliver]` and `ak-harness loop paused`.
- `loop doctor` gained a `brief.skills` check; `loop retro`'s `dispatches.byProvider` now groups by
  `provider/model@effort` when an effort was recorded.
- Explicitly out of scope (from `background-agents`): a remote control plane, sandboxed/remote worktrees
  (Modal/E2B/Daytona), prebuilds/snapshots, a multiplayer web UI, and Slack/GitHub-App bots. This harness's runtime
  stays Orca + local worktrees; none of the above changes that.
