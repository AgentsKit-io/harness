# ADR-0046: Verdict levels bound to the patch, a pure merge policy, and a read-back after merge

## Status

Accepted

## Context

Research of pstack (cursor/plugins) and google-research/harness2 (2026-10-20) found three weaknesses the
maintainer approved fixing for reliability. The harness and the fleet are one product (fleet repository,
`docs/design/factory-app-brief.md` §7 Trust), so what a "pass" means has to be the same on both sides.

1. **Pass/fail hides how far something was checked.** "Passed" covered "it compiles" and "I ran it against the
   real thing". A merge gate cannot ask for what the record cannot say (ADR-0035, ADR-0039).
2. **A verdict outlived the code it judged, or was thrown away needlessly.** Proofs were read per head: a rebase
   that changed no line re-ran everything (expensive for a `fleet` task, ADR-0045), and nothing recorded *which*
   change a proof was made on.
3. **The merge decision was spread across `handlePullRequest`** — held paths, the gate floor, `merge.auto`, the
   human gate — interleaved with I/O, so it could not be tested as a table. And a merge GitHub *accepted* was
   trusted as done.

## Decision

### Verdict levels

`src/loop/verdict.ts`. A verdict is one of, weakest first:

`failed` < `blocked` < `type-check-only` < `unit-verified` < `ci-verified` < `live-verified`

`ci-verified` is the repository verification passing in the PR's own CI on the head SHA — the project's environment,
not a re-run on the control machine. It meets `unit-verified`; it is not a claim about the live system.

`blocked` is "could not be verified at all" — not a failure of the change, a gap only a person can close.
Each definition-of-done item (ADR-0035, both lists) carries a level; the proof table on the PR and the merged
comment show it next to the status. A worker states it in `.ak-loop/dod.json` as `"verdict": "<level>"`.

Where the level comes from:

| Source | Level |
|---|---|
| worker proof with a `verdict` | as written (`status: failed` beats a proven level; `blocked` survives) |
| legacy worker proof, `status: passed` | `unit-verified` |
| legacy worker proof, `status: failed` | `failed` |
| `file-changed` / `pattern-absent`, decided by the harness from the diff | `unit-verified` (deterministic, but not a claim about running code) |
| a command the harness re-ran in its own checkout (`fleet`, ADR-0045) | `unit-verified`; `blocked` (`blocked: environment`) when the install or the run failed for the machine's sake (missing module, wrong engine) |
| the repository verification (`verify` item, or an item/outcome running `delivery.verifyCommand`) with `merge.requireChecks` on and the PR's CI green on the head (`fleet`) | `ci-verified`, with the passing checks and run URL as evidence; not re-run locally |
| a review | `clean` → `unit-verified`, `findings` → `failed`, `incomplete` → `blocked` — judged by its status, not by `minVerdict` |

**Migration of stored state.** `passed` becomes `unit-verified`, `failed` stays `failed`; reading is tolerant,
nothing is rewritten in bulk: a stored `verdicts.json` item that says `passed` is read as `unit-verified`, and
`delivery.json` review entries without a `verdict` get one from their status when read.

**Project minimum.** `delivery.merge.minVerdict` (default `unit-verified`): the weakest level a *proven* item may
carry for the loop to merge. An item below it goes back to the worker as a fix round ("proven, but below the
required verdict … verify them further") — the worker can raise it. Items still `missing` or `failed` are
unchanged. `blocked` items are not fix rounds, see the policy.

### Verdicts bound to the patch

With each assessment the loop stores `<stateDir>/issues/<issue>/verdicts.json`: every item's verdict and
evidence, the `git patch-id --stable` of the PR diff (`gh pr diff | git patch-id --stable`; the `CommandRunner`
gained a `stdin` option for it), the head, and the run fingerprint:

```
{ contract: <frozen contract digest>, guardPolicy: <digest of selfEditPaths + secretFilePatterns>,
  model: <worker provider/model>, baseSha: <collected base, when known> }
```

On the next pass (a push, a rebase) the stored verdicts **hold** when the patch-id is equal *and* the contract
digest and guard-policy digest are equal. The base SHA and the model are recorded, not compared: a rebase moves
the first and a retry the second without changing what was verified. Holding means stored *proven* items stand in
for what the fresh read does not state (a fresh statement always wins), and a `fleet` task whose every item was
proven on this patch skips the local re-run. Otherwise — a different patch, a changed contract or guard policy, or
a patch-id that could not be computed (either side) — nothing is carried and the items are proven again, which is
the existing behaviour. No binding means no reuse; it never means "assume it holds".

The patch-id is read once more right before the merge decision: a push that landed while the review ran makes the
verdicts stale and the policy holds.

### The merge decision is a pure function

`src/loop/merge-policy.ts`: `decideMerge(input) → merge | hold(reason) | escalate(reason)`. Inputs: the verdicts
and `minVerdict`, the patch-ids, CI (status and whether the flow gates on it), the review, held paths (protected
and approved, secret-shaped, enforced layer boundary), the project's autonomy, the flow's `merge.auto`, the human
gate, what vouched for the change, and the escalation rules. It reads nothing. Order, first match wins:

1. `escalate` — a `blocked` verdict while `delivery.merge.escalateOnBlocked` (default true)
2. `hold` — protected paths nobody approved for this head; secret-shaped files; an enforced layer boundary
3. `hold` — a required review that is incomplete, has blocking findings, or never ran
4. `hold` — CI the flow gates on is not green
5. `hold` — the verdicts were made on a different patch
6. `hold` — any item with no verdict, `failed`, or below `minVerdict`
7. `hold` — nothing examined the change (the ADR-0039 floor)
8. `hold` — `delivery.merge.autonomy: supervised`
9. `hold` — the flow has `merge.auto: false`
10. `hold` — `requireHumanApproval` and no approval on GitHub
11. `merge`

`delivery.merge.autonomy` is new: `autonomous` (default, today's behaviour) or `supervised` — the loop reviews,
proves and reports but a person merges.

`deliver` merges only on `merge` from this function. The gates that need the world (running the review, proving
the DoD, fetching checks) stay in `deliver` and produce its inputs; they do not decide. Two things stay
outside it on purpose, as *routing*, not decision: the early holds for protected and secret-shaped files (they stop
the loop spending a review on a PR it would hold anyway; the policy re-checks both), and fix rounds for red CI or
missing/failed proofs (they are instructions to the worker; the policy would only say `hold`).

An `escalate` is a person's call: tracker comment and blocked state, a PR comment, the slot released, worktree and
PR kept, `merge.escalated` in the event log.

### Read back after merge

After `githubMerge` answers merged, `deliver` reads the PR back (`gh pr view`) and requires `state: MERGED` with
`headRefOid` equal to the head it reviewed — up to three reads per pass (`readBackDelayMs`, default 2 s, apart).
Anything else is recorded (`pr.merge-unconfirmed`, with what was observed) and the issue is **not** completed:

- merged, but at a different head → escalate at once (retrying cannot change it);
- still open / unreadable → `waiting`, counted in `delivery.json` (`mergeUnconfirmed`); the third pass in a row
  escalates. If GitHub catches up in between, the next pass finds the PR merged and completes it as the loop's own merge.

## Consequences

- A project that wants "ran against the real thing" sets `minVerdict: live-verified`; one that accepts a
  type check sets `type-check-only`. Existing projects keep `unit-verified`, which every legacy `passed` already is.
- Rebases stop costing re-verification when the patch is the same; a changed contract or guard policy always does.
- The decision table is unit-tested (`test/loop-merge-policy.test.ts`) and `deliver` has no other road to a merge.
- A review that a worker's `dod.json` claims `live-verified` is still the worker's claim: levels are recorded and
  compared, not independently proven. The harness-run proofs (`file-changed`, `pattern-absent`, `fleet` re-runs)
  never exceed `unit-verified`; only a worker (or a future harness probe) states `live-verified`.
- One more `gh` call per merge candidate (the second patch-id), plus one `gh pr view` per merge.
