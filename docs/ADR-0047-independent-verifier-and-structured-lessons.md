# ADR-0047: An independent verifier decides "proven"; lessons are structure that proposes checks

## Status

Accepted

## Context

Research of pstack (cursor/plugins) and google-research/harness2 (2026-10-20), adopted for reliability, found the
same two weaknesses this loop has (ADR-0036, ADR-0038, ADR-0045):

1. **The writer grades its own work.** The definition of done is judged from `dod.json` / `verify.json` the worker
   wrote, plus green CI. ADR-0045 already re-runs commands locally for the `fleet` runner, but the harness and the
   fleet must behave as one product (fleet `docs/design/factory-app-brief.md` §7, Trust): a "proven" verdict has to come
   from something that did not write the code, on every runner, and green CI alone is not a verdict.
2. **Lessons stay prose.** The retro lifts bullets into the learnings ledger and a human (or `loop-auto`) promotes
   sentences into memory that every future brief carries. A sentence with no cue and no evidence is an opinion
   injected into every task, and nothing checks that it was ever acted on mechanically.

## Decision

### Independent verifier

`verifier` in `loop.config.yaml` (off by default: it costs a second agent run):

| key | meaning |
|---|---|
| `enabled` | with it on, nothing merges without a verifier verdict for the exact PR head |
| `commands` | argv the verifier runs on the PR head; empty = **generated starting verifier** from the stack (`package.json` scripts `lint`/`typecheck`/`build`/`test` by lockfile, pytest, cargo, go) |
| `liveChecks` | checks that need the thing running, in words; the verifier performs and evidences each |
| `agentCommand` | agent CLI line for runners that launch a terminal (`orca`, `local`); required there, ignored by `fleet` |
| `budget.timeoutMs` | no verdict in time is a **failed** verification (default 30 min) |

Deliver (`src/loop/verifier.ts`, called after the DoD block) drives it through the selected `RunnerConnector`, so
it works for every runner without a new interface: `createWorkspace` → `launchAgent` → `send` of a verifier brief
(on `fleet` that is `fleet submit` with the verifier brief), then later passes `observeWorkspaces` + `readScreen`
(`fleet tail`). The verifier is a **different workspace** from the writer's. The brief tells it to check out the PR
head, not to trust the PR text, `.ak-loop/*.json` or CI, never to edit code, and to print one
`LOOP-VERDICT: {json}` line: `verdict`, the full `head`, the submission `nonce`, and per item `id`/`status`/`evidence`.
Items are the commands, live checks, the project's `command` DoD items and every contract outcome.

`judgeVerdict` fails closed. `proven` requires: this head, this submission's nonce, every asked item answered
`passed` **with evidence**, a `proven` verdict, and at least one item asked. A brief echoed back by the terminal is not
a verdict (the line must parse). A verifier that ends silent or exceeds the budget is `failed`; one that cannot be
launched or dies is `unavailable` and holds the PR for a person — never read as proven. A new head is a new
verification; the verdict is cached per head in `<stateDir>/issues/<issue>/verifier.json` and the workspace removed.

Outcomes in deliver: `proven` → vouched for by "the independent verifier" (evidence table commented on the PR);
`failed` → a fix round naming what failed; `waiting` → `waiting`; `unavailable` → `held`. The writer's own DoD
proofs are still read first as cheap pre-checks and still gate; they just no longer suffice. New event:
`verifier.verdict`.

### Lessons as structure

`LearningRecord` gains `cue` (when it applies), `lesson` (defaults to `text`), `evidence` (what taught it) and an
optional `check`. `promoteLearnings` refuses to promote a record missing any of them (rejecting stays free), and
`learningsReadyToPromote` only offers structured lessons, so `loop-auto` cannot promote prose either. Retro
suggestions now render `- cue:` / `- evidence:` sub-bullets, which `parseRetro` attaches to their item instead of
making records of their own.

Before keeping a lesson as prose the retro **proposes a concrete check** (`src/loop/lesson-checks.ts`): a lint rule,
a DoD item (a ready `dod.items` snippet with id `lesson-<id>`), a test or a guard rule, chosen from the lesson's
wording (ponytail: a skeleton a person finishes — the retro cannot know the regex or command). The retro comment gets
`## Proposed checks` and `## Lessons still only in prose`: lessons with no adopted check, where adopted means
`check.adopted` in the ledger or the `lesson-<id>` DoD item existing in config. Lessons that cannot be promoted say
which of cue/evidence they lack.

## Consequences

- With the verifier on, merge latency includes a verification run; with it off nothing changes.
- Existing ledger records without cue/evidence stay readable but cannot be promoted until structured.
- There is no CLI flag yet to add a cue/evidence to an existing prose lesson; edit the ledger or let the next retro
  re-propose it with sub-bullets.
