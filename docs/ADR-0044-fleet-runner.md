# ADR-0044: A `fleet` runner — dispatch through the fleet coordinator's queue

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
the queue's. This ADR adds no collect wiring to the engine.

**Prompt hygiene.** The prompt reaches `fleet submit` only through a `0600` file in a fresh temp directory under
the state dir, removed in a `finally` once the submit returns. It is never in argv, logs or error text.

**Config** (`connectors.fleet`, next to `connectors.local`): `bin` (default `fleet` on PATH), `project`
(`github:<owner>/<repo>`; default derived from the `origin` remote of `project.root`, failing closed if that is
not GitHub), `model` (`haiku|sonnet|opus`, default `sonnet`), `fallbackModels`, `priority` (int ≥ 0),
`timeoutMs`.

## Consequences

- Same limit as ADR-0039 recorded for `local`: today `tick`/`deliver`/`install` still call Orca directly, and
  only `createRunnerConnector` callers (the UI's workspace observation) go through the interface. `connectors.runner:
  fleet` is accepted at load as asked, but dispatch itself does not follow it until the engine is moved onto the
  interface. That caller change is a separate step, and until it lands `doctor` should not be read as proof the loop
  dispatches through fleet.
- Records live in a state-dir file, so a later process can observe, tail and cancel what an earlier one submitted.
  Records of workspaces whose `remove` never ran are not garbage-collected.
- The queue JSON shape is read leniently (bare array or `{ tasks }`, `id`/`queueId`, `state`); a shape change in
  the fleet CLI shows up as `unknown` states or an explicit parse error, not as a false `done`.
