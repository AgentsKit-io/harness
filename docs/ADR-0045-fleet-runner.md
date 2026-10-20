# ADR-0045: A `fleet` runner — dispatch through the fleet coordinator's queue

## Status

Accepted

## Context

The factory design (fleet repository, `docs/design/industrial-sdlc.md` §8 step 3) puts the harness's
`RunnerConnector` in front of the factory queue. The fleet coordinator is that queue's front door:
`fleet submit`, `fleet queue --json`, `fleet tail`, `fleet collect`, `fleet cancel`. Behind it the queue may be
fleet's own or Hatchet; the harness must not know which, so it speaks only the CLI, through `CommandRunner`
(argv, no shell).

A fleet task is not an Orca terminal: it is submitted once, runs unattended, has no local worktree, and cannot
be typed into afterwards. The interface has to say so honestly rather than pretend.

## Decision

A third implementation, `createFleetRunner` (`src/loop/fleet-runner.ts`), selected by `connectors.runner: fleet`.
The engine and the interface are unchanged, except one optional field: `WorkspaceObservation.state`, the task
state, because a queued task has no pull request to report.

| `RunnerConnector` | Fleet behaviour |
|---|---|
| `createWorkspace` | Records a pending workspace (harness-side id, branch, base) in `<stateDir>/fleet-workspaces.json`. Contacts nothing. `path` is `''`: there is no local worktree. |
| `launchAgent` | Returns a handle bound to that workspace (the workspace id). `command` is ignored — a queue does not run an interactive CLI line. |
| `send` (first) | **Submits**: `fleet submit --project <p> --base <workspace base> --model <m> [--fallback-models a,b] --priority <n> --prompt-file <tmp>`; parses `submitted <q-id>` and stores the id. Prompt = the text. |
| `send` (later) | Refused: `delivered:false`, detail "not interactive". A failed submit is also `delivered:false` and leaves the workspace unsubmitted, so a retry is possible. |
| `readScreen` | `fleet tail <q-id>`, last `lines` lines. Empty before submit or when tail fails. |
| `observeWorkspaces` | `fleet queue --json`; each submitted workspace maps to `{ id, pullRequest: null, state }`. States fold to `queued · running · done · failed · cancelled`; any word we do not know is `unknown`, never `done`. The SCM stays the source of PR state. |
| `removeWorkspace` | If the task is not terminal, `fleet cancel <q-id>`; a failed cancel throws and keeps the record. Then forgets the record. A task already done/failed/cancelled is not cancelled again. |
| `schedule` | Returns `the fleet coordinator owns scheduling`; writes nothing. |

**Delivery.** When a task ends `done`, the deliver step collects its branch with `fleet collect <host-task-id>`
(which never pushes) and opens the pull request as it does for any runner. The PR is the orchestrator's job, not
the queue's. The connector gained an optional `collect({ id })` for this: it takes the host task id from the queue
row (`hostTaskId`/`host_task_id`/`taskId`/`task_id`, else the queue id), runs `fleet collect`, takes the branch the
output names (else the workspace's own), and fails unless that branch exists in the local clone. Deliver then pushes
it with `git push origin`, opens the PR with `gh pr create` (body carries `Loop-Contract: <digest>`), and the PR is
reviewed and merged like any other. A task that ends `failed`/`cancelled` is a stuck worker, escalated to a person.

**Prompt hygiene.** The prompt reaches `fleet submit` only through a `0600` file in a fresh temp directory under
the state dir, removed in a `finally` once the submit returns. It is never in argv, logs or error text.

**Config** (`connectors.fleet`, next to `connectors.local`): `bin` (default `fleet` on PATH), `project`
(`github:<owner>/<repo>`; default derived from the `origin` remote of `project.root`, failing closed if that is
not GitHub), `model` (`haiku|sonnet|opus`, default `sonnet`), `fallbackModels`, `priority` (int ≥ 0),
`timeoutMs`.

## Consequences

- **`tick` and `deliver` follow the selected runner** (this superseded the earlier "accepted at load, but dispatch
  still runs Orca" limit, which was found live: `runner: fleet` still planned `orca worktree create`). Under `fleet`
  they create the workspace, submit the brief and collect through `RunnerConnector`, and never call Orca — not for
  accounts, worktrees, memory, terminals or the terminal reaper. The Orca path is unchanged and still written out in
  `tick`/`deliver` (trust prompts, submit observation, terminal reaping), not routed through `createOrcaRunner`:
  moving it would risk its behaviour for no gain. `connectors.runner: local` is still rejected at load (ADR-0039);
  `install` still reconciles Orca automations and is not part of this.
- Under `fleet` there is no worktree, so no worker guard, no `project.setup`, no spec files, and no local
  `delivery.verify` of the PR's code (the brief tells the worker to commit and stop; the harness pushes and opens
  the PR). Nudges, handoffs and fix-round messages cannot reach a queued task; `sendToWorker` reports that and returns.
  Provider availability still comes from local detection with no Orca account list, so a provider whose auth is an
  Orca account reads unavailable; the model the fleet runs is `connectors.fleet.model`, not the routed builder.
- `loop doctor` probes the selected runner: `fleet doctor --json` (summarised) and `fleet queue --json` for `fleet`,
  with no Orca checks; Orca checks run only under `orca`.
- Assumption to confirm against the real CLI: `fleet collect` leaves the branch under the workspace's recorded name
  (or names it as `branch <name>` in its output). If it uses another name the collect fails loudly ("not in the local
  clone") instead of pushing the wrong thing.
- Records live in a state-dir file, so a later process can observe, tail and cancel what an earlier one submitted.
  Records of workspaces whose `remove` never ran are not garbage-collected.
- The queue JSON shape is read leniently (bare array or `{ tasks }`, `id`/`queueId`, `state`); a shape change in
  the fleet CLI shows up as `unknown` states or an explicit parse error, not as a false `done`.
