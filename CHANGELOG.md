# Changelog

## [Unreleased]

Found by running the loop on a real repository migration with a single, non-default provider.

- **The orchestrator reads the base branch, not the operator's checkout.** Contract generation, the plan
  interview, the architect, the votes and decompose ran their model in `project.root` — an operator's checkout
  can sit on another branch, hundreds of commits behind, and an architect run from one designed work that had
  already been merged. They now run in a harness-owned detached worktree of `origin/<baseBranch>` under the state
  directory, fetched and reset before use; a failed fetch fails the stage instead of falling back to the stale
  tree. `project.orchestratorView: root` keeps the old behaviour.
- **A worker at a tool-permission prompt is held for a person, never typed into.** `deliver` used to see it as
  idle and send a check-in: text plus Enter into a dialog whose default is "Allow once", approving exactly the
  command the agent's own config marked dangerous (`rm -rf`, `git reset --hard`). It now reads Orca's `permission`
  activity (`OrcaWorktree.activity`, from `worktree ps`) or the prompt on screen, reports `held`, emits
  `worker.permission-wait` once per idle window, keeps the lease, and no nudge, handoff or relaunch happens.
- **Gate lists accumulate across config layers.** `delivery.selfEditPaths`, `delivery.secretFilePatterns` and
  `delivery.requiredChecks` are no longer replaced by a later layer; an entry leaves only when named as `"!entry"`.
  A machine overlay written to free one path had silently dropped the `packages/**` freeze added to the project
  five days later.
- **`loop plan decompose --create` files issues outside the queue and where the queue will find them.** New
  `linear.entryState` (default `Backlog`) must not be one of `linear.states` — the config is refused otherwise;
  before, issues were created in `states[0]`, which *is* the queue, so the human gate did not exist. The issues now
  carry the queue's `requireLabels`/`anyLabels`, land in the project the queue drains (or `--project`), and hang
  under `--parent <epic>`.
- **The plan interview reads what a model meant instead of losing the round.** While the PRD is being filled, a
  bare string is a one-item list and an empty list is a gap for `prdGaps` to report — `glm-5.3` answered
  `"users": "…"` and `"successCriteria": []` and the whole round failed validation. The final PRD stays strict.
- **`loop plan` has its own time budget.** New `worker.plan.stageTimeoutMs` (default 900 s) covers the interview,
  architect, design vote and decompose; `worker.plan.timeoutMs` stays the per-issue planner's. The architect designs
  a whole PRD from a human's shell, and at the shared 300 s `glm-5.3` never finished one.
- **A worker brief is never typed into a pane that is not `tui-idle`.** The launcher waits a second, longer window;
  if the TUI still is not ready the dispatch fails (and the half-created worktree is removed) instead of losing the
  prompt.

## [0.15.0] - 2026-09-20

The loop becomes a cycle. The twelve steps of [docs/ROADMAP-SDLC.md](docs/ROADMAP-SDLC.md) close, the phases of one
issue become files the machine can check instead of claims in a terminal, and the parts of the design that were
decided in conversation become ADRs 0032–0037.

### The phases of an issue leave evidence behind

- The worker writes three files into `.ak-loop/` in its worktree — `plan.md` (the plan it actually followed),
  `verify.json` (what it ran, outcome by outcome) and the definition-of-done proofs — and the brief tells it so.
  **The loop advances on presence plus validation**, never on what a terminal said.
- `deliver` reads them before the merge gate. A missing file comes back as a fix round **naming the file**; a file
  that exists but does not match its schema is called out as worse than absent, because it looks like evidence.
  A dispatch record with no worktree path is left out of the gate: the harness has nowhere to look, and blaming a
  worker for a file nobody can open is how a loop invents work.
- `verify.json` counts as evidence for an outcome the definition-of-done file left unproven. The worker ran the
  check once; asking it to transcribe the result into a second file only invents a way to be inconsistent.

### `layers:` and `documents:` — where the work belongs, and where the decisions live

- **`layers`** declares the slices of the codebase: the tracker label that places an issue, the globs the layer
  owns, and the one command that closes it. The brief tells the worker which test closes its layer — cheaper than
  the whole suite — and `deliver` reports every PR that crossed its boundary, holding it only where the project
  said the boundary is real (`layers[].enforce`). Off by default, because a boundary that blocks before a team has
  drawn it properly costs more than it protects.
- **`documents`** decides where the PRD and the technical design live once a human approves them: `file` writes
  them into the repository, where they are reviewable, diffable and greppable by the workers that come later.
  Turning one into a numbered ADR stays a human gesture.

### Per-role settings, and which phases run at all

- **`flows.profiles.<name>.roles.<role>`** names who runs a role on this flow, with what effort and what timeout.
  Narrow beats broad: the role in the profile, then the project, then the global layer. A pin **narrows** the
  candidate list and never widens it, so a model nobody can serve right now falls through to the ordinary
  candidates instead of becoming an outage — and the dispatch record always says who actually ran.
- **`worker.roles`** is the ordered list of phases for one issue (`planner`, `vote`, `builder`, `verify`, `review`,
  `dod`). Unset, every phase keeps answering from its own block, which is exactly what a project that never opted
  in already has. Declaring the list makes it the answer. **`flows.profiles.<name>.stages`** overrides it per flow;
  `builder` is the work and is never switched off.
- A flow may buy the plan without buying the jury: with the `vote` phase off, the planner's plan stands and is
  stored with zero votes, so nothing downstream mistakes it for consensus.

### The four cost levers, finished

- **A stable, cacheable prefix.** The worker brief and the contract prompt now open with everything invariant for
  the repository — role, standing rules, definition of done, artifacts, pinned skills — and close with the issue,
  its contract and its plan. Two issues share the head of the prompt byte for byte. The test measures that shared
  prefix and asserts a minimum length; without it the reordering would be decoration that the next edit undoes.
- **Context pinned by digest.** A handoff points at a pinned skill by path and sha when the file on disk still
  hashes to what the dispatch record says was delivered, and sends the whole file only when it changed, vanished
  or was never recorded. Fix rounds carry a one-line anchor — contract, brief, pinned skills — instead of
  repeating what the terminal already has. The rule is deliberately asymmetric: a worker without its context is
  worse than a worker that costs more.
- **`models.providers.<id>.subagents` and `flows.profiles.<name>.lead`.** A flow may ask its builder to lead and
  delegate one plan item at a time. Whether it can is the provider's answer; the brief says which of the two the
  worker got, and the dispatch record keeps `delegation: 'subagents' | 'alone'`. Dropping the request silently
  would leave a human reading "lead" in the config and a worker that never led anything.

### `release.waiting`, once per head

- A batch on the integration branch with nobody's approval behind it now emits `release.waiting` and calls the
  configured channel — **once per head**, deduplicated in `release.json`, because a cron that repeats it every few
  minutes is noise and a channel that always shouts stops being read. A promotion clears the mark, so the next
  batch is news again. The stage now carries the event bus and its notifier, like `tick` and `deliver`.

### The event vocabulary, and the compiler that guards it

- **`LOOP_EVENT_TYPES`** names every event the loop emits and what it carries, and `appendLoopEvent` and
  `LoopEventPayload['type']` accept only those. An event whose name exists only inside a template string is an
  event nobody can subscribe to on purpose.
- Narrowing the type found two events no grep had found (`tuning.applied`, `tuning.reverted`) and two that never
  existed (`worker.dry-run`, `github-intake.dry-run`): a dry run returns before anything is written, and the type
  now says so. A test closes the circle both ways — an emission that skipped the vocabulary fails, and so does a
  name declared here that nothing emits.

### The installed agent is code, not a markdown file to append to

- `npx agentskit add <id>` installs an agent as code. The retro's improvement pass now edits **only a markdown
  instructions file that already exists**; an agent that is code, or whose instructions file is missing, gets a
  recorded `needs-human` proposal with its evidence. The previous behaviour appended an HTML comment — to
  `agent.ts`, if that is what the registry named, and it created an `AGENT.md` out of nothing when none existed.
- New `loop doctor` check **`agents.registry`**: every `path` in the registry exists, and the check says which
  instructions file it found. A registry pointing at a directory nobody installed sends every run for that role to
  the provider alone, and nothing said so.

### Documentation

- **Six ADRs**: [0032](docs/ADR-0032-loop-stages-as-state-machines.md) stages as state machines,
  [0033](docs/ADR-0033-four-config-layers-and-presets.md) the four configuration layers and the presets,
  [0034](docs/ADR-0034-connectors-tracker-scm-runner.md) the connectors and the two-implementations rule,
  [0035](docs/ADR-0035-definition-of-done-two-lists.md) the definition of done in two lists,
  [0036](docs/ADR-0036-bounded-self-modification.md) bounded self-modification,
  [0037](docs/ADR-0037-cost-policy-ceilings-and-levers.md) cost — including which levers were not built.
- The `ak-harness-loop` skill gains the section on driving `loop plan` from inside a conversation: one question
  per message, with alternatives and a recommendation, and the rule that **the agent never answers in the human's
  place**. A test asserts every command the skill cites exists in the CLI.
- The README describes the whole cycle instead of the 0.14 loop, and `docs/GETTING-STARTED.md` gains the happy
  path: `loop init` → `loop doctor` → `loop install` → the first tick.

### Windows stops being a second-class platform

The external PR #84 found that provider CLIs installed as `.cmd` shims could not be spawned at all. Auditing
around it found five more, none of them cosmetic:

- **Every `plan` was refused on Windows.** `git status --porcelain` prints forward slashes and `path.relative()`
  returns the platform separator, so the comparison that excludes the harness's own contract file never matched
  and a clean worktree read as dirty. This is the cause of the 16 "pre-existing, unrelated" test failures the PR
  author reported.
- **A timeout could hang forever.** A check runs under a shell; killing the shell left the real command holding
  the inherited pipes, so `close` never fired and the promise never settled. Timeouts now kill the whole tree
  (process group on POSIX, `taskkill /t` on Windows) and a grace period guarantees the call ends either way. A
  spawn that failed emitted `error` and never `close`, which hung the same way; it is handled now.
- **A `:` in an artifact id silently lost the artifact.** On NTFS the id became an alternate data stream: the
  write succeeded, `readdirSync` never listed it, and `list()` quietly returned less than was written. The id
  pattern now rejects `:` — **a narrowing of a public contract**, chosen over encoding the filename because a
  loud `INVALID_INPUT` beats losing data quietly.
- **`connectors.runner: local`** needs tmux and the system crontab, which Windows has neither of; the failure
  arrived as a raw `ENOENT` halfway through a dispatch. `loop doctor` now says so up front (`runner.local`).
- **A fabricated load average.** `os.loadavg()` returns zeros on Windows, so a busy machine reported 0% load and
  CPU pressure never throttled anything. The sample now says the reading is unavailable, and both the reports
  and `adaptiveConcurrency` treat it as unknown rather than as calm.
- Plus: a Windows-absolute path passing the "repository-relative" check, Docker host paths (`C:\…`, UNC)
  rejected before Docker ran, a child process started without `SystemRoot`, a cross-volume `rename` for the
  benchmark manifest, and `writeJsonAtomic` promising an atomicity it did not have while a reader held the
  destination open.

The platform-sensitive tests now run on the Windows leg of CI, and every one of them asserts Windows-shaped
inputs rather than gating on `process.platform`, so they fail on any machine if the behaviour regresses.

### The licence, and a surface for the numbers

- The harness is **free and open source under MIT**, said where someone looks for it: the home, the first
  documentation page and the README.
- **`/api/stats.json`**, in the same envelope the sibling products use, plus a small band on the home. Every
  number is derived at build time from the repository — commands from the commander tree, events from the
  vocabulary, config paths from the Zod schema, decision records from the ADR files — so nothing there can drift
  from what the code actually is. The test suite is never run to produce a count.

### The harness has a folder of its own

- The contract moves from **`.codex/verification.json` to `.ak-harness/verification.json`**, and the run state
  from `.codex/verification` to `.ak-harness/verification`. A tool that routes work across claude, codex, grok
  and opencode should not keep its own state in a folder named after one of them.
- **Nothing breaks for an existing repository**: with no `-c`, the harness reads `.ak-harness/verification.json`
  when it exists, falls back to a legacy `.codex/verification.json` when it does not, and prefers the new one
  when both are there. The run state now defaults to a `verification/` folder *beside the contract that declares
  it*, so a legacy contract keeps its legacy state without either path being hardcoded.
- `resolveConfigPath`, `DEFAULT_CONFIG_PATH` and `LEGACY_CONFIG_PATH` are exported for callers that need to say
  which file they read.

### The documentation site

- **`apps/docs` — a Next.js + fumadocs site, its own package**, so Next and React 19 never reach the harness
  runtime, which draws its TUI with ink. 38 pages in six sections, the eight stage state machines as diagrams,
  four examples, and a `/for-agents` route. `harness.agentskit.io`, static export, published by Vercel like every sibling site.
- **The reference is generated from the code** (`pnpm docs:generate`): the configuration from the Zod schema
  joined with the JSDoc by dotted path (neither source is sufficient alone — the schema has no `.describe()` and
  the file has 155 JSDoc blocks), the CLI walked from the commander tree rather than parsed from `--help`, and
  the events from the vocabulary. A documented path that does not exist in the schema is a hard error. The `docs`
  job in CI runs `docs:generate --check`, which regenerates nothing and fails on drift.
- `llms.txt`, `llms-full.txt` and the raw Markdown of every page, with a contract test that requires the corpus
  to preserve each page byte for byte.
- The captures in the examples are real, taken read-only against a pilot repository on 2026-09-20; everything
  reconstructed says so on the page.

### The twelve steps of the roadmap, in the order they landed

The automations stop drifting: the config file becomes the single source of truth for every scheduled automation,
and the last piece of the loop that lived outside a repository moves into the harness.

### `loop install` reconciles instead of rewriting

- It now compares every live Orca automation with what `schedule:` declares — trigger, prompt, precheck command and
  timeout, provider, workspace, enabled — and **creates what is missing, edits only the fields that drifted, leaves
  a matching automation untouched, and switches off (never deletes) an automation whose stage the config stopped
  declaring**. Each action names the fields it changed.
- `loop doctor` gained **`automations.drift`**: it reports the same comparison and changes nothing. Drift was
  invisible to every other check — the loop looks healthy while the scheduler runs a command nobody declares.
- The motivating defect, measured on 2026-09-19: four automations still pointing at a config file from 2026-09-14,
  because each had been edited by hand inside Orca and nothing ever compared them to the repository.
- `loop uninstall` and `loop status` now cover every managed stage, not just `tick` and `deliver`.

### `loop stage observe` — the health scan comes into the repository

- New stage and new `schedule.observe` cron. It runs the observability scan plus the checks only a scheduler cares
  about: failing doctor checks, automations missing / switched off / stalled (`schedule.observer.schedulerStallMin`),
  and abandoned stage locks (`schedule.observer.staleLockMin`).
- Each problem has a stable id; their sorted set is hashed into a signature stored in
  `<stateDir>/observer-state.json`. The stage exits **0 — the one stage whose exit code is a decision — only when
  that set is new, or unresolved past `schedule.observer.reminderHours`**. A previous, machine-local version of this
  scan fired nine investigations in two hours over the same three unchanged facts.
- This replaces a precheck script that lived on one laptop, outside any repository, with absolute paths baked in.
  Every automation is now a shim that calls `ak-harness loop stage <x> -f <config>` and nothing else.
- `runObservability` now reports `failingChecks` (the doctor checks that did not pass) alongside its anomalies.

### Configuration in four layers, and the loop learns to call a human

Step 2 of the roadmap: configurable per user, per project, per team and per kind of demand.

- **`~/.agentskit/harness.yaml`** (the user) and **`loop.config.team.<key>.yaml`** (the team) join the project and
  machine layers. Deep merge, most specific wins, validated once. The project weighs more than the global and
  never writes to it; a declared team whose file is missing fails loudly instead of quietly running the defaults.
  `$AK_HARNESS_CONFIG`, `$AK_LOOP_TEAM` and `$AK_HARNESS_NO_GLOBAL=1` steer it.
- **`notifications`** — the tracker comment is still the record; this is the channel on top of it. Two generic
  shapes and zero vendor code: `webhook` (a URL from `urlEnv`, covering Slack, Discord, Telegram bots, n8n) and
  `command` (local argv with `{summary}`/`{event}`/`{issue}`/`{json}`). Declared event types reach it, and
  `onEscalate` always does. A failing channel is reported, never fatal. `loop doctor` warns when the URL variable
  is unset in this environment, because an unreachable webhook looks exactly like silence.
- **`stage.paused`** is now a real event: a scheduled stage that auto-pauses writes it to the log and calls the
  channel. Nobody is watching that terminal.
- **`flows`** — named profiles (`enterprise`, `poc`, `incident`, or your own) that switch review votes and
  severity, CI babysitting, the human merge gates and the fix-round ceiling, replacing only the fields they name.
  A rule picks one per issue by **label, then project, then priority** — a label is an intention, a priority is a
  signal — with `flow:<name>` always winning and `flows.default` as the fallback. All three come from the dispatch
  record, frozen at entry, so nothing edited mid-flight changes the gate a running item is judged by.
- **`delivery.merge.requireChecks` finally does something.** It was declared and never read; it is now the CI
  babysitting switch: off, a red or pending check no longer costs a fix round and the review is the gate.
- `loop doctor` fails on a flow referenced but never defined, and reports the configured channel.

### The roles become installed agents, and the retro can improve them

Step 11 of the roadmap.

- `agents.registry.yaml` entries gained **`path`** (the agent installed under `agents/<id>/`) and
  **`instructions`** (the prompt file inside it, `AGENT.md` by default). The code is the project's: the copy in
  the repository is the version and git is its history.
- With **`agents.autoImprove`**, the retro correlates outcomes with roles using only events the loop already
  writes — review findings, fix rounds, escalations, contrary votes — takes the worst role above
  `agents.minRatio`, and proposes **one dated note** appended to that agent's instructions.
- **`agents.evalCommand` is the gate.** The change is kept only if the eval still passes; a failure restores the
  file byte for byte, and with no eval command declared nothing is ever adopted — a change that cannot be
  measured is a guess.
- Never done by a machine: touching `architect` or `reviewer` instructions, writing more than
  `agents.maxAutoLines` lines, or publishing back to the registry. Every proposal is recorded with its evidence
  in `<stateDir>/agent-improvements.json` and listed in the retro comment.
- New events: `agent.adopted`, `agent.reverted`, `agent.needs-human`, `agent.rejected`.

### Presets and a grilled `loop init`

Step 10 of the roadmap.

- **`extends: <preset>`** — `web-app`, `library`, `monorepo`, `data-pipeline`, `mobile`. A preset carries what
  varies by kind of project: the verify command, the Definition of Done items, the layer labels, how strict the
  default review is, whether a human approves every merge. It is merged **below every other layer**, so it fills
  silence and overrides nothing, and an unknown name fails loudly instead of being ignored.
- **`ak-harness loop init`** grills one question per round — kind of project (with each preset described),
  repository, branch, Linear workspace/team, whose queue this machine drains — and writes a config that states
  only what the preset cannot know. It refuses to overwrite an existing config without `--force`.
- It validates the **composition** (preset + the user's layer + the new file) before writing, and `--global`
  writes `~/.agentskit/harness.yaml` with the models this machine can use and a commented-out channel. Models
  live in the user's layer on purpose: which CLIs are installed and logged in is a fact about the person and the
  machine, not about the repository.

### `intake`, `maintain`, and release notes — the cycle closes

Step 12 of the roadmap.

- **`intake`** turns alerts into issues: each source is argv printing a JSON array, the fingerprint covers the
  alert's *identity* rather than its numbers (an error going from "seen 11 times" to "seen 12 times" files
  nothing), and `intake.flowBySeverity` maps a severity to a `flow:<name>` label — the only way the incident flow
  starts without a human at a keyboard. The alert body reaches the issue as data, never as instructions.
- **`maintain`** runs the project's dependency, security and licence checks on a schedule and files **only a
  decision** (`fileWhen: exit-code | output`); a clean check files nothing, and the same unresolved finding is not
  re-filed inside `maintain.dedupeWindowHours`. The command's own output is the evidence.
- Both are stages: `loop stage intake`, `loop stage maintain`.
- **Release notes**: with `release.notesFile`, the batch's notes — commits grouped by the issue they carry — are
  written newest-first and committed **before** the promotion, so the branch that reaches production carries them.
  Built from the log, not from a summary.
- New events: `intake.filed`, `maintain.filed`.

### Cost: a routing policy, two ceilings, and two of the four levers

Step 9 of the roadmap.

- **`models.routing.policy`**: `quality-first` (default, unchanged), `usage-balanced` (most remaining window
  first, unknown usage last) or `cost-first` (declared `models.cost` when the project declared any, otherwise the
  last tier — and the reason says which decided). Policy orders the candidates a role already allows; it never
  widens the set.
- **`budget.perProvider`** — the share of a provider's window the loop may take, leaving the rest for the human
  on the same plan. Over the ceiling the provider is unavailable *for the loop*, with the reason recorded beside
  a rate limit.
- **`budget.perIssueTokens`** — what one issue may cost across every loop call. Reaching it trips the existing
  cost-guard circuit breaker: it escalates, it does not retry with less headroom.
- **Cost lever 2, cheap verifier first**: with `delivery.verify.argv` set, deliver runs it before asking for a
  review. A build that does not pass never spends a two-vote review; it goes straight to a fix round.
- **Cost lever 3, model by size of change**: `delivery.review.smallChangeLines` and `delivery.review.criticalPaths`
  send a small or documentation-only change to the cheapest candidate and anything touching a critical path to
  the strongest. `PullRequestSnapshot` now carries `changedLines`.
- Levers 1 (stable cache prefix) and 4 (context pinned by digest) landed later in this release — see "The four
  cost levers, finished" below.

### Connectors: the engine stops naming vendors

Step 8 of the roadmap.

- **`TrackerConnector`** (queue, issue, comment, labels, state, claim/release, attach, create) and
  **`ScmConnector`** (pull requests, checks, comments, labels, merge), extracted from the Linear and GitHub
  adapters that already existed. `tick` and `deliver` now write to the tracker **only** through the interface, so
  a second tracker is a factory in `resolveConnectors` and a value in `connectors.tracker`, not a change in the
  stages. An unknown value fails with the name of the interface to implement.
- **`RunnerConnector`** with two implementations, because an interface with one is a guess: `orca`, and the new
  **`local`** — git worktree + tmux + the system crontab, no Orca and no daemon. `send` types the literal text and
  only then presses Enter, so a newline inside a brief cannot submit it early; `schedule` reconciles only the
  crontab lines carrying `connectors.local.cronMarker` and leaves every other line untouched.
- `connectors.*` selects them, `connectors.local.*` configures the local runner.

### `release` — promotion and deploy, with a human in front

Step 7 of the roadmap. `project.baseBranch` is the integration branch; `release` is what reaches production.

- `loop release status | approve | run`, and `loop stage release` for the scheduler.
- **The approval binds to a head sha.** Anything merged after it is a different batch and needs its own approval;
  the approval is spent on a successful promotion. An approval that outlived its commits would be a rubber stamp.
- Sequence: promote → `release.deploy` → `release.smoke`; a failing smoke runs `release.rollback` and escalates,
  and a project with no rollback declared is told plainly that a human has to decide.
- Everything is argv, never a shell string: the harness knows how to sequence a release, not how to deploy your
  service.
- New events: `release.promoted`, `release.deployed`, `release.smoke-failed`, `release.rolled-back`,
  `release.failed`; history in `<stateDir>/release.json`.

### `loop plan` — a vague objective becomes issues

Step 6 of the roadmap: the stage that was missing entirely.

- **interview → review → architect → decompose**, a state machine persisted in `<stateDir>/plans/<id>/state.json`,
  driven from the terminal: `loop plan start | answer | approve | architect | approve-design | decompose | show`.
- The **interview asks one question per round**, always with concrete alternatives and a recommendation, and ends
  when the *machine* says so: every required PRD field filled (`objective`, `users`, `inScope`,
  `successCriteria`) and no open question. A model declaring itself done with a gap still open is asked again.
  The human's answers enter the next prompt as data, never as instructions.
- The **architect** designs the whole PRD — module boundaries, contracts, decisions, sequence, risks — and three
  agents vote under the same 2-of-3 rule. Consensus is not enough: the design waits for a human too, because
  everything built afterwards inherits it.
- **Decompose** produces issues that each carry a layer label, a priority, verifiable acceptance criteria and a
  `designRef`; `--create` writes them to the tracker in the queue's **entry** state. `Todo → Ready` stays a human
  gesture — the single gate into the queue.
- New adapter call: `linearSaveIssue` (Orca `linear save-issue`), with a deterministic write id so a retried
  decompose cannot create the same issue twice.

### A plan, voted on, before any worker starts

Step 5 of the roadmap, and the fork closed in §7c: the planner and the vote run **in the harness, headless, before
dispatch** — the same shape as freezing the contract. The model writes the plan and the votes; the machine counts
them and decides.

- **`worker.plan`** (off by default — nothing changes until a project opts in): `votes`, `approvals` (2 of 3 by
  default), `maxCycles`, `timeoutMs`.
- Each cycle: the planner proposes, N agents vote, and a rejection **must** carry a concrete objection — one that
  cannot be answered is discarded, not counted. The next cycle replans with the standing objections quoted back.
- Every vote records the provider and model that cast it, so "three votes" never silently means one model voting
  three times.
- Running out of cycles is not a retry: the issue gets `needs-info` with the objections still standing. Three
  models disagreeing three times is an ambiguous requirement.
- The approved plan lands in `<stateDir>/issues/<id>/plan.json`, keyed to the contract digest, and is quoted into
  the worker brief — with "if it turns out to be wrong, say so in the PR, do not silently replace it".
- New events: `plan.voted`, `plan.escalated`, `plan.failed`.

### The Definition of Done becomes two lists, both proven on the PR

Step 4 of the roadmap.

- **`dod.items`** declares the project's list — the same for every issue — and every item declares how it is
  proven: `command` (argv the worker runs; exit 0), `file-changed` (the PR touches a matching path) or
  `pattern-absent` (no changed file contains the pattern). There is no `manual` kind on purpose: what cannot be
  proven is not a Definition of Done item.
- The **issue's list** stays what it always was: the frozen contract's outcomes, each with its check.
- The worker's brief now carries both lists and the exact file to write the proofs into (`dod.evidenceFile`,
  default `.ak-loop/dod.json` at the worktree root).
- **`deliver` blocks the merge until both lists are proven** and writes them, with the evidence, onto the PR. An
  item with no proof is *missing* (the fix round asks for the proof); an item proven and failing is *failed* (the
  fix round asks for the fix). They are different instructions and the loop keeps them apart.
- The harness decides `file-changed` and `pattern-absent` itself from the PR's changed files; `command` is always
  the worker's proof, because the harness does not run project commands.

### The retro starts improving the loop, within declared limits

Step 3 of the roadmap. Both mechanisms are off by default, bounded, and reversible.

- **Automated learning promotion** (`memory.autoPromote.enabled`). `promoteLearnings` now accepts a second actor,
  `loop-auto`, alongside `human` — the ADR-0019 amendment of 2026-09-19. The bounds that replace the human
  keystroke are the ones already configured: recurrence (`minSightings`), a per-retro cap (`maxPerRun`) and the
  allowed categories. The actor is recorded truthfully, so every automatic promotion can be listed
  (`loop learning promoted`) and revoked (`loop learning reject --ids … --by human`); the retro comment carries
  the revoke command next to what it promoted.
- **Self-adjusting knobs** (`tuning`). A knob is declared with a range — a value ladder or `min`/`max`/`step` —
  and the metric that justifies moving it (`review-findings-ratio`, `stuck-count`, `fix-rounds-per-merge`,
  `escalation-count`; all "lower is better"). At most `maxChangesPerRetro` move per cycle. Each change is written
  into `loop.config.yaml` **in place with every comment preserved**, validated before it is kept, recorded in
  `<stateDir>/tuning.json` with the reason and the evidence, and optionally committed (`tuning.commit`).
- **It undoes itself.** The next retro compares the same metric: worse than before the change means the knob goes
  back and is frozen until a human clears it. A metric at zero never moves a knob — a loop that keeps tightening a
  healthy gate eventually stops merging anything. Models, providers, gates and branches are never auto-adjustable.
- New events: `memory.auto-promoted`, `memory.auto-promote-failed`, `tuning.applied`, `tuning.reverted`.

## [0.14.0] - 2026-09-19

A queue that several machines can drain, a review whose strictness matches the risk, and four fixes that
were sitting unpublished. Motivated by a real 24/7 loop that had been silently doing nothing: the config
was invalid, the queue asked for the wrong assignee, and the diagnostic misnamed its own subject.

### The queue stops being "my issues"

- **`linear.queueOwnership`** (`person` | `unassigned`, default `person`, nothing changes unless you opt
  in). Under `unassigned` the queue lists with `--assignee null` and the assignee becomes a **transient
  claim**: written right after a dispatch succeeds, cleared when the item comes back. That is what lets
  several machines share one priority-ordered queue without two of them picking the same issue.
  The claim is non-fatal and gets its own `queue.claim-failed` event — what actually removes an issue from
  the queue is the status transition, so a failed claim must not cost the transition or the comment.
- **`linear.anyLabels`** — "at least one of these" (OR), because `requireLabels` is AND: listing two
  layers there demands both on the same issue and matches **nothing**. A queue that returns zero is
  indistinguishable from "no work to do", which is the worst failure mode this loop has.
- `loop doctor` now says **which** queue it read. Under `unassigned` ownership it used to print
  "for \<person\>" — the opposite of what it listed, and that is how an empty queue goes unnoticed.

### Review strictness that matches the risk

- **`reviewOverrides`** — stricter review for the slices that deserve it, keyed by label. First match
  wins and only the named fields are replaced: an override that raises `votes` must not silently reset
  the deadline or swap the CLI. The matched label travels to the deliver log, because a gate that costs
  more without explaining itself reads as a bug.
- The labels come from the **dispatch record**, not a fresh Linear read, so editing a label mid-flight
  cannot change the gate a running item is judged by.

### Telling the worker the truth about the base branch

- **`knownFailures`** — suites already red on the base, declared with the tracking issue (mandatory: a
  quarantine without an owner becomes permanent). The harness does **not** run `verifyCommand` — the
  worker does, in its own worktree — so tolerating known breakage is information in the brief, not output
  parsing. Without it, every item touching a broken package fails verification for someone else's defect.

### Memory: recurrence instead of guesswork

- Learning ids are content-derived, so a lesson that reappeared was silently deduplicated and a pattern
  looked exactly like a one-off. **`sightings` now counts**, and `loop retro` offers the lessons that hit
  `memory.recurrence.minSightings` with the promote command already filled in.
- Promotion still requires a human (`HUMAN_APPROVAL_REQUIRED`, ADR-0019). Memory is read into every
  worker brief: a wrong lesson promoted without a human is a wrong instruction on every future task.

### One human approval covers the goal's own effects

- **`tracking.authorization`** (`goal` | `separate`, default `goal`). Approving the verification result
  now authorizes the declared external effect too, recording `authorization.recorded` at the same
  instant. `separate` keeps the old two-gate behaviour.

### Fixes that had never shipped

- Phase age and worker age are different numbers: `ageMin` counts from dispatch, `phaseAgeMin` from the
  event that started the phase. An item in review for 10 minutes used to show the dispatch age and looked
  stuck for hours.
- Stale delivery state is reset on redispatch, dead stage locks recover, queue alerts are ignored during
  scheduled stages, and expected pre-PR delivery gaps stop being reported as problems.

## [0.13.0] - 2026-09-14

A full-codebase test-coverage sweep (every module in `src/kernel/`, `src/execution/`, `src/adapters/`, and most of
`src/loop/` brought to 90%+ statements/branches) that surfaced eight real bugs along the way, each fixed in its own
focused PR rather than folded silently into a test change.

- **Per-issue state files are now written atomically**: `dispatch.json`, `delivery.json`, and `contract.json` were
  each written with a plain `writeFileSync` straight to the final path. `tick` and `deliver` run as separate
  scheduled processes against the same state directory, and `readDeliveryState` already treats malformed JSON as
  "no state yet" rather than erroring — so a crash mid-write or a read racing a write could silently reset
  `fixRounds`/`nudges`/`finalOutcome` instead of surfacing the corruption. Consolidated the three duplicated unsafe
  writes into one shared `src/loop/fs-atomic.ts` (temp file + atomic rename).
- **`events.ndjson` rotation is now serialized**: `appendLoopEvent`'s size-based rotation (`statSync` →
  `renameSync` → `appendFileSync`) had no lock, so two scheduled processes rotating the same file near-
  simultaneously could overwrite one process's archive or drop events. Only the rotation decision is now gated
  behind a lock file; a busy lock skips rotation for that call rather than racing it, and a lock older than 5s is
  treated as an abandoned crash artifact and cleared.
- **PII scanner recognizes current-format secrets**: added `sk-proj-...` (current OpenAI project keys), fine-
  grained GitHub PATs, Google API keys, Stripe live keys, PEM private-key blocks, and the AWS secret-access-key
  half (previously only the `AKIA` access-key id was matched).
- **`Ctrl-C` now actually stops `loop watch`**: its SIGINT handler only set `process.exitCode` without calling
  `process.exit()`, so the long-running poll loop (and its `gh`/`orca` shell-outs) kept running in the background
  after a cancelled watch.
- **Raw throws reclassified as `HarnessError`**: `retro.ts`'s `--since` parsing and `doc-bridge.ts`'s index
  freshness/readability checks threw plain `Error`, so these bad-input/bad-state failures fell through the CLI's
  generic exit-1 catch-all instead of the classified exit-code path every other validation failure uses.
- **Fixed two `execution/agent.ts` session-recorder bugs**: a dead `executing` Set that could never affect
  control flow (removed), and a structurally-invalid-but-non-throwing runtime result that was being swallowed into
  a generic, retryable `RUNTIME_ERROR` instead of surfacing as its own distinct failure.
- **`findExecutable` now checks the execute bit**: a non-executable regular file sitting on `PATH` with a matching
  name was reported as a runnable binary, only to fail with `EACCES` at actual spawn time.
- **`loop debrief --issue X` no longer returns an empty report** for a normal, not-yet-dispatched issue: the
  "always include an explicitly requested issue" fast path was shadowed by an unconditional second skip check
  right after it.

Everything else in this release is test-only: no other production behavior changed.

## [0.12.0] - 2026-09-13

Closes gaps found reusing Orca instead of reinventing it. Orchestration mutations (`run-create`, `task-create`,
`worker-start`, `send`) were verified to require a live Orca terminal pane and cannot be called from the loop's
headless `tick`/`deliver` — every angle was tried (worker-side sends, coordinator-of-own-Run) and all failed
structurally, not from a config gap. What *is* reachable headlessly turned into real fixes below.

- **Escalations now carry the worker's own diagnosis**: `loop deliver`'s stuck/blocked escalations capture the
  dispatched worker's terminal output (`terminal read --screen`, best-effort) and fold it into the Linear comment.
  Two real incidents showed the worker had already explained the blocker in plain language (an explicit "BLOCKED:
  ..." reply, a sandboxed git error) that the idle/no-PR heuristic was discarding.
- **Slot assessment uses Orca's real memory diagnostic**: the harness's own `vm_stat`-based free-RAM estimate and
  static `machine.agentRssMb` guess were measured to run roughly 2x more conservative than `orca diagnostics
  memory`'s macOS memory-pressure reading, at the same instant. `assessSlots` now prefers `host.availableMemory`
  and the average of real per-session RSS when Orca's diagnostic is available, falling back to the previous
  behavior otherwise.
- **`ak-harness-loop` Orca Skill**: an installable `SKILL.md` (`skills/ak-harness-loop/`) documenting the
  read-only vs. mutating `loop` commands and the operational constraints this release's investigation surfaced,
  so a future agent session doesn't have to rediscover them.

## [0.11.0] - 2026-09-13

- **Read-only loop observability**: added `ak-harness loop observe` plus the public `runObservability` and
  `assessObservability` APIs. The report combines doctor/debrief/event-log data with Orca terminal/worktree
  inspection and exposes queue, delivery, machine, provider, memory, cache, review, fix-round, lead-time, and
  observed-token metrics.
- **Deterministic anomaly detection**: flags connected terminals without output, active claims without
  `delivery.json`, finalized dirty worktrees, ready queues with idle slots but no recent dispatch, and stalled
  in-flight workers/reviews. `--precheck` returns scheduler-friendly exit codes without mutating state.
- **Operator documentation and coverage**: added ADR-0031, module-boundary documentation, and focused regression
  tests for the observability rules.

## [0.10.0] - 2026-09-12

Closes the gaps found comparing this harness against LangChain's "custom agent harness" article. The structural
difference stands: this harness orchestrates opaque external CLI agents, so a model/tool-loop middleware isn't
possible here — every item below targets the orchestration layer this loop actually controls (see ADR-0030).

- **Local event bus + orchestration lifecycle hooks**: `plugins.modules` (local `.mjs` files, empty by default)
  loaded once per `tick`/`deliver`, each getting `src/loop/event-bus.ts`'s bus to subscribe to loop events live
  and to `beforeDispatch`/`afterDispatch`/`beforeReview`/`afterReview`/`beforeMerge`/`afterMerge`/`onPause`/
  `onEscalate` — a `before*` hook can return `{ block: true, reason }` to stop the action. `loop doctor` gained a
  `plugins.modules` check.
- **PII/secret scanning**: `security.pii.enabled` (default false) scans issue text before it enters the
  orchestrator prompt and the worker brief for PII-shaped patterns (email, common API-key prefixes, phone,
  card-number-shaped digits); `security.pii.action` is `redact` (default when enabled), `warn`, or `block`.
- **Cost/time circuit breakers** for an in-flight dispatch, since the loop cannot count a worker CLI's own
  model/tool calls: `delivery.maxDispatchMinutes` (hard wall-clock ceiling) and `resilience.maxUsageDeltaPercent`
  (stops a dispatch whose provider's remaining Orca usage dropped past the threshold since it was sent out).
  `dispatch.json` now records `initialRemainingPercent`. Either trip stops the issue like a stuck worker.
- **Human-approval merge gate**: `delivery.merge.requireHumanApproval` (default false) holds a clean, green-checks
  PR until a human approves it on GitHub (`reviewDecision: 'APPROVED'`, already fetched with every PR snapshot).
- **MCP allowlist doctor check**: `loop doctor` validates the default-deny `mcp.allowTools` bridge wiring when
  `mcp.enabled` — MCP stays adapter-only and read-only per ADR-0028, so this checks the allow/deny plumbing, not a
  live connection to an MCP server.
- **Dynamic outcome progress**: the brief documents an optional `progress.json` convention
  (`{"o1": "done", "o2": "in-progress"}`) a worker can write at its worktree root; `loop debrief` shows
  `N/M outcome(s) done` per in-flight issue when present (`src/loop/progress.ts`, best-effort, never required).
- **Secret-shaped filename guardrail**: `delivery.secretFilePatterns` (default covers `.env`, `*.pem`, `*.key`,
  `id_rsa`, `credentials.json`, …) extends the existing `selfEditPaths` hold — a PR touching a matching filename is
  held, never reviewed or merged, in both the normal dispatch path and GitHub label intake.

## [0.9.0] - 2026-09-12

- **Failure-classification fix**: `classifyProviderFailure` now recognises real Claude/Codex/Grok usage-limit phrasing ("You've hit your session limit", "usage limit reached", "credit balance is too low", "spend limit reached", "temporarily limiting requests", "Overloaded") as `quota` instead of falling through to `other`, and `extractResetsAt` parses a relative (`resets in 3h`) or clock-time (`resets 10:40pm`) reset out of the message. A code-review exit is classified the same way, marking the reviewer's provider (not the review-CLI transport id) cooling down instead of retrying every tick. Root cause of a 2026-09-11/12 pilot bug: 19 unclassified `contract.failed` retries across 4 issues and 12 incomplete reviews over 7h with no cooldown ever recorded.
- **Auto-pause after repeated failures**: `resilience.maxConsecutiveFailures` (default 3) pauses a single issue after that many consecutive `contract.failed`/`worker.dispatch-failed` events — one deduplicated Linear comment, the `resilience.pausedLabel` (default `loop:paused`), and it is skipped locally until the label is removed or `ak-harness loop resume <issue>` runs. `resilience.stagePauseAfterRuns` does the same for a `loop stage tick|deliver` run that throws repeatedly, via `loop resume --stage tick|deliver` and a new `loop paused` listing.
- **Skills pinned into the worker brief**: `brief.skills` lists Markdown files (relative to `project.root`) embedded verbatim, sha256-digested, and truncated at `brief.maxSkillChars` in every worker brief's new "Skills (pinned)" section. A missing file fails the dispatch closed. The rendered brief is persisted to `<stateDir>/issues/<id>/brief.md`; `dispatch.json` records `briefDigest` and per-skill digests. A handoff never re-reads `brief.skills`, so editing a skill file after dispatch never affects an in-flight worker. `loop doctor` gained a `brief.skills` check.
- **Worktree setup command**: `project.setup.command` (argv, no shell) runs once in a freshly created worktree before the worker terminal opens (e.g. `pnpm install --frozen-lockfile`), bounded by `project.setup.timeoutSec` (reserved out of the tick budget). `project.setup.required` (default true) fails the dispatch — same cleanup and consecutive-failure accounting as any other dispatch failure — on a non-zero exit or timeout; set to false to only warn.
- **Reasoning effort per role**: `models.effort.<role>` (`low`\|`medium`\|`high`\|`xhigh`) is rendered via `providers.<id>.effortFlag` (e.g. codex `-c model_reasoning_effort={effort}`, grok `--reasoning-effort {effort}`) into `tui`/`headless`; a provider without `effortFlag` ignores it. `dispatch.json` and `loop retro`'s `dispatches.byProvider` record/group by `provider/model@effort`.
- **GitHub label intake**: `github.intakeLabel` (default `loop:review`; `null` disables it) makes `deliver` review and comment on any open PR carrying the label, even one the loop never dispatched (tracked as `pr-<n>`, no Linear issue involved). Every nudge lands as a PR comment instead of a terminal send; `github.reviewOnly` is a fixed schema guarantee — a clean review always ends held ("merge is human") with the label removed, never auto-merged.
- Fixed `scripts/verify-release-manifest.mjs`, which pinned the release version literal to `0.5.0` and would have failed every release since 0.6.0.

## [0.8.0] - 2026-09-12

- Worker **handoff**: when a dispatched worker is idle (or its terminal is gone) and its provider is unavailable (usage/cooldown), deliver relaunches another builder on the **same** Orca worktree + branch with a continuation brief (`renderHandoffBrief`). Lease stays; `dispatch.json` updates terminal/provider/model; `delivery.handoffs[]` + `worker.handed-off` event. Caps via `delivery.handoff.maxHandoffs` (default 2).

## [0.7.0] - 2026-09-12

- Dynamic model routing: `models.routing.mode` (`tiers` | `hybrid` | `dynamic` | `catalog`). Default `tiers` preserves 0.6 behaviour.
- `hybrid`/`dynamic` rank available providers by **remaining Orca usage** (most-constrained window) so work follows quota instead of fixed YAML order.
- Living model catalog (`catalog` mode): CLI discovery (`grok models`), builtin catalog, optional Artificial Analysis cache (`ARTIFICIAL_ANALYSIS_API_KEY`), role quality bands (`frontier`/`balanced`/`fast`).
- Doctor reports remaining usage, why a model was chosen, and Orca integrations missing from `models.providers`.

## [0.6.0] - 2026-09-12

- Loop **approved memory** for token reduction and continuous improvement: file store under `stateDir`, recall into contract/brief with `preferOverDocBridge` + issue-char shrink, human-only `ak-harness loop learning promote`, `memory.recalled` events.
- Doctor: Doc Bridge index/freshness checks; review CLI PATH/`--help` probe (warning when missing).
- Worker brief lists Doc Bridge `playbook` / `for-agents` guidance paths (`contract.briefScopes`).
- Optional deliver smoke gate (`delivery.smoke.verify-argv`) before auto-merge.
- Optional `agents.registry.yaml` role overlay; RAG `ContextProvider` via argv (no hard dep); MCP tool bridge behind policy ([ADR-0028](docs/ADR-0028-mcp-adapter-boundary.md), not loop-wired).
- Optional weekly Linear retro automation (`schedule.retro` + `schedule.retroIssue` → `loop stage retro`).
- Config knobs default off / fail-soft so existing `loop.config.yaml` behaviour is unchanged.

## [0.5.0] - 2026-09-11

- Added the keep-pushing SDLC loop foundation (`ak-harness loop validate|doctor`): `loop.config.yaml` schema (zod), provider detection with Orca usage/rate-limit awareness and cooldowns, role-based tiered model routing, machine slot assessment, Orca CLI and Linear-via-Orca adapters, and the loop doctor report.
- Added loop phase 2 adapters: Orca worktree create/set/rm, terminal send/wait/read and automations argv; Linear issue detail, status/comment/label/attach writes and a Linear `TrackingAdapter`; GitHub PR snapshots, check assessment, self-edit path guard and optimistic squash-merge via `gh`.
- Added loop phase 3 (`ak-harness loop tick|precheck|contract`): orchestrator-frozen task contracts with untrusted issue text, candidate fallback and provider cooldown on auth/quota failures, dispatch ledger claims, Orca worktree dispatch with `--linear-issue`, worker briefs, Linear In Progress transition and `needs-info` escalation.
- Added loop phase 4 (`ak-harness loop deliver`, `precheck deliver`): per-issue delivery state, PR detection by branch, protected-path hold, conflict/CI/review fix rounds sent to the worker terminal with a bounded budget, `agentskit-review` at the current head, optimistic squash-merge, Linear attach/Done, worktree cleanup, stuck/abandoned escalation with slot release.
- Added loop phase 5 (`ak-harness loop install|uninstall|status|hook`): idempotent Orca automations with `--precheck`, existing-workspace mode and session reuse; status with latest runs; a status-only SessionStart hook line; a cross-platform CI job (ubuntu/macos/windows); ADR-0027.
- `loop install` is guided: doctor and environment checks (harness/review CLIs, `gh auth`, Orca repo registration), optional dry-run tick rehearsal, explicit confirmation; `--yes`, `--force`, `--skip-rehearsal`, `--dry-run`, `--plain`.
- `loop install` offers to create the per-machine `loop.config.local.yaml` (queue owner from the Linear team, RAM reserve, worker ceiling) when it is missing; the CLI renders checks and prompts with Ink on TTYs and falls back to plain lines elsewhere. Grok is treated as a CLI subscription (`grok login`), no API key.
- Orca automations now run the stage inside the `--precheck` command (`ak-harness loop stage tick|deliver`, always exit 1) so no agent session is opened per run; `schedule.runner: agent` keeps the previous behaviour. Fixes stuck bypass-permissions sessions leaking one terminal per run.
- Added `ak-harness loop retro [--since 7d] [--json|--learnings]`: escalations by reason, dispatches by provider, merged/blocked/stuck, review outcomes, fix rounds, median lead time, cooldowns, Orca run summary, and rule-based calibration suggestions with the config knob to turn; the Markdown follows the harness retro grammar so `parseRetro`/`promoteLearnings` apply. Suggestions are split by target — `project` (config, issues, process) versus `harness` (library defects seen in production) — with `--target` to filter; the tick records `contract.failed` events.
- Reviews run `agentskit-review --mode trusted-local` by default (`delivery.review.mode`); the isolated default gives claude/codex a temporary HOME without credentials and every lens fails with "Not logged in".
- Review defaults fit an Orca stage: `profile: fast`, `votes: 1`, `concurrency: 4`, and the deadline is capped to the stage budget under `runner: precheck`; `full` profile stays available for long deadlines.
- `delivery.review.transport` (`acp` \| `headless` \| `auto`) is passed through to `agentskit-review` so Grok can use headless when ACP is broken.
- Added `ak-harness loop debrief`: read-only human explanation of in-flight work, holds, escalations and cooldowns (Markdown or `--json`).
- Added `ak-harness loop watch`: TypeScript poller over `delivery.json` (+ optional live PR) emitting `DONE` / `FAILED` / `ACTION_REQUIRED` / `PROGRESS`.
- Workers are launched with the configured TUI command in their own terminal (`orca worktree create` without `--agent`, then `orca terminal create --command <tui>`, wait for idle, send the brief). Orca's `--agent claude` starts in bypass-permissions mode and blocks on a human prompt. The tick has a wall-clock budget under `runner: precheck`; a failed dispatch removes its half-created worktree.
- Add bounded agent eval, safe context/read-only LLM cache, deterministic workflow fan-out/fan-in, and validated optimization observation contracts for token, memory, cache, and parallelism measurements.

## [0.4.0] - 2026-09-10

- Added phase quality matrices, watchdog classification, and resource telemetry.
- Added versioned eval and ecosystem compatibility manifests with fail-closed
  evidence handling.
- Added runnable consumer onboarding, adapter examples, and troubleshooting.

## [0.3.0] - 2026-09-10

- Added portable issue/worktree claims and idempotent dispatch ledger.
- Added failure classification, bounded retry/backoff, and abortable watchdog.
- Added file-scoped preflight planning and shell-composition rejection.
- Added block manifests, status snapshots, retro learning promotion, model
  policies, and provider-neutral Orca/tracking adapters.
- Added configurable machine pressure thresholds and adaptive workflow limits.


All notable changes to `@agentskit/harness` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows Semantic Versioning.

## [0.2.0] - 2026-09-09

### Added

- Pilot-cohort validation that freezes a policy/baseline pair and rejects non-normal, partial, or silently substituted ten-issue cohorts.
- Bounded five-step improvement-cycle assessment with explicit adjustments, repeat decisions, and a deterministic quality matrix.

- Deterministic G2–G5 assessment helpers and CLI commands for independent preflight review, structured idempotent PR handoff, current integration evidence, safe production exposure, and acceptance.

- Current-source evidence now requires a committed Git `HEAD`; directories outside Git fail closed instead of receiving a synthetic revision.

- Discovery gate API and CLI that emit `ready` or an auditable human decision packet from structured ambiguities, approved assumptions and source/contract/context bindings.
- Deterministic WIP admission API and CLI that count blocked and awaiting-human deliveries, reserve resumed work, and reject duplicate ledger entries.
- Controlled runtime-selection API and CLI that reject incomparable Orca/Emdash samples and exclude failed hard gates.
- Configurable `runtime.kind` contract field plus a factory for bounded process or Docker-sandbox execution.
- Real Git snapshot coverage for committed, dirty, untracked, and task-state-excluded evidence.
- Strict TypeScript modular core with generated declarations and source maps.
- Contract-frozen lifecycle, structured evidence, stale detection, human approval, retry, and cleanup.
- Explicit human cancellation and superseded retry history.
- Typed dependency-aware plugin lifecycle with deterministic cleanup.
- Append-only, source- and contract-bound lifecycle event log per run.
- Declarative profile inheritance with validated check overrides.
- Optional provenance-bearing context provider slot for Doc Bridge and Playbook adapters.
- Dependency-free Doc Bridge index adapter with deterministic references and frozen context snapshots.
- Context lifecycle events and stable context hashes that ignore resolution timestamps.
- Portable CLI snapshot resolution and `plan --context-file` binding for shell-based agents.
- Tamper-evident validation for imported context snapshots.
- Direct API callers now receive the same tamper-evident context validation as CLI callers.
- `benchmarkRuns` and `ak-harness benchmark` for reproducible historical run metrics.
- Phase 0 benchmark manifests, task identity bindings, and explicit baseline comparisons.
- Typed agent session recorder with correlated turn/tool events and guarded ordering.
- Adapter metadata and session event protocol that persists hashes instead of raw agent content.
- Required deny-by-default Policy Gate with ordered rules and correlated blocked-tool events.
- Bounded in-process tool runtime with timeout, abort signal, hashed results, and structured failures.
- Shell-free child-process runtime with timeout, output limits, and structured process failures.
- Optional Docker runtime with a no-network, read-only, unprivileged, resource-limited sandbox profile.
- Typed runtime attestation with Docker image digest and effective profile hash in terminal tool events.
- Controlled baseline observation recording through the typed API and `ak-harness benchmark baseline`, with duplicate, unknown-task, and atomic-write protections.
- Benchmark comparisons now require completed harness evidence and report honest non-comparability reasons plus check, outcome, evidence, and review metrics.
- Benchmark baselines now require explicit, unique criterion-level evidence; comparisons report baseline evidence coverage and reject incomplete evidence.
- Comparable benchmark reports now expose directional duration, attempt, and human-review outcomes, with `unavailable` for non-comparable tasks.
- CLI-recorded baseline evidence now preserves a SHA-256 digest of the evidence file and validates digest format on manifest load.
- New lifecycle event logs carry a chained SHA-256 digest and expose explicit integrity verification; legacy logs remain readable but are not reported as verified.
- Event-log locks now carry owner metadata and expose explicit human-authorized stale-lock inspection and recovery through the API and `events lock|unlock` CLI commands.
- Signed evidence verification now supports stable key identities and explicit active/revoked trust stores for controlled key rotation.
- Policy rules can require explicit human approval before sensitive tool actions enter the runtime; unresolved and rejected approvals remain fail-closed and auditable.
- Agent sessions can be resumed from their hash-chained event log, preserving pending approvals without replaying completed tools.
- Ambiguous resumed tool actions now require an explicit human retry or abandonment decision after `tool.execution.started`.
- Benchmark comparisons now expose controlled `escapedIncomplete` deltas for measuring incomplete deliveries that escaped validation.
- Verification results now carry a projection digest in `run.json` and a matching `verification.completed` event; approval rejects projection tampering.
- `ak-harness` CLI and `ak-verify` common-protocol alias.
- Public package documentation and community policy files.
