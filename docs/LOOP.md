# Keep-pushing loop (`ak-harness loop`)

The loop drains one person's Linear queue through Orca worktrees, 24/7, with role-based model routing and
usage-aware fallback. The harness supplies the deterministic parts (claims, machine pressure, gates, evidence);
Orca supplies scheduling, worktrees, terminals, Linear access and visibility. Everything project-specific lives in
`loop.config.yaml` — switching project or person is a config change, never a code change.

Status: **complete (phases 1–5).** Config, doctor, adapters, the dispatch tick, the deliver stage and the Orca
automation installer are in place. See [ADR-0027](ADR-0027-keep-pushing-loop.md).

## Commands

```bash
ak-harness loop validate -f loop.config.yaml          # schema check + effective config + hash
ak-harness loop doctor   -f loop.config.yaml --json   # readiness report (exit 1 when a blocking check fails)
ak-harness loop doctor --no-probe                     # skip provider probe commands
ak-harness loop precheck tick                         # exit 0 when a slot, a builder and a candidate exist (Orca --precheck)
ak-harness loop tick --dry-run --max 1                # plan the next dispatch, print the exact orca argv, write nothing
ak-harness loop tick                                  # dispatch up to <free slots> workers
ak-harness loop contract ENG-123 [--refresh|--dry-run] # freeze or show the orchestrator contract for one issue
ak-harness loop precheck deliver                      # exit 0 when a dispatched issue is in flight
ak-harness loop deliver [--dry-run] [--issue ENG-123] # drive dispatched workers to merge
ak-harness loop install [--yes|--force|--skip-rehearsal|--skip-local-config|--dry-run|--plain]  # guided: overlay → checks → rehearsal → confirm
ak-harness loop uninstall [--dry-run]                 # remove them
ak-harness loop status                                # what Orca knows: enabled, trigger, provider, latest run
ak-harness loop hook                                  # one status line for a SessionStart hook; never mutates
ak-harness loop debrief [--issue ENG-123] [--since 24h]  # human-facing: what is in flight, held, escalated
ak-harness loop watch [--issue ENG-123] [--once] [--interval 30]  # poll delivery/PR; DONE|FAILED|ACTION_REQUIRED
ak-harness loop retro [--since 7d] [--json|--learnings]  # weekly digest + calibration suggestions
```

### Debrief and watch

`loop debrief` is the human companion to the automations: a read-only Markdown (or `--json`) snapshot of
in-flight dispatches, delivery phase (waiting for PR / review / fix round / ready to merge), holds that need a
person, recent escalations and provider cooldowns. It does not call Orca or `gh` — only the loop state directory —
so it is safe to run from a SessionStart hook or a chat agent that needs context before acting.

`loop watch` polls `delivery.json` (and optionally the live PR via `gh`) and prints line-oriented events:

| Event | Meaning |
|---|---|
| `DONE` | Delivery finished as merged (or the PR is MERGED) |
| `FAILED` | stuck / abandoned / failed / PR closed without merge |
| `ACTION_REQUIRED` | held for a human, incomplete review twice, or fix-round findings |
| `PROGRESS` | still moving (waiting for PR, review pending, …) |

Use `--once` for a single snapshot; omit it to block until a terminal outcome (or `--timeout <seconds>`).

## Running 24/7 with Orca

`loop install` is guided and rendered with Ink when stdin/stdout are terminals (plain lines otherwise). When no
`loop.config.local.yaml` exists next to the config it first offers to create one: it lists the Linear team members from
Orca, asks whose queue this machine drains and, optionally, how much RAM to keep free and the worker ceiling, then
writes the gitignored overlay and reloads. It then runs the doctor and the automation-environment checks (harness and review CLIs on
PATH, `gh auth status`, checkout registered in Orca, queue owner), stops on any failed check unless `--force`,
offers a dry-run tick rehearsal (one orchestrator call, nothing written), lists the exact automations it will
create, and asks for confirmation before touching Orca. `--yes` accepts every prompt for scripted setups; without
a TTY the command refuses unless `--yes` or `--dry-run` is given; `--plain` keeps the old check-free behaviour.

It creates two automations in the Orca runtime, each bound to the main checkout as an existing workspace
with session reuse:

| Automation | Trigger | Precheck (plain command, exit 0 = run) | Prompt |
|---|---|---|---|
| `<prefix>-tick` | `schedule.tick` | `<harnessCommand> loop stage tick -f <config>` (runs the tick, exits 1) | never reached under `runner: precheck` |
| `<prefix>-deliver` | `schedule.deliver` | `<harnessCommand> loop stage deliver -f <config>` (runs deliver, exits 1) | never reached under `runner: precheck` |

With the default `schedule.runner: precheck` the **precheck command is the stage itself** (`ak-harness loop stage
tick|deliver`): it runs the harness, prints the JSON report and always exits 1, so Orca records every run as
`skipped_precheck` with the report in `precheckResult.stdout` and never opens an agent session. This is deliberate:
Orca caps a precheck at 600 s, so `contract.timeoutMs` (default 300 s) plus dispatch must fit one run; an Orca-launched agent starts in bypass-permissions mode and waits for a human to accept the warning, which leaks one
stuck session per run. `schedule.runner: agent` keeps the legacy behaviour for providers that run unattended.
Runs and their output are visible in Orca's Automations view and via `loop status`.

`schedule.harnessCommand` must resolve inside Orca's environment: install the harness globally
(`npm i -g @agentskit/harness`) or set an absolute command. `loop install` warns when it cannot find it on this shell's PATH.

Optional SessionStart hook for Claude Code (`.claude/settings.json` of the target project):

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "ak-harness loop hook -f loop.config.yaml", "timeout": 10 }] }] } }
```

It prints `loop: installed (2/2, last run …)` or the install command; it never installs or changes anything.

## Worker handoff

When a worker goes idle past `delivery.workerIdleTimeoutMin` (or its terminal disappears) **and** its provider is unavailable (exhausted usage, cooldown, missing binary), deliver does **not** immediately mark the issue stuck. Instead it:

1. Picks the next available builder via the current routing mode (catalog/hybrid/…)
2. Opens a **new terminal in the same worktree** (same Orca branch)
3. Sends a continuation brief (`renderHandoffBrief`) — resume from `git status` / existing commits; do not recreate the branch
4. Updates `dispatch.json` (`terminal`, `provider`, `model`) and appends `delivery.handoffs[]`

Config (`delivery.handoff`, enabled by default):

```yaml
delivery:
  handoff:
    enabled: true
    maxHandoffs: 2
    onlyWhenProviderUnavailable: true
```

## Deliver

For every issue the loop dispatched (`<stateDir>/issues/<id>/dispatch.json`) and has not finished:

| Situation | Action |
|---|---|
| No PR, worker terminal alive and active | wait |
| No PR, idle ≥ `workerIdleTimeoutMin` | one check-in via `terminal send`; idle again after that → **stuck**: lease released, issue → `returnState` + `blocked`, worktree kept |
| No PR, terminal gone (> 5 min after dispatch) | **stuck** as above |
| PR touches `selfEditPaths` | **held**: one PR comment, no review, no merge |
| PR conflicting | rebase instruction to the worker, once per head (does not count as a fix round) |
| CI red | failing check names to the worker; counts as a fix round |
| CI pending / required check missing | wait |
| CI green, head not reviewed | `agentskit-review --pr … --block <minSeverity> --result … [--post]` with the first available reviewer candidate |
| Review findings ≥ floor | findings to the worker; counts as a fix round; same head is never re-reviewed |
| Fix rounds exhausted (`maxFixRounds`) | **blocked**: Linear comment + label + `returnState`, PR comment, lease released, worktree and PR kept |
| Review clean, `merge.auto` | `gh api PUT …/merge` with `sha=<reviewed head>` (GitHub refuses if the head moved) → Linear attach + comment + `doneState`, worktree removed when `cleanupWorktree` |
| PR merged outside the loop | same completion path |
| PR closed without merge | **abandoned**: lease released, issue → `returnState`, worktree kept |

State lives in `<stateDir>/issues/<id>/delivery.json` (reviews per head, fix rounds, nudges) and every decision is
appended to `<stateDir>/events.ndjson`. `--dry-run` reports the decision for each issue without touching anything.

## GitHub label intake: reviewing PRs the loop never dispatched

The loop's normal queue is Linear issues; `github.intakeLabel` (default `loop:review`, set to `null` to disable)
lets a human ask it to review a PR it had nothing to do with — a contributor's PR, a manual branch, anything —
without filing a Linear issue for it. Every `deliver` run lists open PRs carrying the label
(`gh pr list --label <intakeLabel>`) and starts tracking any not seen before as `pr-<n>` under
`<stateDir>/issues/pr-<n>/intake.json` (`{ pr, headRef, source: 'github-label', addedAt }`); tracking is
idempotent, so discovery never re-adds a PR it already knows about.

An intake PR runs the same checks → review → fix-round decisions as a normal dispatch (see the table above), with
two differences forced by having no Linear issue and no worker terminal:

- Every nudge (conflict, red CI, review findings) is posted as a **PR comment** instead of sent to a worker
  terminal — there is no worker to nudge.
- `github.reviewOnly` is a fixed guarantee, not a knob (the schema pins it to `true`): a clean review always ends
  in **held**, commented as "merge is human", the label removed, and `finishedAt` recorded — this loop merges only
  PRs it dispatched itself, never one it was only asked to review. If the label is removed on GitHub before the
  loop finishes, it stops tracking the PR the same way (held, no further comments).

## Event bus and orchestration hooks

`appendLoopEvent` writes every loop event to `<stateDir>/events.ndjson`, but nothing could react to one *while it
happens*, and there was no deterministic way to say "don't do this" before a consequential action. `plugins.modules`
(`loop.config.yaml`, empty by default — zero behavior change until configured) lists local `.mjs` files, relative to
`project.root` (same trust level as `agents.registry.yaml`: files already in this repo, never fetched over a
network), loaded once at the start of `tick`/`deliver`. Each exports `{ id, apply(bus) }`:

```js
export default {
  id: 'slack-notify',
  apply(bus) {
    bus.on('worker.dispatched', (event) => { /* … */ })
    bus.hook('beforeMerge', (payload) => {
      if (isFrozeWindow()) return { block: true, reason: 'release freeze' }
    })
  },
}
```

- `bus.on(type | '*', listener)` subscribes to the loop's existing event vocabulary (`contract.failed`,
  `worker.dispatched`, `pr.reviewed`, `provider.cooldown`, `issue.paused`, …) live, in addition to the ndjson log.
- `bus.hook(name, listener)` subscribes to an **orchestration lifecycle hook**: `beforeDispatch`, `afterDispatch`,
  `beforeReview`, `afterReview`, `beforeMerge`, `afterMerge`, `onPause`, `onEscalate`. A `before*` listener may
  return `{ block: true, reason }` to stop the action (surfaced as a `skipped`/`waiting`/`held` result with the
  reason); every other hook is notification-only. This is deliberately **not** a hook into the worker's own
  model/tool loop — the worker is an opaque external CLI (ADR-0027) and that loop is invisible to us. These hooks
  fire around the orchestration decisions we actually make: dispatch, review, merge.
- A listener or hook that throws is swallowed (never fatal — a broken plugin must not stop tick or deliver) and,
  for a hook, its error is reported back through `runHook`'s `errors`.
- `loop doctor` runs a `plugins.modules` check confirming every configured module exists and loads cleanly.

See `src/loop/event-bus.ts` for the full API (`createLoopEventBus`, `loadLoopPlugins`).

## One tick

1. **Intake** — `orca linear list-issues` once per configured state, filtered and ordered locally; issues already
   leased, linked to a live worktree or sitting on their branch are *busy* and skipped.
2. **Admit** — `assessSlots` (machine) and the harness dispatch ledger (`<stateDir>/coordination`) decide how many
   workers may start; a claim is atomic per issue/worktree/branch.
3. **Contract** — the orchestrator (first available candidate across `models.orchestrator` tiers) reads the issue and
   the repository read-only and returns a JSON contract between `<<<LOOP_CONTRACT … LOOP_CONTRACT>>>`. Issue text is
   wrapped as untrusted data. An auth/quota failure on one candidate marks it cooling down and the next is tried.
   Contracts are cached under `<stateDir>/issues/<id>/contract.json` while the issue is unchanged.
4. **Dispatch or escalate** — a contract with at least one executable outcome and no blocking ambiguity becomes a
   worker: `orca worktree create --linear-issue <url> --base-branch <base> --no-parent` (no `--agent`: Orca's agent
   launcher runs Claude in bypass-permissions mode and waits for a human), then `orca terminal create --command
   "<providers.<id>.tui>"`, `terminal wait --for tui-idle`, and the brief goes in through `terminal send`. The issue
   moves to `In Progress` and one dedicated comment is posted. Otherwise the loop posts one
   `needs-info` comment (deduped by contract digest), adds the label, and moves on without consuming a slot.

Every side effect is recorded in `<stateDir>/events.ndjson`; `dispatch.json` per issue links the worktree,
terminal handle, provider/model and lease for the deliver stage.

Start from [`loop.config.example.yaml`](../loop.config.example.yaml) at the package root.

## Resilience: auto-pause after repeated failures

Two failure paths have no natural ceiling elsewhere in the pipeline — contract generation failing on every
candidate, and a worktree/worker dispatch failing outright — because the issue never gets a worktree, a lease that
would otherwise expire, or a label that would exclude it from the queue. Left alone, a single misclassified or
persistent error (a quota message the classifier didn't recognise, a broken `orca worktree create`) retries every
tick forever. (The 2026-09-11/12 pilot logged 19 such retries across 4 issues in 7h before this existed.)

- `resilience.maxConsecutiveFailures` (default 3): after this many **consecutive** `contract.failed` or
  `worker.dispatch-failed` events on the *same* issue, the loop stops retrying it: one deduplicated Linear comment
  explaining why, the `resilience.pausedLabel` (default `loop:paused`), and the issue is skipped locally on every
  later tick regardless of whether that label is in `linear.excludeLabels`. A successful dispatch clears the
  counter. State lives in `<stateDir>/issues/<id>/failures.json` (`loop paused` lists every paused issue).
- **Resuming** an issue: remove the `loop:paused` label on Linear (the next tick notices via `list-issues` and
  clears the local state itself) or run `ak-harness loop resume <issue>`, which also best-effort removes the label.
- `resilience.stagePauseAfterRuns` (default 3): a scheduled `loop stage tick|deliver` run that *throws* (a config or
  adapter crash, not a normal idle/ok/blocked report) this many times in a row pauses that stage — `loop stage`
  then short-circuits to a `{"status":"paused", ...}` report instead of running, so a crash loop cannot spend budget
  or provider usage under Orca. `ak-harness loop resume --stage tick|deliver` clears it; a single successful run
  clears it automatically. State lives in `<stateDir>/paused.json`.

Neither mechanism touches the existing `blocked`/`stuck` escalations (fix-round exhaustion, an idle worker with no
PR) — those already label the issue and route it out of the queue via `linear.excludeLabels`.

## PII/secret scanning

`security.pii.enabled` (default `false` — enabling it never changes behavior for a project that doesn't need it)
scans issue text before it enters the orchestrator prompt (`contract.ts`) and the worker brief (`brief.ts`) for
PII-shaped patterns: emails, common provider API-key prefixes (`sk-…`, `ghp_…`, `AKIA…`, Slack tokens), phone
numbers, card-number-shaped digit runs (`src/kernel/pii.ts`, pure and dependency-free). `security.pii.action`
controls what happens on a match:

- `redact` (default when enabled): each match is replaced with `[REDACTED:<kind>]` before the text is embedded.
- `warn`: the text is sent unchanged; a `security.pii-detected` event is still recorded (source `issue-text` or
  `worker-brief`, with the matched kinds and count — never the matched value itself).
- `block`: the dispatch fails closed instead of ever sending the text anywhere, with a message naming the kinds
  found (not the values). Recorded like any other dispatch failure, so `resilience.maxConsecutiveFailures` still
  applies if it keeps happening.

This is a pattern scanner, not a claim of completeness — it catches common shapes, not every possible secret.

## Skills pinned into the worker brief

`brief.skills` (default `[]`) lists Markdown files, relative to `project.root`, that every worker brief embeds
verbatim under a `## Skills (pinned)` section — house conventions the orchestrator's contract can reference but a
worker starting cold has no other way to see (e.g. `AGENTS.md`, `CLAUDE.md`, `docs/for-agents/INDEX.md`).

- Reading and hashing happens once, at dispatch time (`loadPinnedSkills`, `src/loop/skills.ts`): each file is
  sha256-digested and truncated at `brief.maxSkillChars` (default 6000) with a visible `[truncated N chars]` note so
  one large file cannot exhaust the brief budget. A configured path that does not exist or cannot be read **fails
  the dispatch** (fail-closed) rather than silently sending a worker without guidance it was told it would have —
  the same worktree-cleanup and consecutive-failure accounting as any other dispatch failure applies.
- The rendered brief is persisted to `<stateDir>/issues/<id>/brief.md`, and `dispatch.json` records `briefDigest`
  (hash of the full brief) plus `skills: [{path, digest}]` — enough to prove after the fact exactly which revision
  of a skill file a given worker saw.
- **Pinning is by design, not by accident:** a handoff (`renderHandoffBrief`) reuses the worktree/branch state, not
  the original brief, and never re-reads `brief.skills` — so editing a skill file after dispatch affects only
  *future* dispatches, never a worker (or its handoff) already in flight.
- `loop doctor` runs a `brief.skills` check confirming every configured file currently exists and is readable, so a
  typo or a moved file surfaces before the next dispatch fails.

## Worktree setup command

A freshly created Orca worktree is a bare checkout — no `node_modules`, no build output, nothing a worker can run
tests against until it installs dependencies itself, wasting the first several minutes of every dispatch on the
same shell commands. `project.setup.command` (unset by default; an argv array, e.g.
`[pnpm, install, --frozen-lockfile]` — no shell, so no `&&`/`|`) runs once in the new worktree between
`orca worktree create` and opening the worker's terminal.

- `project.setup.timeoutSec` (default 600) bounds the run; the loop's per-tick time budget already reserves this
  much time before attempting a dispatch, so a configured setup command cannot itself blow the tick budget.
- `project.setup.required` (default `true`): a non-zero exit or a timeout removes the just-created worktree, never
  opens a terminal, and fails the dispatch — recorded as a `worker.dispatch-failed` event and counted by the
  per-issue consecutive-failure tracker above, exactly like a contract or worktree-create failure. Set it to
  `false` to have a failing setup only log a note and still hand the worker its terminal.
- Every run (pass or fail) is recorded as a `worker.setup` event and, when the dispatch succeeds, as `setup:
  {command, exitCode, durationMs, timedOut}` on `dispatch.json` — enough to see in `loop retro` whether a slow or
  flaky setup command is costing more dispatches than it saves.

## What the doctor checks

| Check | Source | Blocking |
|---|---|---|
| `orca.version` / `orca.runtime` | `orca --version`, `orca status --json` | yes — the loop cannot run without a reachable Orca runtime at or above `orca.minVersion` |
| `provider.<id>` | PATH lookup, `orca account list` usage windows, `orca agent hooks status`, env key names, optional probe, cooldown store | no — reported per provider |
| `routing.<role>` | tiers from `models.<role>` filtered by provider availability | yes — a role with no available provider blocks |
| `machine.slots` | `sampleMachine` + `adaptiveConcurrency`, free RAM reserve, WSL cap, running worktrees | no — 0 free slots is a warning, not a failure |
| `linear.queue` | `orca linear list-issues` per configured state, filtered and ordered locally | yes — an unreachable Linear blocks |
| `brief.skills` | existence + readability of each `brief.skills` path under `project.root` | yes when any are unreadable — dispatch would fail closed anyway |


## Dynamic model routing

`models.routing.mode` controls how the loop picks `provider/model` for each role:

| Mode | Behaviour |
|---|---|
| `tiers` (default) | YAML declaration order; usage only as available/unavailable (0.6 behaviour). |
| `hybrid` | Keep tier bands (quality policy); **inside a tier** pick the provider with the most remaining Orca usage. |
| `dynamic` | Flatten all YAML candidates; rank by remaining usage (YAML order is a soft tie-break). |
| `catalog` | Discover models from CLI lists (`grok models`), builtin catalog, and optional [Artificial Analysis](https://artificialanalysis.ai/) (cached under `stateDir/catalog/`), then rank by usage + quality band (`models.roles.*.quality`). |

Providers still need a `models.providers.<id>` block (`bin` / `tui` / `headless`) — Orca cannot invent argv. The doctor warns when Orca shows an integration that is not declared.

## Model routing

`models.<role>` is a list of tiers; each tier is a list of `provider/model`. Tiers are tried in order and, inside a
tier, providers in declaration order. The first provider that is **available** wins. A provider is available when
its binary is on PATH, its auth is not known to be missing, no Orca usage window is at or above
`cooldown.exhaustedPercent`, it is not cooling down, and its optional probe passed.

Providers authenticate through their own CLI login (`claude login`, `codex login`, `grok login`); only providers
declared `auth: api-key` need an environment variable, and the loop never reads its value. Orca has no per-run model flag; the chosen model is rendered into `providers.<id>.tui` (for example
`codex -m {model} -s workspace-write -a never`) and launched in the worker terminal. The explicit
approval policy keeps YOLO runs non-interactive while the workspace sandbox limits changes to the assigned worktree.

When a provider runs out of usage the loop records a cooldown in `<stateDir>/provider-cooldowns.json`:
`initialMin` doubling up to `maxMin`, never earlier than the reset instant Orca reported.

### Reasoning effort per role

`models.effort.<role>` (`low | medium | high | xhigh`; defaults: orchestrator/reviewer `high`, builder `medium`,
watcher `low`) is only applied for a provider that declares `providers.<id>.effortFlag` — a template such as
`-c model_reasoning_effort={effort}` (codex) or `--reasoning-effort {effort}` (grok); a provider without one
ignores it entirely, so leaving `effort` at its default is always safe. The flag (with `{effort}` substituted) is
appended to `tui` as literal text, and appended as its own argv elements (split on whitespace, since headless argv
is never shell-joined) to `headless`. `agentskit-review` has no reasoning-effort flag, so `models.effort.reviewer`
is not currently wired into the review CLI call — it is validated and recorded for symmetry and for a future
reviewer transport that supports it.

Whichever effort a dispatched builder actually used is recorded as `effort` on `dispatch.json` and the
`worker.dispatched` event; `loop retro`'s `dispatches.byProvider` groups by `provider/model@effort` (falling back
to plain `provider/model` for older events with no effort recorded) so a retro can tell a slow `gpt-5.6-luna@high`
run from a fast `@medium` one.

## Machine slots

`maxAgents = max(floor, min(adaptiveConcurrency(ceiling), ramBound, wslCap?))` where `ceiling` defaults to
`cpus / 2`, `ramBound` fits `agentRssMb` agents into free RAM minus `minFreeRamGb`, and the WSL cap applies only
inside a WSL distro (host Defender load is invisible there). The loop never lowers a running worker; it only
decides whether to start another.

## Integrations used by the loop

The loop talks to the rest of AgentsKit through **adapters and CLI seams**, not by importing those packages into
the published dependency tree. `@agentskit/harness` stays dependency-light (`commander`, `ink`, `react`, `yaml`,
`zod`); Doc Bridge and Code Review are optional at runtime.

### Doc Bridge (context for the orchestrator)

| Item | Detail |
|---|---|
| Adapter | `src/adapters/doc-bridge.ts` → `createDocBridgeContextProvider` |
| Loop wiring | `resolveDocContext` in `src/loop/contract.ts` |
| Trigger | `.doc-bridge/index.json` exists under `project.root` |
| Knob | `contract.maxContextReferences` (default `6`; `0` disables) |
| Behaviour | Query is `"<issue id> <title>"`. Up to N deterministic references are appended to the orchestrator prompt. Missing or malformed index → **no refs** (loop continues). |
| Boundary | No `@agentskit/doc-bridge` import; the adapter only reads the local index contract ([ADR-0003](ADR-0003-doc-bridge-context-binding.md)). Contract resolution rejects indexes older than `contract.docBridgeMaxAgeHours`; exact source freshness remains a Doc Bridge gate. Index build/refresh stays with Doc Bridge (`pnpm docs:bridge:index` in repos that use it). |

### Code Review (`agentskit-review`)

| Item | Detail |
|---|---|
| Adapter | `src/adapters/code-review.ts` → `runCodeReview` / `buildReviewArgv` |
| Loop wiring | Deliver stage, after CI is green and the head has not been reviewed |
| CLI | `delivery.review.cli` (default `agentskit-review` from `@agentskit/code-review`) |
| Knobs | `mode` (`trusted-local` recommended so CLI logins work), `transport` (`headless` for current Grok CLI), `profile` (`fast` fits a 600 s Orca stage; `full` needs batching), `votes`, `concurrency`, `minSeverity`, `deadlineMs`, `maxCalls`, `post` |
| Provider/model | First available candidate from `models.reviewer` tiers |
| Verdicts | exit `0` → clean (merge path); `1` → findings ≥ floor (fix round); `2` / timeout / incomplete → wait and retry |
| Boundary | Argv + `--result` file only; the harness never embeds the review SDK. |

### Eval battery (package quality, not the live loop)

`evals/manifest.json` plus `runEvalBattery` / `pnpm test:eval-battery` score harness components (`doc-bridge`,
`code-review`, `orca-worktree`, `memory`, …) under a frozen fixture provider. That is the **library** eval gate.
The live SDLC loop does **not** call the eval battery on every PR; it calls `agentskit-review` on each head.

Loop-focused Vitest coverage lives under `test/loop-*.test.ts`, `test/review.test.ts`, and `test/doc-bridge.test.ts`.

## AgentsKit ecosystem map (what the harness has vs what the loop uses)

Legend: **Loop** = wired into `ak-harness loop …` today · **Kernel** = public API / contracts available to callers ·
**Compat** = pinned in `compatibility/manifest.json` · **Absent** = no seam yet.

| Capability | Status | Where | Notes for SDLC |
|---|---|---|---|
| **Doc Bridge** | Loop + Kernel + Compat | `adapters/doc-bridge.ts`, contract stage | Optional context on contract freeze. Playbook/docs surfaces appear as Doc Bridge scopes when the index includes them. |
| **Code Review** | Loop + Compat | `adapters/code-review.ts`, deliver | Live adversarial review before auto-merge. |
| **Orca / Linear / GitHub** | Loop | `adapters/orca-cli.ts`, `linear-orca.ts`, `github-cli.ts` | Scheduler, worktrees, queue, PR merge. |
| **Coding-agent CLIs** | Loop | `adapters/providers.ts`, `models.*` tiers | Claude / Codex / Grok / OpenCode via TUI + headless templates — not an AgentsKit agent registry. |
| **Memory** | Loop + Kernel + Compat | `kernel/memory.ts`, `loop/memory.ts` | Approved learnings (`loop learning promote`) shrink Doc Bridge/issue text in contract + brief. |
| **Eval** | Kernel + Compat | `kernel/eval.ts`, `evals/manifest.json` | Battery + `assessAgentEval`. **Not run inside tick/deliver**. |
| **Runtime (process / Docker)** | Kernel | `execution/runtime.ts` | Tool runtimes with attestation for kernel/agent sessions. Loop workers run as Orca terminals + provider TUIs instead. |
| **Plugin / context registry** | Kernel | `kernel/plugins.ts`, `CONTEXT_PROVIDER_SLOT` | Typed slots so Doc Bridge / Playbook / custom providers plug in without kernel changes. Loop uses Doc Bridge directly today. |
| **Playbook practices** | Loop (via Doc Bridge scopes) | `contract.briefScopes` → worker brief | Titles/paths for `playbook` / `for-agents` scopes listed in the brief when indexed. |
| **RAG (`@agentskit/rag` / os-rag)** | Kernel adapter (opt-in) | `adapters/rag-context.ts` | Argv/`ContextProvider` seam; enable via `rag.enabled` + `contract.contextProviders`. No hard dep. |
| **AgentsKit agent registry** | Composition (opt-in file) | `loop/agent-registry.ts` | Optional `agents.registry.yaml` role→TUI/argv overlay. Not OS marketplace. |
| **MCP / event bridge** | Kernel adapter + ADR-0028 | `adapters/mcp.ts` | Policy-gated tool bridge; **not** wired into tick/deliver in 0.6.0. |
| **`@agentskit/core` / `@agentskit/eval` / `@agentskit/memory`** | Compat pins only | `compatibility/manifest.json` | Upstream packages are compatibility-tested; harness does **not** depend on them at runtime. Callers adapt them through the seams above. |

Compatibility report for 0.4.0 was **fail-closed** on code-review quality baselines and the no-Harness pilot cohort; see `compatibility/report.md`. Refresh after each release (qualification + pinned revisions).

## What can be added to help the SDLC

**0.6.0 ships the backlog below** (memory, doctor freshness/review probe, brief scopes, deliver smoke, agent registry, RAG provider, MCP seam+ADR, Docker verify config, weekly retro automation). Remaining work is dogfooding and deeper MCP/OS registry integrations.

Ordered by leverage for a keep-pushing loop (config/adapters first; no kernel redesign required for the early items).

| Priority | Addition | Why it helps | Suggested shape |
|---|---|---|---|
| P0 | **Memory in contract + brief** | Stop re-deriving the same repo facts; carry approved decisions across tickets | On contract freeze / worker brief, `recall` from an `AgentMemoryAdapter` (backed by `@agentskit/memory` or a file store under `<stateDir>`). Persist only human-`promoteLearnings` / retro-approved records. |
| P0 | **Doc Bridge freshness gate** | Orchestrator context goes stale when the index is old | Doctor check: index exists, `contentHash` age, optional `docs:bridge:index` hint when missing. |
| P1 | **Playbook / for-agents snippets in the brief** | Workers skip repo conventions that already exist as docs | Resolve Doc Bridge (or a Playbook `ContextProvider`) with scopes `playbook` + `for-agents` and render a bounded “must follow” block into `renderWorkerBrief`. |
| P1 | **Eval smoke on deliver (optional)** | Catch harness/component regressions before merge on harness itself | Config flag to run a **bounded** subset of `evals/manifest.json` (or project `ak-verify`) as an extra deliver gate — not a full battery on every product PR. |
| P1 | **Review transport/doctor** | Incomplete reviews burned the pilot (login / model id / stage budget) | Doctor probes `agentskit-review --help`, configured transport, and a one-lens trusted-local dry call; surface `review-tool-errors` in retro. |
| P2 | **RAG context provider** | Large codebases exceed Doc Bridge’s deterministic top-N | New adapter implementing `ContextProvider` over `@agentskit/rag` / os-rag; same freeze-into-contract rules as Doc Bridge (hash + cap). |
| P2 | **AgentsKit agent/skill registry** | Reuse named agents (reviewer, security, docs) instead of free-form CLI templates | Optional `agents.registry` file or OS dispatcher lookup → map role → argv/TUI. Keep fail-closed when the registry entry is missing. |
| P2 | **MCP tools behind policy** | Controlled access to issue trackers, browsers, internal APIs | MCP adapter + `createPolicyGate` allowlist; record hashed tool events. Requires ADR (MODULE-BOUNDARIES already flags this). |
| P3 | **Kernel runtime for untrusted tools** | Sandbox one-off scripts the worker must not run on the host | Offer Docker tool runtime as an opt-in for verify commands; loop default stays Orca worktree. |
| P3 | **Weekly Linear retro automation** | Close the continuous-improvement loop without a human remembering `loop retro` | Orca schedule → `loop retro --learnings` → comment on a fixed Linear issue (project vs harness sections already split). |

Non-goals for the loop: embedding LLM SDKs, reading API key values from config, or making `@agentskit/*` hard dependencies of the published package. New ecosystem pieces enter as adapters/plugins with argv/timeouts and eval coverage ([ADR-0026](ADR-0026-kernel-adapters-boundary.md), [ADR-0027](ADR-0027-keep-pushing-loop.md)).

## Boundaries

Adapters (`src/adapters/command.ts`, `orca-cli.ts`, `providers.ts`, `linear-orca.ts`) depend on kernel contracts
only and receive a `CommandRunner`; they never spawn a shell. Composition (`src/loop/*`) supplies the real
runner and wires adapters together. See `docs/MODULE-BOUNDARIES.md`.

## Security notes

- `loop.config.yaml` holds env variable **names**, never values.
- Every external call is argv-based with a timeout; `ok: false` envelopes fail closed.
- Linear text is data. Later phases render it into worker briefs inside delimiters and never execute it.

## Continuous improvement: `loop retro`

`ak-harness loop retro --since 7d` reads `<stateDir>/events.ndjson`, every `issues/<id>/{contract,dispatch,delivery}.json`,
`provider-cooldowns.json` and (unless `--no-orca`) the Orca run records of the two automations, and prints a Markdown
digest:

- **Numbers** — contracts frozen, escalation rate, dispatches by provider, merged/blocked/stuck/abandoned/in flight,
  review outcomes, fix rounds, median dispatch→merge, cooldowns, Orca runs (idle/work/timed out, durations).
- **Problems** — escalation reasons grouped by shape, blocked/stuck/abandoned issues.
- **What worked** — merged issues with worker, lead time and fix rounds.
- **Adjustments — project** — rule-based suggestions about the target project, each with its evidence and the
  `loop.config.yaml` knob to turn (`escalation-rate`, `review-floor`, `fix-rounds`, `stuck-workers`, `review-incomplete`,
  `provider-cooldowns`, `idle-loop`, `lead-time`, or `steady`).
- **Adjustments — harness** — defects or limitations of the library itself, derived from events the loop only emits
  when its own machinery misbehaved (`worker-relaunch`, `dispatch-failures`, `contract-failures`, `merge-refusals`,
  `review-tool-errors`, `stage-timeout`), with a pointer to the harness issue tracker. `--target project|harness`
  filters one side.

The headings follow the harness retro grammar, so `--learnings` prints `LearningRecord`s in `proposed` state; a human
promotes them with `promoteLearnings` (ADR-0019 keeps that decision human). The calibration loop is: read the digest →
change one knob in `loop.config.yaml` → next digest measures the effect.
