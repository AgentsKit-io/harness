---

type: package
package: harness-benchmarks
editRoot: benchmarks
checks: [pnpm test]
---

# harness-benchmarks

`benchmarks` — Recorded benchmark baselines and eval results.

## Change rules

- Keep changes inside `benchmarks` scoped to the ticket; regenerate any derived artifact in the same change.
- Add a `changelog.d/<ticket>.md` fragment instead of editing `CHANGELOG.md`.

## Check

`pnpm test`
