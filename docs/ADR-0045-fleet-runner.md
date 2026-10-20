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

**Delivery.** When a task ends `done`, the deliver step collects its commits with `fleet collect <host-task-id> --json`
(which never pushes) and opens the pull request as it does for any runner. The PR is the orchestrator's job, not
the queue's. The connector gained an optional `collect({ id })` for this: it takes the host task id from the queue
row (`hostTaskId`/`host_task_id`/`taskId`/`task_id`, else the queue id) and runs `fleet collect --json`.
`fleet collect` creates **no** branch under the harness's name: it fetches the commits to
`ref = refs/remotes/fleet/<host>/<host-task-id>` and reports `{ ref, head, base, commits }`. The output is validated
with a zod schema (`ref`, `head` as a hex sha, `commits` as an integer ≥ 0; other keys ignored); non-JSON or a wrong
shape is refused. `commits: 0` returns no branch, and deliver treats it as a stuck worker (escalated, no push, no PR).
Otherwise the connector checks `git merge-base --is-ancestor <head> <ref>` and runs `git branch -f <branch> <head>`, so
the harness's own local branch sits exactly at the collected commit. Deliver then pushes it with
`git push -u origin <branch>`, opens the PR with `gh pr create` (body carries `Loop-Contract: <digest>`), and the PR is
reviewed and merged like any other. A task that ends `failed`/`cancelled` is a stuck worker, escalated to a person.

**Definition of done.** The other runners prove the DoD from the worker's worktree and the handoff files it wrote
there; a fleet task has neither (found live on factory-sandbox#3: every pass `waiting` on `missing: verify, o1, o2;
failing: test-for-new-code`). For `fleet`, deliver proves it in `src/loop/fleet-dod.ts`, on a **temporary git
worktree at the PR head** (`git worktree add --detach <stateDir>/fleet-checkout-… <head>`, removed with
`worktree remove --force` and pruned in a `finally`, on success and on failure):

- `file-changed` / `pattern-absent` use `baseSha...headSha` — both from `fleet collect --json`, stored on the dispatch
  record as `collected` (`origin/<baseBranch>` stands in for a missing base) — and the files as committed.
- `command` items run in that checkout, bounded by `connectors.fleet.verifyTimeoutMs` (default 600000), after the
  repo's frozen install (`pnpm install --frozen-lockfile`, `npm ci`, `yarn install --frozen-lockfile` or
  `bun install --frozen-lockfile`, chosen by lockfile) — only when some command item or outcome check needs it. Output
  is the proof's evidence. A failed install fails the commands rather than skipping them.
- **The remote agent's claim is never evidence for a command**: a committed `dod.json` that says `verify` passed is
  ignored; the harness runs it.
- **Contract outcomes** (`o1`, `o2`, …): Orca proves them from the worker's `verify.json`/`dod.json` in its worktree.
  For fleet, an outcome whose check carries a command (`command`/`test`) is re-run locally like a `command` item. An
  outcome with no command (`manual`) is proven by the handoff, and the channel is **the collected commit**: the fleet
  brief asks the agent to commit (`git add -f`) `.ak-loop/verify.json` and the `dod.evidenceFile`, and the same readers
  Orca uses (`readDodEvidence`, `readVerifyArtifact`) read them from the checkout. `fleet tail` was rejected: it is a
  truncated log, not a record. The cost is that those two small files appear in the PR diff.
- The checkout is made on every pass that reaches the DoD gate; there is no cache yet.

Separately fixed here: the `file-changed` glob `**/*.{test,spec}.*` (the presets' `test-for-new-code`) never matched
anything, because `{a,b}` was matched literally; the glob matcher now treats it as an alternation.

**Branch name.** The tracker's branch name can hold characters git refuses or people dislike (GitHub issues yield
`<login>/<owner>/<repo>#<n>`). `createWorkspace` therefore derives a safe ref for fleet (`safeFleetBranch`: anything
outside `A-Za-z0-9._/-` becomes `-`, so `login/owner/repo#3` → `login/owner/repo-3`); that name is what the dispatch
record, the brief, the push and the PR use. The other runners keep the tracker's name.

**Prompt hygiene.** The prompt reaches `fleet submit` only through a `0600` file in a fresh temp directory under
the state dir, removed in a `finally` once the submit returns. It is never in argv, logs or error text.

**Config** (`connectors.fleet`, next to `connectors.local`): `bin` (default `fleet` on PATH), `project`
(`github:<owner>/<repo>`; default derived from the `origin` remote of `project.root`, failing closed if that is
not GitHub), `model` (`haiku|sonnet|opus`, default `sonnet`), `fallbackModels`, `priority` (int ≥ 0),
`timeoutMs`, `verifyTimeoutMs`.

## Consequences

- **`tick` and `deliver` follow the selected runner** (this superseded the earlier "accepted at load, but dispatch
  still runs Orca" limit, which was found live: `runner: fleet` still planned `orca worktree create`). Under `fleet`
  they create the workspace, submit the brief and collect through `RunnerConnector`, and never call Orca — not for
  accounts, worktrees, memory, terminals or the terminal reaper. The Orca path is unchanged and still written out in
  `tick`/`deliver` (trust prompts, submit observation, terminal reaping), not routed through `createOrcaRunner`:
  moving it would risk its behaviour for no gain. `connectors.runner: local` is still rejected at load (ADR-0039);
  `install` still reconciles Orca automations and is not part of this.
- Under `fleet` there is no worktree, so no worker guard, no `project.setup`, no spec files, and no local
  `delivery.verify` of the PR's code beyond the definition of done above (the brief tells the worker to commit and stop; the harness pushes and opens
  the PR). Nudges, handoffs and fix-round messages cannot reach a queued task; `sendToWorker` reports that and returns.
  Provider availability still comes from local detection with no Orca account list, so a provider whose auth is an
  Orca account reads unavailable; the model the fleet runs is `connectors.fleet.model`, not the routed builder.
- `loop doctor` probes the selected runner: `fleet doctor --json` (summarised) and `fleet queue --json` for `fleet`,
  with no Orca checks; Orca checks run only under `orca`.
- Found live (factory-sandbox#3): `fleet collect` leaves no branch under the harness's name, so the first design (look
  for the recorded branch locally) failed every pass. Collect now reads `ref`/`head` from `--json` as above.
- `fleet collect --clean` (remove the host workspace once the PR exists) is not used yet: it would need a post-PR hook
  on the connector. The host workspace stays until the fleet's own cleanup.
- Records live in a state-dir file, so a later process can observe, tail and cancel what an earlier one submitted.
  Records of workspaces whose `remove` never ran are not garbage-collected.
- The queue JSON shape is read leniently (bare array or `{ tasks }`, `id`/`queueId`, `state`); a shape change in
  the fleet CLI shows up as `unknown` states or an explicit parse error, not as a false `done`.
