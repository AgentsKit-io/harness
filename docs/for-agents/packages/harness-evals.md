---

type: package
package: harness-evals
editRoot: evals
checks: [pnpm test]
---

# harness-evals

`evals` — Eval manifest used to score loop behavior.

## Change rules

- Keep changes inside `evals` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm test`
