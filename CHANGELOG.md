# Changelog

## [Unreleased]

## [0.21.0] — 2026-09-26

The four gaps left in the control plane v2, closed.

- **Runs shows fix rounds used.** The table reads `used/max` (or the used count when the run was dispatched without
  the wizard) instead of `—/max`.
- **Time in phase is time in phase.** The projection stamps `phaseSince` when an issue's phase changes; the table,
  the running cards and the side panel use it instead of the last event's time.
- **A real event stream on the home page.** `GET /api/v1/events/recent` serves the loop's last 24 h of events,
  newest first, each summarised from its typed fields; the home stream uses it instead of per-issue changes.
- **New batch shows contract status.** `GET /api/v1/contracts?issues=` reports each stored contract and whether it is
  still inside `contract.reuseHours`; the list marks issues as cached, expired, needing input or without a contract.
- **Tracker titles and states survive a restart.** The off-board lookup cache is persisted (bounded to 1000 entries),
  so a restarted UI does not show cancelled work as blocked while it re-learns it.

## [0.20.0] — 2026-09-25

Control plane v2, and the fixes found running the loop against a real repository in the week since 0.19.0.

- **Control plane v2 (`ak-harness ui`).** The home page is now an attention queue — human decisions, stuck or
  failed runs, state out of sync with the tracker or Orca, and system problems — each with the reason and the next
  action. The page reconciles the loop against the tracker and Orca on every refresh, resolves titles and states
  for issues the board does not list, and refuses destructive actions (409) while an issue is out of sync or its
  data is stale. Observed on a real loop: 24 "blocked" issues shrank to 4 once the cancelled ones were recognised.
  New screens: Runs (filters, search, paging, issue side panel with per-criterion evidence, review, worker,
  timeline and cost), Trends, Costs (tokens and plan usage, no dollar estimates), Explore (windowed search over
  events, contracts, evidence, reviews and learnings), System (doctor, routing, cooldowns, automations, stages,
  learnings) and Settings (effective config with provenance, personal overrides, team diffs, tuning freeze). CLI-only
  actions are now in the UI and call the same kernel functions: approve a held PR, plan/design/release approval,
  learning promotion, stage pause/resume, tick/deliver/doctor, automation reinstall, batch enqueue. See ADR-0040.
- **The UI no longer installs Orca automations on start.** Missing or drifted automations show up as system items
  and reinstall on request, pinned to the running harness binary.
- **Weakening a gate is a personal, recorded choice.** Settings writes only `loop.config.local.yaml`; lowering a
  gate there needs explicit confirmation, and every run queued under it records `weakenedGates` and shows a
  badge. Team values come back as a diff to commit, never written by the UI.
- **Attention alerts reuse `notifications`.** A new human-decision or failure item posts `attention.entered`
  through the existing webhook or command channel, once per item.
- **The `ui` verification check runs the real UI suites.** It pointed at `test/ui.test.ts`, which #111 removed.
- **UI copy is English.**

- **`plan approved` supersedes a stale finished run by itself.** A `COMPLETE` (or approval-pending) run whose
  source or contract had moved on still blocked a new plan with `ACTIVE_RUN` until someone ran `status`, which
  only reconciles. Planning now marks it `STALE` and supersedes it; a fresh finished run still blocks.
- **An idle worker with committed but unpushed work is told exactly that.** Observed: a worker committed the whole
  change and stopped before pushing; the generic idle check-in did not see it and the dispatch was marked stuck
  40 minutes later with the work sitting in the worktree. Deliver now counts local commits no remote has and
  asks the worker to push and open the PR.
- **Control plane rewrite (#111).** One projection over the loop's event log replaced the lifecycle guesses the old
  page made from free text; the frontend is a React app shipped in the package.
- **A worktree left for inspection no longer marks its issue busy forever (#112).** After a cost-guard trip or an
  escalation the preserved worktree kept the issue out of dispatch even once resumed; only a live agent, an open PR
  or a merged artifact now counts as busy, and unknown activity still fails closed.
- **Scheduled stages run the harness that installed them (#114).** Orca resolved `ak-harness` on its own PATH — an
  older global install that rejected the config — so every scheduled deliver crashed on load. Installs pin the
  running binary; doctor fails `automations.precheck-failing`; the UI shows a stopped stage; Orca's linked PR moves
  a running issue to review as a read-only overlay.

## [0.19.0] — 2026-09-23

Found by running the loop on a real repository migration with a single, non-default provider.

- **A brief the terminal never confirmed is sent again at once.** The dispatch (and a handoff) recorded that the
  brief was not confirmed, and then nothing acted on it until the 45-minute idle timeout — observed twice, an agent
  sat on an empty prompt because the pointer was typed while its shell was still starting it. The dispatch record
  now carries `briefAccepted`; deliver re-sends the pointer on its first pass over an idle worker, once. The idle
  nudge also points at `.ak-loop/brief.md`, since "continue from `git status`" means nothing to a worker that never
  read the brief.

- **A reset time in days is read whole.** "reset in 4 days 11 hours" (opencode's weekly limit) matched nothing,
  so the provider cooled down for the default 30 minutes and the next dispatch went straight back to it;
  "1 hour 32 minutes" lost its minutes. Every amount after "reset(s) in" now counts, days included.

- **A brief confirmed on screen must stay there.** For agents whose turns Orca cannot observe, the brief counted
  as delivered as soon as its first words appeared; observed, an opencode TUI showed the pointer prompt, dropped it
  and sat on an empty input for minutes. The words must now still be on screen a moment later (a started turn keeps
  the message in its transcript), or the prompt is sent again.

- **An incomplete review says why.** The reviewer's own explanation (exit code and the tail of its output) was
  dropped, so "review incomplete twice; needs a human look" sent a person to re-run the review by hand to find out
  that one lens had returned invalid structured output. It is now kept on the review record, on the
  `pr.reviewed` event, in the held reason and in `loop watch`.

- **`loop watch --issue` waits for an issue that is not dispatched yet.** It returned `done` at once, silently,
  when the named issue had no dispatch record — the usual case right after moving it into the queue.

- **Decompose files work outside this repository outside the queue.** The loop delivers pull requests to
  `project.repo` and nothing else, but decompose also split out issues for other repositories and a deploy;
  once moved into the queue, a worker would have opened a PR here that did not do the work. Planned issues now
  carry `outside` (where the work happens, empty for a PR here); those are filed with `linear.outsideLabel`
  (default `outside-loop`) instead of the queue's labels, say so at the top of their description, and the queue
  never dispatches an issue carrying that label.
- **Approved plan documents stay out of someone else's work.** `loop plan approve` and `approve-design` wrote
  the PRD and the design into `project.root` whatever that checkout held; approved while it sat on an unrelated,
  dirty branch, the PRD landed silently among that branch's uncommitted changes. They are now written there only
  when the checkout is the clean `project.baseBranch`; otherwise under `<stateDir>/documents`, and the command's
  output carries a `note` saying why and that the file needs a PR of its own.
- **A PR closed without merge is escalated once.** Every later deliver pass repeated the escalation for the
  same closed PR — blocked label, transition back to `delivery.returnState`, claim release, Orca comment and a
  `worker.abandoned` event — so an issue a person had since moved was moved back every few minutes.
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
- **A worker out of usage is handed to another provider.** `deliver` reads the worker's screen for the CLI's own
  usage-limit line (opencode: "5 hour usage limit reached. It will reset in …"), marks that provider exhausted until the
  printed reset, closes the exhausted terminal and hands the task to a builder from a different provider in the same
  worktree. Such a worker is never idle — its TUI keeps redrawing "retrying" — and Orca reports no usage for some
  providers, so it used to sit until the provider came back. If the old terminal cannot be closed the issue is held:
  two agents never share a worktree.
- **Model output is found where models actually put it.** The plan stages, votes and contract share one extractor:
  the exact markers when their content parses, else the last fenced JSON block, else the last balanced JSON value that
  parses — the schema still validates whatever is found. Measured on the interview prompt across five models: kimi-k2.6
  dropped the markers for a ```json fence, minimax-m3 mangled them (`<<…` / `<<<…>>>`); with the lenient list shapes
  above, 5/5 now parse, against 2/5 with the strict markers-and-shapes parser.
- **The design gate does not approve open objections by default.** `loop plan approve-design` refuses when any vote
  still carries an objection, even at consensus, and lists them; `--accept-objections` carries them into decompose,
  which is told to settle each one as a decision inside the issue it affects. A 2-of-3 design had been approved while
  two votes named the same missing decision, and it came back as two blocking contract escalations.
- **On macOS, machine pressure is the CPU actually busy, not the load average.** `sampleMachine` measures the busy
  share over 250 ms (`cpuBusyPercent`) and concurrency decisions use it when present; the load average also counts
  runnable-but-idle and I/O-blocked threads and was observed at 60–80 % with the CPU 80 % idle, capping the loop for
  nothing.
- **Review rounds that only discover do not spend the fix-round budget.** A review re-reads the whole change at every
  head, so a worker that fixed everything it was told could still get a new finding each round and be blocked at
  `maxFixRounds` — observed: three rounds, three different findings, all fixed, issue blocked. A round whose findings
  were all absent at earlier heads is now not counted; a finding that persists across heads still is, and twice
  `maxFixRounds` in total review rounds stays a hard ceiling on cost.
- **A PR held for protected paths can be released inside the loop, by an attested approval.** `ak-harness loop
  approve <issue> --head <sha> --by <you>` records who vouched for which commit (in the delivery state and the event
  log as `pr.human-approved`); the loop then reviews and merges that PR as usual, and a new push needs a new approval.
  The hold comment prints the exact command. Deliberately not a PR label: a worker holding the same credentials could
  put one on its own pull request.
- **An agent whose turns Orca cannot observe is confirmed by its screen.** For such an agent (opencode reports
  `observation: unsupported`) the stages never pass `input_accepted`, so the launcher checks that the prompt's first
  words appear on screen and sends again, up to twice, when they do not — an opencode TUI reported idle while still on
  its splash screen and swallowed the brief. `OrcaSendReceipt` gains `observation`.
- **A brief counts as delivered only when the agent's turn starts.** Orca's `input_accepted` means typed, not
  submitted; a pointer prompt sat unsubmitted for 21 minutes and the worker only began when an idle nudge's Enter
  submitted it. The launcher now observes the request again, presses Enter alone if the turn still has not started
  (a no-op for a busy agent), and reports the brief unconfirmed otherwise.
- **A merged issue sheds the flags the loop put on it, and the record says who merged.** Completion removes
  `blocked`/`needs-info`, and a PR merged outside the loop is recorded as merged by a person — the comment used to
  claim "a clean review and green checks" for a PR whose review had blocked and whose CI never ran.
- **A worker starts from the remote base, not the operator's local branch.** The tick fetches
  `origin/<baseBranch>` and creates the worktree from it; `--base-branch main` made Orca resolve the operator's local
  `main`, which nobody fast-forwards — a worker started two merges behind and measured code that no longer existed.
  A failed fetch fails the dispatch.
- **The worker brief travels as a file, not as keystrokes.** The brief is written to `.ak-loop/brief.md` in the
  worktree (already excluded from git) and the terminal receives one short line pointing at it. A real 44 KB brief
  failed every send with `agent_session_ownership_unknown` — deterministically, even with retries — while random
  text of the same size and line count went through: the TUI's paste handling reacts to content, and no retry fixes
  that. Relaunches and handoffs use the same path when the worktree path is known.
- **An ambiguous prompt send is retried by id, not lost.** When Orca answers a send with a failure that names a
  `--retry-request <id>` (e.g. `agent_session_ownership_unknown`), the adapter re-issues it with that id — up to three
  times, 5 s × attempt apart, because the cause is a race: a TUI reports idle a moment before its session hook tells
  Orca who owns the pane. The dispatch used to fail and remove a freshly created worktree.
- **Phase artifacts stay out of product commits.** At dispatch the harness adds `/.ak-loop/` to the repository's
  shared `info/exclude`, and the brief says never to commit it — a worker's `git add -A` had put the loop's own
  evidence files into a product pull request.
- **The worker brief no longer forbids what the contract asks for.** Standing rule 5 listed `delivery.selfEditPaths`
  as paths to *never edit* — but that list is a review gate (a PR touching it is held for a human), so a task whose
  whole job lives under a gated path got a brief that contradicted its contract. The rule now says the paths are
  gated, to edit them only when the contract requires it, and to say so in the PR. A new rule forbids `git stash`:
  the stash is shared by every worktree of a repository, and a worker dropping `stash@{0}` by index can destroy
  another worktree's entry.

- **Gate lists accumulate across config layers.** `delivery.selfEditPaths`, `delivery.secretFilePatterns` and
  `delivery.requiredChecks` are no longer replaced by a later layer; an entry leaves only when named as `"!entry"`.
  A machine overlay written to free one path had silently dropped the `packages/**` freeze added to the project
  five days later.
- **`loop plan decompose --create` files issues outside the queue and where the queue will find them.** New
  `linear.entryState` (default `Backlog`) must not be one of `linear.states` — the config is refused otherwise;
  before, issues were created in `states[0]`, which *is* the queue, so the human gate did not exist. The issues now
  carry the queue's `requireLabels`/`anyLabels`, land in the project the queue drains (or `--project`), and hang
  under `--parent <epic>`. `--create` now files the list already decomposed and shown instead of asking the model
  for a new one — the reviewed list and the created list used to differ; `--refresh` decomposes again. A layer
  becomes a label only when the project declares it: with none configured the prompt used to offer "no layers
  configured" as the choice, the model echoed it, and the tracker refused every issue.
- **The plan interview reads what a model meant instead of losing the round.** While the PRD is being filled, a
  bare string is a one-item list and an empty list is a gap for `prdGaps` to report — `glm-5.3` answered
  `"users": "…"` and `"successCriteria": []` and the whole round failed validation. The final PRD stays strict.
- **`loop plan` has its own time budget.** New `worker.plan.stageTimeoutMs` (default 900 s) covers the interview,
  architect, design vote and decompose; `worker.plan.timeoutMs` stays the per-issue planner's. The architect designs
  a whole PRD from a human's shell, and at the shared 300 s `glm-5.3` never finished one.
- **A worker brief is never typed into a pane that is not `tui-idle`.** The launcher waits a second, longer window;
  if the TUI still is not ready the dispatch fails (and the half-created worktree is removed) instead of losing the
  prompt.

## [0.18.0] - 2026-09-22

What a pre-publish review found when it went looking for the gap between what this package claims and what it
does. Six changes, every one of them a place the harness was wrong about itself.

### Release

- Publishing lives in `release-harness.yml` alongside the checks, as a job that `needs` all three. It used to be
  a separate workflow running *in parallel* with CI, re-running only typecheck/test/build, so a commit could fail
  `ak-verify`, the docs check or the Windows matrix and ship anyway. The filename is load-bearing: npm Trusted
  Publishing authorises by repository **and workflow filename**, and moving the publish to `ci.yml` had it
  rejected with a 404 on the PUT.
- Whether a version is new is the registry's answer now, not a `git diff` against `github.event.before`, which is
  absent after a force-push and was read as "changed".
- `test:capabilities` and release evidence had nothing running them: the first was in no CI job and no contract
  check, the second unchecked entirely while `qualification.json` said `0.4.0` inside the shipped tarball.


### Hygiene

- `loop validate` names config keys the schema does not know instead of stripping them in silence.
  `maxFixRoundz: 2` used to be accepted with `maxFixRounds` quietly taking its default — a typo that reads as
  "I configured this" and behaves as "I did not". Reported, not rejected: a config written for a newer harness
  legitimately carries keys this version has never heard of.
- `deliver` derives the required phase artifacts from the same source `tick` used to decide whether to run the
  planner. A flow that turned the planner off still had deliver demand a `plan.md` the worker was never asked
  to write, and send back a fix round for the omission.
- A dispatch with a cached contract no longer skips the whole time-budget guard. It waived the setup share too,
  and the setup timeout then floored at 1s — a command guaranteed to time out, and with `setup.required`
  (default) a guaranteed dispatch failure that also burned the worktree.
- `loop.config.example.yaml`: the `minSeverity` explanation was attached to the `doctorProbe` line, so copying
  it produced a validation error. `AGENTS.md` no longer claims one `test:*` script per contract criterion —
  there are 47 scripts emitting 82 criteria names against 18 outcomes, and 12 outcomes emit from none.

### Boundaries

- Every read of a JSON file the harness wrote goes through `readJsonFile(path, schema)` and is validated before
  the caller sees it. `JSON.parse(readFileSync(path)) as SomeType` was a claim about a file on disk that nothing
  checked; a record missing a field or holding the wrong type passed the cast and failed somewhere unrelated.
  `scripts/verify-json-boundaries.mjs` keeps new ones out, with a short reviewed allowlist.

### Token and time economy

- `one-shot-vote:` — `plan-vote` made one full call per vote, so a pool with fewer distinct voters than `votes`
  called the same model repeatedly with a byte-identical prompt, re-sending the contract and the whole plan each
  time. It now makes one call per **distinct** voter and asks for the surplus votes inside that call. With enough
  distinct models nothing changes — N models disagreeing is the point of a jury, and no prompt substitutes for it.
  The tally still sees the same number of votes, so `approvals` keeps its meaning.

- `scope:` — the seven worker-facing fix-round messages and the recovery brief told the worker to run
  `delivery.verifyCommand`, the whole gate. `verifyCommandFor()` already existed and resolves the layer's own
  verify from the labels frozen at dispatch; `deliver` never called it. A project with no layers sees no change;
  one with them stops paying for the monorepo suite on every fix round, twice over (`maxFixRounds` defaults to 2).
- `cheapest-sufficient:` — `routing.effort` gave `builder` (writing and debugging the code) `medium` while
  `reviewer` and `orchestrator` (reading a finished diff, turning an issue into a contract) got `high`. That is
  the inversion the rule exists to stop, and it paid more for the cheaper problem. Now `builder: high`,
  the readers `medium`.
- `windowed:` — `buildIssueTimeline` was the last unbounded read: `readLoopEvents(stateDir)` with no window,
  parsing `events.ndjson` plus every rotated archive and filtering one issue out in memory. It takes a window
  now (`--since`, default `30d`).

### Breaking

- `connectors.runner: "local"` is now rejected at config load. It was never wired: `tick`, `deliver` and
  `install` go straight to Orca, so setting it ran Orca anyway while `doctor` reported `runner.local: passed`.
  A silently-wrong runner is worse than a loud one. `createLocalRunner` stays tested so wiring it later is a
  change of caller, not a rewrite.

### Gates

- Auto-merge now has a floor. A flow profile could turn the review, the local verify, the definition of done and
  CI gating all off and still merge unattended — with `merge.requireHumanApproval` defaulting to `false`, nothing
  examined the diff and nobody was asked to. Each switch stays (an incident flow skipping the review is the
  point); all of them off at once holds the PR for a human. The comment in `deliver.ts` claiming the other gates
  "still run" was false and now describes the floor it actually has.

## [0.17.0] - 2026-09-22

Real-time enforcement inside the worker's own session, and a release that can no
longer outrun its own gate.

### Worker guard

- `ak-harness loop worker-guard`: a `PreToolUse` hook entrypoint that blocks a
  `Write`/`Edit`/`MultiEdit`/`NotebookEdit` touching `delivery.selfEditPaths` or
  `delivery.secretFilePatterns` as it happens — the same `touchesProtectedPaths`
  check the PR-time gate already made, just early enough to prevent the write
  instead of reporting it. Installed into the fresh worktree at dispatch and again
  on a provider handoff, before the worker's terminal opens.
- `claude` and `grok` get the hook (they share the event shape by design); `opencode`
  gets static `deny` rules in `.opencode/opencode.json`, a directory created with a
  self-covering `.gitignore` so nothing the harness writes is visible to `git add`;
  `codex` is deliberately uncovered while its `PreToolUse` upstream bugs stand. See
  `docs/ADR-0038`.
- `delivery.workerGuard.enabled` (default `true`) is the escape hatch.
- Known limits, stated rather than implied: a `Bash`-mediated write is not caught
  (neither is it by the gate this backs up), a crashed or timed-out hook fails open
  in every one of these CLIs, and upgrading the harness with workers in flight can
  leave their hook pointing at a build that no longer exists — drain first.

### Release can no longer publish past a red gate

- Publishing moved into `ci.yml` as a job that `needs` verify, docs and the
  macOS/Windows matrix. As its own workflow it ran *in parallel* with CI, re-running
  only typecheck/test/build itself — so a commit could fail `ak-verify`, the docs
  check or the Windows matrix and ship anyway.
- Whether a version is new is now the registry's answer, not a `git diff` against
  `github.event.before`, which is absent after a force-push and was read as "changed".
- `scripts/verify-release-workflow.mjs` asserts the dependency itself, so the gap
  cannot reopen silently.

## [0.16.0] - 2026-09-22

Cheaper and more visible at the same time: the loop's own token/time waste gets cut, and what it spends becomes
something a human — or a study comparing how different models behave on the same task — can actually read back.

### Verification and token waste

- `.ak-harness/verification.json` deduped its checks against `dependsOn` instead of re-running `pnpm typecheck`/
  `pnpm build` up to 11x/7x per `ak-verify run`; `tsconfig.json` gained `incremental`. `AGENTS.md`'s verification
  contract is now scoped per task by default — the full 22-check gate only runs at PR-closing time.
- `issueSpend`, `observability.ts`, `metrics.ts:readRuns`, `tuning.ts:history`, `intake.ts:filed`, and
  `events-archive-*.ndjson` retention (30 days) all read a bounded window now instead of the loop's whole history
  on every call.
- `roles.orchestrator/reviewer.quality` no longer default to `frontier` while `builder` defaults to `balanced` —
  the role writing the code is never given a weaker default than the role only reading it.
- A fix round sizes its reviewer off the incremental diff since the last reviewed head (`githubCompare`), not the
  PR's whole cumulative diff.
- Review usage (`agentskit-review`'s own `providerCalls`/token tracking) surfaces into `pr.reviewed`, so
  `issueBudget`/`issueSpend` see review spend for the first time.

### Observability: every deterministic phase, timestamped and attributed

- `provider.call` now covers every harness-direct model call — contract generation, planner, voters, not just the
  orchestrator — each carrying `provider`/`model`/`effort`/duration/exit code/output size.
- Contract generation success (`contract.generated`), Definition-of-Done assessment (`dod.assessed`), and a
  passing local verify (`verify.passed`) are logged either way, not just on failure.
- `config.changed` and `stage.completed` cover `loop.config.yaml` changes and every `loop stage` run's own
  duration and outcome.
- `plan.voted` lists who voted what, not just the count; `pr.reviewed` carries the review's own configuration
  (`profile`/`votes`/`minSeverity`).
- `resilience.maxUsageDeltaPercent` (the cost circuit breaker) is on by default (40); `provider.usage-observed`
  logs the usage delta on every `deliver` pass, trip or not.
- New: `ak-harness loop issue-timeline <id>` — one issue's events in order, with time/tokens since the previous
  step and a separate list of friction (fix rounds, cooldowns, circuit breakers).

### Event bus, unified

- Every stage (`tick`, `deliver`, `retro`, `release`, `intake`, `maintain`) now reaches the same in-process event
  bus — previously only `tick`/`deliver` did, and `release` loaded no plugins at all. `loop stage <name>` creates
  one bus per invocation and hands it to whichever stage runs, so a plugin or a `notifications.webhook`/`command`
  channel sees every event of that process, not a subset.
- `stage.paused` now goes through that same notifier path as everything else (it was already in
  `notifications.events`'s default list, so nothing changes for anyone using the default).

### House conventions

- Adopted `ponytail` (coding style), `caveman` (output style), and `rtk` (local tooling) as documented
  conventions in `AGENTS.md`/`CONTRIBUTING.md`; added `digest:`/`windowed:`/`scope:`/`cheapest-sufficient:`/
  `one-shot-vote:` as named, checkable house rules.

## [0.15.0] - 2026-09-20

The loop becomes a cycle. The twelve steps of the SDLC roadmap close, the phases of one
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
