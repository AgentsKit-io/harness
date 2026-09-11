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
```

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
| `<prefix>-tick` | `schedule.tick` | `<harnessCommand> loop precheck tick -f <config>` | run `loop tick --json`, report, nothing else |
| `<prefix>-deliver` | `schedule.deliver` | `<harnessCommand> loop precheck deliver -f <config>` | run `loop deliver --json`, report, nothing else |

The automation agent (`schedule.provider`, default: the watcher role's first available provider) only executes the
harness command; every decision stays in the harness. Runs, skips and output are visible in Orca's Automations view and
via `loop status`. The precheck keeps skipped ticks free of model calls.

`schedule.harnessCommand` must resolve inside Orca's environment: install the harness globally
(`npm i -g @agentskit/harness`) or set an absolute command. `loop install` warns when it cannot find it on this shell's PATH.

Optional SessionStart hook for Claude Code (`.claude/settings.json` of the target project):

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "ak-harness loop hook -f loop.config.yaml", "timeout": 10 }] }] } }
```

It prints `loop: installed (2/2, last run …)` or the install command; it never installs or changes anything.

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
   worker: `orca worktree create --agent <builder> --linear-issue <url> --base-branch <base> --prompt <brief>
   --no-parent`, the issue moves to `In Progress`, one dedicated comment is posted. Otherwise the loop posts one
   `needs-info` comment (deduped by contract digest), adds the label, and moves on without consuming a slot.

Every side effect is recorded in `<stateDir>/events.ndjson`; `dispatch.json` per issue links the worktree,
terminal handle, provider/model and lease for the deliver stage.

Start from [`loop.config.example.yaml`](../loop.config.example.yaml) at the package root.

## What the doctor checks

| Check | Source | Blocking |
|---|---|---|
| `orca.version` / `orca.runtime` | `orca --version`, `orca status --json` | yes — the loop cannot run without a reachable Orca runtime at or above `orca.minVersion` |
| `provider.<id>` | PATH lookup, `orca account list` usage windows, `orca agent hooks status`, env key names, optional probe, cooldown store | no — reported per provider |
| `routing.<role>` | tiers from `models.<role>` filtered by provider availability | yes — a role with no available provider blocks |
| `machine.slots` | `sampleMachine` + `adaptiveConcurrency`, free RAM reserve, WSL cap, running worktrees | no — 0 free slots is a warning, not a failure |
| `linear.queue` | `orca linear list-issues` per configured state, filtered and ordered locally | yes — an unreachable Linear blocks |

## Model routing

`models.<role>` is a list of tiers; each tier is a list of `provider/model`. Tiers are tried in order and, inside a
tier, providers in declaration order. The first provider that is **available** wins. A provider is available when
its binary is on PATH, its auth is not known to be missing, no Orca usage window is at or above
`cooldown.exhaustedPercent`, it is not cooling down, and its optional probe passed.

Providers authenticate through their own CLI login (`claude login`, `codex login`, `grok login`); only providers
declared `auth: api-key` need an environment variable, and the loop never reads its value. Orca has no per-run model flag; the chosen model is rendered into `providers.<id>.tui` (for example
`codex -m {model} --full-auto`) and launched in the worker terminal.

When a provider runs out of usage the loop records a cooldown in `<stateDir>/provider-cooldowns.json`:
`initialMin` doubling up to `maxMin`, never earlier than the reset instant Orca reported.

## Machine slots

`maxAgents = max(floor, min(adaptiveConcurrency(ceiling), ramBound, wslCap?))` where `ceiling` defaults to
`cpus / 2`, `ramBound` fits `agentRssMb` agents into free RAM minus `minFreeRamGb`, and the WSL cap applies only
inside a WSL distro (host Defender load is invisible there). The loop never lowers a running worker; it only
decides whether to start another.

## Boundaries

Adapters (`src/adapters/command.ts`, `orca-cli.ts`, `providers.ts`, `linear-orca.ts`) depend on kernel contracts
only and receive a `CommandRunner`; they never spawn a shell. Composition (`src/loop/*`) supplies the real
runner and wires adapters together. See `docs/MODULE-BOUNDARIES.md`.

## Security notes

- `loop.config.yaml` holds env variable **names**, never values.
- Every external call is argv-based with a timeout; `ok: false` envelopes fail closed.
- Linear text is data. Later phases render it into worker briefs inside delimiters and never execute it.
